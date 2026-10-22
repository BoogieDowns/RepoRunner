import { app, BrowserWindow, Menu } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { setupIpc } from "./ipc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV === "development";

let mainWindow: BrowserWindow | null = null;

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
    mainWindow.loadURL("http://localhost:5173");
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
  app.on("second-instance", () => {
    focusExistingWindow();
  });

  app.whenReady().then(() => {
    setupIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}





