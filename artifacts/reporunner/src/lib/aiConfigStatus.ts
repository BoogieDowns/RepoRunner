// Stage 4I: the internal Settings dialog's read-only AI configuration status,
// kept free of React so it can be tested directly.
//
// - Read only. Nothing here saves, edits, tests or connects to anything.
// - Results are re-checked and copied field by field: anything unexpected is
//   treated as a failure, and nothing but known metadata (never an endpoint,
//   model, revision, credential, path or error text) reaches the UI.
// - Loaded once per dialog opening. An answer that arrives after the dialog
//   closed, or after a newer request, is ignored.
// - All wording is fixed. Nothing describes a configuration as connected,
//   validated or ready: no AI adapter exists in this version.
import type { AiConfigStatusIpcResult, AiConfigStatusView, RepoRunnerAPI } from "../types";

export type AiConfigStatusApi = () => Promise<AiConfigStatusIpcResult>;

/** The status method, or null when this launch doesn't provide it (every packaged build). */
export function getAiConfigStatusApi(api: Partial<RepoRunnerAPI> | undefined): AiConfigStatusApi | null {
  const method = api?.aiConfigStatus;
  return typeof method === "function" ? () => method.call(api) : null;
}

const STORAGE = ["missing", "valid", "damaged", "unsupported-version", "unreadable"] as const;
const API_STYLES = ["openai-compatible", "ollama-native"] as const;
const READINESS = ["none", "api-key", "local-endpoint"] as const;
const ID = /^cfg-[a-z0-9]{1,24}$/;
const DAMAGE = /^[a-z][a-z-]{0,40}$/;
const MAX_CONFIGS = 3;

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

/** Reads a result defensively; anything that isn't a well-formed status becomes a failure. */
export function readAiConfigStatus(value: unknown): AiConfigStatusIpcResult {
  const failed: AiConfigStatusIpcResult = { ok: false, error: "failed" };
  if (!isPlain(value)) return failed;
  if (value.ok === false) return { ok: false, error: value.error === "invalid-request" ? "invalid-request" : "failed" };
  if (value.ok !== true || !isPlain(value.status)) return failed;
  const s = value.status;
  if (!oneOf(STORAGE, s.storage) || !oneOf(READINESS, s.providerReadiness)) return failed;
  const count = s.configurationCount;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_CONFIGS) return failed;
  const damage = s.damage;
  if (s.storage === "damaged" ? typeof damage !== "string" || !DAMAGE.test(damage) : damage !== null) return failed;
  let active: AiConfigStatusView["active"] = null;
  if (s.active !== null) {
    const a = s.active;
    if (!isPlain(a) || typeof a.id !== "string" || !ID.test(a.id) || a.kind !== "local-endpoint" || !oneOf(API_STYLES, a.apiStyle)) return failed;
    active = { id: a.id, kind: "local-endpoint", apiStyle: a.apiStyle };
  }
  // Only a valid file has configurations or a selection.
  if (s.storage !== "valid" && (count !== 0 || active !== null)) return failed;
  if (active && count === 0) return failed;
  return { ok: true, status: { storage: s.storage, damage: s.storage === "damaged" ? (damage as string) : null, configurationCount: count, active, providerReadiness: s.providerReadiness } };
}

/** Always shown: there is no AI adapter in this version. */
export const AI_UNAVAILABLE_TEXT = "No AI connection is available in this version.";

export const AI_STATUS_TEXT = {
  loading: "Checking…",
  missing: "No AI configuration is saved.",
  empty: "AI settings are saved, with no configurations.",
  damaged: "The AI settings file is damaged. RepoRunner left it unchanged.",
  "unsupported-version": "The AI settings file comes from a newer version of RepoRunner. This version left it unchanged.",
  unreadable: "RepoRunner couldn't read the AI settings.",
  failed: "AI configuration status isn't available right now.",
} as const;

const API_STYLE_LABEL: Record<(typeof API_STYLES)[number], string> = {
  "openai-compatible": "OpenAI-compatible",
  "ollama-native": "Ollama",
};

export interface AiStatusLines {
  /** The storage state, in plain words. */
  summary: string;
  /** The selection, when there are configurations. */
  selection: string | null;
}

/** Fixed wording for a status. Never includes an endpoint, model, revision or error text. */
export function describeAiStatus(state: AiStatusState): AiStatusLines {
  if (state.phase === "loading") return { summary: AI_STATUS_TEXT.loading, selection: null };
  if (state.phase === "failed") return { summary: AI_STATUS_TEXT.failed, selection: null };
  const s = state.status;
  if (s.storage !== "valid") return { summary: AI_STATUS_TEXT[s.storage], selection: null };
  if (s.configurationCount === 0) return { summary: AI_STATUS_TEXT.empty, selection: null };
  const n = s.configurationCount;
  const summary = `${n} local AI configuration${n === 1 ? "" : "s"} saved.`;
  const selection = s.active ? `Selected: ${s.active.id} (${API_STYLE_LABEL[s.active.apiStyle]}).` : "None is selected.";
  return { summary, selection };
}

export type AiStatusState = { phase: "loading" } | { phase: "failed" } | { phase: "loaded"; status: AiConfigStatusView };

export const AI_STATUS_INITIAL: AiStatusState = Object.freeze({ phase: "loading" });

/** Loads the status once per dialog opening; late or stale answers are ignored. */
export class AiConfigStatusLoader {
  private request = 0;
  private closed = false;

  constructor(
    private readonly api: AiConfigStatusApi,
    private readonly onChange: (state: AiStatusState) => void,
  ) {}

  async load(): Promise<void> {
    if (this.closed) return;
    const id = ++this.request;
    let result: AiConfigStatusIpcResult;
    try {
      result = readAiConfigStatus(await this.api());
    } catch {
      // An IPC rejection has no useful detail for the user.
      result = { ok: false, error: "failed" };
    }
    if (this.closed || id !== this.request) return;
    this.onChange(result.ok ? { phase: "loaded", status: result.status } : { phase: "failed" });
  }

  /** After close, no answer changes anything. */
  close(): void {
    this.closed = true;
  }
}
