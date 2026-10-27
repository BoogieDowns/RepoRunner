// Stage 4C: the internal credential Settings dialog's behavior, kept free of
// React so it can be tested directly.
//
// - The key is never stored here. save() receives it, checks it, forwards it
//   once and drops it; the dialog keeps it only in its password field, which
//   it clears after every attempt and on close.
// - Results from the main process are re-checked and copied field by field,
//   so nothing but known metadata (never a key) reaches the UI's state.
// - One request at a time. A response that arrives after a newer request, or
//   after the dialog closed, is ignored.
import {
  CREDENTIAL_ERROR_MESSAGES,
  CREDENTIAL_MAX_KEY_BYTES,
  CREDENTIAL_SLOT,
  type CredentialIpcErrorCode,
  type CredentialIpcResult,
  type CredentialMetadata,
  type RepoRunnerAPI,
} from "../types";

export type CredentialApi = Required<Pick<RepoRunnerAPI, "credentialStatus" | "setCredential" | "removeCredential">>;

/** The credential methods, or null when this launch doesn't provide them (every packaged build). */
export function getCredentialApi(api: Partial<RepoRunnerAPI> | undefined): CredentialApi | null {
  if (!api) return null;
  const { credentialStatus, setCredential, removeCredential } = api;
  if (typeof credentialStatus !== "function" || typeof setCredential !== "function" || typeof removeCredential !== "function") return null;
  return { credentialStatus, setCredential, removeCredential };
}

export const STATUS_TEXT = {
  none: "No key configured",
  session: "Key saved for this session",
  remembered: "Key remembered on this computer",
} as const;

export function statusText(status: CredentialMetadata): string {
  if (!status.configured || status.mode === null) return STATUS_TEXT.none;
  return status.mode === "remembered" ? STATUS_TEXT.remembered : STATUS_TEXT.session;
}

/** Checks the renderer can make before anything is sent. */
export type LocalKeyProblem = "empty" | "too-long" | "line-break";
export const LOCAL_KEY_MESSAGES: Record<LocalKeyProblem, string> = {
  empty: "Enter a key first.",
  "too-long": `That key is too long. Keys can be at most ${CREDENTIAL_MAX_KEY_BYTES.toLocaleString("en-US")} bytes.`,
  "line-break": "Keys can't contain line breaks.",
};

export function localKeyProblem(key: string): LocalKeyProblem | null {
  if (key.length === 0) return "empty";
  // Each UTF-16 unit is at least one UTF-8 byte, so this avoids encoding a huge string.
  if (key.length > CREDENTIAL_MAX_KEY_BYTES || new TextEncoder().encode(key).length > CREDENTIAL_MAX_KEY_BYTES) return "too-long";
  if (/[\u0000\r\n]/.test(key)) return "line-break";
  return null;
}

const ERROR_CODES = Object.keys(CREDENTIAL_ERROR_MESSAGES) as CredentialIpcErrorCode[];
const MODES = ["remembered", "session", null] as const;
const PERSISTENCE = ["available", "unavailable", "insecure"] as const;

/** A fixed message for any error code; unknown codes get the generic one. */
export function errorMessage(code: unknown): string {
  return ERROR_CODES.includes(code as CredentialIpcErrorCode) ? CREDENTIAL_ERROR_MESSAGES[code as CredentialIpcErrorCode] : CREDENTIAL_ERROR_MESSAGES.failed;
}

/**
 * Reads a result defensively: only the known fields of a well-formed result
 * are copied; anything else becomes a "failed" error.
 */
export function readResult(value: unknown): CredentialIpcResult {
  if (typeof value !== "object" || value === null) return { ok: false, error: "failed" };
  const r = value as { ok?: unknown; status?: unknown; error?: unknown };
  if (r.ok === false) return { ok: false, error: ERROR_CODES.includes(r.error as CredentialIpcErrorCode) ? (r.error as CredentialIpcErrorCode) : "failed" };
  if (r.ok !== true || typeof r.status !== "object" || r.status === null) return { ok: false, error: "failed" };
  const s = r.status as { configured?: unknown; mode?: unknown; persistence?: unknown };
  if (typeof s.configured !== "boolean" || !MODES.includes(s.mode as never) || !PERSISTENCE.includes(s.persistence as never)) return { ok: false, error: "failed" };
  if (s.configured !== (s.mode !== null)) return { ok: false, error: "failed" };
  return { ok: true, status: { configured: s.configured, mode: s.mode as CredentialMetadata["mode"], persistence: s.persistence as CredentialMetadata["persistence"] } };
}

export type Activity = "loading" | "idle" | "saving" | "removing";

export interface CredentialSettingsState {
  status: CredentialMetadata | null;
  activity: Activity;
  /** A fixed message, never containing a key. */
  error: string | null;
  /** A short confirmation after a successful change. */
  notice: string | null;
  confirmingRemove: boolean;
}

export const INITIAL_STATE: CredentialSettingsState = Object.freeze({ status: null, activity: "loading", error: null, notice: null, confirmingRemove: false });

export class CredentialSettingsController {
  private state: CredentialSettingsState = INITIAL_STATE;
  private request = 0;
  private closed = false;

  constructor(
    private readonly api: CredentialApi,
    private readonly onChange: (state: CredentialSettingsState) => void,
  ) {}

  get current(): CredentialSettingsState {
    return this.state;
  }

  /** A save or remove is in flight: the dialog stays open and the actions are disabled. */
  get mutating(): boolean {
    return this.state.activity === "saving" || this.state.activity === "removing";
  }

  private set(patch: Partial<CredentialSettingsState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** Runs one request; its answer applies only if it's still the latest and the dialog is open. */
  private async run(activity: Activity, call: () => Promise<unknown>, notice: string | null): Promise<void> {
    const id = ++this.request;
    this.set({ activity, error: null, notice: null });
    let result: CredentialIpcResult;
    try {
      result = readResult(await call());
    } catch {
      // An IPC rejection (for example a refused sender) has no useful detail for the user.
      result = { ok: false, error: "failed" };
    }
    if (this.closed || id !== this.request) return;
    if (result.ok) this.set({ activity: "idle", status: result.status, notice, confirmingRemove: false });
    else this.set({ activity: "idle", error: errorMessage(result.error), confirmingRemove: false });
  }

  load(): Promise<void> {
    return this.run("loading", () => this.api.credentialStatus(CREDENTIAL_SLOT), null);
  }

  /**
   * Saves `key`. The caller clears its field whatever happens; this neither
   * keeps nor returns the key. Refused while another change is in flight.
   */
  save(key: string, remember: boolean): Promise<void> {
    if (this.mutating || this.closed) return Promise.resolve();
    const problem = localKeyProblem(key);
    if (problem) {
      this.set({ error: LOCAL_KEY_MESSAGES[problem], notice: null });
      return Promise.resolve();
    }
    const options = { remember: remember === true };
    const notice = options.remember ? "Key saved and remembered on this computer." : "Key saved for this session.";
    return this.run("saving", () => this.api.setCredential(CREDENTIAL_SLOT, key, options), notice);
  }

  requestRemove(): void {
    if (this.mutating || !this.state.status?.configured) return;
    this.set({ confirmingRemove: true, error: null, notice: null });
  }

  cancelRemove(): void {
    if (this.mutating) return;
    this.set({ confirmingRemove: false });
  }

  confirmRemove(): Promise<void> {
    if (this.mutating || !this.state.confirmingRemove) return Promise.resolve();
    return this.run("removing", () => this.api.removeCredential(CREDENTIAL_SLOT), "Key removed.");
  }

  /** Whether the dialog may close now (not while a change is in flight). */
  canClose(): boolean {
    return !this.mutating;
  }

  /** After close, no answer changes anything. */
  close(): void {
    this.closed = true;
  }
}
