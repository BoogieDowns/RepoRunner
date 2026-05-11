import { spawn, ChildProcess } from "child_process";
import treeKill from "tree-kill";
import { BrowserWindow } from "electron";
import {
  isPortInUse,
  waitUntilPortIsFree,
  killProcessUsingPort,
  waitUntilPortIsReachable,
} from "./portManager.js";
import {
  LogEntry,
  LogSource,
  ServiceStatus,
  ServiceStatuses,
} from "../src/types.js";

function treeKillAsync(pid: number, signal: string): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, signal, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// Per-service process handles and run IDs
// A new runId is issued every time startService is called for a service.
// All async callbacks capture the runId at the time they were created and
// bail out if the current runId no longer matches — this prevents stale
// events from a killed process from overwriting the status of a freshly
// started replacement process.
const processes: Record<"frontend" | "backend", ChildProcess | null> = {
  frontend: null,
  backend: null,
};

const runIds: Record<"frontend" | "backend", number> = {
  frontend: 0,
  backend: 0,
};

const statuses: ServiceStatuses = {
  frontend: "stopped",
  backend: "stopped",
};

// Resolvers for waitForServiceSettled — fulfilled when a service leaves "starting"
const settledResolvers: Record<"frontend" | "backend", Array<() => void>> = {
  frontend: [],
  backend: [],
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

  // Notify any waitForServiceSettled callers if the service has left "starting"
  if (status !== "starting") {
    const resolvers = settledResolvers[service].splice(0);
    for (const resolve of resolvers) resolve();
  }
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

/**
 * Waits until the service's status is no longer "starting".
 * Resolves immediately if the status is already settled.
 */
export function waitForServiceSettled(
  service: "frontend" | "backend",
  timeoutMs = 60000,
): Promise<void> {
  if (statuses[service] !== "starting") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      // Remove our resolver and force-resolve on timeout
      const idx = settledResolvers[service].indexOf(resolve);
      if (idx !== -1) settledResolvers[service].splice(idx, 1);
      resolve();
    }, timeoutMs);

    settledResolvers[service].push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function startService(
  service: "frontend" | "backend",
  command: string,
  cwd: string,
  port?: number,
): Promise<void> {
  if (statuses[service] === "running" || statuses[service] === "starting") {
    emitLog("system", `${service} is already running or starting.`);
    return;
  }

  if (port) {
    const inUse = await isPortInUse(port);
    if (inUse) {
      const label = service.charAt(0).toUpperCase() + service.slice(1);
      emitLog(
        "system",
        `${label} port ${port} is already in use. Stop services first or free the port.`,
      );
      setStatus(service, "failed");
      return;
    }
  }

  // Issue a new run ID for this invocation. Any callbacks from a previous
  // (now-killed) process will see their captured runId no longer matches
  // and will silently bail out without touching status.
  const runId = ++runIds[service];

  setStatus(service, "starting");
  emitLog(service as LogSource, `Starting ${service}: ${command}`);

  const proc = spawn(command, {
    cwd,
    shell: true,
    env: { ...process.env },
  });

  processes[service] = proc;

  streamProcess(proc, service as LogSource);

  proc.on("error", (err) => {
    if (runIds[service] !== runId) return; // stale — a newer process owns this service
    emitLog(service as LogSource, `Error: ${err.message}`);
    setStatus(service, "failed");
  });

  proc.on("exit", (code, signal) => {
    if (runIds[service] !== runId) return; // stale event — ignore entirely

    // Only null the process slot if it still refers to this process
    if (processes[service] === proc) processes[service] = null;

    // If we were intentionally stopping, stopService handles the status
    if (statuses[service] === "stopping") return;

    emitLog(
      service as LogSource,
      `Process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
    );
    setStatus(service, code === 0 ? "stopped" : "failed");
  });

  // --- Readiness check ---
  if (port) {
    const reachable = await waitUntilPortIsReachable(port, 15000);

    // After the async wait, check if this invocation is still the current one
    if (runIds[service] !== runId) return;

    if (reachable) {
      emitLog(service as LogSource, `${service} is ready on port ${port}.`);
      setStatus(service, "running");
    } else if (proc.exitCode !== null) {
      // Process already died while we were waiting
      emitLog(
        service as LogSource,
        `${service} process exited before becoming ready on port ${port}.`,
      );
      setStatus(service, "failed");
    } else {
      // Process still alive but port never opened — mark unknown
      emitLog(
        service as LogSource,
        `${service} process is still alive, but port ${port} did not become reachable within 15 seconds. Status set to Unknown. The app may still be starting; check the preview URL.`,
      );
      setStatus(service, "unknown");
    }
  } else {
    // No port configured — consider running if the process survives 3 seconds
    await new Promise((r) => setTimeout(r, 3000));
    if (runIds[service] !== runId) return;

    if (proc.exitCode === null) {
      emitLog(service as LogSource, `${service} appears to be running.`);
      setStatus(service, "running");
    } else {
      setStatus(service, "failed");
    }
  }
}

export async function stopService(
  service: "frontend" | "backend",
  port?: number,
): Promise<void> {
  const proc = processes[service];

  // Bump run ID so any in-flight startService for this service becomes stale
  runIds[service]++;

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

  processes[service] = null;

  if (port) {
    const freed = await waitUntilPortIsFree(port, 8000);
    if (!freed) {
      emitLog(
        "system",
        `Port ${port} still in use after stopping ${service}. Attempting force kill...`,
      );
      await killProcessUsingPort(port);
      const freedAfterKill = await waitUntilPortIsFree(port, 5000);
      if (!freedAfterKill) {
        emitLog(
          "system",
          `Warning: Could not verify port ${port} is free. Status set to unknown.`,
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
  backendPort?: number,
): Promise<void> {
  await Promise.all([
    stopService("frontend", frontendPort),
    stopService("backend", backendPort),
  ]);
}

export function getStatuses(): ServiceStatuses {
  return { ...statuses };
}
