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

/** Newest log entries kept in memory, in the main process and in the window. Older ones are dropped. */
export const MAX_RETAINED_LOG_ENTRIES = 5000;

/** Returns `entries` with `entry` appended, keeping only the newest `max`. Does not modify `entries`. */
export function appendRetainedLog<T>(
  entries: readonly T[],
  entry: T,
  max: number = MAX_RETAINED_LOG_ENTRIES
): T[] {
  const overflow = entries.length + 1 - max;
  const kept = overflow > 0 ? entries.slice(overflow) : entries.slice();
  kept.push(entry);
  return kept;
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

export type ProjectStoreErrorCode =
  | "needs-recovery"
  | "unreadable"
  | "unsupported-version"
  | "conflict"
  | "backup-failed"
  | "write-failed"
  | "write-unverified"
  | "profile-unavailable"
  | "recovery-not-available"
  | "backup-unavailable"
  | "recovery-copy-failed";

/**
 * Fixed, value-free messages for saved-setups errors. Shared so the renderer
 * can recognise an error that crossed IPC by its exact text.
 */
export const PROJECT_STORE_ERROR_MESSAGES: Record<ProjectStoreErrorCode, string> = {
  "needs-recovery":
    "RepoRunner found a problem with your saved repo setups and has paused saving so nothing is overwritten. Your saved file has not been changed.",
  unreadable:
    "RepoRunner couldn't open your saved repo setups file. Saving is paused so nothing is overwritten. Your saved file has not been changed.",
  "unsupported-version":
    "Your saved repo setups were created by a newer version of RepoRunner. This version won't change or run them. Update RepoRunner to continue.",
  // Rejected before the primary file was replaced.
  conflict:
    "Your saved repo setups changed since RepoRunner last read them, so this change was not saved. The newer saved setups were kept. Review them and try again.",
  "backup-failed":
    "RepoRunner couldn't back up your saved repo setups, so it didn't save the change. Your saved setups were not changed.",
  // Failed before the primary file was replaced.
  "write-failed":
    "RepoRunner couldn't save your repo setups. Your previously saved setups were not changed.",
  // The primary file was replaced, but reading it back did not match.
  "write-unverified":
    "Your change may have been saved, but RepoRunner couldn't confirm it. Check your saved repo setups before making more changes.",
  "profile-unavailable":
    "This saved repo setup can't be used because its saved details are incomplete or invalid.",
  "recovery-not-available":
    "That recovery option isn't available for your saved repo setups right now. Nothing was changed.",
  "backup-unavailable":
    "RepoRunner couldn't find a usable backup of your saved repo setups. Nothing was changed.",
  "recovery-copy-failed":
    "RepoRunner couldn't save a copy of your current saved repo setups, so it didn't make any changes.",
};

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

