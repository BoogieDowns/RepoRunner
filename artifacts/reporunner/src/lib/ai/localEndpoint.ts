// Stage 4E: validation for a user-entered local AI endpoint. Pure: no
// network, DNS, files, environment or Electron. Nothing in the app uses it yet.
//
// Accepted, and nothing else:
//   http://127.0.0.1:<port>[/base/path]
//   http://[::1]:<port>[/base/path]
//
// The raw text is checked against that grammar first, because the WHATWG URL
// parser rewrites input: it turns 127.1 or 0x7f.0.0.1 into 127.0.0.1, drops
// an explicit :80, decodes %-escapes in the host, resolves dot segments and
// treats "\" as "/". Accepting what the parser produced would accept text
// that doesn't say what it means. The parser is used afterwards only to
// confirm it reads the canonical form the same way.
//
// - localhost is refused (it's resolved by the OS and hosts file, and may be
//   either address family), as are every other 127/8 address, 0.0.0.0,
//   IPv4-mapped IPv6 and all LAN or public addresses.
// - HTTP only. A loopback connection doesn't leave the machine, and HTTPS
//   here would invite turning off certificate checks.
// - Loopback is not authentication: any local program can listen on the port.

export const LOCAL_ENDPOINT_MAX_LENGTH = 256;
export const LOCAL_ENDPOINT_MAX_BASE_PATH_LENGTH = 128;

export const LOCAL_ENDPOINT_HOSTS = Object.freeze(["127.0.0.1", "[::1]"] as const);
export type LocalEndpointHost = (typeof LOCAL_ENDPOINT_HOSTS)[number];

/** Fixed error codes. None contains any part of the input. */
export type LocalEndpointError =
  | "not-a-string"
  | "empty"
  | "too-long"
  | "invalid-characters"
  | "percent-encoding-not-allowed"
  | "credentials-not-allowed"
  | "query-or-fragment-not-allowed"
  | "unsupported-scheme"
  | "malformed"
  | "localhost-not-allowed"
  | "host-not-allowed"
  | "port-required"
  | "invalid-port"
  | "invalid-path"
  | "path-too-long";

export const LOCAL_ENDPOINT_ERROR_MESSAGES: Readonly<Record<LocalEndpointError, string>> = Object.freeze({
  "not-a-string": "Enter the endpoint address as text.",
  empty: "Enter an endpoint address.",
  "too-long": `The endpoint address is too long (at most ${LOCAL_ENDPOINT_MAX_LENGTH} characters).`,
  "invalid-characters": "The endpoint address can't contain spaces, control characters, backslashes or non-ASCII characters.",
  "percent-encoding-not-allowed": "The endpoint address can't contain %-encoded characters.",
  "credentials-not-allowed": "The endpoint address can't contain a username or password.",
  "query-or-fragment-not-allowed": "The endpoint address can't contain ? or #.",
  "unsupported-scheme": "Only http:// endpoints on this computer are supported.",
  malformed: "That isn't a valid endpoint address. Use http://127.0.0.1:<port>.",
  "localhost-not-allowed": "Use 127.0.0.1 or [::1] instead of localhost.",
  "host-not-allowed": "Only endpoints on this computer are supported: use 127.0.0.1 or [::1], written exactly.",
  "port-required": "Include the port, for example http://127.0.0.1:8080.",
  "invalid-port": "The port must be a number from 1 to 65535, without leading zeros.",
  "invalid-path": "The base path may contain only letters, digits and . _ ~ - between single slashes, with no . or .. segments.",
  "path-too-long": `The base path is too long (at most ${LOCAL_ENDPOINT_MAX_BASE_PATH_LENGTH} characters).`,
});

export interface LocalEndpoint {
  /** The canonical form, e.g. "http://127.0.0.1:11434" or "http://[::1]:8080/v1". */
  url: string;
  host: LocalEndpointHost;
  port: number;
  /** "" or "/segment[/segment...]", with no trailing slash. */
  basePath: string;
}

export type LocalEndpointResult = { ok: true; endpoint: LocalEndpoint } | { ok: false; error: LocalEndpointError };

const fail = (error: LocalEndpointError): LocalEndpointResult => ({ ok: false, error });

/** Printable ASCII except space and backslash. */
const ALLOWED_CHARS = /^[\x21-\x5b\x5d-\x7e]*$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const PORT = /^[1-9][0-9]{0,4}$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

function parseHost(text: string): LocalEndpointHost | LocalEndpointError {
  if ((LOCAL_ENDPOINT_HOSTS as readonly string[]).includes(text)) return text as LocalEndpointHost;
  const lower = text.toLowerCase();
  if (lower === "localhost" || lower === "localhost.") return "localhost-not-allowed";
  return "host-not-allowed";
}

function parseBasePath(text: string): string | LocalEndpointError {
  if (text === "" || text === "/") return "";
  const trimmed = text.endsWith("/") ? text.slice(0, -1) : text;
  if (trimmed.length > LOCAL_ENDPOINT_MAX_BASE_PATH_LENGTH) return "path-too-long";
  const segments = trimmed.slice(1).split("/");
  // Empty segments (//), and segments of dots only (., .., ...), are refused.
  for (const segment of segments) if (!SEGMENT.test(segment) || /^\.+$/.test(segment)) return "invalid-path";
  return trimmed;
}

/** Validates and normalizes a local endpoint address. Never throws. */
export function validateLocalEndpoint(input: unknown): LocalEndpointResult {
  if (typeof input !== "string") return fail("not-a-string");
  if (input.length === 0) return fail("empty");
  if (input.length > LOCAL_ENDPOINT_MAX_LENGTH) return fail("too-long");
  if (!ALLOWED_CHARS.test(input)) return fail("invalid-characters");
  if (input.includes("?") || input.includes("#")) return fail("query-or-fragment-not-allowed");
  if (input.includes("@")) return fail("credentials-not-allowed");
  if (input.includes("%")) return fail("percent-encoding-not-allowed");

  const scheme = SCHEME.exec(input);
  if (!scheme) return fail("malformed");
  if (scheme[1].toLowerCase() !== "http") return fail("unsupported-scheme");
  // Exactly "http://": the URL parser also accepts "http:host" and "http:/host".
  const rest = input.slice(scheme[0].length);
  if (!rest.startsWith("//")) return fail("malformed");
  const afterSlashes = rest.slice(2);
  const slash = afterSlashes.indexOf("/");
  const authority = slash === -1 ? afterSlashes : afterSlashes.slice(0, slash);
  const pathText = slash === -1 ? "" : afterSlashes.slice(slash);
  if (authority.length === 0) return fail("malformed");

  let hostText: string;
  let portText: string | null;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return fail("malformed");
    hostText = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after === "") portText = null;
    else if (after.startsWith(":")) portText = after.slice(1);
    else return fail("malformed");
  } else {
    const colon = authority.indexOf(":");
    hostText = colon === -1 ? authority : authority.slice(0, colon);
    portText = colon === -1 ? null : authority.slice(colon + 1);
  }

  const host = parseHost(hostText);
  if (host !== "127.0.0.1" && host !== "[::1]") return fail(host);
  if (portText === null || portText === "") return fail("port-required");
  if (!PORT.test(portText)) return fail("invalid-port");
  const port = Number(portText);
  if (port < 1 || port > 65535) return fail("invalid-port");

  const basePath = parseBasePath(pathText);
  if (basePath === "path-too-long" || basePath === "invalid-path") return fail(basePath);

  const url = `http://${host}:${port}${basePath}`;

  // Cross-check: the WHATWG parser must read the canonical form identically.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("malformed");
  }
  const expectedPort = port === 80 ? "" : String(port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== host ||
    parsed.port !== expectedPort ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== (basePath === "" ? "/" : basePath)
  ) {
    return fail("malformed");
  }

  return { ok: true, endpoint: { url, host, port, basePath } };
}
