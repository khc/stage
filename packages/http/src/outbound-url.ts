import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

export type OutboundFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type DnsRecord = { address: string; family: number };
export type DnsResolver = (hostname: string) => Promise<DnsRecord[]>;

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

export const hasControlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

export const normalizeHost = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\[|\]$/g, "");

const isLoopbackAddress = (ip: string): boolean => {
  const family = isIP(ip);
  if (family === 4) return LOOPBACK_NETS.check(ip, "ipv4");
  if (family === 6) return LOOPBACK_NETS.check(ip, "ipv6");
  return false;
};

export const isBlockedAddress = (ip: string, allowLocal = false): boolean => {
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

export const isValidHttpUrl = (value: string, allowLocal = false): boolean => {
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

export const resolveSafeAddresses = async (
  endpoint: string,
  {
    allowLocalBaseUrl = false,
    resolver,
  }: { allowLocalBaseUrl?: boolean; resolver?: DnsResolver } = {},
): Promise<DnsRecord[] | null> => {
  const parsed = new URL(endpoint);
  const bareHost = normalizeHost(parsed.hostname);
  const literalFamily = isIP(bareHost);
  if (literalFamily !== 0) {
    if (isBlockedAddress(bareHost, allowLocalBaseUrl)) return null;
    return [{ address: bareHost, family: literalFamily }];
  }
  const resolveDns = resolver ?? ((host: string) => dnsLookup(host, { all: true }));
  const resolved = await resolveDns(bareHost);
  if (
    resolved.length === 0 ||
    resolved.some((record) => isBlockedAddress(record.address, allowLocalBaseUrl))
  ) {
    return null;
  }
  return resolved;
};

export const readBoundedText = async (response: Response, maxBytes: number): Promise<string> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new Error("Outbound response exceeded size limit");
  }
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error("Outbound response exceeded size limit");
    }
    return new TextDecoder().decode(buf);
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
      throw new Error("Outbound response exceeded size limit");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
};

export const readBoundedJson = async (response: Response, maxBytes: number): Promise<unknown> =>
  JSON.parse(await readBoundedText(response, maxBytes));

const bodyBytes = (body: BodyInit | null | undefined): string | Uint8Array | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("Unsupported outbound request body type");
};

// Pin resolved IPs at socket creation so DNS rebinding cannot shift the target between check and connect.
export const createPinnedFetcher =
  (
    pinned: DnsRecord[],
    { maxResponseBytes }: { maxResponseBytes?: number } = {},
  ): OutboundFetcher =>
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
      const payload = bodyBytes(init?.body);
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
            reject(new Error("Outbound endpoint must not redirect"));
            return;
          }
          const contentLength = res.headers["content-length"];
          if (
            maxResponseBytes !== undefined &&
            contentLength &&
            Number(contentLength) > maxResponseBytes
          ) {
            res.destroy();
            reject(new Error("Outbound response exceeded size limit"));
            return;
          }
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) headers.set(k, v.join(", "));
            else if (v !== undefined) headers.set(k, v);
          }
          let totalBytes = 0;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on("data", (chunk: Buffer) => {
                totalBytes += chunk.byteLength;
                if (maxResponseBytes !== undefined && totalBytes > maxResponseBytes) {
                  const err = new Error("Outbound response exceeded size limit");
                  res.destroy(err);
                  controller.error(err);
                  return;
                }
                controller.enqueue(new Uint8Array(chunk));
                if ((controller.desiredSize ?? 1) <= 0) res.pause();
              });
              res.on("error", (err) => controller.error(err));
              res.on("end", () => controller.close());
            },
            pull() {
              res.resume();
            },
            cancel() {
              res.destroy();
            },
          });
          resolve(new Response(stream, { status, headers }));
        },
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
