import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

import { guard } from "../../errors";
import {
  MAX_MODEL_ID_LENGTH,
  MAX_PROVIDER_MODELS,
  type ProviderKind,
  type ProviderSummary,
} from "./providers-model";
import type { NewProvider, ProviderPatch, ProvidersStore } from "./providers-store";

export type ProvidersFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type DnsRecord = { address: string; family: number };
export type DnsResolver = (hostname: string) => Promise<DnsRecord[]>;

export type ProvidersServiceDeps = {
  providersStore: ProvidersStore;
  fetcher?: ProvidersFetcher;
  resolver?: DnsResolver;
  // Local/loopback URLs (http://127.0.0.1, http://localhost) stay blocked unless explicitly enabled.
  allowLocalBaseUrl?: boolean;
};

export type CreateProviderResult =
  | { status: "created"; provider: ProviderSummary }
  | { status: "invalid_base_url" | "invalid_api_key" };

export type UpdateProviderResult =
  | { status: "updated"; provider: ProviderSummary }
  | { status: "not_found" | "invalid_base_url" | "invalid_api_key" };

export type FetchModelsInput = {
  kind: ProviderKind;
  providerId?: string;
  apiKey?: string;
  baseUrl?: string | null;
};

export type FetchModelsResult =
  | { status: "ok"; models: string[] }
  | {
      status:
        | "provider_not_found"
        | "invalid_base_url"
        | "invalid_api_key"
        | "api_key_required";
    };

export type ProvidersService = {
  list: () => Promise<ProviderSummary[]>;
  get: (providerId: string) => Promise<ProviderSummary | undefined>;
  create: (input: NewProvider) => Promise<CreateProviderResult>;
  update: (providerId: string, patch: ProviderPatch) => Promise<UpdateProviderResult>;
  delete: (providerId: string) => Promise<boolean>;
  fetchModels: (input: FetchModelsInput) => Promise<FetchModelsResult>;
};

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const hasControlChars = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata", "metadata.goog"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

const RESERVED_IPV4 = new BlockList();
RESERVED_IPV4.addSubnet("0.0.0.0", 8, "ipv4");
RESERVED_IPV4.addSubnet("10.0.0.0", 8, "ipv4");
RESERVED_IPV4.addSubnet("100.64.0.0", 10, "ipv4");
RESERVED_IPV4.addSubnet("169.254.0.0", 16, "ipv4");
RESERVED_IPV4.addSubnet("172.16.0.0", 12, "ipv4");
RESERVED_IPV4.addSubnet("192.0.0.0", 24, "ipv4");
RESERVED_IPV4.addSubnet("192.0.2.0", 24, "ipv4");
RESERVED_IPV4.addSubnet("192.168.0.0", 16, "ipv4");
RESERVED_IPV4.addSubnet("198.18.0.0", 15, "ipv4");
RESERVED_IPV4.addSubnet("198.51.100.0", 24, "ipv4");
RESERVED_IPV4.addSubnet("203.0.113.0", 24, "ipv4");
RESERVED_IPV4.addSubnet("224.0.0.0", 4, "ipv4");
RESERVED_IPV4.addSubnet("240.0.0.0", 4, "ipv4");

// Keep IPv6 blocks separate because BlockList treats ::ffff:0:0/96 as matching all IPv4 addresses.
const RESERVED_IPV6 = new BlockList();
RESERVED_IPV6.addSubnet("::", 128, "ipv6");
RESERVED_IPV6.addSubnet("::", 96, "ipv6");
RESERVED_IPV6.addSubnet("::ffff:0:0", 96, "ipv6");
RESERVED_IPV6.addSubnet("64:ff9b::", 96, "ipv6");
RESERVED_IPV6.addSubnet("64:ff9b:1::", 48, "ipv6");
RESERVED_IPV6.addSubnet("100::", 64, "ipv6");
RESERVED_IPV6.addSubnet("2001::", 32, "ipv6");
RESERVED_IPV6.addSubnet("2001:2::", 48, "ipv6");
RESERVED_IPV6.addSubnet("2001:db8::", 32, "ipv6");
RESERVED_IPV6.addSubnet("2002::", 16, "ipv6");
RESERVED_IPV6.addSubnet("fc00::", 7, "ipv6");
RESERVED_IPV6.addSubnet("fe80::", 10, "ipv6");
RESERVED_IPV6.addSubnet("ff00::", 8, "ipv6");

const LOOPBACK_NETS = new BlockList();
LOOPBACK_NETS.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_NETS.addSubnet("::1", 128, "ipv6");

const normalizeHost = (hostname: string) =>
  hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

const isLoopbackAddress = (ip: string) => {
  const family = isIP(ip);
  if (family === 4) return LOOPBACK_NETS.check(ip, "ipv4");
  if (family === 6) return LOOPBACK_NETS.check(ip, "ipv6");
  return false;
};

const isBlockedAddress = (ip: string, allowLocal: boolean) => {
  if (ip.includes("%")) return true;
  const family = isIP(ip);
  if (family === 4) {
    if (RESERVED_IPV4.check(ip, "ipv4")) return true;
    return !allowLocal && LOOPBACK_NETS.check(ip, "ipv4");
  }
  if (family === 6) {
    if (RESERVED_IPV6.check(ip, "ipv6")) return true;
    return !allowLocal && LOOPBACK_NETS.check(ip, "ipv6");
  }
  return true;
};

const isLoopbackHostname = (host: string) => host === "localhost" || isLoopbackAddress(host);

const isBlockedHost = (host: string, allowLocal: boolean) => {
  if (!host || BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isIP(host) !== 0) return isBlockedAddress(host, allowLocal);
  if (host === "localhost") return !allowLocal;
  return !host.includes(".");
};

const isValidHttpUrl = (value: string, allowLocal: boolean) => {
  if (hasControlChars(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return false;
    const host = normalizeHost(parsed.hostname);
    if (isBlockedHost(host, allowLocal)) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && allowLocal && isLoopbackHostname(host);
  } catch {
    return false;
  }
};

const hasValidApiKeyChars = (value: string) => value.length > 0 && !hasControlChars(value);

const modelsUrlFor = (kind: ProviderKind, baseUrl?: string) => {
  const fallback = kind === "google" ? GOOGLE_DEFAULT_BASE : OPENAI_DEFAULT_BASE;
  const parsed = new URL((baseUrl ?? fallback).replace(/\/+$/, ""));
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path === "" ? (kind === "google" ? "/v1beta/models" : "/v1/models") : `${path}/models`;
  return parsed.toString();
};

const parseProviderModels = (kind: ProviderKind, data: unknown): string[] => {
  if (!data || typeof data !== "object") return [];
  if (kind === "google") {
    const entries = (data as { models?: unknown }).models;
    if (!Array.isArray(entries)) return [];
    const ids = entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as { name?: unknown; supportedGenerationMethods?: unknown };
      if (typeof item.name !== "string") return [];
      if (
        Array.isArray(item.supportedGenerationMethods) &&
        !item.supportedGenerationMethods.includes("generateContent")
      ) {
        return [];
      }
      const id = item.name.replace(/^models\//, "").trim();
      return id && id.length <= MAX_MODEL_ID_LENGTH && !hasControlChars(id) ? [id] : [];
    });
    return [...new Set(ids)].toSorted();
  }
  const entries = (data as { data?: unknown }).data;
  if (!Array.isArray(entries)) return [];
  const ids = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    const trimmed = typeof id === "string" ? id.trim() : "";
    return trimmed && trimmed.length <= MAX_MODEL_ID_LENGTH && !hasControlChars(trimmed)
      ? [trimmed]
      : [];
  });
  return [...new Set(ids)].toSorted();
};

const readBoundedJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new Error("Provider models response exceeded size limit");
  }
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error("Provider models response exceeded size limit");
    }
    return JSON.parse(new TextDecoder().decode(buf));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("Provider models response exceeded size limit");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(combined));
};

// Pin resolved IPs at socket creation so DNS rebinding cannot shift the target between check and connect.
const createPinnedFetcher =
  (pinned: DnsRecord[]): ProvidersFetcher =>
  (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(input);
      const isHttps = target.protocol === "https:";
      const bareHost = normalizeHost(target.hostname);
      const transport = isHttps ? https : http;
      const reqHeaders: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        reqHeaders[k] = v;
      });
      const req = transport.request(
        {
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: init?.method ?? "GET",
          headers: reqHeaders,
          signal: init?.signal ?? undefined,
          ...(isHttps && isIP(bareHost) === 0 && { servername: bareHost }),
          lookup(_host, opts, cb) {
            if (opts.all) cb(null, pinned);
            else cb(null, pinned[0]!.address, pinned[0]!.family);
          },
        },
        (res) => {
          const status = res.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            res.destroy();
            reject(new Error("Provider models endpoint must not redirect"));
            return;
          }
          const contentLength = res.headers["content-length"];
          if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error("Provider models response exceeded size limit"));
            return;
          }
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          res.on("data", (chunk: Buffer) => {
            totalBytes += chunk.byteLength;
            if (totalBytes > MAX_RESPONSE_BYTES) {
              res.destroy(new Error("Provider models response exceeded size limit"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) headers.set(k, v.join(", "));
              else if (v !== undefined) headers.set(k, v);
            }
            resolve(new Response(Buffer.concat(chunks), { status, headers }));
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

const cleanModels = (models: string[]) =>
  [...new Set(models.map((m) => m.trim()).filter((m) => hasValidApiKeyChars(m)))].slice(
    0,
    MAX_PROVIDER_MODELS,
  );

const cleanNullable = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : value.trim();

export const createProvidersService = ({
  providersStore,
  fetcher,
  resolver,
  allowLocalBaseUrl = false,
}: ProvidersServiceDeps): ProvidersService => ({
  list: () => guard("provider_error", providersStore.list),
  get: (providerId) => guard("provider_error", () => providersStore.get(providerId)),
  async create(input) {
    const baseUrl = input.baseUrl?.trim();
    if (baseUrl !== undefined && !isValidHttpUrl(baseUrl, allowLocalBaseUrl))
      return { status: "invalid_base_url" };
    const apiKey = input.apiKey?.trim();
    if (apiKey !== undefined && !hasValidApiKeyChars(apiKey)) return { status: "invalid_api_key" };
    const clean: NewProvider = {
      name: input.name.trim(),
      kind: input.kind,
      ...(apiKey !== undefined && { apiKey }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(input.defaultModel !== undefined && { defaultModel: input.defaultModel.trim() }),
      ...(input.models !== undefined && { models: cleanModels(input.models) }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    };
    return {
      status: "created",
      provider: await guard("provider_error", () => providersStore.create(clean)),
    };
  },
  async update(providerId, patch) {
    const baseUrl = cleanNullable(patch.baseUrl);
    if (typeof baseUrl === "string" && !isValidHttpUrl(baseUrl, allowLocalBaseUrl))
      return { status: "invalid_base_url" };

    const apiKey = cleanNullable(patch.apiKey);
    if (typeof apiKey === "string" && !hasValidApiKeyChars(apiKey))
      return { status: "invalid_api_key" };

    const defaultModel = cleanNullable(patch.defaultModel);
    const models =
      patch.models === undefined
        ? undefined
        : patch.models === null
          ? null
          : cleanModels(patch.models);

    const clean: ProviderPatch = {
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
      ...(apiKey !== undefined && { apiKey }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(defaultModel !== undefined && { defaultModel }),
      ...(models !== undefined && { models }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    };
    const updated = await guard("provider_error", () => providersStore.update(providerId, clean));
    return updated ? { status: "updated", provider: updated } : { status: "not_found" };
  },
  delete: (providerId) => guard("provider_error", () => providersStore.delete(providerId)),
  async fetchModels(input) {
    const rawBaseUrl =
      input.baseUrl === null ? null : input.baseUrl === undefined ? undefined : input.baseUrl.trim();
    if (typeof rawBaseUrl === "string" && !isValidHttpUrl(rawBaseUrl, allowLocalBaseUrl))
      return { status: "invalid_base_url" };

    const rawApiKey = input.apiKey?.trim();
    if (rawApiKey !== undefined && !hasValidApiKeyChars(rawApiKey))
      return { status: "invalid_api_key" };

    let apiKey = rawApiKey;
    let baseUrl: string | undefined = typeof rawBaseUrl === "string" ? rawBaseUrl : undefined;
    if (input.providerId !== undefined) {
      const saved = await guard("provider_error", () =>
        providersStore.getCredentials(input.providerId!.toLowerCase()),
      );
      if (!saved) return { status: "provider_not_found" };

      const requestedBaseUrl =
        rawBaseUrl === null ? undefined : rawBaseUrl !== undefined ? rawBaseUrl : saved.baseUrl;
      const endpointMatchesSaved =
        input.kind === saved.kind && requestedBaseUrl === saved.baseUrl;

      // Never transmit a stored write-only apiKey to a different endpoint or protocol.
      if (!rawApiKey && !endpointMatchesSaved) return { status: "api_key_required" };

      apiKey ??= endpointMatchesSaved ? saved.apiKey : undefined;
      baseUrl = requestedBaseUrl;
    }

    if (baseUrl !== undefined && !isValidHttpUrl(baseUrl, allowLocalBaseUrl))
      return { status: "invalid_base_url" };
    if (!baseUrl && !apiKey) return { status: "api_key_required" };

    const baseEndpoint = modelsUrlFor(input.kind, baseUrl);
    const parsedEndpoint = new URL(baseEndpoint);
    const bareHost = normalizeHost(parsedEndpoint.hostname);
    let pinnedAddresses: DnsRecord[] = [];
    const literalFamily = isIP(bareHost);
    if (literalFamily !== 0) {
      if (isBlockedAddress(bareHost, allowLocalBaseUrl)) return { status: "invalid_base_url" };
      pinnedAddresses = [{ address: bareHost, family: literalFamily }];
    } else if (resolver || !fetcher) {
      const resolveDns = resolver ?? ((host: string) => dnsLookup(host, { all: true }));
      const resolved = await guard("provider_models_error", () => resolveDns(bareHost));
      if (
        resolved.length === 0 ||
        resolved.some((record) => isBlockedAddress(record.address, allowLocalBaseUrl))
      ) {
        return { status: "invalid_base_url" };
      }
      pinnedAddresses = resolved;
    }

    const activeFetcher = fetcher ?? createPinnedFetcher(pinnedAddresses);
    const headers: Record<string, string> = {};
    if (apiKey) {
      if (input.kind === "google") headers["x-goog-api-key"] = apiKey;
      else headers.authorization = `Bearer ${apiKey}`;
    }

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const models = await guard("provider_models_error", async () => {
      const collected: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const endpoint = new URL(baseEndpoint);
        if (pageToken) endpoint.searchParams.set("pageToken", pageToken);
        const response = await activeFetcher(endpoint.toString(), {
          headers,
          redirect: "error",
          signal,
        });
        if (!response.ok) throw new Error(`Provider models request failed (${response.status})`);
        const payload = (await readBoundedJson(response, MAX_RESPONSE_BYTES)) as {
          nextPageToken?: unknown;
        };
        collected.push(...parseProviderModels(input.kind, payload));
        pageToken =
          input.kind === "google" &&
          typeof payload?.nextPageToken === "string" &&
          payload.nextPageToken
            ? payload.nextPageToken
            : undefined;
        if (!pageToken) break;
      }
      return [...new Set(collected)].toSorted().slice(0, MAX_PROVIDER_MODELS);
    });
    return { status: "ok", models };
  },
});
