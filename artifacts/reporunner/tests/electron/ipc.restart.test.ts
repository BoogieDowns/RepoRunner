// Exercises the real "restart-all" and "stop-services" IPC handlers with all
// process and port operations mocked. Nothing on the host can be terminated.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trustedRenderer } from "./fakeSender.js";

type TreeKillCallback = (error?: Error) => void;
type Handler = (event?: unknown, ...args: unknown[]) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  treeKill: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn(),
  exec: vi.fn(),
  isPortInUse: vi.fn(),
  waitUntilPortIsFree: vi.fn(),
  waitUntilPortIsReachable: vi.fn(),
  findListeningPids: vi.fn(),
  loadProject: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
  dialog: {},
  clipboard: { writeText: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));
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
  parsePortFromUrl: () => null,
}));
vi.mock("../../electron/projectStore.js", () => ({
  loadProject: h.loadProject,
  loadProjectState: () => ({ profiles: [], activeProfileId: null }),
  saveProject: () => {},
  setActiveProject: () => {},
  deleteProject: () => {},
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
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

const PROFILE = {
  id: "p1",
  name: "Demo",
  repoPath: "C:\\repo",
  installCommand: "npm install",
  frontendCommand: "npm run dev",
  backendCommand: "npm start",
  previewUrl: "http://localhost:3000",
  frontendPort: 3000,
  backendPort: 3001,
};

const realPlatform = process.platform;
let children: Map<number, FakeChild>;
let nextPid: number;
let processManager: typeof import("../../electron/processManager.js");

const app = trustedRenderer();

function handler(channel: string): Handler {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  // Called as RepoRunner's own page, the only caller the handlers accept.
  return (...args: unknown[]) => (fn as Handler)(app.event(), ...args);
}

async function run<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(async () => {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  children = new Map();
  nextPid = 5000;
  h.handlers.clear();
  for (const fn of [h.treeKill, h.spawn, h.execFile, h.exec, h.isPortInUse, h.waitUntilPortIsFree, h.waitUntilPortIsReachable, h.findListeningPids, h.loadProject]) {
    fn.mockReset();
  }

  h.loadProject.mockReturnValue(PROFILE);
  h.spawn.mockImplementation(() => {
    const child = new FakeChild(nextPid++);
    children.set(child.pid, child);
    return child;
  });
  h.treeKill.mockImplementation((pid: number, _signal: string, cb: TreeKillCallback) => {
    children.get(pid)?.exit(1);
    cb();
  });
  h.isPortInUse.mockResolvedValue(false);
  h.waitUntilPortIsFree.mockResolvedValue(true);
  h.waitUntilPortIsReachable.mockResolvedValue(true);
  h.findListeningPids.mockResolvedValue([]);
  // Recorded, never executed; mimics `netstat | findstr` output so a legacy
  // port-based kill path would run far enough to issue taskkill (and fail).
  h.exec.mockImplementation((_command: string, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) =>
    cb(null, {
      stdout:
        "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       7001\r\n" +
        "  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       7002\r\n",
      stderr: "",
    }),
  );
  vi.spyOn(process, "kill").mockImplementation((() => {
    throw new Error("Test attempted to signal a real process");
  }) as typeof process.kill);

  vi.resetModules();
  processManager = await import("../../electron/processManager.js");
  const ipc = await import("../../electron/ipc.js");
  ipc.setupIpc(app.trust);
});

afterEach(() => {
  for (const [pid] of h.treeKill.mock.calls) {
    expect(children.has(pid)).toBe(true);
  }
  expect(h.exec).not.toHaveBeenCalled();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("Restart", () => {
  it("restarts tracked services, terminating only the previous tracked PIDs", async () => {
    await run(handler("start-backend")());
    await run(handler("start-frontend")());
    const original = [...children.keys()];
    expect(processManager.getStatuses()).toEqual({ frontend: "running", backend: "running" });

    await run(handler("restart-all")());

    expect(h.treeKill.mock.calls.map(([pid]) => pid).sort()).toEqual(original.sort());
    expect(h.spawn).toHaveBeenCalledTimes(4);
    expect(processManager.getStatuses()).toEqual({ frontend: "running", backend: "running" });
  });

  it("with both ports held by other applications, kills nothing and reports failed starts", async () => {
    h.isPortInUse.mockResolvedValue(true);
    h.waitUntilPortIsFree.mockResolvedValue(false);
    h.findListeningPids.mockImplementation(async (port: number) => [port === 3000 ? 7001 : 7002]);

    await run(handler("restart-all")());

    expect(h.exec.mock.calls.map(([command]) => String(command)).filter((c) => /taskkill|findstr/.test(c))).toEqual([]);
    expect(h.treeKill).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.waitUntilPortIsFree).not.toHaveBeenCalled();
    expect(processManager.getStatuses()).toEqual({ frontend: "failed", backend: "failed" });
  });

  it("when RepoRunner starts quitting mid-restart, the restart starts nothing new", async () => {
    await run(handler("start-backend")());
    await run(handler("start-frontend")());
    expect(h.spawn).toHaveBeenCalledTimes(2);

    const restart = handler("restart-all")();
    await vi.advanceTimersByTimeAsync(0); // restart is now stopping the old services
    const cleanup = processManager.stopTrackedServicesForShutdown();
    await run(restart);
    const result = await run(cleanup);

    expect(h.spawn).toHaveBeenCalledTimes(2); // no replacement services
    expect(result.outcome).toBe("stopped");
    expect(processManager.getStatuses()).toEqual({ frontend: "stopped", backend: "stopped" });
  });

  it("does not start over a tracked process whose termination could not be confirmed", async () => {
    await run(handler("start-frontend")());
    const [frontPid] = [...children.keys()];
    h.treeKill.mockImplementation((_pid: number, _signal: string, cb: TreeKillCallback) =>
      cb(new Error("Access is denied.")),
    );

    await run(handler("restart-all")());

    expect(h.treeKill.mock.calls.every(([pid]) => pid === frontPid)).toBe(true);
    // Backend had nothing tracked and started; frontend still owned by the old PID.
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(processManager.getStatuses().frontend).toBe("unknown");
  });
});

describe("Stop Engine IPC", () => {
  it("repeated Stop clicks with nothing tracked never kill and never wait on foreign ports", async () => {
    h.isPortInUse.mockResolvedValue(true);
    h.waitUntilPortIsFree.mockResolvedValue(false);
    h.findListeningPids.mockResolvedValue([8123]);

    await run(handler("stop-services")());
    await run(handler("stop-services")());

    expect(h.exec.mock.calls.map(([command]) => String(command)).filter((c) => /taskkill|findstr/.test(c))).toEqual([]);
    expect(h.treeKill).not.toHaveBeenCalled();
    expect(h.waitUntilPortIsFree).not.toHaveBeenCalled();
    expect(processManager.getStatuses()).toEqual({ frontend: "stopped", backend: "stopped" });
  });

  it("still stops tracked services when the saved setups can't be read", async () => {
    await run(handler("start-frontend")());
    const [frontPid] = [...children.keys()];
    h.loadProject.mockImplementation(() => {
      throw new Error("RepoRunner found a problem with your saved repo setups");
    });

    await run(handler("stop-services")());

    expect(h.treeKill.mock.calls.map(([pid]) => pid)).toEqual([frontPid]);
    expect(processManager.getStatuses()).toEqual({ frontend: "stopped", backend: "stopped" });
  });

  it("runs no command at all when the saved setups can't be read", async () => {
    h.loadProject.mockImplementation(() => {
      throw new Error("RepoRunner found a problem with your saved repo setups");
    });

    for (const channel of ["start-frontend", "start-backend", "restart-all", "run-install", "pull-latest", "open-preview"]) {
      // Attach the rejection handler before advancing timers, otherwise the
      // rejection is reported as unhandled.
      const refused = expect(handler(channel)()).rejects.toThrow("problem with your saved repo setups");
      await vi.runAllTimersAsync();
      await refused;
    }
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.treeKill).not.toHaveBeenCalled();
  });
});
