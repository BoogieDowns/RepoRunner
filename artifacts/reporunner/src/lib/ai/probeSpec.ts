// Stage 4N: the exact request a local AI compatibility probe sends, and the
// checks its answer must pass. Pure: no network, DNS, files, environment,
// clock or Electron. The main-process transport (electron/localProbe.ts) and
// a future preview both derive the request from buildProbeRequest, so what a
// user is shown and what is sent can't drift apart.
//
// A probe asks one fixed, read-only question of a saved local endpoint:
//   ollama-native      GET {basePath}/api/version
//   openai-compatible  GET {basePath}/models
// No other path, no fallback, no implied /v1, no body, no credentials.
//
// What a "compatible" answer means: something listening on that loopback port
// answered in the expected shape. Not which program it is (any local process
// can listen there), not that it's trusted or authenticated, and not that any
// AI feature is ready: readiness is decided elsewhere (providerReadiness.ts)
// and stays "none" while no adapter exists.
//
// Nothing the server sends is ever returned: not its version string, model
// names, headers, error text or body. Results are fixed codes, an HTTP status
// class, or a bounded model count.
import { validateLocalEndpoint } from "./localEndpoint.js";
import { LOCAL_API_STYLES, type LocalApiStyle } from "./settingsSchema.js";

export const PROBE_USER_AGENT = "RepoRunner-LocalProbe/1";

/** The one path suffix each API style is probed at, appended to the validated base path. */
export const PROBE_PATHS: Readonly<Record<LocalApiStyle, string>> = Object.freeze({
  "ollama-native": "/api/version",
  "openai-compatible": "/models",
});

/** Largest response body accepted, in bytes. One byte more is "response-too-large". */
export const PROBE_MAX_BODY_BYTES: Readonly<Record<LocalApiStyle, number>> = Object.freeze({
  "ollama-native": 8 * 1024,
  "openai-compatible": 256 * 1024,
});

/** Largest response header block (Node's maxHeaderSize). */
export const PROBE_MAX_HEADER_BYTES = 16 * 1024;
export const PROBE_MAX_MODELS = 1000;
export const PROBE_MAX_MODEL_ID_LENGTH = 256;
export const PROBE_MAX_VERSION_LENGTH = 32;
/** An Ollama version such as 0.5.7 or 0.6.0-rc1. Checked, never returned. */
export const PROBE_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+.][0-9A-Za-z.]{1,24})?$/;

/** Deadlines in milliseconds. A caller may shorten them, never lengthen them. */
export const PROBE_DEADLINES = Object.freeze({
  /** TCP connect. */
  connectMs: 2000,
  /** Response headers, counted from the connection. */
  headersMs: 3000,
  /** Longest gap between response body chunks. */
  idleMs: 2000,
  /** The whole probe. */
  totalMs: 8000,
});
export type ProbeDeadlines = { [K in keyof typeof PROBE_DEADLINES]: number };

/** One request header, in the order it is sent. */
export type ProbeHeader = readonly [name: string, value: string];

export interface ProbeRequest {
  apiStyle: LocalApiStyle;
  method: "GET";
  /** The literal address connected to: never resolved, never a name. */
  host: "127.0.0.1" | "::1";
  family: 4 | 6;
  port: number;
  /** Validated base path plus the fixed suffix. */
  path: string;
  /** For display: the canonical endpoint plus the path. */
  url: string;
  /** Every header sent, in order. Nothing else is added. */
  headers: readonly ProbeHeader[];
  maxBodyBytes: number;
}

export type ProbeRequestResult = { ok: true; request: ProbeRequest } | { ok: false; error: "invalid-endpoint" | "invalid-api-style" };

/** An own data property, never a getter or anything inherited. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && "value" in d ? d.value : undefined;
}

/**
 * The exact request for a saved configuration's endpoint and API style.
 * The endpoint must already be in canonical form (as the settings schema
 * stores it): anything validateLocalEndpoint would change is refused, never
 * normalized here. Never throws.
 */
export function buildProbeRequest(config: unknown): ProbeRequestResult {
  try {
    const endpoint = own(config, "endpoint");
    const apiStyle = own(config, "apiStyle");
    if (!(LOCAL_API_STYLES as readonly unknown[]).includes(apiStyle)) return { ok: false, error: "invalid-api-style" };
    const checked = validateLocalEndpoint(endpoint);
    if (!checked.ok || checked.endpoint.url !== endpoint) return { ok: false, error: "invalid-endpoint" };
    const style = apiStyle as LocalApiStyle;
    const { host, port, basePath, url } = checked.endpoint;
    const path = basePath + PROBE_PATHS[style];
    const request: ProbeRequest = {
      apiStyle: style,
      method: "GET",
      host: host === "[::1]" ? "::1" : "127.0.0.1",
      family: host === "[::1]" ? 6 : 4,
      port,
      path,
      url: url + PROBE_PATHS[style],
      headers: Object.freeze([
        Object.freeze(["Host", `${host}:${port}`] as const),
        Object.freeze(["Accept", "application/json"] as const),
        Object.freeze(["Accept-Encoding", "identity"] as const),
        Object.freeze(["Connection", "close"] as const),
        Object.freeze(["User-Agent", PROBE_USER_AGENT] as const),
      ]),
      maxBodyBytes: PROBE_MAX_BODY_BYTES[style],
    };
    return { ok: true, request: Object.freeze(request) };
  } catch {
    return { ok: false, error: "invalid-endpoint" };
  }
}

export type ProbeStatusClass = "1xx" | "2xx" | "4xx" | "5xx" | "other";

/** What a probe found. Never contains anything the server sent beyond a status class or a count. */
export type ProbeResult =
  /** The expected answer arrived. modelCount: entries listed (openai-compatible), or null (ollama-native). */
  | { outcome: "compatible"; modelCount: number | null }
  /** An HTTP status the probe doesn't expect. */
  | { outcome: "http-error"; statusClass: ProbeStatusClass }
  | {
      outcome:
        | "incompatible-response"
        | "redirect-refused"
        | "auth-required"
        | "not-found-at-path"
        | "connection-refused"
        | "timeout"
        | "response-too-large"
        | "address-mismatch"
        /** The configuration isn't a valid saved local endpoint. Nothing was sent. */
        | "invalid-request"
        /** The caller's AbortSignal fired. */
        | "cancelled"
        /** Anything unexpected. */
        | "failed";
    };

export type ProbeOutcome = ProbeResult["outcome"];

const classOf = (status: number): ProbeStatusClass =>
  status >= 100 && status < 200 ? "1xx" : status >= 200 && status < 300 ? "2xx" : status >= 400 && status < 500 ? "4xx" : status >= 500 && status < 600 ? "5xx" : "other";

/**
 * What a final HTTP status means before any body is read: null for 200
 * (read and check the body), otherwise the result. Redirects are never
 * followed, and no credential is ever sent, so 401/403 only says one is wanted.
 */
export function resultForStatus(status: number): ProbeResult | null {
  if (status === 200) return null;
  if (status >= 300 && status < 400) return { outcome: "redirect-refused" };
  if (status === 401 || status === 403) return { outcome: "auth-required" };
  if (status === 404) return { outcome: "not-found-at-path" };
  // 101 (protocol switch) and every other 2xx (204, 206...): not the answer asked for.
  if ((status >= 100 && status < 200) || (status >= 200 && status < 300)) return { outcome: "incompatible-response" };
  return { outcome: "http-error", statusClass: classOf(status) };
}

/** application/json, optionally with charset=utf-8. Nothing else. */
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i;

/** Whether the response headers allow reading the body: JSON, uncompressed. */
export function acceptableHeaders(contentType: unknown, contentEncoding: unknown): boolean {
  if (typeof contentType !== "string" || !JSON_CONTENT_TYPE.test(contentType.trim())) return false;
  if (contentEncoding === undefined) return true;
  return typeof contentEncoding === "string" && contentEncoding.trim().toLowerCase() === "identity";
}

const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Checks a complete response body (at most the style's byte limit; the
 * transport enforces that while reading). Strict UTF-8, JSON, and only the
 * fields below, read as own data properties without walking the rest:
 *   ollama-native      { "version": "<bounded version>", ...ignored }
 *   openai-compatible  { "object": "list", "data": [ { "id": "<1-256 chars>", ...ignored }, ...at most 1000 ] }
 * Never throws; never returns any of the body.
 */
export function checkProbeBody(apiStyle: LocalApiStyle, body: Uint8Array): ProbeResult {
  try {
    if (body.byteLength > PROBE_MAX_BODY_BYTES[apiStyle]) return { outcome: "response-too-large" };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) return { outcome: "incompatible-response" };
    if (apiStyle === "ollama-native") {
      const version = own(value, "version");
      const ok = typeof version === "string" && version.length <= PROBE_MAX_VERSION_LENGTH && PROBE_VERSION_PATTERN.test(version);
      return ok ? { outcome: "compatible", modelCount: null } : { outcome: "incompatible-response" };
    }
    if (own(value, "object") !== "list") return { outcome: "incompatible-response" };
    const data = own(value, "data");
    if (!Array.isArray(data) || data.length > PROBE_MAX_MODELS) return { outcome: "incompatible-response" };
    for (let i = 0; i < data.length; i++) {
      const entry: unknown = data[i];
      if (!isPlainObject(entry)) return { outcome: "incompatible-response" };
      const id = own(entry, "id");
      if (typeof id !== "string" || id.length === 0 || id.length > PROBE_MAX_MODEL_ID_LENGTH) return { outcome: "incompatible-response" };
    }
    return { outcome: "compatible", modelCount: data.length };
  } catch {
    // Invalid UTF-8, invalid JSON, or anything else: the same fixed result.
    return { outcome: "incompatible-response" };
  }
}
