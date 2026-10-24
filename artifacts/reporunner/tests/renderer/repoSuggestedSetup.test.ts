// Stage 2C: the read-only "Suggested Setup" section, rendered server-side.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "../../electron/repoScanner/scanRepository.js";
import { RepoAnalysisPanel } from "../../src/components/RepoAnalysisPanel";
import {
  INCOMPLETE_NOTICE,
  RepoSuggestedSetup,
  SAFETY_DETAIL,
  SAFETY_NOTICE,
  buildSuggestedSetupView,
} from "../../src/components/RepoSuggestedSetup";
import type { RepoScanResult } from "../../src/types";
import { FixtureSpace, pkg as filePkg } from "../electron/repoScanner/fixtures.js";
import { deepFreeze, pkg, scan, type ScanOptions } from "./insights/builders";

const render = (result: RepoScanResult) => renderToStaticMarkup(createElement(RepoSuggestedSetup, { result }));
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const commands = (html: string) => [...html.matchAll(/data-testid="suggestion-command"[^>]*>([^<]*)</g)].map((m) => m[1]);
const viewOf = (options: ScanOptions) => buildSuggestedSetupView(scan(options));

const viteApp = (path = "package.json", extra: Parameters<typeof pkg>[1] = {}) =>
  pkg(path, { name: "web", deps: ["react"], dev: ["vite"], scripts: { dev: "vite", build: "vite build" }, ...extra });

describe("safety messaging (always shown)", () => {
  it("states that nothing was run, tested or security-checked, and what confidence means", () => {
    const t = text(render(scan({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] })));
    expect(t).toContain(SAFETY_NOTICE);
    expect(t).toContain("Suggestions are based on repository files. Commands have not been run, tested or security-checked.");
    expect(t).toContain(SAFETY_DETAIL);
    expect(SAFETY_DETAIL).toMatch(/can run any command/);
    expect(SAFETY_DETAIL).toMatch(/installing can run project and dependency scripts/);
    expect(SAFETY_DETAIL).toMatch(/not whether a command is safe or will work/);
  });

  it("never calls a command safe, tested or working", () => {
    const html = render(scan({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] }));
    // The fixed safety sentence deliberately says "not whether a command is safe"; check everything else.
    expect(text(html).replace(SAFETY_DETAIL, "")).not.toMatch(/\b(is safe|safe to run|has been tested|tested and|verified to work|works)\b/i);
  });

  it("shows the notice even when nothing can be suggested", () => {
    const t = text(render(scan({ files: ["requirements.txt"] })));
    expect(t).toContain(SAFETY_NOTICE);
    expect(t).toContain("No setup suggestions could be made");
  });
});

describe("applications", () => {
  it("React + Vite: framework, directory, command, confidence, evidence and caveats", () => {
    const html = render(scan({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] }));
    const t = text(html);
    expect(commands(html)).toEqual(["pnpm run dev", "pnpm install"]);
    expect(t).toContain("React + Vite (high)");
    expect(t).toContain("repository root");
    expect(t).toContain("High confidence");
    expect(t).toContain("Why this suggestion?");
    expect(t).toContain(`Script "dev" starts React + Vite's development server`);
    expect(t).toContain("pnpm-lock.yaml is present");
    expect(t).toContain("The script runs: vite");
    expect(t).toContain("This runs a script defined by the repository, which can execute any command.");
  });

  it("Next.js frontend and an Express backend in a monorepo: separate cards with root-relative directories", () => {
    const html = render(scan({
      packages: [
        pkg("package.json", { workspaces: ["apps/*"] }),
        pkg("apps/web/package.json", { name: "web", deps: ["next", "react"], scripts: { dev: "next dev", start: "next start" } }),
        pkg("apps/api/package.json", { name: "api", deps: ["express"], scripts: { start: "node server.js" } }),
      ],
      files: ["pnpm-lock.yaml", "apps/web/next.config.mjs"],
    }));
    const dirs = [...html.matchAll(/data-testid="suggestion-app" data-directory="([^"]+)"/g)].map((m) => m[1]);
    expect(dirs).toEqual(["apps/web", "apps/api"]); // strongest evidence first
    expect(commands(html)).toEqual(["pnpm run dev", "pnpm run start", "pnpm run start", "pnpm install"]);
    const t = text(html);
    expect(t).toContain("Next.js (high)");
    expect(t).toContain("Express (high)");
    expect(t).not.toMatch(/\bcd\b/);
  });

  it("develop suggestions come before start within a package", () => {
    const view = viewOf({ packages: [pkg("package.json", { deps: ["express"], scripts: { start: "node a.js", dev: "nodemon a.js" } })], files: ["package-lock.json"] });
    expect(view.apps[0].runs.map((s) => s.scriptName)).toEqual(["dev", "start"]);
  });

  it("libraries and packages without run scripts are not shown as runnable; they're listed as not suggested", () => {
    const html = render(scan({ packages: [pkg("package.json", { deps: ["react"], dev: ["vite"], scripts: { build: "vite build" } })], files: ["package-lock.json"] }));
    expect(html).not.toContain('data-testid="suggestion-apps"');
    expect(text(html)).toContain("Not suggested (1)");
    expect(text(html)).toContain("defines no dev, start, serve, develop, start:dev or preview script");
  });

  it("many packages: the first six are shown, the rest behind an expander", () => {
    const packages = [pkg("package.json", { workspaces: ["p/*"] })];
    for (let i = 0; i < 9; i++) packages.push(pkg(`p/a${i}/package.json`, { name: `a${i}`, deps: ["express"], scripts: { start: "node i.js" } }));
    const html = render(scan({ packages, files: ["package-lock.json"] }));
    expect(text(html)).toContain("Show 3 more packages");
  });
});

describe("package managers", () => {
  it("conflicting evidence: each alternative is shown and qualified", () => {
    const html = render(scan({ packages: [viteApp()], files: ["package-lock.json", "yarn.lock", "vite.config.ts"] }));
    expect(commands(html)).toEqual(["npm run dev", "yarn run dev", "npm install", "yarn install"]);
    const t = text(html);
    expect(t).toContain("npm (one of several alternatives)");
    expect(t).toContain("Package-manager evidence conflicts; each alternative is shown.");
    expect(t).toContain("Low confidence: weak evidence");
    expect(t).not.toContain("High confidence");
  });

  it("unknown package manager: unresolved, no command, never npm", () => {
    const html = render(scan({ packages: [viteApp()], files: ["vite.config.ts"] }));
    expect(commands(html)).toEqual([]);
    const t = text(html);
    expect(t).toContain("No command: the package manager is unknown");
    expect(t).toContain("No confidence: no command");
    expect(t).not.toMatch(/npm (run|install)/);
  });
});

describe("orchestration and installs", () => {
  const monorepo = (): ScanOptions => ({
    packages: [
      pkg("package.json", { workspaces: ["apps/*"], scripts: { dev: "turbo run dev", postinstall: "husky" } }),
      viteApp("apps/web/package.json"),
      pkg("apps/api/package.json", { name: "api", deps: ["@nestjs/core"], scripts: { "start:dev": "nest start --watch" } }),
    ],
    files: ["pnpm-lock.yaml", "apps/web/vite.config.ts"],
  });

  it("root orchestration is its own subsection, separate from applications", () => {
    const view = viewOf(monorepo());
    expect(view.orchestration.map((s) => s.command)).toEqual(["pnpm run dev"]);
    expect(view.apps.map((a) => a.directory)).toEqual(["apps/api", "apps/web"]);
    const t = text(render(scan(monorepo())));
    expect(t).toContain("Run several packages at once (root scripts)");
    expect(t).toContain("Which packages they start isn't known.");
  });

  it("installs are a distinct subsection with their script warnings", () => {
    const html = render(scan(monorepo()));
    expect(html).toContain('data-testid="suggestion-installs"');
    const t = text(html);
    expect(t).toContain("Install dependencies");
    expect(t).toContain("Installing may run scripts this project defines: postinstall.");
    expect(t).toContain("Installing can also run scripts from dependencies.");
  });
});

describe("confidence levels and incomplete scans", () => {
  it("high, medium and low are each labelled", () => {
    const t = (options: ScanOptions) => text(render(scan(options)));
    expect(t({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] })).toContain("High confidence");
    expect(t({ packages: [pkg("package.json", { scripts: { start: "node a.js" } })], files: ["pnpm-lock.yaml"] })).toContain("Medium confidence");
    expect(t({ packages: [pkg("package.json", { scripts: { dev: "custom-thing" } })], files: ["pnpm-lock.yaml"] })).toContain("Low confidence: weak evidence");
  });

  it.each([["truncated", ["entries"]], ["cancelled", []], ["timed-out", ["time"]]] as const)("%s scan: flagged, never High", (status, limitsHit) => {
    const html = render(scan({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"], status, limitsHit: [...limitsHit] }));
    const t = text(html);
    expect(t).toContain(INCOMPLETE_NOTICE);
    expect(t).not.toContain("High confidence");
  });

  it("package-level truncation is noted on the card", () => {
    const t = text(render(scan({ packages: [viteApp("package.json", { scriptsTruncated: true, dependenciesTruncated: true })], files: ["pnpm-lock.yaml"] })));
    expect(t).toContain("Its script list was cut short");
    expect(t).toContain("Its dependency list was cut short");
  });

  it("a truncated suggestion list says so", () => {
    const packages = [pkg("package.json", { workspaces: ["p/*"] })];
    for (let i = 0; i < 200; i++) packages.push(pkg(`p/a${i}/package.json`, { deps: ["express"], scripts: { dev: "node a.js", start: "node b.js", serve: "node c.js" } }));
    expect(text(render(scan({ packages, files: ["package-lock.json", "yarn.lock"] })))).toContain("Only the first 300 suggestions are shown.");
  });
});

describe("unsupported, non-Node and unsafe input", () => {
  it("unsupported framework (Nuxt) and non-Node repositories explain why nothing runnable is suggested", () => {
    expect(text(render(scan({ packages: [pkg("package.json", { deps: ["nuxt"], scripts: { dev: "nuxt dev" } })], files: ["nuxt.config.ts", "package-lock.json"] })))).toContain(
      "Nuxt was recognized; RepoRunner doesn't suggest commands for it yet.",
    );
    expect(text(render(scan({ files: ["go.mod"] })))).toContain("Recognized Go project files; RepoRunner doesn't suggest commands for these yet.");
  });

  it("an unsafe script name yields no command and says why", () => {
    const html = render(scan({
      packages: [pkg("package.json", { workspaces: ["a/*"], scripts: { "dev:all && calc": "turbo run dev" } }), pkg("a/x/package.json", { deps: ["express"], scripts: { start: "node i.js" } })],
      files: ["pnpm-lock.yaml"],
    }));
    expect(text(html)).toContain("No command: the script name needs manual review");
    expect(commands(html).some((c) => c.includes("calc"))).toBe(false);
  });

  it("hostile names and script text render as inert text; no tags, links or handlers", () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const html = render(scan({
      packages: [pkg("package.json", { name: hostile, deps: ["express"], scripts: { start: `node a.js ${hostile}`, dev: `nodemon ${"x".repeat(3000)}` } })],
      files: ["package-lock.json"],
    }));
    expect(html).not.toMatch(/<(img|script|a|iframe)\b/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
    expect(html).not.toMatch(/<[^>]*\shref=/i);
    expect(text(html)).toContain(hostile);
  });

  it("offers no actions: no buttons, links, inputs or forms", () => {
    const html = render(scan({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] }));
    expect(html).not.toMatch(/<(button|a|input|textarea|select|form)\b/i);
    expect(text(html)).not.toMatch(/\b(Run|Apply|Save|Copy)\b/);
  });
});

describe("integration and purity", () => {
  it("the Analyze Repo panel shows Suggested Setup between the status and the existing details", () => {
    const result = scan({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] });
    const html = renderToStaticMarkup(createElement(RepoAnalysisPanel, { state: { phase: "done", path: "C:\\repo", result }, onCancel: () => {} }));
    const status = html.indexOf('data-testid="analysis-status"');
    const suggested = html.indexOf('data-testid="suggested-setup"');
    const details = html.indexOf("Package manager");
    expect(status).toBeGreaterThan(-1);
    expect(suggested).toBeGreaterThan(status);
    expect(details).toBeGreaterThan(suggested);
  });

  it("nothing is shown before or during analysis (stale-result rules unchanged)", () => {
    const idle = renderToStaticMarkup(createElement(RepoAnalysisPanel, { state: { phase: "idle" }, onCancel: () => {} }));
    const running = renderToStaticMarkup(createElement(RepoAnalysisPanel, { state: { phase: "running", path: "C:\\repo", cancelling: false }, onCancel: () => {} }));
    expect(idle).not.toContain("suggested-setup");
    expect(running).not.toContain("suggested-setup");
  });

  it("rendering doesn't modify the scan result and is deterministic", () => {
    const result = deepFreeze(scan({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] }));
    const before = JSON.stringify(result);
    const first = render(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(render(result)).toBe(first);
  });

  it("the component makes no scan, IPC, storage, network or Node calls", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/components/RepoSuggestedSetup.tsx"), "utf8");
    expect(source).not.toMatch(/repoRunner|ipcRenderer|window\.|localStorage|sessionStorage|\bfetch\(|XMLHttpRequest|WebSocket|dangerouslySetInnerHTML|innerHTML|require\(|import\(|["']node:|child_process|clipboard|href=/);
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../lib/insights/detectProjects", "../lib/insights/suggestCommands", "../lib/insights/types", "../types", "react"]);
  });
});

describe("from real scans", () => {
  let space: FixtureSpace;
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());

  it("a pnpm monorepo renders per-app, orchestration and install suggestions without secrets", async () => {
    const root = space.repo("2c monorepo", {
      "package.json": filePkg({ name: "mono", private: true, workspaces: ["apps/*"], packageManager: "pnpm@9.12.0", scripts: { dev: "turbo run dev" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "apps/web/package.json": filePkg({ name: "web", scripts: { dev: "vite" }, dependencies: { react: "^18" }, devDependencies: { vite: "^5" } }),
      "apps/web/vite.config.ts": "export default {}",
      "apps/api/package.json": filePkg({ name: "api", scripts: { start: "node server.js" }, dependencies: { express: "^4" } }),
      ".env": "SECRET=CANARY-2C-1",
    });
    const html = render(await scanRepository(root));
    expect(commands(html)).toEqual(["pnpm run dev", "pnpm run start", "pnpm run dev", "pnpm install"]);
    expect(html).not.toContain("CANARY-2C-1");
    expect(html).not.toContain(root);
  });
});
