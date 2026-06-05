/**
 * Browser mock for window.repoRunner — simulates Electron IPC for the
 * Replit web preview. Real functionality runs only inside Electron.
 */
import {
  LogEntry,
  MAX_FREE_REPO_PROFILES,
  ProjectProfile,
  ProjectProfilesState,
  RepoRunnerAPI,
  ServiceStatuses,
  ServiceStatus,
} from "../types";

const PROJECT_STATE_STORAGE_KEY = "reporunner_project_state";
const OLD_PROJECT_STORAGE_KEY = "reporunner_project";
const EMPTY_PROJECT_STATE: ProjectProfilesState = {
  profiles: [],
  activeProfileId: null,
};

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
function hasBackend(project: ProjectProfile | null): project is ProjectProfile {
  return Boolean(project?.backendCommand.trim());
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

function normalizeProjectState(input: unknown): ProjectProfilesState {
  if (
    typeof input === "object" &&
    input !== null &&
    "profiles" in input &&
    Array.isArray(input.profiles)
  ) {
    const profiles = input.profiles as ProjectProfile[];
    const requestedActiveProfileId =
      "activeProfileId" in input && typeof input.activeProfileId === "string"
        ? input.activeProfileId
        : null;
    const activeProfileId = profiles.some(
      (profile) => profile.id === requestedActiveProfileId
    )
      ? requestedActiveProfileId
      : profiles[0]?.id ?? null;

    return { profiles, activeProfileId };
  }

  const profile = input as ProjectProfile;
  return { profiles: [profile], activeProfileId: profile.id };
}

function persistProjectState(state: ProjectProfilesState) {
  localStorage.setItem(PROJECT_STATE_STORAGE_KEY, JSON.stringify(state));
}

function getProjectState(): ProjectProfilesState {
  const stateRaw = localStorage.getItem(PROJECT_STATE_STORAGE_KEY);
  const oldProjectRaw = localStorage.getItem(OLD_PROJECT_STORAGE_KEY);
  const raw = stateRaw ?? oldProjectRaw;
  if (!raw) return EMPTY_PROJECT_STATE;

  try {
    const state = normalizeProjectState(JSON.parse(raw) as unknown);
    persistProjectState(state);
    if (!stateRaw && oldProjectRaw) {
      localStorage.removeItem(OLD_PROJECT_STORAGE_KEY);
    }
    return state;
  } catch {
    return EMPTY_PROJECT_STATE;
  }
}

function getProject(): ProjectProfile | null {
  const state = getProjectState();
  return (
    state.profiles.find((profile) => profile.id === state.activeProfileId) ??
    null
  );
}

export const mockRepoRunnerAPI: RepoRunnerAPI = {
  async selectFolder() {
    return "/Users/you/projects/my-app";
  },

  async loadProjectState() {
    return getProjectState();
  },

  async saveProject(profile: ProjectProfile) {
    const state = getProjectState();
    const existingIndex = state.profiles.findIndex(
      (existing) => existing.id === profile.id
    );

    if (
      existingIndex === -1 &&
      state.profiles.length >= MAX_FREE_REPO_PROFILES
    ) {
      throw new Error(
        "Repo limit reached. RepoRunner Free currently supports up to 5 saved repo setups."
      );
    }

    const profiles = [...state.profiles];
    if (existingIndex === -1) {
      profiles.push(profile);
    } else {
      profiles[existingIndex] = profile;
    }

    const nextState = { profiles, activeProfileId: profile.id };
    persistProjectState(nextState);
    return nextState;
  },

  async loadProject() {
    return getProject();
  },

  async setActiveProject(profileId: string) {
    const state = getProjectState();
    if (!state.profiles.some((profile) => profile.id === profileId)) {
      throw new Error("Saved repo setup not found.");
    }
    const nextState = { ...state, activeProfileId: profileId };
    persistProjectState(nextState);
    return nextState;
  },

  async deleteProject(profileId: string) {
    const state = getProjectState();
    const profiles = state.profiles.filter(
      (profile) => profile.id !== profileId
    );
    if (profiles.length === state.profiles.length) {
      throw new Error("Saved repo setup not found.");
    }

    const activeProfileId =
      state.activeProfileId === profileId
        ? profiles[0]?.id ?? null
        : state.activeProfileId;
    const nextState = { profiles, activeProfileId };
    persistProjectState(nextState);
    return nextState;
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

    if (!hasBackend(project)) {
      clearFakeTimer("backend");
      setStatus("backend", "stopped");
      emitLog("system", "Backend is not configured; skipping backend startup.");
      return;
    }

    doFakeStart("backend", project.backendCommand, project.backendPort);
  },

  async stopServices() {
    const project = getProject();
    const backendConfigured = hasBackend(project);

    clearFakeTimer("frontend");
    clearFakeTimer("backend");

    setStatus("frontend", "stopping");
    if (backendConfigured) {
      setStatus("backend", "stopping");
    } else {
      setStatus("backend", "stopped");
    }

    emitLog("system", "Stopping services...");

    await delay(700);

    setStatus("frontend", "stopped");
    setStatus("backend", "stopped");
    emitLog("system", "Services stopped.");
  },

  async restartAll() {
    const project = getProject();
    const backendConfigured = hasBackend(project);

    emitLog("system", "Restarting all services...");
    emitLog("system", "Stopping services...");

    clearFakeTimer("frontend");
    clearFakeTimer("backend");

    setStatus("frontend", "stopping");
    if (backendConfigured) {
      setStatus("backend", "stopping");
    } else {
      setStatus("backend", "stopped");
    }

    await delay(700);

    setStatus("frontend", "stopped");
    setStatus("backend", "stopped");
    emitLog("system", "Services stopped.");

    await delay(400);

    if (backendConfigured) {
      emitLog("backend", "Starting backend...");
      await doFakeStart(
        "backend",
        project.backendCommand,
        project.backendPort
      );
      emitLog("backend", "Backend is running.");

      await delay(200);
    } else {
      emitLog("system", "Backend is not configured; skipping backend startup.");
    }

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

  async getStatuses() {
    return { ...statuses };
  },

  onStatus(callback) {
    statusListeners.push(callback);
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







