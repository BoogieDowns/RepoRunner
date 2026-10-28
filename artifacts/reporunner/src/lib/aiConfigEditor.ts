// Stage 4L: the internal Settings dialog's local AI configuration editor,
// kept free of React so it can be tested directly.
//
// - Edits change a draft in memory; nothing is written until Save, which
//   sends the whole document with the revision from the last load or save
//   (kept only in this object). The main process validates everything again.
// - A conflict is reported, never retried or merged: Reload fetches the saved
//   version (after confirmation when there are unsaved changes).
// - A damaged, newer or unreadable file disables editing; there's no reset.
// - One request at a time. An answer that arrives after the dialog closed,
//   or after a newer request, is ignored; nothing is sent after close.
// - Saving doesn't connect to anything, and the wording never says it does.
import { AI_MODEL_LABEL_MAX_LENGTH, AI_MODEL_LABEL_PATTERN, AI_SETTINGS_MAX_CONFIGS, validateAiSettings } from "./ai/settingsSchema";
import { validateLocalEndpoint, type LocalEndpointError } from "./ai/localEndpoint";
import type { AiConfigEditDocument, AiConfigEditEntry, AiConfigEditLoadResult, AiConfigEditSaveResult, RepoRunnerAPI } from "../types";

export interface AiConfigEditApi {
  load: () => Promise<AiConfigEditLoadResult>;
  save: (settings: AiConfigEditDocument, expectedRevision: string | null) => Promise<AiConfigEditSaveResult>;
}

/** Both editing methods, or null when this launch doesn't provide them (every packaged build). */
export function getAiConfigEditApi(api: Partial<RepoRunnerAPI> | undefined): AiConfigEditApi | null {
  const load = api?.aiConfigEditLoad;
  const save = api?.aiConfigEditSave;
  if (typeof load !== "function" || typeof save !== "function") return null;
  return { load: () => load.call(api), save: (settings, revision) => save.call(api, settings, revision) };
}

export const API_STYLE_LABELS: Record<AiConfigEditEntry["apiStyle"], string> = {
  "openai-compatible": "OpenAI-compatible",
  "ollama-native": "Ollama",
};

export const AI_EDITOR_TEXT = {
  loading: "Loading saved configurations…",
  saved: "Saved. Not connected — no AI connection is available in this version.",
  conflict: "These settings were changed somewhere else since you opened them. Reload to see the saved version.",
  reloadDiscards: "Reloading discards the changes you haven't saved.",
  damaged: "The AI settings file is damaged, so it can't be edited here. RepoRunner left it unchanged.",
  "unsupported-version": "The AI settings file comes from a newer version of RepoRunner, so this version won't change it.",
  unreadable: "RepoRunner couldn't read the AI settings, so they can't be edited right now.",
  failed: "Something went wrong, so nothing was saved.",
  loadFailed: "The saved configurations couldn't be loaded.",
  writeFailed: "The settings couldn't be saved. The previous version is unchanged.",
  invalid: "These settings can't be saved. Check each endpoint address and model label.",
  notAvailable: "Editing AI configurations isn't available in this launch.",
  limit: `You can save up to ${AI_SETTINGS_MAX_CONFIGS} local AI configurations.`,
  modelInvalid: `Model labels can use letters, digits and . _ : / + - (up to ${AI_MODEL_LABEL_MAX_LENGTH} characters), starting with a letter or digit.`,
} as const;

export const ENDPOINT_MESSAGES: Record<LocalEndpointError, string> = {
  "not-a-string": "Enter an endpoint address.",
  empty: "Enter an endpoint address.",
  "too-long": "That address is too long.",
  "invalid-characters": "The address can't contain spaces, backslashes or non-ASCII characters.",
  "percent-encoding-not-allowed": "The address can't contain %-encoded characters.",
  "credentials-not-allowed": "The address can't contain a username or password.",
  "query-or-fragment-not-allowed": "The address can't contain ? or #.",
  "unsupported-scheme": "Only http:// addresses on this computer are supported.",
  malformed: "That isn't a valid address. Use http://127.0.0.1:<port>.",
  "localhost-not-allowed": "Use 127.0.0.1 or [::1] instead of localhost.",
  "host-not-allowed": "Only this computer is supported: use 127.0.0.1 or [::1], written exactly.",
  "port-required": "Include the port, for example http://127.0.0.1:11434.",
  "invalid-port": "The port must be a number from 1 to 65535.",
  "invalid-path": "The path may contain only letters, digits and . _ ~ - between single slashes.",
  "path-too-long": "The path is too long.",
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const REVISION = /^[0-9a-f]{64}$/;

/** A new id, cfg- plus 16 characters from a cryptographically secure source, unused in `taken`. */
export function newConfigId(taken: ReadonlySet<string>, random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    let suffix = "";
    while (suffix.length < 16) {
      for (const byte of random(new Uint8Array(32))) {
        // Rejection sampling: 252 = 7 * 36, so each character is equally likely.
        if (byte < 252 && suffix.length < 16) suffix += ID_ALPHABET[byte % 36];
      }
    }
    const id = `cfg-${suffix}`;
    if (!taken.has(id)) return id;
  }
  throw new Error("could not generate a unique id");
}

/** Checks a whole document with the Stage 4E schema; returns a fresh copy or null. */
function checkedDocument(value: unknown): AiConfigEditDocument | null {
  const checked = validateAiSettings(value);
  return checked.ok ? (checked.settings as AiConfigEditDocument) : null;
}

/** Load answers, re-checked: anything malformed is a failure. */
export function readLoadResult(value: unknown): AiConfigEditLoadResult {
  if (typeof value !== "object" || value === null) return { ok: false, error: "failed" };
  const r = value as Record<string, unknown>;
  if (r.ok === true) {
    const settings = checkedDocument(r.settings);
    if (!settings || (r.state !== "missing" && r.state !== "valid")) return { ok: false, error: "failed" };
    if (r.state === "missing" ? r.revision !== null : typeof r.revision !== "string" || !REVISION.test(r.revision)) return { ok: false, error: "failed" };
    return { ok: true, state: r.state, revision: r.revision as string | null, settings };
  }
  if (r.ok === false) {
    if (r.error === "damaged") return { ok: false, error: "damaged", damage: "invalid-shape" };
    if (r.error === "unsupported-version" || r.error === "unreadable" || r.error === "not-available") return { ok: false, error: r.error };
  }
  return { ok: false, error: "failed" };
}

/** Save answers, re-checked the same way. */
export function readSaveResult(value: unknown): AiConfigEditSaveResult {
  if (typeof value !== "object" || value === null) return { ok: false, error: "failed" };
  const r = value as Record<string, unknown>;
  if (r.ok === true) {
    const settings = checkedDocument(r.settings);
    if (!settings || typeof r.revision !== "string" || !REVISION.test(r.revision)) return { ok: false, error: "failed" };
    return { ok: true, revision: r.revision, settings };
  }
  if (r.ok === false) {
    if (r.error === "invalid-settings") return { ok: false, error: "invalid-settings", detail: "invalid-shape" };
    const known = ["not-available", "invalid-request", "conflict", "damaged", "unsupported-version", "unreadable", "write-failed"] as const;
    if ((known as readonly unknown[]).includes(r.error)) return { ok: false, error: r.error as (typeof known)[number] };
  }
  return { ok: false, error: "failed" };
}

export interface EntryForm {
  /** The configuration being edited, or null when adding. */
  editingId: string | null;
  endpoint: string;
  apiStyle: AiConfigEditEntry["apiStyle"];
  model: string;
  /** A fixed message for the field, or null. */
  error: string | null;
  /** When the address is valid but written differently: the exact form that would be saved. */
  canonical: string | null;
}

export type BlockedReason = "damaged" | "unsupported-version" | "unreadable";

export interface AiEditorState {
  phase: "loading" | "ready" | "blocked" | "failed";
  blocked: BlockedReason | null;
  /** The working copy (what Save would send). */
  draft: AiConfigEditDocument | null;
  /** Whether the draft differs from what was last loaded or saved. */
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  /** Asking before Reload discards unsaved changes. */
  confirmingReload: boolean;
  /** The configuration awaiting remove confirmation. */
  confirmingRemove: string | null;
  form: EntryForm | null;
  /** A fixed message. */
  error: string | null;
  notice: string | null;
}

export const AI_EDITOR_INITIAL: AiEditorState = Object.freeze({
  phase: "loading",
  blocked: null,
  draft: null,
  dirty: false,
  saving: false,
  conflict: false,
  confirmingReload: false,
  confirmingRemove: null,
  form: null,
  error: null,
  notice: null,
});

const same = (a: AiConfigEditDocument | null, b: AiConfigEditDocument | null) => JSON.stringify(a) === JSON.stringify(b);
const copy = (d: AiConfigEditDocument): AiConfigEditDocument => ({ ...d, configs: d.configs.map((c) => ({ ...c })) });

export class AiConfigEditorController {
  private state: AiEditorState = AI_EDITOR_INITIAL;
  /** The last persisted document and its revision. Kept here only. */
  private saved: AiConfigEditDocument | null = null;
  private revision: string | null = null;
  private request = 0;
  private closed = false;

  constructor(
    private readonly api: AiConfigEditApi,
    private readonly onChange: (state: AiEditorState) => void,
    private readonly onSaved: () => void = () => {},
    private readonly random?: (bytes: Uint8Array) => Uint8Array,
  ) {}

  get current(): AiEditorState {
    return this.state;
  }

  /** Unsaved changes exist (the dialog asks before closing). */
  get hasUnsavedChanges(): boolean {
    return this.state.dirty;
  }

  private set(patch: Partial<AiEditorState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private setDraft(draft: AiConfigEditDocument, extra: Partial<AiEditorState> = {}) {
    this.set({ draft, dirty: !same(draft, this.saved), notice: null, error: null, ...extra });
  }

  private editable(): AiConfigEditDocument | null {
    const s = this.state;
    return !this.closed && s.phase === "ready" && !s.saving && !s.conflict && s.draft ? s.draft : null;
  }

  /** Loads the saved settings (once per opening, and on Reload). */
  async load(): Promise<void> {
    if (this.closed || this.state.saving) return;
    const id = ++this.request;
    this.set({ ...AI_EDITOR_INITIAL });
    let result: AiConfigEditLoadResult;
    try {
      result = readLoadResult(await this.api.load());
    } catch {
      result = { ok: false, error: "failed" };
    }
    if (this.closed || id !== this.request) return;
    if (result.ok) {
      this.saved = copy(result.settings);
      this.revision = result.revision;
      this.set({ ...AI_EDITOR_INITIAL, phase: "ready", draft: copy(result.settings) });
    } else if (result.error === "damaged" || result.error === "unsupported-version" || result.error === "unreadable") {
      this.saved = null;
      this.revision = null;
      this.set({ ...AI_EDITOR_INITIAL, phase: "blocked", blocked: result.error });
    } else {
      this.saved = null;
      this.revision = null;
      this.set({ ...AI_EDITOR_INITIAL, phase: "failed", error: result.error === "not-available" ? AI_EDITOR_TEXT.notAvailable : AI_EDITOR_TEXT.loadFailed });
    }
  }

  /** Reload: asks first when there are unsaved changes. */
  requestReload(): void {
    if (this.closed || this.state.saving) return;
    if (this.state.dirty && !this.state.confirmingReload) {
      this.set({ confirmingReload: true });
      return;
    }
    void this.load();
  }

  cancelReload(): void {
    this.set({ confirmingReload: false });
  }

  startAdd(): void {
    const draft = this.editable();
    if (!draft) return;
    if (draft.configs.length >= AI_SETTINGS_MAX_CONFIGS) {
      this.set({ error: AI_EDITOR_TEXT.limit });
      return;
    }
    this.set({ form: { editingId: null, endpoint: "", apiStyle: "openai-compatible", model: "", error: null, canonical: null }, confirmingRemove: null, notice: null, error: null });
  }

  startEdit(id: string): void {
    const draft = this.editable();
    const entry = draft?.configs.find((c) => c.id === id);
    if (!entry) return;
    this.set({ form: { editingId: id, endpoint: entry.endpoint, apiStyle: entry.apiStyle, model: entry.model ?? "", error: null, canonical: null }, confirmingRemove: null, notice: null, error: null });
  }

  updateForm(patch: Partial<Pick<EntryForm, "endpoint" | "apiStyle" | "model">>): void {
    const form = this.state.form;
    if (!form || !this.editable()) return;
    const next = { ...form, ...patch };
    if (patch.apiStyle !== undefined && patch.apiStyle !== "openai-compatible" && patch.apiStyle !== "ollama-native") return;
    // Any change to the address withdraws a pending canonical suggestion.
    this.set({ form: { ...next, error: null, canonical: patch.endpoint !== undefined ? null : form.canonical } });
  }

  cancelForm(): void {
    this.set({ form: null });
  }

  /**
   * Applies the form to the draft. An invalid address shows a fixed message;
   * a valid one written differently shows the exact canonical form and is
   * applied only after acceptCanonical(). Nothing is normalized silently.
   */
  applyForm(): void {
    const draft = this.editable();
    const form = this.state.form;
    if (!draft || !form) return;
    const checked = validateLocalEndpoint(form.endpoint);
    if (!checked.ok) {
      this.set({ form: { ...form, error: ENDPOINT_MESSAGES[checked.error], canonical: null } });
      return;
    }
    const model = form.model.trim() === "" ? null : form.model;
    if (model !== null && (model.length > AI_MODEL_LABEL_MAX_LENGTH || !AI_MODEL_LABEL_PATTERN.test(model))) {
      this.set({ form: { ...form, error: AI_EDITOR_TEXT.modelInvalid, canonical: null } });
      return;
    }
    if (checked.endpoint.url !== form.endpoint) {
      this.set({ form: { ...form, error: null, canonical: checked.endpoint.url } });
      return;
    }
    this.commitEntry(draft, form, checked.endpoint.url, model);
  }

  /** Uses the shown canonical address. */
  acceptCanonical(): void {
    const draft = this.editable();
    const form = this.state.form;
    if (!draft || !form?.canonical) return;
    const checked = validateLocalEndpoint(form.canonical);
    if (!checked.ok || checked.endpoint.url !== form.canonical) return;
    this.set({ form: { ...form, endpoint: form.canonical, canonical: null } });
    this.applyForm();
  }

  private commitEntry(draft: AiConfigEditDocument, form: EntryForm, endpoint: string, model: string | null) {
    if (form.editingId === null) {
      if (draft.configs.length >= AI_SETTINGS_MAX_CONFIGS) {
        this.set({ error: AI_EDITOR_TEXT.limit });
        return;
      }
      const id = newConfigId(new Set(draft.configs.map((c) => c.id)), this.random);
      this.setDraft({ ...draft, configs: [...draft.configs.map((c) => ({ ...c })), { id, kind: "local-endpoint", endpoint, apiStyle: form.apiStyle, model }] }, { form: null });
    } else {
      const configs = draft.configs.map((c) => (c.id === form.editingId ? { ...c, endpoint, apiStyle: form.apiStyle, model } : { ...c }));
      this.setDraft({ ...draft, configs }, { form: null });
    }
  }

  /** Selects a configuration (or none) as active. */
  select(id: string | null): void {
    const draft = this.editable();
    if (!draft || (id !== null && !draft.configs.some((c) => c.id === id))) return;
    this.setDraft({ ...draft, active: id, configs: draft.configs.map((c) => ({ ...c })) });
  }

  requestRemove(id: string): void {
    const draft = this.editable();
    if (!draft?.configs.some((c) => c.id === id)) return;
    this.set({ confirmingRemove: id, form: null, notice: null, error: null });
  }

  cancelRemove(): void {
    this.set({ confirmingRemove: null });
  }

  /** Removes the confirmed configuration from the draft; clears the selection if it was active. */
  confirmRemove(): void {
    const draft = this.editable();
    const id = this.state.confirmingRemove;
    if (!draft || id === null) return;
    this.setDraft(
      { ...draft, active: draft.active === id ? null : draft.active, configs: draft.configs.filter((c) => c.id !== id).map((c) => ({ ...c })) },
      { confirmingRemove: null },
    );
  }

  /** Sends the whole draft with the last known revision. One at a time; never after close; never retried. */
  async save(): Promise<void> {
    const draft = this.editable();
    if (!draft || this.state.form) return;
    if (!checkedDocument(draft)) {
      this.set({ error: AI_EDITOR_TEXT.invalid, notice: null });
      return;
    }
    const id = ++this.request;
    const sent = copy(draft);
    this.set({ saving: true, error: null, notice: null, confirmingRemove: null });
    let result: AiConfigEditSaveResult;
    try {
      result = readSaveResult(await this.api.save(sent, this.revision));
    } catch {
      result = { ok: false, error: "failed" };
    }
    if (this.closed || id !== this.request) return;
    if (result.ok) {
      this.saved = copy(result.settings);
      this.revision = result.revision;
      this.set({ saving: false, draft: copy(result.settings), dirty: false, notice: AI_EDITOR_TEXT.saved });
      this.onSaved();
      return;
    }
    switch (result.error) {
      case "conflict":
        this.set({ saving: false, conflict: true, error: AI_EDITOR_TEXT.conflict });
        return;
      case "damaged":
      case "unsupported-version":
      case "unreadable":
        this.set({ saving: false, phase: "blocked", blocked: result.error, form: null, error: null });
        return;
      case "invalid-settings":
      case "invalid-request":
        this.set({ saving: false, error: AI_EDITOR_TEXT.invalid });
        return;
      case "write-failed":
        this.set({ saving: false, error: AI_EDITOR_TEXT.writeFailed });
        return;
      case "not-available":
        this.set({ saving: false, error: AI_EDITOR_TEXT.notAvailable });
        return;
      default:
        this.set({ saving: false, error: AI_EDITOR_TEXT.failed });
    }
  }

  /** The dialog may close now (not while a save is in flight). */
  canClose(): boolean {
    return !this.state.saving;
  }

  /** After close nothing is sent and no answer changes anything. */
  close(): void {
    this.closed = true;
  }
}
