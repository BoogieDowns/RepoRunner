/*
 * Result model for the read-only repository scanner. Everything here is plain
 * JSON data (safe to send over IPC later). Paths are root-relative with "/"
 * separators; every string taken from the repository has been sanitized and
 * length-limited.
 */

export type RepoScanStatus = "complete" | "truncated" | "cancelled" | "timed-out";

export type RepoScanLimit =
  | "depth"
  | "entries"
  | "directories"
  | "manifests"
  | "bytes"
  | "time"
  | "result-size";

export type ManifestKind =
  | "package-json"
  | "lockfile"
  | "workspace-config"
  | "node-version"
  | "typescript-config"
  | "framework-config"
  | "build-config"
  | "container"
  | "process-file"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "php"
  | "java"
  | "deno"
  | "make";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

export type WorkspaceSignal =
  | "npm-workspaces"
  | "pnpm-workspace"
  | "lerna"
  | "nx"
  | "turbo"
  | "rush";

export type RepoScanWarningCode =
  | "manifest-malformed"
  | "manifest-not-object"
  | "manifest-oversized"
  | "manifest-unreadable"
  | "manifest-limit-reached"
  | "byte-budget-exhausted"
  | "directory-unreadable"
  | "changed-during-scan"
  | "node-version-unrecognized";

export interface RepoScanWarning {
  code: RepoScanWarningCode;
  /** Root-relative path of the file or directory concerned. */
  path: string;
}

export interface PackageScript {
  name: string;
  /** Passive text from package.json. RepoRunner never runs it on its own. */
  command: string;
}

export interface PackageSummary {
  path: string;
  name: string | null;
  version: string | null;
  private: boolean;
  packageManager: string | null;
  engines: { node: string | null };
  scripts: PackageScript[];
  scriptsTruncated: boolean;
  dependencies: string[];
  devDependencies: string[];
  dependenciesTruncated: boolean;
  /** Workspace patterns exactly as declared (text only; never used as paths). */
  workspaces: string[];
}

export interface RepoScanResult {
  status: RepoScanStatus;
  /** True unless every directory within the limits was examined. */
  partial: boolean;
  limitsHit: RepoScanLimit[];
  rootName: string;
  stats: {
    directoriesVisited: number;
    entriesExamined: number;
    filesRead: number;
    bytesRead: number;
    durationMs: number;
  };
  manifests: Array<{ path: string; kind: ManifestKind }>;
  manifestsTruncated: boolean;
  packages: PackageSummary[];
  packagesTruncated: boolean;
  nodeVersionFiles: Array<{ path: string; version: string | null }>;
  workspace: { signals: WorkspaceSignal[]; patterns: string[] };
  packageManager: {
    lockfiles: Array<{ path: string; manager: PackageManagerName }>;
    declared: string | null;
  };
  /** Names of .env-style files. Their contents are never read. */
  envFiles: string[];
  envFilesTruncated: boolean;
  skipped: {
    links: number;
    excludedDirectories: number;
    sensitiveFiles: number;
    depthLimited: number;
    unreadable: number;
    oversized: number;
    otherTypes: number;
  };
  warnings: RepoScanWarning[];
  warningsTruncated: boolean;
}

export type RepoScanErrorCode =
  | "invalid-path"
  | "not-found"
  | "not-a-directory"
  | "root-not-allowed"
  | "unreadable"
  | "scan-in-progress";

const ERROR_MESSAGES: Record<RepoScanErrorCode, string> = {
  "invalid-path": "Choose a full local folder path to analyze.",
  "not-found": "That folder doesn't exist.",
  "not-a-directory": "That path is not a folder.",
  "root-not-allowed":
    "RepoRunner won't analyze a drive root, network share, system folder or your whole home folder. Choose the repository's own folder.",
  unreadable: "RepoRunner couldn't read that folder.",
  "scan-in-progress": "A repository analysis is already running.",
};

/** Fixed, value-free errors (never contain paths or filesystem messages). */
export class RepoScanError extends Error {
  readonly code: RepoScanErrorCode;

  constructor(code: RepoScanErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}
