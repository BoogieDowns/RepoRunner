// Reusable RepoScanResult builders for insight tests. Project files are
// classified with the scanner's own rules, so fixtures look like real scans.
import { lockfileManager, manifestKind, workspaceSignalForFile } from "../../../electron/repoScanner/scanRules.js";
import type { PackageSummary, RepoScanResult, WorkspaceSignal } from "../../../src/types";

export interface PkgOptions {
  name?: string | null;
  deps?: string[];
  dev?: string[];
  scripts?: Record<string, string>;
  packageManager?: string | null;
  node?: string | null;
  workspaces?: string[];
  scriptsTruncated?: boolean;
  dependenciesTruncated?: boolean;
  workspacesExact?: boolean;
}

export function pkg(path: string, options: PkgOptions = {}): PackageSummary {
  return {
    path,
    name: options.name === undefined ? path.split("/").slice(-2, -1)[0] ?? "root" : options.name,
    version: "1.0.0",
    private: true,
    packageManager: options.packageManager ?? null,
    engines: { node: options.node ?? null },
    // Builders describe exact package.json names; scriptNames.test.ts covers altered ones.
    scripts: Object.entries(options.scripts ?? {}).map(([name, command]) => ({ name, nameExact: true, command })),
    scriptsTruncated: options.scriptsTruncated ?? false,
    dependencies: options.deps ?? [],
    devDependencies: options.dev ?? [],
    dependenciesTruncated: options.dependenciesTruncated ?? false,
    workspaces: options.workspaces ?? [],
    workspacesTruncated: false,
    workspacesExact: options.workspacesExact ?? true,
  };
}

export interface ScanOptions {
  packages?: PackageSummary[];
  /** Extra project files by root-relative path (package.json paths are added automatically). */
  files?: string[];
  nodeVersionFiles?: string[];
  status?: RepoScanResult["status"];
  limitsHit?: RepoScanResult["limitsHit"];
  manifestsTruncated?: boolean;
  packagesTruncated?: boolean;
  warnings?: RepoScanResult["warnings"];
}

export function scan(options: ScanOptions = {}): RepoScanResult {
  const packages = options.packages ?? [];
  const paths = [...packages.map((p) => p.path), ...(options.files ?? [])];
  const manifests = paths
    .map((path) => ({ path, kind: manifestKind(path.split("/").pop()!) }))
    .filter((m): m is { path: string; kind: NonNullable<typeof m.kind> } => m.kind !== null);
  const lockfiles = paths
    .map((path) => ({ path, manager: lockfileManager(path.split("/").pop()!) }))
    .filter((l): l is { path: string; manager: NonNullable<typeof l.manager> } => l.manager !== null);
  const signals = new Set<WorkspaceSignal>();
  for (const path of paths) {
    if (path.includes("/")) continue;
    const signal = workspaceSignalForFile(path);
    if (signal) signals.add(signal);
  }
  const root = packages.find((p) => p.path === "package.json");
  if (root && root.workspaces.length > 0) signals.add("npm-workspaces");
  const status = options.status ?? "complete";

  return {
    status,
    partial: status !== "complete",
    limitsHit: options.limitsHit ?? [],
    rootName: "repo",
    stats: { directoriesVisited: 1, entriesExamined: paths.length, filesRead: packages.length, bytesRead: 100, durationMs: 1 },
    manifests,
    manifestsTruncated: options.manifestsTruncated ?? false,
    packages,
    packagesTruncated: options.packagesTruncated ?? false,
    nodeVersionFiles: (options.nodeVersionFiles ?? []).map((path) => ({ path, version: "20" })),
    workspace: { signals: [...signals], patterns: root?.workspaces ?? [], patternsTruncated: false },
    packageManager: { lockfiles, declared: root?.packageManager ?? null },
    envFiles: [],
    envFilesTruncated: false,
    skipped: { links: 0, excludedDirectories: 0, sensitiveFiles: 0, depthLimited: 0, unreadable: 0, oversized: 0, otherTypes: 0, changedDuringScan: 0 },
    warnings: options.warnings ?? [],
    warningsTruncated: false,
  };
}

/** Recursively freezes a value so any mutation throws. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
