import { describe, expect, spyOn, test } from "bun:test";
import http from "node:http";
import { PassThrough } from "node:stream";

import {
  createPinnedFetcher,
  hasControlChars,
  isBlockedAddress,
  isValidHttpUrl,
  normalizeHost,
  readBoundedJson,
  readBoundedText,
  resolveSafeAddresses,
} from "./outbound-url";

describe("outbound-url", () => {
  test("validates http/https URLs and blocks reserved/metadata/internal hosts", () => {
    expect(isValidHttpUrl("https://api.openai.com/v1")).toBe(true);
    expect(isValidHttpUrl("http://api.openai.com/v1")).toBe(false);
    expect(isValidHttpUrl("http://127.0.0.1:11434/v1")).toBe(false);
    expect(isValidHttpUrl("http://127.0.0.1:11434/v1", true)).toBe(true);
    expect(isValidHttpUrl("http://localhost:8000/v1", true)).toBe(true);
    expect(isValidHttpUrl("https://user:pass@api.openai.com/v1")).toBe(false);
    expect(isValidHttpUrl("https://metadata.google.internal.")).toBe(false);
    expect(isValidHttpUrl("https://extract/internal")).toBe(false);
    expect(isValidHttpUrl("https://service.internal/v1")).toBe(false);
    expect(isValidHttpUrl("https://api.openai.com/v1\n")).toBe(false);
    expect(hasControlChars("sk-valid-123")).toBe(false);
    expect(hasControlChars("sk-bad\u0000key")).toBe(true);
    expect(normalizeHost("[::1].")).toBe("::1");
  });

  test("blocks reserved IPv4, IPv6, IPv4-mapped IPv6, and zone IDs", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.0.0.1", true)).toBe(false);
    expect(isBlockedAddress("169.254.169.254", true)).toBe(true);
    expect(isBlockedAddress("10.0.0.1", true)).toBe(true);
    expect(isBlockedAddress("::ffff:a9fe:a9fe", true)).toBe(true);
    expect(isBlockedAddress("fe80::1%en0", true)).toBe(true);
    expect(isBlockedAddress("fc00::1", true)).toBe(true);
    expect(isBlockedAddress("not-an-ip", true)).toBe(true);
  });

  test("resolveSafeAddresses checks literals and rejects DNS responses containing blocked IPs", async () => {
    expect(await resolveSafeAddresses("https://169.254.169.254/v1")).toBeNull();
    expect(
      await resolveSafeAddresses("http://127.0.0.1:8000/v1", { allowLocalBaseUrl: true }),
    ).toEqual([{ address: "127.0.0.1", family: 4 }]);
    expect(
      await resolveSafeAddresses("https://evil.example.com/v1", {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ],
      }),
    ).toBeNull();
    expect(
      await resolveSafeAddresses("https://good.example.com/v1", {
        resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  test("readBoundedText and readBoundedJson reject oversized content-length and streams", async () => {
    const small = new Response(JSON.stringify({ ok: true }));
    expect(await readBoundedJson(small, 100)).toEqual({ ok: true });

    const byHeader = new Response("ok", { headers: { "content-length": "500" } });
    await expect(readBoundedText(byHeader, 100)).rejects.toThrow("size limit");

    const byBody = new Response("x".repeat(200));
    await expect(readBoundedText(byBody, 100)).rejects.toThrow("size limit");
  });

  test("createPinnedFetcher forwards POST body, streams chunks, rejects redirects, and enforces maxResponseBytes", async () => {
    const pinned = [{ address: "127.0.0.1", family: 4 }];
    const writtenBodies: string[] = [];

    const spy = spyOn(http, "request").mockImplementation(((_opts: unknown, cb: unknown) => {
      const req = {
        on: () => req,
        write: (chunk: unknown) => writtenBodies.push(String(chunk)),
        end: () => {
          const res = new PassThrough() as PassThrough & {
            statusCode?: number;
            headers: Record<string, string>;
          };
          res.statusCode = 200;
          res.headers = { "content-type": "text/event-stream" };
          (cb as (r: typeof res) => void)(res);
          queueMicrotask(() => {
            res.write("data: one\n\n");
            res.end("data: [DONE]\n\n");
          });
        },
      };
      return req as unknown as http.ClientRequest;
    }) as typeof http.request);

    try {
      const fetcher = createPinnedFetcher(pinned);
      const res = await fetcher("http://localhost:8000/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
      });
      expect(writtenBodies).toEqual(['{"model":"m"}']);
      expect(await res.text()).toBe("data: one\n\ndata: [DONE]\n\n");

      spy.mockImplementationOnce(((_opts: unknown, cb: unknown) => {
        const req = {
          on: () => req,
          write: () => {},
          end: () => {
            const res = new PassThrough() as PassThrough & {
              statusCode?: number;
              headers: Record<string, string>;
            };
            res.statusCode = 302;
            res.headers = { location: "http://169.254.169.254" };
            (cb as (r: typeof res) => void)(res);
          },
        };
        return req as unknown as http.ClientRequest;
      }) as typeof http.request);
      await expect(fetcher("http://localhost:8000/v1/models")).rejects.toThrow("must not redirect");

      spy.mockImplementationOnce(((_opts: unknown, cb: unknown) => {
        const req = {
          on: () => req,
          write: () => {},
          end: () => {
            const res = new PassThrough() as PassThrough & {
              statusCode?: number;
              headers: Record<string, string>;
            };
            res.statusCode = 200;
            res.headers = {};
            (cb as (r: typeof res) => void)(res);
            queueMicrotask(() => {
              res.write("12345678901");
            });
          },
        };
        return req as unknown as http.ClientRequest;
      }) as typeof http.request);
      const bounded = createPinnedFetcher(pinned, { maxResponseBytes: 10 });
      const cappedRes = await bounded("http://localhost:8000/v1/models");
      await expect(cappedRes.text()).rejects.toThrow("size limit");
    } finally {
      spy.mockRestore();
    }
  });
});
