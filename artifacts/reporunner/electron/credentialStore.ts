import fs from "fs";
import path from "path";
import crypto from "crypto";

/*
 * Main-process storage for future BYOK credentials (Stage 3D). Not connected
 * to IPC, the preload or any UI, and nothing creates an instance yet.
 *
 * - Remembered credentials are encrypted with Electron safeStorage (DPAPI on
 *   Windows) before they are written, to their own file in userData. There is
 *   no plaintext fallback: when OS-backed encryption is unavailable, or on
 *   Linux the backend is basic_text/unknown, remembering a key is refused.
 * - Session-only credentials live in this object's memory and are never
 *   written anywhere.
 * - A slot holds at most one credential: remembering clears the session copy,
 *   and a session-only key first removes any remembered one.
 * - Values never appear in errors, logs, status results or process.env, and
 *   the store never logs at all. Status returns metadata only.
 * - Operations on one store run one at a time, so updates can't overwrite each
 *   other. The app should use a single store per process.
 *
 * Limits: encryption at rest does not protect against code running as the
 * same OS user (Stage 3A). Removing a key rewrites the file without it, but
 * file deletion can't guarantee erasure from SSDs or OS backups, and
 * JavaScript can't guarantee a string is wiped from memory.
 */

/** Credential slots. Labels only: never paths, URLs or commands. Providers are not decided yet. */
export const CREDENTIAL_SLOTS = Object.freeze(["byok-slot-1", "byok-slot-2", "byok-slot-3"] as const);
export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];

export const CREDENTIAL_FILE = "reporunner-credentials.json";
const FORMAT = "reporunner-credentials";
const FORMAT_VERSION = 1;
/** Larger than any real file of three encrypted keys; anything bigger is refused unread. */
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_SECRET_LENGTH = 8192;
const MAX_ENCRYPTED_BASE64_LENGTH = 16 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type CredentialStoreErrorCode =
  | "invalid-slot"
  | "invalid-secret"
  | "encryption-unavailable"
  | "encryption-insecure"
  | "encrypt-failed"
  | "decrypt-failed"
  | "store-corrupt"
  | "unsupported-version"
  | "read-failed"
  | "write-failed";

const MESSAGES: Record<CredentialStoreErrorCode, string> = {
  "invalid-slot": "Unknown credential slot.",
  "invalid-secret": "The credential is empty, too long or contains invalid characters.",
  "encryption-unavailable": "Secure storage isn't available, so the credential can't be remembered.",
  "encryption-insecure": "This system's secure storage isn't strong enough, so the credential can't be remembered.",
  "encrypt-failed": "The credential couldn't be encrypted.",
  "decrypt-failed": "A remembered credential couldn't be decrypted.",
  "store-corrupt": "The credentials file is damaged and was left unchanged.",
  "unsupported-version": "The credentials file was written by a newer RepoRunner and was left unchanged.",
  "read-failed": "The credentials file couldn't be read.",
  "write-failed": "The credentials file couldn't be saved; the previous file is unchanged.",
};

/** Errors carry a fixed message per code: never a credential, path or system message. */
export class CredentialStoreError extends Error {
  constructor(readonly code: CredentialStoreErrorCode) {
    super(MESSAGES[code]);
    this.name = "CredentialStoreError";
  }
}

/** The parts of Electron's safeStorage the store uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/** The file operations the store uses (Node's fs by default; replaceable in tests). */
export interface CredentialFs {
  readFileSync(file: string): Buffer;
  statSync(file: string): { size: number };
  openSync(file: string, flags: string, mode?: number): number;
  writeSync(fd: number, buffer: Buffer): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
}

export interface CredentialStoreOptions {
  /** The directory for the credentials file (the app's userData). */
  dir: string;
  safeStorage: SafeStorageLike;
  platform?: NodeJS.Platform;
  fs?: CredentialFs;
}

export interface CredentialStatus {
  configured: boolean;
  mode: "remembered" | "session" | null;
}

export type PersistenceAvailability = { available: true } | { available: false; reason: "encryption-unavailable" | "encryption-insecure" };

type StoredFile = { format: typeof FORMAT; version: typeof FORMAT_VERSION; credentials: Partial<Record<CredentialSlot, string>> };

const errorCode = (error: unknown) => (error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined);

export function isCredentialSlot(value: unknown): value is CredentialSlot {
  return typeof value === "string" && (CREDENTIAL_SLOTS as readonly string[]).includes(value);
}

function assertSlot(slot: unknown): asserts slot is CredentialSlot {
  if (!isCredentialSlot(slot)) throw new CredentialStoreError("invalid-slot");
}

function assertSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.length === 0 || secret.length > MAX_SECRET_LENGTH || /[\u0000\r\n]/.test(secret)) {
    throw new CredentialStoreError("invalid-secret");
  }
}

/** Validates the parsed file strictly; anything unexpected is refused, never repaired. */
function parseStoredFile(bytes: Buffer): StoredFile {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CredentialStoreError("store-corrupt");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CredentialStoreError("store-corrupt");
  const record = value as Record<string, unknown>;
  if (record.format !== FORMAT) throw new CredentialStoreError("store-corrupt");
  if (record.version !== FORMAT_VERSION) {
    throw new CredentialStoreError(typeof record.version === "number" && record.version > FORMAT_VERSION ? "unsupported-version" : "store-corrupt");
  }
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.every((k) => k === "format" || k === "version" || k === "credentials")) throw new CredentialStoreError("store-corrupt");
  const creds = record.credentials;
  if (!creds || typeof creds !== "object" || Array.isArray(creds)) throw new CredentialStoreError("store-corrupt");
  const credentials: Partial<Record<CredentialSlot, string>> = {};
  for (const [slot, encoded] of Object.entries(creds as Record<string, unknown>)) {
    if (!isCredentialSlot(slot)) throw new CredentialStoreError("store-corrupt");
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_ENCRYPTED_BASE64_LENGTH || !BASE64.test(encoded)) {
      throw new CredentialStoreError("store-corrupt");
    }
    credentials[slot] = encoded;
  }
  return { format: FORMAT, version: FORMAT_VERSION, credentials };
}

export class CredentialStore {
  private readonly dir: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly platform: NodeJS.Platform;
  private readonly fs: CredentialFs;
  private readonly session = new Map<CredentialSlot, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CredentialStoreOptions) {
    this.dir = options.dir;
    this.safeStorage = options.safeStorage;
    this.platform = options.platform ?? process.platform;
    this.fs = options.fs ?? (fs as unknown as CredentialFs);
  }

  /** Whether remembered (encrypted, on-disk) credentials can be used on this system. */
  persistenceAvailability(): PersistenceAvailability {
    let available = false;
    try {
      available = this.safeStorage.isEncryptionAvailable() === true;
    } catch {
      available = false;
    }
    if (!available) return { available: false, reason: "encryption-unavailable" };
    if (this.platform === "linux") {
      let backend = "unknown";
      try {
        backend = this.safeStorage.getSelectedStorageBackend?.() ?? "unknown";
      } catch {
        backend = "unknown";
      }
      // basic_text is a hard-coded key, not OS-backed protection; unknown means it can't be confirmed.
      if (backend === "basic_text" || backend === "unknown") return { available: false, reason: "encryption-insecure" };
    }
    return { available: true };
  }

  /** Stores a credential. `remember: true` encrypts it to disk; false keeps it in memory for this session only. */
  setCredential(slot: CredentialSlot, secret: string, options: { remember: boolean }): Promise<void> {
    return this.serialized(() => {
      assertSlot(slot);
      assertSecret(secret);
      if (options.remember === true) {
        const availability = this.persistenceAvailability();
        if (!availability.available) throw new CredentialStoreError(availability.reason);
        let encrypted: Buffer;
        try {
          encrypted = this.safeStorage.encryptString(secret);
        } catch {
          throw new CredentialStoreError("encrypt-failed");
        }
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new CredentialStoreError("encrypt-failed");
        const file = this.readFile() ?? { format: FORMAT, version: FORMAT_VERSION, credentials: {} };
        this.writeFile({ ...file, credentials: { ...file.credentials, [slot]: encrypted.toString("base64") } });
        this.session.delete(slot);
        return;
      }
      if (options.remember !== false) throw new CredentialStoreError("invalid-secret");
      // Session-only: a remembered copy must not survive (or come back later).
      const file = this.readFile();
      if (file && file.credentials[slot] !== undefined) {
        const credentials = { ...file.credentials };
        delete credentials[slot];
        this.writeFile({ ...file, credentials });
      }
      this.session.set(slot, secret);
    });
  }

  /** The credential for `slot`, or null. Main-process only: never send the result over IPC, log it or put it in an environment. */
  getCredential(slot: CredentialSlot): Promise<string | null> {
    return this.serialized(() => {
      assertSlot(slot);
      const session = this.session.get(slot);
      if (session !== undefined) return session;
      const encoded = this.readFile()?.credentials[slot];
      if (encoded === undefined) return null;
      if (!this.persistenceAvailability().available) throw new CredentialStoreError("encryption-unavailable");
      let secret: unknown;
      try {
        secret = this.safeStorage.decryptString(Buffer.from(encoded, "base64"));
      } catch {
        throw new CredentialStoreError("decrypt-failed");
      }
      if (typeof secret !== "string" || secret.length === 0) throw new CredentialStoreError("decrypt-failed");
      return secret;
    });
  }

  /** Metadata only. */
  status(slot: CredentialSlot): Promise<CredentialStatus> {
    return this.serialized(() => {
      assertSlot(slot);
      if (this.session.has(slot)) return { configured: true, mode: "session" } as CredentialStatus;
      return this.readFile()?.credentials[slot] !== undefined ? ({ configured: true, mode: "remembered" } as CredentialStatus) : { configured: false, mode: null };
    });
  }

  /** Removes the credential from memory and from the file. Removing an absent credential is fine. */
  removeCredential(slot: CredentialSlot): Promise<void> {
    return this.serialized(() => {
      assertSlot(slot);
      this.session.delete(slot);
      const file = this.readFile();
      if (!file || file.credentials[slot] === undefined) return;
      const credentials = { ...file.credentials };
      delete credentials[slot];
      this.writeFile({ ...file, credentials });
    });
  }

  private serialized<T>(operation: () => T): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get filePath(): string {
    return path.join(this.dir, CREDENTIAL_FILE);
  }

  /** The validated file, or null when there is none. Damaged or newer files throw and are never rewritten. */
  private readFile(): StoredFile | null {
    let size: number;
    try {
      size = this.fs.statSync(this.filePath).size;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw new CredentialStoreError("read-failed");
    }
    if (size > MAX_FILE_BYTES) throw new CredentialStoreError("store-corrupt");
    let bytes: Buffer;
    try {
      bytes = this.fs.readFileSync(this.filePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw new CredentialStoreError("read-failed");
    }
    if (bytes.length > MAX_FILE_BYTES) throw new CredentialStoreError("store-corrupt");
    return parseStoredFile(bytes);
  }

  /** Writes a new file next to the old one (owner-only where supported), syncs it, then renames it over. */
  private writeFile(file: StoredFile): void {
    const bytes = Buffer.from(JSON.stringify(file), "utf8");
    const tmp = path.join(this.dir, `${CREDENTIAL_FILE}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    let fd: number | null = null;
    try {
      fd = this.fs.openSync(tmp, "wx", 0o600);
      let written = 0;
      while (written < bytes.length) written += this.fs.writeSync(fd, bytes.subarray(written));
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = null;
      this.fs.renameSync(tmp, this.filePath);
    } catch {
      if (fd !== null) {
        try {
          this.fs.closeSync(fd);
        } catch {
          // already failing; the temp file is removed below
        }
      }
      try {
        this.fs.unlinkSync(tmp);
      } catch {
        // nothing to remove
      }
      throw new CredentialStoreError("write-failed");
    }
  }
}
