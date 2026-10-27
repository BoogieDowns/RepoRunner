// Stage 4E: the strict, non-secret AI settings schema (pure; no files).
import { describe, expect, it } from "vitest";
import {
  AI_MODEL_LABEL_MAX_LENGTH,
  AI_SETTINGS_FORMAT,
  AI_SETTINGS_MAX_BYTES,
  AI_SETTINGS_MAX_CONFIGS,
  AI_SETTINGS_VERSION,
  emptyAiSettings,
  isDamagedSettingsError,
  parseAiSettings,
  serializeAiSettings,
  validateAiSettings,
  type AiSettings,
  type AiSettingsError,
  type LocalEndpointConfig,
} from "../../../src/lib/ai/settingsSchema";

const config = (over: Partial<Record<keyof LocalEndpointConfig, unknown>> = {}) =>
  ({ id: "cfg-a1", kind: "local-endpoint", endpoint: "http://127.0.0.1:11434", apiStyle: "ollama-native", model: "llama3.1:8b", ...over }) as LocalEndpointConfig;
const doc = (over: Record<string, unknown> = {}) => ({ format: AI_SETTINGS_FORMAT, version: AI_SETTINGS_VERSION, active: null, configs: [] as unknown[], ...over });
const three = () => [
  config({ id: "cfg-a1" }),
  config({ id: "cfg-b2", endpoint: "http://[::1]:8080/v1", apiStyle: "openai-compatible", model: null }),
  config({ id: "cfg-c3", endpoint: "http://127.0.0.1:80", model: "hf.co/org/model-GGUF:Q4_K_M" }),
];
const parse = (value: unknown) => parseAiSettings(JSON.stringify(value));
const errorOf = (value: unknown): AiSettingsError | "ok" => {
  const result = parse(value);
  return result.ok ? "ok" : result.error;
};

describe("valid documents", () => {
  it("the empty document", () => {
    expect(parseAiSettings(JSON.stringify(emptyAiSettings()))).toEqual({ ok: true, settings: emptyAiSettings() });
  });

  it.each([1, 2, 3])("%i configuration(s), each selectable", (count) => {
    const configs = three().slice(0, count);
    for (const active of [null, ...configs.map((c) => c.id)]) {
      const result = parse(doc({ configs, active }));
      expect(result).toEqual({ ok: true, settings: doc({ configs, active }) });
    }
  });

  it("returns a fresh copy, sharing nothing with the input", () => {
    const input = doc({ configs: three(), active: "cfg-b2" });
    const result = validateAiSettings(input);
    expect(result.ok && result.settings).toEqual(input);
    expect(result.ok && result.settings).not.toBe(input);
    expect(result.ok && result.settings.configs).not.toBe(input.configs);
    expect(result.ok && result.settings.configs[0]).not.toBe(input.configs[0]);
  });

  it("accepts a null-prototype object (as some callers build them)", () => {
    const record = Object.assign(Object.create(null), doc());
    expect(validateAiSettings(record).ok).toBe(true);
  });

  it("the model label limit is inclusive", () => {
    expect(errorOf(doc({ configs: [config({ model: "m".repeat(AI_MODEL_LABEL_MAX_LENGTH) })] }))).toBe("ok");
  });
});

describe("refused documents", () => {
  const cases: Array<[string, unknown, AiSettingsError]> = [
    // Shape and identity
    ["an array", [], "invalid-shape"],
    ["null", null, "invalid-shape"],
    ["a string", "settings", "invalid-shape"],
    ["missing format", { version: 1, active: null, configs: [] }, "invalid-format"],
    ["wrong format", doc({ format: "reporunner-credentials" }), "invalid-format"],
    ["format with different case", doc({ format: "RepoRunner-AI-Settings" }), "invalid-format"],
    ["missing version", { format: AI_SETTINGS_FORMAT, active: null, configs: [] }, "invalid-version"],
    ["version 0", doc({ version: 0 }), "invalid-version"],
    ["negative version", doc({ version: -1 }), "invalid-version"],
    ["fractional version", doc({ version: 1.5 }), "invalid-version"],
    ["version as a string", doc({ version: "1" }), "invalid-version"],
    ["version null", doc({ version: null }), "invalid-version"],
    ["huge version", doc({ version: 1e300 }), "invalid-version"],
    ["newer version", doc({ version: 2 }), "unsupported-version"],
    ["newer version with fields this version doesn't know", doc({ version: 7, providers: [], configs: "changed" }), "unsupported-version"],
    ["unknown top-level field", doc({ extra: true }), "unknown-field"],
    ["a secret field", doc({ apiKey: "sk-SYNTHETIC" }), "unknown-field"],
    ["missing active", { format: AI_SETTINGS_FORMAT, version: 1, configs: [] }, "invalid-shape"],
    ["missing configs", { format: AI_SETTINGS_FORMAT, version: 1, active: null }, "invalid-shape"],
    ["configs not an array", doc({ configs: {} }), "invalid-shape"],
    ["configs null", doc({ configs: null }), "invalid-shape"],
    // Collection
    ["too many configurations", doc({ configs: [...three(), config({ id: "cfg-d4" })] }), "too-many-configs"],
    ["duplicate id", doc({ configs: [config({ id: "cfg-a1" }), config({ id: "cfg-a1", endpoint: "http://[::1]:1" })] }), "duplicate-config-id"],
    ["a configuration that isn't an object", doc({ configs: ["cfg-a1"] }), "invalid-config"],
    ["a null configuration", doc({ configs: [null] }), "invalid-config"],
    ["a configuration that's an array", doc({ configs: [[]] }), "invalid-config"],
    // Active selection
    ["active pointing at nothing", doc({ configs: three(), active: "cfg-zz" }), "invalid-active"],
    ["active with no configurations", doc({ active: "cfg-a1" }), "invalid-active"],
    ["active as an index", doc({ configs: three(), active: 0 }), "invalid-active"],
    ["active as an empty string", doc({ configs: three(), active: "" }), "invalid-active"],
    ["active as an object", doc({ configs: three(), active: { id: "cfg-a1" } }), "invalid-active"],
    // Configuration kind and fields
    ["missing kind", doc({ configs: [{ id: "cfg-a1", endpoint: "http://127.0.0.1:1", apiStyle: "ollama-native", model: null }] }), "invalid-config"],
    ["kind not a string", doc({ configs: [config({ kind: 1 })] }), "invalid-config"],
    ["remote provider (not defined yet)", doc({ configs: [{ id: "cfg-a1", kind: "remote-provider", provider: "x", credentialSlot: "byok-slot-1", model: null }] }), "unsupported-kind"],
    ["unknown kind", doc({ configs: [config({ kind: "plugin" })] }), "unsupported-kind"],
    ["unknown configuration field", doc({ configs: [{ ...config(), note: "x" }] }), "unknown-field"],
    ["a credential slot field", doc({ configs: [{ ...config(), authSlot: "byok-slot-1" }] }), "unknown-field"],
    ["a header field", doc({ configs: [{ ...config(), headers: { Authorization: "Bearer SYNTHETIC" } }] }), "unknown-field"],
    ["missing model", doc({ configs: [{ id: "cfg-a1", kind: "local-endpoint", endpoint: "http://127.0.0.1:1", apiStyle: "ollama-native" }] }), "invalid-shape"],
    ["missing endpoint", doc({ configs: [{ id: "cfg-a1", kind: "local-endpoint", apiStyle: "ollama-native", model: null }] }), "invalid-shape"],
    // IDs
    ["id without prefix", doc({ configs: [config({ id: "a1" })] }), "invalid-config-id"],
    ["id with upper case", doc({ configs: [config({ id: "cfg-A1" })] }), "invalid-config-id"],
    ["id __proto__", doc({ configs: [config({ id: "__proto__" })] }), "invalid-config-id"],
    ["id constructor", doc({ configs: [config({ id: "constructor" })] }), "invalid-config-id"],
    ["id with a path", doc({ configs: [config({ id: "cfg-../x" })] }), "invalid-config-id"],
    ["id too long", doc({ configs: [config({ id: "cfg-" + "a".repeat(25) })] }), "invalid-config-id"],
    ["empty id suffix", doc({ configs: [config({ id: "cfg-" })] }), "invalid-config-id"],
    ["id as a number", doc({ configs: [config({ id: 1 })] }), "invalid-config-id"],
    // Endpoints
    ["endpoint localhost", doc({ configs: [config({ endpoint: "http://localhost:11434" })] }), "invalid-endpoint"],
    ["endpoint LAN", doc({ configs: [config({ endpoint: "http://192.168.1.2:11434" })] }), "invalid-endpoint"],
    ["endpoint https", doc({ configs: [config({ endpoint: "https://127.0.0.1:11434" })] }), "invalid-endpoint"],
    ["endpoint with userinfo", doc({ configs: [config({ endpoint: "http://u:p@127.0.0.1:11434" })] }), "invalid-endpoint"],
    ["endpoint not canonical (trailing slash)", doc({ configs: [config({ endpoint: "http://127.0.0.1:11434/" })] }), "invalid-endpoint"],
    ["endpoint not canonical (scheme case)", doc({ configs: [config({ endpoint: "HTTP://127.0.0.1:11434" })] }), "invalid-endpoint"],
    ["endpoint not a string", doc({ configs: [config({ endpoint: { host: "127.0.0.1" } })] }), "invalid-endpoint"],
    ["endpoint null", doc({ configs: [config({ endpoint: null })] }), "invalid-endpoint"],
    // API style
    ["unknown API style", doc({ configs: [config({ apiStyle: "grpc" })] }), "invalid-api-style"],
    ["API style case", doc({ configs: [config({ apiStyle: "OpenAI-Compatible" })] }), "invalid-api-style"],
    ["API style null", doc({ configs: [config({ apiStyle: null })] }), "invalid-api-style"],
    // Model labels
    ["empty model", doc({ configs: [config({ model: "" })] }), "invalid-model"],
    ["model with a space", doc({ configs: [config({ model: "llama 3" })] }), "invalid-model"],
    ["model with a newline", doc({ configs: [config({ model: "llama3\n" })] }), "invalid-model"],
    ["model starting with a dash", doc({ configs: [config({ model: "-rf" })] }), "invalid-model"],
    ["model with a backslash", doc({ configs: [config({ model: "a\\b" })] }), "invalid-model"],
    ["model with a quote", doc({ configs: [config({ model: 'a"b' })] }), "invalid-model"],
    ["model non-ASCII", doc({ configs: [config({ model: "modèle" })] }), "invalid-model"],
    ["model too long", doc({ configs: [config({ model: "m".repeat(AI_MODEL_LABEL_MAX_LENGTH + 1) })] }), "invalid-model"],
    ["model as a number", doc({ configs: [config({ model: 3 })] }), "invalid-model"],
  ];

  it.each(cases)("%s", (_name, value, error) => {
    expect(errorOf(value)).toBe(error);
  });

  it("refuses invalid JSON and non-text input", () => {
    expect(parseAiSettings("{")).toEqual({ ok: false, error: "invalid-json" });
    expect(parseAiSettings("")).toEqual({ ok: false, error: "invalid-json" });
    expect(parseAiSettings("﻿" + JSON.stringify(doc()))).toEqual({ ok: false, error: "invalid-json" });
    expect(parseAiSettings(Buffer.from(JSON.stringify(doc())) as unknown)).toEqual({ ok: false, error: "invalid-shape" });
    expect(parseAiSettings(null)).toEqual({ ok: false, error: "invalid-shape" });
  });

  it("refuses oversized text before parsing it, counting UTF-8 bytes", () => {
    const padded = (n: number) => JSON.stringify(doc()).replace("{", "{" + " ".repeat(n));
    const base = JSON.stringify(doc()).length;
    expect(parseAiSettings(padded(AI_SETTINGS_MAX_BYTES - base)).ok).toBe(true);
    expect(parseAiSettings(padded(AI_SETTINGS_MAX_BYTES - base + 1))).toEqual({ ok: false, error: "too-large" });
    // Within the character limit but over the byte limit.
    const multibyte = JSON.stringify(doc({ note: "é".repeat(AI_SETTINGS_MAX_BYTES / 2 + 1) }));
    expect(multibyte.length).toBeLessThan(AI_SETTINGS_MAX_BYTES);
    expect(parseAiSettings(multibyte)).toEqual({ ok: false, error: "too-large" });
    expect(parseAiSettings("[" + "1,".repeat(AI_SETTINGS_MAX_BYTES) + "1]")).toEqual({ ok: false, error: "too-large" });
  });

  it("only a newer version counts as anything other than damage", () => {
    expect(isDamagedSettingsError("unsupported-version")).toBe(false);
    for (const [, , error] of cases) if (error !== "unsupported-version") expect(isDamagedSettingsError(error)).toBe(true);
    expect(isDamagedSettingsError("too-large")).toBe(true);
    expect(isDamagedSettingsError("invalid-json")).toBe(true);
  });

  it("refuses rather than repairs: nothing is dropped, trimmed or coerced", () => {
    // A valid document with one bad configuration is refused as a whole, not returned without it.
    expect(errorOf(doc({ configs: [config(), config({ id: "cfg-b2", endpoint: "http://localhost:1" })] }))).toBe("invalid-endpoint");
    expect(errorOf(doc({ configs: [config({ id: " cfg-a1" })] }))).toBe("invalid-config-id");
    expect(errorOf(doc({ configs: [config({ model: " llama3" })] }))).toBe("invalid-model");
  });
});

describe("hostile shapes", () => {
  it("a JSON __proto__ key is an unknown field and pollutes nothing", () => {
    const text = `{"format":"${AI_SETTINGS_FORMAT}","version":1,"active":null,"configs":[],"__proto__":{"polluted":true}}`;
    expect(parseAiSettings(text)).toEqual({ ok: false, error: "unknown-field" });
    const inConfig = `{"format":"${AI_SETTINGS_FORMAT}","version":1,"active":null,"configs":[{"id":"cfg-a1","kind":"local-endpoint","endpoint":"http://127.0.0.1:1","apiStyle":"ollama-native","model":null,"__proto__":{"x":1}}]}`;
    expect(parseAiSettings(inConfig)).toEqual({ ok: false, error: "unknown-field" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses constructor and prototype keys", () => {
    expect(errorOf(doc({ constructor: {} }))).toBe("unknown-field");
    expect(errorOf(doc({ prototype: {} }))).toBe("unknown-field");
  });

  it("inherited fields don't count", () => {
    const inherited = Object.create(doc());
    expect(validateAiSettings(inherited)).toEqual({ ok: false, error: "invalid-shape" });
  });

  it("never runs getters or proxy traps as data", () => {
    let ran = false;
    const getter = doc();
    Object.defineProperty(getter, "active", { enumerable: true, get: () => ((ran = true), null) });
    expect(validateAiSettings(getter)).toEqual({ ok: false, error: "invalid-shape" });
    const configGetter = config();
    Object.defineProperty(configGetter, "endpoint", { enumerable: true, get: () => ((ran = true), "http://127.0.0.1:1") });
    expect(validateAiSettings(doc({ configs: [configGetter] }))).toEqual({ ok: false, error: "invalid-config" });
    expect(ran).toBe(false);
    const proxy = new Proxy(doc(), { ownKeys: () => { throw new Error("trap"); } });
    expect(validateAiSettings(proxy)).toEqual({ ok: false, error: "invalid-shape" });
  });

  it("refuses symbol keys, class instances, sparse arrays and array subclasses", () => {
    expect(validateAiSettings({ ...doc(), [Symbol("x")]: 1 })).toEqual({ ok: false, error: "invalid-shape" });
    expect(validateAiSettings(new (class { format = AI_SETTINGS_FORMAT; version = 1; active = null; configs = []; })())).toEqual({ ok: false, error: "invalid-shape" });
    // eslint-disable-next-line no-sparse-arrays
    expect(validateAiSettings(doc({ configs: [, config()] }))).toEqual({ ok: false, error: "invalid-shape" });
    const withExtra = [config()] as unknown[] & { extra?: number };
    withExtra.extra = 1;
    expect(validateAiSettings(doc({ configs: withExtra }))).toEqual({ ok: false, error: "invalid-shape" });
    class MyArray extends Array {}
    expect(validateAiSettings(doc({ configs: MyArray.from([config()]) }))).toEqual({ ok: false, error: "invalid-shape" });
  });

  it("never throws", () => {
    for (const value of [undefined, 0, Symbol("s"), () => 1, new Map(), new Date(0), Object.freeze(doc())]) {
      expect(() => validateAiSettings(value)).not.toThrow();
      expect(() => serializeAiSettings(value)).not.toThrow();
    }
  });
});

describe("serialization", () => {
  it("round-trips every valid document exactly", () => {
    const docs: AiSettings[] = [emptyAiSettings(), doc({ configs: three(), active: "cfg-c3" }) as AiSettings, doc({ configs: three().slice(0, 1), active: null }) as AiSettings];
    for (const settings of docs) {
      const serialized = serializeAiSettings(settings);
      expect(serialized.ok).toBe(true);
      if (!serialized.ok) continue;
      const parsed = parseAiSettings(serialized.text);
      expect(parsed).toEqual({ ok: true, settings });
      // Repeating it changes nothing.
      const again = parsed.ok ? serializeAiSettings(parsed.settings) : null;
      expect(again).toEqual(serialized);
    }
  });

  it("writes fields in a fixed order", () => {
    const shuffled = { configs: [{ model: null, apiStyle: "openai-compatible", endpoint: "http://[::1]:1", kind: "local-endpoint", id: "cfg-x" }], active: "cfg-x", version: 1, format: AI_SETTINGS_FORMAT };
    const serialized = serializeAiSettings(shuffled);
    expect(serialized.ok && JSON.parse(serialized.text)).toEqual(shuffled);
    expect(serialized.ok && Object.keys(JSON.parse(serialized.text))).toEqual(["format", "version", "active", "configs"]);
    expect(serialized.ok && Object.keys(JSON.parse(serialized.text).configs[0])).toEqual(["id", "kind", "endpoint", "apiStyle", "model"]);
  });

  it("refuses to serialize anything the parser would refuse", () => {
    expect(serializeAiSettings(doc({ active: "cfg-missing" }))).toEqual({ ok: false, error: "invalid-active" });
    expect(serializeAiSettings(doc({ version: 2 }))).toEqual({ ok: false, error: "unsupported-version" });
    expect(serializeAiSettings(doc({ configs: [config({ endpoint: "http://localhost:1" })] }))).toEqual({ ok: false, error: "invalid-endpoint" });
    expect(serializeAiSettings(doc({ apiKey: "sk-SYNTHETIC" }))).toEqual({ ok: false, error: "unknown-field" });
  });

  it("the largest valid document is far below the size limit", () => {
    const big = doc({
      active: "cfg-" + "a".repeat(24),
      configs: ["a", "b", "c"].map((c) =>
        config({ id: "cfg-" + c.repeat(24), endpoint: "http://127.0.0.1:65535/" + "p".repeat(127), model: "m".repeat(AI_MODEL_LABEL_MAX_LENGTH) }),
      ),
    });
    const serialized = serializeAiSettings(big);
    expect(serialized.ok).toBe(true);
    expect(serialized.ok && serialized.text.length).toBeLessThan(AI_SETTINGS_MAX_BYTES / 4);
    expect(AI_SETTINGS_MAX_CONFIGS).toBe(3);
  });
});
