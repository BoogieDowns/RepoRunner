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

  it("Codex review: an orphaned port survives a refused restart and a Stop with nothing tracked, until it's seen free", async () => {
    const c = child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    h.isPortInUse.mockResolvedValue(true);
    c.exit(0);
    await vi.runAllTimersAsync();
    expect(pm.getStatuses().frontend).toBe("unknown");
    // Start again on the same port: refused (the port is still held), status failed; the port stays reported.
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    expect(pm.getStatuses().frontend).toBe("failed");
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
    // Stop Engine: nothing tracked, port still in use, status stopped; still reported.
    await run(pm.stopAllServices(3000));
    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
    // A later check finds it free: no longer reported.
    h.isPortInUse.mockResolvedValue(false);
    await run(pm.stopAllServices(3000));
    expect(pm.getTrackedServicePorts()).toEqual([]);
  });

  it("an orphaned port is also cleared by the next start's own check finding it free", async () => {
    const c = child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    h.isPortInUse.mockResolvedValue(true);
    c.exit(0);
    await vi.runAllTimersAsync();
    h.isPortInUse.mockResolvedValue(false);
    const next = child(1002);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    expect(pm.getTrackedServicePorts()).toEqual([3000]); // the new run's port
    next.exit(1);
    await vi.runAllTimersAsync();
    expect(pm.getTrackedServicePorts()).toEqual([]);
  });

  it("only the next start's own check (finding the port free) clears it, even if nothing checks the port again", async () => {
    const c = child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    h.isPortInUse.mockResolvedValue(true);
    c.exit(0);
    await vi.runAllTimersAsync();
    h.isPortInUse.mockResolvedValue(false);
    child(1002);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    // Stop without a configured port: no port check after stopping.
    await run(pm.stopAllServices());
    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(pm.getTrackedServicePorts()).toEqual([]);
  });

  it("a tracked stop that leaves the port held keeps it reported, even after the status settles", async () => {
    child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    h.waitUntilPortIsFree.mockResolvedValue(false);
    h.isPortInUse.mockResolvedValue(true);
    await run(pm.stopAllServices(3000));
    expect(pm.getStatuses().frontend).toBe("unknown");
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
    h.isPortInUse.mockResolvedValue(true);
    await run(pm.stopAllServices(3000));
    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
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

// Codex review of 670fb20: several orphaned ports per service, Stop racing the
// exit check, and the launch port versus an edited setup port. `held` is the
// set of ports the (mocked) port check reports as in use; deferred checks
// make the races deterministic, with no sleeps.
describe("port ownership across lifecycles", () => {
  let held: Set<number>;
  const sorted = () => [...pm.getTrackedServicePorts()].sort((a, b) => a - b);
  type Deferred = { port: number; resolve: (inUse: boolean) => void };
  let deferred: Deferred[] | null;

  beforeEach(() => {
    held = new Set();
    deferred = null;
    h.isPortInUse.mockImplementation((port: number) => {
      if (deferred) return new Promise<boolean>((resolve) => deferred!.push({ port, resolve }));
      return Promise.resolve(held.has(port));
    });
  });
  /** Starts `service` on `port`; the root then exits leaving an orphan holding the port. */
  async function orphan(service: "frontend" | "backend", pid: number, port: number) {
    const c = child(pid);
    await run(pm.startService(service, "npm run dev", "C:\repo", port));
    held.add(port);
    c.exit(0);
    await vi.runAllTimersAsync();
    return c;
  }

  it("1-2. orphans on 3000 and then 3001 both stay protected; a third run that exits cleanly removes nothing else", async () => {
    await orphan("frontend", 1001, 3000);
    await orphan("frontend", 1002, 3001);
    expect(sorted()).toEqual([3000, 3001]);
    const third = child(1003);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3002));
    expect(sorted()).toEqual([3000, 3001, 3002]);
    third.exit(1);
    await vi.runAllTimersAsync();
    expect(sorted()).toEqual([3000, 3001]);
  });

  it("3. repeated launches on the same port make one record", async () => {
    await orphan("frontend", 1001, 3000);
    held.delete(3000);
    await orphan("frontend", 1002, 3000);
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
  });

  it("4. Stop Engine while the exit check is still pending: protected throughout, and after", async () => {
    const c = child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    deferred = [];
    c.exit(0);
    // Recorded before any check has answered.
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
    const stopping = pm.stopAllServices(3000);
    await vi.advanceTimersByTimeAsync(10);
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
    // Every check (exit, stop, re-check) finds the orphan still there.
    while (deferred.length) {
      for (const d of deferred.splice(0)) d.resolve(true);
      await vi.advanceTimersByTimeAsync(10);
    }
    await stopping;
    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
  });

  it("5. a stale 'free' answer from an older run's check can't erase a newer run's record of the same port", async () => {
    const a = child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    deferred = [];
    a.exit(0); // check A pending
    const checkA = deferred.shift()!;
    deferred = null;
    // Stop Engine (status settles), then run B starts on 3000 (its own check finds it free) and exits leaving an orphan.
    await run(pm.stopAllServices(3000));
    await orphan("frontend", 1002, 3000);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
    // Run A's old check finally answers "free": it must not clear B's record.
    checkA.resolve(false);
    await vi.runAllTimersAsync();
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
  });

  it("6-7. the launch port is what counts: a setup edited to 4000 (held by something unrelated) is never claimed", async () => {
    child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
    held.add(4000); // unrelated
    // Stop Engine passes the edited setup's port (4000); the tree on 3000 exits and 3000 is free.
    h.waitUntilPortIsFree.mockResolvedValue(false);
    await run(pm.stopAllServices(4000));
    expect(pm.getTrackedServicePorts()).toEqual([]);
    expect(pm.getTrackedServicePorts()).not.toContain(4000);
  });

  it("8-9. a refused restart and a Stop with no tracked root keep every recorded port", async () => {
    await orphan("frontend", 1001, 3000);
    await orphan("frontend", 1002, 3001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3001));
    expect(pm.getStatuses().frontend).toBe("failed");
    expect(sorted()).toEqual([3000, 3001]);
    await run(pm.stopAllServices(3001));
    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(sorted()).toEqual([3000, 3001]);
  });

  it("10-11. a port leaves only after its own check finds it free; the others stay", async () => {
    await orphan("frontend", 1001, 3000);
    await orphan("frontend", 1002, 3001);
    held.delete(3000);
    // Freed, but nothing has checked it yet.
    expect(sorted()).toEqual([3000, 3001]);
    await run(pm.stopAllServices(3001)); // Stop re-checks this service's recorded ports one by one
    expect(sorted()).toEqual([3001]);
  });

  it("12. starting the service again on another port keeps the earlier record", async () => {
    await orphan("frontend", 1001, 3000);
    child(1002);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3005));
    expect(sorted()).toEqual([3000, 3005]);
  });

  it("13. frontend and backend records are independent", async () => {
    await orphan("frontend", 1001, 3000);
    await orphan("backend", 2001, 4000);
    held.delete(3000);
    held.delete(4000);
    await run(pm.stopService("backend", 4000)); // re-checks backend records only
    expect(sorted()).toEqual([3000]);
    await run(pm.stopService("frontend", 3000));
    expect(sorted()).toEqual([]);
  });

  it("14. active ports stay protected while running and while a stop is in progress", async () => {
    child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    h.treeKill.mockImplementation(() => {}); // the kill hasn't completed yet
    const stopping = pm.stopAllServices(3000);
    await vi.advanceTimersByTimeAsync(10);
    expect(pm.getStatuses().frontend).toBe("stopping");
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
    void stopping;
  });

  it("a start still checking its port claims nothing yet (an unrelated holder isn't treated as ours)", async () => {
    deferred = [];
    const starting = pm.startService("frontend", "npm run dev", "C:\repo", 5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(deferred.length).toBe(1);
    expect(pm.getTrackedServicePorts()).toEqual([]);
    deferred.shift()!.resolve(true); // held by something else: refused
    deferred = null;
    await run(starting);
    expect(pm.getStatuses().frontend).toBe("failed");
    expect(pm.getTrackedServicePorts()).toEqual([]);
  });

  it("an occupied port is never recorded just because a check found it in use", async () => {
    held.add(5000);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 5000)); // refused
    await run(pm.stopAllServices(5000)); // nothing tracked, port in use
    expect(pm.getTrackedServicePorts()).toEqual([]);
  });

  it("no checks while RepoRunner is quitting; the record stays", async () => {
    const c = child(1001);
    await run(pm.startService("frontend", "npm run dev", "C:\repo", 3000));
    pm.beginShutdown();
    h.isPortInUse.mockClear();
    held.add(3000);
    c.exit(0);
    await vi.runAllTimersAsync();
    expect(h.isPortInUse).not.toHaveBeenCalled();
    expect(pm.getTrackedServicePorts()).toEqual([3000]);
  });
});
