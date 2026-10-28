// Stage 4C: internal-only credential Settings. Shown only when the preload
// provides the credential methods (internal development launches); never in
// packaged builds. All behavior lives in src/lib/credentialSettings.ts.
//
// The key exists only in the password field until Save, which reads it,
// clears the field and passes it on once. It is never put in React state,
// never shown again, and the field is also cleared on close and unmount.
// While it is typed it is in this page's memory like any text input;
// clearing the field can't guarantee the browser has erased every copy.
//
// Stage 4I: when the preload provides aiConfigStatus (the same internal
// launches), a read-only "Local AI configuration" section shows the AI
// settings' state, loaded once per opening (src/lib/aiConfigStatus.ts). It
// edits nothing and connects to nothing.
//
// Stage 4L: when the preload also provides the editing methods, a "Local AI
// configurations" section (AiConfigEditor.tsx, src/lib/aiConfigEditor.ts)
// lets internal users add, edit, select and remove local endpoints and save
// the whole document. Closing with unsaved changes asks first. Saving
// connects to nothing.
// Relative imports keep it renderable in tests.
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  CredentialSettingsController,
  INITIAL_STATE,
  statusText,
  type CredentialApi,
  type CredentialSettingsState,
} from "../lib/credentialSettings";
import {
  AI_STATUS_INITIAL,
  AI_UNAVAILABLE_TEXT,
  AiConfigStatusLoader,
  describeAiStatus,
  type AiConfigStatusApi,
  type AiStatusState,
} from "../lib/aiConfigStatus";
import { AI_EDITOR_INITIAL, AiConfigEditorController, type AiConfigEditApi, type AiEditorState } from "../lib/aiConfigEditor";
import { AiConfigEditorSection, type AiEditorHandlers } from "./AiConfigEditor";

export const CREDENTIAL_DIALOG_TITLE_ID = "credential-settings-title";
export const AI_STATUS_TITLE_ID = "ai-config-status-title";

// Radio buttons are inputs; the editor adds a select.
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])";
const text = { color: "#b8b4af" } as const;
const subtle = { color: "#858280" } as const;

export interface CredentialSettingsDialogProps {
  api: CredentialApi;
  /** Present only when the preload provides it; otherwise the AI section isn't shown. */
  aiStatusApi?: AiConfigStatusApi | null;
  /** Present only when the preload provides both editing methods; otherwise the editor isn't shown. */
  aiEditApi?: AiConfigEditApi | null;
  onClose: () => void;
}

/** The read-only AI configuration section. Fixed wording only. */
function AiStatusSection({ state }: { state: AiStatusState }) {
  const lines = describeAiStatus(state);
  return (
    <section className="mt-5 pt-4" style={{ borderTop: "1px solid #242020" }} aria-labelledby={AI_STATUS_TITLE_ID} data-testid="ai-config-status">
      <h3 id={AI_STATUS_TITLE_ID} className="text-[13px] font-semibold" style={{ color: "#dedad5" }}>
        Local AI configuration
      </h3>
      <div className="mt-1 space-y-1 text-sm" style={text} aria-live="polite">
        <p data-testid="ai-config-summary">{lines.summary}</p>
        {lines.selection && <p data-testid="ai-config-selection">{lines.selection}</p>}
      </div>
      <p className="mt-1 text-[12px]" style={subtle} data-testid="ai-config-availability">
        {AI_UNAVAILABLE_TEXT}
      </p>
    </section>
  );
}

/** The dialog's markup for a given state (hook-free, so it can be rendered in tests). */
export function CredentialSettingsView(props: {
  state: CredentialSettingsState;
  /** The AI section's state; when absent, the section isn't shown. */
  aiStatus?: AiStatusState | null;
  /** The AI editor's state and actions; when absent, the editor isn't shown. */
  aiEditor?: AiEditorState | null;
  aiEditorHandlers?: AiEditorHandlers;
  endpointRef?: React.Ref<HTMLInputElement>;
  /** Asking before closing discards unsaved AI configuration changes. */
  confirmingClose?: boolean;
  keepEditingRef?: React.Ref<HTMLButtonElement>;
  onConfirmClose?: () => void;
  onCancelClose?: () => void;
  remember: boolean;
  keyRef?: React.Ref<HTMLInputElement>;
  dialogRef?: React.Ref<HTMLDivElement>;
  onRememberChange: (value: boolean) => void;
  onSubmit: (event: React.FormEvent) => void;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
  onClose: () => void;
}) {
  const { state, remember } = props;
  const busy = state.activity !== "idle";
  // The field stays usable while the status loads, so it can take focus on open.
  const mutating = state.activity === "saving" || state.activity === "removing";
  const canRemember = state.status?.persistence === "available";
  const configured = state.status?.configured === true;
  const persistenceNote =
    state.status?.persistence === "insecure"
      ? "Remembering isn't available: this computer has no secure keyring."
      : state.status?.persistence === "unavailable"
        ? "Remembering isn't available: this computer can't encrypt keys right now."
        : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.72)" }}
      onClick={props.onClose}
      role="presentation"
    >
      <div
        ref={props.dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={CREDENTIAL_DIALOG_TITLE_ID}
        aria-describedby="credential-settings-description"
        onClick={(event) => event.stopPropagation()}
        className="w-full overflow-y-auto rounded-xl p-5 shadow-2xl"
        style={{ maxWidth: 520, maxHeight: "92vh", background: "#0a0a0a", border: "1px solid #242020", boxShadow: "0 24px 80px rgba(0,0,0,0.9), 0 0 0 1px rgba(185,14,28,0.10)" }}
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <p className="text-[0.68rem] font-medium uppercase" style={{ color: "#706d69", letterSpacing: "0.08em" }}>
              Settings · internal test feature
            </p>
            <h2 id={CREDENTIAL_DIALOG_TITLE_ID} className="mt-1 text-base font-semibold" style={{ color: "#dedad5" }}>
              AI provider key
            </h2>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            disabled={mutating}
            aria-label="Close settings"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-md"
            style={{ color: "#706d69", background: "#0d0d0d", border: "1px solid #242020" }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div id="credential-settings-description" className="space-y-2 text-sm leading-relaxed" style={text}>
          <p>
            For internal testing only. RepoRunner doesn't connect to any AI provider yet: saving a key doesn't check it, use it or turn on
            any AI feature.
          </p>
          <p style={subtle}>
            A key you save is never shown again. If you remember it, it's encrypted with your Windows account, but other programs running
            as you (including scripts from repositories you run) could still ask Windows to decrypt it. Use a key with spending limits.
          </p>
        </div>

        <p className="mt-4 text-sm" aria-live="polite" style={{ color: "#dedad5" }} data-testid="credential-status">
          {state.status ? statusText(state.status) : state.activity === "loading" ? "Checking…" : "Status unavailable"}
        </p>

        <form className="mt-4 space-y-3" onSubmit={props.onSubmit} autoComplete="off" noValidate>
          <div>
            <label htmlFor="credential-key-input" className="block text-[12px] font-medium" style={subtle}>
              {configured ? "New key (replaces the saved one)" : "Key"}
            </label>
            <input
              id="credential-key-input"
              ref={props.keyRef}
              type="password"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={mutating}
              className="mt-1 h-9 w-full rounded-md px-3 text-sm outline-none"
              style={{ background: "#0d0d0d", border: "1px solid #242020", color: "#dedad5", fontFamily: "'JetBrains Mono', monospace" }}
            />
          </div>
          <label className="flex items-center gap-2 text-[13px]" style={canRemember ? text : subtle}>
            <input
              id="credential-remember"
              type="checkbox"
              checked={remember && canRemember}
              disabled={busy || !canRemember}
              onChange={(event) => props.onRememberChange(event.currentTarget.checked)}
            />
            Remember on this computer
          </label>
          {persistenceNote && (
            <p className="text-[12px]" style={subtle}>
              {persistenceNote}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button type="submit" className="btn-glass btn-glass-primary h-9 px-4 text-[13px]" disabled={busy} aria-busy={state.activity === "saving"}>
              {state.activity === "saving" ? "Saving…" : configured ? "Replace key" : "Save key"}
            </button>
            {configured && !state.confirmingRemove && (
              <button type="button" className="btn-glass btn-glass-secondary h-9 px-4 text-[13px]" disabled={busy} onClick={props.onRequestRemove}>
                Remove key…
              </button>
            )}
          </div>
        </form>

        {state.confirmingRemove && (
          <div className="mt-3 rounded-md p-3" role="group" aria-label="Confirm removal" style={{ border: "1px solid rgba(185,14,28,0.28)" }}>
            <p className="text-sm" style={text}>
              Remove the saved key? RepoRunner will forget it on this computer.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="btn-glass btn-glass-danger h-8 px-3 text-[13px]"
                disabled={busy}
                aria-busy={state.activity === "removing"}
                onClick={props.onConfirmRemove}
              >
                {state.activity === "removing" ? "Removing…" : "Remove key"}
              </button>
              <button type="button" className="btn-glass btn-glass-secondary h-8 px-3 text-[13px]" disabled={busy} onClick={props.onCancelRemove}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {state.error && (
          <p className="mt-3 text-sm" role="alert" style={{ color: "#ffb06a" }} data-testid="credential-error">
            {state.error}
          </p>
        )}
        {state.notice && (
          <p className="mt-3 text-sm" role="status" style={{ color: "#7cff6b" }} data-testid="credential-notice">
            {state.notice}
          </p>
        )}

        {props.aiStatus && <AiStatusSection state={props.aiStatus} />}

        {props.aiEditor && props.aiEditorHandlers && <AiConfigEditorSection state={props.aiEditor} handlers={props.aiEditorHandlers} endpointRef={props.endpointRef} />}

        {props.confirmingClose && (
          <div className="mt-4 rounded-md p-3" role="group" aria-label="Unsaved changes" style={{ border: "1px solid rgba(185,14,28,0.28)" }} data-testid="ai-config-close-confirm">
            <p className="text-sm" style={text}>
              You have unsaved AI configuration changes. Close and discard them?
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn-glass btn-glass-danger h-8 px-3 text-[13px]" onClick={props.onConfirmClose}>
                Discard changes and close
              </button>
              <button type="button" ref={props.keepEditingRef} className="btn-glass btn-glass-secondary h-8 px-3 text-[13px]" onClick={props.onCancelClose}>
                Keep editing
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function CredentialSettingsDialog({ api, aiStatusApi, aiEditApi, onClose }: CredentialSettingsDialogProps) {
  const keyRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<CredentialSettingsController | null>(null);
  const [state, setState] = useState<CredentialSettingsState>(INITIAL_STATE);
  // Session-only is the default; remembering is chosen each time.
  const [remember, setRemember] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatusState | null>(aiStatusApi ? AI_STATUS_INITIAL : null);
  // Bumped after a successful AI save, so the read-only status reflects it.
  const [statusVersion, setStatusVersion] = useState(0);
  const [aiEditor, setAiEditor] = useState<AiEditorState | null>(aiEditApi ? AI_EDITOR_INITIAL : null);
  const editorRef = useRef<AiConfigEditorController | null>(null);
  const endpointRef = useRef<HTMLInputElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);

  const clearKey = useCallback(() => {
    if (keyRef.current) keyRef.current.value = "";
  }, []);

  useEffect(() => {
    // Created here (not during render) so a remount gets a fresh controller.
    const controller = new CredentialSettingsController(api, setState);
    controllerRef.current = controller;
    void controller.load();
    keyRef.current?.focus();
    return () => {
      controller.close();
      controllerRef.current = null;
      clearKey();
    };
  }, [api, clearKey]);

  // AI status: read once per opening, only when the preload provides it.
  useEffect(() => {
    if (!aiStatusApi) return;
    const loader = new AiConfigStatusLoader(aiStatusApi, setAiStatus);
    void loader.load();
    return () => loader.close();
  }, [aiStatusApi, statusVersion]);

  // AI editor: loaded once per opening, only when the preload provides it.
  useEffect(() => {
    if (!aiEditApi) return;
    const editor = new AiConfigEditorController(aiEditApi, setAiEditor, () => setStatusVersion((v) => v + 1));
    editorRef.current = editor;
    void editor.load();
    return () => {
      editor.close();
      editorRef.current = null;
    };
  }, [aiEditApi]);

  // Focus follows the editor: into the address field when the form opens.
  const formKey = aiEditor?.form ? (aiEditor.form.editingId ?? "new") : null;
  useEffect(() => {
    if (formKey !== null) endpointRef.current?.focus();
  }, [formKey]);
  useEffect(() => {
    if (confirmingClose) keepEditingRef.current?.focus();
  }, [confirmingClose]);

  const closeNow = useCallback(() => {
    clearKey();
    onClose();
  }, [clearKey, onClose]);

  const requestClose = useCallback(() => {
    const controller = controllerRef.current;
    if (controller && !controller.canClose()) return;
    const editor = editorRef.current;
    if (editor && !editor.canClose()) return;
    // Unsaved AI changes are never dropped silently.
    if (editor?.hasUnsavedChanges) {
      setConfirmingClose(true);
      return;
    }
    closeNow();
  }, [closeNow]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const controller = controllerRef.current;
    if (!controller || controller.mutating) return;
    const key = keyRef.current?.value ?? "";
    // Cleared before the request is sent, whatever its outcome.
    clearKey();
    const rememberThis = remember && state.status?.persistence === "available";
    setRemember(false);
    void controller.save(key, rememberThis);
  };

  // Escape and Tab are handled for the whole document while the dialog is open,
  // so focus can't leave it even if it lands outside (for example on a button
  // that became disabled during a save).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // While asking about unsaved changes, Escape means "keep editing".
        if (confirmingClose) setConfirmingClose(false);
        else requestClose();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const inside = dialog.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [requestClose, confirmingClose]);

  const editor = () => editorRef.current;
  const aiEditorHandlers: AiEditorHandlers = {
    onAdd: () => editor()?.startAdd(),
    onEdit: (id) => editor()?.startEdit(id),
    onFormChange: (patch) => editor()?.updateForm(patch),
    onApplyForm: () => editor()?.applyForm(),
    onAcceptCanonical: () => editor()?.acceptCanonical(),
    onCancelForm: () => editor()?.cancelForm(),
    onSelect: (id) => editor()?.select(id),
    onRequestRemove: (id) => editor()?.requestRemove(id),
    onConfirmRemove: () => editor()?.confirmRemove(),
    onCancelRemove: () => editor()?.cancelRemove(),
    onSave: () => void editor()?.save(),
    onReload: () => editor()?.requestReload(),
    onCancelReload: () => editor()?.cancelReload(),
  };

  return (
    <CredentialSettingsView
      state={state}
      aiStatus={aiStatus}
      aiEditor={aiEditor}
      aiEditorHandlers={aiEditorHandlers}
      endpointRef={endpointRef}
      confirmingClose={confirmingClose}
      keepEditingRef={keepEditingRef}
      onConfirmClose={closeNow}
      onCancelClose={() => setConfirmingClose(false)}
      remember={remember}
      keyRef={keyRef}
      dialogRef={dialogRef}
      onRememberChange={setRemember}
      onSubmit={onSubmit}
      onRequestRemove={() => controllerRef.current?.requestRemove()}
      onConfirmRemove={() => void controllerRef.current?.confirmRemove()}
      onCancelRemove={() => controllerRef.current?.cancelRemove()}
      onClose={requestClose}
    />
  );
}
