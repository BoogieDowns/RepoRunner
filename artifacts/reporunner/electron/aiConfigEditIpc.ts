import { loadAiSettings, saveAiSettings } from "./aiSettingsService.js";
import type { AiSettings } from "../src/lib/ai/settingsSchema.js";
import type { AiConfigEditLoadResult, AiConfigEditSaveResult } from "../src/types.js";

/*
 * AI configuration editing IPC (Stage 4K): "ai-config-edit-load" and
 * "ai-config-edit-save". Main process only: no preload method, renderer API
 * or UI reaches them yet.
 *
 * ipc.ts registers both through the shared sender guard and the same
 * startup-decided internal gate as the credential handlers (unpackaged with
 * REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS=1). Order: sender check, gate
 * (aiConfigEditNotAvailable() when off), then the exact arguments here, then
 * the AI settings service. Nothing here reads the environment.
 *
 * - load takes no arguments and returns the validated, non-secret document
 *   and its revision (null when the file is missing; nothing is created).
 *   A damaged, newer or unreadable file gives a fixed code (with the fixed
 *   damage reason), never its contents.
 * - save takes exactly (settings, expectedRevision): a plain object, and
 *   null or 64 lowercase hex characters. It replaces the whole document
 *   through the service, which validates it with the Stage 4E schema
 *   (loopback-only endpoints, at most three configurations, no secrets, at
 *   most 16 KiB), checks the revision and writes atomically. A damaged, newer
 *   or unreadable file is never replaced. The result is the document as
 *   parsed back from the bytes written, with the new revision.
 * - Everything is copied field by field; errors are fixed codes. No path,
 *   system message, credential or network access.
 */

export const AI_CONFIG_EDIT_CHANNELS = Object.freeze(["ai-config-edit-load", "ai-config-edit-save"] as const);

// The contract is shared with the renderer (src/types.ts, Stage 4L), so a
// change on either side fails to compile.
export type { AiConfigEditLoadResult, AiConfigEditSaveResult };

const REVISION = /^[0-9a-f]{64}$/;
const SAVE_ERRORS = ["conflict", "damaged", "unsupported-version", "unreadable", "write-failed"] as const;

/** The answer when the internal gate is off. Touches nothing. */
export function aiConfigEditNotAvailable(): { ok: false; error: "not-available" } {
  return { ok: false, error: "not-available" };
}

/** A fresh copy with exactly the schema's fields. */
function project(settings: AiSettings): AiSettings {
  return {
    format: settings.format,
    version: settings.version,
    active: settings.active,
    configs: settings.configs.map((c) => ({ id: c.id, kind: c.kind, endpoint: c.endpoint, apiStyle: c.apiStyle, model: c.model })),
  };
}

/** A plain object, as structured clone delivers one: not an array, null, primitive or class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export async function aiConfigEditLoad(args: unknown[]): Promise<AiConfigEditLoadResult> {
  if (args.length !== 0) return { ok: false, error: "invalid-request" };
  try {
    const loaded = await loadAiSettings();
    switch (loaded.status) {
      case "missing":
        return { ok: true, state: "missing", revision: null, settings: project(loaded.settings) };
      case "valid":
        if (!REVISION.test(loaded.revision)) return { ok: false, error: "failed" };
        return { ok: true, state: "valid", revision: loaded.revision, settings: project(loaded.settings) };
      case "damaged":
        return { ok: false, error: "damaged", damage: loaded.reason };
      case "unsupported-version":
        return { ok: false, error: "unsupported-version" };
      case "unreadable":
        return { ok: false, error: "unreadable" };
      default:
        return { ok: false, error: "failed" };
    }
  } catch {
    // Anything unexpected: a fixed code, never the message.
    return { ok: false, error: "failed" };
  }
}

export async function aiConfigEditSave(args: unknown[]): Promise<AiConfigEditSaveResult> {
  if (args.length !== 2) return { ok: false, error: "invalid-request" };
  const [settings, expectedRevision] = args;
  if (!(expectedRevision === null || (typeof expectedRevision === "string" && REVISION.test(expectedRevision)))) {
    return { ok: false, error: "invalid-request" };
  }
  if (!isPlainObject(settings)) return { ok: false, error: "invalid-request" };
  try {
    const saved = await saveAiSettings(settings, expectedRevision);
    if (saved.ok) {
      if (!REVISION.test(saved.revision)) return { ok: false, error: "failed" };
      return { ok: true, revision: saved.revision, settings: project(saved.settings) };
    }
    if (saved.error === "invalid-settings") return { ok: false, error: "invalid-settings", detail: saved.detail };
    return (SAVE_ERRORS as readonly string[]).includes(saved.error) ? { ok: false, error: saved.error } : { ok: false, error: "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}
