// Stage 4P: the internal connection-test UI: availability, the exact preview,
// saved-versus-draft gating, the id-and-revision contract, late and stale
// answers, clearing, fixed wording and the markup. Synthetic values only.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AI_EDITOR_INITIAL,
  AI_EDITOR_TEXT,
  AiConfigEditorController,
  PROBE_EXPLANATION,
  PROBE_MESSAGES,
  PROBE_TEXT,
  getAiConfigEditApi,
  probeMessage,
  readProbeResult,
  type AiConfigEditApi,
  type AiEditorState,
  type ProbeView,
} from "../../src/lib/aiConfigEditor";
import { AiConfigEditorSection, type AiEditorHandlers } from "../../src/components/AiConfigEditor";
import type { AiConfigEditDocument, AiConfigEditEntry, AiConfigProbeIpcResult } from "../../src/types";

const REV1 = "1".repeat(64);
const REV2 = "2".repeat(64);
const entry = (id: string, endpoint = "http://127.0.0.1:11434", apiStyle: AiConfigEditEntry["apiStyle"] = "ollama-native", model: string | null = "SYNTHETIC-label"): AiConfigEditEntry => ({ id, kind: "local-endpoint", endpoint, apiStyle, model });
const doc = (configs: AiConfigEditEntry[] = [], active: string | null = null): AiConfigEditDocument => ({ format: "reporunner-ai-settings", version: 1, active, configs });
const FORBIDDEN = /provider verified|\bverified\b|ai ready|\bready\b|\bauthenticated\b|secure connection|connected successfully|\bconnected\b/i;

type Pending = { kind: "load" | "save" | "probe"; args: unknown[]; resolve: (v: unknown) => void; reject: (e: unknown) => void };
function fakeApi(withProbe = true) {
  const pending: Pending[] = [];
  const make = (kind: Pending["kind"]) => vi.fn((...args: unknown[]) => new Promise((resolve, reject) => pending.push({ kind, args, resolve, reject })));
  const load = make("load");
  const save = make("save");
  const probe = make("probe");
  const api = { load, save, ...(withProbe ? { probe } : {}) } as unknown as AiConfigEditApi;
  return { api, load, save, probe, pending };
}
async function ready(document: AiConfigEditDocument = doc([entry("cfg-a1")]), revision: string | null = REV1, withProbe = true) {
  const f = fakeApi(withProbe);
  const states: AiEditorState[] = [];
  const c = new AiConfigEditorController(f.api, (s) => states.push(s));
  const p = c.load();
  f.pending.shift()!.resolve({ ok: true, state: revision ? "valid" : "missing", revision, settings: document });
  await p;
  return { c, states, ...f };
}
const next = (f: { pending: Pending[] }, kind: Pending["kind"]) => {
  const i = f.pending.findIndex((p) => p.kind === kind);
  return f.pending.splice(i, 1)[0];
};

describe("availability", () => {
  it("the probe is offered only when the preload provides it", () => {
    const base = { aiConfigEditLoad: async () => ({}), aiConfigEditSave: async () => ({}) };
    expect(getAiConfigEditApi(base as never)!.probe).toBeUndefined();
    const probe = vi.fn(async () => ({ ok: true, outcome: "timeout" }));
    const api = getAiConfigEditApi({ ...base, aiConfigProbe: probe } as never)!;
    expect(typeof api.probe).toBe("function");
    void api.probe!("cfg-a1", REV1);
    expect(probe.mock.calls).toEqual([["cfg-a1", REV1]]);
  });

  it("without the probe method there's no test UI at all", async () => {
    const { c } = await ready(doc([entry("cfg-a1")]), REV1, false);
    expect(c.probeView("cfg-a1")).toBeNull();
  });
});

describe("preview", () => {
  it("the exact request for a saved configuration: method, path, destination, API style, five headers", async () => {
    const { c } = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://[::1]:8080/v1", "openai-compatible", null)]), REV1);
    expect(c.probeView("cfg-a1")!.preview).toEqual({
      url: "http://127.0.0.1:11434/api/version",
      method: "GET",
      path: "/api/version",
      apiStyle: "Ollama",
      headers: [["Host", "127.0.0.1:11434"], ["Accept", "application/json"], ["Accept-Encoding", "identity"], ["Connection", "close"], ["User-Agent", "RepoRunner-LocalProbe/1"]],
    });
    const b = c.probeView("cfg-b2")!.preview!;
    expect([b.method, b.path, b.url, b.apiStyle]).toEqual(["GET", "/v1/models", "http://[::1]:8080/v1/models", "OpenAI-compatible"]);
    expect(b.headers[0]).toEqual(["Host", "[::1]:8080"]);
    expect(JSON.stringify(b)).not.toMatch(/authorization|cookie|content-length|SYNTHETIC/i);
  });

  it("no implied /v1: an openai-compatible endpoint without a base path is probed at /models", async () => {
    const { c } = await ready(doc([entry("cfg-a1", "http://127.0.0.1:1234", "openai-compatible")]), REV1);
    expect(c.probeView("cfg-a1")!.preview!.path).toBe("/models");
  });
});

describe("only a saved, unchanged configuration can be tested", () => {
  it("ready: testable", async () => {
    const { c } = await ready();
    expect(c.probeView("cfg-a1")).toMatchObject({ canTest: true, reason: null, testing: false, result: null });
  });

  it("a configuration added but not saved: no preview, can't test", async () => {
    const { c } = await ready();
    c.startAdd();
    c.updateForm({ endpoint: "http://127.0.0.1:2" });
    c.applyForm();
    const added = c.current.draft!.configs.find((x) => x.id !== "cfg-a1")!.id;
    expect(c.probeView(added)).toMatchObject({ preview: null, canTest: false, reason: PROBE_TEXT.saveFirst });
  });

  it("unsaved changes (selection, edit, removal) or an open form: no preview, can't test", async () => {
    for (const change of [
      (c: AiConfigEditorController) => c.select("cfg-a1"),
      (c: AiConfigEditorController) => (c.startEdit("cfg-a1"), c.updateForm({ endpoint: "http://127.0.0.1:9" }), c.applyForm()),
      (c: AiConfigEditorController) => c.startAdd(),
      (c: AiConfigEditorController) => c.startEdit("cfg-a1"),
    ]) {
      const { c } = await ready();
      change(c);
      expect(c.probeView("cfg-a1")).toMatchObject({ preview: null, canTest: false, reason: PROBE_TEXT.unsaved });
    }
  });

  it("no file yet (no revision): nothing to test", async () => {
    const { c } = await ready(doc([]), null);
    expect(c.probeView("cfg-a1")).toMatchObject({ canTest: false, reason: PROBE_TEXT.saveFirst });
  });

  it("damaged, newer or unreadable settings: no preview and no action", async () => {
    for (const answer of [{ ok: false, error: "damaged", damage: "invalid-json" }, { ok: false, error: "unsupported-version" }, { ok: false, error: "unreadable" }]) {
      const f = fakeApi();
      const c = new AiConfigEditorController(f.api, () => {});
      const p = c.load();
      f.pending.shift()!.resolve(answer);
      await p;
      expect(c.probeView("cfg-a1")).toMatchObject({ preview: null, canTest: false });
      await c.testConnection("cfg-a1");
      expect(f.probe).not.toHaveBeenCalled();
    }
  });

  it("while saving, reloading or in conflict: can't test", async () => {
    const s1 = await ready();
    s1.c.select("cfg-a1");
    void s1.c.save();
    s1.c.select(null); // ignored while saving
    expect(s1.c.probeView("cfg-a1")!.canTest).toBe(false);
    const s2 = await ready();
    void s2.c.requestReload();
    expect(s2.c.probeView("cfg-a1")!.canTest).toBe(false);
  });

  it("a refused click sends nothing", async () => {
    const { c, probe } = await ready();
    c.select("cfg-a1");
    await c.testConnection("cfg-a1");
    await c.testConnection("cfg-nope");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("a test", () => {
  it("one click: exactly the saved id and the loaded revision; Testing… then a fixed result; nothing automatic", async () => {
    const f = await ready();
    expect(f.probe).not.toHaveBeenCalled(); // not on open or load
    const t = f.c.testConnection("cfg-a1");
    expect(f.probe.mock.calls).toEqual([["cfg-a1", REV1]]);
    expect(f.c.probeView("cfg-a1")).toMatchObject({ testing: true, canTest: false });
    await f.c.testConnection("cfg-a1"); // a second click while testing
    expect(f.probe).toHaveBeenCalledTimes(1);
    next(f, "probe").resolve({ ok: true, outcome: "compatible", modelCount: 3 });
    await t;
    expect(f.c.probeView("cfg-a1")).toMatchObject({ testing: false, canTest: true, result: { text: PROBE_MESSAGES.compatible, detail: "The response listed 3 models.", tone: "status" } });
    expect(f.probe).toHaveBeenCalledTimes(1); // never retried
    // A compatible answer changes nothing else: no notice, no readiness wording anywhere in the state.
    expect(f.c.current.notice).toBeNull();
    expect(JSON.stringify(f.c.current)).not.toMatch(/ai ready|ready|connected|verified|authenticated/i);
  });

  it("a fresh opening (a new controller) shows no earlier result: nothing is kept between openings", async () => {
    const f = await ready();
    const t = f.c.testConnection("cfg-a1");
    next(f, "probe").resolve({ ok: true, outcome: "compatible", modelCount: 2 });
    await t;
    f.c.close();
    const again = await ready();
    expect(again.c.probeView("cfg-a1")).toMatchObject({ result: null, testing: false });
    expect(again.c.current.probe).toBeNull();
  });

  it("after saving, the next test uses the new revision; saving itself doesn't test", async () => {
    const f = await ready();
    f.c.select("cfg-a1");
    const s = f.c.save();
    next(f, "save").resolve({ ok: true, revision: REV2, settings: doc([entry("cfg-a1")], "cfg-a1") });
    await s;
    expect(f.probe).not.toHaveBeenCalled();
    void f.c.testConnection("cfg-a1");
    expect(f.probe.mock.calls).toEqual([["cfg-a1", REV2]]);
  });

  it("busy and rate-limited: fixed wording, no retry", async () => {
    for (const error of ["busy", "rate-limited"] as const) {
      const f = await ready();
      const t = f.c.testConnection("cfg-a1");
      next(f, "probe").resolve({ ok: false, error });
      await t;
      expect(f.c.probeView("cfg-a1")!.result).toEqual({ text: PROBE_MESSAGES[error], detail: null, tone: "alert" });
      expect(f.probe).toHaveBeenCalledTimes(1);
    }
  });

  it("conflict: the existing conflict flow (Reload), nothing retried", async () => {
    const f = await ready();
    const t = f.c.testConnection("cfg-a1");
    next(f, "probe").resolve({ ok: false, error: "conflict" });
    await t;
    expect(f.c.current).toMatchObject({ conflict: true, error: AI_EDITOR_TEXT.conflict });
    expect(f.c.probeView("cfg-a1")).toMatchObject({ canTest: false, reason: PROBE_TEXT.conflictReload });
    expect(f.probe).toHaveBeenCalledTimes(1);
  });

  it("a rejected call or a malformed answer: a fixed failure, never the error text", async () => {
    for (const settle of [(p: Pending) => p.reject(new Error("EACCES C:\\Users\\SYNTHETIC")), (p: Pending) => p.resolve({ ok: true, outcome: "compatible", modelCount: 1, models: ["SYNTHETIC"] })]) {
      const f = await ready();
      const t = f.c.testConnection("cfg-a1");
      settle(next(f, "probe"));
      await t;
      const shown = JSON.stringify(f.c.probeView("cfg-a1"));
      expect(shown).not.toMatch(/SYNTHETIC|EACCES/);
    }
  });
});

describe("stale and late answers", () => {
  it("after close: ignored, nothing changes", async () => {
    const f = await ready();
    const t = f.c.testConnection("cfg-a1");
    const before = f.states.length;
    f.c.close();
    next(f, "probe").resolve({ ok: true, outcome: "compatible", modelCount: null });
    await t;
    expect(f.states.length).toBe(before);
  });

  it("after a reload: ignored, and the result is cleared", async () => {
    const f = await ready();
    const t = f.c.testConnection("cfg-a1");
    const r = f.c.load();
    next(f, "load").resolve({ ok: true, state: "valid", revision: REV1, settings: doc([entry("cfg-a1")]) });
    await r;
    next(f, "probe").resolve({ ok: true, outcome: "compatible", modelCount: null });
    await t;
    expect(f.c.probeView("cfg-a1")).toMatchObject({ testing: false, result: null });
  });

  it("after the revision changed (a save): ignored", async () => {
    const f = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://127.0.0.1:2")]));
    const t = f.c.testConnection("cfg-a1");
    f.c.select("cfg-b2"); // a change clears the test; then it's saved
    const s = f.c.save();
    next(f, "save").resolve({ ok: true, revision: REV2, settings: doc([entry("cfg-a1"), entry("cfg-b2", "http://127.0.0.1:2")], "cfg-b2") });
    await s;
    next(f, "probe").resolve({ ok: true, outcome: "compatible", modelCount: null });
    await t;
    expect(f.c.probeView("cfg-a1")!.result).toBeNull();
  });

  it("two tests finishing out of order (the first invalidated by a reload): only the newer result counts", async () => {
    const f = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://127.0.0.1:2")]));
    const t1 = f.c.testConnection("cfg-a1");
    const p1 = next(f, "probe");
    const r = f.c.load();
    next(f, "load").resolve({ ok: true, state: "valid", revision: REV1, settings: doc([entry("cfg-a1"), entry("cfg-b2", "http://127.0.0.1:2")]) });
    await r;
    const t2 = f.c.testConnection("cfg-b2");
    const p2 = next(f, "probe");
    p2.resolve({ ok: true, outcome: "timeout" }); // the newer test answers first
    await t2;
    p1.resolve({ ok: true, outcome: "compatible", modelCount: 5 }); // the older one arrives late
    await t1;
    expect(f.c.probeView("cfg-b2")!.result!.text).toBe(PROBE_MESSAGES.timeout);
    expect(f.c.probeView("cfg-a1")!.result).toBeNull();
    expect(f.c.current.probe).toMatchObject({ configId: "cfg-b2", testing: false });
  });

  it("a configuration removed during a test: the answer is ignored", async () => {
    const f = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://127.0.0.1:2")]));
    const t = f.c.testConnection("cfg-a1");
    f.c.requestRemove("cfg-a1");
    f.c.confirmRemove();
    next(f, "probe").resolve({ ok: true, outcome: "compatible", modelCount: null });
    await t;
    expect(f.c.current.probe).toBeNull();
  });

  it("any change to the draft clears a shown result", async () => {
    const f = await ready(doc([entry("cfg-a1"), entry("cfg-b2", "http://127.0.0.1:2")]));
    const t = f.c.testConnection("cfg-a1");
    next(f, "probe").resolve({ ok: true, outcome: "connection-refused" });
    await t;
    expect(f.c.probeView("cfg-a1")!.result).not.toBeNull();
    f.c.select("cfg-b2");
    expect(f.c.current.probe).toBeNull();
  });
});

describe("results and wording", () => {
  const all: AiConfigProbeIpcResult[] = [
    { ok: true, outcome: "compatible", modelCount: null },
    { ok: true, outcome: "compatible", modelCount: 1 },
    { ok: true, outcome: "http-error", statusClass: "5xx" },
    ...(["incompatible-response", "redirect-refused", "auth-required", "not-found-at-path", "connection-refused", "timeout", "response-too-large", "address-mismatch"] as const).map((outcome) => ({ ok: true as const, outcome })),
    ...(["not-available", "invalid-request", "missing", "damaged", "unsupported-version", "unreadable", "conflict", "not-found", "invalid-configuration", "port-in-use-by-project", "busy", "rate-limited", "cancelled", "failed"] as const).map((error) => ({ ok: false as const, error })),
  ];

  it("every outcome and error has a fixed message; none claims verification, readiness or a connection", () => {
    expect(Object.keys(PROBE_MESSAGES)).toHaveLength(24);
    for (const r of all) {
      expect(readProbeResult(r)).toEqual(r);
      const m = probeMessage(r);
      expect(m.text.length).toBeGreaterThan(10);
      expect(`${m.text} ${m.detail ?? ""}`).not.toMatch(FORBIDDEN);
    }
    for (const line of [...PROBE_EXPLANATION, ...Object.values(PROBE_TEXT)]) expect(line).not.toMatch(FORBIDDEN);
    expect(PROBE_MESSAGES.compatible).toBe("A compatible-looking response was received from the local endpoint. This does not verify which program answered, and AI features remain unavailable.");
  });

  it("only the bounded metadata: a model count or status class, never names or versions", () => {
    expect(probeMessage({ ok: true, outcome: "compatible", modelCount: 1 }).detail).toBe("The response listed 1 model.");
    expect(probeMessage({ ok: true, outcome: "http-error", statusClass: "4xx" }).detail).toBe("HTTP status class: 4xx.");
    for (const bad of [
      { ok: true, outcome: "compatible", modelCount: 1001 },
      { ok: true, outcome: "compatible", modelCount: -1 },
      { ok: true, outcome: "compatible", modelCount: "3" },
      { ok: true, outcome: "http-error", statusClass: "418 I'm a teapot" },
      { ok: true, outcome: "SYNTHETIC" },
      { ok: false, error: "EACCES" },
      null,
      "compatible",
    ]) {
      expect(readProbeResult(bad)).toEqual({ ok: false, error: "failed" });
    }
    expect(readProbeResult({ ok: true, outcome: "compatible", modelCount: 2, version: "0.5.7", models: ["SYNTHETIC"] })).toEqual({ ok: true, outcome: "compatible", modelCount: 2 });
  });
});

describe("markup", () => {
  const handlers = Object.fromEntries(["onAdd", "onEdit", "onFormChange", "onApplyForm", "onAcceptCanonical", "onCancelForm", "onSelect", "onRequestRemove", "onConfirmRemove", "onCancelRemove", "onSave", "onReload", "onCancelReload", "onTest"].map((k) => [k, () => {}])) as unknown as AiEditorHandlers;
  const D = doc([entry("cfg-a1")]);
  const view = (v: Partial<ProbeView>): ProbeView => ({
    preview: { url: "http://127.0.0.1:11434/api/version", method: "GET", path: "/api/version", apiStyle: "Ollama", headers: [["Host", "127.0.0.1:11434"], ["Accept", "application/json"], ["Accept-Encoding", "identity"], ["Connection", "close"], ["User-Agent", "RepoRunner-LocalProbe/1"]] },
    canTest: true,
    reason: null,
    testing: false,
    result: null,
    ...v,
  });
  const render = (v: ProbeView | null) => renderToStaticMarkup(createElement(AiConfigEditorSection, { state: { ...AI_EDITOR_INITIAL, phase: "ready", draft: D }, handlers, probeFor: () => v }));

  it("the preview, the explanation tied to the button, and an enabled Test connection", () => {
    const html = render(view({}));
    for (const s of ["Connection test", "GET /api/version", "http://127.0.0.1:11434/api/version", "Host: 127.0.0.1:11434", "Accept: application/json", "Accept-Encoding: identity", "Connection: close", "User-Agent: RepoRunner-LocalProbe/1", "None. No Authorization header, cookies or credentials."]) expect(html).toContain(s);
    for (const line of PROBE_EXPLANATION) expect(html).toContain(line.replace(/'/g, "&#x27;"));
    expect(html).toMatch(/aria-describedby="ai-probe-cfg-a1-explain"[^>]*>Test connection</);
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="ai-probe-test"/);
  });

  it("testing: the button is busy and disabled, with a status line", () => {
    const html = render(view({ canTest: false, testing: true }));
    expect(html).toMatch(/disabled="" aria-busy="true"[^>]*>Testing…</);
    expect(html).toMatch(/role="status"[^>]*>Testing…</);
  });

  it("results: role=status for outcomes, role=alert for errors", () => {
    expect(render(view({ result: { text: PROBE_MESSAGES.compatible, detail: null, tone: "status" } }))).toMatch(/role="status"[^>]*data-testid="ai-probe-result">A compatible-looking response/);
    expect(render(view({ result: { text: PROBE_MESSAGES.busy, detail: null, tone: "alert" } }))).toMatch(/role="alert"[^>]*data-testid="ai-probe-result">Another connection test/);
  });

  it("not testable: a reason and no preview or button", () => {
    const html = render(view({ preview: null, canTest: false, reason: PROBE_TEXT.unsaved }));
    expect(html).toContain(PROBE_TEXT.unsaved);
    expect(html).not.toMatch(/ai-probe-test|ai-probe-preview/);
  });

  it("no probe method: no Connection test block at all", () => {
    expect(render(null)).not.toContain("Connection test");
  });
});

describe("source boundaries", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/^\s*\/\/.*$/gm, "");

  it("the renderer never opens a connection, stores a result or changes capabilities", () => {
    for (const f of ["src/lib/aiConfigEditor.ts", "src/components/AiConfigEditor.tsx", "src/components/CredentialSettingsDialog.tsx"]) {
      const code = read(f);
      expect(code, f).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|ipcRenderer|setInterval|AI_IMPLEMENTED|PRODUCTION_AI_ADAPTERS|providerReadiness|probeLocalEndpoint/);
    }
  });

  it("the dialog only forwards the click; nothing tests on open, save or selection", () => {
    const dialog = read("src/components/CredentialSettingsDialog.tsx");
    expect(dialog.match(/testConnection\(/g)).toHaveLength(1);
    expect(dialog).toContain("onTest: (id) => void editor()?.testConnection(id),");
    const editor = read("src/lib/aiConfigEditor.ts");
    // testConnection is only called from the dialog's handler, never inside the controller.
    expect(editor.match(/testConnection\(/g)).toHaveLength(1);
  });

  it("the mock has no probe method", () => {
    expect(fs.readFileSync(path.join(ROOT, "src/mock/repoRunnerMock.ts"), "utf8")).not.toMatch(/aiConfigProbe|ai-config-probe/);
  });
});
