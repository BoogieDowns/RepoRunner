import type { RepoScanErrorCode, RepoScanResult } from "../electron/repoScanner/types.js";

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

// Repository analysis contract. The result shapes are defined once, next to
// the scanner (electron/repoScanner/types.ts), and re-exported here as types
// only, so no scanner code is bundled into the window.
export type {
  ManifestKind,
  PackageManagerName,
  PackageScript,
  PackageSummary,
  RepoScanErrorCode,
  RepoScanLimit,
  RepoScanResult,
  RepoScanStatus,
  RepoScanWarning,
  RepoScanWarningCode,
  WorkspaceSignal,
} from "../electron/repoScanner/types.js";

/** Scanner errors plus the IPC layer's own refusals. */
export type RepoAnalysisErrorCode =
  | RepoScanErrorCode
  | "invalid-request"
  | "not-allowed"
  | "unavailable"
  | "failed";

/**
 * Fixed, value-free messages for analysis errors (no paths, no filesystem
 * errors). Shared so the renderer can recognise an error that crossed IPC by
 * its exact text.
 */
export const REPO_ANALYSIS_ERROR_MESSAGES: Record<RepoAnalysisErrorCode, string> = {
  "invalid-path": "Choose a full local folder path to analyze.",
  "not-found": "That folder doesn't exist.",
  "not-a-directory": "That path is not a folder.",
  "root-not-allowed":
    "RepoRunner won't analyze a drive root, network share, system folder or your whole home folder. Choose the repository's own folder.",
  unreadable: "RepoRunner couldn't read that folder.",
  // Also returned while a cancelled or timed-out analysis finishes its last filesystem call.
  "scan-in-progress": "A repository analysis is still running or finishing. Try again in a moment.",
  "invalid-request": "RepoRunner received an invalid analysis request.",
  "not-allowed": "Repository analysis isn't available from this page.",
  unavailable: "Repository analysis isn't available while RepoRunner is closing.",
  failed: "RepoRunner couldn't analyze that folder.",
};

// Credential contract (Stage 4B IPC, Stage 4C internal Settings). Metadata
// only: no type here ever carries a stored key.

/** The one credential slot the IPC accepts. */
export const CREDENTIAL_SLOT = "byok-slot-1";
export type CredentialSlotId = typeof CREDENTIAL_SLOT;

/** Same limit as the main-process store (UTF-8 bytes, not characters). */
export const CREDENTIAL_MAX_KEY_BYTES = 8192;

export interface CredentialMetadata {
  configured: boolean;
  mode: "remembered" | "session" | null;
  /** Whether "remember" can be used on this computer. */
  persistence: "available" | "unavailable" | "insecure";
}

export type CredentialIpcErrorCode =
  /** The credential channels are off in this launch (the internal gate is closed). */
  | "not-available"
  | "invalid-request"
  | "invalid-secret"
  | "busy"
  | "failed"
  | "encryption-unavailable"
  | "encryption-insecure"
  | "encrypt-failed"
  | "decrypt-failed"
  | "store-corrupt"
  | "unsupported-version"
  | "read-failed"
  | "write-failed";

export type CredentialIpcResult = { ok: true; status: CredentialMetadata } | { ok: false; error: CredentialIpcErrorCode };

// AI configuration status contract (Stage 4H IPC, Stage 4I internal Settings).
// Metadata only: never an endpoint, model, settings document, revision,
// credential or path. A status here says nothing about connectivity, and
// "providerReadiness" stays "none" while no AI adapter exists.

export type AiConfigStorageState = "missing" | "valid" | "damaged" | "unsupported-version" | "unreadable";

export interface AiConfigStatusView {
  storage: AiConfigStorageState;
  /** A fixed reason code when storage is "damaged"; null otherwise. */
  damage: string | null;
  configurationCount: number;
  active: { id: string; kind: "local-endpoint"; apiStyle: "openai-compatible" | "ollama-native" } | null;
  providerReadiness: "none" | "api-key" | "local-endpoint";
}

export type AiConfigStatusIpcResult = { ok: true; status: AiConfigStatusView } | { ok: false; error: "invalid-request" | "failed" };

/** Fixed, value-free messages for credential errors: no key, path or system detail. */
export const CREDENTIAL_ERROR_MESSAGES: Record<CredentialIpcErrorCode, string> = {
  "not-available": "Saving AI provider keys isn't available in this version of RepoRunner.",
  "invalid-request": "RepoRunner couldn't process that request.",
  "invalid-secret": "That key can't be used. It must not be empty, must fit in 8,192 bytes and can't contain line breaks.",
  busy: "Another key change is still in progress. Try again in a moment.",
  failed: "Something went wrong, so nothing was changed.",
  "encryption-unavailable":
    "This computer can't encrypt keys right now, so RepoRunner can't remember one. You can still keep a key for this session only.",
  "encryption-insecure":
    "No secure keyring is available on this computer, so RepoRunner won't remember keys. You can still keep a key for this session only.",
  "encrypt-failed": "The key couldn't be encrypted, so it wasn't saved.",
  "decrypt-failed": "A saved key couldn't be read.",
  "store-corrupt": "The saved keys file is damaged, so RepoRunner can't read or change it. It hasn't been changed or deleted.",
  "unsupported-version": "The saved keys file comes from a newer version of RepoRunner, so this version won't read or change it.",
  "read-failed": "RepoRunner couldn't read the saved keys file.",
  "write-failed": "RepoRunner couldn't save the change. Your previous key setting is unchanged.",
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
  /**
   * Read-only analysis of a local folder. Never runs anything or saves
   * anything. Check `status`: only "complete" is a full scan.
   */
  analyzeRepo(repoPath: string): Promise<RepoScanResult>;
  /** Stops the running analysis, if any (its call then resolves "cancelled"). */
  cancelRepoAnalysis(): Promise<void>;
  /*
   * Credential methods (Stage 4C): present only in internal development
   * launches (unpackaged, with an explicit opt-in), absent in every packaged
   * build and in the browser mock. They return metadata only; there is no
   * method that returns a stored key.
   */
  credentialStatus?(slot: CredentialSlotId): Promise<CredentialIpcResult>;
  /** The key travels to the main process once and never comes back. */
  setCredential?(slot: CredentialSlotId, secret: string, options: { remember: boolean }): Promise<CredentialIpcResult>;
  removeCredential?(slot: CredentialSlotId): Promise<CredentialIpcResult>;
  /**
   * AI configuration status (Stage 4I): present only in the same internal
   * development launches as the credential methods. Read-only metadata.
   */
  aiConfigStatus?(): Promise<AiConfigStatusIpcResult>;
}

declare global {
  interface Window {
    repoRunner: RepoRunnerAPI;
  }
}

