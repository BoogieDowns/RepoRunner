// Stage 4G: the lazy, shared AI settings service. Electron's app is mocked;
// the real store runs in a temporary userData folder. Synthetic, non-secret
// configurations only; no real userData, credentials or network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettingsFs, AiSettingsStoreOptions } from "../../electron/aiSettingsStore.js";

const h = vi.hoisted(() => ({
  userData: "",
  getPathCalls: [] as string[],
  getPathThrows: false,
  constructed: [] as unknown[],
  fsOverride: null as unknown,
  credentialAccess: 0,
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      h.getPathCalls.push(name);
      if (h.getPathThrows) throw new Error(`EACCES: C:\\Users\\SYNTHETIC\\${name}`);
      return name === "userData" ? h.userData : path.join(h.userData, `wrong-${name}`);
    },
  },
}));
// Counts constructions; optionally swaps in a failing fs. Otherwise the real store.
vi.mock("../../electron/aiSettingsStore.js", async (original) => {
  const real = await original<typeof import("../../electron/aiSettingsStore.js")>();
  class CountingStore extends real.AiSettingsStore {
    constructor(options: AiSettingsStoreOptions) {
      h.constructed.push({ ...options });
      super(h.fsOverride ? { ...options, fs: h.fsOverride as AiSettingsFs } : options);
    }
  }
  return { ...real, AiSettingsStore: CountingStore };
});
// Any credential access fails the test loudly.
vi.mock("../../electron/credentialService.js", () => ({
  getCredentialStore: () => {
    h.credentialAccess++;
    throw new Error("credential service must not be used");
  },
}));
vi.mock("../../electron/credentialStore.js", () => {
  h.credentialAccess++;
  return {};
});

type Service = typeof import("../../electron/aiSettingsService.js");
let service: Service;
const FILE = "reporunner-ai-settings.json";
const file = () => path.join(h.userData, FILE);
const local = (id: string, endpoint = "http://127.0.0.1:11434", apiStyle = "ollama-native") => ({ id, kind: "local-endpoint", endpoint, apiStyle, model: "llama3.1:8b" });
const doc = (configs: unknown[] = [], active: string | null = null, version = 1) => ({ format: "reporunner-ai-settings", version, active, configs });

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "rr-aiservice-"));
  h.getPathCalls = [];
  h.getPathThrows = false;
  h.constructed = [];
  h.fsOverride = null;
  h.credentialAccess = 0;
  fetchSpy = vi.fn(() => {
    throw new Error("no network");
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.resetModules();
  service = await import("../../electron/aiSettingsService.js");
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(h.userData, { recursive: true, force: true });
  // No credential access and no network, in every test.
  expect(h.credentialAccess).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

describe("lazy, single store", () => {
  it("importing the service does nothing", () => {
    expect(h.constructed).toEqual([]);
    expect(h.getPathCalls).toEqual([]);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("the first call creates exactly one store, in userData with the default fs; every later call shares it", async () => {
    await service.getAiConfigurationStatus();
    expect(h.constructed).toEqual([{ dir: h.userData }]);
    expect(h.getPathCalls).toEqual(["userData"]);
    await service.loadAiSettings();
    await service.saveAiSettings(doc(), null);
    await service.getAiConfigurationStatus();
    expect(h.constructed).toHaveLength(1);
    expect(h.getPathCalls).toEqual(["userData"]);
  });

  it("operations through the service stay serialized on the one store", async () => {
    const [s1, s2, status] = await Promise.all([
      service.saveAiSettings(doc([local("cfg-a1")]), null),
      service.saveAiSettings(doc([local("cfg-b2")]), null),
      service.getAiConfigurationStatus(),
    ]);
    expect(s1.ok).toBe(true);
    expect(s2).toEqual({ ok: false, error: "conflict" });
    expect(status).toMatchObject({ storage: "valid", configurationCount: 1, revision: s1.ok ? s1.revision : "" });
    expect(h.constructed).toHaveLength(1);
  });

  it("if userData can't be resolved: fixed 'unreadable' results, no store cached, a later call retries", async () => {
    h.getPathThrows = true;
    expect(await service.loadAiSettings()).toEqual({ status: "unreadable" });
    expect(await service.saveAiSettings(doc(), null)).toEqual({ ok: false, error: "unreadable" });
    const status = await service.getAiConfigurationStatus();
    expect(status).toEqual({ storage: "unreadable", damage: null, revision: null, configurationCount: 0, active: null, providerReadiness: "none" });
    expect(JSON.stringify(status)).not.toMatch(/SYNTHETIC|EACCES|Users/);
    expect(h.constructed).toEqual([]);
    h.getPathThrows = false;
    expect((await service.loadAiSettings()).status).toBe("missing");
    expect(h.constructed).toHaveLength(1);
  });

  it("exposes only load, save and status: no store, reset or override hook", () => {
    expect(Object.keys(service).sort()).toEqual(["getAiConfigurationStatus", "loadAiSettings", "saveAiSettings"]);
  });
});

describe("status", () => {
  it("missing file: empty, nothing selected, readiness none, and nothing written", async () => {
    expect(await service.getAiConfigurationStatus()).toEqual({ storage: "missing", damage: null, revision: null, configurationCount: 0, active: null, providerReadiness: "none" });
    expect(await service.loadAiSettings()).toMatchObject({ status: "missing", revision: null });
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("valid file: metadata only (no endpoint or model), and readiness none even with an active endpoint", async () => {
    const saved = await service.saveAiSettings(doc([local("cfg-a1"), local("cfg-b2", "http://[::1]:8080/v1", "openai-compatible")], "cfg-b2"), null);
    expect(saved.ok).toBe(true);
    const status = await service.getAiConfigurationStatus();
    expect(status).toEqual({
      storage: "valid",
      damage: null,
      revision: saved.ok ? saved.revision : null,
      configurationCount: 2,
      active: { id: "cfg-b2", kind: "local-endpoint", apiStyle: "openai-compatible" },
      providerReadiness: "none",
    });
    expect(JSON.stringify(status)).not.toMatch(/127\.0\.0\.1|::1|11434|8080|llama/);
  });

  it("readiness is none for every valid configuration: the production adapter registry is empty", async () => {
    let revision: string | null = null;
    for (const style of ["ollama-native", "openai-compatible"]) {
      for (const active of [null, "cfg-a1"]) {
        const saved = await service.saveAiSettings(doc([local("cfg-a1", "http://127.0.0.1:11434", style)], active), revision);
        expect(saved.ok).toBe(true);
        revision = saved.ok ? saved.revision : null;
        expect((await service.getAiConfigurationStatus()).providerReadiness).toBe("none");
      }
    }
  });

  const unusable: Array<[string, string | Buffer, Record<string, unknown>]> = [
    ["damaged (invalid JSON)", "{", { storage: "damaged", damage: "invalid-json" }],
    ["damaged (an endpoint off this computer)", JSON.stringify(doc([local("cfg-a1", "http://192.168.1.4:11434")], "cfg-a1")), { storage: "damaged", damage: "invalid-endpoint" }],
    ["damaged (a secret field)", JSON.stringify({ ...doc(), apiKey: "sk-SYNTHETIC" }), { storage: "damaged", damage: "unknown-field" }],
    ["a newer version", JSON.stringify(doc([local("cfg-a1")], "cfg-a1", 2)), { storage: "unsupported-version", damage: null }],
  ];
  it.each(unusable)("%s: reported as such, never as an empty configuration, and the file is untouched", async (_name, contents, expected) => {
    fs.writeFileSync(file(), contents);
    const before = fs.readFileSync(file());
    const status = await service.getAiConfigurationStatus();
    expect(status).toEqual({ damage: null, revision: null, configurationCount: 0, active: null, providerReadiness: "none", ...expected });
    expect(await service.saveAiSettings(doc(), null)).toMatchObject({ ok: false });
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(fs.readdirSync(h.userData)).toEqual([FILE]);
  });

  it("a directory at the file's path is damaged, not empty", async () => {
    fs.mkdirSync(file());
    expect(await service.getAiConfigurationStatus()).toMatchObject({ storage: "damaged", damage: "not-a-regular-file", providerReadiness: "none" });
  });

  it("unreadable storage is reported as unreadable, without system details", async () => {
    fs.writeFileSync(file(), JSON.stringify(doc([local("cfg-a1")], "cfg-a1")));
    h.fsOverride = {
      ...fs,
      lstatSync: () => {
        throw Object.assign(new Error(`EACCES: permission denied, lstat '${file()}'`), { code: "EACCES" });
      },
    };
    const status = await service.getAiConfigurationStatus();
    expect(status).toEqual({ storage: "unreadable", damage: null, revision: null, configurationCount: 0, active: null, providerReadiness: "none" });
    expect(JSON.stringify(status)).not.toMatch(/EACCES|permission|rr-aiservice/);
    expect(await service.saveAiSettings(doc(), null)).toEqual({ ok: false, error: "unreadable" });
  });
});

describe("saving", () => {
  it("is revision-aware and validated by the Stage 4E schema", async () => {
    const first = await service.saveAiSettings(doc([local("cfg-a1")]), null);
    expect(first.ok).toBe(true);
    expect(await service.saveAiSettings(doc([local("cfg-zz")]), null)).toEqual({ ok: false, error: "conflict" });
    expect(await service.saveAiSettings(doc(), "0".repeat(64))).toEqual({ ok: false, error: "conflict" });
    expect(await service.saveAiSettings(doc([local("cfg-a1", "http://localhost:11434")]), first.ok ? first.revision : null)).toEqual({ ok: false, error: "invalid-settings", detail: "invalid-endpoint" });
    expect(await service.saveAiSettings({ ...doc(), token: "SYNTHETIC" }, first.ok ? first.revision : null)).toEqual({ ok: false, error: "invalid-settings", detail: "unknown-field" });
    const second = await service.saveAiSettings(doc([local("cfg-b2")], "cfg-b2"), first.ok ? first.revision : null);
    expect(second.ok).toBe(true);
    expect(await service.loadAiSettings()).toMatchObject({ status: "valid", revision: second.ok ? second.revision : "", settings: { active: "cfg-b2" } });
    expect(fs.readFileSync(file(), "utf8")).not.toMatch(/token|SYNTHETIC|key|secret/i);
  });
});

describe("module boundaries", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const source = fs.readFileSync(path.join(ROOT, "electron/aiSettingsService.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports only Electron's app, the store, the readiness mapping and types", () => {
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../src/lib/ai/providerReadiness.js", "../src/lib/ai/settingsSchema.js", "../src/lib/editions/types.js", "./aiSettingsStore.js", "electron"]);
    expect(source).toMatch(/^import \{ app \} from "electron";$/m);
    expect(source).toMatch(/^import type \{ AiConfigKind, LocalApiStyle \} from "\.\.\/src\/lib\/ai\/settingsSchema\.js";$/m);
    expect(source).toMatch(/^import type \{ ProviderReadiness \} from "\.\.\/src\/lib\/editions\/types\.js";$/m);
  });

  it("uses the real, empty production adapter registry, with no credential metadata", () => {
    expect(code).toMatch(/deriveProviderReadiness\(settings, null, PRODUCTION_AI_ADAPTERS\)/);
    expect(code).not.toMatch(/requiresCredential|kind: "local-endpoint", apiStyle/);
  });

  it("has no credential, network, environment, file, process or dynamic-code access", () => {
    expect(code).not.toMatch(
      /credentialStore|credentialService|getCredential|safeStorage|\bfetch\(|XMLHttpRequest|WebSocket|["'](net|dns|http|https|tls|dgram|child_process|fs|node:fs)["']|process\.env|\brequire\(|\bimport\(|\beval\(|new Function|console\.|ipcMain|ipcRenderer|webContents|aiReady/,
    );
  });

  it("only the Stage 4H status handler, the Stage 4K edit handlers and the Stage 4O probe handler import it, and nothing calls it at startup", () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|cts|mts)$/.test(entry.name) && ![path.join(ROOT, "electron/aiSettingsService.ts"), path.join(ROOT, "electron/aiConfigIpc.ts"), path.join(ROOT, "electron/aiConfigEditIpc.ts"), path.join(ROOT, "electron/aiProbeIpc.ts")].includes(full) && /aiSettingsService|getAiConfigurationStatus|loadAiSettings|saveAiSettings/.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(path.join(ROOT, "src"));
    walk(path.join(ROOT, "electron"));
    expect(offenders).toEqual([]);
    // aiConfigIpc.ts uses only the status function; ipc.ts reaches the service only through it.
    const ipcModule = fs.readFileSync(path.join(ROOT, "electron/aiConfigIpc.ts"), "utf8");
    expect([...ipcModule.matchAll(/import \{([^}]*)\} from "\.\/aiSettingsService\.js"/g)].map((m) => m[1].trim())).toEqual(["getAiConfigurationStatus"]);
    expect(ipcModule).not.toMatch(/loadAiSettings|saveAiSettings/);
    // The edit handlers use load and save, nothing else.
    const editModule = fs.readFileSync(path.join(ROOT, "electron/aiConfigEditIpc.ts"), "utf8");
    expect([...editModule.matchAll(/import \{([^}]*)\} from "\.\/aiSettingsService\.js"/g)].map((m) => m[1].trim())).toEqual(["loadAiSettings, saveAiSettings"]);
  });
});
