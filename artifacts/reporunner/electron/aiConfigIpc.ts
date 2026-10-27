import { getAiConfigurationStatus, type AiConfigurationStatus } from "./aiSettingsService.js";

/*
 * AI configuration status IPC (Stage 4H): one read-only channel,
 * "ai-config-status". ipc.ts registers it through the same sender guard as
 * every other handler, so an untrusted caller is refused before any of this
 * runs (the service isn't touched, no file is read).
 *
 * - No preload method exposes it yet, so the renderer can't reach it.
 * - Takes no arguments; any argument (even undefined) is refused.
 * - Returns the Stage 4G status, copied field by field: storage state, damage
 *   reason, revision, configuration count, the active configuration's id,
 *   kind and API style, and provider readiness ("none" while no adapter
 *   exists). Never an endpoint, model, settings document, credential, path
 *   or system error.
 * - Reading status never writes; a missing file stays missing. The first
 *   call creates the service's one store (lazily); later calls share it.
 * - Nothing here writes, tests an endpoint, touches credentials or the
 *   network, logs, or throws.
 */

export const AI_CONFIG_STATUS_CHANNEL = "ai-config-status";

export type AiConfigStatusResult = { ok: true; status: AiConfigurationStatus } | { ok: false; error: "invalid-request" | "failed" };

export async function aiConfigStatus(args: unknown[]): Promise<AiConfigStatusResult> {
  if (args.length !== 0) return { ok: false, error: "invalid-request" };
  try {
    const s = await getAiConfigurationStatus();
    // Only these fields cross IPC, whatever the service returns.
    return {
      ok: true,
      status: {
        storage: s.storage,
        damage: s.damage,
        revision: s.revision,
        configurationCount: s.configurationCount,
        active: s.active ? { id: s.active.id, kind: s.active.kind, apiStyle: s.active.apiStyle } : null,
        providerReadiness: s.providerReadiness,
      },
    };
  } catch {
    // Anything unexpected: a fixed code, never the message.
    return { ok: false, error: "failed" };
  }
}
