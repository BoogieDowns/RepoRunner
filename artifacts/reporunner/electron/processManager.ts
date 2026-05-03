import { spawn, ChildProcess } from "child_process";
import treeKill from "tree-kill";
import { promisify } from "util";
import { BrowserWindow } from "electron";
import {
  isPortInUse,
  waitUntilPortIsFree,
  killProcessUsingPort,
  waitUntilPortIsReachable,
} from "./portManager.js";
import { LogEntry, LogSource, ServiceStatus, ServiceStatuses } from "../src/types.js";

const treeKillAsync = promisify(treeKill);

let frontendProcess: ChildProcess | null = null;
let backendProcess: ChildProcess | null = null;

const statuses: ServiceStatuses = {
  frontend: "stopped",
  backend: "stopped",
};

let logCounter = 0;

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0] : null;
}

function emitLog(source: LogSource, text: string) {
  const entry: LogEntry = {
    id: `${Date.now()}-${logCounter++}`,
    timestamp: Date.now(),
    source,
    text,
  };
  const win = getMainWindow();
  win?.webContents.send("log", entry);
}

function emitStatus() {
  const win = getMainWindow();
  win?.webContents.send("status", { ...statuses });
}

function setStatus(service: "frontend" | "backend", status: ServiceStatus) {
  statuses[service] = status;
  emitStatus();
}

function streamProcess(proc: ChildProcess, source: LogSource) {
  proc.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) emitLog(source, line);
    }
  });
  proc.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) emitLog(source, line);
    }
  });
}

export async function startService(
  service: "frontend" | "backend",
  command: string,
  cwd: string,
  port?: number
): Promise<void> {
  const current = service === "frontend" ? frontendProcess : backendProcess;

  if (
    statuses[service] === "running" ||
    statuses[service] === "starting"
  ) {
    emitLog("system", `${service} is already running or starting.`);
    return;
  }

  if (port) {
    const inUse = await isPortInUse(port);
    if (inUse) {
      emitLog(
        "system",
        `${service.charAt(0).toUpperCase() + service.slice(1)} port ${port} is already in use. Stop services first or free the port.`
      );
      setStatus(service, "failed");
      return;
    }
  }

  setStatus(service, "starting");
  emitLog(service as LogSource, `Starting: ${command}`);

  const proc = spawn(command, {
    cwd,
    shell: true,
    env: { ...process.env },
  });

  if (service === "frontend") {
    frontendProcess = proc;
  } else {
    backendProcess = proc;
  }

  streamProcess(proc, service as LogSource);

  proc.on("error", (err) => {
    emitLog(service as LogSource, `Error: ${err.message}`);
    setStatus(service, "failed");
  });

  proc.on("exit", (code, signal) => {
    if (statuses[service] !== "stopping") {
      emitLog(
        service as LogSource,
        `Process exited with code ${code} signal ${signal}`
      );
      setStatus(service, code === 0 ? "stopped" : "failed");
    }
    if (service === "frontend") frontendProcess = null;
    else backendProcess = null;
  });

  if (port) {
    const reachable = await waitUntilPortIsReachable(port, 30000);
    if (reachable) {
      emitLog(service as LogSource, `${service} is ready on port ${port}`);
      setStatus(service, "running");
    } else {
      emitLog(
        service as LogSource,
        `${service} did not become reachable on port ${port} within 30s`
      );
      setStatus(service, "unknown");
    }
  } else {
    await new Promise((r) => setTimeout(r, 3000));
    if (proc.exitCode === null) {
      setStatus(service, "running");
    } else {
      setStatus(service, "failed");
    }
  }
}

export async function stopService(
  service: "frontend" | "backend",
  port?: number
): Promise<void> {
  const proc = service === "frontend" ? frontendProcess : backendProcess;

  setStatus(service, "stopping");
  emitLog(service as LogSource, `Stopping ${service}...`);

  if (proc && proc.pid) {
    try {
      await treeKillAsync(proc.pid, "SIGTERM");
    } catch {
      try {
        await treeKillAsync(proc.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  if (service === "frontend") frontendProcess = null;
  else backendProcess = null;

  if (port) {
    const freed = await waitUntilPortIsFree(port, 8000);
    if (!freed) {
      emitLog(
        "system",
        `Port ${port} still in use after stopping ${service}. Attempting force kill...`
      );
      await killProcessUsingPort(port);
      const freedAfterKill = await waitUntilPortIsFree(port, 5000);
      if (!freedAfterKill) {
        emitLog(
          "system",
          `Warning: Could not verify port ${port} is free. Status set to unknown.`
        );
        setStatus(service, "unknown");
        return;
      }
    }
  }

  setStatus(service, "stopped");
  emitLog(service as LogSource, `${service} stopped.`);
}

export async function stopAllServices(
  frontendPort?: number,
  backendPort?: number
): Promise<void> {
  await Promise.all([
    stopService("frontend", frontendPort),
    stopService("backend", backendPort),
  ]);
}

export function getStatuses(): ServiceStatuses {
  return { ...statuses };
}
