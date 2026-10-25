// Three-edition Stage 2: every IPC handler checks its caller first. Exercises
// the shared sender check with realistic window, webContents and frame
// stand-ins, and the real handler registrations in electron/ipc.ts, with
// every module that could have a side effect replaced by a spy.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const spies = {} as Record<string, ReturnType<typeof vi.fn>>;
  return {
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
    spies,
    spy: (name: string, impl?: (...args: never[]) => unknown) => (spies[name] = vi.fn(impl as never)),
    PROFILE: { id: "a", name: "Repo", repoPath: "C:\\secret\\repo", installCommand: "npm install", frontendCommand: "npm run dev", backendCommand: "", previewUrl: "http://localhost:5173", frontendPort: 5173 },
  };
});
const { PROFILE } = h;

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
  dialog: { showOpenDialog: h.spy("dialog.showOpenDialog", async () => ({ canceled: false, filePaths: ["C:\\picked"] })) },
  clipboard: { writeText: h.spy("clipboard.writeText") },
  shell: { openExternal: h.spy("shell.openExternal", async () => {}), showItemInFolder: h.spy("shell.showItemInFolder"), openPath: h.spy("shell.openPath", async () => "") },
  BrowserWindow: { fromWebContents: h.spy("BrowserWindow.fromWebContents", () => null), getFocusedWindow: () => null, getAllWindows: () => [] },
}));
vi.mock("child_process", () => ({ spawn: h.spy("child_process.spawn"), execFile: h.spy("child_process.execFile"), exec: h.spy("child_process.exec") }));
vi.mock("../../electron/projectStore.js", () => ({
  loadProject: h.spy("projectStore.loadProject", () => h.PROFILE),
  loadProjectState: h.spy("projectStore.loadProjectState", () => ({ profiles: [h.PROFILE], activeProfileId: "a", revision: null })),
  saveProject: h.spy("projectStore.saveProject"),
  setActiveProject: h.spy("projectStore.setActiveProject"),
  deleteProject: h.spy("projectStore.deleteProject"),
  inspectProjectStore: h.spy("projectStore.inspectProjectStore", () => ({ state: "ok" })),
  resolveProjectStoreIssue: h.spy("projectStore.resolveProjectStoreIssue"),
  getProjectStoreRevealTarget: h.spy("projectStore.getProjectStoreRevealTarget", () => ({ kind: "file", path: "C:\\secret\\store.json" })),
}));
vi.mock("../../electron/processManager.js", () => ({
  startService: h.spy("processManager.startService", async () => {}),
  stopAllServices: h.spy("processManager.stopAllServices", async () => {}),
  waitForServiceSettled: h.spy("processManager.waitForServiceSettled", async () => {}),
  getStatuses: h.spy("processManager.getStatuses", () => ({ frontend: "stopped", backend: "stopped" })),
}));
vi.mock("../../electron/commandUtils.js", () => ({
  prepareCommandForExecution: h.spy("commandUtils.prepareCommandForExecution", (c: string) => ({ kind: "shell", command: c })),
  sanitizeCommandInput: h.spy("commandUtils.sanitizeCommandInput", (c: string) => c),
  spawnPreparedCommand: h.spy("commandUtils.spawnPreparedCommand"),
}));
vi.mock("../../electron/logSink.js", () => ({
  emitLog: h.spy("logSink.emitLog"),
  clearLogs: h.spy("logSink.clearLogs"),
  formatLogsForClipboard: h.spy("logSink.formatLogsForClipboard", () => "logs"),
}));
vi.mock("../../electron/projectProfileValidation.js", async (original) => {
  const real = await original<typeof import("../../electron/projectProfileValidation.js")>();
  return {
    validateProjectProfileForSave: h.spy("validation.validateProjectProfileForSave", real.validateProjectProfileForSave as never),
    validateRepoPathDirectoryForSave: h.spy("validation.validateRepoPathDirectoryForSave", async () => {}),
  };
});

import { UNTRUSTED_SENDER_MESSAGE, isTrustedSender } from "../../electron/ipcTrust.js";
import { setupIpc } from "../../electron/ipc.js";
import { REPO_ANALYSIS_ERROR_MESSAGES } from "../../src/types.js";
import { DEV_URL, FakeContents, FakeFrame, FakeWindow, PACKAGED_URL, trustedRenderer } from "./fakeSender.js";

const GENERAL_CHANNELS = [
  "select-folder", "load-project", "load-project-state", "save-project", "set-active-project", "delete-project",
  "get-project-store-status", "resolve-project-store-issue", "reveal-project-store-file", "pull-latest", "run-install",
  "start-frontend", "start-backend", "stop-services", "restart-all", "open-preview", "copy-logs", "clear-logs", "get-statuses",
];
const ANALYSIS_CHANNELS = ["analyze-repo", "cancel-repo-analysis"];
const REV = "a".repeat(64);
/** Arguments each handler would accept from a trusted caller, so a refusal can only come from the sender check. */
const VALID_ARGS: Record<string, unknown[]> = {
  "save-project": [PROFILE, REV],
  "set-active-project": ["a", REV],
  "delete-project": ["a", REV],
  "resolve-project-store-issue": ["start-fresh", REV],
  "analyze-repo": ["C:\\secret\\repo"],
};

let app: ReturnType<typeof trustedRenderer>;
const sideEffects = () => Object.entries(h.spies).filter(([, f]) => f.mock.calls.length > 0).map(([n]) => n);

/** Calls that must be refused: other windows, frames, pages and broken states. */
function untrustedEvents() {
  const other = new FakeContents(PACKAGED_URL, 9, 1);
  const sub = new FakeFrame(PACKAGED_URL, 4, 2);
  sub.parent = app.contents.mainFrame;
  const elsewhere = new FakeContents("https://example.invalid/", 4, 1);
  return [
    ["another window showing the same page", { sender: other, senderFrame: other.mainFrame }],
    ["the main webContents with another window's frame", { sender: app.contents, senderFrame: other.mainFrame }],
    ["a subframe of the main window", { sender: app.contents, senderFrame: sub }],
    ["a frame with the main frame's ids but a different page", { sender: app.contents, senderFrame: new FakeFrame("https://example.invalid/", 4, 1) }],
    ["no senderFrame", { sender: app.contents, senderFrame: null }],
    ["no sender", { senderFrame: app.contents.mainFrame }],
    ["a webContents showing another page", { sender: elsewhere, senderFrame: elsewhere.mainFrame }],
    ["an empty event", {}],
  ] as Array<[string, unknown]>;
}

beforeEach(() => {
  h.handlers.clear();
  for (const f of Object.values(h.spies)) f.mockClear();
  app = trustedRenderer();
  setupIpc(app.trust);
});

describe("the shared sender check", () => {
  it("accepts RepoRunner's own page in the main window's top-level frame, packaged and in development", () => {
    expect(isTrustedSender(app.event() as never, app.trust)).toBe(true);
    const dev = trustedRenderer(DEV_URL);
    expect(isTrustedSender(dev.event() as never, dev.trust)).toBe(true);
  });

  it("packaged and development identities don't stand in for each other", () => {
    const dev = trustedRenderer(DEV_URL);
    expect(isTrustedSender(dev.event() as never, app.trust)).toBe(false);
    expect(isTrustedSender(app.event() as never, dev.trust)).toBe(false);
  });

  it.each([
    ["no trust information", (e: unknown) => isTrustedSender(e as never, undefined)],
  ])("refuses with %s", (_n, check) => {
    expect(check(app.event())).toBe(false);
  });

  it("refuses other windows, frames and pages, even with the same URL", () => {
    for (const [name, event] of untrustedEvents()) expect(isTrustedSender(event as never, app.trust), name).toBe(false);
  });

  it("refuses when the sender's page has navigated elsewhere, even though the frame looks right", () => {
    app.contents.url = "https://example.invalid/";
    expect(isTrustedSender(app.event() as never, app.trust)).toBe(false);
  });

  it("refuses malformed URLs", () => {
    app.contents.url = "not a url";
    app.contents.mainFrame.url = "not a url";
    expect(isTrustedSender(app.event() as never, app.trust)).toBe(false);
  });

  it("refuses destroyed or detached senders, destroyed or missing windows, and frames that throw", () => {
    app.contents.mainFrame.detached = true;
    expect(isTrustedSender(app.event() as never, app.trust)).toBe(false);
    app.contents.mainFrame.detached = false;
    app.contents.destroyed = true;
    expect(isTrustedSender(app.event() as never, app.trust)).toBe(false);
    app.contents.destroyed = false;
    app.window.current!.destroyed = true;
    expect(isTrustedSender(app.event() as never, app.trust)).toBe(false);
    app.window.current = null;
    expect(isTrustedSender(app.event() as never, app.trust)).toBe(false);
    app.window.current = new FakeWindow(app.contents);
    const stale = { sender: app.contents, get senderFrame(): never { throw new Error("Render frame was disposed"); } };
    expect(isTrustedSender(stale as never, app.trust)).toBe(false);
  });

  it("after a reload the same page is still trusted; after the window is replaced only the new one is", () => {
    app.contents.mainFrame = new FakeFrame(PACKAGED_URL, 4, 1);
    expect(isTrustedSender(app.event() as never, app.trust)).toBe(true);
    const old = app.event();
    const replacement = new FakeContents(PACKAGED_URL, 5, 1);
    app.window.current = new FakeWindow(replacement);
    expect(isTrustedSender(old as never, app.trust)).toBe(false);
    expect(isTrustedSender({ sender: replacement, senderFrame: replacement.mainFrame } as never, app.trust)).toBe(true);
  });
});

describe("every handler", () => {
  it("exactly the expected handlers are registered", () => {
    expect([...h.handlers.keys()].sort()).toEqual([...GENERAL_CHANNELS, ...ANALYSIS_CHANNELS].sort());
  });

  it("refuses every untrusted caller before anything happens, with a message that reveals nothing", async () => {
    for (const channel of h.handlers.keys()) {
      for (const [name, event] of untrustedEvents()) {
        const error = await h.handlers.get(channel)!(event, ...(VALID_ARGS[channel] ?? [])).then(() => null, (e: Error) => e);
        const expected = ANALYSIS_CHANNELS.includes(channel) ? REPO_ANALYSIS_ERROR_MESSAGES["not-allowed"] : UNTRUSTED_SENDER_MESSAGE;
        expect(error?.message, `${channel} / ${name}`).toBe(expected);
        expect(sideEffects(), `${channel} / ${name}`).toEqual([]);
      }
    }
  });

  it("refuses everything when no trust information was given", async () => {
    h.handlers.clear();
    setupIpc();
    for (const channel of h.handlers.keys()) {
      const error = await h.handlers.get(channel)!(app.event(), ...(VALID_ARGS[channel] ?? [])).then(() => null, (e: Error) => e);
      expect(error, channel).toBeInstanceOf(Error);
      expect(sideEffects(), channel).toEqual([]);
    }
  });

  it("the refusal message contains no paths, setups or state", () => {
    expect(UNTRUSTED_SENDER_MESSAGE).toBe("This request isn't allowed from this page.");
    expect(UNTRUSTED_SENDER_MESSAGE).not.toMatch(/[\\/:]|repo|setup|path|token|key/i);
  });
});

describe("trusted callers keep their behavior", () => {
  const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!(app.event(), ...args);

  it("reads, saves and validates as before", async () => {
    await expect(call("load-project-state")).resolves.toMatchObject({ activeProfileId: "a" });
    await expect(call("load-project")).resolves.toEqual(PROFILE);
    await call("save-project", PROFILE, REV);
    expect(h.spies["projectStore.saveProject"]).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), { expectedRevision: REV });
    // Argument validation still runs, after the sender check, with its own messages.
    await expect(call("set-active-project", "", REV)).rejects.toThrow("Saved repo setup not found.");
    await expect(call("resolve-project-store-issue", "delete-everything", REV)).rejects.toThrow("Unknown recovery action.");
    await expect(call("reveal-project-store-file", "C:\\Windows")).rejects.toThrow("Unexpected arguments.");
    await expect(call("save-project", { id: "" })).rejects.not.toThrow(UNTRUSTED_SENDER_MESSAGE);
  });

  it("runs, stops, opens and copies as before", async () => {
    await call("start-frontend");
    expect(h.spies["processManager.startService"]).toHaveBeenCalledWith("frontend", "npm run dev", PROFILE.repoPath, 5173);
    await call("stop-services");
    expect(h.spies["processManager.stopAllServices"]).toHaveBeenCalled();
    await call("open-preview");
    expect(h.spies["shell.openExternal"]).toHaveBeenCalledWith("http://localhost:5173");
    await call("copy-logs");
    expect(h.spies["clipboard.writeText"]).toHaveBeenCalledWith("logs");
    await expect(call("select-folder")).resolves.toBe("C:\\picked");
    await expect(call("get-statuses")).resolves.toEqual({ frontend: "stopped", backend: "stopped" });
    await call("clear-logs");
    expect(h.spies["logSink.clearLogs"]).toHaveBeenCalled();
  });
});

describe("source structure", () => {
  it("ipc.ts registers handlers only through the guard, and the guard checks before calling the handler", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/ipc.ts"), "utf8");
    expect(source.match(/ipcMain\.(handle|handleOnce|on|once)\(/g)).toEqual(["ipcMain.handle("]);
    const guard = /ipcMain\.handle\(channel, async \(event, \.\.\.args: unknown\[\]\) => \{\s*if \(!isTrustedSender\(event, trustedRenderer\)\) throw untrustedSenderError\(\);\s*return listener\(event, \.\.\.args\);\s*\}\);/;
    expect(source).toMatch(guard);
    expect(source.match(/^ {2}handle\("/gm)).toHaveLength(GENERAL_CHANNELS.length);
  });

  it("no other main-process file registers IPC handlers", () => {
    const dir = path.resolve(import.meta.dirname, "../../electron");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const registering = files.filter((f) => /ipcMain\.(handle|handleOnce|on|once)\(/.test(fs.readFileSync(path.join(dir, f), "utf8")));
    expect(registering.sort()).toEqual(["ipc.ts", "repoAnalysisIpc.ts"]);
  });
});
