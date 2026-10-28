// Stage 4O: getTrackedServicePorts reports the ports RepoRunner's own services
// were started with, only while RepoRunner owns or may still hold them.
// Safety: every process operation is mocked (spawn, tree-kill, port checks,
// process.kill), so nothing on the host is started, scanned or terminated.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  treeKill: vi.fn(),
  spawn: vi.fn(),
  isPortInUse: vi.fn(),
  waitUntilPortIsFree: vi.fn(),
  waitUntilPortIsReachable: vi.fn(),
  findListeningPids: vi.fn(),
}));

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("tree-kill", () => ({ default: h.treeKill }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: h.spawn, execFile: vi.fn((_f, _a, _o, cb) => cb(new Error("not stubbed"))), exec: vi.fn() };
});
vi.mock("../../electron/portManager.js", () => ({
  isPortInUse: h.isPortInUse,
  waitUntilPortIsFree: h.waitUntilPortIsFree,
  waitUntilPortIsReachable: h.waitUntilPortIsReachable,
  findListeningPids: h.findListeningPids,
}));
vi.mock("../../electron/logSink.js", () => ({ emitLog: () => {}, clearLogs: () => {}, formatLogsForClipboard: () => "" }));

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(public pid: number) {
    super();
  }
  exit(code: number | null = 1) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    alive.delete(this.pid);
    this.emit("exit", code, null);
  }
}

let pm: typeof import("../../electron/processManager.js");
let alive: Set<number>;
const children = new Map<number, FakeChild>();
const realPlatform = process.platform;

async function run<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}
function child(pid: number) {
  const c = new FakeChild(pid);
  children.set(pid, c);
  alive.add(pid);
  h.spawn.mockReturnValueOnce(c);
  return c;
}

beforeEach(async () => {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  alive = new Set();
  children.clear();
  for (const f of Object.values(h)) f.mockReset();
  h.treeKill.mockImplementation((pid: number, _s: string, cb: (e?: Error) => void) => {
    children.get(pid)?.exit(1);
    cb();
  });
  h.isPortInUse.mockResolvedValue(false);
  h.waitUntilPortIsFree.mockResolvedValue(true);
  h.waitUntilPortIsReachable.mockResolvedValue(true);
  h.findListeningPids.mockResolvedValue([]);
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (signal !== 0) throw new Error(`real signal ${String(signal)} to ${pid}`);
    if (alive.has(pid)) return true;
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
  vi.resetModules();
  pm = await import("../../electron/processManager.js");
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("getTrackedServicePorts", () => {
  it("nothing started: no ports", () => {
    expect(pm.getTrackedServicePorts()).toEqual([]);
  });

  it("a running service's port, and only services that have one", async () => {
    child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 5173));
    child(1002);
    await run(pm.startService("backend", "npm run api", "C:\\repo"));
    expect(pm.getStatuses()).toEqual({ frontend: "running", backend: "running" });
    expect(pm.getTrackedServicePorts()).toEqual([5173]);
  });

  it("while starting (before the port is reachable) the port already counts", async () => {
    child(1001);
    h.waitUntilPortIsReachable.mockReturnValue(new Promise(() => {}));
    void pm.startService("frontend", "npm run dev", "C:\\repo", 3000);
    await vi.advanceTimersByTimeAsync(10);
    expect(pm.getStatuses().frontend).toBe("starting");
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
  });

  it("after Stop Engine: no ports", async () => {
    child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 3000));
    await run(pm.stopAllServices(3000));
    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(pm.getTrackedServicePorts()).toEqual([]);
  });

  it("a start refused because the port was already taken: not RepoRunner's, so not reported", async () => {
    h.isPortInUse.mockResolvedValue(true);
    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 3000));
    expect(pm.getStatuses().frontend).toBe("failed");
    expect(h.spawn).not.toHaveBeenCalled();
    expect(pm.getTrackedServicePorts()).toEqual([]);
  });

  it("exited but the port is still held (status unknown): still reported", async () => {
    const c = child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 3000));
    h.isPortInUse.mockResolvedValue(true);
    c.exit(0);
    await vi.runAllTimersAsync();
    expect(pm.getStatuses().frontend).toBe("unknown");
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
  });

  it("exited and the port was released: not reported", async () => {
    const c = child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 3000));
    c.exit(1);
    await vi.runAllTimersAsync();
    expect(pm.getStatuses().frontend).toBe("failed");
    expect(pm.getTrackedServicePorts()).toEqual([]);
  });

  it("is read-only: it never checks or scans a port", async () => {
    child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 3000));
    const calls = [h.isPortInUse, h.waitUntilPortIsFree, h.waitUntilPortIsReachable, h.findListeningPids].map((f) => f.mock.calls.length);
    pm.getTrackedServicePorts();
    pm.getTrackedServicePorts();
    expect([h.isPortInUse, h.waitUntilPortIsFree, h.waitUntilPortIsReachable, h.findListeningPids].map((f) => f.mock.calls.length)).toEqual(calls);
  });
});
