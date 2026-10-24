// Stage 2A: framework, runtime, package-manager and runnability detection
// over RepoScanResult fixtures.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjects } from "../../../src/lib/insights/detectProjects";
import { commandSegments, invokedTool } from "../../../src/lib/insights/frameworkRules";
import type { Confidence, FrameworkId, PackageInsight, ProjectInsights } from "../../../src/lib/insights/types";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const only = (insights: ProjectInsights): PackageInsight => {
  expect(insights.packages).toHaveLength(1);
  return insights.packages[0];
};
const byDir = (insights: ProjectInsights, dir: string) => insights.packages.find((p) => p.directory === dir)!;
const ids = (p: PackageInsight) => p.frameworks.map((f) => f.id).sort();
const rank = (c: Confidence | null) => (c === null ? -1 : { low: 0, medium: 1, high: 2 }[c]);

describe("framework detection (table)", () => {
  const cases: Array<{
    label: string;
    scan: ScanOptions;
    frameworks: FrameworkId[];
    confidence: Confidence;
    role: PackageInsight["role"];
    runnable: PackageInsight["runnability"]["status"];
    supported?: boolean;
  }> = [
    {
      label: "React + Vite",
      scan: { packages: [pkg("package.json", { deps: ["react", "react-dom"], dev: ["vite", "@vitejs/plugin-react"], scripts: { dev: "vite", build: "vite build" } })], files: ["vite.config.ts"] },
      frameworks: ["react-vite"], confidence: "high", role: "frontend", runnable: "has-run-script",
    },
    {
      label: "Vue + Vite",
      scan: { packages: [pkg("package.json", { deps: ["vue"], dev: ["vite", "@vitejs/plugin-vue"], scripts: { dev: "vite" } })], files: ["vite.config.js"] },
      frameworks: ["vue-vite"], confidence: "high", role: "frontend", runnable: "has-run-script",
    },
    {
      label: "Svelte + Vite",
      scan: { packages: [pkg("package.json", { dev: ["svelte", "vite", "@sveltejs/vite-plugin-svelte"], scripts: { dev: "vite" } })] },
      frameworks: ["svelte-vite"], confidence: "high", role: "frontend", runnable: "has-run-script",
    },
    {
      label: "SvelteKit (reported instead of Svelte + Vite)",
      scan: { packages: [pkg("package.json", { dev: ["@sveltejs/kit", "svelte", "vite"], scripts: { dev: "vite dev" } })], files: ["svelte.config.js", "vite.config.ts"] },
      frameworks: ["sveltekit"], confidence: "high", role: "fullstack", runnable: "has-run-script",
    },
    {
      label: "Next.js",
      scan: { packages: [pkg("package.json", { deps: ["next", "react", "react-dom"], scripts: { dev: "next dev", start: "next start" } })], files: ["next.config.mjs"] },
      frameworks: ["nextjs"], confidence: "high", role: "fullstack", runnable: "has-run-script",
    },
    {
      label: "Angular",
      scan: { packages: [pkg("package.json", { deps: ["@angular/core", "@angular/common"], dev: ["@angular/cli"], scripts: { start: "ng serve" } })], files: ["angular.json"] },
      frameworks: ["angular"], confidence: "high", role: "frontend", runnable: "has-run-script",
    },
    {
      label: "Express (runtime dependency is direct evidence)",
      scan: { packages: [pkg("package.json", { deps: ["express"], scripts: { start: "node server.js" } })] },
      frameworks: ["express"], confidence: "high", role: "backend", runnable: "has-run-script",
    },
    {
      label: "Fastify",
      scan: { packages: [pkg("package.json", { deps: ["fastify"], scripts: { dev: "fastify start -w app.js" } })] },
      frameworks: ["fastify"], confidence: "high", role: "backend", runnable: "has-run-script",
    },
    {
      label: "NestJS",
      scan: { packages: [pkg("package.json", { deps: ["@nestjs/core", "@nestjs/common"], dev: ["@nestjs/cli"], scripts: { "start:dev": "nest start --watch" } })] },
      frameworks: ["nestjs"], confidence: "high", role: "backend", runnable: "has-run-script",
    },
    {
      label: "Nuxt (recognized, no suggestions yet)",
      scan: { packages: [pkg("package.json", { deps: ["nuxt", "vue"], dev: ["vite"], scripts: { dev: "nuxt dev" } })], files: ["nuxt.config.ts"] },
      frameworks: ["nuxt"], confidence: "high", role: "fullstack", runnable: "has-run-script", supported: false,
    },
    {
      label: "Astro (recognized, no suggestions yet)",
      scan: { packages: [pkg("package.json", { deps: ["astro"], scripts: { dev: "astro dev" } })], files: ["astro.config.mjs"] },
      frameworks: ["astro"], confidence: "high", role: "frontend", runnable: "has-run-script", supported: false,
    },
    {
      label: "Remix on Vite (reported instead of React + Vite)",
      scan: { packages: [pkg("package.json", { deps: ["@remix-run/react", "react"], dev: ["@remix-run/dev", "vite"], scripts: { dev: "remix vite:dev" } })], files: ["vite.config.ts"] },
      frameworks: ["remix"], confidence: "high", role: "fullstack", runnable: "has-run-script", supported: false,
    },
  ];

  it.each(cases)("$label", ({ scan: options, frameworks, confidence, role, runnable, supported }) => {
    const insight = only(detectProjects(scan(options)));
    expect(ids(insight)).toEqual([...frameworks].sort());
    for (const framework of insight.frameworks) {
      expect(framework.confidence).toBe(confidence);
      expect(framework.evidence.length).toBeGreaterThan(0);
      expect(framework.suggestionsSupported).toBe(supported ?? true);
    }
    expect(insight.role).toBe(role);
    expect(insight.runnability.status).toBe(runnable);
  });

  it("generic Node app: no framework, a run script that starts node", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { scripts: { start: "node index.js" } })] })));
    expect(insight.frameworks).toEqual([]);
    expect(insight.role).toBe("node-app");
    expect(insight.runnability).toMatchObject({ status: "has-run-script", runScripts: ["start"], confidence: "medium" });
    expect(insight.runtimes.find((r) => r.runtime === "node")?.confidence).toBe("high");
  });

  it("several frameworks in one package are all reported, none chosen", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { deps: ["next", "react", "express"], scripts: { dev: "node server.js" } })] })));
    expect(ids(insight)).toEqual(["express", "nextjs"]);
    expect(insight.uncertainties).toContain("multiple-frameworks");
    expect(insight.role).toBe("fullstack");
  });

  it("frontend and backend frameworks in one package: role 'mixed'", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { deps: ["react", "express"], dev: ["vite"], scripts: { dev: "vite" } })] })));
    expect(ids(insight)).toEqual(["express", "react-vite"]);
    expect(insight.role).toBe("mixed");
  });

  it("a React component library without run scripts is a library, not runnable", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { dev: ["react", "vite"], scripts: { build: "vite build", test: "vitest" } })] })));
    expect(ids(insight)).toEqual(["react-vite"]);
    expect(insight.runnability).toMatchObject({ status: "no-run-script", runScripts: [] });
    expect(insight.role).toBe("library");
  });

  it("Express without a start script: framework found, not runnable, still backend", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { deps: ["express"], scripts: { test: "jest" } })] })));
    expect(ids(insight)).toEqual(["express"]);
    expect(insight.runnability.status).toBe("no-run-script");
    expect(insight.role).toBe("backend");
  });

  it("dependency-only evidence without a corroborating file or script is medium", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { deps: ["react"], dev: ["vite"] })] })));
    expect(insight.frameworks[0]).toMatchObject({ id: "react-vite", confidence: "medium" });
  });

  it("a devDependency-only backend library isn't direct evidence (medium)", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { dev: ["express"] })] })));
    expect(insight.frameworks[0]).toMatchObject({ id: "express", confidence: "medium" });
  });

  it("indirect evidence only (config file or tool script without the dependency) is low and says so", () => {
    const viaConfig = only(detectProjects(scan({ packages: [pkg("package.json")], files: ["next.config.js"] })));
    expect(viaConfig.frameworks[0]).toMatchObject({ id: "nextjs", confidence: "low" });
    expect(viaConfig.frameworks[0].uncertainties).toContain("indirect-evidence-only");
    expect(viaConfig.frameworks[0].evidence.some((e) => e.kind === "absence")).toBe(true);
    const viaScript = only(detectProjects(scan({ packages: [pkg("package.json", { scripts: { dev: "next dev" } })] })));
    expect(viaScript.frameworks[0]).toMatchObject({ id: "nextjs", confidence: "low" });
  });

  it("vite.config alone doesn't name a framework", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { scripts: { dev: "vite" } })], files: ["vite.config.ts"] })));
    expect(insight.frameworks).toEqual([]);
  });

  it("script matching uses exact tokens, never substrings", () => {
    for (const command of ["echo next dev", "./node_modules/.bin/next-ish dev", "nextjs dev", "previte", "devite", "run-ng serve", "\"next\" dev", "next"]) {
      const insight = only(detectProjects(scan({ packages: [pkg("package.json", { scripts: { dev: command } })] })));
      expect(insight.frameworks, command).toEqual([]);
    }
    expect(invokedTool("cross-env NODE_ENV=dev next dev", [{ tool: "next", subcommands: ["dev"] }])).not.toBeNull();
    expect(invokedTool("npm run build && next start", [{ tool: "next", subcommands: ["start"] }])).not.toBeNull();
    expect(commandSegments("a && b || c; d | e & f").map((t) => t[0])).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("runnability", () => {
  it("lists only candidate scripts that exist, in preference order; never invents names", () => {
    const scripts = { preview: "vite preview", start: "node a.js", "start:dev": "node b.js", dev: "vite", build: "vite build", "dev:watch": "x", Dev: "x", " dev": "x" };
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { scripts })] })));
    expect(insight.runnability.runScripts).toEqual(["dev", "start", "start:dev", "preview"]);
    for (const name of insight.runnability.runScripts) expect(Object.keys(scripts)).toContain(name);
  });

  it("a run script name alone is weak (low); invoking a known tool raises it", () => {
    expect(only(detectProjects(scan({ packages: [pkg("package.json", { scripts: { dev: "turbo-like-thing" } })] }))).runnability.confidence).toBe("low");
    expect(only(detectProjects(scan({ packages: [pkg("package.json", { scripts: { dev: "nodemon src/index.js" } })] }))).runnability.confidence).toBe("medium");
  });

  it("only a preview script stays low", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { dev: ["react", "vite"], scripts: { preview: "vite preview" } })], files: ["vite.config.ts"] })));
    expect(insight.runnability).toMatchObject({ status: "has-run-script", runScripts: ["preview"], confidence: "low" });
  });

  it("truncated scripts can't prove a run script is absent", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { deps: ["react"], dev: ["vite"], scripts: { build: "x" }, scriptsTruncated: true })] })));
    expect(insight.runnability).toMatchObject({ status: "unknown", confidence: null });
    expect(insight.runnability.uncertainties).toContain("scripts-truncated");
    expect(insight.role).not.toBe("library");
  });

  it("truncated scripts with a run script present cap runnability at medium", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { deps: ["next"], scripts: { dev: "next dev" }, scriptsTruncated: true })], files: ["next.config.js"] })));
    expect(insight.runnability.confidence).toBe("medium");
  });

  it("evidence never repeats script command text (it stays passive data)", () => {
    const canary = "CANARY-SCRIPT-TEXT-9f1";
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { deps: ["express"], scripts: { start: `node server.js --token=${canary}`, dev: `echo ${canary}` } })] })));
    expect(JSON.stringify(insight)).not.toContain(canary);
  });
});

describe("package manager", () => {
  const pm = (options: ScanOptions, dir = ".") => byDir(detectProjects(scan(options)), dir).packageManager;

  it("one lockfile: single, high", () => {
    expect(pm({ packages: [pkg("package.json")], files: ["pnpm-lock.yaml"] })).toMatchObject({ status: "single", confidence: "high", candidates: [{ manager: "pnpm" }] });
  });

  it("conflicting lockfiles: both kept, none chosen", () => {
    const result = pm({ packages: [pkg("package.json")], files: ["package-lock.json", "yarn.lock"] });
    expect(result.status).toBe("conflict");
    expect(result.confidence).toBe("low");
    expect(result.candidates.map((c) => c.manager).sort()).toEqual(["npm", "yarn"]);
    expect(result.uncertainties).toContain("package-manager-conflict");
  });

  it("packageManager field disagreeing with the lockfile is a conflict", () => {
    const result = pm({ packages: [pkg("package.json", { packageManager: "pnpm@9.1.0" })], files: ["package-lock.json"] });
    expect(result.status).toBe("conflict");
    expect(result.candidates.map((c) => c.manager).sort()).toEqual(["npm", "pnpm"]);
  });

  it("field and lockfile agreeing: single, both pieces of evidence", () => {
    const result = pm({ packages: [pkg("package.json", { packageManager: "yarn@4.1.0" })], files: ["yarn.lock"] });
    expect(result).toMatchObject({ status: "single", confidence: "high" });
    expect(result.candidates[0].evidence.map((e) => e.kind).sort()).toEqual(["lockfile", "package-manager-field"]);
  });

  it("field only: medium", () => {
    expect(pm({ packages: [pkg("package.json", { packageManager: "bun@1.1.0" })] })).toMatchObject({ status: "single", confidence: "medium" });
  });

  it("nearest folder with a lockfile wins over the root", () => {
    const options: ScanOptions = {
      packages: [pkg("package.json"), pkg("apps/web/package.json"), pkg("apps/legacy/package.json")],
      files: ["pnpm-lock.yaml", "apps/legacy/yarn.lock"],
    };
    expect(pm(options, "apps/web")).toMatchObject({ status: "single", candidates: [{ manager: "pnpm" }] });
    expect(pm(options, "apps/web").candidates[0].evidence[0].text).toContain("parent folder");
    expect(pm(options, "apps/legacy")).toMatchObject({ status: "single", candidates: [{ manager: "yarn" }] });
  });

  it("no evidence: unknown; npm is never assumed", () => {
    const result = pm({ packages: [pkg("package.json")] });
    expect(result).toEqual({ status: "unknown", candidates: [], confidence: null, uncertainties: ["package-manager-unknown"] });
  });

  it("an unrecognized packageManager field is reported, not trusted", () => {
    const result = pm({ packages: [pkg("package.json", { packageManager: "foo@1.0.0" })] });
    expect(result.status).toBe("unknown");
    expect(result.uncertainties).toContain("unrecognized-package-manager-field");
  });

  it("pnpm-workspace.yaml alone is weak evidence (low)", () => {
    expect(pm({ packages: [pkg("package.json")], files: ["pnpm-workspace.yaml"] })).toMatchObject({ status: "single", confidence: "low", candidates: [{ manager: "pnpm" }] });
  });

  it("when lockfiles may have been dropped from the result, confidence is capped and flagged", () => {
    const result = pm({ packages: [pkg("package.json")], files: ["pnpm-lock.yaml"], limitsHit: ["result-size"], status: "truncated" });
    expect(result.confidence).toBe("medium");
    expect(result.uncertainties).toContain("lockfiles-may-be-missing");
  });

  it("possibly-missing lockfiles cap confidence even if a result claims to be complete (inconsistent input)", () => {
    const result = pm({ packages: [pkg("package.json")], files: ["pnpm-lock.yaml"], manifestsTruncated: true });
    expect(result.confidence).toBe("medium");
    expect(result.uncertainties).toContain("lockfiles-may-be-missing");
  });

  it("bun lockfile also signals the Bun runtime", () => {
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { scripts: { dev: "bun run index.ts" } })], files: ["bun.lockb"] })));
    expect(insight.runtimes.find((r) => r.runtime === "bun")?.confidence).toBe("high");
  });
});

describe("monorepos and repository kind", () => {
  const monorepo = (): ScanOptions => ({
    packages: [
      pkg("package.json", { workspaces: ["apps/*", "packages/*"], dev: ["turbo"], scripts: { dev: "turbo run dev", build: "turbo run build" } }),
      pkg("apps/web/package.json", { deps: ["react"], dev: ["vite"], scripts: { dev: "vite" } }),
      pkg("apps/api/package.json", { deps: ["express"], scripts: { dev: "nodemon src/index.js", start: "node dist/index.js" } }),
      pkg("packages/ui/package.json", { deps: ["react"], dev: ["vite"], scripts: { build: "vite build" } }),
    ],
    files: ["turbo.json", "pnpm-lock.yaml", "apps/web/vite.config.ts"],
  });

  it("frontend and backend packages, workspace root, orchestration", () => {
    const insights = detectProjects(scan(monorepo()));
    expect(insights.kind).toBe("monorepo");
    expect(byDir(insights, ".").role).toBe("workspace-root");
    expect(byDir(insights, "apps/web")).toMatchObject({ role: "frontend", runnability: { status: "has-run-script" } });
    expect(byDir(insights, "apps/api")).toMatchObject({ role: "backend", runnability: { runScripts: ["dev", "start"] } });
    expect(byDir(insights, "packages/ui").role).toBe("library");
    expect(insights.orchestration.map((o) => [o.scriptName, o.tool])).toEqual([["dev", "turbo"], ["build", "turbo"]]);
    expect(byDir(insights, "apps/api").packageManager.candidates.map((c) => c.manager)).toEqual(["pnpm"]);
  });

  it("config files apply only to the package in their own folder", () => {
    const insights = detectProjects(scan(monorepo()));
    expect(byDir(insights, "apps/web").frameworks[0]).toMatchObject({ id: "react-vite", confidence: "high" });
    // packages/ui has no vite.config of its own and no script invoking vite as a dev server.
    const ui = byDir(insights, "packages/ui").frameworks[0];
    expect(ui.evidence.some((e) => e.kind === "config-file")).toBe(false);
    // A root config doesn't corroborate a nested package.
    const rootConfigOnly = detectProjects(scan({ packages: [pkg("package.json"), pkg("apps/x/package.json", { deps: ["react"], dev: ["vite"] })], files: ["vite.config.ts"] }));
    expect(byDir(rootConfigOnly, "apps/x").frameworks[0].confidence).toBe("medium");
  });

  it.each([
    ["pnpm -r --parallel run dev", "pnpm-recursive"],
    ["pnpm --filter web dev", "pnpm-recursive"],
    ["npm run dev --workspaces", "npm-workspaces"],
    ["nx run-many -t serve", "nx"],
    ["lerna run dev", "lerna"],
    ["concurrently \"npm:dev:*\"", "concurrently"],
    ["yarn workspaces foreach run dev", "yarn-workspaces"],
  ])("root orchestration: %s -> %s", (command, tool) => {
    const insights = detectProjects(scan({ packages: [pkg("package.json", { workspaces: ["a/*"], scripts: { dev: command } }), pkg("a/b/package.json")] }));
    expect(insights.orchestration.map((o) => o.tool)).toEqual([tool]);
  });

  it("several packages without workspace configuration: multi-package", () => {
    const insights = detectProjects(scan({ packages: [pkg("client/package.json", { scripts: { start: "node a.js" } }), pkg("server/package.json")] }));
    expect(insights.kind).toBe("multi-package");
    expect(insights.packages.map((p) => p.role)).not.toContain("workspace-root");
  });

  it("single package", () => {
    expect(detectProjects(scan({ packages: [pkg("package.json")] })).kind).toBe("single-package");
  });

  it("non-Node repository: recognized ecosystems, no packages", () => {
    const insights = detectProjects(scan({ files: ["requirements.txt", "pyproject.toml", "Dockerfile"] }));
    expect(insights).toMatchObject({ kind: "non-node", packages: [], otherEcosystems: ["Python"] });
    expect(insights.kindEvidence.length).toBeGreaterThan(0);
  });

  it("mixed repository keeps both: Node packages and other ecosystems", () => {
    const insights = detectProjects(scan({ packages: [pkg("web/package.json")], files: ["go.mod"] }));
    expect(insights.otherEcosystems).toEqual(["Go"]);
    expect(insights.packages).toHaveLength(1);
  });

  it("malformed manifest: no packages, kind unknown, flagged", () => {
    const insights = detectProjects(scan({ files: ["package.json"], warnings: [{ code: "manifest-malformed", path: "package.json" }] }));
    expect(insights).toMatchObject({ kind: "unknown", packages: [] });
    expect(insights.uncertainties).toContain("unreadable-manifests");
  });

  it("workspace patterns are text only: nothing is derived from them", () => {
    const insights = detectProjects(scan({ packages: [pkg("package.json", { workspaces: ["../outside/*", "C:\\Windows\\*"] })] }));
    expect(insights.packages.map((p) => p.directory)).toEqual(["."]);
    expect(JSON.stringify(insights)).not.toContain("outside");
  });
});

describe("incomplete scans and truncation", () => {
  const strong = (): ScanOptions => ({
    packages: [pkg("package.json", { deps: ["next", "react"], scripts: { dev: "next dev" } })],
    files: ["next.config.js", "pnpm-lock.yaml"],
  });

  it.each([
    ["truncated", ["entries"]],
    ["cancelled", []],
    ["timed-out", ["time"]],
  ] as const)("a %s scan caps every conclusion at medium and says why", (status, limitsHit) => {
    const insights = detectProjects(scan({ ...strong(), status, limitsHit: [...limitsHit] }));
    expect(insights.scanComplete).toBe(false);
    expect(insights.uncertainties).toContain("scan-incomplete");
    if (status === "cancelled") expect(insights.uncertainties).toContain("scan-cancelled");
    if (status === "timed-out") expect(insights.uncertainties).toContain("scan-timed-out");
    const insight = only(insights);
    expect(insight.frameworks[0].confidence).toBe("medium");
    expect(rank(insight.packageManager.confidence)).toBeLessThanOrEqual(1);
    expect(rank(insight.runnability.confidence)).toBeLessThanOrEqual(1);
    for (const runtime of insight.runtimes) expect(rank(runtime.confidence)).toBeLessThanOrEqual(1);
  });

  it("the same scan when complete reaches high (the cap is what lowered it)", () => {
    const insight = only(detectProjects(scan(strong())));
    expect(insight.frameworks[0].confidence).toBe("high");
    expect(insight.packageManager.confidence).toBe("high");
    expect(insight.runnability.confidence).toBe("high");
  });

  it("truncated dependency names cap at medium and missing names mean unknown, not absent", () => {
    const capped = only(detectProjects(scan({ packages: [pkg("package.json", { deps: ["next"], scripts: { dev: "next dev" }, dependenciesTruncated: true })], files: ["next.config.js"] })));
    expect(capped.frameworks[0].confidence).toBe("medium");
    expect(capped.uncertainties).toContain("dependencies-truncated");
    const configOnly = only(detectProjects(scan({ packages: [pkg("package.json", { dependenciesTruncated: true })], files: ["next.config.js"] })));
    expect(configOnly.frameworks[0].evidence.some((e) => e.kind === "absence")).toBe(false); // can't claim "not listed"
    expect(configOnly.frameworks[0].uncertainties).toContain("dependencies-truncated");
  });

  it("truncated package and project-file lists are flagged at repository level", () => {
    const insights = detectProjects(scan({ packages: [pkg("package.json")], packagesTruncated: true, manifestsTruncated: true, limitsHit: ["result-size"], status: "truncated" }));
    expect(insights.uncertainties).toEqual(expect.arrayContaining(["packages-incomplete", "project-files-incomplete", "lockfiles-may-be-missing"]));
  });

  it("every framework and package-manager candidate carries evidence", () => {
    const insights = detectProjects(scan({
      packages: [
        pkg("package.json", { workspaces: ["*"], packageManager: "pnpm@9" }),
        pkg("a/package.json", { deps: ["express", "next", "react"], dev: ["vite"], scripts: { dev: "next dev" } }),
        pkg("b/package.json", { dev: ["@angular/core"] }),
      ],
      files: ["pnpm-lock.yaml", "yarn.lock", "a/next.config.js", "b/angular.json"],
    }));
    for (const p of insights.packages) {
      for (const f of p.frameworks) expect(f.evidence.length, `${p.directory} ${f.id}`).toBeGreaterThan(0);
      for (const c of p.packageManager.candidates) expect(c.evidence.length).toBeGreaterThan(0);
      for (const r of p.runtimes) expect(r.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("untrusted data, purity and determinism", () => {
  it("hostile script and package names are kept as inert data and never become run scripts", () => {
    const hostile = { "<script>alert(1)</script>": "x", "dev; rm -rf /": "x", "start && calc": "x", "../../dev": "x", "dev\u0000": "x" };
    const insight = only(detectProjects(scan({ packages: [pkg("package.json", { name: "<img src=x onerror=alert(1)>", scripts: hostile })] })));
    expect(insight.runnability).toMatchObject({ status: "no-run-script", runScripts: [] });
    expect(insight.name).toBe("<img src=x onerror=alert(1)>"); // passed through as data; rendering is plain text
  });

  it("does not modify its input (deep-frozen) and is deterministic and order-independent", () => {
    const options: ScanOptions = {
      packages: [
        pkg("package.json", { workspaces: ["apps/*"], scripts: { dev: "turbo run dev" } }),
        pkg("apps/web/package.json", { deps: ["react"], dev: ["vite"], scripts: { dev: "vite" } }),
        pkg("apps/api/package.json", { deps: ["express"], scripts: { start: "node index.js" } }),
      ],
      files: ["pnpm-lock.yaml", "apps/web/vite.config.ts"],
    };
    const input = deepFreeze(scan(options));
    const before = JSON.stringify(input);
    const first = detectProjects(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(detectProjects(input)).toEqual(first);
    const reversed = scan({ ...options, packages: [...options.packages!].reverse(), files: [...options.files!].reverse() });
    expect(detectProjects(reversed)).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("the insights modules import only each other and types; no filesystem, network, IPC, storage or execution", () => {
    const dir = path.resolve(import.meta.dirname, "../../../src/lib/insights");
    for (const file of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)) {
        const [, typeOnly, spec] = match;
        if (spec === "../../types") expect(typeOnly, `${file}: ${spec} must be type-only`).toBe("type ");
        else expect(spec.startsWith("./"), `${file}: ${spec}`).toBe(true);
      }
      expect(source, file).not.toMatch(/\brequire\(|import\(|\beval\(|new Function|new RegExp|\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|ipcRenderer|window\.|child_process|["']node:/);
    }
  });
});
