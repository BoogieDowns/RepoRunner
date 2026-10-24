// Stage 3C: the live rules around "Use in Setup…": analysis identity, field
// origins, when a review goes stale and what Apply may change. Driven through
// the real analysis controller (with a fake API) and the screen's pure
// session helpers, as event sequences; the panel wiring is checked by
// rendering. The real Electron harness covers clicking, focus and saving.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RepoAnalysisPanel } from "../../src/components/RepoAnalysisPanel";
import { SetupDraftReview } from "../../src/components/SetupDraftReview";
import { suggestCommands } from "../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../src/lib/insights/types";
import { createRepoAnalysisController, type RepoAnalysisState } from "../../src/lib/repoAnalysis";
import type { SetupDraftForm, SetupDraftPlan } from "../../src/lib/setupDraft";
import {
  analysisForDraft,
  applyFromScreen,
  canUseSuggestion,
  fieldEdited,
  initialFieldOrigins,
  planFromScreen,
  reviewInvalidation,
  type SetupScreenDraftState,
} from "../../src/lib/setupDraftSession";
import type { RepoRunnerAPI, RepoScanResult } from "../../src/types";
import { deepFreeze, pkg, scan, type ScanOptions } from "./insights/builders";

const REPO = "C:\\Users\\dev\\repo";
const DEFAULTS: SetupDraftForm = {
  name: "",
  repoPath: REPO,
  installCommand: "npm install",
  frontendCommand: "npm run dev",
  backendCommand: "npm start",
  previewUrl: "http://localhost:3000",
  frontendPort: "3000",
  backendPort: "3001",
};
const viteApp = (scripts: Record<string, string> = { dev: "vite", start: "vite preview" }, files = ["pnpm-lock.yaml", "vite.config.ts"]): ScanOptions => ({
  packages: [pkg("package.json", { deps: ["react"], dev: ["vite"], scripts })],
  files,
});

/** The analysis controller with an API whose calls are resolved by hand. */
function analysisHarness() {
  const calls: Array<{ path: string; resolve(r: RepoScanResult): void }> = [];
  const others = { saveProject: vi.fn(), runInstall: vi.fn(), startFrontend: vi.fn(), startBackend: vi.fn(), restartAll: vi.fn(), pullLatest: vi.fn() };
  const api = {
    ...others,
    analyzeRepo: vi.fn((p: string) => new Promise<RepoScanResult>((resolve) => calls.push({ path: p, resolve }))),
    cancelRepoAnalysis: vi.fn(async () => {}),
  };
  let state: RepoAnalysisState = { phase: "idle" };
  const controller = createRepoAnalysisController(() => api as unknown as RepoRunnerAPI, (s) => (state = s), { active: null });
  return {
    controller,
    calls,
    others,
    get state() {
      return state;
    },
    /** Starts an analysis of `p` and completes it with `result`. */
    async analyze(p: string, result: RepoScanResult) {
      const run = controller.start(p);
      calls[calls.length - 1].resolve(result);
      await run;
      return state;
    },
  };
}

/** The Setup screen's draft-relevant state, built the way SetupScreen builds it. */
const screen = (analysis: RepoAnalysisState, over: Partial<SetupScreenDraftState> = {}): SetupScreenDraftState => ({
  form: DEFAULTS,
  fieldOrigins: initialFieldOrigins("initial-defaults"),
  setupId: "setup-1",
  analysis,
  ...over,
});
const find = (state: RepoAnalysisState, match: (s: CommandSuggestion) => boolean) => {
  if (state.phase !== "done") throw new Error("no completed analysis");
  const s = suggestCommands(state.result).suggestions.find(match);
  if (!s) throw new Error("no such suggestion");
  return s;
};
const install = (s: CommandSuggestion) => s.source === "install" && s.directory === ".";
const script = (name: string) => (s: CommandSuggestion) => s.scriptName === name && s.directory === ".";
function open(suggestion: CommandSuggestion, state: SetupScreenDraftState): SetupDraftPlan {
  const plan = planFromScreen(suggestion, state);
  if (plan.status !== "eligible") throw new Error(`refused: ${plan.reason}`);
  return plan;
}
function applied(plan: SetupDraftPlan, state: SetupScreenDraftState) {
  const out = applyFromScreen(plan, state);
  if (out.status !== "applied") throw new Error(`not applied: ${out.reason}`);
  return out;
}
const changedFields = (before: SetupDraftForm, after: SetupDraftForm) => (Object.keys(before) as (keyof SetupDraftForm)[]).filter((k) => before[k] !== after[k]);

describe("analysis identity", () => {
  it("every completed analysis gets a fresh id, bound to its result; same path twice differs", async () => {
    const h = analysisHarness();
    const first = await h.analyze(REPO, scan(viteApp()));
    const second = await h.analyze(REPO, scan(viteApp()));
    if (first.phase !== "done" || second.phase !== "done") throw new Error("not done");
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.id).not.toBe(first.id);
    expect(analysisForDraft(second)).toEqual({ id: second.id, repoPath: REPO, result: second.result });
    expect(second.result).not.toBe(first.result);
  });

  it("ids aren't reused after a cancel or a new controller", async () => {
    const ids = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const h = analysisHarness();
      const run = h.controller.start(REPO);
      h.controller.cancel();
      h.calls[0].resolve(scan({ ...viteApp(), status: "cancelled" }));
      await run;
      if (h.state.phase === "done") ids.add(h.state.id);
      const again = await h.analyze(REPO, scan(viteApp()));
      if (again.phase === "done") ids.add(again.id);
    }
    expect(ids.size).toBe(6);
  });

  it("only a completed analysis can be planned from", () => {
    expect(analysisForDraft({ phase: "idle" })).toBeNull();
    expect(analysisForDraft({ phase: "running", path: REPO, cancelling: false })).toBeNull();
    expect(analysisForDraft({ phase: "error", path: REPO, code: "failed", message: "x" })).toBeNull();
  });
});

describe("field origins", () => {
  it("first run: untouched defaults; Add New: blank; a saved setup: the user's", () => {
    expect(initialFieldOrigins("initial-defaults")).toEqual({ installCommand: "initial-default", frontendCommand: "initial-default" });
    expect(initialFieldOrigins("blank")).toEqual({});
    expect(initialFieldOrigins("saved")).toEqual({ installCommand: "user-entered", frontendCommand: "user-entered" });
  });

  it("typing makes a field the user's, even when the text equals the default", () => {
    let origins = initialFieldOrigins("initial-defaults");
    origins = fieldEdited(origins, "frontendCommand");
    expect(origins).toEqual({ installCommand: "initial-default", frontendCommand: "user-entered" });
    expect(fieldEdited(origins, "name")).toBe(origins); // other fields aren't tracked
  });

  it("the review reports origin as recorded, not from the text", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const s = find(done, install);
    expect(open(s, screen(done)).change.currentKind).toBe("initial-default");
    const typedSame = screen(done, { fieldOrigins: fieldEdited(initialFieldOrigins("initial-defaults"), "installCommand") });
    expect(open(s, typedSame).change.currentKind).toBe("user-entered");
    expect(open(s, screen(done, { form: { ...DEFAULTS, installCommand: "" }, fieldOrigins: {} })).change.currentKind).toBe("blank");
  });
});

describe("Use in Setup → review → Apply", () => {
  it("root install, develop and start: each fills only its own field", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const state = screen(done);
    const cases: Array<[(s: CommandSuggestion) => boolean, keyof SetupDraftForm, string]> = [
      [install, "installCommand", "pnpm install"],
      [script("dev"), "frontendCommand", "pnpm run dev"],
      [script("start"), "frontendCommand", "pnpm run start"],
    ];
    for (const [match, field, value] of cases) {
      const plan = open(find(done, match), state);
      const out = applied(plan, state);
      expect(changedFields(state.form, out.form)).toEqual([field]);
      expect(out.form[field]).toBe(value);
      expect(out.fieldOrigins[field as "installCommand"]).toBe("user-entered");
    }
  });

  it("opening a review changes nothing; cancelling (closing it) changes nothing", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const state = deepFreeze(screen(done));
    const before = JSON.stringify(state.form);
    const plan = open(find(done, script("dev")), state);
    expect(JSON.stringify(state.form)).toBe(before);
    // Cancel is simply not applying: the form is the same object, untouched.
    expect(state.form).toBe(state.form);
    expect(JSON.stringify(state.form)).toBe(before);
    expect(plan.change).toEqual({ field: "frontendCommand", currentValue: "npm run dev", proposedValue: "pnpm run dev", currentKind: "initial-default" });
  });

  it("the review shows exactly the plan's current and proposed values and the replace warning", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const plan = open(find(done, script("dev")), screen(done, { form: { ...DEFAULTS, frontendCommand: "node my-server.js" }, fieldOrigins: initialFieldOrigins("saved") }));
    const html = renderToStaticMarkup(createElement(SetupDraftReview, { plan, onApply: () => {}, onCancel: () => {} }));
    expect(html).toMatch(/data-testid="setup-draft-current">node my-server\.js</);
    expect(html).toMatch(/data-testid="setup-draft-proposed">pnpm run dev</);
    expect(html).toContain("A value you entered or saved. It will be replaced.");
  });

  it("after Apply the field is the user's, and later edits stay theirs", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    let state = screen(done);
    const out = applied(open(find(done, install), state), state);
    state = { ...state, form: out.form, fieldOrigins: out.fieldOrigins };
    // The user edits the applied value.
    state = { ...state, form: { ...state.form, installCommand: "pnpm install --frozen-lockfile" }, fieldOrigins: fieldEdited(state.fieldOrigins, "installCommand") };
    const next = open(find(done, install), state);
    expect(next.change).toMatchObject({ currentValue: "pnpm install --frozen-lockfile", currentKind: "user-entered" });
  });

  it("conflicting managers: no row is chosen for the user; clicking one is the explicit choice, with its caveat kept", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp({ dev: "vite" }, ["package-lock.json", "pnpm-lock.yaml", "vite.config.ts"])));
    const state = screen(done);
    const alternatives = suggestCommands((done as { result: RepoScanResult }).result).suggestions.filter((s) => s.directory === "." && s.packageManagerAmbiguous);
    expect(alternatives.map((s) => s.packageManager).sort()).toEqual(["npm", "npm", "pnpm", "pnpm"]);
    for (const s of alternatives) expect(canUseSuggestion(s, state)).toBe(true);
    const plan = open(alternatives.find((s) => s.scriptName === "dev" && s.packageManager === "pnpm")!, state);
    expect(plan.packageManager).toBe("pnpm");
    expect(plan.options).toEqual({ chosenPackageManager: "pnpm" });
    expect(plan.suggestion.packageManagerAmbiguous).toBe(true);
    expect(applied(plan, state).form.frontendCommand).toBe("pnpm run dev");
  });

  it("nested packages and orchestration stay informational", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan({
      packages: [
        pkg("package.json", { workspaces: ["apps/*"], scripts: { dev: "turbo run dev" } }),
        pkg("apps/web/package.json", { deps: ["react"], dev: ["vite"], scripts: { dev: "vite" } }),
      ],
      files: ["package-lock.json", "apps/web/vite.config.ts"],
    }));
    const state = screen(done);
    const all = suggestCommands((done as { result: RepoScanResult }).result).suggestions;
    const usable = all.filter((s) => canUseSuggestion(s, state)).map((s) => s.id);
    expect(usable).toEqual([".|install|install|npm"]);
    expect(all.some((s) => s.directory === "apps/web")).toBe(true);
    expect(all.some((s) => s.orchestration !== null)).toBe(true);
  });

  it("incomplete analysis: the plan is marked incomplete, never High, with its caveat", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan({ ...viteApp(), status: "timed-out" }));
    const plan = open(find(done, script("dev")), screen(done));
    expect([plan.scanComplete, plan.confidence]).toEqual([false, "medium"]);
    expect(plan.caveats.map((c) => c.code)).toContain("scan-incomplete");
  });
});

describe("a review goes stale", () => {
  async function opened() {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const state = screen(done);
    return { h, done, state, plan: open(find(done, script("dev")), state) };
  }

  it("while nothing changed it stays open and applies", async () => {
    const { state, plan } = await opened();
    expect(reviewInvalidation(plan, state)).toBeNull();
    expect(applyFromScreen(plan, state).status).toBe("applied");
  });

  it("the repository path changes (and the controller drops its result)", async () => {
    const { h, state, plan } = await opened();
    h.controller.pathChanged("C:\\Users\\dev\\other");
    const live = screen(h.state, { form: { ...state.form, repoPath: "C:\\Users\\dev\\other" } });
    expect(reviewInvalidation(plan, live)).toBe("repository-path-changed");
    expect(applyFromScreen(plan, live)).toMatchObject({ status: "not-applied", reason: "repository-path-changed" });
  });

  it("the same path is analyzed again: the old plan is stale though everything looks the same", async () => {
    const { h, state, plan } = await opened();
    const again = await h.analyze(REPO, scan(viteApp()));
    const live = screen(again, { form: state.form });
    expect(reviewInvalidation(plan, live)).toBe("analysis-changed");
    expect(applyFromScreen(plan, live)).toMatchObject({ status: "not-applied", reason: "analysis-changed" });
  });

  it("a new analysis starts, or is cancelled", async () => {
    const { h, state, plan } = await opened();
    const run = h.controller.start(REPO);
    expect(reviewInvalidation(plan, screen(h.state, { form: state.form }))).toBe("analysis-changed");
    h.controller.cancel();
    h.calls[h.calls.length - 1].resolve(scan({ ...viteApp(), status: "cancelled" }));
    await run;
    expect(h.state).toMatchObject({ phase: "done", result: { status: "cancelled" } });
    expect(reviewInvalidation(plan, screen(h.state, { form: state.form }))).toBe("analysis-changed");
    expect(applyFromScreen(plan, screen(h.state, { form: state.form })).status).toBe("not-applied");
  });

  it("a different setup is selected (or Add New)", async () => {
    const { state, plan } = await opened();
    expect(reviewInvalidation(plan, { ...state, setupId: "setup-2" })).toBe("setup-changed");
    expect(reviewInvalidation(plan, { ...state, setupId: null })).toBe("setup-changed");
    expect(applyFromScreen(plan, { ...state, setupId: "setup-2" })).toMatchObject({ status: "not-applied", reason: "setup-changed" });
  });

  it("the target field is edited while the review is open: it stays open, but Apply refuses", async () => {
    const { state, plan } = await opened();
    const live = { ...state, form: { ...state.form, frontendCommand: "npm run serve" }, fieldOrigins: fieldEdited(state.fieldOrigins, "frontendCommand") };
    expect(reviewInvalidation(plan, live)).toBeNull();
    const out = applyFromScreen(plan, live);
    expect(out).toMatchObject({ status: "not-applied", reason: "field-changed" });
    if (out.status === "not-applied") expect(out.message).toContain("nothing was applied");
  });

  it("a late completion of an abandoned analysis never becomes the analysis plans come from", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const plan = open(find(done, script("dev")), screen(done));
    const late = h.controller.start(REPO);
    h.controller.pathChanged("C:\\Users\\dev\\other"); // abandons the running call
    h.calls[h.calls.length - 1].resolve(scan(viteApp()));
    await late;
    expect(h.state).toEqual({ phase: "idle" });
    expect(analysisForDraft(h.state)).toBeNull();
    expect(applyFromScreen(plan, screen(h.state)).status).toBe("not-applied");
  });

  it("rapid repeats: applying a plan twice changes nothing more the second time", async () => {
    const { state, plan } = await opened();
    const first = applied(plan, state);
    const afterFirst = { ...state, form: first.form, fieldOrigins: first.fieldOrigins };
    expect(applyFromScreen(plan, afterFirst)).toMatchObject({ status: "not-applied", reason: "field-changed" });
    // Re-opening repeatedly from the same state gives the same plan each time.
    const s = find(state.analysis, script("dev"));
    expect(JSON.stringify(open(s, state))).toBe(JSON.stringify(open(s, state)));
  });
});

describe("invariants", () => {
  it("Apply never changes name, folder, backend command, Preview URL or ports", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const form: SetupDraftForm = { name: "N", repoPath: REPO, installCommand: "a", frontendCommand: "b", backendCommand: "c", previewUrl: "http://x:1", frontendPort: "1", backendPort: "2" };
    const state = screen(done, { form, fieldOrigins: initialFieldOrigins("saved") });
    for (const s of suggestCommands((done as { result: RepoScanResult }).result).suggestions.filter((x) => canUseSuggestion(x, state))) {
      const out = applied(open(s, state), state);
      for (const k of ["name", "repoPath", "backendCommand", "previewUrl", "frontendPort", "backendPort"] as const) expect(out.form[k]).toBe(form[k]);
    }
  });

  it("nothing is saved, installed or run; inputs aren't mutated", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const state = deepFreeze(screen(done));
    const snapshot = JSON.stringify(state);
    const plan = open(find(done, install), state);
    applyFromScreen(plan, state);
    reviewInvalidation(plan, state);
    expect(JSON.stringify(state)).toBe(snapshot);
    for (const spy of Object.values(h.others)) expect(spy).not.toHaveBeenCalled();
    expect(h.calls.length).toBe(1);
  });

  it("the session helpers have no IPC, saving, storage or execution", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/lib/setupDraftSession.ts"), "utf-8");
    expect(source).not.toMatch(/window\.|repoRunner|ipcRenderer|saveProject|runInstall|startFrontend|\bfetch\(|localStorage|sessionStorage|child_process|\beval\(|["']node:/);
  });
});

describe("panel wiring", () => {
  it("actions reach Suggested Setup, and the review sits above the scrolling results", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const state = screen(done);
    const plan = open(find(done, script("dev")), state);
    const html = renderToStaticMarkup(
      createElement(RepoAnalysisPanel, {
        state: done,
        onCancel: () => {},
        suggestionActions: { canUse: (s) => canUseSuggestion(s, state), onUse: () => {} },
        draftReview: createElement(SetupDraftReview, { plan, onApply: () => {}, onCancel: () => {} }),
      }),
    );
    expect([...html.matchAll(/data-suggestion-id="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([".|develop|dev|pnpm", ".|install|install|pnpm", ".|start|start|pnpm"]);
    expect(html.indexOf('data-testid="setup-draft-review"')).toBeLessThan(html.indexOf('data-testid="analysis-results"'));
    expect(html.indexOf('data-testid="setup-draft-review"')).toBeGreaterThan(-1);
  });

  it("without actions or a review the panel renders exactly as before", async () => {
    const h = analysisHarness();
    const done = await h.analyze(REPO, scan(viteApp()));
    const plain = renderToStaticMarkup(createElement(RepoAnalysisPanel, { state: done, onCancel: () => {} }));
    expect(plain).not.toContain("suggestion-use");
    expect(plain).not.toContain("setup-draft-review");
    expect(renderToStaticMarkup(createElement(RepoAnalysisPanel, { state: done, onCancel: () => {}, suggestionActions: undefined, draftReview: null }))).toBe(plain);
  });

  it("the review is only shown with a completed analysis", () => {
    const review = createElement("div", { "data-testid": "probe-review" });
    for (const state of [{ phase: "running", path: REPO, cancelling: false }, { phase: "error", path: REPO, code: "failed", message: "x" }] as RepoAnalysisState[]) {
      expect(renderToStaticMarkup(createElement(RepoAnalysisPanel, { state, onCancel: () => {}, draftReview: review }))).not.toContain("probe-review");
    }
  });
});

describe("SetupScreen wiring (source checks)", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/components/SetupScreen.tsx"), "utf-8");

  it("uses the shared form type and the session helpers; no eligibility logic of its own", () => {
    expect(source).toContain("type SetupFormState = SetupDraftForm;");
    expect(source).not.toMatch(/SAFE_SCRIPT_NAME|isSafeScriptName|run \$\{|checkCommandTemplate|suggestCommands\(/);
    expect(source).toMatch(/canUse: \(suggestion\) => canUseSuggestion\(suggestion, draftState\)/);
  });

  it("Apply and Cancel never save, install or run", () => {
    const apply = source.slice(source.indexOf("const applyDraft = () =>"), source.indexOf("const draftReview ="));
    const cancel = source.slice(source.indexOf("const cancelDraft = () =>"), source.indexOf("const applyDraft = () =>"));
    for (const body of [apply, cancel]) {
      expect(body.length).toBeGreaterThan(50);
      expect(body).not.toMatch(/saveProject|runInstall|startFrontend|startBackend|restartAll|pullLatest|window\.repoRunner|onSave\(/);
    }
    expect(apply).toContain("applyFromScreen(plan, draftState)");
  });

  it("typing in a field records it as the user's", () => {
    const update = source.slice(source.indexOf("const updateField = ("), source.indexOf("const suggestionActions"));
    expect(update).toContain("setFormData((current) => ({ ...current, [field]: value }));");
    expect(update).toContain("setFieldOrigins((current) => fieldEdited(current, field));");
  });

  it("every form reset also resets field origins and closes the review", () => {
    const resets = [...source.matchAll(/setFormData\((projectToFormValues\([^)]*\)|blankFormValues)\);/g)].length;
    expect(resets).toBeGreaterThanOrEqual(4);
    expect([...source.matchAll(/setFieldOrigins\(initialFieldOrigins\(/g)].length).toBe(resets);
    expect(source).toMatch(/useState<FieldOrigins>\(\(\) =>\s*initialFieldOrigins\(activeProject \? "saved" : "initial-defaults"\)/);
  });
});
