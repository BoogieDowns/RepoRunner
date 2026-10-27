import { app } from "electron";
import { AiSettingsStore, type AiSettingsDamage, type AiSettingsLoadResult, type AiSettingsSaveResult } from "./aiSettingsStore.js";
import { PRODUCTION_AI_ADAPTERS, deriveProviderReadiness } from "../src/lib/ai/providerReadiness.js";
import type { AiConfigKind, LocalApiStyle } from "../src/lib/ai/settingsSchema.js";
import type { ProviderReadiness } from "../src/lib/editions/types.js";

/*
 * The application's one AI settings store (Stage 4G). Nothing uses it yet: no
 * startup code, IPC handler, preload or UI calls it, so it changes nothing.
 *
 * - Created on first use, never at startup: importing this module does
 *   nothing, and nothing reads the settings file until a function here is
 *   called. Reading status never writes.
 * - One store per process, so its operations stay serialized. Every
 *   main-process consumer must use these functions and never construct an
 *   AiSettingsStore. Another process isn't guarded against here; the
 *   single-instance lock in main.ts keeps a second app instance away.
 * - Non-secret configuration only. No credential is read (the credential
 *   service isn't touched), no network or endpoint is contacted, and the
 *   environment isn't consulted.
 * - Provider readiness comes from the Stage 4E mapping with the real
 *   production adapter registry, which is empty, so it is "none" in every
 *   state. It is the capability model's input, not proof that any AI
 *   feature works; nothing here infers connectivity, licensing or consent.
 * - Failures are fixed results. If the userData folder can't be resolved,
 *   the result is "unreadable" and no store is created (a later call tries
 *   again).
 */

let store: AiSettingsStore | null = null;

/** The shared store, or null when userData can't be resolved (nothing is cached then). */
function sharedStore(): AiSettingsStore | null {
  if (store) return store;
  try {
    store = new AiSettingsStore({ dir: app.getPath("userData") });
  } catch {
    return null;
  }
  return store;
}

/** The settings, or why they can't be used. A missing file gives the empty document and writes nothing. */
export async function loadAiSettings(): Promise<AiSettingsLoadResult> {
  const s = sharedStore();
  return s ? s.load() : { status: "unreadable" };
}

/** Replaces the whole document; `expectedRevision` is the revision it was based on (null when the file was missing). */
export async function saveAiSettings(settings: unknown, expectedRevision: string | null): Promise<AiSettingsSaveResult> {
  const s = sharedStore();
  return s ? s.save(settings, expectedRevision) : { ok: false, error: "unreadable" };
}

/** Metadata about the stored configuration: no endpoint, model or credential. */
export interface AiConfigurationStatus {
  /** The settings file's state. Only "missing" and "valid" have configurations. */
  storage: AiSettingsLoadResult["status"];
  /** Why the file is damaged; null otherwise. */
  damage: AiSettingsDamage | null;
  /** For a later save; null unless the file is valid. */
  revision: string | null;
  configurationCount: number;
  active: { id: string; kind: AiConfigKind; apiStyle: LocalApiStyle } | null;
  /** The capability model's input. "none" whenever the settings aren't valid or no adapter exists (always, in this version). */
  providerReadiness: ProviderReadiness;
}

export async function getAiConfigurationStatus(): Promise<AiConfigurationStatus> {
  const loaded = await loadAiSettings();
  if (loaded.status !== "missing" && loaded.status !== "valid") {
    return {
      storage: loaded.status,
      damage: loaded.status === "damaged" ? loaded.reason : null,
      revision: null,
      configurationCount: 0,
      active: null,
      providerReadiness: "none",
    };
  }
  const { settings } = loaded;
  const config = settings.configs.find((c) => c.id === settings.active) ?? null;
  return {
    storage: loaded.status,
    damage: null,
    revision: loaded.revision,
    configurationCount: settings.configs.length,
    active: config ? { id: config.id, kind: config.kind, apiStyle: config.apiStyle } : null,
    // No credential metadata: no production adapter exists, so none could need one.
    providerReadiness: deriveProviderReadiness(settings, null, PRODUCTION_AI_ADAPTERS),
  };
}
