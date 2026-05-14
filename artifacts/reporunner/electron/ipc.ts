import { ipcMain, dialog, clipboard } from "electron";
import { exec } from "child_process";
import { promisify } from "util";
import { loadProject, saveProject } from "./projectStore.js";
import {
  startService,
  stopAllServices,
  waitForServiceSettled,
  getStatuses,
} from "./processManager.js";
import { parsePortFromUrl } from "./portManager.js";
import { ProjectProfile, LogEntry, LogSource } from "../src/types.js";
import { BrowserWindow } from "electron";

const execAsync = promisify(exec);

let logCounter = 0;

function emitLog(source: LogSource, text: string) {
  const entry: LogEntry = {
    id: `${Date.now()}-${logCounter++}`,
    timestamp: Date.now(),
    source,
    text,
  };
  const wins = BrowserWindow.getAllWindows();
  wins[0]?.webContents.send("log", entry);
}

export function setupIpc() {
  ipcMain.handle("select-folder", async (event) => {
    const parentWindow =
      BrowserWindow.fromWebContents(event.sender) ??
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0] ??
      null;
    const usableParentWindow =
      parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory"],
    };

    try {
      const result = usableParentWindow
        ? await dialog.showOpenDialog(usableParentWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    } catch (error) {
      console.error("Failed to open folder picker:", error);
      return null;
    }
  });

  ipcMain.handle("load-project", async () => {
    return loadProject();
  });

  ipcMain.handle("save-project", async (_event, profile: ProjectProfile) => {
    saveProject(profile);
  });

  ipcMain.handle("pull-latest", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    emitLog("git", "Pulling latest code...");
    const { stdout, stderr } = await execAsync("git pull", {
      cwd: project.repoPath,
    });
    if (stdout.trim()) emitLog("git", stdout.trim());
    if (stderr.trim()) emitLog("git", stderr.trim());
    return { stdout, stderr };
  });

  ipcMain.handle("run-install", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    emitLog("install", `Running: ${project.installCommand}`);
    const { stdout, stderr } = await execAsync(project.installCommand, {
      cwd: project.repoPath,
      env: { ...process.env },
    });
    if (stdout.trim()) emitLog("install", stdout.trim());
    if (stderr.trim()) emitLog("install", stderr.trim());
    emitLog("install", "Install finished.");
    return { stdout, stderr };
  });

  ipcMain.handle("start-frontend", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    await startService(
      "frontend",
      project.frontendCommand,
      project.repoPath,
      project.frontendPort
    );
  });

  ipcMain.handle("start-backend", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    await startService(
      "backend",
      project.backendCommand,
      project.repoPath,
      project.backendPort
    );
  });

  ipcMain.handle("stop-services", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    emitLog("system", "Stopping services...");
    await stopAllServices(project.frontendPort, project.backendPort);
    emitLog("system", "Services stopped.");
  });

  ipcMain.handle("restart-all", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");

    emitLog("system", "Restarting all services...");

    // 1. Stop everything and wait for ports to clear
    emitLog("system", "Stopping services...");
    await stopAllServices(project.frontendPort, project.backendPort);
    emitLog("system", "Services stopped.");

    // Brief pause to ensure OS resources are released
    await new Promise((r) => setTimeout(r, 500));

    // 2. Start backend and wait for it to settle before touching frontend
    emitLog("backend", "Starting backend...");
    await startService(
      "backend",
      project.backendCommand,
      project.repoPath,
      project.backendPort
    );
    await waitForServiceSettled("backend", 30000);

    const backendStatus = getStatuses().backend;
    if (backendStatus === "running") {
      emitLog("backend", "Backend is running.");
    } else {
      emitLog("backend", `Backend status: ${backendStatus}. Continuing to start frontend anyway.`);
    }

    // 3. Start frontend and wait for it to settle
    emitLog("frontend", "Starting frontend...");
    await startService(
      "frontend",
      project.frontendCommand,
      project.repoPath,
      project.frontendPort
    );
    await waitForServiceSettled("frontend", 30000);

    const frontendStatus = getStatuses().frontend;
    if (frontendStatus === "running") {
      emitLog("frontend", "Frontend is running.");
    } else {
      emitLog("frontend", `Frontend status: ${frontendStatus}.`);
    }

    emitLog("system", "Restart complete.");
  });

  ipcMain.handle("open-preview", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    const { shell } = await import("electron");
    await shell.openExternal(project.previewUrl);
  });

  function normalizeClipboardText(value: unknown): string {
  if (value === undefined || value === null) return "";

  if (typeof value === "string") return value;

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "" : serialized;
  } catch {
    return String(value);
  }
}

ipcMain.handle("copy-logs", async (_event, logs: unknown) => {
  const clipboardText = normalizeClipboardText(logs);
  clipboard.writeText(clipboardText);
});

  ipcMain.handle("clear-logs", async () => {
    // log buffer is managed on the renderer side
  });

  ipcMain.handle("get-statuses", async () => {
    return getStatuses();
  });
}


