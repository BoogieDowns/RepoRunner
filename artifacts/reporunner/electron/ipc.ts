import { ipcMain, dialog, clipboard } from "electron";
import { spawn } from "child_process";
import { promisify } from "util";
import { loadProject, saveProject } from "./projectStore.js";
import {
  startService,
  stopAllServices,
  waitForServiceSettled,
  getStatuses,
} from "./processManager.js";
import { parsePortFromUrl } from "./portManager.js";
import {
  prepareCommandForExecution,
  sanitizeCommandInput,
} from "./commandUtils.js";
import { ProjectProfile, LogEntry, LogSource } from "../src/types.js";
import { BrowserWindow } from "electron";
import {
  validateProjectProfileForSave,
  validateRepoPathDirectoryForSave,
} from "./projectProfileValidation.js";
import { clearLogs, emitLog, formatLogsForClipboard } from "./logSink.js";

function createLineBufferedLogEmitter(source: LogSource) {
  let pending = "";

  const emitChunk = (chunk: Buffer | string) => {
    pending += chunk.toString();

    const lines = pending.split(/\r\n|\n|\r/);
    pending = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) {
        emitLog(source, line);
      }
    }
  };

  const flush = () => {
    if (pending.trim()) {
      emitLog(source, pending);
    }
    pending = "";
  };

  return { emitChunk, flush };
}

function runStreamingPull(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["pull"], {
      cwd,
      shell: false,
      env: { ...process.env },
    });

    
    const stdoutLog = createLineBufferedLogEmitter("git");
    const stderrLog = createLineBufferedLogEmitter("git");

    const flushLogs = () => {
      stdoutLog.flush();
      stderrLog.flush();
    };

    let settled = false;

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout?.on("data", stdoutLog.emitChunk);
    child.stderr?.on("data", stderrLog.emitChunk);

    child.on("error", (error) => {
      emitLog("git", `Error: ${error.message}`);
      settleReject(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      flushLogs();

      if (code === 0) {
        emitLog("git", "Pull finished.");
        resolve();
        return;
      }

      const failureMessage =
        signal && signal.trim()
          ? `Pull failed with code ${code ?? "unknown"} (signal ${signal}).`
          : `Pull failed with code ${code ?? "unknown"}.`;

      emitLog("git", failureMessage);
      reject(new Error(failureMessage));
    });
  });
}
function runStreamingInstall(
  preparedCommand: ReturnType<typeof prepareCommandForExecution>,
  cwd: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child =
      preparedCommand.kind === "file"
        ? spawn(preparedCommand.file, preparedCommand.args, {
            cwd,
            shell: false,
            env: { ...process.env },
          })
        : spawn(preparedCommand.command, {
            cwd,
            shell: true,
            env: { ...process.env },
          });


    const stdoutLog = createLineBufferedLogEmitter("install");
    const stderrLog = createLineBufferedLogEmitter("install");

    const flushLogs = () => {
      stdoutLog.flush();
      stderrLog.flush();
    };

    let settled = false;

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout?.on("data", stdoutLog.emitChunk);
    child.stderr?.on("data", stderrLog.emitChunk);

    child.on("error", (error) => {
      emitLog("install", `Error: ${error.message}`);
      settleReject(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      flushLogs();

      if (code === 0) {
        emitLog("install", "Install finished.");
        resolve();
        return;
      }

      const failureMessage =
        signal && signal.trim()
          ? `Install failed with code ${code ?? "unknown"} (signal ${signal}).`
          : `Install failed with code ${code ?? "unknown"}.`;

      emitLog("install", failureMessage);
      reject(new Error(failureMessage));
    });
  });
}

function isBackendConfigured(project: ProjectProfile): boolean {
  return project.backendCommand.trim().length > 0;
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

  ipcMain.handle("save-project", async (_event, profile: unknown) => {
    const validatedProfile = validateProjectProfileForSave(profile);
        await validateRepoPathDirectoryForSave(validatedProfile.repoPath);
    saveProject(validatedProfile);
  });

  ipcMain.handle("pull-latest", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    emitLog("git", "Pulling latest code...");
    await runStreamingPull(project.repoPath);
  });

  ipcMain.handle("run-install", async () => {
    const project = loadProject();
    if (!project) throw new Error("No project configured");
    const installCommand = sanitizeCommandInput(project.installCommand);
    emitLog("install", `Running: ${installCommand}`);
    const preparedCommand = prepareCommandForExecution(installCommand);
    await runStreamingInstall(preparedCommand, project.repoPath);
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

    if (!isBackendConfigured(project)) {
      emitLog("system", "Backend is not configured; skipping backend startup.");
      return;
    }

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

    // 2. Start backend and wait for it to settle before touching frontend,
    // unless this is a frontend-only project.
    if (isBackendConfigured(project)) {
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
    } else {
      emitLog("system", "Backend is not configured; skipping backend startup.");
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
  ipcMain.handle("copy-logs", async () => {
    clipboard.writeText(formatLogsForClipboard());
  });

  ipcMain.handle("clear-logs", async () => {
    clearLogs();
  });

  ipcMain.handle("get-statuses", async () => {
    return getStatuses();
  });
}


























