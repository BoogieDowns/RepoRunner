// Stage 4L: the "Local AI configurations" section of the internal Settings
// dialog. Hook-free markup for a given editor state; all behavior lives in
// src/lib/aiConfigEditor.ts. Shown only when the preload provides the editing
// methods (internal development launches). Fixed wording only; nothing here
// connects to anything. Relative imports keep it renderable in tests.
//
// Stage 4P: each saved configuration can show a "Connection test" block (only
// when the preload provides the probe): the exact request, what it does and
// doesn't prove, a Test connection button, and a fixed result. The renderer
// sends nothing over the network itself; the click asks the main process.
import * as React from "react";
import { AI_SETTINGS_MAX_CONFIGS } from "../lib/ai/settingsSchema";
import { AI_EDITOR_TEXT, API_STYLE_LABELS, PROBE_EXPLANATION, PROBE_TEXT, type AiEditorState, type EntryForm, type ProbeView } from "../lib/aiConfigEditor";

export const AI_EDITOR_TITLE_ID = "ai-config-editor-title";

const text = { color: "#b8b4af" } as const;
const subtle = { color: "#858280" } as const;
const field = { background: "#0d0d0d", border: "1px solid #242020", color: "#dedad5" } as const;
const mono = { fontFamily: "'JetBrains Mono', monospace" } as const;

export interface AiEditorHandlers {
  onAdd: () => void;
  onEdit: (id: string) => void;
  onFormChange: (patch: Partial<Pick<EntryForm, "endpoint" | "apiStyle" | "model">>) => void;
  onApplyForm: () => void;
  onAcceptCanonical: () => void;
  onCancelForm: () => void;
  onSelect: (id: string | null) => void;
  onRequestRemove: (id: string) => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
  onSave: () => void;
  onReload: () => void;
  onCancelReload: () => void;
  /** Stage 4P: one connection test of a saved configuration. */
  onTest?: (id: string) => void;
}

const btn = "btn-glass btn-glass-secondary h-8 px-3 text-[12px]";
const primary = "btn-glass btn-glass-primary h-8 px-3 text-[12px]";

function EntryFormView({ form, handlers, endpointRef, disabled }: { form: EntryForm; handlers: AiEditorHandlers; endpointRef?: React.Ref<HTMLInputElement>; disabled: boolean }) {
  return (
    <form
      className="mt-3 space-y-2 rounded-md p-3"
      style={{ border: "1px solid #242020" }}
      aria-label={form.editingId ? `Edit ${form.editingId}` : "Add local endpoint"}
      data-testid="ai-config-form"
      noValidate
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        handlers.onApplyForm();
      }}
    >
      <div>
        <label htmlFor="ai-config-endpoint" className="block text-[12px] font-medium" style={subtle}>
          Endpoint address (this computer only)
        </label>
        <input
          id="ai-config-endpoint"
          ref={endpointRef}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="http://127.0.0.1:11434"
          value={form.endpoint}
          disabled={disabled}
          aria-invalid={form.error ? true : undefined}
          aria-describedby={form.error ? "ai-config-form-error" : undefined}
          onChange={(event) => handlers.onFormChange({ endpoint: event.currentTarget.value })}
          className="mt-1 h-8 w-full rounded-md px-2 text-[13px] outline-none"
          style={{ ...field, ...mono }}
        />
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label htmlFor="ai-config-api-style" className="block text-[12px] font-medium" style={subtle}>
            API style
          </label>
          <select
            id="ai-config-api-style"
            value={form.apiStyle}
            disabled={disabled}
            onChange={(event) => handlers.onFormChange({ apiStyle: event.currentTarget.value as EntryForm["apiStyle"] })}
            className="mt-1 h-8 w-full rounded-md px-2 text-[13px]"
            style={field}
          >
            <option value="openai-compatible">{API_STYLE_LABELS["openai-compatible"]}</option>
            <option value="ollama-native">{API_STYLE_LABELS["ollama-native"]}</option>
          </select>
        </div>
        <div className="flex-1">
          <label htmlFor="ai-config-model" className="block text-[12px] font-medium" style={subtle}>
            Model label (optional)
          </label>
          <input
            id="ai-config-model"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={form.model}
            disabled={disabled}
            onChange={(event) => handlers.onFormChange({ model: event.currentTarget.value })}
            className="mt-1 h-8 w-full rounded-md px-2 text-[13px] outline-none"
            style={{ ...field, ...mono }}
          />
        </div>
      </div>
      {form.error && (
        <p id="ai-config-form-error" className="text-[12px]" role="alert" style={{ color: "#ffb06a" }} data-testid="ai-config-form-error">
          {form.error}
        </p>
      )}
      {form.canonical && (
        <div className="text-[12px]" role="group" aria-label="Address will be saved differently" data-testid="ai-config-canonical" style={text}>
          <p>
            This address will be saved as <code style={mono}>{form.canonical}</code>.
          </p>
          <button type="button" className={`${btn} mt-1`} disabled={disabled} onClick={handlers.onAcceptCanonical}>
            Use this address
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={disabled}>
          {form.editingId ? "Update" : "Add to list"}
        </button>
        <button type="button" className={btn} disabled={disabled} onClick={handlers.onCancelForm}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Stage 4P: the exact request, the explanation, the button and the result for one configuration. */
function ProbeSection({ id, view, onTest }: { id: string; view: ProbeView; onTest?: (id: string) => void }) {
  const base = `ai-probe-${id}`;
  return (
    <div className="ml-6 mt-2 rounded-md p-2" style={{ border: "1px dashed #242020" }} role="group" aria-labelledby={`${base}-title`} data-testid="ai-probe">
      <p id={`${base}-title`} className="text-[12px] font-medium" style={subtle}>
        Connection test
      </p>
      {view.preview && (
        <>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[12px]" style={subtle} data-testid="ai-probe-preview">
            <dt>Request</dt>
            <dd style={mono}>
              {view.preview.method} {view.preview.path}
            </dd>
            <dt>Destination</dt>
            <dd style={mono}>{view.preview.url}</dd>
            <dt>API style</dt>
            <dd>{view.preview.apiStyle}</dd>
            <dt>Headers</dt>
            <dd>
              <ul data-testid="ai-probe-headers">
                {view.preview.headers.map(([name, value]) => (
                  <li key={name} style={mono}>
                    {name}: {value}
                  </li>
                ))}
              </ul>
            </dd>
            <dt>Body</dt>
            <dd>None. No Authorization header, cookies or credentials.</dd>
          </dl>
          <ul id={`${base}-explain`} className="mt-1 list-disc pl-4 text-[12px]" style={text} data-testid="ai-probe-explanation">
            {PROBE_EXPLANATION.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {view.reason && (
        <p className="mt-1 text-[12px]" style={subtle} data-testid="ai-probe-reason">
          {view.reason}
        </p>
      )}
      {view.preview && (
        <button
          type="button"
          className={`${btn} mt-2`}
          disabled={!view.canTest}
          aria-busy={view.testing}
          aria-describedby={`${base}-explain`}
          onClick={() => onTest?.(id)}
          data-testid="ai-probe-test"
        >
          {view.testing ? PROBE_TEXT.testing : "Test connection"}
        </button>
      )}
      <div aria-live="polite">
        {view.testing && (
          <p className="mt-1 text-[12px]" role="status" style={subtle}>
            {PROBE_TEXT.testing}
          </p>
        )}
        {view.result && (
          <p className="mt-1 text-[12px]" role={view.result.tone} style={{ color: view.result.tone === "alert" ? "#ffb06a" : "#dedad5" }} data-testid="ai-probe-result">
            {view.result.text}
            {view.result.detail ? ` ${view.result.detail}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}

/** The editor section for a given state. `probeFor` (Stage 4P) gives each configuration's connection-test view, when tests are available. */
export function AiConfigEditorSection({
  state,
  handlers,
  endpointRef,
  probeFor,
}: {
  state: AiEditorState;
  handlers: AiEditorHandlers;
  endpointRef?: React.Ref<HTMLInputElement>;
  probeFor?: (id: string) => ProbeView | null;
}) {
  const draft = state.draft;
  const busy = state.saving;
  const locked = busy || state.conflict;
  return (
    <section className="mt-5 pt-4" style={{ borderTop: "1px solid #242020" }} aria-labelledby={AI_EDITOR_TITLE_ID} data-testid="ai-config-editor">
      <h3 id={AI_EDITOR_TITLE_ID} className="text-[13px] font-semibold" style={{ color: "#dedad5" }}>
        Local AI configurations
      </h3>

      {state.phase === "loading" && (
        <p className="mt-1 text-sm" style={text} aria-live="polite">
          {AI_EDITOR_TEXT.loading}
        </p>
      )}

      {state.phase === "blocked" && state.blocked && (
        <p className="mt-1 text-sm" role="alert" style={{ color: "#ffb06a" }} data-testid="ai-config-blocked">
          {AI_EDITOR_TEXT[state.blocked]}
        </p>
      )}

      {state.phase === "failed" && (
        <div className="mt-1">
          <p className="text-sm" role="alert" style={{ color: "#ffb06a" }}>
            {state.error}
          </p>
          <button type="button" className={`${btn} mt-2`} onClick={handlers.onReload}>
            Reload
          </button>
        </div>
      )}

      {state.phase === "ready" && draft && (
        <div className="mt-2 space-y-2">
          <fieldset disabled={locked}>
            <legend className="text-[12px] font-medium" style={subtle}>
              Selected configuration
            </legend>
            <ul className="mt-1 space-y-1" data-testid="ai-config-list">
              <li className="flex items-center gap-2 text-[13px]" style={text}>
                <input type="radio" id="ai-config-active-none" name="ai-config-active" checked={draft.active === null} onChange={() => handlers.onSelect(null)} />
                <label htmlFor="ai-config-active-none">None</label>
              </li>
              {draft.configs.map((c) => (
                <li key={c.id} className="rounded-md p-2 text-[13px]" style={{ ...text, border: "1px solid #1c1a1a" }} data-testid="ai-config-entry">
                  <div className="flex items-center gap-2">
                    <input type="radio" id={`ai-config-active-${c.id}`} name="ai-config-active" checked={draft.active === c.id} onChange={() => handlers.onSelect(c.id)} />
                    <label htmlFor={`ai-config-active-${c.id}`} style={mono}>
                      {c.id}
                    </label>
                  </div>
                  <dl className="ml-6 mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[12px]" style={subtle}>
                    <dt>Endpoint</dt>
                    <dd style={mono} data-testid="ai-config-endpoint-value">
                      {c.endpoint}
                    </dd>
                    <dt>API style</dt>
                    <dd>{API_STYLE_LABELS[c.apiStyle]}</dd>
                    <dt>Model</dt>
                    <dd style={c.model ? mono : undefined}>{c.model ?? "No model label"}</dd>
                  </dl>
                  {state.confirmingRemove === c.id ? (
                    <div className="ml-6 mt-2" role="group" aria-label={`Confirm removing ${c.id}`}>
                      <p className="text-[12px]" style={text}>
                        Remove {c.id}? It is removed when you save. No key is deleted.
                      </p>
                      <div className="mt-1 flex gap-2">
                        <button type="button" className="btn-glass btn-glass-danger h-8 px-3 text-[12px]" onClick={handlers.onConfirmRemove}>
                          Remove
                        </button>
                        <button type="button" className={btn} onClick={handlers.onCancelRemove}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="ml-6 mt-2 flex gap-2">
                      <button type="button" className={btn} onClick={() => handlers.onEdit(c.id)} aria-label={`Edit ${c.id}`}>
                        Edit
                      </button>
                      <button type="button" className={btn} onClick={() => handlers.onRequestRemove(c.id)} aria-label={`Remove ${c.id}`}>
                        Remove…
                      </button>
                    </div>
                  )}
                  {(() => {
                    const view = probeFor?.(c.id);
                    return view ? <ProbeSection id={c.id} view={view} onTest={handlers.onTest} /> : null;
                  })()}
                </li>
              ))}
            </ul>
          </fieldset>

          {draft.configs.length === 0 && (
            <p className="text-[12px]" style={subtle}>
              No local AI configurations yet.
            </p>
          )}

          {state.form ? (
            <EntryFormView form={state.form} handlers={handlers} endpointRef={endpointRef} disabled={locked} />
          ) : (
            <button type="button" className={btn} disabled={locked || draft.configs.length >= AI_SETTINGS_MAX_CONFIGS} onClick={handlers.onAdd}>
              Add local endpoint
            </button>
          )}
          {draft.configs.length >= AI_SETTINGS_MAX_CONFIGS && !state.form && (
            <p className="text-[12px]" style={subtle}>
              {AI_EDITOR_TEXT.limit}
            </p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button type="button" className={primary} disabled={locked || !state.dirty || state.form !== null} aria-busy={busy} onClick={handlers.onSave}>
              {busy ? "Saving…" : "Save changes"}
            </button>
            {state.dirty && !busy && (
              <span className="text-[12px]" style={subtle} data-testid="ai-config-unsaved">
                Unsaved changes
              </span>
            )}
          </div>
        </div>
      )}

      {state.conflict && (
        <div className="mt-2" role="group" aria-label="Settings changed elsewhere">
          {state.confirmingReload ? (
            <>
              <p className="text-[12px]" style={text}>
                {AI_EDITOR_TEXT.reloadDiscards}
              </p>
              <div className="mt-1 flex gap-2">
                <button type="button" className="btn-glass btn-glass-danger h-8 px-3 text-[12px]" onClick={handlers.onReload}>
                  Discard and reload
                </button>
                <button type="button" className={btn} onClick={handlers.onCancelReload}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button type="button" className={btn} onClick={handlers.onReload}>
              Reload
            </button>
          )}
        </div>
      )}

      {state.error && state.phase !== "failed" && (
        <p className="mt-2 text-sm" role="alert" style={{ color: "#ffb06a" }} data-testid="ai-config-error">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p className="mt-2 text-sm" role="status" style={{ color: "#7cff6b" }} data-testid="ai-config-notice">
          {state.notice}
        </p>
      )}
    </section>
  );
}
