// Stage 4K: "ai-config-edit-load" and "ai-config-edit-save", end to end
// through the real ipc.ts registration, sender guard and internal gate, the
// real AI settings service and the real store, in a temporary userData
// folder. Synthetic, non-secret configurations only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  userData: "",
  getPathCalls: 0,
  getPathThrows: false,
  constructed: 0,
  loadThrows: false,
  credentialCalls: 0,
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
  app: {
    getPath: (name: string) => {
      h.getPathCalls++;
      if (h.getPathThrows) throw new Error(`EACCES: permission denied, C:\\Users\\SYNTHETIC\\${name}`);
      return h.userData;
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  clipboard: { writeText: () => {} },
  shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
}));
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
vi.mock("../../electron/credentialService.js", () => ({
  getCredentialStore: () => {
    h.credentialCalls++;
    throw new Error("the AI edit handlers must not use credentials");
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

import { FakeContents, FakeFrame, PACKAGED_URL, trustedRenderer } from "./fakeSender.js";
import { UNTRUSTED_SENDER_MESSAGE } from "../../electron/ipcTrust.js";

const LOAD = "ai-config-edit-load";
const SAVE = "ai-config-edit-save";
const FILE = "reporunner-ai-settings.json";
const HEX = /^[0-9a-f]{64}$/;
const EMPTY = { format: "reporunner-ai-settings", version: 1, active: null, configs: [] };
const local = (id: string, endpoint = "http://127.0.0.1:11434", apiStyle = "ollama-native", model: string | null = "synthetic-model-4k") => ({ id, kind: "local-endpoint", endpoint, apiStyle, model });
const doc = (configs: unknown[] = [], active: string | null = null, extra: Record<string, unknown> = {}) => ({ format: "reporunner-ai-settings", version: 1, active, configs, ...extra });

let app: ReturnType<typeof trustedRenderer>;
let fetchSpy: ReturnType<typeof vi.fn>;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
const file = () => path.join(h.userData, FILE);
const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!(app.event(), ...args) as Promise<Record<string, unknown>>;
const NO_OPTIONS = Symbol("no options");
const assertNoLeak = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const leak of ["SYNTHETIC", "EACCES", "EIO", "permission", h.userData, path.basename(h.userData), FILE, "Users"]) expect(text, leak).not.toContain(leak);
};

/** A fresh main process; by default an internal launch (the gate open). */
async function startApp(options: unknown = { internalCredentialSettings: true }) {
  vi.resetModules();
  h.handlers.clear();
  const { setupIpc } = await import("../../electron/ipc.js");
  app = trustedRenderer(PACKAGED_URL);
  if (options === NO_OPTIONS) setupIpc(app.trust);
  else (setupIpc as (trust: unknown, options?: unknown) => void)(app.trust, options);
}

beforeEach(async () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "rr-4k-edit-"));
  h.getPathCalls = 0;
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
  expect(h.credentialCalls).toBe(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe("the internal gate (decided at startup, passed in by main.ts)", () => {
  const CALLS: Array<[string, unknown[]]> = [
    [LOAD, []],
    [LOAD, [undefined]],
    [SAVE, [doc([local("cfg-a1")], "cfg-a1"), null]],
    [SAVE, [doc(), "f".repeat(64)]],
    [SAVE, []],
    [SAVE, ["not a document", 1, 2]],
  ];

  it.each([
    ["no options", NO_OPTIONS],
    ["an empty options object", {}],
    ["false", { internalCredentialSettings: false }],
    ["the string 'true'", { internalCredentialSettings: "true" }],
    ["the number 1", { internalCredentialSettings: 1 }],
  ])("closed (%s): both channels answer exactly 'not-available' before looking at the request; nothing is touched", async (_name, options) => {
    await startApp(options);
    for (const [channel, args] of CALLS) expect(await call(channel, ...args), `${channel} ${args.length}`).toEqual({ ok: false, error: "not-available" });
    expect([h.constructed, h.getPathCalls]).toEqual([0, 0]);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("closed: Free IPC and the read-only ai-config-status still answer", async () => {
    await startApp({ internalCredentialSettings: false });
    await expect(h.handlers.get("get-statuses")!(app.event())).resolves.toEqual({ frontend: "stopped", backend: "stopped" });
    await expect(h.handlers.get("ai-config-status")!(app.event())).resolves.toMatchObject({ ok: true, status: { storage: "missing" } });
  });

  it("the sender check comes first: untrusted callers are refused the same way with the gate open or closed", async () => {
    for (const options of [{ internalCredentialSettings: true }, { internalCredentialSettings: false }, NO_OPTIONS]) {
      await startApp(options);
      const other = new FakeContents(PACKAGED_URL, 9, 1);
      const sub = new FakeFrame(PACKAGED_URL, 4, 2);
      sub.parent = app.contents.mainFrame;
      const events = [
        { sender: other, senderFrame: other.mainFrame },
        { sender: app.contents, senderFrame: other.mainFrame },
        { sender: app.contents, senderFrame: sub },
        { sender: app.contents, senderFrame: new FakeFrame(PACKAGED_URL, 4, 7) },
        { sender: app.contents, senderFrame: null },
        {},
      ];
      for (const event of events) {
        for (const [channel, args] of CALLS) await expect(h.handlers.get(channel)!(event, ...args)).rejects.toThrow(UNTRUSTED_SENDER_MESSAGE);
      }
    }
    expect([h.constructed, h.getPathCalls]).toEqual([0, 0]);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("decided once: changing the options object or the environment afterwards changes nothing", async () => {
    const options = { internalCredentialSettings: false };
    await startApp(options);
    options.internalCredentialSettings = true;
    const saved = process.env.REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS;
    process.env.REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS = "1";
    try {
      expect(await call(LOAD)).toEqual({ ok: false, error: "not-available" });
      expect(await call(SAVE, doc(), null)).toEqual({ ok: false, error: "not-available" });
    } finally {
      if (saved === undefined) delete process.env.REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS;
      else process.env.REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS = saved;
    }
    expect(h.constructed).toBe(0);
  });
});

describe("edit-load", () => {
  it("missing file: the empty v1 document and revision null; nothing is created", async () => {
    expect(await call(LOAD)).toEqual({ ok: true, state: "missing", revision: null, settings: EMPTY });
    expect(await call(LOAD)).toEqual({ ok: true, state: "missing", revision: null, settings: EMPTY });
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it.each([["undefined", [undefined]], ["null", [null]], ["a string", ["x"]], ["two arguments", [undefined, undefined]]])(
    "any argument (%s) is refused before the service is touched",
    async (_name, args) => {
      expect(await call(LOAD, ...args)).toEqual({ ok: false, error: "invalid-request" });
      expect([h.constructed, h.getPathCalls]).toEqual([0, 0]);
    },
  );

  it("valid file: exactly the schema's fields and the file's revision", async () => {
    const saved = await call(SAVE, doc([local("cfg-a1"), local("cfg-b2", "http://[::1]:8080/v1", "openai-compatible", null)], "cfg-b2"), null);
    const loaded = await call(LOAD);
    expect(loaded).toEqual({ ok: true, state: "valid", revision: saved.revision, settings: saved.settings });
    expect(loaded.revision).toMatch(HEX);
    expect(Object.keys(loaded)).toEqual(["ok", "state", "revision", "settings"]);
    expect(Object.keys(loaded.settings as object)).toEqual(["format", "version", "active", "configs"]);
    for (const c of (loaded.settings as { configs: object[] }).configs) expect(Object.keys(c)).toEqual(["id", "kind", "endpoint", "apiStyle", "model"]);
  });

  const unusable: Array<[string, () => void, Record<string, unknown>]> = [
    ["invalid JSON", () => fs.writeFileSync(file(), "{ SYNTHETIC broken"), { ok: false, error: "damaged", damage: "invalid-json" }],
    ["a secret field", () => fs.writeFileSync(file(), JSON.stringify(doc([], null, { apiKey: "sk-SYNTHETIC" }))), { ok: false, error: "damaged", damage: "unknown-field" }],
    ["a LAN endpoint", () => fs.writeFileSync(file(), JSON.stringify(doc([local("cfg-a1", "http://192.168.1.9:11434")]))), { ok: false, error: "damaged", damage: "invalid-endpoint" }],
    ["a directory at the path", () => fs.mkdirSync(file()), { ok: false, error: "damaged", damage: "not-a-regular-file" }],
    ["a newer version", () => fs.writeFileSync(file(), JSON.stringify({ ...doc(), version: 2, providers: ["SYNTHETIC"] })), { ok: false, error: "unsupported-version" }],
  ];
  it.each(unusable)("%s: a fixed code, never the contents, never 'missing'; the file is untouched", async (_name, setup, expected) => {
    setup();
    const before = fs.statSync(file()).isFile() ? fs.readFileSync(file()) : null;
    const result = await call(LOAD);
    expect(result).toEqual(expected);
    assertNoLeak(result);
    if (before) expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(fs.readdirSync(h.userData)).toEqual([FILE]);
  });

  it("unreadable (userData can't be resolved) and unexpected failures: fixed codes, no details", async () => {
    h.getPathThrows = true;
    const unreadable = await call(LOAD);
    expect(unreadable).toEqual({ ok: false, error: "unreadable" });
    assertNoLeak(unreadable);
    h.getPathThrows = false;
    await call(SAVE, doc(), null);
    h.loadThrows = true;
    const failed = await call(LOAD);
    expect(failed).toEqual({ ok: false, error: "failed" });
    assertNoLeak(failed);
  });
});

describe("edit-save: the request", () => {
  it.each([
    ["no arguments", []],
    ["one argument", [doc()]],
    ["three arguments", [doc(), null, null]],
    ["an undefined revision", [doc(), undefined]],
    ["a trailing undefined", [doc(), null, undefined]],
    ["an upper-case revision", [doc(), "A".repeat(64)]],
    ["a short revision", [doc(), "a".repeat(63)]],
    ["a long revision", [doc(), "a".repeat(65)]],
    ["a revision with a prefix", [doc(), "sha256:" + "a".repeat(64)]],
    ["a numeric revision", [doc(), 1]],
    ["an empty revision", [doc(), ""]],
    ["an array document", [[doc()], null]],
    ["a null document", [null, null]],
    ["a string document", [JSON.stringify(doc()), null]],
    ["a number document", [7, null]],
    ["a Date document", [new Date(0), null]],
    ["a Map document", [new Map([["format", "reporunner-ai-settings"]]), null]],
    ["a class-instance document", [new (class { format = "reporunner-ai-settings"; version = 1; active = null; configs = []; })(), null]],
  ])("%s is refused as invalid-request before the service is touched", async (_name, args) => {
    expect(await call(SAVE, ...args)).toEqual({ ok: false, error: "invalid-request" });
    expect([h.constructed, h.getPathCalls]).toEqual([0, 0]);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("a null-prototype document is a plain object and is accepted", async () => {
    const plain = Object.assign(Object.create(null), doc([local("cfg-a1")]));
    expect(await call(SAVE, plain, null)).toMatchObject({ ok: true });
  });
});

describe("edit-save: the document (Stage 4E schema, in the main process)", () => {
  it.each([
    ["an unknown top-level field", doc([], null, { note: "x" }), "unknown-field"],
    ["an apiKey", doc([], null, { apiKey: "sk-SYNTHETIC" }), "unknown-field"],
    ["a token in a configuration", doc([{ ...local("cfg-a1"), token: "SYNTHETIC" }]), "unknown-field"],
    ["headers in a configuration", doc([{ ...local("cfg-a1"), headers: { Authorization: "Bearer SYNTHETIC" } }]), "unknown-field"],
    ["a credential slot", doc([{ ...local("cfg-a1"), authSlot: "byok-slot-1" }]), "unknown-field"],
    ["a remote provider", doc([{ id: "cfg-a1", kind: "remote-provider", provider: "x", model: null }]), "unsupported-kind"],
    ["localhost", doc([local("cfg-a1", "http://localhost:11434")]), "invalid-endpoint"],
    ["a LAN address", doc([local("cfg-a1", "http://10.0.0.5:11434")]), "invalid-endpoint"],
    ["a public host", doc([local("cfg-a1", "http://example.com:80")]), "invalid-endpoint"],
    ["https", doc([local("cfg-a1", "https://127.0.0.1:8443")]), "invalid-endpoint"],
    ["userinfo", doc([local("cfg-a1", "http://u:p@127.0.0.1:1")]), "invalid-endpoint"],
    ["a query", doc([local("cfg-a1", "http://127.0.0.1:1/v1?x=1")]), "invalid-endpoint"],
    ["no port", doc([local("cfg-a1", "http://127.0.0.1")]), "invalid-endpoint"],
    ["port 0", doc([local("cfg-a1", "http://127.0.0.1:0")]), "invalid-endpoint"],
    ["an encoded path", doc([local("cfg-a1", "http://127.0.0.1:1/%2e%2e")]), "invalid-endpoint"],
    ["a traversal path", doc([local("cfg-a1", "http://127.0.0.1:1/a/../b")]), "invalid-endpoint"],
    ["a non-canonical endpoint (trailing slash)", doc([local("cfg-a1", "http://127.0.0.1:1/")]), "invalid-endpoint"],
    ["127.1", doc([local("cfg-a1", "http://127.1:11434")]), "invalid-endpoint"],
    ["an oversized endpoint", doc([local("cfg-a1", "http://127.0.0.1:1/" + "a".repeat(20_000))]), "invalid-endpoint"],
    ["four configurations", doc([local("cfg-a1"), local("cfg-b2"), local("cfg-c3"), local("cfg-d4")]), "too-many-configs"],
    ["duplicate ids", doc([local("cfg-a1"), local("cfg-a1", "http://[::1]:2")]), "duplicate-config-id"],
    ["an active id that points at nothing", doc([local("cfg-a1")], "cfg-zz"), "invalid-active"],
    ["a bad id", doc([local("../x")]), "invalid-config-id"],
    ["an unknown API style", doc([local("cfg-a1", "http://127.0.0.1:1", "grpc")]), "invalid-api-style"],
    ["an oversized model label", doc([local("cfg-a1", "http://127.0.0.1:1", "ollama-native", "m".repeat(129))]), "invalid-model"],
    ["an oversized unknown field (over 16 KiB of UTF-8)", doc([], null, { padding: "é".repeat(10_000) }), "unknown-field"],
    ["a newer version", { ...doc(), version: 2 }, "unsupported-version"],
    ["a wrong format", { ...doc(), format: "reporunner-credentials" }, "invalid-format"],
  ])("%s: invalid-settings with a fixed detail; nothing written", async (_name, settings, detail) => {
    const result = await call(SAVE, settings, null);
    expect(result).toEqual({ ok: false, error: "invalid-settings", detail });
    assertNoLeak(result);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });
});

describe("edit-save: writing and revisions", () => {
  it("initial save with null, read back by load (read-after-write), then chained by revision", async () => {
    const first = await call(SAVE, doc([local("cfg-a1")], "cfg-a1"), null);
    expect(first).toEqual({ ok: true, revision: expect.stringMatching(HEX), settings: doc([local("cfg-a1")], "cfg-a1") });
    expect(fs.readdirSync(h.userData)).toEqual([FILE]);
    expect(await call(LOAD)).toEqual({ ok: true, state: "valid", revision: first.revision, settings: first.settings });

    const second = await call(SAVE, doc([local("cfg-a1"), local("cfg-b2", "http://[::1]:8080")], "cfg-b2"), first.revision);
    expect(second).toMatchObject({ ok: true, settings: { active: "cfg-b2" } });
    expect(second.revision).not.toBe(first.revision);
    expect(await call(LOAD)).toEqual({ ok: true, state: "valid", revision: second.revision, settings: second.settings });

    // Removing a configuration is a whole-document replacement too.
    const third = await call(SAVE, doc([local("cfg-b2", "http://[::1]:8080")], null), second.revision);
    expect(third).toMatchObject({ ok: true, settings: { active: null, configs: [{ id: "cfg-b2" }] } });
  });

  it("the result is the document as written, field by field (not the request object)", async () => {
    const request = doc([local("cfg-a1")], "cfg-a1");
    const result = await call(SAVE, request, null);
    expect(result.settings).toEqual(request);
    expect(result.settings).not.toBe(request);
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual(request);
  });

  it("stale or wrong revisions are conflicts, with no document in the answer, and nothing changes", async () => {
    const first = await call(SAVE, doc([local("cfg-a1")]), null);
    const second = await call(SAVE, doc([local("cfg-b2")]), first.revision);
    const before = fs.readFileSync(file());
    for (const revision of [first.revision, null, "0".repeat(64)]) {
      expect(await call(SAVE, doc([local("cfg-zz")]), revision)).toEqual({ ok: false, error: "conflict" });
    }
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("a revision when the file is missing is a conflict, and creates nothing", async () => {
    expect(await call(SAVE, doc(), "a".repeat(64))).toEqual({ ok: false, error: "conflict" });
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("parallel saves from the same revision: exactly one succeeds", async () => {
    const base = await call(SAVE, doc(), null);
    const results = await Promise.all([1, 2, 3, 4].map((n) => call(SAVE, doc([local(`cfg-p${n}`)]), base.revision)));
    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r.error === "conflict")).toHaveLength(3);
  });

  const unusable: Array<[string, () => void, string]> = [
    ["damaged", () => fs.writeFileSync(file(), "{ SYNTHETIC"), "damaged"],
    ["a non-regular file", () => fs.mkdirSync(file()), "damaged"],
    ["a newer version", () => fs.writeFileSync(file(), JSON.stringify({ ...doc(), version: 3 })), "unsupported-version"],
  ];
  it.each(unusable)("%s file: never replaced, whatever the revision", async (_name, setup, error) => {
    setup();
    const before = fs.statSync(file()).isFile() ? fs.readFileSync(file()) : null;
    for (const revision of [null, "b".repeat(64)]) {
      const result = await call(SAVE, doc([local("cfg-a1")]), revision);
      expect(result).toEqual({ ok: false, error });
      assertNoLeak(result);
    }
    if (before) expect(fs.readFileSync(file()).equals(before)).toBe(true);
    else expect(fs.statSync(file()).isDirectory()).toBe(true);
    expect(fs.readdirSync(h.userData)).toEqual([FILE]);
  });

  it("unreadable storage: a fixed code, nothing written, no details", async () => {
    h.getPathThrows = true;
    const result = await call(SAVE, doc(), null);
    expect(result).toEqual({ ok: false, error: "unreadable" });
    assertNoLeak(result);
  });
});

describe("unchanged around it", () => {
  it("ai-config-status still has no revision, and readiness stays none after saving an active endpoint", async () => {
    await call(SAVE, doc([local("cfg-a1")], "cfg-a1"), null);
    const status = await h.handlers.get("ai-config-status")!(app.event());
    expect(status).toEqual({ ok: true, status: { storage: "valid", damage: null, configurationCount: 1, active: { id: "cfg-a1", kind: "local-endpoint", apiStyle: "ollama-native" }, providerReadiness: "none" } });
    expect(JSON.stringify(status)).not.toMatch(/revision|[0-9a-f]{64}|127\.0\.0\.1|synthetic-model/);
  });

  it("no preload method, renderer API or mock reaches the edit channels", () => {
    const ROOT = path.resolve(import.meta.dirname, "../..");
    for (const f of ["electron/preload.cts", "src/types.ts", "src/mock/repoRunnerMock.ts", "src/App.tsx", "src/components/CredentialSettingsDialog.tsx", "src/lib/aiConfigStatus.ts"]) {
      expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/ai-config-edit|aiConfigEdit/);
    }
  });

  it("the handler module has no credential, network, environment, logging or dynamic-code access", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/aiConfigEditIpc.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect([...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["./aiSettingsService.js", "./aiSettingsStore.js", "../src/lib/ai/settingsSchema.js"]);
    expect(code).not.toMatch(/credential|safeStorage|\bfetch\(|XMLHttpRequest|WebSocket|["'](net|dns|http|https|tls|fs|child_process)["']|process\.|console\.|\brequire\(|\bimport\(|\beval\(|new Function/);
  });

  it("ipc.ts gates both channels exactly like the credential handlers", () => {
    const ipc = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/ipc.ts"), "utf8");
    expect(ipc).toContain('handle("ai-config-edit-load", async (_event, ...args: unknown[]) => (credentialsAllowed ? aiConfigEditLoad(args) : aiConfigEditNotAvailable()));');
    expect(ipc).toContain('handle("ai-config-edit-save", async (_event, ...args: unknown[]) => (credentialsAllowed ? aiConfigEditSave(args) : aiConfigEditNotAvailable()));');
  });
});
