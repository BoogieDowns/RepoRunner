// What the Analyze Repo panel renders, via server-side rendering (no DOM).
// Includes real scanner output from a fixture with canary secrets.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "../../electron/repoScanner/scanRepository.js";
import { AnalyzeRepoButton, LOCAL_ANALYSIS_NOTE, RepoAnalysisPanel } from "../../src/components/RepoAnalysisPanel";
import { MAX_DEPENDENCIES_SHOWN, summarizeStatus, type RepoAnalysisState } from "../../src/lib/repoAnalysis";
import { REPO_ANALYSIS_ERROR_MESSAGES, type RepoScanResult } from "../../src/types";
import { FixtureSpace, pkg } from "../electron/repoScanner/fixtures.js";

const CANARY = "CANARY-UI-SECRET-51d2";
let space: FixtureSpace;
beforeAll(() => {
  space = new FixtureSpace();
});
afterAll(() => space.cleanup());

const render = (state: RepoAnalysisState) => renderToStaticMarkup(createElement(RepoAnalysisPanel, { state, onCancel: () => {} }));
const done = (result: RepoScanResult): RepoAnalysisState => ({ phase: "done", path: "C:\\repo", result });
/** Visible text only (tags removed, entities decoded). */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

function base(overrides: Partial<RepoScanResult> = {}): RepoScanResult {
  return {
    status: "complete",
    partial: false,
    limitsHit: [],
    rootName: "app",
    stats: { directoriesVisited: 3, entriesExamined: 10, filesRead: 2, bytesRead: 100, durationMs: 4 },
    manifests: [],
    manifestsTruncated: false,
    packages: [],
    packagesTruncated: false,
    nodeVersionFiles: [],
    workspace: { signals: [], patterns: [], patternsTruncated: false },
    packageManager: { lockfiles: [], declared: null },
    envFiles: [],
    envFilesTruncated: false,
    skipped: { links: 0, excludedDirectories: 0, sensitiveFiles: 0, depthLimited: 0, unreadable: 0, oversized: 0, otherTypes: 0, changedDuringScan: 0 },
    warnings: [],
    warningsTruncated: false,
    ...overrides,
  };
}

describe("Analyze Repo button", () => {
  it("is enabled, disabled and shows progress as told", () => {
    const enabled = renderToStaticMarkup(createElement(AnalyzeRepoButton, { disabled: false, running: false, onClick: () => {} }));
    const disabled = renderToStaticMarkup(createElement(AnalyzeRepoButton, { disabled: true, running: false, onClick: () => {} }));
    const running = renderToStaticMarkup(createElement(AnalyzeRepoButton, { disabled: true, running: true, onClick: () => {} }));
    expect(enabled).toContain("Analyze Repo");
    expect(enabled).toContain('type="button"'); // never submits the Setup form
    expect(enabled).not.toContain('disabled=""');
    expect(disabled).toContain('disabled=""');
    expect(running).toContain("Analyzing...");
  });
});

describe("panel states", () => {
  it("renders nothing before any analysis", () => {
    expect(render({ phase: "idle" })).toBe("");
  });

  it("loading: progress text, accessible Cancel, busy region and the local-only note", () => {
    const html = render({ phase: "running", path: "C:\\repo", cancelling: false });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Analyzing repository...");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-testid="analysis-cancel"[^>]*>.*Cancel analysis/);
    expect(html).toContain(LOCAL_ANALYSIS_NOTE);
    const cancelling = render({ phase: "running", path: "C:\\repo", cancelling: true });
    expect(cancelling).toContain("Cancelling...");
    expect(cancelling).toMatch(/data-testid="analysis-cancel"[^>]*disabled=""|disabled=""[^>]*data-testid="analysis-cancel"/);
  });

  it("errors show only the fixed message", () => {
    const html = render({ phase: "error", path: "C:\\repo", code: "root-not-allowed", message: REPO_ANALYSIS_ERROR_MESSAGES["root-not-allowed"] });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(REPO_ANALYSIS_ERROR_MESSAGES["root-not-allowed"]);
    expect(html).not.toContain("C:\\repo");
  });
});

describe("results", () => {
  it("shows the complete result: name, status, package manager, workspace, node version, packages and scripts", () => {
    const html = render(
      done(
        base({
          rootName: "mono repo",
          manifests: [
            { path: "package.json", kind: "package-json" },
            { path: "pnpm-workspace.yaml", kind: "workspace-config" },
            { path: "apps/web/vite.config.ts", kind: "framework-config" },
          ],
          packages: [
            {
              path: "package.json", name: "mono", version: "1.0.0", private: true, packageManager: "pnpm@9.1.0",
              engines: { node: ">=20" }, scripts: [{ name: "dev", command: "turbo run dev" }], scriptsTruncated: false,
              dependencies: [], devDependencies: ["turbo"], dependenciesTruncated: false, workspaces: ["apps/*"],
            },
            {
              path: "apps/web/package.json", name: "web", version: null, private: null, packageManager: null,
              engines: { node: null }, scripts: [{ name: "build", command: "vite build" }], scriptsTruncated: false,
              dependencies: ["react"], devDependencies: [], dependenciesTruncated: false, workspaces: [],
            },
          ],
          workspace: { signals: ["pnpm-workspace", "turbo"], patterns: ["apps/*"] },
          packageManager: { lockfiles: [{ path: "pnpm-lock.yaml", manager: "pnpm" }], declared: "pnpm@9.1.0" },
          nodeVersionFiles: [{ path: ".nvmrc", version: "20" }],
        }),
      ),
    );
    const t = text(html);
    for (const expected of [
      "Analysis complete", "mono repo", "declared pnpm@9.1.0 · lockfile: pnpm", "pnpm-lock.yaml", "pnpm-workspace, turbo", "apps/*",
      ".nvmrc: 20", "Packages (2)", "mono", "1.0.0", "apps/web/package.json", "dev", "turbo run dev", "vite build", "react",
      "shown for reference, not run", "apps/web/vite.config.ts", "packageManager: pnpm@9.1.0", "node: >=20",
    ]) {
      expect(t, expected).toContain(expected);
    }
    expect(html).toMatch(/<details open=""[^>]*data-testid="analysis-package"/); // first package expanded
    expect(html).toContain("max-h-[360px] overflow-y-auto"); // long results scroll
  });

  it("offers no actions on results: no buttons, links, forms or inputs", () => {
    const html = render(done(base({ packages: [{ path: "package.json", name: "x", version: null, private: null, packageManager: null, engines: { node: null }, scripts: [{ name: "start", command: "node server.js" }], scriptsTruncated: false, dependencies: [], devDependencies: [], dependenciesTruncated: false, workspaces: [] }] })));
    expect(html).not.toMatch(/<(button|a|form|input|textarea|select)\b/);
    expect(html).not.toMatch(/<[^>]*\s(href|on[a-z]+)=/i);
  });

  it("limits long dependency lists and says how many are hidden", () => {
    const deps = Array.from({ length: 60 }, (_, i) => `dep-${i}`);
    const html = render(done(base({ packages: [{ path: "package.json", name: "x", version: null, private: null, packageManager: null, engines: { node: null }, scripts: [], scriptsTruncated: false, dependencies: deps, devDependencies: [], dependenciesTruncated: true, workspaces: [] }] })));
    const t = text(html);
    expect(t).toContain("Dependencies (60+)");
    expect(t).toContain(`+${60 - MAX_DEPENDENCIES_SHOWN} more`);
    expect(t).toContain(`dep-${MAX_DEPENDENCIES_SHOWN - 1}`);
    expect(t).not.toContain(`dep-${MAX_DEPENDENCIES_SHOWN} `);
  });

  it("renders hostile strings as inert text", () => {
    const hostile = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      '"><svg onload=alert(1)>',
      "javascript:alert(1)",
      "[click me](javascript:alert(1))",
      "**bold** <b>bold</b>",
    ];
    const html = render(
      done(
        base({
          rootName: hostile[0],
          packages: [{
            path: hostile[1], name: hostile[2], version: hostile[3], private: null, packageManager: hostile[4],
            engines: { node: hostile[5] }, scripts: hostile.map((command, i) => ({ name: `s${i}${hostile[i]}`, command })),
            scriptsTruncated: false, dependencies: hostile, devDependencies: [], dependenciesTruncated: false, workspaces: hostile,
          }],
          workspace: { signals: [], patterns: hostile },
          envFiles: [".env<script>"],
        }),
      ),
    );
    // Real tags start with a literal "<"; a "<" in text is always escaped.
    expect(html).not.toMatch(/<(script|img|svg|b)\b/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
    expect(html).not.toMatch(/<a\b|<[^>]*\shref=/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    for (const value of hostile) expect(text(html)).toContain(value); // shown verbatim, as text
  });

  it.each([
    ["truncated", base({ status: "truncated", partial: true, limitsHit: ["entries", "result-size"] }), "Partial results", ["Results limited for a large repository (file count).", "Some details were left out to keep the results small."]],
    ["cancelled", base({ status: "cancelled", partial: true }), "Analysis cancelled", ["Results are incomplete."]],
    ["timed-out", base({ status: "timed-out", partial: true, limitsHit: ["time"] }), "Analysis timed out", ["Results are incomplete."]],
    ["unanalyzed files or folders", base({ status: "truncated", partial: true, skipped: { links: 2, excludedDirectories: 0, sensitiveFiles: 0, depthLimited: 0, unreadable: 1, oversized: 1, otherTypes: 0, changedDuringScan: 1 } }), "Partial results", ["Some files or folders could not be analyzed (3).", "2 linked folders or files were not followed."]],
    ["workspace patterns cut", base({ status: "truncated", partial: true, workspace: { signals: ["npm-workspaces"], patterns: ["apps/*"], patternsTruncated: true } }), "Partial results", ["Not all workspace patterns are listed."]],
  ])("%s results are labelled clearly", (_label, result, title, notes) => {
    const t = text(render(done(result)));
    expect(t).toContain(title);
    for (const note of notes) expect(t).toContain(note);
    if (result.status !== "complete") expect(t).not.toContain("Analysis complete");
  });

  it("never presents an incomplete status as complete", () => {
    for (const status of ["truncated", "cancelled", "timed-out"] as const) {
      expect(summarizeStatus(base({ status, partial: true })).title).not.toMatch(/complete/i);
      expect(summarizeStatus(base({ status, partial: true })).tone).not.toBe("ok");
    }
  });

  it("real scanner output: env file names shown, contents never; warnings shown by fixed text", async () => {
    const root = space.repo("ui fixture", {
      "package.json": pkg({ name: "ui-app", scripts: { dev: "vite" } }),
      "broken/package.json": `{ "token": "${CANARY}"`,
      ".env": `API_KEY=${CANARY}`,
      ".env.local": `SECRET=${CANARY}`,
      "id_rsa": CANARY,
      ".npmrc": `//registry/:_authToken=${CANARY}`,
    });
    const scanned = await scanRepository(root);
    const html = render(done(scanned));
    const t = text(html);
    expect(t).toContain(".env");
    expect(t).toContain(".env.local");
    expect(t).toContain("Names only. Their contents are never opened.");
    expect(t).toMatch(/broken\/package\.json\s*: package\.json is not valid JSON/);
    expect(html).not.toContain(CANARY);
    expect(html).not.toContain(root);
  });
});

describe("source safety of the Analyze Repo UI", () => {
  it("uses no raw HTML, network, IPC, Node or storage access", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(import.meta.dirname, "../../src");
    for (const file of ["components/RepoAnalysisPanel.tsx", "lib/repoAnalysis.ts", "components/SetupScreen.tsx"]) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|\beval\(|new Function|\bfetch\(|XMLHttpRequest|WebSocket|ipcRenderer|require\(|["']node:|child_process|localStorage|sessionStorage/);
    }
    const lib = fs.readFileSync(path.join(dir, "lib/repoAnalysis.ts"), "utf8");
    expect([...lib.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["../types"]);
  });
});
