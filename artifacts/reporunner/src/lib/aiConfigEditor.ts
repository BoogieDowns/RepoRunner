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
//
// Stage 4P: a manual connection test for a *saved* configuration. The view
// shows the exact request (buildProbeRequest, the same pure function the
// main process uses) and what it does and doesn't prove; one click sends
// only the saved configuration's id and the loaded revision (never a URL).
// Testing needs a loaded file with a revision, no unsaved changes, no open
// form, no save or reload in progress, and no test already running. Results
// are fixed messages, kept only here: any change to the draft, a reload or a
// save clears them, and an answer that arrives after close, a newer test, a
// reload or a revision change is ignored. Nothing is retried or polled.
import { AI_MODEL_LABEL_MAX_LENGTH, AI_MODEL_LABEL_PATTERN, AI_SETTINGS_MAX_CONFIGS, validateAiSettings } from "./ai/settingsSchema";
import { validateLocalEndpoint, type LocalEndpointError } from "./ai/localEndpoint";
import { buildProbeRequest, PROBE_MAX_MODELS } from "./ai/probeSpec";
import type {
  AiConfigEditDocument,
  AiConfigEditEntry,
  AiConfigEditLoadResult,
  AiConfigEditSaveResult,
  AiConfigProbeError,
  AiConfigProbeIpcResult,
  AiConfigProbeOutcome,
  AiConfigProbeStatusClass,
  RepoRunnerAPI,
} from "../types";

export interface AiConfigEditApi {
  load: () => Promise<AiConfigEditLoadResult>;
  save: (settings: AiConfigEditDocument, expectedRevision: string | null) => Promise<AiConfigEditSaveResult>;
  /** Stage 4P: present only when the preload provides it (internal launches). */
  probe?: (configId: string, expectedRevision: string) => Promise<AiConfigProbeIpcResult>;
}

/** Both editing methods (and the probe when provided), or null when this launch doesn't provide them (every packaged build). */
export function getAiConfigEditApi(api: Partial<RepoRunnerAPI> | undefined): AiConfigEditApi | null {
  const load = api?.aiConfigEditLoad;
  const save = api?.aiConfigEditSave;
  if (typeof load !== "function" || typeof save !== "function") return null;
  const probe = api?.aiConfigProbe;
  return {
    load: () => load.call(api),
    save: (settings, revision) => save.call(api, settings, revision),
    ...(typeof probe === "function" ? { probe: (configId: string, revision: string) => probe.call(api, configId, revision) } : {}),
  };
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

/** What a connection test sends and what it can't tell you; shown before the button. */
export const PROBE_EXPLANATION = Object.freeze([
  "Test connection sends one HTTP GET request to the address shown, only when you click it.",
  "Any program on this computer listening at that address may answer.",
  "A compatible response doesn't show which program answered or that it can be trusted, and it doesn't enable AI features.",
  "No repository data, prompts or credentials are included.",
] as const);

export const PROBE_TEXT = {
  testing: "Testing…",
  saveFirst: "Save this configuration before testing it.",
  unsaved: "Save or discard your changes to test a saved configuration.",
  busy: "Wait for the current operation to finish.",
  conflictReload: "Reload the saved settings before testing.",
  invalidSaved: "This saved configuration can't be tested.",
} as const;

/** One fixed message per result. Never server text. */
export const PROBE_MESSAGES: Readonly<Record<"compatible" | "http-error" | AiConfigProbeOutcome | AiConfigProbeError, string>> = Object.freeze({
  compatible: "A compatible-looking response was received from the local endpoint. This does not verify which program answered, and AI features remain unavailable.",
  "http-error": "The local endpoint answered with an HTTP error.",
  "incompatible-response": "Something answered at this address, but not in the format expected for this API style.",
  "redirect-refused": "The local endpoint answered with a redirect. RepoRunner doesn't follow redirects, so nothing else was contacted.",
  "auth-required": "The local endpoint asked for authentication. RepoRunner doesn't send credentials to local endpoints.",
  "not-found-at-path": "Nothing was found at this path. Check the address and API style; RepoRunner doesn't try other paths.",
  "connection-refused": "Nothing is accepting connections at this address.",
  timeout: "The local endpoint didn't answer in time.",
  "response-too-large": "The answer was larger than a test accepts, so it was discarded.",
  "address-mismatch": "The connection didn't reach the expected local address, so nothing was sent.",
  "not-available": "Connection tests aren't available in this launch.",
  "invalid-request": "The test request wasn't accepted. Nothing was sent.",
  missing: "There are no saved settings to test. Nothing was sent.",
  damaged: "The AI settings file is damaged, so nothing was sent.",
  "unsupported-version": "The AI settings file comes from a newer version of RepoRunner, so nothing was sent.",
  unreadable: "RepoRunner couldn't read the AI settings, so nothing was sent.",
  conflict: "The saved settings changed since they were loaded, so nothing was sent. Reload to see the saved version.",
  "not-found": "This configuration isn't in the saved settings, so nothing was sent.",
  "invalid-configuration": "This saved configuration can't be tested. Nothing was sent.",
  "port-in-use-by-project": "This port belongs to a project RepoRunner is running or recently ran, so it wasn't tested.",
  busy: "Another connection test is already running. Try again when it finishes.",
  "rate-limited": "Connection tests are limited to one every few seconds. Try again shortly.",
  cancelled: "The test was cancelled.",
  failed: "The test couldn't be completed.",
});

const PROBE_OUTCOMES: readonly AiConfigProbeOutcome[] = [
  "incompatible-response",
  "redirect-refused",
  "auth-required",
  "not-found-at-path",
  "connection-refused",
  "timeout",
  "response-too-large",
  "address-mismatch",
];
const PROBE_ERRORS: readonly AiConfigProbeError[] = [
  "not-available",
  "invalid-request",
  "missing",
  "damaged",
  "unsupported-version",
  "unreadable",
  "conflict",
  "not-found",
  "invalid-configuration",
  "port-in-use-by-project",
  "busy",
  "rate-limited",
  "cancelled",
  "failed",
];
const STATUS_CLASSES: readonly AiConfigProbeStatusClass[] = ["1xx", "2xx", "4xx", "5xx", "other"];

/** Probe answers, re-checked field by field: anything else is "failed". */
export function readProbeResult(value: unknown): AiConfigProbeIpcResult {
  if (typeof value !== "object" || value === null) return { ok: false, error: "failed" };
  const r = value as Record<string, unknown>;
  if (r.ok === true) {
    if (r.outcome === "compatible") {
      const count = r.modelCount;
      if (count === null || (typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= PROBE_MAX_MODELS)) return { ok: true, outcome: "compatible", modelCount: count };
      return { ok: false, error: "failed" };
    }
    if (r.outcome === "http-error") {
      return (STATUS_CLASSES as readonly unknown[]).includes(r.statusClass) ? { ok: true, outcome: "http-error", statusClass: r.statusClass as AiConfigProbeStatusClass } : { ok: false, error: "failed" };
    }
    if ((PROBE_OUTCOMES as readonly unknown[]).includes(r.outcome)) return { ok: true, outcome: r.outcome as AiConfigProbeOutcome };
    return { ok: false, error: "failed" };
  }
  if (r.ok === false && (PROBE_ERRORS as readonly unknown[]).includes(r.error)) return { ok: false, error: r.error as AiConfigProbeError };
  return { ok: false, error: "failed" };
}

/** The fixed message for a result, plus the bounded detail the contract allows. */
export function probeMessage(result: AiConfigProbeIpcResult): { text: string; detail: string | null; tone: "status" | "alert" } {
  if (!result.ok) return { text: PROBE_MESSAGES[result.error], detail: null, tone: "alert" };
  if (result.outcome === "compatible") {
    const n = result.modelCount;
    return { text: PROBE_MESSAGES.compatible, detail: n === null ? null : `The response listed ${n} ${n === 1 ? "model" : "models"}.`, tone: "status" };
  }
  if (result.outcome === "http-error") return { text: PROBE_MESSAGES["http-error"], detail: `HTTP status class: ${result.statusClass}.`, tone: "status" };
  return { text: PROBE_MESSAGES[result.outcome], detail: null, tone: "status" };
}

/** The exact request a test would send, for display. */
export interface ProbePreview {
  url: string;
  method: "GET";
  path: string;
  apiStyle: string;
  headers: ReadonlyArray<readonly [string, string]>;
}

/** What the view shows for one configuration's connection test. */
export interface ProbeView {
  /** Only for a saved, unchanged, valid configuration. */
  preview: ProbePreview | null;
  canTest: boolean;
  /** Why testing isn't possible right now (fixed text), or null. */
  reason: string | null;
  testing: boolean;
  result: { text: string; detail: string | null; tone: "status" | "alert" } | null;
}

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
  /** The values the form opened with, to tell whether anything was typed. */
  initial: { endpoint: string; apiStyle: AiConfigEditEntry["apiStyle"]; model: string };
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
  /** Stage 4P: the connection test in progress or last finished (memory only), for one configuration. */
  probe: { configId: string; testing: boolean; result: ProbeView["result"] } | null;
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
  probe: null,
});

const same = (a: AiConfigEditDocument | null, b: AiConfigEditDocument | null) => JSON.stringify(a) === JSON.stringify(b);
const copy = (d: AiConfigEditDocument): AiConfigEditDocument => ({ ...d, configs: d.configs.map((c) => ({ ...c })) });

export class AiConfigEditorController {
  private state: AiEditorState = AI_EDITOR_INITIAL;
  /** The last persisted document and its revision. Kept here only. */
  private saved: AiConfigEditDocument | null = null;
  private revision: string | null = null;
  private request = 0;
  /** Stage 4P: bumped by every test, draft change, reload and save, so older answers are ignored. */
  private probeRequest = 0;
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

  /**
   * Unsaved changes exist (the dialog asks before closing): a draft that
   * differs from what was saved, or an open form whose fields were changed
   * but not yet applied to the draft.
   */
  get hasUnsavedChanges(): boolean {
    const form = this.state.form;
    const formChanged = form !== null && (form.endpoint !== form.initial.endpoint || form.apiStyle !== form.initial.apiStyle || form.model !== form.initial.model);
    return this.state.dirty || formChanged;
  }

  private set(patch: Partial<AiEditorState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private setDraft(draft: AiConfigEditDocument, extra: Partial<AiEditorState> = {}) {
    // Any change to the draft ends what a test result described.
    this.probeRequest++;
    this.set({ draft, dirty: !same(draft, this.saved), notice: null, error: null, probe: null, ...extra });
  }

  private editable(): AiConfigEditDocument | null {
    const s = this.state;
    return !this.closed && s.phase === "ready" && !s.saving && !s.conflict && s.draft ? s.draft : null;
  }

  /** Loads the saved settings (once per opening, and on Reload). */
  async load(): Promise<void> {
    if (this.closed || this.state.saving) return;
    const id = ++this.request;
    this.probeRequest++;
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
    this.set({
      form: { editingId: null, endpoint: "", apiStyle: "openai-compatible", model: "", error: null, canonical: null, initial: { endpoint: "", apiStyle: "openai-compatible", model: "" } },
      confirmingRemove: null,
      notice: null,
      error: null,
    });
  }

  startEdit(id: string): void {
    const draft = this.editable();
    const entry = draft?.configs.find((c) => c.id === id);
    if (!entry) return;
    const initial = { endpoint: entry.endpoint, apiStyle: entry.apiStyle, model: entry.model ?? "" };
    this.set({ form: { editingId: id, ...initial, error: null, canonical: null, initial }, confirmingRemove: null, notice: null, error: null });
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
      this.probeRequest++;
      this.set({ saving: false, draft: copy(result.settings), dirty: false, notice: AI_EDITOR_TEXT.saved, probe: null });
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

  /** Stage 4P: the saved configuration a test would use, when one can be tested at all. */
  private savedEntry(id: string): AiConfigEditEntry | null {
    return this.saved?.configs.find((c) => c.id === id) ?? null;
  }

  /** What the view shows for one configuration's connection test, or null when tests aren't available here. */
  probeView(id: string): ProbeView | null {
    if (!this.api.probe) return null;
    const s = this.state;
    const testing = s.probe?.testing === true && s.probe.configId === id;
    const result = s.probe && s.probe.configId === id && !s.probe.testing ? s.probe.result : null;
    const base = { testing, result };
    if (s.phase !== "ready" || this.closed) return { preview: null, canTest: false, reason: null, ...base };
    const entry = this.savedEntry(id);
    if (!entry) return { preview: null, canTest: false, reason: PROBE_TEXT.saveFirst, ...base };
    if (s.dirty || s.form !== null) return { preview: null, canTest: false, reason: PROBE_TEXT.unsaved, ...base };
    const built = buildProbeRequest(entry);
    if (!built.ok || this.revision === null) return { preview: null, canTest: false, reason: PROBE_TEXT.invalidSaved, ...base };
    const r = built.request;
    const preview: ProbePreview = { url: r.url, method: r.method, path: r.path, apiStyle: API_STYLE_LABELS[entry.apiStyle], headers: r.headers };
    if (s.conflict || s.confirmingReload) return { preview, canTest: false, reason: PROBE_TEXT.conflictReload, ...base };
    if (s.saving || s.probe?.testing) return { preview, canTest: false, reason: s.probe?.testing ? null : PROBE_TEXT.busy, ...base };
    return { preview, canTest: true, reason: null, ...base };
  }

  /**
   * Sends one test of a saved configuration: its id and the loaded revision,
   * nothing else. One at a time; never retried; ignored if anything moved on
   * before the answer arrived.
   */
  async testConnection(id: string): Promise<void> {
    const view = this.probeView(id);
    const probe = this.api.probe;
    const revision = this.revision;
    if (!view?.canTest || !probe || revision === null) return;
    const token = ++this.probeRequest;
    this.set({ probe: { configId: id, testing: true, result: null }, notice: null });
    let result: AiConfigProbeIpcResult;
    try {
      result = readProbeResult(await probe(id, revision));
    } catch {
      result = { ok: false, error: "failed" };
    }
    if (this.closed || token !== this.probeRequest || this.revision !== revision) return;
    const message = probeMessage(result);
    if (!result.ok && result.error === "conflict") {
      this.set({ probe: { configId: id, testing: false, result: message }, conflict: true, error: AI_EDITOR_TEXT.conflict });
      return;
    }
    this.set({ probe: { configId: id, testing: false, result: message } });
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
