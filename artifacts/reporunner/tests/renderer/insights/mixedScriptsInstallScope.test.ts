// PR #76 second Codex pass: (1) a script that invokes an unsupported framework
// anywhere is withheld, even when it also starts a supported one; (2) a parent
// lockfile is package-manager evidence, not install scope: only confirmed
// workspace membership puts a nested package under a parent's install.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { unsupportedInvocations } from "../../../src/lib/insights/frameworkRules";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../../src/lib/insights/types";
import { workspaceMembership } from "../../../src/lib/insights/workspaceMembership";
import { FixtureSpace, pkg as filePkg } from "../../electron/repoScanner/fixtures.js";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const runs = (options: ScanOptions) => suggestCommands(scan(options)).suggestions.filter((s) => s.source === "script");
const installs = (options: ScanOptions) => suggestCommands(scan(options)).suggestions.filter((s) => s.source === "install");
const codes = (s: CommandSuggestion) => s.caveats.map((c) => c.code);
const text = (s: CommandSuggestion) => [...s.evidence.map((e) => e.text), ...s.caveats.map((c) => c.text)].join(" ");

describe("P2: every invocation is checked for unsupported frameworks", () => {
  const viteAstro = (scripts: Record<string, string>, deps = ["react", "astro"]): ScanOptions => ({
    packages: [pkg("package.json", { deps, dev: ["vite"], scripts })],
    files: ["package-lock.json", "vite.config.ts"],
  });

  it.each(["vite & astro dev", "vite && astro dev", "astro dev && vite", "vite | astro dev", "vite; astro dev", "vite || astro dev"])(
    'dev: "%s" is withheld, naming Astro',
    (command) => {
      const options = viteAstro({ dev: command });
      expect(runs(options)).toEqual([]);
      expect(suggestCommands(scan(options)).skipped).toContainEqual(
        expect.objectContaining({ reason: "unsupported-framework", text: 'Script "dev" in package.json runs Astro, which RepoRunner doesn\'t suggest commands for yet.' }),
      );
    },
  );

  it("withheld even when Astro wasn't detected from dependencies (the script still runs it)", () => {
    expect(runs(viteAstro({ dev: "vite & astro dev" }, ["react"]))).toEqual([]);
  });

  it("a normal supported invocation, and several supported ones, are still suggested", () => {
    expect(runs(viteAstro({ dev: "vite" }))[0]).toMatchObject({ command: "npm run dev", confidence: "high" });
    expect(runs(viteAstro({ dev: "vite & node server.js" }))[0]).toMatchObject({ command: "npm run dev", confidence: "high" });
  });

  it("an unsupported invocation mixed with a Node runner is withheld (any subcommand)", () => {
    const options: ScanOptions = { packages: [pkg("package.json", { deps: ["express", "nuxt"], scripts: { start: "nuxt build && node .output/server/index.mjs" } })], files: ["package-lock.json"] };
    expect(runs(options)).toEqual([]);
    expect(suggestCommands(scan(options)).skipped[0].text).toContain("runs Nuxt");
  });

  it("an unsupported script doesn't suppress a separate supported script", () => {
    expect(runs(viteAstro({ dev: "astro dev", start: "node server.js" })).map((s) => s.scriptName)).toEqual(["start"]);
  });

  it("echo astro dev only mentions Astro; it doesn't launch it", () => {
    expect(unsupportedInvocations("echo astro dev && vite")).toEqual([]);
    expect(runs(viteAstro({ dev: "echo astro dev && vite" }))[0]).toMatchObject({ command: "npm run dev", confidence: "high" });
  });

  it("unknown shell wrappers stay conservative: never high", () => {
    for (const command of ['sh -c "astro dev"', "bash -lc astro", "dotenv -e .env -- astro dev"]) {
      for (const s of runs(viteAstro({ dev: command }))) expect(s.confidence).toBe("low");
    }
  });

  it("confidence never rises because an unsupported invocation is hidden: no script with one is ever suggested", () => {
    const tails = ["astro dev", "astro build", "nuxt dev", "nuxi dev", "remix vite:dev", "npx astro dev", "cross-env X=1 nuxt dev"];
    for (const tail of tails) {
      for (const command of [`vite & ${tail}`, `${tail} && vite`, `node a.js; ${tail}`]) {
        expect(runs(viteAstro({ dev: command })), command).toEqual([]);
      }
    }
  });

  it("names every unsupported framework the script runs", () => {
    expect(unsupportedInvocations("astro dev & nuxt dev & astro build").map((u) => u.label)).toEqual(["Astro", "Nuxt"]);
  });
});

describe("workspaceMembership", () => {
  const root = (workspaces: string[], extra: Partial<ReturnType<typeof pkg>> = {}) => ({ ...pkg("package.json", { workspaces }), ...extra });
  const member = (workspaces: string[], dir: string, files: string[] = [], options: Partial<ScanOptions> = {}, extra = {}) =>
    workspaceMembership(scan({ packages: [root(workspaces, extra), pkg(`${dir}/package.json`)], files, ...options }), ".", dir);

  it.each<[string[], string, string]>([
    [["apps/*"], "apps/web", "member"],
    [["./apps/*/"], "apps/web", "member"],
    [["packages/**"], "packages/a/b", "member"],
    [["apps/app-*"], "apps/app-web", "member"],
    [["tools/cli"], "tools/cli", "member"],
    [["apps/*"], "apps/web/nested", "not-member"],
    [["apps/*"], "tools/cli", "not-member"],
    [[], "tools/cli", "not-member"],
    [["{apps,libs}/*"], "apps/web", "unknown"],
    [["apps/[a-z]*"], "apps/web", "unknown"],
    [["apps/*", "!apps/legacy"], "apps/web", "unknown"],
  ])("%j / %s -> %s", (workspaces, dir, status) => {
    expect(member(workspaces, dir).status).toBe(status);
  });

  it("an unsupported pattern is never read as an exclusion, and makes the whole list unverified", () => {
    // The unsupported pattern could be an exclusion, so even a supported match isn't confirmed.
    expect(member(["{apps,libs}/*", "tools/*"], "tools/cli")).toEqual({ status: "unknown", reason: "pattern-unsupported" });
    expect(member(["{apps,libs}/*"], "tools/cli")).toEqual({ status: "unknown", reason: "pattern-unsupported" });
  });

  it("workspace files RepoRunner doesn't read make a non-match unknown (pnpm-workspace.yaml, lerna.json, rush.json); turbo/nx don't", () => {
    for (const file of ["pnpm-workspace.yaml", "lerna.json", "rush.json"]) expect(member([], "apps/web", [file])).toEqual({ status: "unknown", reason: "workspace-file-unread" });
    for (const file of ["turbo.json", "nx.json"]) expect(member([], "apps/web", [file]).status).toBe("not-member");
  });

  it("truncated patterns and incomplete scans make a non-match unknown, never an exclusion", () => {
    expect(member(["apps/*"], "tools/cli", [], {}, { workspacesTruncated: true })).toEqual({ status: "unknown", reason: "patterns-truncated" });
    expect(member([], "tools/cli", [], { status: "truncated", limitsHit: ["entries"] })).toEqual({ status: "unknown", reason: "scan-incomplete" });
    expect(member([], "tools/cli", [], { manifestsTruncated: true }).status).toBe("unknown");
    expect(member([], "tools/cli", [], { packagesTruncated: true }).status).toBe("unknown");
  });

  it("folder names alone never establish membership", () => {
    expect(member([], "packages/ui").status).toBe("not-member");
    expect(member([], "apps/web").status).toBe("not-member");
  });
});

describe("P2: install scope", () => {
  const app = (dir: string) => pkg(dir === "." ? "package.json" : `${dir}/package.json`, { deps: ["express"], scripts: { start: "node i.js" } });
  const pairs = (options: ScanOptions) => installs(options).map((s) => [s.directory, s.command, s.confidence]);

  it("a single package installs from the root (unchanged)", () => {
    expect(pairs({ packages: [app(".")], files: ["package-lock.json"] })).toEqual([[".", "npm install", "high"]]);
  });

  it("a confirmed workspace installs once at the root, with no duplicate member installs", () => {
    const options: ScanOptions = { packages: [pkg("package.json", { workspaces: ["apps/*"] }), app("apps/a"), app("apps/b"), app("apps/c")], files: ["package-lock.json"] };
    expect(pairs(options)).toEqual([[".", "npm install", "high"]]);
    expect(text(installs(options)[0])).toContain('4 packages share this install root: 3 matched by the "workspaces" patterns in package.json');
  });

  it("Codex case: an independent nested package under a root lockfile gets its own install, and the root install doesn't claim it", () => {
    const options: ScanOptions = { packages: [app("."), app("apps/api")], files: ["package-lock.json"] };
    expect(pairs(options)).toEqual([
      [".", "npm install", "high"],
      ["apps/api", "npm install", "medium"],
    ]);
    const [rootInstall, nested] = installs(options);
    expect(text(rootInstall)).not.toMatch(/apps\/api|share this install root/);
    expect(codes(nested)).toEqual(expect.arrayContaining(["independent-package", "no-lockfile-here"]));
    expect(text(nested)).toContain("package.json declares no workspaces, so installing at the repository root doesn't install apps/api");
    expect(nested.evidence.some((e) => e.kind === "lockfile" && e.text.includes("package-lock.json"))).toBe(true); // still package-manager evidence
  });

  it("a nested package outside the workspaces patterns is independent", () => {
    const options: ScanOptions = { packages: [pkg("package.json", { workspaces: ["apps/*"] }), app("apps/a"), app("tools/cli")], files: ["package-lock.json"] };
    expect(pairs(options)).toEqual([
      [".", "npm install", "high"],
      ["tools/cli", "npm install", "medium"],
    ]);
    expect(text(installs(options)[1])).toContain('tools/cli doesn\'t match the "workspaces" patterns in package.json');
  });

  it("a nested package with its own lockfile keeps its own install root, without an independence caveat", () => {
    const options: ScanOptions = { packages: [app("."), app("legacy")], files: ["package-lock.json", "legacy/yarn.lock"] };
    expect(pairs(options)).toEqual([
      [".", "npm install", "high"],
      ["legacy", "yarn install", "high"],
    ]);
    expect(codes(installs(options)[1])).not.toContain("independent-package");
  });

  it("several independent nested packages each get their own install", () => {
    expect(pairs({ packages: [app("."), app("a"), app("b/c"), app("d")], files: ["pnpm-lock.yaml"] }).map(([d]) => d)).toEqual([".", "a", "b/c", "d"]);
  });

  it("a deeper workspace pattern matches nested paths", () => {
    expect(pairs({ packages: [pkg("package.json", { workspaces: ["packages/**"] }), app("packages/a/b")], files: ["package-lock.json"] })).toEqual([[".", "npm install", "high"]]);
  });

  it("unsupported patterns or an unread workspace file: separate, low, qualified install; the root says so too", () => {
    for (const options of [
      { packages: [pkg("package.json", { workspaces: ["{apps,libs}/*"] }), app("apps/a")], files: ["package-lock.json"] },
      { packages: [pkg("package.json"), app("apps/a")], files: ["pnpm-lock.yaml", "pnpm-workspace.yaml"] },
    ] satisfies ScanOptions[]) {
      const [rootInstall, nested] = installs(options);
      expect([nested.directory, nested.confidence]).toEqual(["apps/a", "low"]);
      expect(codes(nested)).toContain("workspace-membership-unknown");
      expect(text(nested)).toMatch(/If it is, installing at the repository root already covers it; if not, it needs this separate install/);
      expect(codes(rootInstall)).toContain("members-unconfirmed");
      expect(text(rootInstall)).not.toContain("share this install root");
    }
  });

  it("partial or truncated workspace evidence: unknown, never independent", () => {
    const truncated = { ...pkg("package.json", { workspaces: ["apps/*"] }), workspacesTruncated: true };
    for (const options of [
      { packages: [truncated, app("tools/cli")], files: ["package-lock.json"] },
      { packages: [app("."), app("tools/cli")], files: ["package-lock.json"], status: "truncated" as const, limitsHit: ["entries" as const] },
    ] satisfies ScanOptions[]) {
      const nested = installs(options).find((s) => s.directory === "tools/cli")!;
      expect(codes(nested)).toContain("workspace-membership-unknown");
      expect(codes(nested)).not.toContain("independent-package");
      expect(nested.confidence).toBe("low");
    }
  });

  it("conflicting package managers: every alternative, ambiguous, at most low, for the nested install too", () => {
    const nested = installs({ packages: [app("."), app("tools/cli")], files: ["package-lock.json", "yarn.lock"] }).filter((s) => s.directory === "tools/cli");
    expect(nested.map((s) => s.command).sort()).toEqual(["npm install", "yarn install"]);
    for (const s of nested) expect([s.packageManagerAmbiguous, s.confidence]).toEqual([true, "low"]);
  });

  it("unknown package manager: unresolved, never npm, for the nested install too", () => {
    const nested = installs({ packages: [app("."), app("tools/cli")] }).filter((s) => s.directory === "tools/cli");
    expect(nested.map((s) => [s.command, s.unavailableReason])).toEqual([[null, "package-manager-unknown"]]);
    expect(codes(nested[0])).not.toContain("no-lockfile-here"); // there's no parent lockfile to speak of
  });

  it("pure: inputs untouched, deterministic, commands only from fixed templates", () => {
    const result = deepFreeze(scan({ packages: [pkg("package.json", { workspaces: ["apps/*", "{x,y}"] }), app("apps/a"), app("tools/cli"), app("z")], files: ["package-lock.json"] }));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(suggestCommands(result)).toEqual(first);
    for (const s of first.suggestions) if (s.command) expect(s.command).toMatch(/^npm (install|run start)$/);
  });
});

describe("install scope from real scans", () => {
  let space: FixtureSpace;
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());

  it("root lockfile + independent nested package (no workspaces): two installs, the nested one qualified", async () => {
    const root = space.repo("independent nested", {
      "package.json": filePkg({ name: "site", scripts: { start: "node server.js" }, dependencies: { express: "^4" } }),
      "package-lock.json": "{}",
      "apps/api/package.json": filePkg({ name: "api", scripts: { start: "node index.js" }, dependencies: { fastify: "^4" } }),
    });
    const set = suggestCommands(await scanRepository(root));
    const list = set.suggestions.filter((s) => s.source === "install");
    expect(list.map((s) => [s.directory, s.command, s.confidence])).toEqual([
      [".", "npm install", "high"],
      ["apps/api", "npm install", "medium"],
    ]);
    expect(codes(list[1])).toContain("independent-package");
  });

  it("pnpm-workspace.yaml only (unread): nested installs are qualified, never merged or declared independent", async () => {
    const root = space.repo("pnpm yaml only", {
      "package.json": filePkg({ name: "mono", private: true }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/web/package.json": filePkg({ name: "web", scripts: { dev: "vite" }, devDependencies: { vite: "^5" }, dependencies: { react: "^18" } }),
    });
    const set = suggestCommands(await scanRepository(root));
    const list = set.suggestions.filter((s) => s.source === "install");
    expect(list.map((s) => [s.directory, s.command, s.confidence])).toEqual([
      [".", "pnpm install", "high"],
      ["apps/web", "pnpm install", "low"],
    ]);
    expect(codes(list[0])).toContain("members-unconfirmed");
    expect(codes(list[1])).toContain("workspace-membership-unknown");
  });

  it('a mixed "vite & astro dev" script from a real scan is withheld', async () => {
    const root = space.repo("vite astro", {
      "package.json": filePkg({ name: "x", scripts: { dev: "vite & astro dev", start: "node server.js" }, dependencies: { react: "^18", astro: "^4" }, devDependencies: { vite: "^5" } }),
      "package-lock.json": "{}",
    });
    const set = suggestCommands(await scanRepository(root));
    expect(set.suggestions.filter((s) => s.source === "script").map((s) => s.scriptName)).toEqual(["start"]);
    expect(set.skipped.map((s) => s.reason)).toContain("unsupported-framework");
  });
});
