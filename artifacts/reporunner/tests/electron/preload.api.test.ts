// What the preload script exposes to the page: a fixed list of named
// methods, never ipcRenderer itself or a generic send/invoke.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  exposed: new Map<string, Record<string, unknown>>(),
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const fakeElectron = {
  contextBridge: { exposeInMainWorld: (key: string, api: Record<string, unknown>) => h.exposed.set(key, api) },
  ipcRenderer: { invoke: h.invoke, send: h.send, sendSync: vi.fn(), on: h.on, removeListener: h.removeListener },
};

/**
 * Vitest doesn't load .cts files, so the real preload source is compiled to
 * CommonJS (as the build does) and run with a require that only knows
 * "electron" and a `process` whose argv is the renderer's command line.
 */
function loadPreload(argv: string[]): Record<string, unknown> {
  h.exposed.clear();
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/preload.cts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const fakeRequire = (id: string) => {
    if (id === "electron") return fakeElectron;
    throw new Error(`preload must not require ${id}`);
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "process", outputText)(fakeRequire, module, module.exports, { argv });
  return h.exposed.get("repoRunner")!;
}

/** A packaged or ordinary launch: the renderer's argv never carries the internal switch. */
const PRODUCTION_ARGV = ["C:\\Program Files\\RepoRunner\\RepoRunner.exe", "--type=renderer", "--enable-sandbox", "--reporunner-internal-credential-settings-x"];
const INTERNAL_SWITCH = "--reporunner-internal-credential-settings";

let api: Record<string, unknown>;
beforeAll(() => {
  api = loadPreload(PRODUCTION_ARGV);
});

describe("preload API", () => {
  it("exposes exactly the approved methods under one key", () => {
    expect([...h.exposed.keys()]).toEqual(["repoRunner"]);
    expect(Object.keys(api).sort()).toEqual(
      [
        "analyzeRepo",
        "cancelRepoAnalysis",
        "clearLogs",
        "copyLogs",
        "deleteProject",
        "getProjectStoreStatus",
        "getStatuses",
        "loadProject",
        "loadProjectState",
        "onLog",
        "onStatus",
        "openPreview",
        "pullLatest",
        "resolveProjectStoreIssue",
        "restartAll",
        "revealProjectStoreFile",
        "runInstall",
        "saveProject",
        "selectFolder",
        "setActiveProject",
        "startBackend",
        "startFrontend",
        "stopServices",
      ].sort(),
    );
    for (const value of Object.values(api)) expect(typeof value).toBe("function");
  });

  it("does not expose ipcRenderer or any generic channel access", () => {
    for (const name of Object.keys(api)) expect(name).not.toMatch(/^(invoke|send|sendSync|on|ipc|ipcRenderer|postMessage)$/i);
    expect(Object.values(api)).not.toContain(h.invoke);
    expect(Object.values(api)).not.toContain(h.send);
  });

  it("analyzeRepo forwards only the path to its fixed channel", async () => {
    h.invoke.mockClear();
    await (api.analyzeRepo as (...args: unknown[]) => Promise<unknown>)("C:\\repo", { limits: { maxDepth: 999 } }, "extra");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("analyze-repo", "C:\\repo");
  });

  it("cancelRepoAnalysis sends no arguments to its fixed channel", async () => {
    h.invoke.mockClear();
    await (api.cancelRepoAnalysis as (...args: unknown[]) => Promise<unknown>)("some-scan-id", "C:\\other");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("cancel-repo-analysis");
  });

  it("no exposed method can reach an arbitrary channel", async () => {
    h.invoke.mockClear();
    for (const [name, fn] of Object.entries(api)) {
      if (name === "onLog" || name === "onStatus") continue;
      await (fn as (...args: unknown[]) => Promise<unknown>)("execute-command", "rm -rf /");
    }
    const channels = h.invoke.mock.calls.map((call) => (call as unknown[])[0]);
    expect(channels).not.toContain("execute-command");
    expect(channels.every((c) => typeof c === "string" && /^[a-z-]+$/.test(c as string))).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("an ordinary launch exposes no credential or AI method, whatever similar switches appear", () => {
    expect(Object.keys(api).filter((k) => /cred|key|secret|ai|config/i.test(k))).toEqual([]);
    const lookalike = loadPreload([...PRODUCTION_ARGV, "--reporunner-internal-credential-settings=0", "--REPORUNNER-INTERNAL-CREDENTIAL-SETTINGS"]);
    expect(Object.keys(lookalike).filter((k) => /cred|ai|config/i.test(k))).toEqual([]);
    // A packaged build's renderer gets the same argv as any ordinary launch: the main process never passes the switch there.
    const packaged = loadPreload(["C:\\Program Files\\RepoRunner\\RepoRunner.exe", "--type=renderer", "--enable-sandbox"]);
    expect(Object.keys(packaged).sort()).toEqual(Object.keys(api).sort());
  });
});

describe("internal credential methods (Stage 4C, only with the main process's switch)", () => {
  let internal: Record<string, unknown>;
  beforeAll(() => {
    internal = loadPreload([...PRODUCTION_ARGV, INTERNAL_SWITCH]);
  });
  const call = (name: string, ...args: unknown[]) => (internal[name] as (...a: unknown[]) => Promise<unknown>)(...args);

  it("adds exactly six methods to the same API (three credential, AI status, AI edit load/save), and no way to read a key", () => {
    expect(Object.keys(internal).filter((k) => !Object.keys(api).includes(k)).sort()).toEqual(["aiConfigEditLoad", "aiConfigEditSave", "aiConfigStatus", "credentialStatus", "removeCredential", "setCredential"]);
    // No other AI write, delete, reset or test method.
    expect(Object.keys(internal).filter((k) => /ai|config/i.test(k)).sort()).toEqual(["aiConfigEditLoad", "aiConfigEditSave", "aiConfigStatus"]);
    expect(Object.keys(internal)).not.toEqual(expect.arrayContaining(["getCredential"]));
    expect(Object.keys(internal).filter((k) => /get.*(cred|key|secret)/i.test(k))).toEqual([]);
    for (const name of ["credentialStatus", "setCredential", "removeCredential"]) expect(internal[name]).not.toBe(h.invoke);
  });

  it("each forwards exactly its fixed arguments to its one channel", async () => {
    h.invoke.mockClear();
    await call("credentialStatus", "byok-slot-1", "extra");
    await call("setCredential", "byok-slot-1", "rr-synthetic-preload-key", { remember: true }, "extra");
    await call("removeCredential", "byok-slot-1", { anything: true });
    expect(h.invoke.mock.calls).toEqual([
      ["credential-status", "byok-slot-1"],
      ["credential-set", "byok-slot-1", "rr-synthetic-preload-key", { remember: true }],
      ["credential-remove", "byok-slot-1"],
    ]);
  });

  it("can't be turned into a generic channel or a get", async () => {
    h.invoke.mockClear();
    await call("credentialStatus", "credential-get");
    await call("setCredential", "credential-get", "x", { remember: false });
    expect(h.invoke.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["credential-status", "credential-set"]);
  });

  it("aiConfigStatus (Stage 4I) forwards only its one channel, with no arguments", async () => {
    h.invoke.mockClear();
    await call("aiConfigStatus");
    await call("aiConfigStatus", "credential-get", { write: true }, undefined);
    expect(h.invoke.mock.calls).toEqual([["ai-config-status"], ["ai-config-status"]]);
    expect(internal.aiConfigStatus).not.toBe(h.invoke);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("aiConfigEditLoad (Stage 4L) sends no arguments; aiConfigEditSave sends exactly the document and the revision", async () => {
    h.invoke.mockClear();
    const doc = { format: "reporunner-ai-settings", version: 1, active: null, configs: [] };
    await call("aiConfigEditLoad");
    await call("aiConfigEditLoad", "ai-config-edit-save", { anything: true });
    await call("aiConfigEditSave", doc, null);
    await call("aiConfigEditSave", doc, "a".repeat(64), "extra", { more: true });
    expect(h.invoke.mock.calls).toEqual([
      ["ai-config-edit-load"],
      ["ai-config-edit-load"],
      ["ai-config-edit-save", doc, null],
      ["ai-config-edit-save", doc, "a".repeat(64)],
    ]);
    for (const name of ["aiConfigEditLoad", "aiConfigEditSave"]) expect(internal[name]).not.toBe(h.invoke);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("main.ts and preload.cts use the same switch", () => {
    const features = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/internalFeatures.ts"), "utf8");
    expect(features).toContain(`INTERNAL_CREDENTIAL_SETTINGS_SWITCH = "${INTERNAL_SWITCH}"`);
  });
});
