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
    setupIpc: vi.fn(),
    shutdownRepoAnalysis: vi.fn(),
    isPackaged: true,
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
    get isPackaged() {
      return h.isPackaged;
    },
  },
  BrowserWindow: h.FakeWindow,
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  session: { defaultSession: h.session },
}));
vi.mock("../../electron/ipc.js", () => ({ setupIpc: h.setupIpc }));
vi.mock("../../electron/repoAnalysisIpc.js", () => ({ shutdownRepoAnalysis: h.shutdownRepoAnalysis }));
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
  h.setupIpc.mockClear();
  h.shutdownRepoAnalysis.mockClear();
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

  it("a packaged build never passes the internal credential switch to the renderer", () => {
    const prefs = h.FakeWindow.instances[0].options.webPreferences;
    expect(prefs).not.toHaveProperty("additionalArguments");
  });

  it("loads the packaged page", () => {
    expect(h.FakeWindow.instances[0].loadFile).toHaveBeenCalledWith(
      path.join("C:\\Apps\\RepoRunner\\resources\\app.asar", "dist/public/index.html"),
    );
  });
});

describe("internal credential Settings gate (Stage 4C)", () => {
  const ENV = "REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS";
  /** Starts main.ts again with the given packaging state and opt-in value; returns the window's webPreferences. */
  async function launch(isPackaged: boolean, optIn: string | undefined) {
    const saved = process.env[ENV];
    if (optIn === undefined) delete process.env[ENV];
    else process.env[ENV] = optIn;
    try {
      h.isPackaged = isPackaged;
      h.FakeWindow.instances = [];
      vi.resetModules();
      await import("../../electron/main.js");
      await flush();
      return h.FakeWindow.instances[0].options.webPreferences;
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
      h.isPackaged = true;
    }
  }

  it("is on only for an unpackaged launch with the explicit opt-in, and adds only the one switch", async () => {
    expect((await launch(false, "1")).additionalArguments).toEqual(["--reporunner-internal-credential-settings"]);
  });

  it.each([
    ["packaged, opted in", true, "1"],
    ["packaged, no opt-in", true, undefined],
    ["unpackaged, no opt-in (the default)", false, undefined],
    ["unpackaged, opt-in 'true'", false, "true"],
    ["unpackaged, opt-in '0'", false, "0"],
    ["unpackaged, opt-in ' 1'", false, " 1"],
  ])("is off when %s", async (_name, isPackaged, optIn) => {
    const prefs = await launch(isPackaged, optIn);
    expect(prefs).not.toHaveProperty("additionalArguments");
    // Hardening is the same either way.
    expect([prefs.contextIsolation, prefs.nodeIntegration, prefs.sandbox, prefs.webviewTag]).toEqual([true, false, true, false]);
  });

  it("an enabled launch keeps the same hardening", async () => {
    const prefs = await launch(false, "1");
    expect([prefs.contextIsolation, prefs.nodeIntegration, prefs.sandbox, prefs.webviewTag]).toEqual([true, false, true, false]);
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

describe("repository analysis wiring", () => {
  it("gives IPC the main window and the exact packaged page as the trusted renderer", () => {
    expect(h.setupIpc).toHaveBeenCalledTimes(1);
    const trust = h.setupIpc.mock.calls[0][0] as { getMainWindow(): unknown; appPageUrl(): string };
    expect(trust.getMainWindow()).toBe(h.FakeWindow.instances[0]);
    expect(trust.appPageUrl()).toBe(
      pathToFileURL(path.join("C:\\Apps\\RepoRunner\\resources\\app.asar", "dist/public/index.html")).href,
    );
  });

  it("aborts analysis as soon as quitting begins", () => {
    for (const listener of h.appListeners.get("before-quit") ?? []) listener({ preventDefault: vi.fn() });
    expect(h.shutdownRepoAnalysis).toHaveBeenCalledTimes(1);
  });
});
