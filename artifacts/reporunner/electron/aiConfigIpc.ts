import { getAiConfigurationStatus } from "./aiSettingsService.js";
import type { AiConfigStatusIpcResult } from "../src/types.js";

/*
 * AI configuration status IPC (Stage 4H): one read-only channel,
 * "ai-config-status". ipc.ts registers it through the same sender guard as
 * every other handler, so an untrusted caller is refused before any of this
 * runs (the service isn't touched, no file is read).
 *
 * - Reachable from the renderer only through aiConfigStatus(), which the
 *   preload adds in internal development launches (Stage 4I, the same switch
 *   as the credential methods; see internalFeatures.ts). The checks here
 *   apply either way.
 * - Takes no arguments; any argument (even undefined) is refused.
 * - Returns the Stage 4G status, copied field by field: storage state, damage
 *   reason, configuration count, the active configuration's id, kind and API
 *   style, and provider readiness ("none" while no adapter exists). Never an
 *   endpoint, model, settings document, revision, credential, path or system
 *   error. (The revision stays in the store and service, for a future
 *   editing contract.)
 * - Reading status never writes; a missing file stays missing. The first
 *   call creates the service's one store (lazily); later calls share it.
 * - Nothing here writes, tests an endpoint, touches credentials or the
 *   network, logs, or throws.
 */

export const AI_CONFIG_STATUS_CHANNEL = "ai-config-status";

export type { AiConfigStatusIpcResult };

export async function aiConfigStatus(args: unknown[]): Promise<AiConfigStatusIpcResult> {
  if (args.length !== 0) return { ok: false, error: "invalid-request" };
  try {
    const s = await getAiConfigurationStatus();
    // Only these fields cross IPC, whatever the service returns.
    return {
      ok: true,
      status: {
        storage: s.storage,
        damage: s.damage,
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
