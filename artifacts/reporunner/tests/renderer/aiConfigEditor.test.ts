// Stage 4L: the internal local AI configuration editor: result checks, ids,
// the controller (drafts, revisions, conflicts, blocked files, late answers)
// and the section's markup. Synthetic, non-secret values only.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AI_EDITOR_INITIAL,
  AI_EDITOR_TEXT,
  AiConfigEditorController,
  ENDPOINT_MESSAGES,
  getAiConfigEditApi,
  newConfigId,
  readLoadResult,
  readSaveResult,
  type AiConfigEditApi,
  type AiEditorState,
} from "../../src/lib/aiConfigEditor";
import { AiConfigEditorSection, AI_EDITOR_TITLE_ID, type AiEditorHandlers } from "../../src/components/AiConfigEditor";
import type { AiConfigEditDocument, AiConfigEditEntry } from "../../src/types";

const REV1 = "1".repeat(64);
const REV2 = "2".repeat(64);
const REV3 = "3".repeat(64);
const entry = (id: string, endpoint = "http://127.0.0.1:11434", apiStyle: AiConfigEditEntry["apiStyle"] = "ollama-native", model: string | null = "llama3.1:8b"): AiConfigEditEntry => ({ id, kind: "local-endpoint", endpoint, apiStyle, model });
const doc = (configs: AiConfigEditEntry[] = [], active: string | null = null): AiConfigEditDocument => ({ format: "reporunner-ai-settings", version: 1, active, configs });
const EMPTY = doc();
/** Forbidden anywhere the editor speaks. */
const MISLEADING = /(?<!not )\b(connected|ready|validated|verified|working|online|reachable)\b/i;

/** A controllable stand-in for the two preload methods. */
function fakeApi() {
  const pending: Array<{ kind: "load" | "save"; args: unknown[]; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const load = vi.fn((...args: unknown[]) => new Promise((resolve, reject) => pending.push({ kind: "load", args, resolve, reject })));
  const save = vi.fn((...args: unknown[]) => new Promise((resolve, reject) => pending.push({ kind: "save", args, resolve, reject })));
  return { api: { load, save } as unknown as AiConfigEditApi, load, save, pending };
}
/** A controller already showing `document` at `revision`. */
async function ready(document: AiConfigEditDocument = EMPTY, revision: string | null = null) {
  const f = fakeApi();
  const states: AiEditorState[] = [];
  const onSaved = vi.fn();
  let n = 0;
  // Deterministic "random" bytes for ids in tests that don't check randomness.
  const random = (bytes: Uint8Array) => bytes.map(() => (n++ * 7) % 252);
  const c = new AiConfigEditorController(f.api, (s) => states.push(s), onSaved, random);
  const loading = c.load();
  f.pending.shift()!.resolve({ ok: true, state: revision ? "valid" : "missing", revision, settings: document });
  await loading;
  return { c, ...f, states, onSaved };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("availability", () => {
  it("needs both methods", () => {
    expect(getAiConfigEditApi(undefined)).toBeNull();
    expect(getAiConfigEditApi({ aiConfigEditLoad: async () => ({}) } as never)).toBeNull();
    expect(getAiConfigEditApi({ aiConfigEditSave: async () => ({}) } as never)).toBeNull();
    expect(getAiConfigEditApi({ aiConfigEditLoad: async () => ({}), aiConfigEditSave: async () => ({}) } as never)).not.toBeNull();
  });

  it("forwards nothing to load and exactly the document and revision to save", async () => {
    const load = vi.fn(async () => ({}));
    const save = vi.fn(async () => ({}));
    const api = getAiConfigEditApi({ aiConfigEditLoad: load, aiConfigEditSave: save } as never)!;
    await api.load();
    await api.save(EMPTY, REV1);
    expect(load.mock.calls).toEqual([[]]);
    expect(save.mock.calls).toEqual([[EMPTY, REV1]]);
  });
});

describe("ids", () => {
  it("cfg- plus 16 characters from the allowed alphabet, from the cryptographic source by default", () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const id = newConfigId(new Set());
    expect(id).toMatch(/^cfg-[a-z0-9]{16}$/);
    expect(spy).toHaveBeenCalled();
  });

  it("never repeats a taken id, and differs between calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(newConfigId(ids));
    expect(ids.size).toBe(200);
  });

  it("skips a collision instead of returning it", () => {
    // The first draw gives all "a"; every later draw all "b".
    let draws = 0;
    const random = (bytes: Uint8Array) => bytes.map(() => (draws === 0 ? 0 : 1));
    const counted = (b: Uint8Array) => {
      const out = random(b);
      draws++;
      return out;
    };
    expect(newConfigId(new Set(), counted)).toBe("cfg-aaaaaaaaaaaaaaaa");
    draws = 0;
    // "a…" is taken, so the next draw ("b…") is used instead.
    expect(newConfigId(new Set(["cfg-aaaaaaaaaaaaaaaa"]), counted)).toBe("cfg-bbbbbbbbbbbbbbbb");
  });

  it("rejection sampling: bytes 252-255 are discarded", () => {
    const id = newConfigId(new Set(), (b) => b.map((_, i) => (i % 2 === 0 ? 255 : 36)));
    expect(id).toBe("cfg-aaaaaaaaaaaaaaaa");
  });
});

describe("answers are re-checked", () => {
  it("accepts well-formed loads and saves, and copies only the schema's fields", () => {
    const loaded = readLoadResult({ ok: true, state: "valid", revision: REV1, settings: { ...doc([{ ...entry("cfg-a1"), token: "x" } as never]), extra: 1 } });
    expect(loaded).toEqual({ ok: false, error: "failed" });
    expect(readLoadResult({ ok: true, state: "valid", revision: REV1, settings: doc([entry("cfg-a1")], "cfg-a1"), extra: "SYNTHETIC" })).toEqual({ ok: true, state: "valid", revision: REV1, settings: doc([entry("cfg-a1")], "cfg-a1") });
    expect(readSaveResult({ ok: true, revision: REV2, settings: EMPTY, path: "C:\\x" })).toEqual({ ok: true, revision: REV2, settings: EMPTY });
  });

  it.each([
    ["missing with a revision", { ok: true, state: "missing", revision: REV1, settings: EMPTY }],
    ["valid without a revision", { ok: true, state: "valid", revision: null, settings: EMPTY }],
    ["an upper-case revision", { ok: true, state: "valid", revision: "A".repeat(64), settings: EMPTY }],
    ["a LAN endpoint", { ok: true, state: "valid", revision: REV1, settings: doc([entry("cfg-a1", "http://10.0.0.1:1")]) }],
    ["an unknown state", { ok: true, state: "connected", revision: null, settings: EMPTY }],
    ["not an object", "SYNTHETIC"],
  ])("load: %s is a failure", (_name, value) => {
    expect(readLoadResult(value)).toEqual({ ok: false, error: "failed" });
  });

  it("fixed error codes only; anything else is a failure", () => {
    expect(readLoadResult({ ok: false, error: "damaged", damage: "EACCES C:\\SYNTHETIC" })).toEqual({ ok: false, error: "damaged", damage: "invalid-shape" });
    expect(readLoadResult({ ok: false, error: "EIO" })).toEqual({ ok: false, error: "failed" });
    expect(readSaveResult({ ok: false, error: "conflict", settings: EMPTY })).toEqual({ ok: false, error: "conflict" });
    expect(readSaveResult({ ok: false, error: "invalid-settings", detail: "raw text" })).toEqual({ ok: false, error: "invalid-settings", detail: "invalid-shape" });
    expect(readSaveResult({ ok: true, revision: "short", settings: EMPTY })).toEqual({ ok: false, error: "failed" });
  });
});

describe("loading", () => {
  it("missing and valid files become an editable draft", async () => {
    expect((await ready()).c.current).toMatchObject({ phase: "ready", draft: EMPTY, dirty: false });
    const valid = doc([entry("cfg-a1")], "cfg-a1");
    expect((await ready(valid, REV1)).c.current).toMatchObject({ phase: "ready", draft: valid, dirty: false });
  });

  it.each([
    ["damaged", { ok: false, error: "damaged", damage: "invalid-json" }, "damaged"],
    ["newer", { ok: false, error: "unsupported-version" }, "unsupported-version"],
    ["unreadable", { ok: false, error: "unreadable" }, "unreadable"],
  ])("%s file: editing blocked, with a fixed message", async (_name, answer, blocked) => {
    const f = fakeApi();
    const c = new AiConfigEditorController(f.api, () => {});
    const p = c.load();
    f.pending.shift()!.resolve(answer);
    await p;
    expect(c.current).toMatchObject({ phase: "blocked", blocked, draft: null });
    c.startAdd();
    c.select(null);
    await c.save();
    expect(f.save).not.toHaveBeenCalled();
  });

  it("an IPC failure is a fixed message, never the error text", async () => {
    const f = fakeApi();
    const c = new AiConfigEditorController(f.api, () => {});
    const p = c.load();
    f.pending.shift()!.reject(new Error("EACCES: C:\\Users\\SYNTHETIC\\reporunner-ai-settings.json"));
    await p;
    expect(c.current).toMatchObject({ phase: "failed", error: AI_EDITOR_TEXT.loadFailed });
    expect(JSON.stringify(c.current)).not.toMatch(/SYNTHETIC|EACCES/);
  });

  it("a stale load answer is ignored; an answer after close changes nothing", async () => {
    const f = fakeApi();
    const states: AiEditorState[] = [];
    const c = new AiConfigEditorController(f.api, (s) => states.push(s));
    const first = c.load();
    const second = c.load();
    f.pending[1].resolve({ ok: true, state: "missing", revision: null, settings: EMPTY });
    await second;
    f.pending[0].resolve({ ok: true, state: "valid", revision: REV1, settings: doc([entry("cfg-old1")]) });
    await first;
    expect(c.current.draft).toEqual(EMPTY);
    const late = new AiConfigEditorController(f.api, (s) => states.push(s));
    const count = states.length;
    const p = late.load();
    late.close();
    f.pending[2].resolve({ ok: true, state: "missing", revision: null, settings: EMPTY });
    await p;
    expect(states.length).toBe(count + 1); // only the "loading" state from before close
  });
});

describe("adding, editing, selecting, removing", () => {
  it("adds a valid canonical endpoint with a fresh id and marks the draft unsaved", async () => {
    const { c } = await ready();
    c.startAdd();
    c.updateForm({ endpoint: "http://127.0.0.1:11434", apiStyle: "ollama-native", model: "llama3.1:8b" });
    c.applyForm();
    const d = c.current.draft!;
    expect(d.configs).toHaveLength(1);
    expect(d.configs[0]).toMatchObject({ kind: "local-endpoint", endpoint: "http://127.0.0.1:11434", apiStyle: "ollama-native", model: "llama3.1:8b" });
    expect(d.configs[0].id).toMatch(/^cfg-[a-z0-9]{16}$/);
    expect(c.current).toMatchObject({ dirty: true, form: null });
  });

  it("an empty model label becomes null", async () => {
    const { c } = await ready();
    c.startAdd();
    c.updateForm({ endpoint: "http://[::1]:8080/v1", model: "   " });
    c.applyForm();
    expect(c.current.draft!.configs[0].model).toBeNull();
  });

  it.each([
    ["localhost", "http://localhost:11434", "localhost-not-allowed"],
    ["a LAN address", "http://192.168.0.9:11434", "host-not-allowed"],
    ["a public host", "http://example.com:80", "host-not-allowed"],
    ["https", "https://127.0.0.1:8443", "unsupported-scheme"],
    ["no port", "http://127.0.0.1", "port-required"],
    ["userinfo", "http://u:p@127.0.0.1:1", "credentials-not-allowed"],
    ["a query", "http://127.0.0.1:1/?x=1", "query-or-fragment-not-allowed"],
    ["empty", "", "empty"],
  ] as const)("refuses %s with the validator's fixed message; the draft is unchanged", async (_name, endpoint, code) => {
    const { c } = await ready();
    c.startAdd();
    c.updateForm({ endpoint });
    c.applyForm();
    expect(c.current.form?.error).toBe(ENDPOINT_MESSAGES[code]);
    expect(c.current.draft).toEqual(EMPTY);
    expect(c.current.dirty).toBe(false);
  });

  it("an invalid model label is refused", async () => {
    const { c } = await ready();
    c.startAdd();
    c.updateForm({ endpoint: "http://127.0.0.1:1", model: "has space" });
    c.applyForm();
    expect(c.current.form?.error).toBe(AI_EDITOR_TEXT.modelInvalid);
    expect(c.current.draft).toEqual(EMPTY);
  });

  it("a valid address written differently is shown in canonical form and used only after acceptance", async () => {
    const { c } = await ready();
    c.startAdd();
    c.updateForm({ endpoint: "HTTP://127.0.0.1:11434/v1/" });
    c.applyForm();
    expect(c.current.form?.canonical).toBe("http://127.0.0.1:11434/v1");
    expect(c.current.draft).toEqual(EMPTY);
    // Changing the address withdraws the suggestion.
    c.updateForm({ endpoint: "HTTP://127.0.0.1:2/" });
    expect(c.current.form?.canonical).toBeNull();
    c.applyForm();
    c.acceptCanonical();
    expect(c.current.draft!.configs[0].endpoint).toBe("http://127.0.0.1:2");
  });

  it("editing keeps the id and changes only that entry", async () => {
    const { c } = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://[::1]:2")], "cfg-a1"), REV1);
    c.startEdit("cfg-b2");
    expect(c.current.form).toMatchObject({ editingId: "cfg-b2", endpoint: "http://[::1]:2", model: "llama3.1:8b" });
    c.updateForm({ endpoint: "http://127.0.0.1:9", apiStyle: "openai-compatible", model: "" });
    c.applyForm();
    expect(c.current.draft!.configs).toEqual([entry("cfg-a1"), { id: "cfg-b2", kind: "local-endpoint", endpoint: "http://127.0.0.1:9", apiStyle: "openai-compatible", model: null }]);
  });

  it("selects a configuration or none; unknown ids are ignored", async () => {
    const { c } = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://[::1]:2")]), REV1);
    c.select("cfg-b2");
    expect(c.current.draft!.active).toBe("cfg-b2");
    c.select("cfg-nope");
    expect(c.current.draft!.active).toBe("cfg-b2");
    c.select(null);
    expect(c.current.draft!.active).toBeNull();
    expect(c.current.dirty).toBe(false); // back to what was saved
  });

  it("removal needs confirmation; cancel keeps it; confirming an inactive one keeps the selection", async () => {
    const { c } = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://[::1]:2")], "cfg-a1"), REV1);
    c.requestRemove("cfg-b2");
    expect(c.current.draft!.configs).toHaveLength(2);
    c.cancelRemove();
    expect(c.current.confirmingRemove).toBeNull();
    c.requestRemove("cfg-b2");
    c.confirmRemove();
    expect(c.current.draft).toEqual(doc([entry("cfg-a1")], "cfg-a1"));
  });

  it("removing the active configuration clears the selection", async () => {
    const { c } = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://[::1]:2")], "cfg-a1"), REV1);
    c.requestRemove("cfg-a1");
    c.confirmRemove();
    expect(c.current.draft).toEqual(doc([entry("cfg-b2", "http://[::1]:2")], null));
  });

  it("at most three configurations", async () => {
    const { c } = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://[::1]:2"), entry("cfg-c3", "http://[::1]:3")]), REV1);
    c.startAdd();
    expect(c.current.form).toBeNull();
    expect(c.current.error).toBe(AI_EDITOR_TEXT.limit);
  });

  it("added ids are unique among existing ones", async () => {
    const { c } = await ready();
    for (const port of [1, 2, 3]) {
      c.startAdd();
      c.updateForm({ endpoint: `http://127.0.0.1:${port}` });
      c.applyForm();
    }
    const ids = c.current.draft!.configs.map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("saving", () => {
  it("sends the whole draft with the loaded revision, then chains to the new one", async () => {
    const { c, save, pending, onSaved } = await ready(doc([entry("cfg-a1")]), REV1);
    c.select("cfg-a1");
    const s1 = c.save();
    expect(save.mock.calls[0]).toEqual([doc([entry("cfg-a1")], "cfg-a1"), REV1]);
    pending.shift()!.resolve({ ok: true, revision: REV2, settings: doc([entry("cfg-a1")], "cfg-a1") });
    await s1;
    expect(c.current).toMatchObject({ dirty: false, notice: AI_EDITOR_TEXT.saved, saving: false });
    expect(onSaved).toHaveBeenCalledTimes(1);
    c.select(null);
    const s2 = c.save();
    expect(save.mock.calls[1]).toEqual([doc([entry("cfg-a1")], null), REV2]);
    pending.shift()!.resolve({ ok: true, revision: REV3, settings: doc([entry("cfg-a1")], null) });
    await s2;
  });

  it("a missing file saves with revision null", async () => {
    const { c, save } = await ready();
    c.startAdd();
    c.updateForm({ endpoint: "http://127.0.0.1:1" });
    c.applyForm();
    void c.save();
    expect(save.mock.calls[0][1]).toBeNull();
  });

  it("the displayed draft becomes the persisted document from the answer", async () => {
    const { c, pending } = await ready(doc([entry("cfg-a1")]), REV1);
    c.select("cfg-a1");
    const s = c.save();
    pending.shift()!.resolve({ ok: true, revision: REV2, settings: doc([entry("cfg-a1", "http://127.0.0.1:11434", "ollama-native", null)], "cfg-a1") });
    await s;
    expect(c.current.draft!.configs[0].model).toBeNull();
  });

  it("no double submit: a second save while one is in flight sends nothing", async () => {
    const { c, save } = await ready(doc([entry("cfg-a1")]), REV1);
    c.select("cfg-a1");
    void c.save();
    void c.save();
    c.select(null);
    c.startAdd();
    expect(save).toHaveBeenCalledTimes(1);
    expect(c.current.draft!.active).toBe("cfg-a1");
    expect(c.canClose()).toBe(false);
  });

  it("nothing to save until something changed, and not while the form is open", async () => {
    const { c, save } = await ready(doc([entry("cfg-a1")]), REV1);
    c.startAdd();
    await c.save();
    expect(save).not.toHaveBeenCalled();
  });

  it("conflict: a fixed message, no retry, no merge; Reload asks first, then loads the saved version", async () => {
    const { c, save, load, pending } = await ready(doc([entry("cfg-a1")]), REV1);
    c.select("cfg-a1");
    const s = c.save();
    pending.shift()!.resolve({ ok: false, error: "conflict" });
    await s;
    expect(c.current).toMatchObject({ conflict: true, error: AI_EDITOR_TEXT.conflict, dirty: true });
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    // Editing and saving are locked until reload.
    c.select(null);
    await c.save();
    expect(save).toHaveBeenCalledTimes(1);
    c.requestReload();
    expect(c.current.confirmingReload).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    c.cancelReload();
    c.requestReload();
    c.requestReload();
    expect(load).toHaveBeenCalledTimes(2);
    pending.shift()!.resolve({ ok: true, state: "valid", revision: REV3, settings: doc([entry("cfg-zz")]) });
    await flush();
    expect(c.current).toMatchObject({ phase: "ready", conflict: false, dirty: false, draft: doc([entry("cfg-zz")]) });
    c.select("cfg-zz");
    void c.save();
    expect(save.mock.calls[1][1]).toBe(REV3);
  });

  it.each([
    ["damaged", "damaged"],
    ["unsupported-version", "unsupported-version"],
    ["unreadable", "unreadable"],
  ] as const)("a %s answer blocks editing", async (error, blocked) => {
    const { c, pending, save } = await ready(doc([entry("cfg-a1")]), REV1);
    c.select("cfg-a1");
    const s = c.save();
    pending.shift()!.resolve({ ok: false, error });
    await s;
    expect(c.current).toMatchObject({ phase: "blocked", blocked });
    await c.save();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["write-failed", AI_EDITOR_TEXT.writeFailed],
    ["invalid-settings", AI_EDITOR_TEXT.invalid],
    ["failed", AI_EDITOR_TEXT.failed],
    ["SOMETHING-RAW C:\\Users\\SYNTHETIC", AI_EDITOR_TEXT.failed],
  ])("a %s answer is a fixed message; the draft stays unsaved", async (error, message) => {
    const { c, pending } = await ready(doc([entry("cfg-a1")]), REV1);
    c.select("cfg-a1");
    const s = c.save();
    pending.shift()!.resolve({ ok: false, error, detail: "raw" });
    await s;
    expect(c.current).toMatchObject({ error: message, dirty: true, saving: false });
    expect(JSON.stringify(c.current)).not.toMatch(/SYNTHETIC|raw/);
  });

  it("a rejected save is a fixed failure", async () => {
    const { c, pending } = await ready(doc([entry("cfg-a1")]), REV1);
    c.select("cfg-a1");
    const s = c.save();
    pending.shift()!.reject(new Error("EIO C:\\SYNTHETIC"));
    await s;
    expect(c.current.error).toBe(AI_EDITOR_TEXT.failed);
  });

  it("after close: nothing is sent, and a late save answer changes nothing", async () => {
    const { c, save, pending, states } = await ready(doc([entry("cfg-a1")]), REV1);
    c.select("cfg-a1");
    const s = c.save();
    c.close();
    const before = states.length;
    pending.shift()!.resolve({ ok: true, revision: REV2, settings: doc([entry("cfg-a1")], "cfg-a1") });
    await s;
    expect(states.length).toBe(before);
    await c.save();
    expect(save).toHaveBeenCalledTimes(1);
    c.select(null);
    expect(states.length).toBe(before);
  });

  it("after close, a save with nothing in flight sends nothing either", async () => {
    const { c, save } = await ready(doc([entry("cfg-a1")]), REV1);
    c.select("cfg-a1");
    c.close();
    await c.save();
    expect(save).not.toHaveBeenCalled();
  });

  it("unsaved changes are reported for the close prompt", async () => {
    const { c } = await ready(doc([entry("cfg-a1")]), REV1);
    expect(c.hasUnsavedChanges).toBe(false);
    c.select("cfg-a1");
    expect(c.hasUnsavedChanges).toBe(true);
  });

  it("text typed into the form counts as unsaved before it's applied (Codex review)", async () => {
    const { c } = await ready(doc([entry("cfg-a1")]), REV1);
    c.startAdd();
    expect(c.hasUnsavedChanges).toBe(false); // an untouched form isn't a change
    c.updateForm({ endpoint: "http://127.0.0.1:5" });
    expect(c.hasUnsavedChanges).toBe(true);
    expect(c.current.dirty).toBe(false);
    c.cancelForm();
    expect(c.hasUnsavedChanges).toBe(false);
    c.startEdit("cfg-a1");
    expect(c.hasUnsavedChanges).toBe(false);
    c.updateForm({ apiStyle: "openai-compatible" });
    expect(c.hasUnsavedChanges).toBe(true);
    c.updateForm({ apiStyle: "ollama-native" });
    expect(c.hasUnsavedChanges).toBe(false); // back to the original value
    c.updateForm({ model: "other-model" });
    expect(c.hasUnsavedChanges).toBe(true);
  });
});

describe("markup", () => {
  const handlers = Object.fromEntries(["onAdd", "onEdit", "onFormChange", "onApplyForm", "onAcceptCanonical", "onCancelForm", "onSelect", "onRequestRemove", "onConfirmRemove", "onCancelRemove", "onSave", "onReload", "onCancelReload"].map((k) => [k, () => {}])) as unknown as AiEditorHandlers;
  const render = (state: Partial<AiEditorState>) => renderToStaticMarkup(createElement(AiConfigEditorSection, { state: { ...AI_EDITOR_INITIAL, ...state }, handlers }));
  const D = doc([entry("cfg-a1"), entry("cfg-b2", "http://[::1]:8080/v1", "openai-compatible", null)], "cfg-b2");
  const states: Array<[string, Partial<AiEditorState>]> = [
    ["loading", {}],
    ["empty", { phase: "ready", draft: EMPTY }],
    ["two entries", { phase: "ready", draft: D }],
    ["dirty", { phase: "ready", draft: D, dirty: true }],
    ["saved", { phase: "ready", draft: D, notice: AI_EDITOR_TEXT.saved }],
    ["form", { phase: "ready", draft: D, form: { editingId: null, endpoint: "HTTP://127.0.0.1:1/", apiStyle: "openai-compatible", model: "", error: null, canonical: "http://127.0.0.1:1" } }],
    ["form error", { phase: "ready", draft: D, form: { editingId: "cfg-a1", endpoint: "http://localhost:1", apiStyle: "ollama-native", model: "", error: ENDPOINT_MESSAGES["localhost-not-allowed"], canonical: null } }],
    ["removing", { phase: "ready", draft: D, confirmingRemove: "cfg-a1" }],
    ["conflict", { phase: "ready", draft: D, dirty: true, conflict: true, error: AI_EDITOR_TEXT.conflict }],
    ["conflict reload confirm", { phase: "ready", draft: D, dirty: true, conflict: true, confirmingReload: true, error: AI_EDITOR_TEXT.conflict }],
    ["damaged", { phase: "blocked", blocked: "damaged" }],
    ["newer", { phase: "blocked", blocked: "unsupported-version" }],
    ["unreadable", { phase: "blocked", blocked: "unreadable" }],
    ["failed", { phase: "failed", error: AI_EDITOR_TEXT.loadFailed }],
  ];

  it.each(states)("%s: labelled section, fixed wording, never 'connected' or 'ready'", (_name, state) => {
    const html = render(state);
    expect(html).toContain(`aria-labelledby="${AI_EDITOR_TITLE_ID}"`);
    expect(html).toContain("Local AI configurations");
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(MISLEADING);
  });

  it("the saved notice says it isn't connected", () => {
    expect(AI_EDITOR_TEXT.saved).toBe("Saved. Not connected — no AI connection is available in this version.");
    expect(render(states[4][1])).toContain('role="status"');
  });

  it("lists id, endpoint, API style and model; a radio group with None", () => {
    const html = render(states[2][1]);
    for (const s of ["cfg-a1", "cfg-b2", "http://127.0.0.1:11434", "http://[::1]:8080/v1", "Ollama", "OpenAI-compatible", "llama3.1:8b", "No model label", ">None<"]) expect(html).toContain(s);
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/id="ai-config-active-cfg-b2"[^>]*checked=""/);
  });

  it("form fields are labelled; errors use role=alert; a canonical form needs explicit acceptance", () => {
    const html = render(states[5][1]);
    for (const id of ["ai-config-endpoint", "ai-config-api-style", "ai-config-model"]) expect(html).toContain(`for="${id}"`);
    expect(html).toContain("<select");
    expect(html).toContain("This address will be saved as");
    expect(html).toContain("Use this address");
    expect(render(states[6][1])).toMatch(/role="alert"[^>]*>Use 127\.0\.0\.1 or \[::1\] instead of localhost\./);
  });

  it("damaged, newer and unreadable: a fixed alert and no editing controls", () => {
    for (const s of [states[10], states[11], states[12]]) {
      const html = render(s[1]);
      expect(html).toContain('role="alert"');
      expect(html).not.toMatch(/<input|<select|Save changes|Add local endpoint/);
    }
  });

  it("conflict: Reload, and a discard confirmation when there are unsaved changes; controls locked", () => {
    expect(render(states[8][1])).toMatch(/>Reload</);
    expect(render(states[8][1])).toMatch(/<fieldset disabled=""/);
    const confirm = render(states[9][1]);
    expect(confirm).toContain(AI_EDITOR_TEXT.reloadDiscards.replace(/'/g, "&#x27;"));
    expect(confirm).toContain("Discard and reload");
  });

  it("removal confirmation names the entry and says no key is deleted", () => {
    const html = render(states[7][1]);
    expect(html).toContain("Remove cfg-a1? It is removed when you save. No key is deleted.");
  });

  it("Save is disabled until something changed; Add is disabled at three", () => {
    expect(render(states[2][1])).toMatch(/disabled=""[^>]*>Save changes/);
    expect(render(states[3][1])).not.toMatch(/disabled=""[^>]*>Save changes/);
    const full = render({ phase: "ready", draft: doc([entry("cfg-a1"), entry("cfg-b2", "http://[::1]:2"), entry("cfg-c3", "http://[::1]:3")]) });
    expect(full).toMatch(/disabled=""[^>]*>Add local endpoint/);
    expect(full).toContain(AI_EDITOR_TEXT.limit);
  });
});

describe("source boundaries", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

  it("the editor logic and view have no network, storage, credential, IPC, environment or dynamic-code access", () => {
    for (const f of ["src/lib/aiConfigEditor.ts", "src/components/AiConfigEditor.tsx"]) {
      const code = read(f).replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|ipcRenderer|setCredential|credentialStatus|removeCredential|process\.|\beval\(|new Function|console\.|import\(|aiReady/);
    }
    expect([...read("src/lib/aiConfigEditor.ts").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["../types", "./ai/localEndpoint", "./ai/probeSpec", "./ai/settingsSchema"]);
  });

  it("the editor is loaded only from the dialog's effect, never at startup; App only passes it on", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/const aiEditApi = useMemo\(\(\) => getAiConfigEditApi\(window\.repoRunner\), \[\]\);/);
    const rest = app
      .replace('import { getAiConfigEditApi } from "@/lib/aiConfigEditor";', "")
      .replace("const aiEditApi = useMemo(() => getAiConfigEditApi(window.repoRunner), []);", "")
      .replace("aiEditApi={aiEditApi}", "");
    expect(rest).not.toMatch(/aiEditApi|aiConfigEdit|AiConfigEditorController/);
    const dialog = read("src/components/CredentialSettingsDialog.tsx");
    expect(dialog.match(/new AiConfigEditorController\(/g)).toHaveLength(1);
    expect(dialog).toMatch(/useEffect\(\(\) => \{\s*if \(!aiEditApi\) return;\s*const editor = new AiConfigEditorController\(aiEditApi, setAiEditor, \(\) => setStatusVersion\(\(v\) => v \+ 1\)\);\s*editorRef\.current = editor;\s*void editor\.load\(\);\s*return \(\) => \{\s*editor\.close\(\);/);
    expect(dialog).toContain("useState<AiEditorState | null>(aiEditApi ? AI_EDITOR_INITIAL : null)");
  });

  it("the dialog's focus trap covers select and textarea; closing with unsaved changes asks first", () => {
    const dialog = read("src/components/CredentialSettingsDialog.tsx");
    expect(dialog).toContain('const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])";');
    expect(dialog).toMatch(/if \(editor\?\.hasUnsavedChanges\) \{\s*setConfirmingClose\(true\);\s*return;\s*\}/);
    // Codex review: the confirmed close checks again for a save started after the question, and the button waits.
    expect(dialog).toMatch(/const confirmClose = useCallback\(\(\) => \{\s*if \(!closable\(\)\) return;\s*closeNow\(\);/);
    expect(dialog).toContain("onConfirmClose={confirmClose}");
    expect(dialog).toContain('closeBlocked={state.activity === "saving" || state.activity === "removing" || aiEditor?.saving === true}');
    expect(dialog).toMatch(/disabled=\{props\.closeBlocked\} onClick=\{props\.onConfirmClose\}/);
    // A save that finished while the question was showing withdraws it (nothing left to discard).
    expect(dialog).toContain("const nothingToDiscard = !!aiEditor && !aiEditor.saving && editorRef.current?.hasUnsavedChanges === false;");
    expect(dialog).toMatch(/if \(!confirmingClose \|\| !nothingToDiscard\) return;\s*setConfirmingClose\(false\);/);
  });

  it("the browser mock has no editing methods", () => {
    expect(read("src/mock/repoRunnerMock.ts")).not.toMatch(/aiConfigEdit|ai-config-edit/);
  });
});
