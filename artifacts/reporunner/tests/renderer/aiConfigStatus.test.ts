// Stage 4I: the internal Settings dialog's read-only AI configuration status:
// the result check, fixed wording, the once-per-opening loader and the
// dialog markup. Synthetic, non-secret values only.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AI_STATUS_INITIAL,
  AI_STATUS_TEXT,
  AI_UNAVAILABLE_TEXT,
  AiConfigStatusLoader,
  describeAiStatus,
  getAiConfigStatusApi,
  readAiConfigStatus,
  type AiStatusState,
} from "../../src/lib/aiConfigStatus";
import { AI_STATUS_TITLE_ID, CredentialSettingsView } from "../../src/components/CredentialSettingsDialog";
import { INITIAL_STATE } from "../../src/lib/credentialSettings";
import type { AiConfigStatusIpcResult, AiConfigStatusView } from "../../src/types";

const ENDPOINT = "http://127.0.0.1:11434";
const MODEL = "synthetic-model-label-4i";
const REVISION = "c".repeat(64);
const view = (over: Partial<AiConfigStatusView> = {}): AiConfigStatusView => ({
  storage: "missing",
  damage: null,
  configurationCount: 0,
  active: null,
  providerReadiness: "none",
  ...over,
});
const ok = (status: AiConfigStatusView): AiConfigStatusIpcResult => ({ ok: true, status });
const ACTIVE = { id: "cfg-b2", kind: "local-endpoint" as const, apiStyle: "openai-compatible" as const };

/** Every state the section can show. */
const STATES: Array<[string, AiStatusState]> = [
  ["loading", AI_STATUS_INITIAL],
  ["failed", { phase: "failed" }],
  ["missing", { phase: "loaded", status: view() }],
  ["valid, no configurations", { phase: "loaded", status: view({ storage: "valid" }) }],
  ["valid, none selected", { phase: "loaded", status: view({ storage: "valid", configurationCount: 2 }) }],
  ["valid, one selected", { phase: "loaded", status: view({ storage: "valid", configurationCount: 1, active: { ...ACTIVE, apiStyle: "ollama-native" } }) }],
  ["valid, selected of three", { phase: "loaded", status: view({ storage: "valid", configurationCount: 3, active: ACTIVE }) }],
  ["damaged", { phase: "loaded", status: view({ storage: "damaged", damage: "invalid-endpoint" }) }],
  ["unsupported", { phase: "loaded", status: view({ storage: "unsupported-version" }) }],
  ["unreadable", { phase: "loaded", status: view({ storage: "unreadable" }) }],
];
/** Nothing shown may suggest AI works, or reveal values. */
const FORBIDDEN = /\b(ready|connected|connection established|validated|verified|working|online|enabled|reachable|usable)\b|127\.0\.0\.1|11434|synthetic-model|revision|[0-9a-f]{64}|http:|endpoint|model|key|token|password|[A-Z]:\\|\/Users\//i;

describe("availability", () => {
  it("is null unless the preload provides the method", () => {
    expect(getAiConfigStatusApi(undefined)).toBeNull();
    expect(getAiConfigStatusApi({})).toBeNull();
    expect(getAiConfigStatusApi({ aiConfigStatus: "not a function" } as never)).toBeNull();
  });

  it("calls the method with no arguments", async () => {
    const method = vi.fn(async () => ok(view()));
    const apiFn = getAiConfigStatusApi({ aiConfigStatus: method } as never);
    expect(apiFn).not.toBeNull();
    await apiFn!();
    expect(method).toHaveBeenCalledTimes(1);
    expect(method.mock.calls[0]).toEqual([]);
  });
});

describe("results are re-checked and copied field by field", () => {
  it.each([
    ["missing", view()],
    ["valid with none", view({ storage: "valid" })],
    ["valid with a selection", view({ storage: "valid", configurationCount: 2, active: ACTIVE })],
    ["damaged", view({ storage: "damaged", damage: "invalid-json" })],
    ["unsupported", view({ storage: "unsupported-version" })],
    ["unreadable", view({ storage: "unreadable" })],
  ])("accepts %s", (_name, status) => {
    expect(readAiConfigStatus(ok(status))).toEqual(ok(status));
  });

  it("drops anything extra: endpoint, model, revision, settings, path", () => {
    const result = readAiConfigStatus({
      ok: true,
      extra: ENDPOINT,
      status: {
        ...view({ storage: "valid", configurationCount: 1 }),
        active: { ...ACTIVE, endpoint: ENDPOINT, model: MODEL },
        revision: REVISION,
        settings: { configs: [{ endpoint: ENDPOINT }] },
        path: "C:\\Users\\SYNTHETIC\\reporunner-ai-settings.json",
      },
    });
    expect(result).toEqual(ok(view({ storage: "valid", configurationCount: 1, active: ACTIVE })));
    expect(JSON.stringify(result)).not.toMatch(/127\.0\.0\.1|synthetic-model|cccc|SYNTHETIC|settings|revision/);
  });

  it.each([
    ["null", null],
    ["a string", "valid"],
    ["an array", [ok(view())]],
    ["no ok", { status: view() }],
    ["ok true without a status", { ok: true }],
    ["an unknown storage state", ok(view({ storage: "connected" as never }))],
    ["an unknown readiness", ok(view({ providerReadiness: "ready" as never }))],
    ["a negative count", ok(view({ storage: "valid", configurationCount: -1 }))],
    ["a fractional count", ok(view({ storage: "valid", configurationCount: 1.5 }))],
    ["too many configurations", ok(view({ storage: "valid", configurationCount: 4 }))],
    ["a count as a string", ok(view({ storage: "valid", configurationCount: "2" as never }))],
    ["damage without damaged storage", ok(view({ damage: "invalid-json" }))],
    ["damaged storage without a reason", ok(view({ storage: "damaged" }))],
    ["a damage reason that's free text", ok(view({ storage: "damaged", damage: "EACCES: C:\\Users\\x" }))],
    ["a selection without configurations", ok(view({ storage: "valid", active: ACTIVE }))],
    ["configurations on a missing file", ok(view({ configurationCount: 2 }))],
    ["a selection on a damaged file", ok(view({ storage: "damaged", damage: "invalid-json", configurationCount: 1, active: ACTIVE }))],
    ["a selection with a bad id", ok(view({ storage: "valid", configurationCount: 1, active: { ...ACTIVE, id: "../../x" } }))],
    ["a selection with an unknown API style", ok(view({ storage: "valid", configurationCount: 1, active: { ...ACTIVE, apiStyle: "grpc" as never } }))],
    ["a selection of another kind", ok(view({ storage: "valid", configurationCount: 1, active: { ...ACTIVE, kind: "remote-provider" as never } }))],
    ["a class instance", new (class { ok = true; status = view(); })()],
  ])("refuses %s as a failure", (_name, value) => {
    expect(readAiConfigStatus(value)).toEqual({ ok: false, error: "failed" });
  });

  it("keeps the two fixed error codes and nothing else", () => {
    expect(readAiConfigStatus({ ok: false, error: "invalid-request" })).toEqual({ ok: false, error: "invalid-request" });
    expect(readAiConfigStatus({ ok: false, error: "EIO: C:\\secret" })).toEqual({ ok: false, error: "failed" });
  });
});

describe("wording", () => {
  it.each(STATES)("%s: fixed text, never connected, ready or a value", (_name, state) => {
    const lines = describeAiStatus(state);
    for (const line of [lines.summary, lines.selection]) if (line) expect(line).not.toMatch(FORBIDDEN);
  });

  it("each storage state reads differently, and a damaged file isn't described as empty", () => {
    const summaries = STATES.map(([, s]) => describeAiStatus(s).summary);
    expect(describeAiStatus({ phase: "loaded", status: view({ storage: "damaged", damage: "invalid-json" }) }).summary).toBe(AI_STATUS_TEXT.damaged);
    expect(describeAiStatus({ phase: "loaded", status: view({ storage: "unsupported-version" }) }).summary).toBe(AI_STATUS_TEXT["unsupported-version"]);
    expect(describeAiStatus({ phase: "loaded", status: view({ storage: "unreadable" }) }).summary).toBe(AI_STATUS_TEXT.unreadable);
    expect(describeAiStatus({ phase: "loaded", status: view() }).summary).toBe(AI_STATUS_TEXT.missing);
    expect(new Set([AI_STATUS_TEXT.missing, AI_STATUS_TEXT.empty, AI_STATUS_TEXT.damaged, AI_STATUS_TEXT["unsupported-version"], AI_STATUS_TEXT.unreadable, AI_STATUS_TEXT.failed]).size).toBe(6);
    expect(summaries.filter((s) => s === AI_STATUS_TEXT.missing)).toHaveLength(1);
  });

  it("names the selection by id and API style only", () => {
    expect(describeAiStatus(STATES[6][1])).toEqual({ summary: "3 local AI configurations saved.", selection: "Selected: cfg-b2 (OpenAI-compatible)." });
    expect(describeAiStatus(STATES[5][1])).toEqual({ summary: "1 local AI configuration saved.", selection: "Selected: cfg-b2 (Ollama)." });
    expect(describeAiStatus(STATES[4][1]).selection).toBe("None is selected.");
  });

  it("the availability line says no AI connection exists", () => {
    expect(AI_UNAVAILABLE_TEXT).toBe("No AI connection is available in this version.");
  });
});

describe("loader", () => {
  /** A status method whose answers resolve when told to. */
  function pendingApi() {
    const calls: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const api = vi.fn(() => new Promise<AiConfigStatusIpcResult>((resolve, reject) => calls.push({ resolve: resolve as never, reject })));
    return { api, calls };
  }

  it("loads once and reports the checked status", async () => {
    const { api, calls } = pendingApi();
    const onChange = vi.fn();
    const loader = new AiConfigStatusLoader(api, onChange);
    const done = loader.load();
    expect(api).toHaveBeenCalledTimes(1);
    calls[0].resolve({ ok: true, status: { ...view({ storage: "valid", configurationCount: 1, active: ACTIVE }), revision: REVISION } });
    await done;
    expect(onChange.mock.calls).toEqual([[{ phase: "loaded", status: view({ storage: "valid", configurationCount: 1, active: ACTIVE }) }]]);
  });

  it("ignores an answer that arrives after close", async () => {
    const { api, calls } = pendingApi();
    const onChange = vi.fn();
    const loader = new AiConfigStatusLoader(api, onChange);
    const done = loader.load();
    loader.close();
    calls[0].resolve(ok(view({ storage: "valid" })));
    await done;
    expect(onChange).not.toHaveBeenCalled();
    await loader.load();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale answer once a newer request was made", async () => {
    const { api, calls } = pendingApi();
    const onChange = vi.fn();
    const loader = new AiConfigStatusLoader(api, onChange);
    const first = loader.load();
    const second = loader.load();
    calls[1].resolve(ok(view({ storage: "unreadable" })));
    await second;
    calls[0].resolve(ok(view({ storage: "valid", configurationCount: 2 })));
    await first;
    expect(onChange.mock.calls).toEqual([[{ phase: "loaded", status: view({ storage: "unreadable" }) }]]);
  });

  it.each([
    ["a rejection", (c: { reject: (e: unknown) => void }) => c.reject(new Error(`EACCES: C:\\Users\\SYNTHETIC ${ENDPOINT}`))],
    ["a malformed answer", (c: { resolve: (v: unknown) => void }) => c.resolve({ ok: true, status: { storage: "connected" } })],
    ["a fixed error", (c: { resolve: (v: unknown) => void }) => c.resolve({ ok: false, error: "failed" })],
  ])("%s becomes the fixed failure state, without detail", async (_name, settle) => {
    const { api, calls } = pendingApi();
    const onChange = vi.fn();
    const loader = new AiConfigStatusLoader(api, onChange);
    const done = loader.load();
    settle(calls[0] as never);
    await done;
    expect(onChange.mock.calls).toEqual([[{ phase: "failed" }]]);
    expect(JSON.stringify(onChange.mock.calls)).not.toMatch(/EACCES|SYNTHETIC|127\.0\.0\.1/);
  });
});

describe("dialog markup", () => {
  const render = (aiStatus?: AiStatusState | null) =>
    renderToStaticMarkup(
      createElement(CredentialSettingsView, {
        state: { ...INITIAL_STATE, activity: "idle", status: { configured: false, mode: null, persistence: "available" } },
        aiStatus,
        remember: false,
        onRememberChange: () => {},
        onSubmit: () => {},
        onRequestRemove: () => {},
        onConfirmRemove: () => {},
        onCancelRemove: () => {},
        onClose: () => {},
      }),
    );

  it("without the status method, the section isn't offered", () => {
    for (const html of [render(undefined), render(null)]) {
      expect(html).not.toContain("Local AI configuration");
      expect(html).not.toContain("ai-config-status");
    }
  });

  it.each(STATES)("%s: a labelled, read-only section with the fixed availability line", (_name, state) => {
    const html = render(state);
    expect(html).toContain(`aria-labelledby="${AI_STATUS_TITLE_ID}"`);
    expect(html).toContain(`id="${AI_STATUS_TITLE_ID}"`);
    expect(html).toContain("Local AI configuration");
    expect(html).toContain(AI_UNAVAILABLE_TEXT);
    expect(html).toContain(describeAiStatus(state).summary.replace(/'/g, "&#x27;"));
    const section = html.slice(html.indexOf('data-testid="ai-config-status"'));
    // Read only: no field, button or form in the section.
    expect(section).not.toMatch(/<input|<button|<form|<textarea|<select/);
    const sectionText = section.replace(/<[^>]+>/g, " ");
    expect(sectionText.replace(AI_UNAVAILABLE_TEXT, "")).not.toMatch(FORBIDDEN);
  });

  it("the credential part of the dialog is unchanged by the section", () => {
    const without = render(undefined);
    const withSection = render(STATES[6][1]);
    expect(withSection.slice(0, withSection.indexOf('<section'))).toBe(without.slice(0, without.lastIndexOf("</div></div>")));
  });
});

describe("source boundaries", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

  it("the status logic has no network, storage, IPC, environment or dynamic-code access", () => {
    const code = read("src/lib/aiConfigStatus.ts").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|ipcRenderer|process\.|\beval\(|new Function|console\.|setCredential|saveAi|import\(/);
    expect([...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["../types"]);
  });

  it("the status is read only from the dialog's effect, never at startup", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/const aiStatusApi = useMemo\(\(\) => getAiConfigStatusApi\(window\.repoRunner\), \[\]\);/);
    // App only passes the method on; it never calls it (in any form, including aiStatusApi?.()).
    const rest = app
      .replace('import { getAiConfigStatusApi } from "@/lib/aiConfigStatus";', "")
      .replace("const aiStatusApi = useMemo(() => getAiConfigStatusApi(window.repoRunner), []);", "")
      .replace("aiStatusApi={aiStatusApi}", "");
    expect(rest).not.toMatch(/aiStatusApi|aiConfigStatus\b|AiConfigStatusLoader|repoRunner\??\.aiConfigStatus/);
    const dialog = read("src/components/CredentialSettingsDialog.tsx");
    expect(dialog.match(/new AiConfigStatusLoader\(/g)).toHaveLength(1);
    // Without the method there is no section at all (not even "Checking…").
    expect(dialog).toContain("useState<AiStatusState | null>(aiStatusApi ? AI_STATUS_INITIAL : null)");
    // Stage 4L: statusVersion re-reads the status after a successful AI save (still only while the dialog is open).
    expect(dialog).toMatch(/useEffect\(\(\) => \{\s*if \(!aiStatusApi\) return;\s*const loader = new AiConfigStatusLoader\(aiStatusApi, setAiStatus\);\s*void loader\.load\(\);\s*return \(\) => loader\.close\(\);\s*\}, \[aiStatusApi, statusVersion\]\);/);
    expect(dialog).not.toMatch(/localStorage|sessionStorage/);
  });

  it("the browser mock has no AI status method", () => {
    expect(read("src/mock/repoRunnerMock.ts")).not.toMatch(/aiConfigStatus|ai-config-status/);
  });
});
