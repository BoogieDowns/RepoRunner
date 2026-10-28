// Stage 4H: the read-only "ai-config-status" IPC channel, end to end through
// the real ipc.ts registration and sender guard, the real AI settings
// service and the real store, in a temporary userData folder. Synthetic,
// non-secret configurations only; no real userData, credentials or network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  userData: "",
  getPathCalls: [] as string[],
  getPathThrows: false,
  constructed: 0,
  loadThrows: false,
  credentialCalls: 0,
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
  app: {
    getPath: (name: string) => {
      h.getPathCalls.push(name);
      if (h.getPathThrows) throw new Error(`EACCES: permission denied, C:\\Users\\SYNTHETIC\\${name}`);
      return h.userData;
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  clipboard: { writeText: () => {} },
  shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
}));
// Counts store constructions; can make a load throw unexpectedly. Otherwise the real store.
vi.mock("../../electron/aiSettingsStore.js", async (original) => {
  const real = await original<typeof import("../../electron/aiSettingsStore.js")>();
  class CountingStore extends real.AiSettingsStore {
    constructor(options: import("../../electron/aiSettingsStore.js").AiSettingsStoreOptions) {
      super(options);
      h.constructed++;
    }
    override load() {
      if (h.loadThrows) return Promise.reject(new Error(`EIO: ${h.userData}\\reporunner-ai-settings.json SYNTHETIC`));
      return super.load();
    }
  }
  return { ...real, AiSettingsStore: CountingStore };
});
// A saved credential "elsewhere": the credential handlers see one; AI status must not look.
vi.mock("../../electron/credentialService.js", () => ({
  getCredentialStore: () => {
    h.credentialCalls++;
    return {
      status: async () => ({ configured: true, mode: "remembered" }),
      persistenceAvailability: () => ({ available: true }),
      setCredential: async () => {},
      removeCredential: async () => {},
      getCredential: async () => {
        throw new Error("must never be called");
      },
    };
  },
}));
vi.mock("child_process", () => ({ spawn: vi.fn(), execFile: vi.fn(), exec: vi.fn() }));
vi.mock("../../electron/projectStore.js", () => ({
  loadProject: () => null,
  loadProjectState: () => ({ profiles: [], activeProfileId: null, revision: null }),
  saveProject: vi.fn(),
  setActiveProject: vi.fn(),
  deleteProject: vi.fn(),
  inspectProjectStore: () => ({ state: "ok" }),
  resolveProjectStoreIssue: vi.fn(),
  getProjectStoreRevealTarget: () => ({ kind: "file", path: "C:\\x" }),
}));
vi.mock("../../electron/processManager.js", () => ({
  startService: vi.fn(async () => {}),
  stopAllServices: vi.fn(async () => {}),
  waitForServiceSettled: vi.fn(async () => {}),
  getStatuses: () => ({ frontend: "stopped", backend: "stopped" }),
}));
vi.mock("../../electron/logSink.js", () => ({ emitLog: vi.fn(), clearLogs: vi.fn(), formatLogsForClipboard: () => "logs" }));

import { DEV_URL, FakeContents, FakeFrame, PACKAGED_URL, trustedRenderer } from "./fakeSender.js";
import { UNTRUSTED_SENDER_MESSAGE } from "../../electron/ipcTrust.js";
import { AI_SETTINGS_FORMAT, serializeAiSettings } from "../../src/lib/ai/settingsSchema.js";

const CHANNEL = "ai-config-status";
const FILE = "reporunner-ai-settings.json";
const ENDPOINT = "http://127.0.0.1:11434";
const ENDPOINT_2 = "http://[::1]:8080/v1";
const MODEL = "synthetic-model-label-7q";
const GENERAL_CALLS: Array<[string, unknown[]]> = [
  ["load-project", []], ["load-project-state", []], ["get-project-store-status", []], ["get-statuses", []],
  ["select-folder", []], ["copy-logs", []], ["clear-logs", []], ["stop-services", []],
];

let app: ReturnType<typeof trustedRenderer>;
let fetchSpy: ReturnType<typeof vi.fn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
const file = () => path.join(h.userData, FILE);
const call = (...args: unknown[]) => h.handlers.get(CHANNEL)!(app.event(), ...args) as Promise<Record<string, unknown>>;
const settings = (active: string | null = "cfg-b2", version = 1) => ({
  format: AI_SETTINGS_FORMAT,
  version,
  active,
  configs: [
    { id: "cfg-a1", kind: "local-endpoint", endpoint: ENDPOINT, apiStyle: "ollama-native", model: MODEL },
    { id: "cfg-b2", kind: "local-endpoint", endpoint: ENDPOINT_2, apiStyle: "openai-compatible", model: null },
  ],
});
const writeValid = (active: string | null = "cfg-b2") => {
  const s = serializeAiSettings(settings(active));
  if (!s.ok) throw new Error(s.error);
  fs.writeFileSync(file(), s.text);
  return s.text;
};
const status = (over: Record<string, unknown> = {}) => ({
  ok: true,
  status: { storage: "missing", damage: null, configurationCount: 0, active: null, providerReadiness: "none", ...over },
});
/** Nothing in a result may reveal configuration values, revisions, credentials, paths or system errors. */
const assertNoLeak = (value: unknown) => {
  const text = JSON.stringify(value);
  // Stage 4I: no revision crosses IPC, under any name.
  expect(text).not.toMatch(/"revision"|[0-9a-f]{64}/);
  for (const leak of ["127.0.0.1", "11434", "::1", "8080", "/v1", MODEL, "\"endpoint\"", "\"model\"", "\"settings\"", "\"configs\"", "SYNTHETIC", "EACCES", "EIO", h.userData, path.basename(h.userData), "rr-4h-ipc", os.tmpdir(), FILE, "remembered", "configured"]) {
    expect(text, leak).not.toContain(leak);
  }
};

/** A fresh main process: module state (the service's store) starts over; userData stays. */
async function startApp(trustUrl = PACKAGED_URL) {
  vi.resetModules();
  h.handlers.clear();
  const { setupIpc } = await import("../../electron/ipc.js");
  app = trustedRenderer(trustUrl);
  // An internal launch, so the credential handler used below runs.
  setupIpc(app.trust, { internalCredentialSettings: true });
}

beforeEach(async () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "rr-4h-ipc-"));
  h.getPathCalls = [];
  h.getPathThrows = false;
  h.constructed = 0;
  h.loadThrows = false;
  h.credentialCalls = 0;
  fetchSpy = vi.fn(() => {
    throw new Error("no network");
  });
  vi.stubGlobal("fetch", fetchSpy);
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
  await startApp();
});
afterEach(() => {
  for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe("lazy and shared", () => {
  it("registering the handlers and running ordinary Free handlers touch nothing", async () => {
    expect(h.handlers.has(CHANNEL)).toBe(true);
    for (const [channel, args] of GENERAL_CALLS) await h.handlers.get(channel)!(app.event(), ...args);
    expect(h.constructed).toBe(0);
    expect(h.getPathCalls).toEqual([]);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("the first trusted call creates the one store in userData; later calls share it", async () => {
    await call();
    expect(h.constructed).toBe(1);
    expect(h.getPathCalls).toEqual(["userData"]);
    for (let i = 0; i < 3; i++) await call();
    await Promise.all([call(), call(), call()]);
    expect(h.constructed).toBe(1);
    expect(h.getPathCalls).toEqual(["userData"]);
  });
});

describe("the trusted page", () => {
  it("missing settings: the empty status, and no file is created", async () => {
    expect(await call()).toEqual(status());
    expect(await call()).toEqual(status());
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("valid settings: metadata only, and readiness none even with an active endpoint", async () => {
    const text = writeValid("cfg-b2");
    const result = await call();
    expect(result).toEqual(status({
      storage: "valid",
      configurationCount: 2,
      active: { id: "cfg-b2", kind: "local-endpoint", apiStyle: "openai-compatible" },
    }));
    assertNoLeak(result);
    expect(fs.readFileSync(file(), "utf8")).toBe(text);
    // Nothing selected: still metadata, still none.
    writeValid(null);
    expect(await call()).toMatchObject({ ok: true, status: { storage: "valid", active: null, configurationCount: 2, providerReadiness: "none" } });
  });

  it("works for the development page too", async () => {
    await startApp(DEV_URL);
    expect(await call()).toEqual(status());
  });

  const unusable: Array<[string, () => void, Record<string, unknown>]> = [
    ["damaged (invalid JSON)", () => fs.writeFileSync(file(), "{ SYNTHETIC"), { storage: "damaged", damage: "invalid-json" }],
    ["damaged (an endpoint off this computer)", () => fs.writeFileSync(file(), JSON.stringify({ ...settings(), configs: [{ ...settings().configs[0], endpoint: "http://192.168.1.4:11434" }], active: "cfg-a1" })), { storage: "damaged", damage: "invalid-endpoint" }],
    ["damaged (a secret field)", () => fs.writeFileSync(file(), JSON.stringify({ ...settings(), apiKey: "sk-SYNTHETIC" })), { storage: "damaged", damage: "unknown-field" }],
    ["damaged (a directory at the path)", () => fs.mkdirSync(file()), { storage: "damaged", damage: "not-a-regular-file" }],
    ["a newer version", () => fs.writeFileSync(file(), JSON.stringify(settings("cfg-a1", 2))), { storage: "unsupported-version" }],
  ];
  it.each(unusable)("%s: reported as such, never as an empty valid configuration, and left untouched", async (_name, setup, expected) => {
    setup();
    const before = fs.statSync(file()).isFile() ? fs.readFileSync(file()) : null;
    const result = await call();
    expect(result).toEqual(status(expected));
    assertNoLeak(result);
    if (before) expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(fs.readdirSync(h.userData)).toEqual([FILE]);
  });

  it("unreadable (userData can't be resolved): a fixed status, no details", async () => {
    h.getPathThrows = true;
    const result = await call();
    expect(result).toEqual(status({ storage: "unreadable" }));
    assertNoLeak(result);
  });

  it("an unexpected internal error is a fixed failure, without its message", async () => {
    writeValid();
    h.loadThrows = true;
    const result = await call();
    expect(result).toEqual({ ok: false, error: "failed" });
    assertNoLeak(result);
  });

  it("a saved credential changes nothing, and the AI status never asks the credential service", async () => {
    writeValid("cfg-a1");
    await expect(h.handlers.get("credential-status")!(app.event(), "byok-slot-1")).resolves.toMatchObject({ ok: true, status: { configured: true } });
    const before = h.credentialCalls;
    const result = await call();
    expect(result).toMatchObject({ ok: true, status: { storage: "valid", providerReadiness: "none" } });
    expect(h.credentialCalls).toBe(before);
    assertNoLeak(result);
  });
});

describe("arguments", () => {
  it.each([
    ["undefined", [undefined]],
    ["null", [null]],
    ["a string", ["status"]],
    ["an object", [{}]],
    ["a path", ["C:\\Users\\SYNTHETIC\\reporunner-ai-settings.json"]],
    ["two undefined", [undefined, undefined]],
  ])("any argument (%s) is refused before the service is touched", async (_name, args) => {
    expect(await call(...args)).toEqual({ ok: false, error: "invalid-request" });
    expect(h.constructed).toBe(0);
    expect(h.getPathCalls).toEqual([]);
  });
});

describe("untrusted callers", () => {
  function untrustedEvents() {
    const other = new FakeContents(PACKAGED_URL, 9, 1);
    const sub = new FakeFrame(PACKAGED_URL, 4, 2);
    sub.parent = app.contents.mainFrame;
    const elsewhere = new FakeContents("https://example.invalid/", 4, 1);
    const detached = new FakeFrame(PACKAGED_URL, 4, 1);
    detached.detached = true;
    return [
      ["another window showing the same page", { sender: other, senderFrame: other.mainFrame }],
      ["the main webContents with another window's frame", { sender: app.contents, senderFrame: other.mainFrame }],
      ["a subframe of the main window", { sender: app.contents, senderFrame: sub }],
      ["a forged frame: main frame's ids, different page", { sender: app.contents, senderFrame: new FakeFrame("https://example.invalid/", 4, 1) }],
      ["a wrong process id", { sender: app.contents, senderFrame: new FakeFrame(PACKAGED_URL, 5, 1) }],
      ["a wrong routing id", { sender: app.contents, senderFrame: new FakeFrame(PACKAGED_URL, 4, 7) }],
      ["a detached frame", { sender: app.contents, senderFrame: detached }],
      ["no senderFrame", { sender: app.contents, senderFrame: null }],
      ["no sender", { senderFrame: app.contents.mainFrame }],
      ["a webContents showing another page", { sender: elsewhere, senderFrame: elsewhere.mainFrame }],
      ["the development URL when packaged", { sender: new FakeContents(DEV_URL, 4, 1), senderFrame: new FakeFrame(DEV_URL, 4, 1) }],
      ["an empty event", {}],
    ] as Array<[string, unknown]>;
  }

  it("are refused with the usual message, before the service, a file, credentials or the network are touched", async () => {
    writeValid();
    for (const [name, event] of untrustedEvents()) {
      const error = await h.handlers.get(CHANNEL)!(event).then(() => null, (e: Error) => e);
      expect(error?.message, name).toBe(UNTRUSTED_SENDER_MESSAGE);
    }
    expect(h.constructed).toBe(0);
    expect(h.getPathCalls).toEqual([]);
    expect(h.credentialCalls).toBe(0);
  });

  it("a destroyed sender, a navigated page and a replaced window are refused", async () => {
    app.contents.url = "https://example.invalid/";
    await expect(call()).rejects.toThrow(UNTRUSTED_SENDER_MESSAGE);
    app.contents.url = PACKAGED_URL;
    app.contents.destroyed = true;
    await expect(call()).rejects.toThrow(UNTRUSTED_SENDER_MESSAGE);
    app.contents.destroyed = false;
    app.window.current = null;
    await expect(call()).rejects.toThrow(UNTRUSTED_SENDER_MESSAGE);
    expect(h.constructed).toBe(0);
    expect(h.getPathCalls).toEqual([]);
  });

  it("everything is refused when no trust information was given", async () => {
    vi.resetModules();
    h.handlers.clear();
    const { setupIpc } = await import("../../electron/ipc.js");
    setupIpc();
    await expect(h.handlers.get(CHANNEL)!(app.event())).rejects.toThrow(UNTRUSTED_SENDER_MESSAGE);
    expect(h.constructed).toBe(0);
  });
});

describe("renderer isolation and module boundaries", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

  it("only the internal preload method reaches the channel; the mock never does", () => {
    // Stage 4I: one method, inside the same switch-gated block as the credential methods.
    const preload = read("electron/preload.cts");
    expect(preload.match(/ai-config-status/g)).toHaveLength(1);
    const gated = preload.slice(preload.indexOf("process.argv.includes(INTERNAL_CREDENTIAL_SETTINGS_SWITCH)"), preload.indexOf("  : {};"));
    expect(gated).toContain('aiConfigStatus: () => ipcRenderer.invoke("ai-config-status"),');
    expect(read("src/mock/repoRunnerMock.ts")).not.toMatch(/ai-config-status|aiConfigStatus|getAiConfigurationStatus/);
    expect(read("src/types.ts")).toMatch(/^ {2}aiConfigStatus\?\(\): Promise<AiConfigStatusIpcResult>;$/m);
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|cts)$/.test(entry.name) && /ai-config-status|aiConfigStatus/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(ROOT, full).replace(/\\/g, "/"));
      }
    };
    walk(path.join(ROOT, "src"));
    walk(path.join(ROOT, "electron"));
    expect(offenders.sort()).toEqual(["electron/aiConfigIpc.ts", "electron/ipc.ts", "electron/preload.cts", "src/App.tsx", "src/components/CredentialSettingsDialog.tsx", "src/lib/aiConfigStatus.ts", "src/types.ts"]);
  });

  it("the handler module imports only the status function, and has no credential, network, file, environment or logging access", () => {
    const source = read("electron/aiConfigIpc.ts");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect([...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["./aiSettingsService.js", "../src/types.js"]);
    expect(source).toMatch(/^import type \{ AiConfigStatusIpcResult \} from "\.\.\/src\/types\.js";$/m);
    expect(code).not.toMatch(
      /saveAiSettings|loadAiSettings|credential|getCredential|safeStorage|\bfetch\(|XMLHttpRequest|WebSocket|["'](net|dns|http|https|tls|fs|child_process)["']|process\.env|console\.|\brequire\(|\bimport\(|\beval\(|aiReady|endpoint|model|revision/,
    );
  });

  it("ipc.ts registers the channel once, through the guard, with no other new registration", () => {
    const source = read("electron/ipc.ts");
    expect(source.match(/handle\("ai-config-status"/g)).toHaveLength(1);
    expect(source).toMatch(/^ {2}handle\("ai-config-status", async \(_event, \.\.\.args: unknown\[\]\) => aiConfigStatus\(args\)\);$/m);
    expect(source).not.toMatch(/aiSettingsService/);
  });
});
