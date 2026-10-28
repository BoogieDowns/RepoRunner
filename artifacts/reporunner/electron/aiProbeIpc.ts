import { loadAiSettings } from "./aiSettingsService.js";
import { probeLocalEndpoint } from "./localProbe.js";
import { AI_CONFIG_ID_PATTERN } from "../src/lib/ai/settingsSchema.js";
import { buildProbeRequest, PROBE_MAX_MODELS, type ProbeResult, type ProbeStatusClass } from "../src/lib/ai/probeSpec.js";

/*
 * Local AI connection probe IPC (Stage 4O): one channel, "ai-config-probe".
 * Main process only: no preload method, renderer API or UI reaches it yet.
 *
 * ipc.ts registers it through the shared sender guard and behind the same
 * startup-decided internal gate as the credential and AI editing handlers
 * (aiConfigProbeNotAvailable() when off: nothing is loaded or contacted).
 * Then, in this order:
 *   1. exactly (configId, expectedRevision): a saved configuration id and
 *      64 lowercase hex characters. No URL, host, port, path or object.
 *   2. the saved settings, through the AI settings service (never created);
 *   3. the revision must equal the file's current revision ("conflict");
 *   4. the id must exist in that document ("not-found");
 *   5. the stored endpoint is checked again (buildProbeRequest: canonical
 *      loopback only, "invalid-configuration");
 *   6. its port must not belong to a RepoRunner-run project service or the
 *      app's own dev server ("port-in-use-by-project"); see ipc.ts;
 *   7. one probe at a time in the whole main process ("busy"), and 2 s after
 *      the last probe finished ("rate-limited"), checked and taken in one
 *      synchronous step;
 *   8. the Stage 4N transport (electron/localProbe.ts), which validates the
 *      endpoint once more and owns every network limit.
 * Calls refused before step 8 never touch the busy flag or the cooldown.
 *
 * - The coordinator owns the AbortController handed to the transport. The
 *   caller's signal (ipc.ts aborts it when the window's webContents is
 *   destroyed or its renderer is gone) aborts it; the transport's own 8 s
 *   deadline applies regardless. No cancellation channel.
 * - Results are fixed codes, plus at most a model count or an HTTP status
 *   class, copied field by field: never server text, the endpoint, a path or
 *   an error message. Nothing is stored, logged or used to change readiness,
 *   capabilities or the active selection. No credential is read.
 * - A compatible answer says only that something on that loopback port
 *   answered in the expected shape: not which program, not that it's trusted.
 */

export const AI_CONFIG_PROBE_CHANNEL = "ai-config-probe";
/** Time after a probe finishes before the next may start. */
export const AI_PROBE_COOLDOWN_MS = 2000;

const REVISION = /^[0-9a-f]{64}$/;

export type AiConfigProbeError =
  | "not-available"
  | "invalid-request"
  | "missing"
  | "damaged"
  | "unsupported-version"
  | "unreadable"
  | "conflict"
  | "not-found"
  | "invalid-configuration"
  | "port-in-use-by-project"
  | "busy"
  | "rate-limited"
  | "cancelled"
  | "failed";

type ProbeOutcomeOnly = Exclude<ProbeResult["outcome"], "compatible" | "http-error" | "invalid-request" | "cancelled" | "failed">;

export type AiConfigProbeIpcResult =
  | { ok: true; outcome: "compatible"; modelCount: number | null }
  | { ok: true; outcome: "http-error"; statusClass: ProbeStatusClass }
  | { ok: true; outcome: ProbeOutcomeOnly }
  | { ok: false; error: AiConfigProbeError };

const OUTCOMES_ONLY: readonly ProbeOutcomeOnly[] = [
  "incompatible-response",
  "redirect-refused",
  "auth-required",
  "not-found-at-path",
  "connection-refused",
  "timeout",
  "response-too-large",
  "address-mismatch",
];
const STATUS_CLASSES: readonly ProbeStatusClass[] = ["1xx", "2xx", "4xx", "5xx", "other"];

const fail = (error: AiConfigProbeError): AiConfigProbeIpcResult => ({ ok: false, error });

/** The answer when the internal gate is off. Touches nothing. */
export function aiConfigProbeNotAvailable(): AiConfigProbeIpcResult {
  return fail("not-available");
}

/** Copies only known fields and values from a transport result. */
function project(result: ProbeResult): AiConfigProbeIpcResult {
  switch (result.outcome) {
    case "compatible": {
      const count = result.modelCount;
      if (count === null || (Number.isInteger(count) && count >= 0 && count <= PROBE_MAX_MODELS)) return { ok: true, outcome: "compatible", modelCount: count };
      return fail("failed");
    }
    case "http-error":
      return STATUS_CLASSES.includes(result.statusClass) ? { ok: true, outcome: "http-error", statusClass: result.statusClass } : fail("failed");
    case "invalid-request":
      return fail("invalid-configuration");
    case "cancelled":
      return fail("cancelled");
    default:
      return OUTCOMES_ONLY.includes(result.outcome as ProbeOutcomeOnly) ? { ok: true, outcome: result.outcome as ProbeOutcomeOnly } : fail("failed");
  }
}

export interface AiProbeDependencies {
  loadSettings: typeof loadAiSettings;
  probe: typeof probeLocalEndpoint;
  /** Monotonic milliseconds. */
  now: () => number;
}

export interface AiProbeContext {
  /** Aborts an active probe (the caller's window is gone). */
  signal?: AbortSignal;
  /** Ports RepoRunner's own project services and dev server use right now. */
  projectPorts: () => readonly number[];
}

/** One probe at a time, with a cooldown. Create one per process (sharedAiProbeCoordinator). */
export class AiProbeCoordinator {
  private active = false;
  private lastFinished: number | null = null;

  constructor(private readonly deps: AiProbeDependencies) {}

  async run(args: unknown[], context: AiProbeContext): Promise<AiConfigProbeIpcResult> {
    // 1. Exact arguments, before anything is read.
    if (args.length !== 2) return fail("invalid-request");
    const [configId, expectedRevision] = args;
    if (typeof configId !== "string" || !AI_CONFIG_ID_PATTERN.test(configId)) return fail("invalid-request");
    if (typeof expectedRevision !== "string" || !REVISION.test(expectedRevision)) return fail("invalid-request");

    try {
      // 2. The saved settings.
      const loaded = await this.deps.loadSettings();
      switch (loaded.status) {
        case "valid":
          break;
        case "missing":
          return fail("missing");
        case "damaged":
          return fail("damaged");
        case "unsupported-version":
          return fail("unsupported-version");
        case "unreadable":
          return fail("unreadable");
        default:
          return fail("failed");
      }
      // 3. The document the caller saw.
      if (loaded.revision !== expectedRevision) return fail("conflict");
      // 4. The configuration in it.
      const config = loaded.settings.configs.find((c) => c.id === configId);
      if (!config) return fail("not-found");
      // 5. Its endpoint, checked again here.
      const built = buildProbeRequest({ endpoint: config.endpoint, apiStyle: config.apiStyle });
      if (!built.ok) return fail("invalid-configuration");
      // 6. Not a port RepoRunner's own project or dev server is using.
      const ports = context.projectPorts();
      if (!Array.isArray(ports)) return fail("failed");
      if (ports.includes(built.request.port)) return fail("port-in-use-by-project");
      if (context.signal?.aborted) return fail("cancelled");

      // 7. Checked and taken together: no await between them.
      if (this.active) return fail("busy");
      if (this.lastFinished !== null && this.deps.now() - this.lastFinished < AI_PROBE_COOLDOWN_MS) return fail("rate-limited");
      this.active = true;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      context.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // 8. The transport, with the stored values only.
        return project(await this.deps.probe({ endpoint: config.endpoint, apiStyle: config.apiStyle }, { signal: controller.signal }));
      } catch {
        return fail("failed");
      } finally {
        context.signal?.removeEventListener("abort", onAbort);
        this.lastFinished = this.deps.now();
        this.active = false;
      }
    } catch {
      return fail("failed");
    }
  }
}

let shared: AiProbeCoordinator | null = null;

/** The main process's one coordinator, created on first use. */
export function sharedAiProbeCoordinator(): AiProbeCoordinator {
  if (!shared) shared = new AiProbeCoordinator({ loadSettings: loadAiSettings, probe: probeLocalEndpoint, now: () => performance.now() });
  return shared;
}

/** The port of the app's own dev server when the page is served over http (development only), else none. */
export function devServerPorts(appPageUrl: string | undefined): number[] {
  if (!appPageUrl) return [];
  try {
    const url = new URL(appPageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    return [url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80];
  } catch {
    return [];
  }
}

/** What a sender looks like here: an Electron webContents (the trusted main window's). */
export interface ProbeSender {
  once(event: "destroyed" | "render-process-gone", listener: () => void): unknown;
  removeListener(event: "destroyed" | "render-process-gone", listener: () => void): unknown;
}

/**
 * The handler body (after the sender check and the gate): runs the shared
 * coordinator, aborting the probe if the sender's webContents is destroyed or
 * its renderer is gone.
 */
export async function aiConfigProbe(args: unknown[], sender: ProbeSender, projectPorts: () => readonly number[]): Promise<AiConfigProbeIpcResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  sender.once("destroyed", abort);
  sender.once("render-process-gone", abort);
  try {
    return await sharedAiProbeCoordinator().run(args, { signal: controller.signal, projectPorts });
  } finally {
    sender.removeListener("destroyed", abort);
    sender.removeListener("render-process-gone", abort);
  }
}
