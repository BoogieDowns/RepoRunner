// Stage 4C: the internal credential Settings behavior (controller) and the
// dialog's markup. Synthetic keys only; assertions compare booleans or fixed
// strings and never print a key.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialSettingsController,
  INITIAL_STATE,
  LOCAL_KEY_MESSAGES,
  STATUS_TEXT,
  errorMessage,
  getCredentialApi,
  localKeyProblem,
  readResult,
  statusText,
  type CredentialApi,
  type CredentialSettingsState,
} from "../../src/lib/credentialSettings";
import { CREDENTIAL_DIALOG_TITLE_ID, CredentialSettingsView } from "../../src/components/CredentialSettingsDialog";
import { CREDENTIAL_ERROR_MESSAGES, CREDENTIAL_MAX_KEY_BYTES, type CredentialIpcResult, type CredentialMetadata } from "../../src/types";
import { MAX_SECRET_BYTES } from "../../electron/credentialStore";

const KEY = "rr-synthetic-renderer-key-4c9f";
const NONE: CredentialMetadata = { configured: false, mode: null, persistence: "available" };
const SESSION: CredentialMetadata = { configured: true, mode: "session", persistence: "available" };
const REMEMBERED: CredentialMetadata = { configured: true, mode: "remembered", persistence: "available" };
const ok = (status: CredentialMetadata): CredentialIpcResult => ({ ok: true, status });

/** A controllable stand-in for the three preload methods; each call resolves when told to. */
function fakeApi() {
  const pending: Array<{ name: string; args: unknown[]; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const make = (name: string) => vi.fn((...args: unknown[]) => new Promise((resolve, reject) => pending.push({ name, args, resolve, reject })));
  const api = { credentialStatus: make("status"), setCredential: make("set"), removeCredential: make("remove") };
  return { api: api as unknown as CredentialApi & typeof api, pending };
}
function controllerWith() {
  const { api, pending } = fakeApi();
  const states: CredentialSettingsState[] = [];
  const c = new CredentialSettingsController(api, (s) => states.push(s));
  return { c, api, pending, states, last: () => c.current };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const leaks = (value: unknown) => JSON.stringify(value).includes(KEY);

describe("availability", () => {
  it("is offered only when all three preload methods exist (never in the browser mock or an ordinary preload)", async () => {
    const f = () => Promise.resolve();
    expect(getCredentialApi(undefined)).toBeNull();
    expect(getCredentialApi({ getStatuses: f } as never)).toBeNull();
    expect(getCredentialApi({ credentialStatus: f, setCredential: f } as never)).toBeNull();
    expect(getCredentialApi({ credentialStatus: f, setCredential: f, removeCredential: "x" } as never)).toBeNull();
    const { mockRepoRunnerAPI } = await import("../../src/mock/repoRunnerMock");
    expect(getCredentialApi(mockRepoRunnerAPI)).toBeNull();
    const api = getCredentialApi({ credentialStatus: f, setCredential: f, removeCredential: f, getStatuses: f } as never)!;
    expect(Object.keys(api).sort()).toEqual(["credentialStatus", "removeCredential", "setCredential"]);
  });

  it("the renderer limit matches the store's", () => {
    expect(CREDENTIAL_MAX_KEY_BYTES).toBe(MAX_SECRET_BYTES);
  });
});

describe("local checks before anything is sent", () => {
  it.each([
    ["empty", "", "empty"],
    ["line feed", "a\nb", "line-break"],
    ["carriage return", "a\rb", "line-break"],
    ["NUL", "a\u0000b", "line-break"],
    ["too many characters", "k".repeat(CREDENTIAL_MAX_KEY_BYTES + 1), "too-long"],
    ["few characters, too many UTF-8 bytes", "€".repeat(3000), "too-long"],
    ["exactly the byte limit", "€".repeat(2730) + "kk", null],
    ["ordinary key", KEY, null],
  ])("%s", (_n, key, problem) => {
    expect(localKeyProblem(key)).toBe(problem);
  });
});

describe("results are re-checked and copied field by field", () => {
  it("only known metadata survives, even if the main process sent more", () => {
    const r = readResult({ ok: true, status: { ...REMEMBERED, value: KEY, suffix: KEY.slice(-4) }, extra: KEY });
    expect(r).toEqual({ ok: true, status: REMEMBERED });
    expect(leaks(r)).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", KEY],
    ["no ok", { status: NONE }],
    ["bad mode", { ok: true, status: { configured: true, mode: "plain", persistence: "available" } }],
    ["bad persistence", { ok: true, status: { configured: false, mode: null, persistence: "maybe" } }],
    ["configured without a mode", { ok: true, status: { configured: true, mode: null, persistence: "available" } }],
    ["a mode while not configured", { ok: true, status: { configured: false, mode: "session", persistence: "available" } }],
    ["unknown error code", { ok: false, error: `boom ${KEY}` }],
  ])("%s becomes a generic failure", (_n, value) => {
    expect(readResult(value)).toEqual({ ok: false, error: "failed" });
  });

  it("every error code has a fixed message without paths or system detail; unknown codes get the generic one", () => {
    for (const [code, message] of Object.entries(CREDENTIAL_ERROR_MESSAGES)) {
      expect(errorMessage(code)).toBe(message);
      expect(message).not.toMatch(/[\\/]|[A-Z]:|EACCES|ENOENT|Error:|stack|undefined/);
    }
    expect(errorMessage("EACCES: C:\\Users\\x\\reporunner-credentials.json")).toBe(CREDENTIAL_ERROR_MESSAGES.failed);
  });

  it("status labels", () => {
    expect([statusText(NONE), statusText(SESSION), statusText(REMEMBERED)]).toEqual([STATUS_TEXT.none, STATUS_TEXT.session, STATUS_TEXT.remembered]);
    expect(STATUS_TEXT).toEqual({ none: "No key configured", session: "Key saved for this session", remembered: "Key remembered on this computer" });
  });
});

describe("controller", () => {
  it("loads the status", async () => {
    const { c, pending, last } = controllerWith();
    const done = c.load();
    expect(last().activity).toBe("loading");
    pending[0].resolve(ok(NONE));
    await done;
    expect(last()).toMatchObject({ activity: "idle", status: NONE, error: null });
  });

  it("forwards a key once with the chosen mode, and never keeps it in state", async () => {
    const { c, api, pending, states } = controllerWith();
    const done = c.save(KEY, false);
    expect(api.setCredential).toHaveBeenCalledTimes(1);
    expect(api.setCredential.mock.calls[0]).toEqual(["byok-slot-1", KEY, { remember: false }]);
    pending[0].resolve(ok(SESSION));
    await done;
    expect(c.current).toMatchObject({ status: SESSION, notice: "Key saved for this session." });
    expect(states.some(leaks)).toBe(false);
  });

  it("remembering needs an explicit true", async () => {
    const { c, api, pending } = controllerWith();
    for (const value of ["true", 1, undefined, null] as unknown[]) {
      const p = c.save(KEY, value as boolean);
      pending.at(-1)!.resolve(ok(SESSION));
      await p;
    }
    expect(api.setCredential.mock.calls.map((call) => (call[2] as { remember: boolean }).remember)).toEqual([false, false, false, false]);
    const p = c.save(KEY, true);
    pending.at(-1)!.resolve(ok(REMEMBERED));
    await p;
    expect(api.setCredential.mock.calls.at(-1)![2]).toEqual({ remember: true });
  });

  it("local problems are reported without sending anything", async () => {
    const { c, api } = controllerWith();
    await c.save("", false);
    expect(c.current.error).toBe(LOCAL_KEY_MESSAGES.empty);
    await c.save("€".repeat(3000), true);
    expect(c.current.error).toBe(LOCAL_KEY_MESSAGES["too-long"]);
    await c.save(`${KEY}\n`, false);
    expect(c.current.error).toBe(LOCAL_KEY_MESSAGES["line-break"]);
    expect(api.setCredential).not.toHaveBeenCalled();
  });

  it("refuses a second submission, and a removal, while a save is in flight", async () => {
    const { c, api, pending } = controllerWith();
    const first = c.save(KEY, false);
    await c.save(KEY, true);
    c.requestRemove();
    await c.confirmRemove();
    expect(api.setCredential).toHaveBeenCalledTimes(1);
    expect(api.removeCredential).not.toHaveBeenCalled();
    expect(c.canClose()).toBe(false);
    pending[0].resolve(ok(SESSION));
    await first;
    expect(c.canClose()).toBe(true);
  });

  it("an older answer arriving last doesn't overwrite a newer one", async () => {
    const { c, pending } = controllerWith();
    const load = c.load();
    const save = c.save(KEY, true);
    pending[1].resolve(ok(REMEMBERED)); // the save answers first
    await save;
    pending[0].resolve(ok(NONE)); // the stale status answers last
    await load;
    expect(c.current.status).toEqual(REMEMBERED);
  });

  it("answers after close change nothing", async () => {
    const { c, pending, states } = controllerWith();
    const save = c.save(KEY, false);
    const count = states.length;
    c.close();
    pending[0].resolve(ok(SESSION));
    await save;
    expect(states.length).toBe(count);
    await c.save(KEY, false);
    expect(pending).toHaveLength(1);
  });

  it("a main-process error shows its fixed message; an IPC rejection or malformed answer shows the generic one; nothing raw", async () => {
    const { c, pending } = controllerWith();
    let p = c.save(KEY, true);
    pending[0].resolve({ ok: false, error: "encryption-unavailable" });
    await p;
    expect(c.current.error).toBe(CREDENTIAL_ERROR_MESSAGES["encryption-unavailable"]);
    p = c.save(KEY, true);
    pending[1].reject(new Error(`Error invoking remote method 'credential-set': C:\\Users\\x ${KEY}`));
    await p;
    expect(c.current.error).toBe(CREDENTIAL_ERROR_MESSAGES.failed);
    p = c.load();
    pending[2].resolve({ ok: true, status: "remembered" });
    await p;
    expect(c.current.error).toBe(CREDENTIAL_ERROR_MESSAGES.failed);
    expect(leaks(c.current)).toBe(false);
  });

  it.each([
    ["invalid-secret"], ["busy"], ["encryption-insecure"], ["store-corrupt"], ["unsupported-version"], ["read-failed"], ["write-failed"], ["invalid-request"],
  ])("maps %s to its fixed message", async (code) => {
    const { c, pending } = controllerWith();
    const p = c.save(KEY, false);
    pending[0].resolve({ ok: false, error: code });
    await p;
    expect(c.current.error).toBe(CREDENTIAL_ERROR_MESSAGES[code as keyof typeof CREDENTIAL_ERROR_MESSAGES]);
  });

  it("removal needs a configured key and an explicit confirmation", async () => {
    const { c, api, pending } = controllerWith();
    c.requestRemove();
    expect(c.current.confirmingRemove).toBe(false); // nothing configured yet
    let p = c.load();
    pending[0].resolve(ok(REMEMBERED));
    await p;
    await c.confirmRemove(); // not requested
    expect(api.removeCredential).not.toHaveBeenCalled();
    c.requestRemove();
    expect(c.current.confirmingRemove).toBe(true);
    c.cancelRemove();
    expect(c.current.confirmingRemove).toBe(false);
    c.requestRemove();
    p = c.confirmRemove();
    expect(api.removeCredential).toHaveBeenCalledTimes(1);
    pending[1].resolve(ok(NONE));
    await p;
    expect(c.current).toMatchObject({ status: NONE, confirmingRemove: false, notice: "Key removed." });
  });
});

describe("dialog markup", () => {
  const render = (state: Partial<CredentialSettingsState> = {}, remember = false) =>
    renderToStaticMarkup(
      createElement(CredentialSettingsView, {
        state: { ...INITIAL_STATE, activity: "idle", status: NONE, ...state },
        remember,
        onRememberChange: () => {},
        onSubmit: () => {},
        onRequestRemove: () => {},
        onConfirmRemove: () => {},
        onCancelRemove: () => {},
        onClose: () => {},
      }),
    );

  it("is a labelled modal dialog marked as internal, and says no provider is connected", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain(`aria-labelledby="${CREDENTIAL_DIALOG_TITLE_ID}"`);
    expect(html).toMatch(new RegExp(`id="${CREDENTIAL_DIALOG_TITLE_ID}"[^>]*>AI provider key<`));
    expect(html).toContain("internal test feature");
    expect(html).toContain("doesn&#x27;t connect to any AI provider yet");
    expect(html).toContain('aria-label="Close settings"');
    expect(html).not.toMatch(/fully secure|completely secure|protected from/i);
  });

  it("the key field is a password field with no value, no autofill and no reveal control", () => {
    const html = render({ status: REMEMBERED });
    const input = html.match(/<input id="credential-key-input"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('type="password"');
    expect(input).toContain('autoComplete="off"');
    expect(input).toContain('spellCheck="false"');
    expect(input).not.toMatch(/value=/);
    expect(html).toMatch(/<label for="credential-key-input"/);
    expect(html).not.toMatch(/show key|reveal|type="text"/i);
  });

  it("'Remember on this computer' is unchecked by default and disabled when encryption isn't available", () => {
    const checkbox = (html: string) => html.match(/<input id="credential-remember"[^>]*>/)?.[0] ?? "";
    expect(checkbox(render())).not.toContain("checked");
    expect(checkbox(render({}, true))).toContain("checked");
    const unavailable = render({ status: { ...NONE, persistence: "unavailable" } }, true);
    expect(checkbox(unavailable)).toContain("disabled");
    expect(checkbox(unavailable)).not.toContain("checked");
    expect(unavailable).toContain("can&#x27;t encrypt keys right now");
    expect(render({ status: { ...NONE, persistence: "insecure" } })).toContain("no secure keyring");
  });

  it("shows metadata-only status labels and the right actions", () => {
    expect(render()).toContain("No key configured");
    expect(render()).toContain(">Save key<");
    expect(render()).not.toContain("Remove key");
    const remembered = render({ status: REMEMBERED });
    expect(remembered).toContain("Key remembered on this computer");
    expect(remembered).toContain(">Replace key<");
    expect(remembered).toContain("Remove key…");
    expect(render({ status: SESSION })).toContain("Key saved for this session");
  });

  it("removal asks for confirmation first", () => {
    const html = render({ status: REMEMBERED, confirmingRemove: true });
    expect(html).toContain('aria-label="Confirm removal"');
    expect(html).toContain("Remove the saved key?");
    expect(html).toContain(">Remove key<");
    expect(html).toContain(">Cancel<");
    expect(html).not.toContain("Remove key…");
  });

  it("errors are announced; actions are disabled while busy", () => {
    expect(render({ error: CREDENTIAL_ERROR_MESSAGES["store-corrupt"] })).toMatch(/role="alert"[^>]*>The saved keys file is damaged/);
    const saving = render({ activity: "saving", status: REMEMBERED });
    expect(saving).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Saving…</);
    expect(saving).toMatch(/aria-label="Close settings"[^>]*disabled=""|disabled=""[^>]*aria-label="Close settings"/);
  });
});

describe("source boundaries", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", p), "utf8");
  it("the Settings code keeps no copy of a key in storage, logs or the network", () => {
    for (const f of ["src/lib/credentialSettings.ts", "src/components/CredentialSettingsDialog.tsx"]) {
      expect(read(f), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|location\.|history\./);
    }
    // The key never goes into React state in the dialog.
    expect(read("src/components/CredentialSettingsDialog.tsx")).not.toMatch(/useState<string>|setKey|setSecret/);
  });

  it("the browser mock and every packaged build stay without credential methods", () => {
    expect(read("src/mock/repoRunnerMock.ts")).not.toMatch(/credential/i);
  });
});
