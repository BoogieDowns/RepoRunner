/**
 * Browser mock for window.repoRunner — simulates Electron IPC for the
 * Replit web preview. Real functionality runs only inside Electron.
 */
import {
  LogEntry,
  ProjectProfile,
  RepoRunnerAPI,
  ServiceStatuses,
  ServiceStatus,
} from "../types";

const STORAGE_KEY = "reporunner_project";

let logs: LogEntry[] = [];
let logCounter = 0;
let logListeners: ((entry: LogEntry) => void)[] = [];
let statusListeners: ((s: ServiceStatuses) => void)[] = [];

const statuses: ServiceStatuses = {
  frontend: "stopped",
  backend: "stopped",
};

// Per-service fake timers — NOT shared, so restartAll can't accidentally
// clear the wrong service's timer.
const fakeTimers: Record<"frontend" | "backend", ReturnType<typeof setTimeout> | null> = {
  frontend: null,
  backend: null,
};

function emitLog(source: LogEntry["source"], text: string) {
  const entry: LogEntry = {
    id: `${Date.now()}-${logCounter++}`,
    timestamp: Date.now(),
    source,
    text,
  };
  logs.push(entry);
  logListeners.forEach((fn) => fn(entry));
}

function setStatus(service: "frontend" | "backend", status: ServiceStatus) {
  statuses[service] = status;
  statusListeners.forEach((fn) => fn({ ...statuses }));
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function formatLogTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
}

function formatLogsForClipboard(logEntries: LogEntry[]): string {
  return logEntries
    .map((log) => `${formatLogTimestamp(log.timestamp)} [${log.source.toUpperCase()}] ${log.text}`)
    .join("\n");
}
function clearFakeTimer(service: "frontend" | "backend") {
  if (fakeTimers[service] !== null) {
    clearTimeout(fakeTimers[service]!);
    fakeTimers[service] = null;
  }
}

/**
 * Simulates a service starting up. Returns a Promise that resolves once the
 * service has reached "running" (or is interrupted).
 * Uses per-service timers so concurrent starts for different services don't
 * interfere with each other.
 */
async function doFakeStart(
  service: "frontend" | "backend",
  command: string,
  port?: number
): Promise<void> {
  clearFakeTimer(service);

  setStatus(service, "starting");
  emitLog(service, `Starting ${service}: ${command}`);

  await delay(700);
  if (statuses[service] !== "starting") return; // was stopped externally

  emitLog(service, "Starting dev server...");

  await delay(900);
  if (statuses[service] !== "starting") return;

  emitLog(service, port ? `Listening on port ${port}` : "Ready.");
  setStatus(service, "running");
}

function getProject(): ProjectProfile | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProjectProfile;
  } catch {
    return null;
  }
}

export const mockRepoRunnerAPI: RepoRunnerAPI = {
  async selectFolder() {
    return "/Users/you/projects/my-app";
  },

  async saveProject(profile: ProjectProfile) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  },

  async loadProject() {
    return getProject();
  },

  async pullLatest() {
    emitLog("git", "Pulling latest code...");
    await delay(1200);
    emitLog("git", "Already up to date.");
  },

  async runInstall() {
    const project = getProject();
    emitLog("install", `Running: ${project?.installCommand ?? "npm install"}`);
    await delay(1000);
    emitLog("install", "added 247 packages in 2.4s");
    emitLog("install", "Install finished.");
  },

  async startFrontend() {
    if (statuses.frontend === "running" || statuses.frontend === "starting") {
      emitLog("system", "Frontend is already running or starting.");
      return;
    }
    const project = getProject();
    // Fire-and-forget for manual start — UI shows "starting" pill immediately,
    // status updates to "running" when the simulation completes.
    doFakeStart(
      "frontend",
      project?.frontendCommand ?? "npm run dev",
      project?.frontendPort
    );
  },

  async startBackend() {
    if (statuses.backend === "running" || statuses.backend === "starting") {
      emitLog("system", "Backend is already running or starting.");
      return;
    }
    const project = getProject();
    doFakeStart(
      "backend",
      project?.backendCommand ?? "node server.js",
      project?.backendPort
    );
  },

  async stopServices() {
    clearFakeTimer("frontend");
    clearFakeTimer("backend");

    setStatus("frontend", "stopping");
    setStatus("backend", "stopping");
    emitLog("system", "Stopping services...");

    await delay(700);

    setStatus("frontend", "stopped");
    setStatus("backend", "stopped");
    emitLog("system", "Services stopped.");
  },

  async restartAll() {
    const project = getProject();

    emitLog("system", "Restarting all services...");
    emitLog("system", "Stopping services...");

    clearFakeTimer("frontend");
    clearFakeTimer("backend");
    setStatus("frontend", "stopping");
    setStatus("backend", "stopping");
    await delay(700);
    setStatus("frontend", "stopped");
    setStatus("backend", "stopped");
    emitLog("system", "Services stopped.");

    await delay(400);

    // Start backend and AWAIT it fully before touching frontend.
    // This is the key fix — no shared interval, no race condition.
    emitLog("backend", "Starting backend...");
    await doFakeStart(
      "backend",
      project?.backendCommand ?? "node server.js",
      project?.backendPort
    );
    emitLog("backend", "Backend is running.");

    await delay(200);

    emitLog("frontend", "Starting frontend...");
    await doFakeStart(
      "frontend",
      project?.frontendCommand ?? "npm run dev",
      project?.frontendPort
    );
    emitLog("frontend", "Frontend is running.");

    emitLog("system", "Restart complete.");
  },

  async openPreview() {
    const project = getProject();
    const url = project?.previewUrl ?? "http://localhost:3000";
    window.open(url, "_blank");
  },

  async copyLogs() {
    await navigator.clipboard.writeText(formatLogsForClipboard(logs)).catch(() => {});
  },

  async clearLogs() {
    logs = [];
  },

  onLog(callback) {
    logListeners.push(callback);
    return () => {
      logListeners = logListeners.filter((fn) => fn !== callback);
    };
  },

  onStatus(callback) {
    statusListeners.push(callback);
    // Deliver current state immediately so the UI doesn't start blank
    setTimeout(() => callback({ ...statuses }), 0);
    return () => {
      statusListeners = statusListeners.filter((fn) => fn !== callback);
    };
  },
};

export function installMock() {
  if (typeof window !== "undefined" && !window.repoRunner) {
    (window as any).repoRunner = mockRepoRunnerAPI;
    emitLog("system", "RepoRunner ready. (Preview mode — running in browser)");
  }
}




