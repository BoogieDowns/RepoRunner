import { app } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  MAX_FREE_REPO_PROFILES,
  ProjectProfile,
  ProjectProfilesState,
  ProjectStoreRecoveryAction,
  ProjectStoreStatus,
} from "../src/types.js";
import { validateProjectProfileForLoad } from "./projectProfileValidation.js";

/*
 * Saved repo setups store.
 *
 * Safety rules:
 * - Reading never writes, renames or deletes anything.
 * - A file that cannot be fully understood (empty, malformed, unreadable,
 *   unsupported version, missing while backups exist) blocks every write.
 *   It is never treated as "no saved setups".
 * - Individually invalid entries, unknown fields and the stored order are
 *   preserved through ordinary writes.
 * - Every write goes through commitStore(): revision check, rolling backup of
 *   the current (successfully loaded) bytes, exclusive temp file, fsync,
 *   read-back verification, a second revision check, then rename.
 *
 * Recovery actions (resolveProjectStoreIssue) run only when explicitly
 * requested, never during loading. Before replacing or discarding anything
 * they copy the current bytes to a new, uniquely named recovery file that is
 * created exclusively and never overwritten or deleted.
 *
 * Atomicity limits: rename over an existing file is a single metadata
 * operation on NTFS and POSIX filesystems, so readers see the old or the new
 * file, never a mix. Node does not request write-through for the rename on
 * Windows, so after a power loss the rename itself may be lost (the old file
 * remains). The revision re-check before rename narrows, but cannot close,
 * the window in which another program could change the file.
 */

export const STORE_FILE = "reporunner-project.json";
export const BACKUP_FILE = "reporunner-project.json.bak";
export const LEGACY_BACKUP_FILE = "reporunner-project.legacy.json";
export const RECOVERY_FILE_PREFIX = "reporunner-project.recovery-";
const LEGACY_BACKUP_PREFIX = "reporunner-project.legacy";

const SUPPORTED_SCHEMA_VERSION = 1;
const FS_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];
const TRANSIENT_FS_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const PROFILE_FIELD_KEYS = [
  "id",
  "name",
  "repoPath",
  "installCommand",
  "frontendCommand",
  "backendCommand",
  "previewUrl",
  "frontendPort",
  "backendPort",
] as const;

const REPO_LIMIT_MESSAGE =
  "Repo limit reached. RepoRunner Free currently supports up to 5 saved repo setups.";
const NOT_FOUND_MESSAGE = "Saved repo setup not found.";
/** Leave the stored activeProfileId exactly as it is. */
const KEEP_ACTIVE = Symbol("keep-active");

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

const STORE_ERROR_MESSAGES: Record<ProjectStoreErrorCode, string> = {
  "needs-recovery":
    "RepoRunner found a problem with your saved repo setups and has paused saving so nothing is overwritten. Your saved file has not been changed.",
  unreadable:
    "RepoRunner couldn't open your saved repo setups file. Saving is paused so nothing is overwritten. Your saved file has not been changed.",
  "unsupported-version":
    "Your saved repo setups were created by a newer version of RepoRunner. This version won't change or run them. Update RepoRunner to continue.",
  // Rejected before the primary file was replaced.
  conflict:
    "Your saved repo setups changed since RepoRunner last read them, so this change was not saved. The newer saved setups were kept. Reopen RepoRunner and try again.",
  "backup-failed":
    "RepoRunner couldn't back up your saved repo setups, so it didn't save the change. Your saved setups were not changed.",
  // Failed before the primary file was replaced.
  "write-failed":
    "RepoRunner couldn't save your repo setups. Your previously saved setups were not changed.",
  // The primary file was replaced, but reading it back did not match.
  "write-unverified":
    "Your change may have been saved, but RepoRunner couldn't confirm it. Reopen RepoRunner and check your saved repo setups before making more changes.",
  "profile-unavailable":
    "This saved repo setup can't be used because its saved details are incomplete or invalid.",
  "recovery-not-available":
    "That recovery option isn't available for your saved repo setups right now. Nothing was changed.",
  "backup-unavailable":
    "RepoRunner couldn't find a usable backup of your saved repo setups. Nothing was changed.",
  "recovery-copy-failed":
    "RepoRunner couldn't save a copy of your current saved repo setups, so it didn't make any changes.",
};

/** Errors carry fixed messages only: no paths, file contents or commands. */
export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode;

  constructor(code: ProjectStoreErrorCode) {
    super(STORE_ERROR_MESSAGES[code]);
    // `name` stays "Error": Electron prefixes it to messages crossing IPC and
    // the renderer only strips "Error:".
    this.code = code;
  }
}

export type NeedsRecoveryReason =
  | "empty"
  | "invalid-encoding"
  | "malformed-json"
  | "invalid-structure"
  | "invalid-legacy-profile"
  | "missing-with-recovery-data";

type UnknownRecord = Record<string, unknown>;

interface ValidEntry {
  status: "valid";
  raw: UnknownRecord;
  profile: ProjectProfile;
  /** False when `profile.id` is a fallback that is not yet in the file. */
  hasStoredId: boolean;
}

interface UnavailableEntry {
  status: "unavailable";
  raw: unknown;
  rawId: string;
  reason: string;
}

type StoreEntry = ValidEntry | UnavailableEntry;

interface StoreDocument {
  /** "profiles": current format; "legacy": a single bare profile; "new": no file yet. */
  format: "profiles" | "legacy" | "new";
  /** Top-level object as stored ("profiles" format only), unknown fields included. */
  top: UnknownRecord;
  entries: StoreEntry[];
  activeProfileId: string | null;
}

type StoreSnapshot =
  | { kind: "missing"; revision: null; document: StoreDocument }
  | { kind: "ok"; revision: string; document: StoreDocument }
  | { kind: "needs-recovery"; revision: string | null; reason: NeedsRecoveryReason }
  | { kind: "unreadable"; revision: null; reason: string }
  | { kind: "unsupported-version"; revision: string };

type WritableSnapshot = Extract<StoreSnapshot, { kind: "missing" | "ok" }>;

export interface ProjectStoreWriteOptions {
  /** When given, the write is rejected unless the file still has this revision. */
  expectedRevision?: string | null;
}

function getStoreDir(): string {
  return app.getPath("userData");
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Retries operations that commonly fail briefly on Windows (antivirus, indexers, sync clients). */
function withTransientRetry<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (attempt >= FS_RETRY_DELAYS_MS.length || !TRANSIENT_FS_ERROR_CODES.has(errorCode(error))) {
        throw error;
      }
      sleepSync(FS_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function readStoredId(raw: unknown): string {
  return isRecord(raw) && typeof raw.id === "string" ? raw.id.trim() : "";
}

function fallbackId(index: number, raw: unknown, taken: Set<string>): string {
  const base = `profile-${sha256(Buffer.from(`${index}\n${JSON.stringify(raw)}`)).slice(0, 16)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function safeEntryReason(error: unknown): string {
  // Validator messages name a field only, never the stored value.
  return error instanceof Error && error.message.startsWith("Invalid project profile:")
    ? error.message
    : "Invalid project profile";
}

function buildEntries(rawEntries: unknown[]): StoreEntry[] {
  const entries: StoreEntry[] = [];
  const takenIds = new Set<string>();

  for (const raw of rawEntries) {
    const rawId = readStoredId(raw);
    if (rawId && takenIds.has(rawId)) {
      // The first entry with an ID keeps it; later ones are held back so an
      // ID-based action can never touch two entries.
      entries.push({ status: "unavailable", raw, rawId, reason: "Duplicate profile ID" });
      continue;
    }
    if (rawId) takenIds.add(rawId);

    try {
      const profile = validateProjectProfileForLoad(raw);
      entries.push({ status: "valid", raw: raw as UnknownRecord, profile, hasStoredId: Boolean(profile.id) });
    } catch (error) {
      entries.push({ status: "unavailable", raw, rawId, reason: safeEntryReason(error) });
    }
  }

  entries.forEach((entry, index) => {
    if (entry.status === "valid" && !entry.hasStoredId) {
      const id = fallbackId(index, entry.raw, takenIds);
      takenIds.add(id);
      entry.profile = { ...entry.profile, id };
    }
  });

  return entries;
}

/**
 * A stored `activeProfileId` is honoured exactly: if it doesn't name a usable
 * entry (null, removed, or invalid), no repo is selected and RepoRunner never
 * switches to another one on a guess. Earlier versions rewrote the file on
 * every load so that it always named a profile (or was null with no
 * profiles), so this never changes a previously working selection.
 *
 * Only when the field is absent altogether (hand-made or very old files) does
 * the original fallback to the first profile apply, and only if no entry is
 * held back.
 */
function resolveActiveProfileId(entries: StoreEntry[], top: UnknownRecord): string | null {
  const valid = entries.filter((entry): entry is ValidEntry => entry.status === "valid");

  if (!("activeProfileId" in top)) {
    if (entries.some((entry) => entry.status === "unavailable")) return null;
    return valid[0]?.profile.id ?? null;
  }

  const requestedId = typeof top.activeProfileId === "string" ? top.activeProfileId.trim() : "";
  return requestedId && valid.some((entry) => entry.profile.id === requestedId) ? requestedId : null;
}

function classifyBytes(bytes: Buffer): Exclude<StoreSnapshot, { kind: "missing" | "unreadable" }> {
  const revision = sha256(bytes);
  const needsRecovery = (reason: NeedsRecoveryReason) =>
    ({ kind: "needs-recovery", revision, reason }) as const;

  let text: string;
  try {
    // Strips one leading UTF-8 BOM; rejects invalid UTF-8 instead of
    // replacing it, which would corrupt the bytes on the next write.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return needsRecovery("invalid-encoding");
  }

  if (!text.trim()) return needsRecovery("empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return needsRecovery("malformed-json");
  }

  if (!isRecord(parsed)) return needsRecovery("invalid-structure");

  if ("schemaVersion" in parsed && parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { kind: "unsupported-version", revision };
  }

  if ("profiles" in parsed) {
    if (!Array.isArray(parsed.profiles)) return needsRecovery("invalid-structure");
    const entries = buildEntries(parsed.profiles);
    return {
      kind: "ok",
      revision,
      document: {
        format: "profiles",
        top: parsed,
        entries,
        activeProfileId: resolveActiveProfileId(entries, parsed),
      },
    };
  }

  // Legacy format: the whole file is one profile.
  const entries = buildEntries([parsed]);
  const [entry] = entries;
  if (entry.status !== "valid") return needsRecovery("invalid-legacy-profile");
  return {
    kind: "ok",
    revision,
    document: { format: "legacy", top: {}, entries, activeProfileId: entry.profile.id },
  };
}

function hasRecoveryData(dir: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  return names.some(
    (name) =>
      name === BACKUP_FILE ||
      (name.startsWith(LEGACY_BACKUP_PREFIX) && name.endsWith(".json")) ||
      name.startsWith(RECOVERY_FILE_PREFIX),
  );
}

function emptyDocument(): StoreDocument {
  return { format: "new", top: {}, entries: [], activeProfileId: null };
}

/** Reads and classifies the store. Never modifies any file. */
function readStoreSnapshot(): StoreSnapshot {
  const dir = getStoreDir();
  let bytes: Buffer;

  try {
    bytes = withTransientRetry(() => fs.readFileSync(path.join(dir, STORE_FILE)));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return { kind: "unreadable", revision: null, reason: errorCode(error) };
    }
    try {
      return hasRecoveryData(dir)
        ? { kind: "needs-recovery", revision: null, reason: "missing-with-recovery-data" }
        : { kind: "missing", revision: null, document: emptyDocument() };
    } catch (dirError) {
      return { kind: "unreadable", revision: null, reason: errorCode(dirError) };
    }
  }

  return classifyBytes(bytes);
}

function requireWritable(snapshot: StoreSnapshot, options?: ProjectStoreWriteOptions): WritableSnapshot {
  if (snapshot.kind !== "missing" && snapshot.kind !== "ok") {
    throw new ProjectStoreError(snapshot.kind);
  }
  if (options && options.expectedRevision !== undefined && options.expectedRevision !== snapshot.revision) {
    throw new ProjectStoreError("conflict");
  }
  return snapshot;
}

function readStoreForWrite(options?: ProjectStoreWriteOptions): WritableSnapshot {
  return requireWritable(readStoreSnapshot(), options);
}

function toPublicState(document: StoreDocument, revision: string | null): ProjectProfilesState {
  return {
    profiles: document.entries
      .filter((entry): entry is ValidEntry => entry.status === "valid")
      .map((entry) => entry.profile),
    activeProfileId: document.activeProfileId,
    revision,
  };
}

function entryToRaw(entry: StoreEntry): unknown {
  if (entry.status === "unavailable" || entry.hasStoredId) return entry.raw;
  // Persist the fallback ID so it stays stable from now on.
  return "id" in entry.raw ? { ...entry.raw, id: entry.profile.id } : { id: entry.profile.id, ...entry.raw };
}

/** Applies the profile's known fields onto the stored object, keeping unknown fields and key order. */
function mergeProfileIntoRaw(raw: UnknownRecord, profile: ProjectProfile): UnknownRecord {
  const next: UnknownRecord = { ...raw };
  for (const key of PROFILE_FIELD_KEYS) {
    const value = profile[key];
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

function serializeDocument(
  document: StoreDocument,
  entries: StoreEntry[],
  activeProfileId: string | null | typeof KEEP_ACTIVE,
): Buffer {
  const out: UnknownRecord = document.format === "profiles" ? { ...document.top } : {};
  out.profiles = entries.map(entryToRaw);
  if (activeProfileId !== KEEP_ACTIVE) {
    out.activeProfileId = activeProfileId;
  } else if (document.format !== "profiles") {
    out.activeProfileId = document.activeProfileId;
  }
  return Buffer.from(JSON.stringify(out, null, 2), "utf-8");
}


function readCurrentBytes(target: string): Buffer | null {
  try {
    return withTransientRetry(() => fs.readFileSync(target));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new ProjectStoreError("unreadable");
  }
}

function assertRevision(current: Buffer | null, expected: string | null): void {
  const actual = current === null ? null : sha256(current);
  if (actual !== expected) throw new ProjectStoreError("conflict");
}

function removeOwnTempFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Best effort; a leftover *.tmp file is ignored by the loader.
  }
}

/**
 * Creates a new file exclusively, writes all bytes, flushes them to disk and
 * reads them back. Removes the file again (it is ours) if any step fails.
 */
function writeNewFileVerified(file: string, bytes: Buffer): void {
  const fd = fs.openSync(file, "wx");
  let open = true;
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Short write");
      offset += written;
    }
    fs.fsyncSync(fd);
    open = false;
    fs.closeSync(fd);
    if (!fs.readFileSync(file).equals(bytes)) throw new Error("Read-back mismatch");
  } catch (error) {
    if (open) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    removeOwnTempFile(file);
    throw error;
  }
}

function tempPathFor(dir: string, baseName: string): string {
  return path.join(dir, `${baseName}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
}

function syncDirectory(dir: string): void {
  // Windows cannot open a directory for fsync; NTFS journals the rename.
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Best effort.
  }
}

/** Replaces `name` with `bytes` via a verified temp file and rename. */
function replaceFileAtomically(dir: string, name: string, bytes: Buffer, beforeRename?: () => void): void {
  const tmp = tempPathFor(dir, name);
  writeNewFileVerified(tmp, bytes);
  try {
    beforeRename?.();
    withTransientRetry(() => fs.renameSync(tmp, path.join(dir, name)));
  } catch (error) {
    removeOwnTempFile(tmp);
    throw error;
  }
  syncDirectory(dir);
}

/**
 * One-time copy of a legacy-format file before it is converted. Existing
 * copies are never overwritten.
 */
function preserveLegacyBackup(dir: string, bytes: Buffer): void {
  const candidates = [LEGACY_BACKUP_FILE, `${LEGACY_BACKUP_PREFIX}-${sha256(bytes).slice(0, 12)}.json`];
  for (const name of candidates) {
    const file = path.join(dir, name);
    let existing: Buffer | null = null;
    try {
      existing = fs.readFileSync(file);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (existing) {
      if (existing.equals(bytes)) return;
      continue;
    }
    writeNewFileVerified(file, bytes);
    syncDirectory(dir);
    return;
  }
  throw new Error("No free legacy backup name");
}

function wrapStoreError(error: unknown, fallback: ProjectStoreErrorCode): ProjectStoreError {
  if (error instanceof ProjectStoreError) return error;
  console.error(`RepoRunner store: ${fallback} (${errorCode(error)})`);
  return new ProjectStoreError(fallback);
}

/**
 * The only path that writes the primary store file. Returns the new state.
 *
 * Order: verify revision → legacy copy (if converting) → rolling backup of the
 * current bytes → verified temp file → verify revision again → rename.
 * Any failure before the rename leaves the primary file untouched and is
 * reported as conflict / unreadable / backup-failed / write-failed. Only a
 * failed read-back after the rename is reported as write-unverified.
 */
function commitStore(snapshot: WritableSnapshot, nextBytes: Buffer, convertingLegacy: boolean): ProjectProfilesState {
  const next = classifyBytes(nextBytes);
  if (next.kind !== "ok") throw new ProjectStoreError("write-failed");

  const dir = getStoreDir();
  const target = path.join(dir, STORE_FILE);

  let current: Buffer | null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    current = readCurrentBytes(target);
    assertRevision(current, snapshot.revision);
  } catch (error) {
    throw wrapStoreError(error, "write-failed");
  }

  if (current) {
    // `current` has the revision that loaded successfully, so the backup
    // only ever receives readable data.
    try {
      if (convertingLegacy) preserveLegacyBackup(dir, current);
      replaceFileAtomically(dir, BACKUP_FILE, current);
    } catch (error) {
      throw wrapStoreError(error, "backup-failed");
    }
  }

  replacePrimary(snapshot.revision, nextBytes);
  return toPublicState(next.document, sha256(nextBytes));
}

/**
 * Final step of every write and recovery action: verified temp file,
 * revision re-check, rename, read-back.
 */
function replacePrimary(expectedRevision: string | null, nextBytes: Buffer): void {
  const dir = getStoreDir();
  const target = path.join(dir, STORE_FILE);

  try {
    replaceFileAtomically(dir, STORE_FILE, nextBytes, () => {
      assertRevision(readCurrentBytes(target), expectedRevision);
    });
  } catch (error) {
    throw wrapStoreError(error, "write-failed");
  }

  // The rename has happened: from here on, never report "not saved".
  let written: Buffer | null = null;
  try {
    written = readCurrentBytes(target);
  } catch {
    // Reported below.
  }
  if (!written || !written.equals(nextBytes)) throw new ProjectStoreError("write-unverified");
}

function findValidIndex(entries: StoreEntry[], profileId: string): number {
  return entries.findIndex((entry) => entry.status === "valid" && entry.profile.id === profileId);
}

function isUnavailableId(entries: StoreEntry[], profileId: string): boolean {
  return entries.some((entry) => entry.status === "unavailable" && entry.rawId === profileId);
}

/** The rolling backup, only if it exists and loads cleanly. Never modifies files. */
function readValidatedBackup(): Buffer | null {
  let bytes: Buffer;
  try {
    bytes = withTransientRetry(() => fs.readFileSync(path.join(getStoreDir(), BACKUP_FILE)));
  } catch {
    return null;
  }
  return classifyBytes(bytes).kind === "ok" ? bytes : null;
}

function availableActions(snapshot: StoreSnapshot, backupAvailable: boolean): ProjectStoreRecoveryAction[] {
  switch (snapshot.kind) {
    case "needs-recovery":
      return backupAvailable ? ["retry", "restore-backup", "start-fresh"] : ["retry", "start-fresh"];
    case "ok":
      return snapshot.document.entries.some((entry) => entry.status === "unavailable")
        ? ["retry", "discard-invalid-entries"]
        : ["retry"];
    default:
      // missing: nothing to recover. unreadable: usually a lock or permission
      // problem outside RepoRunner. unsupported-version: update RepoRunner.
      return ["retry"];
  }
}

function statusOf(snapshot: StoreSnapshot): ProjectStoreStatus {
  const entries = snapshot.kind === "ok" || snapshot.kind === "missing" ? snapshot.document.entries : [];
  const backupAvailable = readValidatedBackup() !== null;
  return {
    state: snapshot.kind,
    reason: "reason" in snapshot ? snapshot.reason : null,
    recoveryRequired: snapshot.kind === "needs-recovery" || snapshot.kind === "unreadable",
    readOnly: snapshot.kind !== "ok" && snapshot.kind !== "missing",
    backupAvailable,
    revision: snapshot.revision,
    totalEntries: entries.length,
    unavailableEntries: entries.flatMap((entry, index) =>
      entry.status === "unavailable" ? [{ index, reason: entry.reason }] : [],
    ),
    availableActions: availableActions(snapshot, backupAvailable),
  };
}

/** Classified, read-only view of the store for diagnostics and recovery. */
export function inspectProjectStore(): ProjectStoreStatus {
  return statusOf(readStoreSnapshot());
}

/**
 * What to reveal in the OS file manager: the store file if present, else its
 * folder. Determined here, never taken from or sent to the renderer.
 */
export function getProjectStoreRevealTarget(): { kind: "file" | "folder"; path: string } {
  const dir = getStoreDir();
  const file = path.join(dir, STORE_FILE);
  return fs.existsSync(file) ? { kind: "file", path: file } : { kind: "folder", path: dir };
}

/** Copies `bytes` to a new, uniquely named recovery file. Never overwrites. */
function preserveRecoveryCopy(dir: string, bytes: Buffer, label: string): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  for (let attempt = 0; ; attempt++) {
    const name = `${RECOVERY_FILE_PREFIX}${stamp}-${label}-${crypto.randomBytes(4).toString("hex")}.json`;
    try {
      writeNewFileVerified(path.join(dir, name), bytes);
      syncDirectory(dir);
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || attempt >= 3) throw error;
    }
  }
}

function preserveOrFail(dir: string, bytes: Buffer, label: string): void {
  try {
    preserveRecoveryCopy(dir, bytes, label);
  } catch (error) {
    throw wrapStoreError(error, "recovery-copy-failed");
  }
}

/** Re-reads the primary, checks it still has `revision`, and returns its bytes (null if absent). */
function readPrimaryAtRevision(revision: string | null): Buffer | null {
  try {
    const current = readCurrentBytes(path.join(getStoreDir(), STORE_FILE));
    assertRevision(current, revision);
    return current;
  } catch (error) {
    throw wrapStoreError(error, "write-failed");
  }
}

function restoreBackup(snapshot: StoreSnapshot): void {
  if (snapshot.kind !== "needs-recovery") throw new ProjectStoreError("recovery-not-available");
  const backup = readValidatedBackup();
  if (!backup) throw new ProjectStoreError("backup-unavailable");

  const dir = getStoreDir();
  const current = readPrimaryAtRevision(snapshot.revision);
  if (current) preserveOrFail(dir, current, "damaged");
  // The backup itself stays in place; after restoring it equals the primary.
  replacePrimary(snapshot.revision, backup);
}

function startFresh(snapshot: StoreSnapshot): void {
  if (snapshot.kind !== "needs-recovery") throw new ProjectStoreError("recovery-not-available");

  const dir = getStoreDir();
  const current = readPrimaryAtRevision(snapshot.revision);
  if (current) preserveOrFail(dir, current, "damaged");
  // The next ordinary save rotates the backup, so keep a permanent copy of it
  // too, valid or not: it may be all that is left of the old setups.
  let backup: Buffer | null = null;
  try {
    backup = withTransientRetry(() => fs.readFileSync(path.join(dir, BACKUP_FILE)));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw wrapStoreError(error, "recovery-copy-failed");
  }
  if (backup) preserveOrFail(dir, backup, "backup");

  replacePrimary(snapshot.revision, serializeDocument(emptyDocument(), [], null));
}

function discardInvalidEntries(snapshot: StoreSnapshot): void {
  if (snapshot.kind !== "ok" || !snapshot.document.entries.some((entry) => entry.status === "unavailable")) {
    throw new ProjectStoreError("recovery-not-available");
  }
  const { document } = snapshot;
  const current = readPrimaryAtRevision(snapshot.revision);
  if (current) preserveOrFail(getStoreDir(), current, "before-discard");

  const entries = document.entries.filter((entry) => entry.status === "valid");
  // Keep the stored active setup only if it is one of the kept entries.
  const activeProfileId =
    document.activeProfileId !== null && findValidIndex(entries, document.activeProfileId) !== -1
      ? document.activeProfileId
      : null;
  commitStore(snapshot, serializeDocument(document, entries, activeProfileId), document.format === "legacy");
}

/**
 * Explicit recovery entry point; never called during loading. Only "retry"
 * may run without the revision of the status the user acted on; every other
 * action is rejected as a conflict if the file has changed since.
 */
export function resolveProjectStoreIssue(
  action: ProjectStoreRecoveryAction,
  options?: ProjectStoreWriteOptions,
): ProjectStoreStatus {
  const snapshot = readStoreSnapshot();
  if (action === "retry") return statusOf(snapshot);

  if (!options || options.expectedRevision === undefined || options.expectedRevision !== snapshot.revision) {
    throw new ProjectStoreError("conflict");
  }

  switch (action) {
    case "restore-backup":
      restoreBackup(snapshot);
      break;
    case "start-fresh":
      startFresh(snapshot);
      break;
    case "discard-invalid-entries":
      discardInvalidEntries(snapshot);
      break;
    default:
      throw new ProjectStoreError("recovery-not-available");
  }
  return inspectProjectStore();
}

/**
 * Usable saved setups. Unavailable entries are not returned but stay in the
 * file. Throws ProjectStoreError when the file can't be safely used.
 */
export function loadProjectState(): ProjectProfilesState {
  const snapshot = readStoreSnapshot();
  if (snapshot.kind !== "missing" && snapshot.kind !== "ok") {
    throw new ProjectStoreError(snapshot.kind);
  }
  return toPublicState(snapshot.document, snapshot.revision);
}

export function saveProject(
  profile: Omit<ProjectProfile, "id"> & { id?: string },
  options?: ProjectStoreWriteOptions,
): ProjectProfilesState {
  const snapshot = readStoreForWrite(options);
  const { document } = snapshot;
  const saved: ProjectProfile = { ...profile, id: profile.id || uuidv4() };
  const existingIndex = findValidIndex(document.entries, saved.id);

  // A held-back entry may share the ID (e.g. a later duplicate); only refuse
  // when no usable entry owns it, so a new entry never duplicates the ID.
  if (existingIndex === -1 && isUnavailableId(document.entries, saved.id)) {
    throw new ProjectStoreError("profile-unavailable");
  }

  // Unavailable entries count toward the limit until the user removes them.
  if (existingIndex === -1 && document.entries.length >= MAX_FREE_REPO_PROFILES) {
    throw new Error(REPO_LIMIT_MESSAGE);
  }

  const entries = [...document.entries];
  const previousRaw = existingIndex === -1 ? {} : (entries[existingIndex] as ValidEntry).raw;
  const nextEntry: ValidEntry = {
    status: "valid",
    raw: mergeProfileIntoRaw(previousRaw, saved),
    profile: saved,
    hasStoredId: true,
  };
  if (existingIndex === -1) entries.push(nextEntry);
  else entries[existingIndex] = nextEntry;

  return commitStore(snapshot, serializeDocument(document, entries, saved.id), document.format === "legacy");
}

export function loadProject(): ProjectProfile | null {
  const state = loadProjectState();
  return (
    state.profiles.find((profile) => profile.id === state.activeProfileId) ??
    null
  );
}

export function setActiveProject(profileId: string, options?: ProjectStoreWriteOptions): ProjectProfilesState {
  const snapshot = readStoreForWrite(options);
  const { document } = snapshot;

  if (findValidIndex(document.entries, profileId) === -1) {
    if (isUnavailableId(document.entries, profileId)) throw new ProjectStoreError("profile-unavailable");
    throw new Error(NOT_FOUND_MESSAGE);
  }

  return commitStore(
    snapshot,
    serializeDocument(document, document.entries, profileId),
    document.format === "legacy",
  );
}

/**
 * Removes exactly one usable entry. Unavailable entries are never removed
 * here; that needs an explicit recovery action.
 */
export function deleteProject(profileId: string, options?: ProjectStoreWriteOptions): ProjectProfilesState {
  const snapshot = readStoreForWrite(options);
  const { document } = snapshot;
  const index = findValidIndex(document.entries, profileId);

  if (index === -1) {
    throw new Error(NOT_FOUND_MESSAGE);
  }

  const entries = document.entries.filter((_, i) => i !== index);
  const activeProfileId =
    document.activeProfileId === profileId
      ? entries.find((entry): entry is ValidEntry => entry.status === "valid")?.profile.id ?? null
      : KEEP_ACTIVE;

  return commitStore(snapshot, serializeDocument(document, entries, activeProfileId), document.format === "legacy");
}
