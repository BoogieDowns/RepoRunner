/**
 * Browser mock for window.repoRunner — simulates Electron IPC for the
 * Replit web preview. Real functionality runs only inside Electron.
 */
import {
  LogEntry,
  MAX_FREE_REPO_PROFILES,
  PROJECT_STORE_ERROR_MESSAGES,
  ProjectProfile,
  ProjectProfilesState,
  ProjectStoreRecoveryAction,
  ProjectStoreStatus,
  REPO_ANALYSIS_ERROR_MESSAGES,
  RepoRunnerAPI,
  RepoScanResult,
  ServiceStatuses,
  ServiceStatus,
} from "../types";

const PROJECT_STATE_STORAGE_KEY = "reporunner_project_state";
const OLD_PROJECT_STORAGE_KEY = "reporunner_project";
// Simulated file revision: bumped on every write so stale-revision conflicts
// behave like the desktop app.
const PROJECT_REVISION_STORAGE_KEY = "reporunner_project_revision";
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
    // Same rule as the desktop store: a stored selection is honoured exactly
    // (no repo if it no longer exists); only a missing field falls back.
    const activeProfileId = profiles.some(
      (profile) => profile.id === requestedActiveProfileId
    )
      ? requestedActiveProfileId
      : "activeProfileId" in input
        ? null
        : profiles[0]?.id ?? null;

    return { profiles, activeProfileId };
  }

  const profile = input as ProjectProfile;
  return { profiles: [profile], activeProfileId: profile.id };
}

function currentRevision(): string | null {
  if (!localStorage.getItem(PROJECT_STATE_STORAGE_KEY)) return null;
  return `mock-${localStorage.getItem(PROJECT_REVISION_STORAGE_KEY) ?? "0"}`;
}

function persistProjectState(state: ProjectProfilesState, bumpRevision = true) {
  const { profiles, activeProfileId } = state;
  localStorage.setItem(PROJECT_STATE_STORAGE_KEY, JSON.stringify({ profiles, activeProfileId }));
  if (bumpRevision) {
    const next = Number(localStorage.getItem(PROJECT_REVISION_STORAGE_KEY) ?? "0") + 1;
    localStorage.setItem(PROJECT_REVISION_STORAGE_KEY, String(next));
  }
}

function assertRevision(expectedRevision?: string | null) {
  if (expectedRevision !== undefined && expectedRevision !== currentRevision()) {
    throw new Error(PROJECT_STORE_ERROR_MESSAGES.conflict);
  }
}

function withRevision(state: ProjectProfilesState): ProjectProfilesState {
  return { profiles: state.profiles, activeProfileId: state.activeProfileId, revision: currentRevision() };
}

function getProjectState(): ProjectProfilesState {
  const stateRaw = localStorage.getItem(PROJECT_STATE_STORAGE_KEY);
  const oldProjectRaw = localStorage.getItem(OLD_PROJECT_STORAGE_KEY);
  const raw = stateRaw ?? oldProjectRaw;
  if (!raw) return { ...EMPTY_PROJECT_STATE, revision: null };

  try {
    const state = normalizeProjectState(JSON.parse(raw) as unknown);
    persistProjectState(state, false);
    if (!stateRaw && oldProjectRaw) {
      localStorage.removeItem(OLD_PROJECT_STORAGE_KEY);
    }
    return withRevision(state);
  } catch {
    return { ...EMPTY_PROJECT_STATE, revision: null };
  }
}

function getProject(): ProjectProfile | null {
  const state = getProjectState();
  return (
    state.profiles.find((profile) => profile.id === state.activeProfileId) ??
    null
  );
}

// The browser preview keeps setups in localStorage, which has no damaged-file
// states, so the mock store is always healthy and only "retry" applies.
function getMockStoreStatus(): ProjectStoreStatus {
  return {
    state: localStorage.getItem(PROJECT_STATE_STORAGE_KEY) ? "ok" : "missing",
    reason: null,
    recoveryRequired: false,
    readOnly: false,
    backupAvailable: false,
    revision: currentRevision(),
    totalEntries: getProjectState().profiles.length,
    unavailableEntries: [],
    availableActions: ["retry"],
  };
}

// Preview-mode repository analysis: returns the same passive sample result
// for any folder. Like the desktop app it only describes; nothing is run or
// saved. One analysis at a time; cancel resolves the running one "cancelled".
let mockAnalysis: { cancel(): void } | null = null;

function sampleScanResult(rootName: string, cancelled: boolean): RepoScanResult {
  return {
    status: cancelled ? "cancelled" : "complete",
    partial: cancelled,
    limitsHit: [],
    rootName,
    stats: { directoriesVisited: 4, entriesExamined: 23, filesRead: 2, bytesRead: 912, durationMs: 18 },
    manifests: cancelled
      ? []
      : [
          { path: "package.json", kind: "package-json" },
          { path: "pnpm-lock.yaml", kind: "lockfile" },
          { path: "vite.config.ts", kind: "framework-config" },
          { path: ".nvmrc", kind: "node-version" },
        ],
    manifestsTruncated: false,
    packages: cancelled
      ? []
      : [
          {
            path: "package.json",
            name: "my-app",
            version: "0.1.0",
            private: true,
            packageManager: "pnpm@9.1.0",
            engines: { node: ">=20" },
            scripts: [
              { name: "dev", nameExact: true, command: "vite", commandExact: true },
              { name: "build", nameExact: true, command: "vite build", commandExact: true },
            ],
            scriptsTruncated: false,
            dependencies: ["react", "react-dom"],
            devDependencies: ["vite", "typescript"],
            dependenciesTruncated: false,
            workspaces: [],
            workspacesTruncated: false,
            workspacesExact: true,
          },
        ],
    packagesTruncated: false,
    nodeVersionFiles: cancelled ? [] : [{ path: ".nvmrc", version: "20" }],
    workspace: { signals: [], patterns: [], patternsTruncated: false },
    packageManager: { lockfiles: cancelled ? [] : [{ path: "pnpm-lock.yaml", manager: "pnpm" }], declared: cancelled ? null : "pnpm@9.1.0" },
    envFiles: cancelled ? [] : [".env.example"],
    envFilesTruncated: false,
    skipped: { links: 0, excludedDirectories: 1, sensitiveFiles: 1, depthLimited: 0, unreadable: 0, oversized: 0, otherTypes: 0, changedDuringScan: 0 },
    warnings: [],
    warningsTruncated: false,
  };
}

export const mockRepoRunnerAPI: RepoRunnerAPI = {
  async selectFolder() {
    return "/Users/you/projects/my-app";
  },

  async loadProjectState() {
    return getProjectState();
  },

  async saveProject(profile: ProjectProfile, expectedRevision?: string | null) {
    assertRevision(expectedRevision);
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
    return withRevision(nextState);
  },

  async loadProject() {
    return getProject();
  },

  async getProjectStoreStatus() {
    return getMockStoreStatus();
  },

  async resolveProjectStoreIssue(action: ProjectStoreRecoveryAction) {
    if (action !== "retry") {
      throw new Error(PROJECT_STORE_ERROR_MESSAGES["recovery-not-available"]);
    }
    return getMockStoreStatus();
  },

  async revealProjectStoreFile() {
    emitLog("system", "Revealing the saved setups file is only available in the desktop app.");
  },

  async setActiveProject(profileId: string, expectedRevision?: string | null) {
    assertRevision(expectedRevision);
    const state = getProjectState();
    if (!state.profiles.some((profile) => profile.id === profileId)) {
      throw new Error("Saved repo setup not found.");
    }
    const nextState = { ...state, activeProfileId: profileId };
    persistProjectState(nextState);
    return withRevision(nextState);
  },

  async deleteProject(profileId: string, expectedRevision?: string | null) {
    assertRevision(expectedRevision);
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
    return withRevision(nextState);
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

  async analyzeRepo(repoPath: string) {
    if (typeof repoPath !== "string" || repoPath.length === 0 || repoPath.length > 4096) {
      throw new Error(REPO_ANALYSIS_ERROR_MESSAGES["invalid-path"]);
    }
    if (mockAnalysis) throw new Error(REPO_ANALYSIS_ERROR_MESSAGES["scan-in-progress"]);

    const rootName = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
    return new Promise<RepoScanResult>((resolve) => {
      const finish = (cancelled: boolean) => {
        clearTimeout(timer);
        mockAnalysis = null;
        resolve(sampleScanResult(rootName, cancelled));
      };
      const timer = setTimeout(() => finish(false), 600);
      mockAnalysis = { cancel: () => finish(true) };
    });
  },

  async cancelRepoAnalysis() {
    mockAnalysis?.cancel();
  },
};

export function installMock() {
  if (typeof window !== "undefined" && !window.repoRunner) {
    (window as any).repoRunner = mockRepoRunnerAPI;
    emitLog("system", "RepoRunner ready. (Preview mode — running in browser)");
  }
}







