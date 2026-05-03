import { ipcMain, dialog, clipboard } from "electron";
import { exec } from "child_process";
import { promisify } from "util";
import { loadProject, saveProject } from "./projectStore.js";
import {
  startService,
  stopAllServices,
  getStatuses,
} from "./processManager.js";
import { parsePortFromUrl } from "./portManager.js";
import { ProjectProfile } from "../src/types.js";

const execAsync = promisify(exec);

let logBuffer: string[] = [];

export function setupIpc() {
  ipcMain.handle("select-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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
    const { stdout, stderr } = await execAsync("git pull", {
      cwd: project.repoPath,
    });
    return { stdout, stderr };
  });

  ipcMain.handle("run-install", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    const { stdout, stderr } = await execAsync(project.installCommand, {
      cwd: project.repoPath,
      env: { ...process.env },
    });
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
    await stopAllServices(project.frontendPort, project.backendPort);
  });

  ipcMain.handle("restart-all", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    await stopAllServices(project.frontendPort, project.backendPort);
    await startService(
      "backend",
      project.backendCommand,
      project.repoPath,
      project.backendPort
    );
    await startService(
      "frontend",
      project.frontendCommand,
      project.repoPath,
      project.frontendPort
    );
  });

  ipcMain.handle("open-preview", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    const { shell } = await import("electron");
    await shell.openExternal(project.previewUrl);
  });

  ipcMain.handle("copy-logs", async (_event, logs: string) => {
    clipboard.writeText(logs);
  });

  ipcMain.handle("clear-logs", async () => {
    logBuffer = [];
  });

  ipcMain.handle("get-statuses", async () => {
    return getStatuses();
  });
}
