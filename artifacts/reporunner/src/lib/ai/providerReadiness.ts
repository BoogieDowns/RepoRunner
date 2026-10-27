// Stage 4E: turns AI configuration into the Stage 1 capability model's
// ProviderReadiness input. Pure: no files, credentials, network or clock, and
// nothing in the app uses it yet.
//
// "Ready" here means only "configured for something this version can talk
// to". It never means the provider is reachable, the model can do the task,
// the user is licensed or the user agreed to a request; those are separate
// facts, decided elsewhere (connectivity and consent at request time,
// entitlement and implementation in src/lib/editions/capabilities.ts).
//
// Fails closed: anything missing, damaged or unrecognized gives "none".
// - No active configuration, or settings that don't validate: none.
// - No adapter in the registry for the configuration's kind and API style:
//   none. A saved key or an entered endpoint alone is never enough.
// - An adapter that needs a credential, without well-formed metadata saying
//   one is configured: none. Only metadata is read, never a key.
//
// The production registry is empty in this version, so every real
// configuration gives "none".
import type { ProviderReadiness } from "../editions/types";
import type { CredentialIpcResult } from "../../types";
import { validateAiSettings, LOCAL_API_STYLES, type AiConfigKind, type LocalApiStyle } from "./settingsSchema";

/** What an adapter in this build can serve. Describes code that exists; it is not configuration. */
export interface AiAdapterDescriptor {
  kind: AiConfigKind;
  apiStyle: LocalApiStyle;
  /** Whether requests need a stored credential (for example endpoint authentication). */
  requiresCredential: boolean;
}

/** The adapters this version of RepoRunner contains. None. */
export const PRODUCTION_AI_ADAPTERS: readonly AiAdapterDescriptor[] = Object.freeze([]);

const DESCRIPTOR_KEYS = ["kind", "apiStyle", "requiresCredential"];

/** A well-formed descriptor (exact own data fields), or null. */
function readDescriptor(value: unknown): AiAdapterDescriptor | null {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== DESCRIPTOR_KEYS.length || !keys.every((k) => typeof k === "string" && DESCRIPTOR_KEYS.includes(k))) return null;
  const field = (key: string) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && "value" in d ? d.value : undefined;
  };
  const kind = field("kind");
  const apiStyle = field("apiStyle");
  const requiresCredential = field("requiresCredential");
  if (kind !== "local-endpoint" || !(LOCAL_API_STYLES as readonly unknown[]).includes(apiStyle) || typeof requiresCredential !== "boolean") return null;
  return { kind, apiStyle: apiStyle as LocalApiStyle, requiresCredential };
}

/**
 * True only for metadata of the exact shape { ok: true, status: { configured: true, ... } }.
 * Reads the "ok", "status" and "configured" data fields and nothing else.
 */
function credentialConfigured(metadata: unknown): boolean {
  const read = (value: unknown, key: string): unknown => {
    if (typeof value !== "object" || value === null) return undefined;
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && "value" in d ? d.value : undefined;
  };
  return read(metadata, "ok") === true && read(read(metadata, "status"), "configured") === true;
}

/**
 * The ProviderReadiness for the active configuration.
 *
 * @param settings  An AI settings document (re-validated here).
 * @param credentialMetadata  The credential status result for the configuration's credential, if any. Metadata only.
 * @param availableAdapters  The adapters this build contains (PRODUCTION_AI_ADAPTERS in the app).
 */
export function deriveProviderReadiness(
  settings: unknown,
  credentialMetadata: CredentialIpcResult | null | undefined,
  availableAdapters: readonly AiAdapterDescriptor[],
): ProviderReadiness {
  try {
    const checked = validateAiSettings(settings);
    if (!checked.ok || checked.settings.active === null) return "none";
    const { active, configs } = checked.settings;
    const config = configs.find((c) => c.id === active);
    if (!config) return "none";
    if (!Array.isArray(availableAdapters)) return "none";
    const adapter = availableAdapters.map(readDescriptor).find((a) => a !== null && a.kind === config.kind && a.apiStyle === config.apiStyle);
    if (!adapter) return "none";
    if (adapter.requiresCredential && !credentialConfigured(credentialMetadata)) return "none";
    return "local-endpoint";
  } catch {
    return "none";
  }
}
