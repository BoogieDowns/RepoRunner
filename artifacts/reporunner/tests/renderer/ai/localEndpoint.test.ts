// Stage 4E: local AI endpoint validation (pure; no network or DNS).
import { describe, expect, it } from "vitest";
import {
  LOCAL_ENDPOINT_ERROR_MESSAGES,
  LOCAL_ENDPOINT_MAX_BASE_PATH_LENGTH,
  LOCAL_ENDPOINT_MAX_LENGTH,
  validateLocalEndpoint,
  type LocalEndpointError,
} from "../../../src/lib/ai/localEndpoint";

const ok = (input: string) => {
  const result = validateLocalEndpoint(input);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to be accepted, got ${result.error}`);
  return result.endpoint;
};
const errorOf = (input: unknown) => {
  const result = validateLocalEndpoint(input);
  return result.ok ? `accepted as ${result.endpoint.url}` : result.error;
};

describe("accepted endpoints", () => {
  it.each([
    ["http://127.0.0.1:11434", "http://127.0.0.1:11434", "127.0.0.1", 11434, ""],
    ["http://127.0.0.1:1", "http://127.0.0.1:1", "127.0.0.1", 1, ""],
    ["http://127.0.0.1:65535", "http://127.0.0.1:65535", "127.0.0.1", 65535, ""],
    ["http://[::1]:8080", "http://[::1]:8080", "[::1]", 8080, ""],
    ["http://127.0.0.1:8080/", "http://127.0.0.1:8080", "127.0.0.1", 8080, ""],
    ["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1", "127.0.0.1", 8080, "/v1"],
    ["http://127.0.0.1:8080/v1/", "http://127.0.0.1:8080/v1", "127.0.0.1", 8080, "/v1"],
    ["http://[::1]:1234/api/openai-compat.v2_x~y", "http://[::1]:1234/api/openai-compat.v2_x~y", "[::1]", 1234, "/api/openai-compat.v2_x~y"],
    ["HTTP://127.0.0.1:8080", "http://127.0.0.1:8080", "127.0.0.1", 8080, ""],
  ])("%s", (input, url, host, port, basePath) => {
    expect(ok(input)).toEqual({ url, host, port, basePath });
  });

  it("keeps an explicit default port, which the URL parser would drop", () => {
    expect(new URL("http://127.0.0.1:80").port).toBe("");
    expect(ok("http://127.0.0.1:80")).toEqual({ url: "http://127.0.0.1:80", host: "127.0.0.1", port: 80, basePath: "" });
    expect(ok("http://[::1]:80/v1").url).toBe("http://[::1]:80/v1");
  });

  it("normalization is idempotent", () => {
    for (const input of ["http://127.0.0.1:8080/", "HTTP://[::1]:80/a/b/", "http://127.0.0.1:443/v1"]) {
      const once = ok(input).url;
      expect(ok(once).url).toBe(once);
    }
  });
});

describe("refused endpoints", () => {
  const cases: Array<[string, unknown, LocalEndpointError]> = [
    // Input type and size
    ["a number", 8080, "not-a-string"],
    ["null", null, "not-a-string"],
    ["a URL object", new URL("http://127.0.0.1:8080"), "not-a-string"],
    ["empty", "", "empty"],
    ["too long", "http://127.0.0.1:8080/" + "a".repeat(LOCAL_ENDPOINT_MAX_LENGTH), "too-long"],
    // Characters
    ["leading space", " http://127.0.0.1:8080", "invalid-characters"],
    ["trailing newline", "http://127.0.0.1:8080\n", "invalid-characters"],
    ["inner tab", "http://127.0.0.1:80\t80", "invalid-characters"],
    ["NUL", "http://127.0.0.1:8080\u0000", "invalid-characters"],
    ["DEL", "http://127.0.0.1:8080/\u007f", "invalid-characters"],
    ["backslash after the scheme", "http:\\\\127.0.0.1:8080", "invalid-characters"],
    ["backslash in the path", "http://127.0.0.1:8080\\v1", "invalid-characters"],
    ["Unicode host", "http://１２７.0.0.1:8080", "invalid-characters"],
    ["Unicode path", "http://127.0.0.1:8080/modèle", "invalid-characters"],
    ["zero-width space", "http://127.0.0.1\u200b:8080", "invalid-characters"],
    ["lone surrogate", "http://127.0.0.1:8080/\ud800", "invalid-characters"],
    // Query, fragment, userinfo, percent-encoding
    ["query", "http://127.0.0.1:8080/v1?x=1", "query-or-fragment-not-allowed"],
    ["empty query", "http://127.0.0.1:8080?", "query-or-fragment-not-allowed"],
    ["fragment", "http://127.0.0.1:8080/#top", "query-or-fragment-not-allowed"],
    ["empty fragment", "http://127.0.0.1:8080#", "query-or-fragment-not-allowed"],
    ["username", "http://user@127.0.0.1:8080", "credentials-not-allowed"],
    ["username and password", "http://user:pass@127.0.0.1:8080", "credentials-not-allowed"],
    ["empty userinfo", "http://@127.0.0.1:8080", "credentials-not-allowed"],
    ["host hidden behind userinfo", "http://127.0.0.1:8080@example.com:80", "credentials-not-allowed"],
    ["encoded path", "http://127.0.0.1:8080/v%31", "percent-encoding-not-allowed"],
    ["encoded dot segment", "http://127.0.0.1:8080/%2e%2e/admin", "percent-encoding-not-allowed"],
    ["encoded slash", "http://127.0.0.1:8080/a%2Fb", "percent-encoding-not-allowed"],
    ["encoded host", "http://127.0.0.%31:8080", "percent-encoding-not-allowed"],
    ["IPv6 zone id", "http://[::1%25eth0]:8080", "percent-encoding-not-allowed"],
    // Scheme
    ["https", "https://127.0.0.1:8443", "unsupported-scheme"],
    ["ws", "ws://127.0.0.1:8080", "unsupported-scheme"],
    ["file", "file://127.0.0.1/c:/x", "unsupported-scheme"],
    ["javascript", "javascript:alert(1)", "unsupported-scheme"],
    ["data", "data:text/plain,x", "unsupported-scheme"],
    ["no scheme", "127.0.0.1:8080", "malformed"],
    ["no scheme, name first (reads as a scheme)", "localhost:8080", "unsupported-scheme"],
    ["scheme-relative", "//127.0.0.1:8080", "malformed"],
    ["no slashes (the URL parser accepts it)", "http:127.0.0.1:8080", "malformed"],
    ["one slash (the URL parser accepts it)", "http:/127.0.0.1:8080", "malformed"],
    ["three slashes", "http:///127.0.0.1:8080", "malformed"],
    ["no authority", "http://", "malformed"],
    ["unclosed IPv6 bracket", "http://[::1:8080", "malformed"],
    ["junk after IPv6 bracket", "http://[::1]x:8080", "malformed"],
    // Hosts
    ["localhost", "http://localhost:8080", "localhost-not-allowed"],
    ["LOCALHOST", "http://LOCALHOST:8080", "localhost-not-allowed"],
    ["localhost.", "http://localhost.:8080", "localhost-not-allowed"],
    ["sub.localhost", "http://a.localhost:8080", "host-not-allowed"],
    ["127.1 (the URL parser rewrites it)", "http://127.1:8080", "host-not-allowed"],
    ["127.0.1", "http://127.0.1:8080", "host-not-allowed"],
    ["hexadecimal", "http://0x7f.0.0.1:8080", "host-not-allowed"],
    ["single hexadecimal number", "http://0x7f000001:8080", "host-not-allowed"],
    ["decimal number", "http://2130706433:8080", "host-not-allowed"],
    ["octal", "http://0177.0.0.1:8080", "host-not-allowed"],
    ["leading zero", "http://127.0.0.01:8080", "host-not-allowed"],
    ["trailing dot", "http://127.0.0.1.:8080", "host-not-allowed"],
    ["127.0.0.2", "http://127.0.0.2:8080", "host-not-allowed"],
    ["127.255.255.254", "http://127.255.255.254:8080", "host-not-allowed"],
    ["0.0.0.0", "http://0.0.0.0:8080", "host-not-allowed"],
    ["0", "http://0:8080", "host-not-allowed"],
    ["LAN 192.168", "http://192.168.1.10:8080", "host-not-allowed"],
    ["LAN 10/8", "http://10.0.0.5:11434", "host-not-allowed"],
    ["link-local", "http://169.254.169.254:80", "host-not-allowed"],
    ["public IP", "http://8.8.8.8:80", "host-not-allowed"],
    ["public name", "http://example.com:80", "host-not-allowed"],
    ["name resolving to loopback", "http://127.0.0.1.nip.io:8080", "host-not-allowed"],
    ["empty host", "http://:8080", "host-not-allowed"],
    ["IPv6 unspecified", "http://[::]:8080", "host-not-allowed"],
    ["IPv6 loopback, long form", "http://[0:0:0:0:0:0:0:1]:8080", "host-not-allowed"],
    ["IPv6 loopback, leading zeros", "http://[::0001]:8080", "host-not-allowed"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]:8080", "host-not-allowed"],
    ["IPv4-mapped loopback, hex", "http://[::ffff:7f00:1]:8080", "host-not-allowed"],
    ["IPv4-compatible loopback", "http://[::127.0.0.1]:8080", "host-not-allowed"],
    ["IPv6 LAN", "http://[fe80::1]:8080", "host-not-allowed"],
    ["unbracketed IPv6", "http://::1:8080", "host-not-allowed"],
    // Ports
    ["no port", "http://127.0.0.1", "port-required"],
    ["no port, with a path", "http://127.0.0.1/v1", "port-required"],
    ["no IPv6 port", "http://[::1]", "port-required"],
    ["empty port", "http://127.0.0.1:", "port-required"],
    ["empty IPv6 port", "http://[::1]:/v1", "port-required"],
    ["port 0", "http://127.0.0.1:0", "invalid-port"],
    ["port 65536", "http://127.0.0.1:65536", "invalid-port"],
    ["port 99999", "http://127.0.0.1:99999", "invalid-port"],
    ["six-digit port", "http://127.0.0.1:100000", "invalid-port"],
    ["leading zero port", "http://127.0.0.1:080", "invalid-port"],
    ["negative port", "http://127.0.0.1:-1", "invalid-port"],
    ["plus sign", "http://127.0.0.1:+80", "invalid-port"],
    ["hex port", "http://127.0.0.1:0x50", "invalid-port"],
    ["exponent port", "http://127.0.0.1:8e3", "invalid-port"],
    ["two ports", "http://127.0.0.1:80:81", "invalid-port"],
    ["named port", "http://127.0.0.1:http", "invalid-port"],
    // Paths
    ["dot segment", "http://127.0.0.1:8080/./v1", "invalid-path"],
    ["dot-dot segment", "http://127.0.0.1:8080/v1/../admin", "invalid-path"],
    ["trailing dot-dot", "http://127.0.0.1:8080/v1/..", "invalid-path"],
    ["trailing dot", "http://127.0.0.1:8080/v1/.", "invalid-path"],
    ["triple dot", "http://127.0.0.1:8080/...", "invalid-path"],
    ["empty segment", "http://127.0.0.1:8080//v1", "invalid-path"],
    ["double trailing slash", "http://127.0.0.1:8080/v1//", "invalid-path"],
    ["only slashes", "http://127.0.0.1:8080//", "invalid-path"],
    ["semicolon", "http://127.0.0.1:8080/v1;x", "invalid-path"],
    ["colon in path", "http://127.0.0.1:8080/c:", "invalid-path"],
    ["quote in path", "http://127.0.0.1:8080/a'b", "invalid-path"],
    ["angle bracket", "http://127.0.0.1:8080/<x>", "invalid-path"],
    ["long base path", "http://127.0.0.1:8080/" + "a".repeat(LOCAL_ENDPOINT_MAX_BASE_PATH_LENGTH), "path-too-long"],
  ];

  it.each(cases)("%s", (_name, input, error) => {
    expect(errorOf(input)).toBe(error);
  });

  it("the base-path limit is inclusive", () => {
    const longest = "/" + "a".repeat(LOCAL_ENDPOINT_MAX_BASE_PATH_LENGTH - 1);
    expect(ok("http://127.0.0.1:8080" + longest).basePath).toBe(longest);
  });

  it("the overall length limit is inclusive", () => {
    const prefix = "http://127.0.0.1:8080/";
    const atLimit = prefix + "a".repeat(LOCAL_ENDPOINT_MAX_LENGTH - prefix.length);
    expect(atLimit.length).toBe(LOCAL_ENDPOINT_MAX_LENGTH);
    expect(errorOf(atLimit)).toBe("path-too-long"); // passes the length check, then fails the path limit
    expect(errorOf(atLimit + "a")).toBe("too-long");
  });

  it("the URL parser alone would have accepted many of these", () => {
    // Shows why the raw checks come first.
    for (const input of ["http://127.1:8080", "http://0x7f.0.0.1:8080", "http:127.0.0.1:8080", "http://127.0.0.1:8080/a/../b", "http://127.0.0.%31:8080", "http:\\\\127.0.0.1:8080"]) {
      expect(new URL(input).hostname).toBe("127.0.0.1");
      expect(validateLocalEndpoint(input).ok).toBe(false);
    }
  });
});

describe("error results", () => {
  it("are fixed codes with fixed messages that never echo the input", () => {
    const secretish = "http://user:sk-SYNTHETIC-0000@127.0.0.1:8080";
    const result = validateLocalEndpoint(secretish);
    expect(result).toEqual({ ok: false, error: "credentials-not-allowed" });
    for (const message of Object.values(LOCAL_ENDPOINT_ERROR_MESSAGES)) {
      expect(message).not.toContain("SYNTHETIC");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("never throws, whatever the input", () => {
    const odd: unknown[] = [undefined, {}, [], Symbol("x"), () => "http://127.0.0.1:1", { toString: () => "http://127.0.0.1:1" }, "\u0000".repeat(300), "[".repeat(100)];
    for (const input of odd) expect(() => validateLocalEndpoint(input)).not.toThrow();
    expect(validateLocalEndpoint({ toString: () => "http://127.0.0.1:1" })).toEqual({ ok: false, error: "not-a-string" });
  });
});
