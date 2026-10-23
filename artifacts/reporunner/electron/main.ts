import { app, BrowserWindow, Menu, session } from "electron";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { setupIpc } from "./ipc.js";
import { hardenSession, hardenWebContents } from "./windowSecurity.js";
import { shutdownRepoAnalysis } from "./repoAnalysisIpc.js";
import {
  beginShutdown,
  hasTrackedServiceWork,
  isShuttingDown,
  stopTrackedServicesForShutdown,
} from "./processManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV === "development";
const DEV_SERVER_URL = "http://localhost:5173/";

/** The only page RepoRunner windows may show (navigation elsewhere is blocked). */
function appPageUrl(): string {
  return isDev
    ? DEV_SERVER_URL
    : pathToFileURL(path.join(app.getAppPath(), "dist/public/index.html")).href;
}

let mainWindow: BrowserWindow | null = null;

/**
 * Quit lifecycle: idle → cleaning-up → complete. The first quit request
 * blocks new service starts; if RepoRunner owns running services the quit
 * waits (at most SHUTDOWN_DEADLINE_MS) while they are stopped, then quits.
 */
type QuitState = "idle" | "cleaning-up" | "complete";
let quitState: QuitState = "idle";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
    icon: path.join(__dirname, "../assets/icon.png"),
  });

  mainWindow.webContents.on("context-menu", (_event, params) => {

    if (!params.isEditable) return;

    const menu = Menu.buildFromTemplate([
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { type: "separator" },
      { role: "selectAll" },
    ]);

    menu.popup({ window: mainWindow ?? undefined });
  });

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), "dist/public/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * Brings the running instance's window forward when RepoRunner is launched
 * again. If the window doesn't exist yet (second launch during startup),
 * there is nothing to do: the first instance shows its window when ready.
 */
function focusExistingWindow() {
  // Quitting: never bring back or recreate a window.
  if (isShuttingDown()) return;

  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;

  if (!window) {
    // macOS keeps the app running with no windows; recreate one there.
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
    return;
  }

  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

// Only one RepoRunner may run per user-data folder: two instances would
// track separate process lists and edit the same saved setups file.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // Another instance is running and receives "second-instance". Exit before
  // registering IPC handlers, reading saved setups or creating a window.
  app.quit();
} else {
  // Every webContents (the window, its frames, anything created later) gets
  // the navigation, new-window and webview restrictions before it loads.
  app.on("web-contents-created", (_event, contents) => {
    hardenWebContents(contents, appPageUrl());
  });

  app.on("second-instance", () => {
    focusExistingWindow();
  });

  app.whenReady().then(() => {
    hardenSession(session.defaultSession);
    setupIpc({ getMainWindow: () => mainWindow, appPageUrl });
    createWindow();

    app.on("activate", () => {
      if (!isShuttingDown() && BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("before-quit", (event) => {
    if (quitState === "complete") return;

    // From the first quit request on, nothing new may start.
    beginShutdown();
    shutdownRepoAnalysis();

    if (quitState === "cleaning-up") {
      // Repeated quit request: keep waiting for the cleanup already running.
      event.preventDefault();
      return;
    }

    if (!hasTrackedServiceWork()) {
      quitState = "complete";
      return;
    }

    event.preventDefault();
    quitState = "cleaning-up";
    void stopTrackedServicesForShutdown()
      .then((result) => {
        if (result.outcome !== "stopped") {
          console.warn(
            `RepoRunner exit cleanup: ${result.outcome}` +
              (result.remainingPids.length > 0 ? `; tracked PIDs still alive: ${result.remainingPids.join(", ")}` : "") +
              (result.unverifiedServices.length > 0 ? `; unverified: ${result.unverifiedServices.join(", ")}` : ""),
          );
        }
      })
      .catch((error: unknown) => {
        console.error("RepoRunner exit cleanup failed:", error);
      })
      .finally(() => {
        quitState = "complete";
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}





