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
  return new Promise((r) => setTimeout(r, ms));
}

let fakeInterval: ReturnType<typeof setInterval> | null = null;

function startFakeOutput(
  service: "frontend" | "backend",
  command: string,
  port?: number
) {
  let ticks = 0;
  fakeInterval = setInterval(() => {
    ticks++;
    if (ticks === 1) {
      emitLog(service, `$ ${command}`);
    } else if (ticks === 2) {
      emitLog(service, "Starting dev server...");
    } else if (ticks === 3) {
      emitLog(service, port ? `Listening on port ${port}` : "Ready.");
      setStatus(service, "running");
      clearInterval(fakeInterval!);
    }
  }, 800);
}

export const mockRepoRunnerAPI: RepoRunnerAPI = {
  async selectFolder() {
    return "/Users/you/projects/my-app";
  },

  async saveProject(profile: ProjectProfile) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  },

  async loadProject() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ProjectProfile;
    } catch {
      return null;
    }
  },

  async pullLatest() {
    emitLog("git", "Running git pull...");
    await delay(1200);
    emitLog("git", "Already up to date.");
  },

  async runInstall() {
    const raw = localStorage.getItem(STORAGE_KEY);
    const project = raw ? (JSON.parse(raw) as ProjectProfile) : null;
    emitLog("install", `Running: ${project?.installCommand ?? "npm install"}`);
    await delay(800);
    emitLog("install", "added 247 packages in 2.4s");
    emitLog("install", "Done.");
  },

  async startFrontend() {
    if (statuses.frontend === "running" || statuses.frontend === "starting") {
      emitLog("system", "Frontend is already running.");
      return;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    const project = raw ? (JSON.parse(raw) as ProjectProfile) : null;
    setStatus("frontend", "starting");
    startFakeOutput(
      "frontend",
      project?.frontendCommand ?? "npm run dev",
      project?.frontendPort
    );
  },

  async startBackend() {
    if (statuses.backend === "running" || statuses.backend === "starting") {
      emitLog("system", "Backend is already running.");
      return;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    const project = raw ? (JSON.parse(raw) as ProjectProfile) : null;
    setStatus("backend", "starting");
    startFakeOutput(
      "backend",
      project?.backendCommand ?? "node server.js",
      project?.backendPort
    );
  },

  async stopServices() {
    if (fakeInterval) {
      clearInterval(fakeInterval);
      fakeInterval = null;
    }
    setStatus("frontend", "stopping");
    setStatus("backend", "stopping");
    emitLog("system", "Stopping services...");
    await delay(800);
    setStatus("frontend", "stopped");
    setStatus("backend", "stopped");
    emitLog("system", "All services stopped.");
  },

  async restartAll() {
    await mockRepoRunnerAPI.stopServices();
    await delay(400);
    await mockRepoRunnerAPI.startBackend();
    await delay(200);
    await mockRepoRunnerAPI.startFrontend();
  },

  async openPreview() {
    const raw = localStorage.getItem(STORAGE_KEY);
    const project = raw ? (JSON.parse(raw) as ProjectProfile) : null;
    const url = project?.previewUrl ?? "http://localhost:3000";
    window.open(url, "_blank");
  },

  async copyLogs() {
    const text = logs
      .map((l) => `[${l.source}] ${l.text}`)
      .join("\n");
    await navigator.clipboard.writeText(text);
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
