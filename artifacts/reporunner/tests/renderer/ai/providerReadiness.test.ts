// Stage 4E: AI configuration → the Stage 1 ProviderReadiness input, and what
// the capability model makes of it. Pure; no files, credentials or network.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_AI_ADAPTERS, deriveProviderReadiness, type AiAdapterDescriptor } from "../../../src/lib/ai/providerReadiness";
import { AI_SETTINGS_FORMAT, LOCAL_API_STYLES, emptyAiSettings, type AiSettings, type LocalApiStyle } from "../../../src/lib/ai/settingsSchema";
import { AI_CAPABILITIES, AI_IMPLEMENTED, evaluateCapabilities } from "../../../src/lib/editions/capabilities";
import type { CloudEntitlement, CloudState, Edition, EditionState, LicenseState } from "../../../src/lib/editions/types";
import type { CredentialIpcResult } from "../../../src/types";

const settings = (apiStyle: LocalApiStyle = "ollama-native", active: string | null = "cfg-a1"): AiSettings => ({
  format: AI_SETTINGS_FORMAT,
  version: 1,
  active,
  configs: [
    { id: "cfg-a1", kind: "local-endpoint", endpoint: "http://127.0.0.1:11434", apiStyle, model: "llama3.1:8b" },
    { id: "cfg-b2", kind: "local-endpoint", endpoint: "http://[::1]:8080/v1", apiStyle: apiStyle === "ollama-native" ? "openai-compatible" : "ollama-native", model: null },
  ],
});
const adapter = (apiStyle: LocalApiStyle, requiresCredential = false): AiAdapterDescriptor => ({ kind: "local-endpoint", apiStyle, requiresCredential });

const KEY_SESSION: CredentialIpcResult = { ok: true, status: { configured: true, mode: "session", persistence: "available" } };
const KEY_REMEMBERED: CredentialIpcResult = { ok: true, status: { configured: true, mode: "remembered", persistence: "available" } };
const NO_KEY: CredentialIpcResult = { ok: true, status: { configured: false, mode: null, persistence: "available" } };
const STATUS_FAILED: CredentialIpcResult = { ok: false, error: "store-corrupt" };
const CREDENTIALS: Array<CredentialIpcResult | null | undefined> = [KEY_SESSION, KEY_REMEMBERED, NO_KEY, STATUS_FAILED, null, undefined];

describe("the production registry", () => {
  it("is empty and frozen", () => {
    expect(PRODUCTION_AI_ADAPTERS).toEqual([]);
    expect(Object.isFrozen(PRODUCTION_AI_ADAPTERS)).toBe(true);
  });

  it("gives none for every configuration, selection and credential state", () => {
    const docs: unknown[] = [emptyAiSettings(), ...LOCAL_API_STYLES.flatMap((s) => [settings(s), settings(s, "cfg-b2"), settings(s, null)])];
    for (const doc of docs) for (const credential of CREDENTIALS) expect(deriveProviderReadiness(doc, credential, PRODUCTION_AI_ADAPTERS)).toBe("none");
  });
});

describe("fails closed", () => {
  const every = LOCAL_API_STYLES.map((s) => adapter(s));

  it("no settings or no active configuration", () => {
    expect(deriveProviderReadiness(emptyAiSettings(), null, every)).toBe("none");
    expect(deriveProviderReadiness(settings("ollama-native", null), null, every)).toBe("none");
    expect(deriveProviderReadiness(null, KEY_REMEMBERED, every)).toBe("none");
    expect(deriveProviderReadiness(undefined, KEY_REMEMBERED, every)).toBe("none");
  });

  it("damaged settings, however they're damaged", () => {
    const good = settings();
    const damaged: unknown[] = [
      { ...good, active: "cfg-missing" },
      { ...good, version: 2 },
      { ...good, format: "other" },
      { ...good, extra: 1 },
      { ...good, configs: [{ ...good.configs[0], endpoint: "http://localhost:11434" }] },
      { ...good, configs: [{ ...good.configs[0], endpoint: "http://192.168.0.2:11434" }] },
      { ...good, configs: [{ ...good.configs[0], apiStyle: "grpc" }] },
      { ...good, configs: [good.configs[0], good.configs[0]] },
      JSON.stringify(good),
      "{}",
      [],
      42,
    ];
    for (const doc of damaged) expect(deriveProviderReadiness(doc, KEY_REMEMBERED, every), JSON.stringify(doc)).toBe("none");
  });

  it("a stored credential with no provider configuration", () => {
    for (const credential of [KEY_SESSION, KEY_REMEMBERED]) {
      expect(deriveProviderReadiness(emptyAiSettings(), credential, every)).toBe("none");
      expect(deriveProviderReadiness(settings("ollama-native", null), credential, every)).toBe("none");
    }
  });

  it("a configured endpoint with no adapter for its API style", () => {
    expect(deriveProviderReadiness(settings("ollama-native"), KEY_REMEMBERED, [adapter("openai-compatible")])).toBe("none");
    expect(deriveProviderReadiness(settings("openai-compatible"), KEY_REMEMBERED, [adapter("ollama-native")])).toBe("none");
    expect(deriveProviderReadiness(settings("ollama-native"), KEY_REMEMBERED, [])).toBe("none");
  });

  it("malformed or unrecognized adapter descriptors are ignored", () => {
    const style = "ollama-native";
    const bad: unknown[] = [
      null,
      "ollama-native",
      { kind: "local-endpoint", apiStyle: style },
      { kind: "local-endpoint", apiStyle: style, requiresCredential: "no" },
      { kind: "remote-provider", apiStyle: style, requiresCredential: false },
      { kind: "local-endpoint", apiStyle: "OLLAMA-NATIVE", requiresCredential: false },
      { kind: "local-endpoint", apiStyle: style, requiresCredential: false, extra: true },
      Object.create({ kind: "local-endpoint", apiStyle: style, requiresCredential: false }),
    ];
    for (const descriptor of bad) expect(deriveProviderReadiness(settings(style), null, [descriptor as AiAdapterDescriptor])).toBe("none");
    expect(deriveProviderReadiness(settings(style), null, "ollama-native" as never)).toBe("none");
    expect(deriveProviderReadiness(settings(style), null, null as never)).toBe("none");
  });

  it("an adapter that needs a credential, without metadata saying one is configured", () => {
    const needsKey = [adapter("ollama-native", true)];
    for (const credential of [NO_KEY, STATUS_FAILED, null, undefined, {} as CredentialIpcResult, { ok: true } as CredentialIpcResult, { ok: true, status: { configured: "yes" } } as never]) {
      expect(deriveProviderReadiness(settings(), credential, needsKey)).toBe("none");
    }
  });
});

describe("with synthetic adapters (tests only: no production adapter exists)", () => {
  it("a supported, active local endpoint maps to local-endpoint", () => {
    for (const style of LOCAL_API_STYLES) {
      expect(deriveProviderReadiness(settings(style), null, [adapter(style)])).toBe("local-endpoint");
      // The selection decides, not the first configuration.
      expect(deriveProviderReadiness(settings(style, "cfg-b2"), null, [adapter(style)])).toBe("none");
    }
  });

  it("a credential is used only when the adapter needs one", () => {
    expect(deriveProviderReadiness(settings(), KEY_SESSION, [adapter("ollama-native", true)])).toBe("local-endpoint");
    expect(deriveProviderReadiness(settings(), KEY_REMEMBERED, [adapter("ollama-native", true)])).toBe("local-endpoint");
    // No credential needed: its state doesn't matter.
    for (const credential of CREDENTIALS) expect(deriveProviderReadiness(settings(), credential, [adapter("ollama-native")])).toBe("local-endpoint");
  });

  it("never reports api-key: version 1 has no remote-provider configurations", () => {
    for (const style of LOCAL_API_STYLES) for (const credential of CREDENTIALS) {
      expect(deriveProviderReadiness(settings(style), credential, LOCAL_API_STYLES.map((s) => adapter(s, true)))).not.toBe("api-key");
    }
  });
});

describe("credential isolation", () => {
  it("reads only the metadata fields ok, status and configured, never a value", () => {
    const touched: string[] = [];
    const trap = <T extends object>(target: T, name: string): T =>
      new Proxy(target, {
        get(t, key, receiver) {
          touched.push(`${name}.get.${String(key)}`);
          return Reflect.get(t, key, receiver);
        },
        getOwnPropertyDescriptor(t, key) {
          touched.push(`${name}.${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(t, key);
        },
      });
    const status = trap({ configured: true, mode: "remembered", persistence: "available", secret: "sk-SYNTHETIC-NEVER-READ" }, "status");
    const metadata = trap({ ok: true, status, getCredential: () => { throw new Error("must not be called"); } }, "result");
    expect(deriveProviderReadiness(settings(), metadata as never, [adapter("ollama-native", true)])).toBe("local-endpoint");
    expect(touched.sort()).toEqual(["result.ok", "result.status", "status.configured"]);
  });

  it("doesn't look at credentials at all when no adapter needs one", () => {
    let touched = false;
    const metadata = new Proxy({}, { get: () => ((touched = true), undefined), getOwnPropertyDescriptor: () => ((touched = true), undefined) });
    deriveProviderReadiness(settings(), metadata as never, [adapter("ollama-native")]);
    deriveProviderReadiness(settings(), metadata as never, PRODUCTION_AI_ADAPTERS);
    expect(touched).toBe(false);
  });

  it("a getter on the metadata is never run", () => {
    let ran = false;
    const metadata = { status: { configured: true } } as Record<string, unknown>;
    Object.defineProperty(metadata, "ok", { get: () => ((ran = true), true) });
    expect(deriveProviderReadiness(settings(), metadata as never, [adapter("ollama-native", true)])).toBe("none");
    expect(ran).toBe(false);
  });

  it("never throws, even on hostile input", () => {
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error("trap"); }, ownKeys: () => { throw new Error("trap"); } });
    expect(deriveProviderReadiness(hostile, hostile as never, [hostile as never])).toBe("none");
    expect(deriveProviderReadiness(settings(), hostile as never, [adapter("ollama-native", true)])).toBe("none");
  });
});

describe("with the capability model", () => {
  const NOW = 1_800_000_000_000;
  const EDITIONS: Edition[] = ["free", "byok-pro", "cloud-pro"];
  const LICENSES: LicenseState[] = ["none", "valid", "invalid", "not-verifiable"];
  const ENTITLEMENTS: CloudEntitlement[] = ["active", "expired", "revoked", "unknown"];
  const CLOUDS: CloudState[] = [{ signedIn: false, entitlement: "unknown", online: false, lastVerifiedAt: null }];
  for (const entitlement of ENTITLEMENTS) for (const online of [true, false]) CLOUDS.push({ signedIn: true, entitlement, online, lastVerifiedAt: NOW - 1000 });
  const ADAPTER_SETS: AiAdapterDescriptor[][] = [[...PRODUCTION_AI_ADAPTERS], LOCAL_API_STYLES.map((s) => adapter(s)), LOCAL_API_STYLES.map((s) => adapter(s, true))];
  const DOCS: unknown[] = [emptyAiSettings(), settings(), settings("openai-compatible", "cfg-b2"), { ...settings(), version: 9 }];

  it("no implemented AI feature exists, so nothing is ever usable", () => {
    expect(Object.values(AI_IMPLEMENTED).every((v) => v === false)).toBe(true);
    let evaluated = 0;
    for (const doc of DOCS) for (const credential of CREDENTIALS) for (const adapters of ADAPTER_SETS) {
      const provider = deriveProviderReadiness(doc, credential, adapters);
      for (const edition of EDITIONS) for (const license of LICENSES) for (const cloud of CLOUDS) {
        const report = evaluateCapabilities({ edition, license, provider, cloud } as EditionState, NOW);
        for (const capability of AI_CAPABILITIES) {
          expect(report.ai[capability].usable).toBe(false);
          expect(report.ai[capability].implemented).toBe(false);
          expect(report.ai[capability].reason).not.toBeNull();
        }
        evaluated++;
      }
    }
    expect(evaluated).toBe(DOCS.length * CREDENTIALS.length * ADAPTER_SETS.length * EDITIONS.length * LICENSES.length * CLOUDS.length);
  });

  it("with the production registry, a configured endpoint and a saved key leave AI not ready", () => {
    const provider = deriveProviderReadiness(settings(), KEY_REMEMBERED, PRODUCTION_AI_ADAPTERS);
    const report = evaluateCapabilities({ edition: "byok-pro", license: "valid", provider, cloud: CLOUDS[0] }, NOW);
    expect(report.ai["ai-setup-recommendations"]).toMatchObject({ entitled: true, ready: false, readinessReason: "provider-not-configured", prospectivelyEligible: false, usable: false, route: null });
  });

  it("even a synthetic supported adapter only reaches 'prospectively eligible', never usable", () => {
    const provider = deriveProviderReadiness(settings(), null, [adapter("ollama-native")]);
    expect(provider).toBe("local-endpoint");
    const report = evaluateCapabilities({ edition: "byok-pro", license: "valid", provider, cloud: CLOUDS[0] }, NOW);
    expect(report.ai["ai-setup-recommendations"]).toMatchObject({ entitled: true, ready: true, prospectivelyEligible: true, implemented: false, usable: false, reason: "not-implemented", route: "byok-local" });
    // Readiness never grants entitlement.
    const free = evaluateCapabilities({ edition: "free", license: "none", provider, cloud: CLOUDS[0] }, NOW);
    expect(free.ai["ai-setup-recommendations"]).toMatchObject({ entitled: false, usable: false, reason: "edition-not-entitled" });
    const unlicensed = evaluateCapabilities({ edition: "byok-pro", license: "none", provider, cloud: CLOUDS[0] }, NOW);
    expect(unlicensed.ai["ai-setup-recommendations"]).toMatchObject({ entitled: false, usable: false, reason: "license-missing" });
  });
});

describe("module boundaries", () => {
  const AI_DIR = path.resolve(import.meta.dirname, "../../../src/lib/ai");
  // Stage 4N adds probeSpec.ts; Stage 4R adds explanationContext.ts and contextDigest.ts. All held to the same purity rules.
  const FILES = ["localEndpoint.ts", "settingsSchema.ts", "providerReadiness.ts", "probeSpec.ts", "explanationContext.ts", "contextDigest.ts"];

  it("contains exactly the six modules", () => {
    expect(fs.readdirSync(AI_DIR).sort()).toEqual([...FILES].sort());
  });

  it("are pure: no Electron, Node, network, DNS, storage, environment, clock or credential store", () => {
    for (const file of FILES) {
      const source = fs.readFileSync(path.join(AI_DIR, file), "utf-8");
      const code = source.replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(
        /["']node:|["']electron["']|ipcRenderer|ipcMain|window\.|globalThis|\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|Date\.now|new Date\(|performance\.|process\.|require\(|import\(|localStorage|sessionStorage|indexedDB|credentialStore|credentialService|getCredential|safeStorage|console\.|\beval\(|new Function/,
      );
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(imports.every((i) => ["./localEndpoint", "./localEndpoint.js", "./settingsSchema", "./settingsSchema.js", "../editions/types", "../editions/types.js", "../../types", "../../types.js", "../insights/types", "../safety/types", "./explanationContext"].includes(i)), `${file}: ${imports.join(", ")}`).toBe(true);
    }
  });

  it("the type-only imports stay type-only", () => {
    const source = fs.readFileSync(path.join(AI_DIR, "providerReadiness.ts"), "utf-8");
    expect(source).toMatch(/import type \{ ProviderReadiness \} from "\.\.\/editions\/types\.js"/);
    expect(source).toMatch(/import type \{ CredentialIpcResult \} from "\.\.\/\.\.\/types\.js"/);
  });

  // Stage 4F/4G: the AI settings store and service reuse these modules; nothing
  // in the running app imports either (tests/electron/aiSettings*.test.ts).
  // Stage 4K: aiConfigEditIpc.ts imports the schema's types only.
  const SCHEMA_CONSUMERS = [
    ...["aiSettingsStore.ts", "aiSettingsService.ts", "aiConfigEditIpc.ts"].map((f) => path.resolve(import.meta.dirname, "../../../electron", f)),
    // Stage 4L: the internal editor checks addresses and documents with the same pure modules.
    path.resolve(import.meta.dirname, "../../../src/lib/aiConfigEditor.ts"),
    path.resolve(import.meta.dirname, "../../../src/components/AiConfigEditor.tsx"),
    // Stage 4N: the probe transport builds its request with probeSpec.ts; nothing in the app calls it.
    path.resolve(import.meta.dirname, "../../../electron/localProbe.ts"),
    // Stage 4O: the probe IPC re-checks the id pattern and the stored endpoint with them.
    path.resolve(import.meta.dirname, "../../../electron/aiProbeIpc.ts"),
  ];

  it("nothing in the app imports them yet, apart from the unused settings store and service", () => {
    const roots = ["src", "electron"].map((d) => path.resolve(import.meta.dirname, "../../..", d));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full !== AI_DIR) walk(full);
        } else if (/\.(ts|tsx|cts|mts)$/.test(entry.name) && /lib\/ai\/|["']\.\/ai\/|["']\.\.\/ai\//.test(fs.readFileSync(full, "utf-8"))) {
          if (!SCHEMA_CONSUMERS.includes(full)) offenders.push(full);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
