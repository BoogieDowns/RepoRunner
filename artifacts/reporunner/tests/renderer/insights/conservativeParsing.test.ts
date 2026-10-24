// PR #76 Codex findings: (1) whether a workspace wildcard covers a hidden
// folder depends on the package manager (npm's glob doesn't), so such a match
// is unknown, never a confirmed membership and never a definite "not a member";
// (2) inside quotes, &&, | or ; aren't separators and words aren't programs,
// so a command that uses quotes or escapes isn't classified at all.
import { describe, expect, it } from "vitest";
import { detectProjects } from "../../../src/lib/insights/detectProjects";
import { classifyScript, commandSegments, invokedTool, leadingWords, unsupportedInvocations } from "../../../src/lib/insights/frameworkRules";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../../src/lib/insights/types";
import { MATCH_STATE_BUDGET, matchSegments, workspaceMembership } from "../../../src/lib/insights/workspaceMembership";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const app = (dir: string) => pkg(`${dir}/package.json`, { deps: ["express"], scripts: { start: "node i.js" } });
const ws = (workspaces: string[], dir: string, extra: Partial<ScanOptions> = {}): ScanOptions => ({
  packages: [pkg("package.json", { workspaces }), app(dir)],
  files: ["package-lock.json"],
  ...extra,
});
const member = (workspaces: string[], dir: string, budget?: number) => workspaceMembership(scan(ws(workspaces, dir)), ".", dir, budget);
const installs = (options: ScanOptions) => suggestCommands(scan(options)).suggestions.filter((s) => s.source === "install");
const rows = (list: CommandSuggestion[]) => list.map((s) => [s.directory, s.command, s.confidence]);
const at = (list: CommandSuggestion[], dir: string) => list.find((s) => s.directory === dir)!;
const codes = (s: CommandSuggestion) => s.caveats.map((c) => c.code);
const text = (s: CommandSuggestion) => [...s.evidence.map((e) => e.text), ...s.caveats.map((c) => c.text)].join(" ");
const HIDDEN = { status: "unknown", reason: "hidden-folder-wildcard" };

describe("hidden folders and workspace wildcards", () => {
  it("packages/* doesn't confirm packages/.web, and doesn't rule it out either", () => {
    expect(member(["packages/*"], "packages/.web")).toEqual(HIDDEN);
    expect(member(["packages/*"], "packages/web")).toEqual({ status: "member", pattern: "packages/*" });
  });

  it('"**" reaching a hidden folder at any depth is uncertain; visible ones still match', () => {
    expect(member(["packages/**"], "packages/.web")).toEqual(HIDDEN);
    expect(member(["packages/**"], "packages/.tools/web")).toEqual(HIDDEN);
    expect(member(["packages/**"], "packages/a/.b/web")).toEqual(HIDDEN);
    expect(member(["**/web"], ".tools/web")).toEqual(HIDDEN);
    expect(member(["*/web"], ".tools/web")).toEqual(HIDDEN);
    expect(member(["packages/**"], "packages/a/b/web")).toEqual({ status: "member", pattern: "packages/**" });
    expect(member(["packages/*/*"], "packages/a.b/web")).toEqual({ status: "member", pattern: "packages/*/*" }); // a dot inside a name isn't hidden
  });

  it("a pattern that names the hidden folder itself matches it as written", () => {
    expect(member(["packages/.web"], "packages/.web")).toEqual({ status: "member", pattern: "packages/.web" });
    expect(member(["packages/.*"], "packages/.web")).toEqual({ status: "member", pattern: "packages/.*" });
    expect(member([".tools/*"], ".tools/web")).toEqual({ status: "member", pattern: ".tools/*" });
    expect(member(["packages/.web/**"], "packages/.web/a")).toEqual({ status: "member", pattern: "packages/.web/**" });
    // A literal hidden segment doesn't vouch for a wildcard over another hidden one.
    expect(member([".tools/*"], ".tools/.web")).toEqual(HIDDEN);
  });

  it("another pattern that matches it plainly confirms membership, in either order", () => {
    expect(member(["packages/*", "packages/.web"], "packages/.web")).toEqual({ status: "member", pattern: "packages/.web" });
    expect(member(["packages/.web", "packages/*"], "packages/.web")).toEqual({ status: "member", pattern: "packages/.web" });
    // A plain match within the same "**" pattern wins over a hidden one.
    expect(matchSegments(["**", "web"], [".a", "web"], { remaining: MATCH_STATE_BUDGET })).toBe("hidden-uncertain");
    expect(matchSegments(["a", "**"], ["a"], { remaining: MATCH_STATE_BUDGET })).toBe("match");
  });

  it("with several patterns, an uncertain one keeps the answer unknown rather than not-a-member", () => {
    expect(member(["apps/*", "packages/*"], "packages/.web")).toEqual(HIDDEN);
    expect(member(["packages/*", "apps/*"], "packages/.web")).toEqual(HIDDEN);
    // No wildcard reaches it: a definite no, as before.
    expect(member(["apps/*"], "packages/.web")).toEqual({ status: "not-member", reason: "no-pattern-matches" });
    expect(member(["packages/*/x"], "packages/.web")).toEqual({ status: "not-member", reason: "no-pattern-matches" });
  });

  it("the rest of the gate still applies first: unsupported syntax, exclusions, budget", () => {
    expect(member(["packages/{a,.web}"], "packages/.web")).toEqual({ status: "unknown", reason: "pattern-unsupported" });
    expect(member(["packages/.web", "!packages/x"], "packages/.web")).toEqual({ status: "unknown", reason: "negated-pattern" });
    expect(member(["packages/*", "!packages/x"], "packages/.web")).toEqual(HIDDEN);
    expect(member(["**/**/**/web"], ".a/.b/.c/.d/.e/.f/.g/web", 5)).toEqual({ status: "unknown", reason: "match-budget-exceeded" });
  });

  it("matching work is unchanged: each state once, within the same budget", () => {
    const count = (pattern: string[], path: string[]) => {
      const budget = { remaining: MATCH_STATE_BUDGET };
      const outcome = matchSegments(pattern, path, budget);
      return { outcome, used: MATCH_STATE_BUDGET - budget.remaining };
    };
    const visible = count(["**", "**", "**", "zz"], ["a", "b", "c", "d", "e", "f", "g", "h"]);
    const hidden = count(["**", "**", "**", "zz"], [".a", ".b", ".c", ".d", ".e", ".f", ".g", ".h"]);
    expect(hidden.used).toBe(visible.used);
    expect(hidden.used).toBeLessThanOrEqual(5 * 9);
    expect(count(["**", "**", "**", "zz"], [".a", "b"], ).outcome).toBe("no-match");
  });

  it("agrees with a direct reference on random patterns over hidden and visible names", () => {
    // Reference: a match with dot-skipping wildcards is a match; failing that, a match that needs them is uncertain.
    const ref = (p: readonly string[], n: readonly string[], dot: boolean): boolean => {
      if (p.length === 0) return n.length === 0;
      const seg = (pat: string, name: string) => {
        if (!dot && name.startsWith(".") && !pat.startsWith(".") && pat.includes("*")) return false;
        const re = new RegExp(`^${pat.split("*").map((x) => x.replace(/\./g, "\\.")).join("[^/]*")}$`);
        return re.test(name);
      };
      if (p[0] === "**") return ref(p.slice(1), n, dot) || (n.length > 0 && (dot || !n[0].startsWith(".")) && ref(p, n.slice(1), dot));
      return n.length > 0 && seg(p[0], n[0]) && ref(p.slice(1), n.slice(1), dot);
    };
    let seed = 29;
    const next = (k: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
    const segments = ["a", ".a", "*", ".*", "a*", "*a", "**"];
    const names = ["a", ".a", "aa", ".aa", "ba"];
    for (let t = 0; t < 3000; t++) {
      const p = Array.from({ length: 1 + next(5) }, () => segments[next(segments.length)]);
      const n = Array.from({ length: 1 + next(5) }, () => names[next(names.length)]);
      const expected = ref(p, n, false) ? "match" : ref(p, n, true) ? "hidden-uncertain" : "no-match";
      expect(matchSegments(p, n, { remaining: MATCH_STATE_BUDGET }), `${p.join("/")} vs ${n.join("/")}`).toBe(expected);
    }
  });

  it("install suggestions: the root doesn't claim the hidden package, which keeps its own Low install", () => {
    const list = installs(ws(["packages/*"], "packages/.web"));
    expect(rows(list)).toEqual([
      [".", "npm install", "high"],
      ["packages/.web", "npm install", "low"],
    ]);
    expect(codes(at(list, "packages/.web"))).toContain("workspace-membership-unknown");
    expect(text(at(list, "packages/.web"))).toContain("hidden folder");
    expect(text(at(list, "."))).not.toContain("share this install root");
    // Named explicitly: one install, as before.
    expect(rows(installs(ws(["packages/.web"], "packages/.web")))).toEqual([[".", "npm install", "high"]]);
    expect(rows(installs(ws(["packages/*"], "packages/web")))).toEqual([[".", "npm install", "high"]]);
  });

  it("nested workspaces: a hidden nested root is unknown to the top root; its own members stay direct", () => {
    const options: ScanOptions = {
      packages: [pkg("package.json", { workspaces: ["packages/*"] }), pkg("packages/.mono/package.json", { workspaces: ["apps/*"] }), app("packages/.mono/apps/web")],
      files: ["package-lock.json"],
    };
    const result = scan(options);
    expect(workspaceMembership(result, ".", "packages/.mono")).toEqual(HIDDEN);
    expect(workspaceMembership(result, "packages/.mono", "packages/.mono/apps/web")).toEqual({ status: "member", pattern: "apps/*" });
    // Membership is direct: packages/* doesn't reach apps/web through packages/.mono.
    expect(workspaceMembership(result, ".", "packages/.mono/apps/web")).toEqual({ status: "not-member", reason: "no-pattern-matches" });
    const list = installs(options);
    expect(list.map((s) => s.directory)).not.toContain("packages/.mono/apps/web");
    expect(at(list, "packages/.mono").confidence).toBe("low");
    expect(text(at(list, "."))).not.toContain("share this install root");
  });
});

describe("quoted commands are not classified", () => {
  const viteApp = (scripts: Record<string, string>): ScanOptions => ({
    packages: [pkg("package.json", { deps: ["react"], dev: ["vite"], scripts })],
    files: ["package-lock.json", "vite.config.ts"],
  });
  const nextApp = (scripts: Record<string, string>): ScanOptions => ({ packages: [pkg("package.json", { deps: ["next", "react"], scripts })], files: ["package-lock.json", "next.config.mjs"] });
  const expressApp = (scripts: Record<string, string>): ScanOptions => ({ packages: [pkg("package.json", { deps: ["express"], scripts })], files: ["package-lock.json"] });
  const runs = (options: ScanOptions) => suggestCommands(scan(options)).suggestions.filter((s) => s.source === "script");
  const insight = (options: ScanOptions) => detectProjects(scan(options)).packages[0];
  const UNCLASSIFIED = { kind: null, frameworkId: null, tool: null, quoting: true };

  it('echo "ready && vite --host" doesn\'t start Vite: Low, explained, not High', () => {
    const command = 'echo "ready && vite --host"';
    expect(classifyScript(command, ["react-vite"])).toEqual(UNCLASSIFIED);
    const [run] = runs(viteApp({ dev: command }));
    expect([run.command, run.confidence]).toEqual(["npm run dev", "low"]);
    expect(run.scriptCommandText).toBe(command); // shown as written
    expect(text(run)).toContain("uses quotes or escapes");
    expect(text(run)).not.toContain("development server");
    expect(insight(viteApp({ dev: command })).runnability).toMatchObject({ status: "has-run-script", confidence: "low" });
  });

  it.each(["&&", "||", "|", ";", "&"])("a quoted %s is not a separator", (sep) => {
    for (const command of [`echo "x ${sep} vite"`, `echo 'x ${sep} next dev'`, `echo "x${sep}astro dev"`]) {
      expect(commandSegments(command), command).toEqual([]);
      expect(classifyScript(command, ["react-vite", "nextjs", "astro"]), command).toEqual(UNCLASSIFIED);
      expect(unsupportedInvocations(command), command).toEqual([]);
    }
  });

  it("single quotes, backticks and backslash escapes are treated the same", () => {
    for (const command of ["echo 'a && next dev'", "echo `next dev`", "echo \\&\\& next dev", "next dev --hostname 'localhost'"]) {
      expect(classifyScript(command, ["nextjs"]), command).toEqual(UNCLASSIFIED);
      expect(runs(nextApp({ dev: command }))[0].confidence, command).toBe("low");
    }
  });

  it('echo "astro dev" is not withheld as Astro: suggested at Low', () => {
    const options = expressApp({ dev: 'echo "astro dev"' });
    const set = suggestCommands(scan(options));
    expect(set.skipped.map((s) => s.reason)).not.toContain("unsupported-framework");
    expect(set.suggestions.filter((s) => s.source === "script").map((s) => [s.scriptName, s.confidence])).toEqual([["dev", "low"]]);
    // Nor is Astro identified from it.
    expect(insight(options).frameworks.map((f) => f.id)).toEqual(["express"]);
  });

  it("unquoted vite dev and next dev are unchanged: High", () => {
    expect(runs(viteApp({ dev: "vite dev" }))[0].confidence).toBe("high");
    expect(runs(viteApp({ dev: "vite" }))[0].confidence).toBe("high");
    expect(runs(nextApp({ dev: "next dev" }))[0].confidence).toBe("high");
    expect(runs(nextApp({ dev: "cross-env NODE_ENV=development next dev" }))[0].confidence).toBe("high");
    expect(classifyScript("echo ready && vite --host", ["react-vite"])).toEqual({ kind: "develop", frameworkId: "react-vite", tool: "vite" }); // real separator
  });

  it("quotes anywhere in a complex command leave the whole command unclassified", () => {
    for (const command of ['cross-env NODE_ENV=development vite --host "0.0.0.0"', 'tsc && node "dist/index.js"', 'vite "build"', 'nodemon --exec "ts-node src/index.ts"']) {
      expect(classifyScript(command, ["react-vite"]), command).toEqual(UNCLASSIFIED);
      expect(invokedTool(command, [{ tool: "vite" }, { tool: "node" }, { tool: "nodemon" }]), command).toBeNull();
    }
    // vite "build" doesn't build-only exclude the script either: it stays a Low candidate.
    expect(insight(viteApp({ dev: 'vite "build"' })).runnability).toMatchObject({ runScripts: ["dev"], buildOnlyScripts: [], confidence: "low" });
  });

  it("unknown wrappers stay unclassified, quoted or not", () => {
    expect(classifyScript("my-wrapper vite", ["react-vite"]).kind).toBeNull();
    expect(classifyScript('my-wrapper "vite"', ["react-vite"])).toEqual(UNCLASSIFIED);
    expect(runs(viteApp({ dev: 'my-wrapper "vite"' }))[0].confidence).toBe("low");
  });

  it("framework detection from dependencies and config files is unaffected", () => {
    const quoted = insight(viteApp({ dev: 'vite --host "0.0.0.0"' })).frameworks.map((f) => [f.id, f.confidence]);
    const plain = insight(viteApp({ build: "tsc" })).frameworks.map((f) => [f.id, f.confidence]);
    expect(quoted).toEqual(plain);
    expect(quoted.length).toBeGreaterThan(0);
  });

  it("mixed evidence: an unquoted unsupported invocation is still withheld; a quoted one is not read", () => {
    const astro = (dev: string): ScanOptions => ({ packages: [pkg("package.json", { deps: ["express", "astro"], scripts: { dev, start: "node server.js" } })], files: ["package-lock.json"] });
    expect(suggestCommands(scan(astro("vite & astro dev"))).skipped.map((s) => s.reason)).toContain("unsupported-framework");
    expect(runs(astro("vite & astro dev")).map((s) => s.scriptName)).toEqual(["start"]);
    // Astro still comes from its dependency; the quoted script is a Low, explained candidate.
    const quoted = astro('astro dev --host "0.0.0.0"');
    expect(insight(quoted).frameworks.map((f) => f.id)).toContain("astro");
    const dev = runs(quoted).find((s) => s.scriptName === "dev")!;
    expect(dev.confidence).toBe("low");
    expect(text(dev)).toContain("uses quotes or escapes");
  });

  it("orchestration: only the unquoted program a command starts with is named", () => {
    const orchestration = (dev: string) => detectProjects(scan({ packages: [pkg("package.json", { workspaces: ["apps/*"], scripts: { dev } }), app("apps/web")], files: ["package-lock.json"] })).orchestration.map((o) => o.tool);
    expect(orchestration('concurrently "npm:dev:*"')).toEqual(["concurrently"]);
    expect(orchestration('npx concurrently "a" "b"')).toEqual(["concurrently"]);
    expect(orchestration('turbo run dev --filter "web"')).toEqual(["turbo"]);
    expect(orchestration('echo "x && turbo dev"')).toEqual([]);
    expect(orchestration('echo hi; turbo "dev"')).toEqual([]); // a separator before the quote: not read
    expect(orchestration('turbo"x" dev')).toEqual([]); // a word that runs into the quote isn't a program name
    expect(leadingWords('cross-env A=1 concurrently "x"')).toEqual(["concurrently"]);
  });

  it("script-name integrity rules still apply to quoted scripts", () => {
    const scanned = scan(viteApp({ dev: 'echo "vite"' }));
    scanned.packages[0].scripts[0] = { ...scanned.packages[0].scripts[0], nameExact: false };
    expect(suggestCommands(scanned).suggestions.filter((s) => s.source === "script")).toEqual([]);
  });

  it("nothing is executed or mutated; output is deterministic; commands come only from the template", () => {
    const result = deepFreeze(scan(viteApp({ dev: 'echo "ready && vite --host"', start: "vite preview" })));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(suggestCommands(result))).toBe(JSON.stringify(first));
    expect(JSON.stringify(detectProjects(result))).toBe(JSON.stringify(detectProjects(result)));
    expect(JSON.stringify(result)).toBe(before);
    for (const s of first.suggestions) expect(s.command === null || !s.command.includes('"')).toBe(true);
  });
});
