// Window configuration and where main.ts applies the hardening. Electron and
// IPC are mocked; windowSecurity is real.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

const h = vi.hoisted(() => {
  class FakeWindow {
    static instances: FakeWindow[] = [];
    webContents = { on: vi.fn() };
    loadFile = vi.fn();
    loadURL = vi.fn();
    constructor(public options: { webPreferences: Record<string, unknown> }) {
      FakeWindow.instances.push(this);
    }
    on() {}
    isDestroyed() {
      return false;
    }
    static getAllWindows() {
      return FakeWindow.instances;
    }
  }
  return {
    FakeWindow,
    appListeners: new Map<string, Listener[]>(),
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  };
});

vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    on: (event: string, listener: Listener) => h.appListeners.set(event, [...(h.appListeners.get(event) ?? []), listener]),
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    getAppPath: () => "C:\\Apps\\RepoRunner\\resources\\app.asar",
  },
  BrowserWindow: h.FakeWindow,
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  session: { defaultSession: h.session },
}));
vi.mock("../../electron/ipc.js", () => ({ setupIpc: vi.fn() }));
vi.mock("../../electron/processManager.js", () => ({
  beginShutdown: vi.fn(),
  isShuttingDown: () => false,
  hasTrackedServiceWork: () => false,
  stopTrackedServicesForShutdown: vi.fn(),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  h.FakeWindow.instances = [];
  h.appListeners.clear();
  h.session.setPermissionRequestHandler.mockClear();
  h.session.setPermissionCheckHandler.mockClear();
  vi.resetModules();
  await import("../../electron/main.js");
  await flush();
});

describe("main window configuration", () => {
  it("keeps context isolation, disables node integration and webviews, and enables the sandbox", () => {
    const prefs = h.FakeWindow.instances[0].options.webPreferences;

    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webviewTag).toBe(false);
  });

  it("loads the packaged page", () => {
    expect(h.FakeWindow.instances[0].loadFile).toHaveBeenCalledWith(
      path.join("C:\\Apps\\RepoRunner\\resources\\app.asar", "dist/public/index.html"),
    );
  });
});

describe("hardening is applied", () => {
  it("to the default session before the window is created", () => {
    expect(h.session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(h.session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  });

  it("to every webContents as it is created, allowing only the packaged page", () => {
    const listeners = new Map<string, Listener>();
    let openHandler: ((details: unknown) => unknown) | null = null;
    const contents = {
      on: (event: string, listener: Listener) => listeners.set(event, listener),
      setWindowOpenHandler: (handler: (details: unknown) => unknown) => (openHandler = handler),
    };

    for (const listener of h.appListeners.get("web-contents-created") ?? []) listener({}, contents);

    expect(openHandler!({ url: "https://example.com" })).toEqual({ action: "deny" });
    const appPage = pathToFileURL(path.join("C:\\Apps\\RepoRunner\\resources\\app.asar", "dist/public/index.html")).href;
    const allowed = { url: appPage, preventDefault: vi.fn() };
    const blocked = { url: "https://example.com", preventDefault: vi.fn() };
    listeners.get("will-navigate")!(allowed);
    listeners.get("will-navigate")!(blocked);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(blocked.preventDefault).toHaveBeenCalled();
    expect(listeners.has("will-redirect")).toBe(true);
    expect(listeners.has("will-frame-navigate")).toBe(true);
    expect(listeners.has("will-attach-webview")).toBe(true);
  });
});
