export type ServiceStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed"
  | "unknown";

export type LogSource =
  | "system"
  | "git"
  | "install"
  | "frontend"
  | "backend";

export interface LogEntry {
  id: string;
  timestamp: number;
  source: LogSource;
  text: string;
}

export interface ProjectProfile {
  id: string;
  name: string;
  repoPath: string;
  installCommand: string;
  frontendCommand: string;
  backendCommand: string;
  previewUrl: string;
  frontendPort?: number;
  backendPort?: number;
}

export const MAX_FREE_REPO_PROFILES = 5;

export interface ProjectProfilesState {
  profiles: ProjectProfile[];
  activeProfileId: string | null;
  /**
   * Revision of the saved file this state was read from (null when no file
   * exists yet). Pass it back to mutations to reject stale changes.
   */
  revision?: string | null;
}

export type ProjectStoreState =
  | "missing"
  | "ok"
  | "needs-recovery"
  | "unreadable"
  | "unsupported-version";

export type ProjectStoreRecoveryAction =
  | "retry"
  | "restore-backup"
  | "start-fresh"
  | "discard-invalid-entries";

/** Value-free description of the saved setups file. Never contains paths, commands or file contents. */
export interface ProjectStoreStatus {
  state: ProjectStoreState;
  /** Machine-readable cause for a non-ok state, e.g. "malformed-json". */
  reason: string | null;
  /** Saving is blocked until the user resolves the problem. */
  recoveryRequired: boolean;
  /** RepoRunner will not modify (or run) the saved setups in this state. */
  readOnly: boolean;
  /** A backup exists and loads cleanly. */
  backupAvailable: boolean;
  revision: string | null;
  totalEntries: number;
  unavailableEntries: { index: number; reason: string }[];
  availableActions: ProjectStoreRecoveryAction[];
}

export interface ServiceStatuses {
  frontend: ServiceStatus;
  backend: ServiceStatus;
}

export interface RepoRunnerAPI {
  selectFolder(): Promise<string | null>;
  loadProjectState(): Promise<ProjectProfilesState>;
  saveProject(profile: ProjectProfile, expectedRevision?: string | null): Promise<ProjectProfilesState>;
  loadProject(): Promise<ProjectProfile | null>;
  setActiveProject(profileId: string, expectedRevision?: string | null): Promise<ProjectProfilesState>;
  deleteProject(profileId: string, expectedRevision?: string | null): Promise<ProjectProfilesState>;
  getProjectStoreStatus(): Promise<ProjectStoreStatus>;
  /**
   * Explicit recovery action. All actions except "retry" require the revision
   * from the status the user confirmed (null when there is no file).
   */
  resolveProjectStoreIssue(
    action: ProjectStoreRecoveryAction,
    expectedRevision?: string | null
  ): Promise<ProjectStoreStatus>;
  revealProjectStoreFile(): Promise<void>;
  pullLatest(): Promise<void>;
  runInstall(): Promise<void>;
  startFrontend(): Promise<void>;
  startBackend(): Promise<void>;
  stopServices(): Promise<void>;
  restartAll(): Promise<void>;
  openPreview(): Promise<void>;
  copyLogs(): Promise<void>;
  clearLogs(): Promise<void>;
  onLog(callback: (entry: LogEntry) => void): () => void;
  getStatuses(): Promise<ServiceStatuses>;
  onStatus(callback: (statuses: ServiceStatuses) => void): () => void;
}

declare global {
  interface Window {
    repoRunner: RepoRunnerAPI;
  }
}

