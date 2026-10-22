// Safety: every process operation in this file is mocked. tree-kill, spawn,
// execFile and process.kill are replaced, and process.kill throws on any real
// signal, so these tests cannot terminate anything on the host machine.
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
}));

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
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
  emitLog: (source: string, text: string) => h.logs.push({ source, text }),
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

  exit(code: number | null = 1, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

type ProcessManager = typeof import("../../electron/processManager.js");

const realPlatform = process.platform;
let children: Map<number, FakeChild>;
let alivePids: Set<number>;
let pm: ProcessManager;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Default tree-kill: the tracked tree dies cleanly. */
function treeKillKillsTree(pid: number, _signal: string, cb: TreeKillCallback) {
  children.get(pid)?.exit(1);
  cb();
}

async function run<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

function logText(): string {
  return h.logs.map((entry) => entry.text).join("\n");
}

async function startTracked(
  service: "frontend" | "backend" = "frontend",
  pid = 1001,
  port: number | undefined = 3000,
): Promise<FakeChild> {
  const child = new FakeChild(pid);
  children.set(pid, child);
  h.spawn.mockReturnValueOnce(child);
  await run(pm.startService(service, "npm run dev", "C:\\repo", port));
  return child;
}

beforeEach(async () => {
  vi.useFakeTimers();
  setPlatform("win32");
  children = new Map();
  alivePids = new Set();
  h.logs.length = 0;

  for (const fn of [
    h.treeKill,
    h.spawn,
    h.execFile,
    h.exec,
    h.isPortInUse,
    h.waitUntilPortIsFree,
    h.waitUntilPortIsReachable,
    h.findListeningPids,
  ]) {
    fn.mockReset();
  }

  h.treeKill.mockImplementation(treeKillKillsTree);
  h.isPortInUse.mockResolvedValue(false);
  h.waitUntilPortIsFree.mockResolvedValue(true);
  h.waitUntilPortIsReachable.mockResolvedValue(true);
  h.findListeningPids.mockResolvedValue([]);
  h.execFile.mockImplementation((_f, _a, _o, cb) => cb(new Error("execFile not stubbed for this test")));
  // Recorded, never executed. Answers like `netstat | findstr` would, so any
  // legacy port-based kill path runs far enough to reveal itself.
  h.exec.mockImplementation((_command: string, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       999\r\n", stderr: "" }),
  );

  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (signal !== 0) throw new Error(`Test attempted to send real signal ${String(signal)} to PID ${pid}`);
    if (alivePids.has(pid)) return true;
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);

  vi.resetModules();
  pm = await import("../../electron/processManager.js");
});

afterEach(() => {
  // Global safety invariants for every test in this file.
  const trackedPids = new Set(children.keys());
  for (const [pid] of h.treeKill.mock.calls) {
    expect(trackedPids.has(pid)).toBe(true);
  }
  expect(h.exec).not.toHaveBeenCalled();
  for (const [file] of h.execFile.mock.calls) {
    expect(["taskkill", "kill", "lsof"]).not.toContain(file);
  }

  vi.useRealTimers();
  setPlatform(realPlatform);
});

describe("Windows normal shutdown", () => {
  it("terminates only the tracked process tree and reports stopped", async () => {
    const child = await startTracked();
    expect(pm.getStatuses().frontend).toBe("running");

    await run(pm.stopService("frontend", 3000));

    expect(h.treeKill).toHaveBeenCalledTimes(1);
    expect(h.treeKill).toHaveBeenCalledWith(child.pid, "SIGTERM", expect.any(Function));
    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(h.findListeningPids).not.toHaveBeenCalled();
    expect(logText()).toContain("frontend stopped.");
  });

  it("stops both services with stopAllServices", async () => {
    const front = await startTracked("frontend", 1001, 3000);
    const back = await startTracked("backend", 2002, 3001);

    await run(pm.stopAllServices(3000, 3001));

    expect(h.treeKill.mock.calls.map(([pid]) => pid).sort()).toEqual([front.pid, back.pid].sort());
    expect(pm.getStatuses()).toEqual({ frontend: "stopped", backend: "stopped" });
  });
});

describe("unrelated port ownership", () => {
  it("never kills the port holder when RepoRunner tracks no process (the original bug)", async () => {
    h.isPortInUse.mockResolvedValue(true);
    h.waitUntilPortIsFree.mockResolvedValue(false); // the foreign app keeps the port
    h.findListeningPids.mockResolvedValue([999]);

    await run(pm.stopService("frontend", 3000));

    const shellCommands = h.exec.mock.calls.map(([command]) => String(command));
    expect(shellCommands.filter((command) => /taskkill|findstr|kill -/.test(command))).toEqual([]);
    expect(h.treeKill).not.toHaveBeenCalled();
    expect(h.waitUntilPortIsFree).not.toHaveBeenCalled(); // no 8 s wait for a port we don't own
    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(logText()).toMatch(/Port 3000 is in use by PID 999, but RepoRunner is not tracking a frontend process, so nothing was stopped/);
  });

  it("start refused because the port is busy, then Stop: nothing is killed", async () => {
    h.isPortInUse.mockResolvedValue(true);
    h.findListeningPids.mockResolvedValue([4444]);

    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 3000));
    expect(h.spawn).not.toHaveBeenCalled();
    expect(pm.getStatuses().frontend).toBe("failed");

    await run(pm.stopService("frontend", 3000));

    expect(h.treeKill).not.toHaveBeenCalled();
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("port still held after the tracked tree is gone: reports unknown, never kills the holder", async () => {
    const child = await startTracked();
    h.waitUntilPortIsFree.mockResolvedValue(false);
    h.findListeningPids.mockResolvedValue([4242]);

    await run(pm.stopService("frontend", 3000));

    expect(h.treeKill).toHaveBeenCalledTimes(1);
    expect(h.treeKill.mock.calls[0][0]).toBe(child.pid);
    expect(pm.getStatuses().frontend).toBe("unknown");
    expect(logText()).toMatch(/Port 3000 is still in use by PID 4242 after stopping frontend\. .*left running/);

    // Repeated Stop: nothing is tracked any more, so the port is only reported.
    h.isPortInUse.mockResolvedValue(true);
    await run(pm.stopService("frontend", 3000));

    expect(h.treeKill).toHaveBeenCalledTimes(1);
    expect(pm.getStatuses().frontend).toBe("stopped");
  });
});

describe("tracked process already exited", () => {
  it("does not call tree-kill for a dead root and does not treat the port holder as ours", async () => {
    const child = await startTracked();
    child.exit(1);
    await vi.runAllTimersAsync();
    expect(pm.getStatuses().frontend).toBe("failed");

    h.isPortInUse.mockResolvedValue(false);
    await run(pm.stopService("frontend", 3000));

    expect(h.treeKill).not.toHaveBeenCalled();
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("a port opened by something else after the tracked root exited is not reported as running", async () => {
    const child = new FakeChild(1001);
    children.set(1001, child);
    h.spawn.mockReturnValueOnce(child);
    let resolveReady: (ready: boolean) => void = () => {};
    h.waitUntilPortIsReachable.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolveReady = resolve)),
    );

    const starting = pm.startService("frontend", "launcher-that-detaches", "C:\\repo", 3000);
    await vi.advanceTimersByTimeAsync(0);

    // Launcher exits; a detached server it left behind holds the port.
    h.isPortInUse.mockResolvedValue(true);
    child.exit(0);
    resolveReady(true);
    await run(starting);

    expect(pm.getStatuses().frontend).toBe("unknown");
    expect(logText()).toMatch(/exited before becoming ready/);
    expect(logText()).not.toMatch(/is ready on port 3000/);
  });

  it("root exit with the port still held is reported as unknown, not stopped", async () => {
    const child = await startTracked();
    h.isPortInUse.mockResolvedValue(true);

    child.exit(0);
    await vi.runAllTimersAsync();

    expect(pm.getStatuses().frontend).toBe("unknown");
    expect(logText()).toMatch(/process exited, but port 3000 is still in use/);
    expect(h.treeKill).not.toHaveBeenCalled();
  });
});

describe("failed termination and retry", () => {
  it("keeps ownership when the tracked root survives, refuses Start, and retries on the same PID", async () => {
    const child = await startTracked();
    h.treeKill.mockImplementation((_pid: number, _signal: string, cb: TreeKillCallback) =>
      cb(new Error("Access is denied.")),
    );

    await run(pm.stopService("frontend", 3000));

    expect(h.treeKill).toHaveBeenCalledTimes(2); // initial attempt + one retry
    expect(pm.getStatuses().frontend).toBe("unknown");
    expect(logText()).toMatch(/Could not confirm that frontend \(PID 1001\) stopped\. RepoRunner is still tracking it/);
    expect(h.findListeningPids).not.toHaveBeenCalled();

    // Start is refused while the old tracked process may still be alive.
    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 3000));
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(logText()).toMatch(/still tracking a running frontend process \(PID 1001\)/);

    // Retry succeeds against the retained identity.
    h.treeKill.mockImplementation(treeKillKillsTree);
    await run(pm.stopService("frontend", 3000));

    expect(h.treeKill).toHaveBeenCalledTimes(3);
    expect(h.treeKill.mock.calls.every(([pid]) => pid === child.pid)).toBe(true);
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("a tree-kill helper that never calls back is bounded: Stop finishes and ownership is kept", async () => {
    const child = await startTracked();
    h.treeKill.mockImplementation(() => {
      // never invokes its callback (simulates a hung taskkill)
    });

    await run(pm.stopService("frontend", 3000));

    expect(pm.getStatuses().frontend).toBe("unknown");
    expect(logText()).toMatch(/did not finish within 10 seconds/);
    expect(logText()).toMatch(/still tracking it/);

    // The Stop lock was released, so a retry runs (and succeeds) on the same PID.
    h.treeKill.mockImplementation(treeKillKillsTree);
    await run(pm.stopService("frontend", 3000));
    expect(h.treeKill.mock.calls.every(([pid]) => pid === child.pid)).toBe(true);
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("Windows: root exited but taskkill reported an error, so the tree is unverified (unknown)", async () => {
    await startTracked();
    h.treeKill.mockImplementation((pid: number, _signal: string, cb: TreeKillCallback) => {
      children.get(pid)?.exit(1);
      cb(new Error("ERROR: The process with PID 1500 (child process of PID 1001) could not be terminated."));
    });

    await run(pm.stopService("frontend", 3000));

    expect(pm.getStatuses().frontend).toBe("unknown");
    expect(logText()).toMatch(/could not confirm that all of its child processes exited/);
  });
});

describe("lifecycle races", () => {
  it("rejects Start while Stop is in progress and keeps the stop authoritative", async () => {
    const child = await startTracked();
    let finishKill: TreeKillCallback = () => {};
    h.treeKill.mockImplementation((_pid: number, _signal: string, cb: TreeKillCallback) => {
      finishKill = (error) => {
        child.exit(1);
        cb(error);
      };
    });

    const stopping = pm.stopService("frontend", 3000);
    await vi.advanceTimersByTimeAsync(0);
    expect(pm.getStatuses().frontend).toBe("stopping");

    // Advance no time while the kill is pending (the tree-kill timeout must not fire).
    const refusedStart = pm.startService("frontend", "npm run dev", "C:\\repo", 3000);
    await vi.advanceTimersByTimeAsync(0);
    await refusedStart;
    expect(h.spawn).toHaveBeenCalledTimes(1); // no second spawn
    expect(logText()).toMatch(/frontend is stopping\. Wait for it to stop/);

    finishKill();
    await run(stopping);
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("concurrent Stop calls share one operation (repeated Stop)", async () => {
    await startTracked();
    let finishKill: TreeKillCallback = () => {};
    h.treeKill.mockImplementation((pid: number, _signal: string, cb: TreeKillCallback) => {
      finishKill = (error) => {
        children.get(pid)?.exit(1);
        cb(error);
      };
    });

    const first = pm.stopService("frontend", 3000);
    await vi.advanceTimersByTimeAsync(0);
    const second = pm.stopService("frontend", 3000);
    expect(second).toBe(first);

    finishKill();
    await run(Promise.all([first, second]));
    expect(h.treeKill).toHaveBeenCalledTimes(1);
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("Stop during a Start's port check cancels the start before anything is spawned", async () => {
    let resolvePortCheck: (inUse: boolean) => void = () => {};
    h.isPortInUse.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolvePortCheck = resolve)),
    );

    const starting = pm.startService("frontend", "npm run dev", "C:\\repo", 3000);
    await vi.advanceTimersByTimeAsync(0);

    // A second Start while the first is still checking the port is rejected.
    await run(pm.startService("frontend", "npm run dev", "C:\\repo", 3000));
    expect(logText()).toMatch(/frontend is already running or starting/);

    const stopping = pm.stopService("frontend", 3000);
    resolvePortCheck(false);
    await run(Promise.all([starting, stopping]));

    expect(h.spawn).not.toHaveBeenCalled();
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("stale events from a replaced process cannot change the new run's status", async () => {
    const first = await startTracked("frontend", 1001);
    await run(pm.stopService("frontend", 3000));
    const second = await startTracked("frontend", 1002);
    expect(pm.getStatuses().frontend).toBe("running");

    first.emit("error", new Error("late error from old process"));
    first.emit("exit", 1, null);
    await vi.runAllTimersAsync();

    expect(pm.getStatuses().frontend).toBe("running");

    await run(pm.stopService("frontend", 3000));
    expect(h.treeKill.mock.calls.map(([pid]) => pid)).toEqual([first.pid, second.pid]);
  });

  it("Stop while a start is waiting for readiness terminates the tracked process", async () => {
    const child = new FakeChild(1001);
    children.set(1001, child);
    h.spawn.mockReturnValueOnce(child);
    let resolveReady: (ready: boolean) => void = () => {};
    h.waitUntilPortIsReachable.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (resolveReady = resolve)),
    );

    const starting = pm.startService("frontend", "npm run dev", "C:\\repo", 3000);
    await vi.advanceTimersByTimeAsync(0);
    expect(pm.getStatuses().frontend).toBe("starting");

    await run(pm.stopService("frontend", 3000));
    resolveReady(true); // late readiness must not flip status back to running
    await run(starting);

    expect(h.treeKill).toHaveBeenCalledWith(1001, "SIGTERM", expect.any(Function));
    expect(pm.getStatuses().frontend).toBe("stopped");
  });
});

describe("POSIX termination", () => {
  function stubPs(lines: string) {
    h.execFile.mockImplementation((file: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
      if (file === "ps") cb(null, { stdout: lines, stderr: "" });
      else cb(new Error(`unexpected execFile ${file}`));
    });
  }

  it("verifies snapshotted descendants are gone before reporting stopped", async () => {
    setPlatform("linux");
    const child = await startTracked();
    alivePids = new Set([child.pid, 1500, 1501]);
    stubPs(`  1 0\n ${child.pid} 1\n 1500 ${child.pid}\n 1501 1500\n 900 1\n`);
    h.treeKill.mockImplementation((pid: number, _signal: string, cb: TreeKillCallback) => {
      alivePids.clear();
      children.get(pid)?.exit(null, "SIGTERM");
      cb();
    });

    await run(pm.stopService("frontend", 3000));

    expect(h.execFile).toHaveBeenCalledWith("ps", ["-A", "-o", "pid=,ppid="], expect.anything(), expect.any(Function));
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("reports surviving descendants as unknown and does not signal them", async () => {
    setPlatform("linux");
    const child = await startTracked();
    alivePids = new Set([1500]);
    stubPs(` ${child.pid} 1\n 1500 ${child.pid}\n`);

    await run(pm.stopService("frontend", 3000));

    expect(pm.getStatuses().frontend).toBe("unknown");
    expect(logText()).toMatch(/child processes are still running \(PID 1500\)\. RepoRunner did not force-stop them/);
    // process.kill is only ever used with signal 0 (enforced by the spy).
  });

  it("escalates to SIGKILL on the same tracked tree when SIGTERM is ignored", async () => {
    setPlatform("linux");
    const child = await startTracked();
    stubPs(` ${child.pid} 1\n`);
    h.treeKill.mockImplementation((pid: number, signal: string, cb: TreeKillCallback) => {
      if (signal === "SIGKILL") children.get(pid)?.exit(null, "SIGKILL");
      cb();
    });

    await run(pm.stopService("frontend", 3000));

    expect(h.treeKill.mock.calls.map(([pid, signal]) => [pid, signal])).toEqual([
      [child.pid, "SIGTERM"],
      [child.pid, "SIGKILL"],
    ]);
    expect(pm.getStatuses().frontend).toBe("stopped");
  });

  it("without a process snapshot, root exit alone is not treated as proof", async () => {
    setPlatform("linux");
    await startTracked();
    // ps unavailable → no snapshot
    h.execFile.mockImplementation((_f, _a, _o, cb) => cb(new Error("ps not found")));

    await run(pm.stopService("frontend", 3000));

    expect(pm.getStatuses().frontend).toBe("unknown");
  });
});
