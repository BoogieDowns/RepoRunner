import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RepoScanError } from "./types.js";

const MAX_PATH_INPUT = 4096;

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

/** Case-insensitive on Windows, exact elsewhere. */
export function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * True when `child` is `parent` or inside it. Uses path.relative (which is
 * case-insensitive on Windows) instead of string prefixes, so "C:\repo-evil"
 * is not inside "C:\repo" and "..foo" directories are handled correctly.
 */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function realpathOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

/** Folders that are never accepted as a repository root. */
function isDisallowedRoot(root: string): boolean {
  if (path.parse(root).root === root) return true; // drive root or "/"

  const home = realpathOrNull(os.homedir());
  if (home && (samePath(root, home) || samePath(root, path.dirname(home)))) return true;

  if (process.platform === "win32") {
    const systemRoot = realpathOrNull(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows");
    if (systemRoot && isWithin(systemRoot, root)) return true;
    for (const variable of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"]) {
      const folder = realpathOrNull(process.env[variable]);
      if (folder && samePath(root, folder)) return true;
    }
    return false;
  }

  const exact = ["/usr", "/var", "/opt", "/home", "/root", "/Users", "/Applications", "/Library", "/private", "/Volumes", "/mnt", "/media", "/srv"];
  const subtrees = ["/proc", "/sys", "/dev", "/etc", "/boot", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/share", "/System", "/private/etc"];
  return exact.some((folder) => samePath(root, folder)) || subtrees.some((folder) => isWithin(folder, root));
}

function isNetworkOrDevicePath(value: string): boolean {
  // \\server\share, \\?\..., \\.\..., //server/share
  return /^[\\/]{2}/.test(value);
}

/**
 * Synchronous checks on the raw input, with no filesystem access: a local,
 * absolute path that isn't a network or device path. Returns the input.
 */
export function checkScanRootSyntax(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_PATH_INPUT || input.includes("\0")) {
    throw new RepoScanError("invalid-path");
  }

  if (process.platform === "win32") {
    if (isNetworkOrDevicePath(input)) throw new RepoScanError("root-not-allowed");
    // Must be a full drive path ("C:\..."); "C:foo" and "\foo" are relative.
    if (!/^[a-zA-Z]:[\\/]/.test(input)) throw new RepoScanError("invalid-path");
  } else if (!path.isAbsolute(input)) {
    throw new RepoScanError("invalid-path");
  }
  return input;
}

/**
 * Validates the user-selected folder and returns its canonical real path.
 * Throws RepoScanError with a fixed code; never echoes the path back.
 */
export async function resolveScanRoot(rawInput: unknown): Promise<string> {
  const input = checkScanRootSyntax(rawInput);

  let real: string;
  try {
    real = await fs.promises.realpath(path.resolve(input));
  } catch (error) {
    const code = errorCode(error);
    throw new RepoScanError(code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "unreadable");
  }

  if (process.platform === "win32" && isNetworkOrDevicePath(real)) throw new RepoScanError("root-not-allowed");

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(real);
  } catch (error) {
    throw new RepoScanError(errorCode(error) === "ENOENT" ? "not-found" : "unreadable");
  }
  if (!stats.isDirectory()) throw new RepoScanError("not-a-directory");
  if (isDisallowedRoot(real)) throw new RepoScanError("root-not-allowed");

  return real;
}
