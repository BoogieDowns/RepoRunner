// A request that arrives while a cancelled scan is still finishing waits (at
// most 2 s) as a "pending" request. It must be abandonable during that wait
// and must never start a scan once abandoned. The finishing scan is held open
// with a gate on one opendir call, so nothing really hangs.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
}));

import { RepoAnalysisService, registerRepoAnalysisIpc, type TrustedRenderer } from "../../electron/repoAnalysisIpc.js";
import { createRepoAnalysisController, type AnalysisCoordinator, type RepoAnalysisState } from "../../src/lib/repoAnalysis.js";
import { REPO_ANALYSIS_ERROR_MESSAGES, type RepoScanResult } from "../../src/types.js";
import { FixtureSpace, pkg } from "./repoScanner/fixtures.js";

const APP_URL = pathToFileURL(path.join(os.tmpdir(), "RepoRunner App", "dist", "public", "index.html")).href;
const LIFECYCLE = ["destroyed", "render-process-gone", "did-start-navigation"];

class FakeFrame {
  detached = false;
  parent: FakeFrame | null = null;
  processId = 4;
  routingId = 1;
  constructor(public url: string) {}
}
class FakeContents extends EventEmitter {
  destroyed = false;
  mainFrame = new FakeFrame(APP_URL);
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return APP_URL;
  }
}

let space: FixtureSpace;
let repo: string;
let other: string;
let contents: FakeContents;
let service: RepoAnalysisService;
const trust: TrustedRenderer = { getMainWindow: () => ({ webContents: contents, isDestroyed: () => false }) as never, appPageUrl: () => APP_URL };
const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
const analyze = (p: string) => h.handlers.get("analyze-repo")!(event(), p) as Promise<RepoScanResult>;
const cancel = () => h.handlers.get("cancel-repo-analysis")!(event()) as Promise<void>;
const settle = <T>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null as T | null, error }));
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms)));
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

/**
 * Holds the first opendir of `target` (the previous scan) until released, and
 * tracks overlap. holdAlso() gates the first listing of another path too
 * (always calling the real opendir, never the spy itself).
 */
function holdPreviousScan(target: string) {
  const opendir = fs.promises.opendir;
  const stats = { calls: [] as string[], now: 0, max: 0 };
  const extraGates = new Map<string, Promise<void>>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  let held = false;
  vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    stats.calls.push(path.resolve(String(p)));
    stats.max = Math.max(stats.max, ++stats.now);
    try {
      const resolved = path.resolve(String(p));
      if (!held && resolved === target) {
        held = true;
        enter();
        await gate;
      }
      const extra = extraGates.get(resolved);
      if (extra) {
        extraGates.delete(resolved);
        await extra;
      }
      return await (opendir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    } finally {
      stats.now--;
    }
  }) as never);
  const holdAlso = (other: string) => {
    let releaseOther!: () => void;
    extraGates.set(other, new Promise<void>((resolve) => (releaseOther = resolve)));
    return () => releaseOther();
  };
  return { stats, entered, release, holdAlso };
}

/** Starts scan A, cancels it while its opendir is held: the session is then "finishing". */
async function finishingPreviousScan() {
  const hold = holdPreviousScan(path.join(repo, "sub"));
  const first = analyze(repo);
  await hold.entered;
  await cancel();
  expect((await within(first, 1000)).status).toBe("cancelled");
  expect(service.isScanning).toBe(true);
  return hold;
}

/**
 * Starts request B and resolves once it is pending in the main process. The
 * promise is wrapped: returning it directly would make this wait for B to end.
 */
async function pendingRequest() {
  const second = settle(analyze(other));
  await vi.waitFor(() => expect(service.hasPendingRequest).toBe(true), { timeout: 1000, interval: 2 });
  return { second };
}

const expectNotStarted = (result: RepoScanResult | null) => {
  expect(result).toMatchObject({ status: "cancelled", partial: true, rootName: "other repo", packages: [], stats: { directoriesVisited: 0, filesRead: 0 } });
};

beforeAll(() => {
  space = new FixtureSpace();
  repo = space.repo("previous repo", { "package.json": pkg({ name: "prev" }), "sub/package.json": pkg({ name: "sub" }) });
  other = space.repo("other repo", { "package.json": pkg({ name: "other" }) });
});
afterAll(() => space.cleanup());

let unhandled: unknown[];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  h.handlers.clear();
  contents = new FakeContents();
  service = new RepoAnalysisService();
  registerRepoAnalysisIpc(trust, service);
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await vi.waitFor(() => expect(service.isScanning).toBe(false), { timeout: 3000, interval: 5 });
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
  for (const name of LIFECYCLE) expect(contents.listenerCount(name), name).toBe(0);
});

describe("abandoning a pending request", () => {
  it("Cancel during the wait answers at once and never starts a scan, even after the previous scan finishes", async () => {
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    const callsBefore = hold.stats.calls.length;

    await cancel();
    const { value, error } = await within(second, 500);
    expect(error).toBeNull();
    expectNotStarted(value);
    expect(service.hasPendingRequest).toBe(false);

    hold.release();
    await vi.waitFor(() => expect(service.isScanning).toBe(false), { timeout: 2000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hold.stats.calls.slice(callsBefore).filter((p) => p.startsWith(other))).toEqual([]); // B never listed anything
    expect(hold.stats.max).toBe(1);
  });

  it.each([
    ["renderer destroyed", (c: FakeContents) => { c.destroyed = true; c.emit("destroyed"); }],
    ["renderer crashed", (c: FakeContents) => c.emit("render-process-gone", {}, { reason: "crashed" })],
    ["main-frame reload", (c: FakeContents) => c.emit("did-start-navigation", { url: APP_URL, isMainFrame: true, isSameDocument: false })],
    ["main-frame navigation", (c: FakeContents) => c.emit("did-start-navigation", { url: "https://example.com/", isMainFrame: true, isSameDocument: false })],
  ])("%s during the wait abandons it", async (_label, trigger) => {
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    trigger(contents);
    const { value } = await within(second, 500);
    expectNotStarted(value);
    hold.release();
    await vi.waitFor(() => expect(service.isScanning).toBe(false), { timeout: 2000, interval: 5 });
    expect(hold.stats.calls.filter((p) => p.startsWith(other))).toEqual([]);
  });

  it("same-document and sub-frame navigations don't abandon it; it then runs normally", async () => {
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    contents.emit("did-start-navigation", { url: `${APP_URL}#x`, isMainFrame: true, isSameDocument: true });
    contents.emit("did-start-navigation", { url: "https://ads.example/", isMainFrame: false, isSameDocument: false });
    expect(service.hasPendingRequest).toBe(true);
    hold.release();
    const { value } = await within(second, 2000);
    expect(value).toMatchObject({ status: "complete", rootName: "other repo" });
    expect(hold.stats.max).toBe(1);
  });

  it("quitting during the wait refuses it at once", async () => {
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    service.shutdown();
    const { error } = await within(second, 500);
    expect(error?.message).toBe(REPO_ANALYSIS_ERROR_MESSAGES.unavailable);
    hold.release();
  });
});

describe("the pending -> active transition", () => {
  it("cancel in the same tick as the previous scan finishing: nothing starts", async () => {
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    hold.release();
    void cancel(); // same tick: the idle notification hasn't been delivered yet
    const { value } = await within(second, 1000);
    expectNotStarted(value);
    expect(hold.stats.max).toBe(1);
  });

  it("cancel just after it became active aborts the scan it started (never a second one)", async () => {
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    // Hold B's first listing so it is observably active.
    const slowSecond = hold.holdAlso(other);
    hold.release();
    await vi.waitFor(() => expect(service.hasPendingRequest).toBe(false), { timeout: 2000, interval: 1 });
    await cancel();
    const { value } = await within(second, 500);
    expect(value).toMatchObject({ status: "cancelled", rootName: "other repo" });
    slowSecond();
  });

  it("the wait is bounded: a previous scan that stays blocked makes it fail clearly after ~2 s, timer cleared", async () => {
    const before = timers();
    const hold = await finishingPreviousScan();
    const started = Date.now();
    const { error } = await within(settle(analyze(other)), 5000);
    expect(error?.message).toBe(REPO_ANALYSIS_ERROR_MESSAGES["scan-in-progress"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(service.hasPendingRequest).toBe(false);
    hold.release();
    await vi.waitFor(() => expect(service.isScanning).toBe(false), { timeout: 2000, interval: 5 });
    expect(timers()).toBeLessThanOrEqual(before); // nothing left behind by this request
  }, 15_000);

  it("an abandoned wait clears its timer at once", async () => {
    const before = timers();
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    await cancel();
    await second;
    hold.release();
    await vi.waitFor(() => expect(service.isScanning).toBe(false), { timeout: 2000, interval: 5 });
    expect(timers()).toBeLessThanOrEqual(before); // nothing left behind by this request
  });

  it("a new request after an abandoned one runs normally", async () => {
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    await cancel();
    expectNotStarted((await second).value);
    hold.release();
    vi.restoreAllMocks();
    await expect(analyze(other)).resolves.toMatchObject({ status: "complete", rootName: "other repo" });
  });

  it("stale lifecycle callbacks from an abandoned request can't cancel a later one", async () => {
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    const stale = LIFECYCLE.flatMap((name) => contents.listeners(name) as Array<(...a: unknown[]) => void>);
    expect(stale).toHaveLength(3);
    await cancel();
    await second;
    hold.release();
    await vi.waitFor(() => expect(service.isScanning).toBe(false), { timeout: 2000, interval: 5 });

    const releaseThird = hold.holdAlso(other);
    const third = analyze(other);
    await vi.waitFor(() => expect(service.isScanning).toBe(true));
    for (const listener of stale) listener({ isMainFrame: true, isSameDocument: false });
    releaseThird();
    await expect(third).resolves.toMatchObject({ status: "complete" });
  });

  it("only one request at a time: a second request while one is pending is refused", async () => {
    const hold = await finishingPreviousScan();
    const { second } = await pendingRequest();
    const started = Date.now();
    const { error } = await within(settle(analyze(other)), 1000);
    expect(error?.message).toBe(REPO_ANALYSIS_ERROR_MESSAGES["scan-in-progress"]);
    expect(Date.now() - started).toBeLessThan(300); // refused at once, not after waiting
    expect(service.hasPendingRequest).toBe(true); // the first pending request is untouched
    await cancel();
    expectNotStarted((await within(second, 500)).value); // and Cancel still reaches it
    hold.release();
  });
});

describe("renderer actions reach a pending request (controller -> IPC)", () => {
  function bridge() {
    const states: RepoAnalysisState[] = [];
    const coordinator: AnalysisCoordinator = { active: null };
    const api = { analyzeRepo: (p: string) => analyze(p), cancelRepoAnalysis: () => cancel() };
    const controller = createRepoAnalysisController(() => api as never, (s) => states.push(s), coordinator);
    return { controller, states };
  }

  it("changing the path while the request is pending abandons it", async () => {
    const hold = await finishingPreviousScan();
    const { controller } = bridge();
    const started = controller.start(other);
    await vi.waitFor(() => expect(service.hasPendingRequest).toBe(true), { timeout: 1000, interval: 2 });
    controller.pathChanged(path.join(other, "elsewhere"));
    await vi.waitFor(() => expect(service.hasPendingRequest).toBe(false), { timeout: 500, interval: 2 });
    await started;
    expect(controller.state).toEqual({ phase: "idle" });
    hold.release();
    await vi.waitFor(() => expect(service.isScanning).toBe(false), { timeout: 2000, interval: 5 });
    expect(hold.stats.calls.filter((p) => p.startsWith(other))).toEqual([]);
  });

  it("unmounting Setup while the request is pending abandons it", async () => {
    const hold = await finishingPreviousScan();
    const { controller, states } = bridge();
    const started = controller.start(other);
    await vi.waitFor(() => expect(service.hasPendingRequest).toBe(true), { timeout: 1000, interval: 2 });
    const reported = states.length;
    controller.dispose();
    await vi.waitFor(() => expect(service.hasPendingRequest).toBe(false), { timeout: 500, interval: 2 });
    await started;
    expect(states.length).toBe(reported);
    hold.release();
    await vi.waitFor(() => expect(service.isScanning).toBe(false), { timeout: 2000, interval: 5 });
    expect(hold.stats.calls.filter((p) => p.startsWith(other))).toEqual([]);
  });

  it("Cancel in the UI while pending shows 'cancelled'", async () => {
    const hold = await finishingPreviousScan();
    const { controller } = bridge();
    const started = controller.start(other);
    await vi.waitFor(() => expect(service.hasPendingRequest).toBe(true), { timeout: 1000, interval: 2 });
    controller.cancel();
    await within(started, 500);
    expect(controller.state).toMatchObject({ phase: "done", result: { status: "cancelled", partial: true } });
    hold.release();
  });
});
