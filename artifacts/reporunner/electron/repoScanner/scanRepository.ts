import fs from "node:fs";
import path from "node:path";
import { parseNodeVersion, parsePackageJson, sanitizePathSegments, sanitizeText } from "./parseManifests.js";
import { checkScanRootSyntax, isWithin, resolveScanRoot, samePath } from "./scanRoot.js";
import {
  SCAN_LIMITS,
  TEXT_LIMITS,
  isEnvFile,
  isExcludedDirectory,
  isSensitiveFile,
  lockfileManager,
  manifestKind,
  readableFileType,
  workspaceSignalForFile,
  type ScanLimits,
} from "./scanRules.js";
import type {
  ManifestKind,
  PackageManagerName,
  PackageSummary,
  RepoScanLimit,
  RepoScanResult,
  RepoScanWarningCode,
  WorkspaceSignal,
} from "./types.js";

/*
 * Read-only repository scanner.
 *
 * - Filesystem APIs only: no child processes, no network, nothing executed.
 * - Breadth-first, so the root and shallow folders are covered first.
 * - Links (symlinks and Windows junctions) are never followed. Before any
 *   directory is entered or file opened, it is re-checked with lstat and its
 *   real path must equal the expected path inside the real root.
 * - Only package.json, .nvmrc and .node-version are ever opened; everything
 *   else is recognised by name. Paths come only from directory listings,
 *   never from file contents (e.g. package.json "workspaces").
 * - Hard limits on depth, entries, directories, files, bytes, time and result
 *   size; hitting one marks the result as partial.
 *
 * Residual race: between the final check and opendir()/open() another
 * process could swap a path for a link. Files are opened with O_NOFOLLOW where
 * the OS supports it and their identity (device + inode/file ID) is compared
 * with the pre-open lstat; directories have no such handle-based check, so a
 * swap in that tiny window could expose one directory listing (names only).
 *
 * Some runtimes (Electron 35 / Node 22 on Windows) report device 0 from every
 * path-based stat; only handle-based fstat has the real volume. Then the
 * opened file must match the lstat file ID and be on the root's volume, read
 * from a handle on the root directory. Without that volume, files are skipped.
 */

export interface ScanOptions {
  /** Aborting stops all further reads; the scan returns a "cancelled" result. */
  signal?: AbortSignal;
  /** Overrides for tests. */
  limits?: Partial<ScanLimits>;
}

interface QueuedDirectory {
  abs: string;
  segments: string[];
  depth: number;
}

const OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * The root's volume, from a read-only handle on the root directory (nothing
 * is read through it). Null if it can't be confirmed to be the root.
 */
async function readRootDevice(root: string): Promise<bigint | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const before = await fs.promises.lstat(root, { bigint: true });
    handle = await fs.promises.open(root, OPEN_FLAGS);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.ino !== before.ino) return null;
    if (before.dev !== 0n && opened.dev !== before.dev) return null;
    return opened.dev;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Same file as the pre-open lstat (see the note on device 0 above). */
function isSameFile(before: fs.BigIntStats, opened: fs.BigIntStats, rootDevice: bigint | null): boolean {
  if (!opened.isFile() || opened.ino !== before.ino) return false;
  if (before.dev !== 0n) return opened.dev === before.dev;
  return rootDevice !== null && opened.dev === rootDevice;
}

/**
 * A started scan. `result` is the caller's answer: on cancel or timeout it
 * settles at once with what was gathered so far, even while a filesystem call
 * is still pending (Node can't interrupt one). `settled` never rejects and
 * resolves only when all scanner work, including that call, has finished.
 */
export interface ScanRun {
  result: Promise<RepoScanResult>;
  settled: Promise<void>;
}

export interface StartScanOptions extends ScanOptions {
  /** Called synchronously when the work has finished (before `result` on a normal finish). */
  onSettled?: () => void;
}

export function scanRepository(rootInput: unknown, options: ScanOptions = {}): Promise<RepoScanResult> {
  return startScan(rootInput, options).result;
}

export function startScan(rootInput: unknown, options: StartScanOptions = {}): ScanRun {
  let rootHint: string;
  try {
    rootHint = checkScanRootSyntax(rootInput);
  } catch (error) {
    options.onSettled?.();
    return { result: Promise.reject(error), settled: Promise.resolve() };
  }

  const limits: ScanLimits = { ...SCAN_LIMITS, ...options.limits };
  const startedAt = Date.now();

  // Cancel and the time budget are watched before anything that can block,
  // including resolving the root.
  let stopReason: "cancelled" | "timed-out" | null = null;
  let signalStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => (signalStop = resolve));
  const stop = (reason: "cancelled" | "timed-out") => {
    if (stopReason) return;
    stopReason = reason;
    signalStop();
  };
  const onAbort = () => stop("cancelled");
  const timer = setTimeout(() => stop("timed-out"), limits.timeBudgetMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const stopWatching = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const stopped = () => {
    if (!stopReason && Date.now() - startedAt >= limits.timeBudgetMs) stop("timed-out");
    return stopReason !== null;
  };

  let root: string | null = null;
  let rootDevice: bigint | null = null;

  const limitsHit = new Set<RepoScanLimit>();
  const stats = { directoriesVisited: 0, entriesExamined: 0, filesRead: 0, bytesRead: 0, durationMs: 0 };
  const skipped = { links: 0, excludedDirectories: 0, sensitiveFiles: 0, depthLimited: 0, unreadable: 0, oversized: 0, otherTypes: 0, changedDuringScan: 0 };
  const manifests: Array<{ path: string; kind: ManifestKind }> = [];
  let manifestsTruncated = false;
  const packages: PackageSummary[] = [];
  const nodeVersionFiles: Array<{ path: string; version: string | null }> = [];
  const signals = new Set<WorkspaceSignal>();
  let workspacePatterns: string[] = [];
  let workspacePatternsTruncated = false;
  const lockfiles: Array<{ path: string; manager: PackageManagerName }> = [];
  let declaredPackageManager: string | null = null;
  const envFiles: string[] = [];
  let envFilesTruncated = false;
  const warnings: Array<{ code: RepoScanWarningCode; path: string }> = [];
  let warningsTruncated = false;
  let packageJsonReads = 0;
  let byteBudgetExhausted = false;

  const warn = (code: RepoScanWarningCode, relativePath: string) => {
    // Counted even when the warning list itself is full.
    if (code === "changed-during-scan") skipped.changedDuringScan++;
    if (warnings.length >= limits.maxWarnings) {
      warningsTruncated = true;
      return;
    }
    warnings.push({ code, path: relativePath });
  };

  /** Directory still a real, non-link directory at its expected place inside the root. */
  const verifyDirectory = async (abs: string): Promise<boolean> => {
    try {
      const st = await fs.promises.lstat(abs);
      if (!st.isDirectory() || st.isSymbolicLink()) return false;
      const real = await fs.promises.realpath(abs);
      return root !== null && samePath(real, abs) && isWithin(root, real);
    } catch {
      return false;
    }
  };

  /** Reads one allowed file with every safety check; null if it must be skipped. */
  const readFileSafely = async (abs: string, rel: string, maxBytes: number): Promise<Uint8Array | null> => {
    if (byteBudgetExhausted) return null;

    let before: fs.BigIntStats;
    try {
      before = await fs.promises.lstat(abs, { bigint: true });
    } catch {
      skipped.unreadable++;
      warn("manifest-unreadable", rel);
      return null;
    }
    if (!before.isFile()) {
      warn("changed-during-scan", rel);
      return null;
    }
    try {
      const real = await fs.promises.realpath(abs);
      if (root === null || !samePath(real, abs) || !isWithin(root, real)) {
        warn("changed-during-scan", rel);
        return null;
      }
    } catch {
      skipped.unreadable++;
      warn("manifest-unreadable", rel);
      return null;
    }

    if (before.size > BigInt(maxBytes)) {
      skipped.oversized++;
      warn("manifest-oversized", rel);
      return null;
    }
    const remaining = limits.maxTotalBytes - stats.bytesRead;
    if (Number(before.size) > remaining) {
      byteBudgetExhausted = true;
      limitsHit.add("bytes");
      warn("byte-budget-exhausted", rel);
      return null;
    }

    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(abs, OPEN_FLAGS);
    } catch {
      skipped.unreadable++;
      warn("manifest-unreadable", rel);
      return null;
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!isSameFile(before, opened, rootDevice)) {
        warn("changed-during-scan", rel);
        return null;
      }
      const cap = Math.min(maxBytes, remaining);
      const buffer = Buffer.alloc(cap + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > cap) {
        // Grew past the limit after the size check.
        skipped.oversized++;
        warn("manifest-oversized", rel);
        return null;
      }
      stats.bytesRead += total;
      stats.filesRead++;
      return buffer.subarray(0, total);
    } catch {
      skipped.unreadable++;
      warn("manifest-unreadable", rel);
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const handleFile = async (directory: QueuedDirectory, name: string) => {
    const segments = [...directory.segments, name];
    const rel = sanitizePathSegments(segments);

    if (isEnvFile(name)) {
      skipped.sensitiveFiles++;
      if (envFiles.length < limits.maxEnvFiles) envFiles.push(rel);
      else envFilesTruncated = true;
      return;
    }
    if (isSensitiveFile(name)) {
      skipped.sensitiveFiles++;
      return;
    }

    const kind = manifestKind(name);
    if (kind) {
      if (manifests.length < limits.maxManifests) manifests.push({ path: rel, kind });
      else manifestsTruncated = true;
    }
    const manager = lockfileManager(name);
    if (manager) lockfiles.push({ path: rel, manager });
    const signal = workspaceSignalForFile(name);
    if (signal && directory.depth === 0) signals.add(signal);

    const readable = readableFileType(name);
    const abs = path.join(directory.abs, name);
    if (readable === "package-json") {
      if (packageJsonReads >= limits.maxPackageJsonFiles) {
        if (!limitsHit.has("manifests")) warn("manifest-limit-reached", rel);
        limitsHit.add("manifests");
        return;
      }
      packageJsonReads++;
      const bytes = await readFileSafely(abs, rel, limits.maxManifestBytes);
      if (!bytes) return;
      const parsed = parsePackageJson(bytes, rel, limits);
      if (!parsed.ok) {
        warn(parsed.warning, rel);
        return;
      }
      packages.push(parsed.summary);
      if (directory.depth === 0) {
        declaredPackageManager = parsed.summary.packageManager;
        if (parsed.summary.workspaces.length > 0) {
          signals.add("npm-workspaces");
          workspacePatterns = parsed.summary.workspaces;
          workspacePatternsTruncated = parsed.summary.workspacesTruncated;
        }
      }
    } else if (readable === "node-version") {
      const bytes = await readFileSafely(abs, rel, limits.maxNodeVersionBytes);
      if (!bytes) return;
      const version = parseNodeVersion(bytes);
      if (version === null) warn("node-version-unrecognized", rel);
      nodeVersionFiles.push({ path: rel, version });
    }
  };

  /** What an entry is; unknown types (some FUSE/network filesystems) are classified with lstat. */
  const classifyEntry = async (directory: QueuedDirectory, entry: fs.Dirent): Promise<"link" | "directory" | "file" | "other" | null> => {
    if (entry.isSymbolicLink()) return "link";
    if (entry.isDirectory()) return "directory";
    if (entry.isFile()) return "file";
    if (entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice()) return "other";
    try {
      // lstat never follows a link; a directory is still re-verified before it is listed.
      const st = await fs.promises.lstat(path.join(directory.abs, entry.name));
      if (st.isSymbolicLink()) return "link";
      if (st.isDirectory()) return "directory";
      if (st.isFile()) return "file";
      return "other";
    } catch {
      skipped.unreadable++;
      warn("entry-unreadable", sanitizePathSegments([...directory.segments, entry.name]));
      return null;
    }
  };

  const traverse = async (scanRoot: string) => {
    const queue: Array<QueuedDirectory | undefined> = [{ abs: scanRoot, segments: [], depth: 0 }];
    let head = 0;
    let stopTraversal = false;

    while (head < queue.length && !stopTraversal) {
      if (stopped()) break;
      if (stats.directoriesVisited >= limits.maxDirectories) {
        limitsHit.add("directories");
        break;
      }
      const directory = queue[head]!;
      queue[head++] = undefined; // release memory as we go

      if (directory.depth > 0 && !(await verifyDirectory(directory.abs))) {
        warn("changed-during-scan", sanitizePathSegments(directory.segments));
        continue;
      }
      if (stopped()) break;

      let dir: fs.Dir;
      try {
        // Small buffer: entries are pulled incrementally, never the whole listing at once.
        dir = await fs.promises.opendir(directory.abs, { bufferSize: 32 });
      } catch {
        skipped.unreadable++;
        warn("directory-unreadable", sanitizePathSegments(directory.segments));
        continue;
      }
      stats.directoriesVisited++;

      try {
        for await (const entry of dir) {
          if (stopped()) break;
          if (stats.entriesExamined >= limits.maxEntries) {
            limitsHit.add("entries");
            stopTraversal = true;
            break;
          }
          stats.entriesExamined++;

          const kind = await classifyEntry(directory, entry);
          if (kind === null) continue;
          if (stopped()) break;
          if (kind === "link") {
            skipped.links++;
          } else if (kind === "directory") {
            if (isExcludedDirectory(entry.name)) {
              skipped.excludedDirectories++;
            } else if (directory.depth + 1 > limits.maxDepth) {
              skipped.depthLimited++;
              limitsHit.add("depth");
            } else {
              queue.push({ abs: path.join(directory.abs, entry.name), segments: [...directory.segments, entry.name], depth: directory.depth + 1 });
            }
          } else if (kind === "file") {
            await handleFile(directory, entry.name);
          } else {
            skipped.otherTypes++;
          }
        }
      } catch {
        skipped.unreadable++;
        warn("directory-unreadable", sanitizePathSegments(directory.segments));
      } finally {
        await dir.close().catch(() => undefined); // already closed after full iteration
      }
    }
  };

  /** The caller's result, built from a copy of the state at this moment. */
  const buildResult = (): RepoScanResult => {
    const resultLimits = new Set(limitsHit);
    if (stopReason === "timed-out") resultLimits.add("time");
    const result: RepoScanResult = structuredClone({
      status: "complete",
      partial: false,
      limitsHit: [],
      rootName: sanitizeText(path.basename(root ?? rootHint), TEXT_LIMITS.rootName),
      stats: { ...stats, durationMs: Date.now() - startedAt },
      manifests,
      manifestsTruncated,
      packages,
      packagesTruncated: false,
      nodeVersionFiles,
      workspace: { signals: [...signals], patterns: workspacePatterns, patternsTruncated: workspacePatternsTruncated },
      packageManager: { lockfiles: lockfiles.slice(0, limits.maxManifests), declared: declaredPackageManager },
      envFiles,
      envFilesTruncated,
      skipped,
      warnings,
      warningsTruncated,
    } satisfies RepoScanResult);

    fitResultSize(result, limits.maxResultBytes, resultLimits);

    result.limitsHit = [...resultLimits];
    result.status =
      stopReason ?? (result.limitsHit.length > 0 || hasTruncatedLists(result) || hasUnanalyzedContent(result) ? "truncated" : "complete");
    result.partial = result.status !== "complete";
    return result;
  };

  const work = (async () => {
    root = await resolveScanRoot(rootInput);
    if (stopped()) return;
    rootDevice = await readRootDevice(root);
    if (stopped()) return;
    await traverse(root);
  })();

  // Exactly one answer per scan: whichever comes first of the work finishing
  // or a stop request. Later work can't change what was delivered (it's a copy).
  let delivered = false;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => (resolveSettled = resolve));
  const result = new Promise<RepoScanResult>((resolve, reject) => {
    const answer = (build: () => RepoScanResult) => {
      if (delivered) return;
      delivered = true;
      stopWatching();
      try {
        resolve(build());
      } catch (error) {
        reject(error);
      }
    };
    const finishWork = () => {
      stopWatching();
      try {
        options.onSettled?.();
      } finally {
        resolveSettled();
      }
    };
    work.then(
      () => {
        finishWork();
        answer(buildResult);
      },
      (error: unknown) => {
        finishWork();
        if (delivered) return; // already answered (stopped); nothing more to report
        delivered = true;
        reject(error);
      },
    );
    void stopRequested.then(() => answer(buildResult));
  });
  return { result, settled };
}

function hasTruncatedLists(result: RepoScanResult): boolean {
  return (
    result.manifestsTruncated ||
    result.packagesTruncated ||
    result.envFilesTruncated ||
    result.warningsTruncated ||
    result.workspace.patternsTruncated ||
    result.packages.some((pkg) => pkg.workspacesTruncated || pkg.scriptsTruncated || pkg.dependenciesTruncated)
  );
}

/**
 * Something in scope could not be analyzed: an unreadable folder (at open or
 * mid-listing), or a folder or allowed file that was unreadable, too large or
 * changed during the scan. Deliberately excluded folders and links don't count.
 */
function hasUnanalyzedContent(result: RepoScanResult): boolean {
  const { unreadable, oversized, changedDuringScan } = result.skipped;
  return unreadable + oversized + changedDuringScan > 0;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Drops the least important data until the serialized result fits. */
function fitResultSize(result: RepoScanResult, maxBytes: number, limitsHit: Set<RepoScanLimit>): void {
  const steps: Array<() => boolean> = [
    () => {
      if (result.warnings.length === 0) return false;
      result.warnings.splice(Math.floor(result.warnings.length / 2));
      result.warningsTruncated = true;
      return true;
    },
    () => {
      const pkg = result.packages.find((p) => p.dependencies.length > 0 || p.devDependencies.length > 0);
      if (!pkg) return false;
      pkg.dependencies = [];
      pkg.devDependencies = [];
      pkg.dependenciesTruncated = true;
      return true;
    },
    () => {
      if (result.manifests.length === 0) return false;
      result.manifests.splice(Math.floor(result.manifests.length / 2));
      result.manifestsTruncated = true;
      return true;
    },
    () => {
      if (result.packages.length === 0) return false;
      result.packages.pop();
      result.packagesTruncated = true;
      return true;
    },
    () => {
      if (result.envFiles.length === 0) return false;
      result.envFiles.splice(Math.floor(result.envFiles.length / 2));
      result.envFilesTruncated = true;
      return true;
    },
    () => {
      if (result.packageManager.lockfiles.length === 0 && result.nodeVersionFiles.length === 0) return false;
      result.packageManager.lockfiles = [];
      result.nodeVersionFiles = [];
      return true;
    },
    () => {
      if (result.workspace.patterns.length === 0) return false;
      result.workspace.patterns = [];
      result.workspace.patternsTruncated = true;
      return true;
    },
  ];

  let size = serializedBytes(result);
  for (const step of steps) {
    while (size > maxBytes && step()) {
      limitsHit.add("result-size");
      size = serializedBytes(result);
    }
    if (size <= maxBytes) return;
  }
}
