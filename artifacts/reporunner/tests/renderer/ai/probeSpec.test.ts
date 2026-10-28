// Stage 4N: the pure probe specification: the exact request, status and
// header rules, and the bounded body checks. No sockets here (see
// tests/electron/localProbe.test.ts). Synthetic values only.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROBE_DEADLINES,
  PROBE_MAX_BODY_BYTES,
  PROBE_MAX_HEADER_BYTES,
  PROBE_MAX_MODELS,
  PROBE_MAX_MODEL_ID_LENGTH,
  PROBE_PATHS,
  PROBE_USER_AGENT,
  acceptableHeaders,
  buildProbeRequest,
  checkProbeBody,
  resultForStatus,
} from "../../../src/lib/ai/probeSpec";

const enc = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const models = (n: number, id = (i: number) => `model-${i}`) => ({ object: "list", data: Array.from({ length: n }, (_, i) => ({ id: id(i), object: "model" })) });

describe("constants", () => {
  it("fixed paths, limits, deadlines and user agent", () => {
    expect(PROBE_PATHS).toEqual({ "ollama-native": "/api/version", "openai-compatible": "/models" });
    expect(PROBE_MAX_BODY_BYTES).toEqual({ "ollama-native": 8192, "openai-compatible": 262144 });
    expect(PROBE_MAX_HEADER_BYTES).toBe(16384);
    expect(PROBE_MAX_MODELS).toBe(1000);
    expect(PROBE_MAX_MODEL_ID_LENGTH).toBe(256);
    expect(PROBE_DEADLINES).toEqual({ connectMs: 2000, headersMs: 3000, idleMs: 2000, totalMs: 8000 });
    expect(PROBE_USER_AGENT).toBe("RepoRunner-LocalProbe/1");
    expect(Object.isFrozen(PROBE_PATHS) && Object.isFrozen(PROBE_MAX_BODY_BYTES) && Object.isFrozen(PROBE_DEADLINES)).toBe(true);
  });
});

describe("buildProbeRequest", () => {
  it("ollama-native on IPv4: GET {base}/api/version with exactly five headers", () => {
    const r = buildProbeRequest({ endpoint: "http://127.0.0.1:11434", apiStyle: "ollama-native" });
    expect(r).toEqual({
      ok: true,
      request: {
        apiStyle: "ollama-native",
        method: "GET",
        host: "127.0.0.1",
        family: 4,
        port: 11434,
        path: "/api/version",
        url: "http://127.0.0.1:11434/api/version",
        headers: [
          ["Host", "127.0.0.1:11434"],
          ["Accept", "application/json"],
          ["Accept-Encoding", "identity"],
          ["Connection", "close"],
          ["User-Agent", "RepoRunner-LocalProbe/1"],
        ],
        maxBodyBytes: 8192,
      },
    });
    expect(r.ok && Object.isFrozen(r.request) && Object.isFrozen(r.request.headers) && Object.isFrozen(r.request.headers[0])).toBe(true);
  });

  it("openai-compatible on IPv6 with a base path: the base path is kept exactly, no /v1 added", () => {
    const r = buildProbeRequest({ endpoint: "http://[::1]:8080/v1", apiStyle: "openai-compatible" });
    expect(r.ok && r.request).toMatchObject({ host: "::1", family: 6, port: 8080, path: "/v1/models", url: "http://[::1]:8080/v1/models", maxBodyBytes: 262144 });
    expect(r.ok && r.request.headers[0]).toEqual(["Host", "[::1]:8080"]);
    const bare = buildProbeRequest({ endpoint: "http://127.0.0.1:1234", apiStyle: "openai-compatible" });
    expect(bare.ok && bare.request.path).toBe("/models");
    const nested = buildProbeRequest({ endpoint: "http://127.0.0.1:1234/a/b.c", apiStyle: "ollama-native" });
    expect(nested.ok && nested.request.path).toBe("/a/b.c/api/version");
  });

  it("ignores extra fields (a saved configuration can be passed as is)", () => {
    const r = buildProbeRequest({ id: "cfg-a1", kind: "local-endpoint", endpoint: "http://127.0.0.1:1", apiStyle: "ollama-native", model: "x" });
    expect(r.ok).toBe(true);
  });

  it.each([
    ["localhost", "http://localhost:11434"],
    ["another 127/8 address", "http://127.0.0.2:11434"],
    ["a LAN address", "http://192.168.1.5:11434"],
    ["a public address", "http://8.8.8.8:80"],
    ["a name", "http://example.com:80"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]:1"],
    ["0.0.0.0", "http://0.0.0.0:1"],
    ["no port", "http://127.0.0.1"],
    ["https", "https://127.0.0.1:443"],
    ["userinfo", "http://u@127.0.0.1:1"],
    ["a query", "http://127.0.0.1:1/?a"],
    ["a fragment", "http://127.0.0.1:1/#a"],
    ["%-encoding", "http://127.0.0.1:1/%2e%2e"],
    ["a dot segment", "http://127.0.0.1:1/a/../b"],
    ["non-canonical: upper-case scheme", "HTTP://127.0.0.1:1"],
    ["non-canonical: trailing slash", "http://127.0.0.1:1/"],
    ["non-canonical: trailing slash after a path", "http://127.0.0.1:1/v1/"],
    ["not a string", 11434],
    ["missing", undefined],
  ])("refuses %s", (_name, endpoint) => {
    expect(buildProbeRequest({ endpoint, apiStyle: "ollama-native" })).toEqual({ ok: false, error: "invalid-endpoint" });
  });

  it("refuses unknown API styles, non-objects, getters and inherited fields", () => {
    expect(buildProbeRequest({ endpoint: "http://127.0.0.1:1", apiStyle: "openai" })).toEqual({ ok: false, error: "invalid-api-style" });
    expect(buildProbeRequest({ endpoint: "http://127.0.0.1:1" })).toEqual({ ok: false, error: "invalid-api-style" });
    expect(buildProbeRequest(null)).toEqual({ ok: false, error: "invalid-api-style" });
    expect(buildProbeRequest("http://127.0.0.1:1")).toEqual({ ok: false, error: "invalid-api-style" });
    let reads = 0;
    const getter = { apiStyle: "ollama-native", get endpoint() { reads++; return "http://127.0.0.1:1"; } };
    expect(buildProbeRequest(getter)).toEqual({ ok: false, error: "invalid-endpoint" });
    expect(reads).toBe(0);
    const inherited = Object.create({ endpoint: "http://127.0.0.1:1", apiStyle: "ollama-native" });
    expect(buildProbeRequest(inherited).ok).toBe(false);
  });
});

describe("status and headers", () => {
  it.each([
    [200, null],
    [301, { outcome: "redirect-refused" }],
    [302, { outcome: "redirect-refused" }],
    [307, { outcome: "redirect-refused" }],
    [308, { outcome: "redirect-refused" }],
    [304, { outcome: "redirect-refused" }],
    [401, { outcome: "auth-required" }],
    [403, { outcome: "auth-required" }],
    [404, { outcome: "not-found-at-path" }],
    [101, { outcome: "incompatible-response" }],
    [204, { outcome: "incompatible-response" }],
    [206, { outcome: "incompatible-response" }],
    [400, { outcome: "http-error", statusClass: "4xx" }],
    [429, { outcome: "http-error", statusClass: "4xx" }],
    [500, { outcome: "http-error", statusClass: "5xx" }],
    [503, { outcome: "http-error", statusClass: "5xx" }],
    [600, { outcome: "http-error", statusClass: "other" }],
    [0, { outcome: "http-error", statusClass: "other" }],
  ])("status %i", (status, expected) => {
    expect(resultForStatus(status)).toEqual(expected);
  });

  it.each([
    ["application/json", undefined, true],
    ["application/json; charset=utf-8", undefined, true],
    ["Application/JSON;charset=UTF-8", "identity", true],
    ['application/json; charset="utf-8"', "IDENTITY", true],
    ["application/json", "gzip", false],
    ["application/json", "br", false],
    ["application/json", "deflate", false],
    ["application/json", "identity, gzip", false],
    ["application/json; charset=latin1", undefined, false],
    ["text/html", undefined, false],
    ["text/plain", undefined, false],
    ["application/json-seq", undefined, false],
    ["application/problem+json", undefined, false],
    [undefined, undefined, false],
    ["application/json", ["identity"], false],
  ])("content-type %s, encoding %s", (type, encoding, ok) => {
    expect(acceptableHeaders(type, encoding)).toBe(ok);
  });
});

describe("checkProbeBody: ollama-native", () => {
  it.each(["0.5.7", "0.6.0-rc1", "1.2.3+build.5", "10.20.30"])("accepts version %s and never returns it", (version) => {
    const r = checkProbeBody("ollama-native", enc({ version }));
    expect(r).toEqual({ outcome: "compatible", modelCount: null });
    expect(JSON.stringify(r)).not.toContain(version);
  });

  it("other keys are ignored, including prototype-like ones, without pollution", () => {
    const body = '{"version":"0.5.7","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"extra":[1,2,3]}';
    expect(checkProbeBody("ollama-native", enc(body))).toEqual({ outcome: "compatible", modelCount: null });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it.each([
    ["missing version", {}],
    ["number version", { version: 5 }],
    ["empty version", { version: "" }],
    ["HTML version", { version: "<b>1.0.0</b>" }],
    ["too long", { version: `1.2.3-${"a".repeat(30)}` }],
    ["control characters", { version: "1.2.3\u0000" }],
    ["a version only via __proto__", '{"__proto__":{"version":"0.5.7"}}'],
    ["an array", [{ version: "0.5.7" }]],
    ["a string", '"0.5.7"'],
    ["null", "null"],
    ["malformed JSON", '{"version":"0.5.7"'],
    ["trailing garbage", '{"version":"0.5.7"}x'],
    ["empty body", ""],
  ])("%s is incompatible", (_name, body) => {
    expect(checkProbeBody("ollama-native", enc(body))).toEqual({ outcome: "incompatible-response" });
  });

  it("invalid UTF-8 is incompatible", () => {
    const bytes = new Uint8Array([...enc('{"version":"0.5.7","x":"'), 0xc3, 0x28, ...enc('"}')]);
    expect(checkProbeBody("ollama-native", bytes)).toEqual({ outcome: "incompatible-response" });
  });

  it("over the byte limit is too large, even if valid", () => {
    const fill = "x".repeat(8192);
    expect(checkProbeBody("ollama-native", enc({ version: "0.5.7", fill }))).toEqual({ outcome: "response-too-large" });
  });
});

describe("checkProbeBody: openai-compatible", () => {
  it("returns only the count: never model names", () => {
    const r = checkProbeBody("openai-compatible", enc(models(3, (i) => `secret-model-name-${i}`)));
    expect(r).toEqual({ outcome: "compatible", modelCount: 3 });
    expect(JSON.stringify(r)).not.toContain("secret-model-name");
    expect(checkProbeBody("openai-compatible", enc({ object: "list", data: [] }))).toEqual({ outcome: "compatible", modelCount: 0 });
  });

  it("exactly 1000 entries are accepted; 1001 are not", () => {
    expect(checkProbeBody("openai-compatible", enc(models(1000, (i) => `m${i}`)))).toEqual({ outcome: "compatible", modelCount: 1000 });
    expect(checkProbeBody("openai-compatible", enc(models(1001, (i) => `m${i}`)))).toEqual({ outcome: "incompatible-response" });
  });

  it("ids of 256 characters are accepted; 257 are not", () => {
    expect(checkProbeBody("openai-compatible", enc(models(1, () => "a".repeat(256))))).toEqual({ outcome: "compatible", modelCount: 1 });
    expect(checkProbeBody("openai-compatible", enc(models(1, () => "a".repeat(257))))).toEqual({ outcome: "incompatible-response" });
  });

  it.each([
    ["wrong object", { object: "model", data: [] }],
    ["missing object", { data: [] }],
    ["missing data", { object: "list" }],
    ["data not an array", { object: "list", data: { id: "a" } }],
    ["entry not an object", { object: "list", data: ["a"] }],
    ["entry an array", { object: "list", data: [["a"]] }],
    ["entry null", { object: "list", data: [null] }],
    ["entry without id", { object: "list", data: [{ name: "a" }] }],
    ["numeric id", { object: "list", data: [{ id: 1 }] }],
    ["empty id", { object: "list", data: [{ id: "" }] }],
    ["data only via __proto__", '{"object":"list","__proto__":{"data":[]}}'],
    ["id only via __proto__", '{"object":"list","data":[{"__proto__":{"id":"a"}}]}'],
  ])("%s is incompatible", (_name, body) => {
    expect(checkProbeBody("openai-compatible", enc(body))).toEqual({ outcome: "incompatible-response" });
  });

  it("deeply nested JSON at the byte limit doesn't crash: a fixed result", () => {
    const half = 256 * 1024 / 2;
    const nested = "[".repeat(half) + "]".repeat(half);
    expect(checkProbeBody("openai-compatible", enc(nested))).toEqual({ outcome: "incompatible-response" });
    const deepObject = '{"object":"list","data":[{"id":"a","x":' + "[".repeat(100000) + "]".repeat(100000) + "}]}";
    expect(checkProbeBody("openai-compatible", enc(deepObject))).toEqual({ outcome: "compatible", modelCount: 1 });
  });

  it("one byte over 256 KiB is too large", () => {
    const pad = (n: number) => JSON.stringify({ object: "list", data: [], pad: "x".repeat(n) });
    const base = pad(0).length;
    expect(checkProbeBody("openai-compatible", enc(pad(262144 - base)))).toEqual({ outcome: "compatible", modelCount: 0 });
    expect(checkProbeBody("openai-compatible", enc(pad(262145 - base)))).toEqual({ outcome: "response-too-large" });
  });
});

describe("source boundaries", () => {
  it("pure: no network, files, environment, Electron, clock or logging", () => {
    const code = fs.readFileSync(path.resolve(import.meta.dirname, "../../../src/lib/ai/probeSpec.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect([...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["./localEndpoint.js", "./settingsSchema.js"]);
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|require\(|import\(|process\.|Date\.|console\.|setTimeout|electron|node:/);
  });
});
