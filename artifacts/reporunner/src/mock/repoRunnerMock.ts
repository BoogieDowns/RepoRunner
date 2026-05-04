/**
 * Browser mock for window.repoRunner — simulates Electron IPC for the
 * Replit web preview. Real functionality runs only inside Electron.
 */
import {
  LogEntry,
  ProjectProfile,
  RepoRunnerAPI,
  RunPlan,
  ScanStep,
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

const fakeTimers: Record<"frontend" | "backend", ReturnType<typeof setTimeout> | null> = {
  frontend: null,
  backend: null,
};

function emitLog(source: LogEntry["source"], text: string, level?: LogEntry["level"]) {
  const entry: LogEntry = {
    id: `${Date.now()}-${logCounter++}`,
    timestamp: Date.now(),
    source,
    level: level ?? "info",
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

function clearFakeTimer(service: "frontend" | "backend") {
  if (fakeTimers[service] !== null) {
    clearTimeout(fakeTimers[service]!);
    fakeTimers[service] = null;
  }
}

async function doFakeStart(
  service: "frontend" | "backend",
  command: string,
  port?: number
): Promise<void> {
  clearFakeTimer(service);
  setStatus(service, "starting");
  emitLog(service, `Starting ${service}: ${command}`);
  await delay(700);
  if (statuses[service] !== "starting") return;
  emitLog(service, "Preparing dev server...");
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

const SCAN_STEPS: { id: string; label: string; duration: number }[] = [
  { id: "clone",     label: "CLONING REPOSITORY",           duration: 900 },
  { id: "packages",  label: "READING PACKAGE FILES",         duration: 700 },
  { id: "framework", label: "DETECTING FRAMEWORK",           duration: 800 },
  { id: "command",   label: "IDENTIFYING START COMMAND",     duration: 600 },
  { id: "env",       label: "SCANNING ENVIRONMENT VARIABLES", duration: 750 },
  { id: "plan",      label: "BUILDING RUN PLAN",             duration: 500 },
];

export const mockRepoRunnerAPI: RepoRunnerAPI = {
  // ── New GitHub-based flow ───────────────────────────────────────────────

  async analyzeRepo(url: string, onStep: (step: ScanStep) => void): Promise<RunPlan> {
    emitLog("system", `Analyzing: ${url}`);

    for (const step of SCAN_STEPS) {
      onStep({ id: step.id, label: step.label, status: "active" });
      emitLog("system", step.label);
      await delay(step.duration + Math.random() * 300);
      onStep({ id: step.id, label: step.label, status: "done" });
    }

    const parts = url.replace(/\.git$/, "").split("/");
    const projectName = parts[parts.length - 1] || "my-app";

    emitLog("system", "Analysis complete. Run plan ready.");

    return {
      repoUrl: url,
      projectName,
      framework: "Next.js 14",
      packageManager: "npm",
      installCommand: "npm install",
      startCommand: "npm run dev",
      port: 3000,
      branch: "main",
      runtime: "Node.js 18.x",
      envVars: [
        { name: "DATABASE_URL",    required: true,  hasValue: false, description: "PostgreSQL connection string" },
        { name: "NEXTAUTH_SECRET", required: true,  hasValue: false, description: "Auth.js secret key" },
        { name: "OPENAI_API_KEY",  required: false, hasValue: false, description: "OpenAI API access" },
      ],
      readiness: "missing-input",
    };
  },

  async launchPreview(): Promise<void> {
    emitLog("system", "Booting preview environment...");
    await delay(300);
    emitLog("install", "npm install");
    await delay(800);
    emitLog("install", "added 312 packages in 1.8s");
    emitLog("install", "Dependencies installed.");
    await delay(200);
    await doFakeStart("backend", "node server.js", 3001);
    await delay(300);
    await doFakeStart("frontend", "npm run dev", 3000);
    emitLog("system", "Preview online at http://localhost:3000");
  },

  async stopPreview(): Promise<void> {
    clearFakeTimer("frontend");
    clearFakeTimer("backend");
    setStatus("frontend", "stopping");
    setStatus("backend", "stopping");
    emitLog("system", "Stopping preview...");
    await delay(600);
    setStatus("frontend", "stopped");
    setStatus("backend", "stopped");
    emitLog("system", "Preview stopped.");
  },

  // ── Legacy local-project methods ────────────────────────────────────────

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
    if (statuses.frontend === "running" || statuses.frontend === "starting") return;
    const project = getProject();
    doFakeStart("frontend", project?.frontendCommand ?? "npm run dev", project?.frontendPort);
  },

  async startBackend() {
    if (statuses.backend === "running" || statuses.backend === "starting") return;
    const project = getProject();
    doFakeStart("backend", project?.backendCommand ?? "node server.js", project?.backendPort);
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
    clearFakeTimer("frontend");
    clearFakeTimer("backend");
    setStatus("frontend", "stopping");
    setStatus("backend", "stopping");
    await delay(700);
    setStatus("frontend", "stopped");
    setStatus("backend", "stopped");
    emitLog("system", "Services stopped.");
    await delay(400);
    await doFakeStart("backend", project?.backendCommand ?? "node server.js", project?.backendPort);
    await delay(200);
    await doFakeStart("frontend", project?.frontendCommand ?? "npm run dev", project?.frontendPort);
    emitLog("system", "Restart complete.");
  },

  async openPreview() {
    const project = getProject();
    window.open(project?.previewUrl ?? "http://localhost:3000", "_blank");
  },

  async copyLogs() {
    const text = logs.map((l) => `[${l.source}] ${l.text}`).join("\n");
    await navigator.clipboard.writeText(text).catch(() => {});
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
    emitLog("system", "RepoRunner ready. [PREVIEW MODE — browser simulation]");
  }
}
