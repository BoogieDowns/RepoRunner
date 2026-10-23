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

let api: Record<string, unknown>;
beforeAll(() => {
  // Vitest doesn't load .cts files, so the real preload source is compiled
  // to CommonJS (as the build does) and run with a require that only knows
  // "electron".
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/preload.cts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const fakeRequire = (id: string) => {
    if (id === "electron") return fakeElectron;
    throw new Error(`preload must not require ${id}`);
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", outputText)(fakeRequire, module, module.exports);
  api = h.exposed.get("repoRunner")!;
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
});
