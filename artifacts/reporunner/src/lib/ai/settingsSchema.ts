// Stage 4E: the strict schema for a future non-secret AI settings document.
// Pure: it parses and serializes text and plain objects only. No file,
// environment, credential store or network access, and nothing in the app
// uses it yet. The document would live in its own file, separate from
// reporunner-project.json and reporunner-credentials.json.
//
// - It holds no secrets: no keys, headers, tokens or credential slots.
// - Version 1 has one configuration kind: a local endpoint. Remote providers
//   are added in a later version, once the providers are chosen.
// - Anything unexpected is refused, never repaired, coerced or dropped.
//   A newer version is reported separately from damage, so a future store
//   can leave such a file alone instead of treating it as broken.
import { validateLocalEndpoint } from "./localEndpoint";

export const AI_SETTINGS_FORMAT = "reporunner-ai-settings";
export const AI_SETTINGS_VERSION = 1;
/** Far more than three configurations need; larger text is refused unparsed. */
export const AI_SETTINGS_MAX_BYTES = 16 * 1024;
export const AI_SETTINGS_MAX_CONFIGS = 3;
export const AI_MODEL_LABEL_MAX_LENGTH = 128;

/**
 * Local API styles a configuration may name. A label only: naming a style
 * says nothing about whether this version can talk to it. Whether a style
 * is usable is decided by the adapter registry (providerReadiness.ts), which
 * is empty in this version.
 */
export const LOCAL_API_STYLES = Object.freeze(["openai-compatible", "ollama-native"] as const);
export type LocalApiStyle = (typeof LOCAL_API_STYLES)[number];

/** Configuration kinds in this version. Remote providers are not defined yet. */
export const AI_CONFIG_KINDS = Object.freeze(["local-endpoint"] as const);
export type AiConfigKind = (typeof AI_CONFIG_KINDS)[number];

/** "cfg-" and 1–24 lowercase letters or digits. Never a path, URL or object key like "__proto__". */
export const AI_CONFIG_ID_PATTERN = /^cfg-[a-z0-9]{1,24}$/;
/** A model name as the user wrote it. A label, never proof the model exists or can do a task. */
export const AI_MODEL_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

export interface LocalEndpointConfig {
  id: string;
  kind: "local-endpoint";
  /** Canonical form from validateLocalEndpoint. */
  endpoint: string;
  apiStyle: LocalApiStyle;
  model: string | null;
}

export type AiConfig = LocalEndpointConfig;

export interface AiSettings {
  format: typeof AI_SETTINGS_FORMAT;
  version: typeof AI_SETTINGS_VERSION;
  /** The selected configuration's id, or null. */
  active: string | null;
  configs: AiConfig[];
}

export type AiSettingsError =
  | "too-large"
  | "invalid-json"
  | "invalid-shape"
  | "invalid-format"
  | "invalid-version"
  | "unsupported-version"
  | "unknown-field"
  | "invalid-config"
  | "unsupported-kind"
  | "invalid-config-id"
  | "duplicate-config-id"
  | "too-many-configs"
  | "invalid-endpoint"
  | "invalid-api-style"
  | "invalid-model"
  | "invalid-active";

export type AiSettingsResult = { ok: true; settings: AiSettings } | { ok: false; error: AiSettingsError };

/** Everything except a newer version is damage. */
export function isDamagedSettingsError(error: AiSettingsError): boolean {
  return error !== "unsupported-version";
}

/** No configurations, nothing selected. */
export function emptyAiSettings(): AiSettings {
  return { format: AI_SETTINGS_FORMAT, version: AI_SETTINGS_VERSION, active: null, configs: [] };
}

const TOP_KEYS = ["format", "version", "active", "configs"] as const;
const CONFIG_KEYS = ["id", "kind", "endpoint", "apiStyle", "model"] as const;

class Refusal {
  constructor(readonly error: AiSettingsError) {}
}
const refuse = (error: AiSettingsError): never => {
  throw new Refusal(error);
};

/**
 * The own data properties of a plain object, or null. Refuses arrays, class
 * instances, symbol keys and getters, so reading a value never runs code.
 */
function plainRecord(value: unknown): Map<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    fields.set(key, descriptor.value);
  }
  return fields;
}

/** The elements of a genuine, dense array whose elements are data properties, or null. */
function plainArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return null; // indexes plus "length", nothing else
  const items: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) return null;
    items.push(descriptor.value);
  }
  return items;
}

function onlyKeys(fields: Map<string, unknown>, allowed: readonly string[]) {
  for (const key of fields.keys()) if (!allowed.includes(key)) refuse("unknown-field");
  for (const key of allowed) if (!fields.has(key)) refuse("invalid-shape");
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && values.includes(value as T);

function readModel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > AI_MODEL_LABEL_MAX_LENGTH || !AI_MODEL_LABEL_PATTERN.test(value)) refuse("invalid-model");
  return value as string;
}

function readConfig(value: unknown): AiConfig {
  const fields = plainRecord(value);
  if (!fields) return refuse("invalid-config");
  // The kind first: a configuration of another kind has other fields.
  const kind = fields.get("kind");
  if (typeof kind !== "string") refuse("invalid-config");
  if (!oneOf(AI_CONFIG_KINDS, kind)) refuse("unsupported-kind");
  onlyKeys(fields, CONFIG_KEYS);
  const id = fields.get("id");
  if (typeof id !== "string" || !AI_CONFIG_ID_PATTERN.test(id)) refuse("invalid-config-id");
  const endpoint = fields.get("endpoint");
  const checked = validateLocalEndpoint(endpoint);
  // Stored endpoints must already be canonical: nothing is normalized on read.
  if (!checked.ok || checked.endpoint.url !== endpoint) refuse("invalid-endpoint");
  const apiStyle = fields.get("apiStyle");
  if (!oneOf(LOCAL_API_STYLES, apiStyle)) refuse("invalid-api-style");
  const model = readModel(fields.get("model"));
  return { id: id as string, kind: "local-endpoint", endpoint: endpoint as string, apiStyle: apiStyle as LocalApiStyle, model };
}

function readSettings(value: unknown): AiSettings {
  const fields = plainRecord(value);
  if (!fields) return refuse("invalid-shape");
  if (fields.get("format") !== AI_SETTINGS_FORMAT) refuse("invalid-format");
  const version = fields.get("version");
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) refuse("invalid-version");
  // Checked before the fields: a newer version may have fields this one doesn't know.
  if ((version as number) > AI_SETTINGS_VERSION) refuse("unsupported-version");
  onlyKeys(fields, TOP_KEYS);
  const list = plainArray(fields.get("configs"));
  if (!list) return refuse("invalid-shape");
  if (list.length > AI_SETTINGS_MAX_CONFIGS) refuse("too-many-configs");
  const configs = list.map(readConfig);
  const ids = new Set<string>();
  for (const config of configs) {
    if (ids.has(config.id)) refuse("duplicate-config-id");
    ids.add(config.id);
  }
  const active = fields.get("active");
  if (active !== null && (typeof active !== "string" || !ids.has(active))) refuse("invalid-active");
  return { format: AI_SETTINGS_FORMAT, version: AI_SETTINGS_VERSION, active: active as string | null, configs };
}

function attempt(read: () => AiSettings): AiSettingsResult {
  try {
    return { ok: true, settings: read() };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.error };
    // Anything else (e.g. a hostile proxy throwing) is damage, never a crash.
    return { ok: false, error: "invalid-shape" };
  }
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** Validates an in-memory value. Returns a fresh copy; the input is never kept or changed. */
export function validateAiSettings(value: unknown): AiSettingsResult {
  return attempt(() => readSettings(value));
}

/** Parses the document's text. Never throws. */
export function parseAiSettings(text: unknown): AiSettingsResult {
  if (typeof text !== "string") return { ok: false, error: "invalid-shape" };
  // Each UTF-16 unit is at least one UTF-8 byte, so this avoids encoding a huge string.
  if (text.length > AI_SETTINGS_MAX_BYTES || utf8Length(text) > AI_SETTINGS_MAX_BYTES) return { ok: false, error: "too-large" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  return validateAiSettings(value);
}

export type AiSettingsSerializeResult = { ok: true; text: string } | { ok: false; error: AiSettingsError };

/** Serializes valid settings, in a fixed field order. Never produces text that parseAiSettings would refuse. */
export function serializeAiSettings(settings: unknown): AiSettingsSerializeResult {
  const checked = validateAiSettings(settings);
  if (!checked.ok) return checked;
  const s = checked.settings;
  const text = JSON.stringify(
    {
      format: s.format,
      version: s.version,
      active: s.active,
      configs: s.configs.map((c) => ({ id: c.id, kind: c.kind, endpoint: c.endpoint, apiStyle: c.apiStyle, model: c.model })),
    },
    null,
    2,
  );
  if (utf8Length(text) > AI_SETTINGS_MAX_BYTES) return { ok: false, error: "too-large" };
  return { ok: true, text };
}
