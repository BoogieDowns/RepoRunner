// Single-instance behaviour of the Electron entry point, with Electron fully
// mocked. The real IPC module is loaded so that "no handlers registered"
// proves a second instance can't reach storage or services.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

const h = vi.hoisted(() => {
  class FakeWindow {
    static instances: FakeWindow[] = [];
    minimized = false;
    visible = true;
    destroyed = false;
    restore = vi.fn(() => {
      this.minimized = false;
    });
    show = vi.fn(() => {
      this.visible = true;
    });
    focus = vi.fn();
    loadFile = vi.fn();
    loadURL = vi.fn();
    webContents = { on: vi.fn() };
    private listeners = new Map<string, Listener>();
    constructor(public options: unknown) {
      FakeWindow.instances.push(this);
    }
    isMinimized() {
      return this.minimized;
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    on(event: string, listener: Listener) {
      this.listeners.set(event, listener);
    }
    emit(event: string) {
      this.listeners.get(event)?.();
    }
    static getAllWindows() {
      return FakeWindow.instances.filter((w) => !w.destroyed);
    }
  }

  const appListeners = new Map<string, Listener[]>();
  let resolveReady: () => void = () => {};
  let ready = false;

  return {
    FakeWindow,
    appListeners,
    lock: true,
    ready: () => ready,
    makeReady: () => {
      ready = true;
      resolveReady();
    },
    resetReady: () => {
      ready = false;
      return new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
    },
    whenReadyPromise: Promise.resolve() as Promise<void>,
    ipcHandle: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn(() => {
      throw new Error("a second instance must not touch user data");
    }),
  };
});

vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: () => h.lock,
    quit: h.quit,
    on: (event: string, listener: Listener) => {
      h.appListeners.set(event, [...(h.appListeners.get(event) ?? []), listener]);
    },
    whenReady: () => h.whenReadyPromise,
    isReady: () => h.ready(),
    getAppPath: () => "C:\\app",
    getPath: h.getPath,
  },
  BrowserWindow: h.FakeWindow,
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  session: { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } },
  ipcMain: { handle: h.ipcHandle },
  dialog: {},
  clipboard: { writeText: () => {} },
  shell: {},
}));

function emitApp(event: string) {
  for (const listener of h.appListeners.get(event) ?? []) listener({}, ["RepoRunner.exe"], "C:\\");
}

async function loadMain() {
  vi.resetModules();
  await import("../../electron/main.js");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.FakeWindow.instances = [];
  h.appListeners.clear();
  h.ipcHandle.mockClear();
  h.quit.mockClear();
  h.getPath.mockClear();
  h.lock = true;
  h.whenReadyPromise = h.resetReady();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("first instance", () => {
  it("obtains the lock and initialises normally: IPC, one window", async () => {
    await loadMain();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.FakeWindow.instances).toHaveLength(0); // nothing before ready

    h.makeReady();
    await flush();

    expect(h.ipcHandle).toHaveBeenCalled();
    expect(h.FakeWindow.instances).toHaveLength(1);
    expect(h.appListeners.has("second-instance")).toBe(true);
  });
});

describe("second instance", () => {
  it("fails to get the lock and quits without IPC, storage, services or a window", async () => {
    h.lock = false;

    await loadMain();
    h.makeReady();
    await flush();

    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(h.FakeWindow.instances).toHaveLength(0);
    expect(h.ipcHandle).not.toHaveBeenCalled(); // no save/start/stop handlers exist
    expect(h.getPath).not.toHaveBeenCalled(); // saved setups never located or read
    expect(h.appListeners.has("second-instance")).toBe(false);
    expect(h.appListeners.has("window-all-closed")).toBe(false);
  });
});

describe("when another launch is attempted", () => {
  async function startFirstInstance() {
    await loadMain();
    h.makeReady();
    await flush();
    return h.FakeWindow.instances[0];
  }

  it("focuses the existing window without creating another", async () => {
    const window = await startFirstInstance();

    emitApp("second-instance");

    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.restore).not.toHaveBeenCalled();
    expect(h.FakeWindow.instances).toHaveLength(1);
  });

  it("restores a minimized window, then focuses it", async () => {
    const window = await startFirstInstance();
    window.minimized = true;

    emitApp("second-instance");

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.restore.mock.invocationCallOrder[0]).toBeLessThan(window.focus.mock.invocationCallOrder[0]);
  });

  it("shows a hidden window", async () => {
    const window = await startFirstInstance();
    window.visible = false;

    emitApp("second-instance");

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("before the first window is ready: no crash, no extra window, then exactly one window", async () => {
    await loadMain();

    expect(() => emitApp("second-instance")).not.toThrow();
    expect(() => emitApp("second-instance")).not.toThrow();
    expect(h.FakeWindow.instances).toHaveLength(0);

    h.makeReady();
    await flush();
    expect(h.FakeWindow.instances).toHaveLength(1);
  });

  it("does not touch a destroyed window or create a duplicate while windows still exist", async () => {
    const window = await startFirstInstance();
    window.destroyed = true;
    // Another live window (e.g. during teardown) means no new window is needed.
    new h.FakeWindow({});

    expect(() => emitApp("second-instance")).not.toThrow();
    expect(window.focus).not.toHaveBeenCalled();
    expect(h.FakeWindow.instances).toHaveLength(2);
  });

  it("repeated launches never multiply windows or IPC registration", async () => {
    const window = await startFirstInstance();
    const handlersAfterStartup = h.ipcHandle.mock.calls.length;

    for (let i = 0; i < 5; i++) emitApp("second-instance");

    expect(h.FakeWindow.instances).toHaveLength(1);
    expect(window.focus).toHaveBeenCalledTimes(5);
    expect(h.ipcHandle.mock.calls.length).toBe(handlersAfterStartup);
  });
});
