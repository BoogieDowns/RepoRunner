// App-exit cleanup in the process manager. Every process operation is
// mocked: tree-kill, spawn, execFile and process.kill are replaced, and
// process.kill throws on any real signal, so nothing on the host can be
// terminated.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TreeKillCallback = (error?: Error) => void;

const h = vi.hoisted(() => ({
  treeKill: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn(),
  exec: vi.fn(),
  isPortInUse: vi.fn(),
  waitUntilPortIsFree: vi.fn(),
  waitUntilPortIsReachable: vi.fn(),
  findListeningPids: vi.fn(),
  logs: [] as Array<{ source: string; text: string }>,
  failLog: null as RegExp | null,
  windows: [] as unknown[],
}));

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => h.windows } }));
vi.mock("tree-kill", () => ({ default: h.treeKill }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: h.spawn, execFile: h.execFile, exec: h.exec };
});
vi.mock("../../electron/portManager.js", () => ({
  isPortInUse: h.isPortInUse,
  waitUntilPortIsFree: h.waitUntilPortIsFree,
  waitUntilPortIsReachable: h.waitUntilPortIsReachable,
  findListeningPids: h.findListeningPids,
}));
vi.mock("../../electron/logSink.js", () => ({
  emitLog: (source: string, text: string) => {
    if (h.failLog?.test(text)) throw new Error("simulated failure");
    h.logs.push({ source, text });
  },
  clearLogs: () => {},
  formatLogsForClipboard: () => "",
}));

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  constructor(public pid: number) {
    super();
  }

  exit(code: number | null = 1) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

type ProcessManager = typeof import("../../electron/processManager.js");

const realPlatform = process.platform;
let children: Map<number, FakeChild>;
let pm: ProcessManager;

function treeKillKillsTree(pid: number, _signal: string, cb: TreeKillCallback) {
  children.get(pid)?.exit(1);
  cb();
}

async function run<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

const logText = () => h.logs.map((entry) => entry.text).join("\n");

async function startTracked(service: "frontend" | "backend", pid: number, port: number | undefined = 3000) {
  const child = new FakeChild(pid);
  children.set(pid, child);
  h.spawn.mockReturnValueOnce(child);
  await run(pm.startService(service, "npm run dev", "C:\\repo", port));
  return child;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  children = new Map();
  h.logs.length = 0;
  h.failLog = null;
  h.windows = [];
  for (const fn of [h.treeKill, h.spawn, h.execFile, h.exec, h.isPortInUse, h.waitUntilPortIsFree, h.waitUntilPortIsReachable, h.findListeningPids]) {
    fn.mockReset();
  }
  h.treeKill.mockImplementation(treeKillKillsTree);
  h.isPortInUse.mockResolvedValue(false);
  h.waitUntilPortIsFree.mockResolvedValue(true);
  h.waitUntilPortIsReachable.mockResolvedValue(true);
  h.findListeningPids.mockResolvedValue([]);
  h.execFile.mockImplementation((_f, _a, _o, cb) => cb(new Error("execFile not stubbed")));
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    throw new Error(`Test attempted to signal real PID ${pid} (${String(signal)})`);
  }) as typeof process.kill);

  vi.resetModules();
  pm = await import("../../electron/processManager.js");
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });

  // Only tracked fixtures may ever be targeted, and never by port.
  const tracked = new Set(children.keys());
  for (const [pid] of h.treeKill.mock.calls) expect(tracked.has(pid)).toBe(true);
  expect(h.exec).not.toHaveBeenCalled();
  for (const [file] of h.execFile.mock.calls) expect(["taskkill", "kill", "lsof", "netstat"]).not.toContain(file);
});

describe("shutdown state", () => {
  it("has a 15-second deadline", () => {
    expect(pm.SHUTDOWN_DEADLINE_MS).toBe(15000);
  });

  it("beginShutdown blocks every new start, is repeatable and is never reset", async () => {
    pm.beginShutdown();
    pm.beginShutdown();
    expect(pm.isShuttingDown()).toBe(true);

    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 3000));
    await run(pm.startService("backend", "npm start", "C:\\repo"));
    await run(pm.stopTrackedServicesForShutdown());

    expect(h.spawn).not.toHaveBeenCalled();
    expect(pm.isShuttingDown()).toBe(true);
    expect(logText()).toMatch(/RepoRunner is closing, so frontend was not started/);
  });

  it("reports whether quitting has to wait", async () => {
    expect(pm.hasTrackedServiceWork()).toBe(false);
    await startTracked("frontend", 1001);
    expect(pm.hasTrackedServiceWork()).toBe(true);
  });
});

describe("stopping tracked services at exit", () => {
  it("nothing tracked: finishes at once without killing anything", async () => {
    const result = await run(pm.stopTrackedServicesForShutdown());

    expect(result).toMatchObject({ outcome: "stopped", remainingPids: [], unverifiedServices: [] });
    expect(h.treeKill).not.toHaveBeenCalled();
  });

  it.each([
    ["frontend only", ["frontend"]],
    ["backend only", ["backend"]],
    ["both services", ["frontend", "backend"]],
  ] as const)("%s: stops exactly the tracked trees", async (_label, services) => {
    const started = [];
    for (const [i, service] of services.entries()) started.push(await startTracked(service, 2000 + i));

    const result = await run(pm.stopTrackedServicesForShutdown());

    expect(result.outcome).toBe("stopped");
    expect(h.treeKill.mock.calls.map(([pid]) => pid).sort()).toEqual(started.map((c) => c.pid).sort());
    expect(started.every((c) => c.exitCode !== null)).toBe(true);
    expect(pm.getStatuses()).toEqual({ frontend: "stopped", backend: "stopped" });
  });

  it("never uses ports to decide what to stop", async () => {
    await startTracked("frontend", 1001, 3000);
    h.isPortInUse.mockClear();

    await run(pm.stopTrackedServicesForShutdown());

    expect(h.isPortInUse).not.toHaveBeenCalled();
    expect(h.waitUntilPortIsFree).not.toHaveBeenCalled();
    expect(h.findListeningPids).not.toHaveBeenCalled();
  });

  it("an already-exited tracked process is not killed", async () => {
    const child = await startTracked("frontend", 1001, undefined);
    child.exit(0);

    const result = await run(pm.stopTrackedServicesForShutdown());

    expect(result.outcome).toBe("stopped");
    expect(h.treeKill).not.toHaveBeenCalled();
  });

  it("repeated calls share one cleanup", async () => {
    await startTracked("frontend", 1001);

    const first = pm.stopTrackedServicesForShutdown();
    const second = pm.stopTrackedServicesForShutdown();
    expect(second).toBe(first);
    await run(first);

    expect(h.treeKill).toHaveBeenCalledTimes(1);
  });

  it("logging and status updates are safe when the window is already destroyed", async () => {
    const send = vi.fn();
    h.windows = [{ isDestroyed: () => true, webContents: { isDestroyed: () => true, send } }];
    await startTracked("frontend", 1001);

    const result = await run(pm.stopTrackedServicesForShutdown());

    expect(result.outcome).toBe("stopped");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("starts, stops and restarts during shutdown", () => {
  it("a start waiting on its port check never spawns once shutdown begins", async () => {
    const portCheck = deferred<boolean>();
    h.isPortInUse.mockReturnValueOnce(portCheck.promise);

    const starting = pm.startService("frontend", "npm run dev", "C:\\repo", 3000);
    pm.beginShutdown(); // only the flag: the pre-spawn check alone must stop it
    portCheck.resolve(false);
    await run(starting);

    expect(h.spawn).not.toHaveBeenCalled();
    expect(logText()).toMatch(/RepoRunner is closing, so frontend was not started/);
  });

  it("a start waiting on its port check is cancelled by the cleanup", async () => {
    const portCheck = deferred<boolean>();
    h.isPortInUse.mockReturnValueOnce(portCheck.promise);
    const starting = pm.startService("frontend", "npm run dev", "C:\\repo", 3000);
    expect(pm.hasTrackedServiceWork()).toBe(true);

    const cleanup = pm.stopTrackedServicesForShutdown();
    portCheck.resolve(false);
    await run(starting);
    const result = await run(cleanup);

    expect(h.spawn).not.toHaveBeenCalled();
    expect(result.outcome).toBe("stopped");
  });

  it("a start waiting for readiness is stopped and never reported as running", async () => {
    const ready = deferred<boolean>();
    h.waitUntilPortIsReachable.mockReturnValueOnce(ready.promise);
    const child = new FakeChild(1001);
    children.set(1001, child);
    h.spawn.mockReturnValueOnce(child);
    const starting = pm.startService("frontend", "npm run dev", "C:\\repo", 3000);
    await vi.advanceTimersByTimeAsync(0);

    const result = await run(pm.stopTrackedServicesForShutdown());
    ready.resolve(true);
    await run(starting);

    expect(result.outcome).toBe("stopped");
    expect(child.exitCode).not.toBeNull();
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("a Stop already in progress is reused, not duplicated", async () => {
    const child = await startTracked("frontend", 1001);
    let finishKill!: () => void;
    h.treeKill.mockImplementationOnce((pid: number, _s: string, cb: TreeKillCallback) => {
      finishKill = () => {
        children.get(pid)?.exit(1);
        cb();
      };
    });
    const userStop = pm.stopService("frontend", 3000);
    await vi.advanceTimersByTimeAsync(0);

    const cleanup = pm.stopTrackedServicesForShutdown();
    finishKill();
    await run(userStop);
    const result = await run(cleanup);

    expect(h.treeKill).toHaveBeenCalledTimes(1);
    expect(child.exitCode).not.toBeNull();
    expect(result.outcome).toBe("stopped");
  });

  it("a restart in progress can't start anything after shutdown begins", async () => {
    await startTracked("frontend", 1001);
    const restart = (async () => {
      await pm.stopAllServices(3000, undefined);
      await new Promise((r) => setTimeout(r, 500));
      await pm.startService("frontend", "npm run dev", "C:\\repo", 3000);
    })();
    await vi.advanceTimersByTimeAsync(0);

    const cleanup = pm.stopTrackedServicesForShutdown();
    await run(restart);
    await run(cleanup);

    expect(h.spawn).toHaveBeenCalledTimes(1); // only the original start
  });
});

describe("stubborn processes and the deadline", () => {
  it("retries once for a root that survives the first stop", async () => {
    const child = await startTracked("frontend", 1001);
    let attempts = 0;
    h.treeKill.mockImplementation((pid: number, _s: string, cb: TreeKillCallback) => {
      attempts++;
      if (attempts <= 2) return cb(new Error("Access is denied.")); // first Stop: both attempts fail
      treeKillKillsTree(pid, _s, cb);
    });

    const result = await run(pm.stopTrackedServicesForShutdown());

    expect(logText()).toMatch(/Retrying stop for frontend before RepoRunner closes/);
    expect(h.treeKill.mock.calls.every(([pid]) => pid === child.pid)).toBe(true);
    expect(result).toMatchObject({ outcome: "stopped", remainingPids: [] });
  });

  it("a root that never dies: the retry starts, the 15 s deadline ends cleanup, and the PID is reported", async () => {
    await startTracked("frontend", 1001);
    h.treeKill.mockImplementation((_pid: number, _s: string, cb: TreeKillCallback) => cb(new Error("Access is denied.")));

    // Each Stop waits 5 s + 3 s for the root, so the retry can't finish in 15 s.
    const result = await run(pm.stopTrackedServicesForShutdown());

    expect(result).toMatchObject({ outcome: "timed-out", remainingPids: [1001], durationMs: 15_000 });
    expect(h.treeKill.mock.calls.length).toBeGreaterThanOrEqual(3); // first Stop's two attempts + the retry
    expect(h.treeKill.mock.calls.every(([pid]) => pid === 1001)).toBe(true);
    expect(logText()).toMatch(/could not confirm that tracked process 1001 stopped/);
  });

  it("with time for the retry to finish, a surviving root is reported as remaining", async () => {
    await startTracked("frontend", 1001);
    h.treeKill.mockImplementation((_pid: number, _s: string, cb: TreeKillCallback) => cb(new Error("Access is denied.")));

    const result = await run(pm.stopTrackedServicesForShutdown(60_000));

    expect(result).toMatchObject({ outcome: "processes-remain", remainingPids: [1001] });
    expect(h.treeKill).toHaveBeenCalledTimes(4); // two attempts per Stop, one retry Stop
  });

  it("a tree whose children can't be confirmed gone is reported as possibly remaining", async () => {
    await startTracked("frontend", 1001);
    h.treeKill.mockImplementation((pid: number, _s: string, cb: TreeKillCallback) => {
      children.get(pid)?.exit(1);
      cb(new Error("ERROR: child process could not be terminated."));
    });

    const result = await run(pm.stopTrackedServicesForShutdown());

    expect(result).toMatchObject({ outcome: "processes-remain", remainingPids: [], unverifiedServices: ["frontend"] });
  });

  it("a kill helper that never returns: cleanup ends at the 15 s deadline as timed-out", async () => {
    await startTracked("frontend", 1001);
    h.treeKill.mockImplementation(() => {
      // never calls back
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const cleanup = pm.stopTrackedServicesForShutdown();
      let settled = false;
      void cleanup.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await cleanup;

      expect(result.outcome).toBe("timed-out");
      expect(result.remainingPids).toEqual([1001]);
      expect(result.durationMs).toBe(15_000);

      // The abandoned stop keeps running in the background without errors.
      await vi.runAllTimersAsync();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a cleanup that finishes early releases its deadline timer", async () => {
    await startTracked("frontend", 1001);
    expect(vi.getTimerCount()).toBe(0);

    // Let the cleanup finish without moving the clock, so a leftover deadline
    // timer would still be pending (runAllTimers would fire it and hide it).
    const cleanup = pm.stopTrackedServicesForShutdown();
    await vi.advanceTimersByTimeAsync(0);
    const result = await cleanup;

    expect(result.outcome).toBe("stopped");
    expect(result.durationMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // no 15 s timer left behind
  });

  it("an unexpected failure is reported as an error, never as stopped", async () => {
    await startTracked("frontend", 1001);
    h.failLog = /^Stopping frontend/;

    const result = await run(pm.stopTrackedServicesForShutdown());

    expect(result.outcome).toBe("error");
  });
});
