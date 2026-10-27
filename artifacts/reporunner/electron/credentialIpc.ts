import { getCredentialStore } from "./credentialService.js";
import { CredentialStoreError, MAX_SECRET_BYTES, type CredentialStoreErrorCode } from "./credentialStore.js";

/*
 * Credential IPC (Stage 4B): "credential-status", "credential-set" and
 * "credential-remove". ipc.ts registers them through the same sender guard as
 * every other handler, so an untrusted caller is refused before any of this
 * runs (no store is created, no file is read, no encryption check is made).
 *
 * Rules:
 * - No handler ever returns a credential or anything derived from one. There
 *   is no "get" channel; getCredential() is for future main-process consumers.
 * - The key travels renderer → main once, as the secret argument of
 *   "credential-set", and never back.
 * - Only byok-slot-1 is accepted for now.
 * - Arguments are checked exactly (count, types, option keys) before the store
 *   is touched; nothing is coerced.
 * - Results are fixed shapes with fixed codes. Nothing here throws, so
 *   Electron never logs a handler error, and nothing here logs at all.
 * - Not exposed through preload yet: the renderer can't reach these channels.
 */

export const CREDENTIAL_CHANNELS = Object.freeze(["credential-status", "credential-set", "credential-remove"] as const);

/** The one slot the IPC accepts in this stage. */
const IPC_SLOT = "byok-slot-1";

export interface CredentialMetadata {
  configured: boolean;
  mode: "remembered" | "session" | null;
  /** Whether "remember" can be used on this computer. */
  persistence: "available" | "unavailable" | "insecure";
}

/** Store codes pass through, except invalid-slot (reported as invalid-request). */
export type CredentialIpcErrorCode = "invalid-request" | "busy" | "failed" | Exclude<CredentialStoreErrorCode, "invalid-slot">;

export type CredentialIpcResult = { ok: true; status: CredentialMetadata } | { ok: false; error: CredentialIpcErrorCode };

const fail = (error: CredentialIpcErrorCode): CredentialIpcResult => ({ ok: false, error });

function toErrorCode(error: unknown): CredentialIpcErrorCode {
  if (error instanceof CredentialStoreError) return error.code === "invalid-slot" ? "invalid-request" : error.code;
  // Anything unexpected: a fixed code, never the message.
  return "failed";
}

const isSlotArg = (args: unknown[]) => args.length === 1 && args[0] === IPC_SLOT;

/** A non-empty string within the store's UTF-8 byte limit, without NUL or line breaks. */
function isValidSecret(secret: unknown): secret is string {
  if (typeof secret !== "string" || secret.length === 0) return false;
  // Each UTF-16 unit is at least one UTF-8 byte, so this avoids encoding a huge string.
  if (secret.length > MAX_SECRET_BYTES || Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) return false;
  return !/[\u0000\r\n]/.test(secret);
}

/** Exactly `{ remember: boolean }`: a plain object with that one own key. */
function readRememberOption(value: unknown): boolean | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "remember") return null;
  const remember = (value as { remember: unknown }).remember;
  return typeof remember === "boolean" ? remember : null;
}

async function metadata(): Promise<CredentialMetadata> {
  const store = getCredentialStore();
  const status = await store.status(IPC_SLOT);
  const availability = store.persistenceAvailability();
  const persistence = availability.available ? "available" : availability.reason === "encryption-insecure" ? "insecure" : "unavailable";
  return { configured: status.configured, mode: status.mode, persistence };
}

/*
 * Ordering: the store runs operations one at a time, in call order. One set or
 * remove may be in flight; another set or remove meanwhile gets "busy"
 * (never queued). A status call is never refused: it waits behind the
 * mutation in the store's queue and reports the state after it.
 */
let mutating = false;

async function mutate(run: () => Promise<void>): Promise<CredentialIpcResult> {
  if (mutating) return fail("busy");
  mutating = true;
  try {
    await run();
    return { ok: true, status: await metadata() };
  } catch (error) {
    return fail(toErrorCode(error));
  } finally {
    mutating = false;
  }
}

export async function credentialStatus(args: unknown[]): Promise<CredentialIpcResult> {
  if (!isSlotArg(args)) return fail("invalid-request");
  try {
    return { ok: true, status: await metadata() };
  } catch (error) {
    return fail(toErrorCode(error));
  }
}

export async function credentialSet(args: unknown[]): Promise<CredentialIpcResult> {
  if (args.length !== 3 || args[0] !== IPC_SLOT) return fail("invalid-request");
  const remember = readRememberOption(args[2]);
  if (remember === null) return fail("invalid-request");
  const secret = args[1];
  if (!isValidSecret(secret)) return fail("invalid-secret");
  return mutate(() => getCredentialStore().setCredential(IPC_SLOT, secret, { remember }));
}

export async function credentialRemove(args: unknown[]): Promise<CredentialIpcResult> {
  if (!isSlotArg(args)) return fail("invalid-request");
  return mutate(() => getCredentialStore().removeCredential(IPC_SLOT));
}
