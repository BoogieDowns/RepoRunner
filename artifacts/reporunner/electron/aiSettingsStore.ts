import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  AI_SETTINGS_MAX_BYTES,
  emptyAiSettings,
  parseAiSettings,
  serializeAiSettings,
  type AiSettings,
  type AiSettingsError,
} from "../src/lib/ai/settingsSchema.js";

/*
 * Main-process storage for the non-secret AI settings document (Stage 4F).
 * Not connected to startup, IPC, the preload or any UI: nothing creates an
 * instance yet, so the app's behavior is unchanged.
 *
 * - One fixed file, reporunner-ai-settings.json, in a directory the caller
 *   supplies (the app's userData in a future stage). Separate from
 *   reporunner-project.json and reporunner-credentials.json.
 * - Every byte read or written goes through the Stage 4E schema
 *   (parseAiSettings / serializeAiSettings). There is no second validator.
 * - The document holds no secrets, but its contents are treated as untrusted.
 *   A valid file says nothing about connectivity or AI readiness.
 * - Constructing the store and reading a missing file write nothing.
 * - A damaged file, a newer version, an unreadable file, or anything at the
 *   path that isn't a regular file (a symlink, a directory) is reported and
 *   never overwritten, deleted, repaired or treated as empty.
 * - Saves replace the whole document: serialize, write a new temp file
 *   exclusively (owner-only where supported), sync it, read it back, then
 *   rename it over the old one. A failed save leaves the old file as it was
 *   and removes its temp file. No backups are kept.
 * - Each save names the revision it was based on; if the file changed since,
 *   the save is refused ("conflict"), so updates can't be lost.
 * - Operations on one store run one at a time, in call order. Another process
 *   writing the same file isn't guarded against here: RepoRunner's
 *   single-instance lock keeps a second app instance away, and the app should
 *   use a single store per process.
 * - Errors are fixed codes: never paths, file contents or system messages.
 *   The store never logs, and never touches credentials or the network.
 *
 * Windows: fs.renameSync replaces an existing file (MoveFileEx with
 * MOVEFILE_REPLACE_EXISTING). If another program holds the file open without
 * delete sharing (an antivirus scan, an editor), the rename fails with
 * EPERM/EBUSY/EACCES; the save then reports "write-failed" with the old file
 * unchanged. It isn't retried. Mode 0o600 has no effect on Windows; the file
 * inherits userData's per-user permissions. A directory can't be synced on
 * Windows; NTFS journals the rename.
 */

export const AI_SETTINGS_FILE = "reporunner-ai-settings.json";

/** Why a file was judged damaged. Never includes any of its contents. */
export type AiSettingsDamage = Exclude<AiSettingsError, "unsupported-version"> | "not-a-regular-file" | "invalid-encoding";

export type AiSettingsLoadResult =
  /** No file: the empty document, in memory only. Nothing is selected. */
  | { status: "missing"; settings: AiSettings; revision: null }
  | { status: "valid"; settings: AiSettings; revision: string }
  | { status: "damaged"; reason: AiSettingsDamage }
  /** Written by a newer RepoRunner. Left alone; not treated as empty. */
  | { status: "unsupported-version" }
  /** The file system refused the read (permissions, locks, I/O errors). */
  | { status: "unreadable" };

export type AiSettingsSaveError =
  /** The document doesn't pass the schema; `detail` says which rule. */
  | "invalid-settings"
  /** The file changed since the revision the save was based on. */
  | "conflict"
  /** The current file is damaged, newer or unreadable, so it isn't overwritten. */
  | "damaged"
  | "unsupported-version"
  | "unreadable"
  | "write-failed";

export type AiSettingsSaveResult =
  | { ok: true; settings: AiSettings; revision: string }
  | { ok: false; error: "invalid-settings"; detail: AiSettingsError }
  | { ok: false; error: Exclude<AiSettingsSaveError, "invalid-settings"> };

/** The file operations the store uses (Node's fs by default; replaceable in tests). */
export interface AiSettingsFs {
  lstatSync(file: string): { isFile(): boolean; size: number };
  openSync(file: string, flags: string | number, mode?: number): number;
  fstatSync(fd: number): { isFile(): boolean; size: number };
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
}

export interface AiSettingsStoreOptions {
  /** The directory for the settings file: an absolute path (the app's userData). */
  dir: string;
  fs?: AiSettingsFs;
  platform?: NodeJS.Platform;
}

const errorCode = (error: unknown) => (error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined);
const revisionOf = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Reads fail with one of these, inside the store only. */
class LoadFailure {
  constructor(readonly result: Exclude<AiSettingsLoadResult, { status: "missing" } | { status: "valid" }>) {}
}

type Current = { status: "missing"; settings: AiSettings; revision: null } | { status: "valid"; settings: AiSettings; revision: string };

export class AiSettingsStore {
  private readonly dir: string;
  private readonly fs: AiSettingsFs;
  private readonly platform: NodeJS.Platform;
  private queue: Promise<unknown> = Promise.resolve();

  /** Touches nothing on disk. */
  constructor(options: AiSettingsStoreOptions) {
    if (typeof options.dir !== "string" || !path.isAbsolute(options.dir) || options.dir.includes("\0")) {
      throw new TypeError("AiSettingsStore needs an absolute directory.");
    }
    this.dir = options.dir;
    this.fs = options.fs ?? (fs as unknown as AiSettingsFs);
    this.platform = options.platform ?? process.platform;
  }

  /** The settings, or why they can't be used. A missing file gives the empty document and writes nothing. */
  load(): Promise<AiSettingsLoadResult> {
    return this.serialized(() => {
      try {
        return this.readCurrent();
      } catch (failure) {
        if (failure instanceof LoadFailure) return failure.result;
        return { status: "unreadable" } as const;
      }
    });
  }

  /**
   * Replaces the whole document. `expectedRevision` is the revision from the
   * load (or save) this change is based on: null when the file was missing.
   */
  save(settings: unknown, expectedRevision: string | null): Promise<AiSettingsSaveResult> {
    return this.serialized((): AiSettingsSaveResult => {
      // Validate and serialize before touching anything.
      const serialized = serializeAiSettings(settings);
      if (!serialized.ok) return { ok: false, error: "invalid-settings", detail: serialized.error };
      const bytes = Buffer.from(serialized.text, "utf8");
      if (bytes.length > AI_SETTINGS_MAX_BYTES) return { ok: false, error: "invalid-settings", detail: "too-large" };
      // The bytes must read back as exactly this document.
      const reparsed = parseAiSettings(serialized.text);
      if (!reparsed.ok) return { ok: false, error: "invalid-settings", detail: reparsed.error };

      let current: Current;
      try {
        current = this.readCurrent();
      } catch (failure) {
        const status = failure instanceof LoadFailure ? failure.result.status : "unreadable";
        return { ok: false, error: status };
      }
      if (current.revision !== expectedRevision) return { ok: false, error: "conflict" };

      if (!this.replaceFile(bytes)) return { ok: false, error: "write-failed" };
      return { ok: true, settings: reparsed.settings, revision: revisionOf(bytes) };
    });
  }

  private serialized<T>(operation: () => T): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get filePath(): string {
    return path.join(this.dir, AI_SETTINGS_FILE);
  }

  /** The current file's state; throws LoadFailure for anything other than missing or valid. */
  private readCurrent(): Current {
    let info: { isFile(): boolean; size: number };
    try {
      // lstat: a symlink is reported as itself, never followed.
      info = this.fs.lstatSync(this.filePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { status: "missing", settings: emptyAiSettings(), revision: null };
      throw new LoadFailure({ status: "unreadable" });
    }
    if (!info.isFile()) throw new LoadFailure({ status: "damaged", reason: "not-a-regular-file" });
    if (info.size > AI_SETTINGS_MAX_BYTES) throw new LoadFailure({ status: "damaged", reason: "too-large" });

    const bytes = this.readBounded();
    let text: string;
    try {
      // Fatal: invalid UTF-8 is damage, not replacement characters. A BOM is kept, so the parser refuses it.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new LoadFailure({ status: "damaged", reason: "invalid-encoding" });
    }
    const parsed = parseAiSettings(text);
    if (parsed.ok) return { status: "valid", settings: parsed.settings, revision: revisionOf(bytes) };
    if (parsed.error === "unsupported-version") throw new LoadFailure({ status: "unsupported-version" });
    throw new LoadFailure({ status: "damaged", reason: parsed.error });
  }

  /** Reads at most one byte past the limit, so a file that grew since lstat can't be read whole. */
  private readBounded(): Buffer {
    const noFollow = this.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    let fd: number;
    try {
      fd = this.fs.openSync(this.filePath, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
      if (errorCode(error) === "ELOOP") throw new LoadFailure({ status: "damaged", reason: "not-a-regular-file" });
      // Gone between lstat and open: report it as unreadable rather than guess.
      throw new LoadFailure({ status: "unreadable" });
    }
    try {
      let opened: { isFile(): boolean };
      try {
        opened = this.fs.fstatSync(fd);
      } catch {
        throw new LoadFailure({ status: "unreadable" });
      }
      if (!opened.isFile()) throw new LoadFailure({ status: "damaged", reason: "not-a-regular-file" });
      const buffer = Buffer.alloc(AI_SETTINGS_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        let read: number;
        try {
          read = this.fs.readSync(fd, buffer, length, buffer.length - length, null);
        } catch {
          throw new LoadFailure({ status: "unreadable" });
        }
        if (read <= 0) break;
        length += read;
      }
      if (length > AI_SETTINGS_MAX_BYTES) throw new LoadFailure({ status: "damaged", reason: "too-large" });
      return buffer.subarray(0, length);
    } finally {
      try {
        this.fs.closeSync(fd);
      } catch {
        // nothing more to do
      }
    }
  }

  /** Writes a verified temp file and renames it over the target. True on success; on failure the target is unchanged. */
  private replaceFile(bytes: Buffer): boolean {
    let tmp: string | null = null;
    let fd: number | null = null;
    let created = false;
    try {
      // A fixed name plus random hex: nothing user-controlled reaches the path.
      // Generated inside the try, so a failure is a "write-failed" result,
      // and never replaced by a predictable name.
      const suffix = crypto.randomBytes(8).toString("hex");
      if (!/^[0-9a-f]{16}$/.test(suffix)) throw new Error("bad temp name");
      tmp = path.join(this.dir, `${AI_SETTINGS_FILE}.${suffix}.tmp`);
      // Exclusive create, read-write (for the read-back), owner-only where supported.
      fd = this.fs.openSync(tmp, "wx+", 0o600);
      created = true;
      let written = 0;
      while (written < bytes.length) {
        const n = this.fs.writeSync(fd, bytes, written, bytes.length - written);
        if (n <= 0) throw new Error("short write");
        written += n;
      }
      this.fs.fsyncSync(fd);
      // Read back through the same descriptor before it replaces anything.
      const check = Buffer.alloc(bytes.length + 1);
      let read = 0;
      while (read < check.length) {
        const n = this.fs.readSync(fd, check, read, check.length - read, read);
        if (n <= 0) break;
        read += n;
      }
      if (read !== bytes.length || !check.subarray(0, read).equals(bytes)) throw new Error("read-back mismatch");
      this.fs.closeSync(fd);
      fd = null;
      // Refuse to replace anything that isn't a regular file (it may have appeared since the check).
      try {
        if (!this.fs.lstatSync(this.filePath).isFile()) throw new Error("target is not a regular file");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      this.fs.renameSync(tmp, this.filePath);
      created = false;
    } catch {
      if (fd !== null) {
        try {
          this.fs.closeSync(fd);
        } catch {
          // already failing; the temp file is removed below
        }
      }
      if (created && tmp !== null) {
        try {
          this.fs.unlinkSync(tmp);
        } catch {
          // nothing more to do
        }
      }
      return false;
    }
    this.syncDirectory();
    return true;
  }

  /** Best effort, POSIX only: Windows can't open a directory to sync it. */
  private syncDirectory(): void {
    if (this.platform === "win32") return;
    try {
      const fd = this.fs.openSync(this.dir, "r");
      try {
        this.fs.fsyncSync(fd);
      } finally {
        this.fs.closeSync(fd);
      }
    } catch {
      // best effort
    }
  }
}
