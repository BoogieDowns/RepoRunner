// Quit lifecycle of the Electron entry point (idle → cleaning-up → complete).
// Electron, IPC and the process manager are mocked; app.quit() is modelled
// like Electron: it emits "before-quit" and only exits if that isn't
// prevented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

const h = vi.hoisted(() => {
  class FakeWindow {
    static instances: FakeWindow[] = [];
    minimized = false;
    destroyed = false;
    restore = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    loadFile = vi.fn();
    loadURL = vi.fn();
    webContents = { on: vi.fn() };
    private listeners = new Map<string, Listener>();
    constructor() {
      FakeWindow.instances.push(this);
    }
    isMinimized() {
      return this.minimized;
    }
    isVisible() {
      return true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    on(event: string, listener: Listener) {
      this.listeners.set(event, listener);
    }
    close() {
      this.destroyed = true;
      this.listeners.get("closed")?.();
    }
    static getAllWindows() {
      return FakeWindow.instances.filter((w) => !w.destroyed);
    }
  }

  const appListeners = new Map<string, Listener[]>();
  const state = { exited: 0, ready: false };

  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of appListeners.get(event) ?? []) listener(...args);
  };

  const quit = vi.fn(() => {
    let prevented = false;
    emit("before-quit", { preventDefault: () => (prevented = true) });
    if (!prevented) state.exited++;
  });

  let shuttingDown = false;
  return {
    FakeWindow,
    appListeners,
    emit,
    quit,
    state,
    pm: {
      beginShutdown: vi.fn(() => {
        shuttingDown = true;
      }),
      isShuttingDown: vi.fn(() => shuttingDown),
      hasTrackedServiceWork: vi.fn(() => false),
      stopTrackedServicesForShutdown: vi.fn(),
      reset() {
        shuttingDown = false;
      },
    },
  };
});

vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: () => true,
    quit: h.quit,
    on: (event: string, listener: Listener) => {
      h.appListeners.set(event, [...(h.appListeners.get(event) ?? []), listener]);
    },
    whenReady: () => Promise.resolve().then(() => {
      h.state.ready = true;
    }),
    isReady: () => h.state.ready,
    getAppPath: () => "C:\\app",
  },
  BrowserWindow: h.FakeWindow,
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  session: { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } },
}));
vi.mock("../../electron/ipc.js", () => ({ setupIpc: vi.fn() }));
vi.mock("../../electron/processManager.js", () => h.pm);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const STOPPED = { outcome: "stopped", remainingPids: [], unverifiedServices: [], durationMs: 5 };

async function startApp() {
  vi.resetModules();
  await import("../../electron/main.js");
  await flush();
  return h.FakeWindow.instances[0];
}

/** Closes the only window the way the X button does: closed → window-all-closed. */
function closeWindow(window: InstanceType<typeof h.FakeWindow>) {
  window.close();
  h.emit("window-all-closed");
}

beforeEach(() => {
  h.FakeWindow.instances = [];
  h.appListeners.clear();
  h.state.exited = 0;
  h.state.ready = false;
  h.quit.mockClear();
  h.pm.reset();
  h.pm.beginShutdown.mockClear();
  h.pm.hasTrackedServiceWork.mockReset().mockReturnValue(false);
  h.pm.stopTrackedServicesForShutdown.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("quitting with nothing to clean up", () => {
  it("exits immediately but still blocks new starts", async () => {
    const window = await startApp();

    closeWindow(window);

    expect(h.pm.beginShutdown).toHaveBeenCalled();
    expect(h.pm.stopTrackedServicesForShutdown).not.toHaveBeenCalled();
    expect(h.state.exited).toBe(1);
  });
});

describe("quitting with tracked services", () => {
  it("window close: waits for one cleanup, then exits exactly once", async () => {
    const window = await startApp();
    h.pm.hasTrackedServiceWork.mockReturnValue(true);
    const cleanup = deferred<typeof STOPPED>();
    h.pm.stopTrackedServicesForShutdown.mockReturnValue(cleanup.promise);

    closeWindow(window);

    expect(h.pm.beginShutdown).toHaveBeenCalled();
    expect(h.pm.stopTrackedServicesForShutdown).toHaveBeenCalledTimes(1);
    expect(h.state.exited).toBe(0); // quit held while cleaning up

    cleanup.resolve(STOPPED);
    await flush();

    expect(h.state.exited).toBe(1);
    expect(h.quit).toHaveBeenCalledTimes(2); // the original request + the final quit
  });

  it("quit while the window is open (menu, Alt+F4 on the app): window stays until cleanup ends", async () => {
    const window = await startApp();
    h.pm.hasTrackedServiceWork.mockReturnValue(true);
    const cleanup = deferred<typeof STOPPED>();
    h.pm.stopTrackedServicesForShutdown.mockReturnValue(cleanup.promise);

    h.quit();

    expect(window.isDestroyed()).toBe(false);
    expect(h.state.exited).toBe(0);
    cleanup.resolve(STOPPED);
    await flush();
    expect(h.state.exited).toBe(1);
  });

  it("repeated quit requests during cleanup are held and start nothing new", async () => {
    const window = await startApp();
    h.pm.hasTrackedServiceWork.mockReturnValue(true);
    const cleanup = deferred<typeof STOPPED>();
    h.pm.stopTrackedServicesForShutdown.mockReturnValue(cleanup.promise);

    closeWindow(window);
    h.quit();
    h.quit();
    h.emit("window-all-closed");

    expect(h.pm.stopTrackedServicesForShutdown).toHaveBeenCalledTimes(1);
    expect(h.state.exited).toBe(0);

    cleanup.resolve(STOPPED);
    await flush();
    expect(h.state.exited).toBe(1);
  });

  it.each([
    ["timed out", { outcome: "timed-out", remainingPids: [4242], unverifiedServices: [], durationMs: 15000 }],
    ["left processes", { outcome: "processes-remain", remainingPids: [], unverifiedServices: ["frontend"], durationMs: 9000 }],
    ["errored", { outcome: "error", remainingPids: [], unverifiedServices: [], durationMs: 10 }],
  ])("cleanup that %s still lets the app exit, and says so", async (_label, result) => {
    const window = await startApp();
    h.pm.hasTrackedServiceWork.mockReturnValue(true);
    h.pm.stopTrackedServicesForShutdown.mockResolvedValue(result);

    closeWindow(window);
    await flush();

    expect(h.state.exited).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`RepoRunner exit cleanup: ${result.outcome}`));
  });

  it("a rejected cleanup still lets the app exit", async () => {
    const window = await startApp();
    h.pm.hasTrackedServiceWork.mockReturnValue(true);
    h.pm.stopTrackedServicesForShutdown.mockRejectedValue(new Error("boom"));

    closeWindow(window);
    await flush();

    expect(h.state.exited).toBe(1);
  });
});

describe("no windows while shutting down", () => {
  it("a second launch during cleanup doesn't create or show a window", async () => {
    const window = await startApp();
    h.pm.hasTrackedServiceWork.mockReturnValue(true);
    h.pm.stopTrackedServicesForShutdown.mockReturnValue(new Promise(() => {}));

    closeWindow(window);
    h.emit("second-instance", {}, [], "C:\\");
    h.emit("activate");

    expect(h.FakeWindow.instances).toHaveLength(1);
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("before quitting, a second launch still focuses the window as usual", async () => {
    const window = await startApp();

    h.emit("second-instance", {}, [], "C:\\");

    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(h.pm.beginShutdown).not.toHaveBeenCalled();
  });
});
