// PR #76 Codex finding: workspace pattern matching is bounded. Each
// (pattern position, path position) state is evaluated once, every evaluation
// is counted against a per-decision budget, and running out of budget makes
// membership unknown, never "not a member".
import { describe, expect, it } from "vitest";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../../src/lib/insights/types";
import { MATCH_STATE_BUDGET, matchSegments, workspaceMembership } from "../../../src/lib/insights/workspaceMembership";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const DEEP = "a/b/c/d/e/f/g/h"; // 8 folders, the scanner's maximum depth
const stars = (n: number, last: string) => [...Array(n).fill("**"), last].join("/");
/** Codex's reproduction: 50 patterns of fifteen "**" segments ending in a name that never matches. */
const HOSTILE = Array.from({ length: 50 }, (_, k) => stars(15, `absent${k}`));

/** Matches one pattern string and reports the states it evaluated. */
function match(pattern: string, path: string, budget = Number.MAX_SAFE_INTEGER) {
  const counter = { remaining: budget };
  const outcome = matchSegments(pattern.split("/"), path.split("/"), counter);
  return { outcome, states: budget - counter.remaining };
}

const member = (workspaces: string[], dir: string, options: Partial<ScanOptions> = {}, budget?: number) =>
  workspaceMembership(scan({ packages: [pkg("package.json", { workspaces }), pkg(`${dir}/package.json`)], ...options }), ".", dir, budget);

const installs = (options: ScanOptions) => suggestCommands(scan(options)).suggestions.filter((s) => s.source === "install");
const at = (list: CommandSuggestion[], dir: string) => list.find((s) => s.directory === dir)!;
const codes = (s: CommandSuggestion) => s.caveats.map((c) => c.code);
const text = (s: CommandSuggestion) => [...s.evidence.map((e) => e.text), ...s.caveats.map((c) => c.text)].join(" ");

/** The previous, unbounded matcher, kept as the reference for supported semantics. */
function referenceMatches(pattern: readonly string[], path: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === "**") {
    for (let skip = 0; skip <= path.length; skip++) if (referenceMatches(rest, path.slice(skip))) return true;
    return false;
  }
  const parts = head.split("*");
  const name = path[0];
  if (name === undefined) return false;
  let ok = parts.length === 1 ? head === name : name.startsWith(parts[0]) && name.endsWith(parts[parts.length - 1]) && name.length >= parts[0].length + parts[parts.length - 1].length;
  if (ok && parts.length > 2) {
    let i = parts[0].length;
    const end = name.length - parts[parts.length - 1].length;
    for (const part of parts.slice(1, -1)) {
      const found = name.indexOf(part, i);
      if (found < 0 || found + part.length > end) ok = false;
      else i = found + part.length;
    }
  }
  return ok && referenceMatches(rest, path.slice(1));
}

describe("bounded workspace pattern matching", () => {
  it("1. Codex's 50-pattern case finishes with little work and is unknown, not 'not a member'", () => {
    const started = performance.now();
    const result = member(HOSTILE, DEEP);
    const elapsed = performance.now() - started;
    expect(result).toEqual({ status: "unknown", reason: "match-budget-exceeded" });
    // With no budget the memoized matcher still decides it exactly, in at most 17 x 9 states per pattern.
    expect(member(HOSTILE, DEEP, {}, Number.MAX_SAFE_INTEGER)).toEqual({ status: "not-member", reason: "no-pattern-matches" });
    const total = HOSTILE.reduce((sum, p) => sum + match(p, DEEP).states, 0);
    expect(total).toBeLessThanOrEqual(50 * 17 * 9);
    expect(total).toBeGreaterThan(MATCH_STATE_BUDGET); // so the default budget is what stops it
    expect(elapsed).toBeLessThan(250); // generous; the unbounded matcher took seconds
  });

  it("2/3. fifteen consecutive '**' segments: each state once, matching or not at the last segment", () => {
    const miss = match(stars(15, "absent"), DEEP);
    expect(miss.outcome).toBe("no-match");
    expect(miss.states).toBeLessThanOrEqual((16 + 1) * (8 + 1));
    const hit = match(stars(15, "h"), DEEP);
    expect(hit.outcome).toBe("match");
    expect(hit.states).toBeLessThanOrEqual((16 + 1) * (8 + 1));
    expect(match(stars(15, "g"), DEEP).outcome).toBe("no-match"); // "g" isn't the last folder
  });

  it.each<[string, string, boolean]>([
    // 4. recursive patterns
    ["packages/**", "packages/a/b", true],
    ["packages/**", "packages", true],
    ["packages/**", "apps/a", false],
    ["**/web", "apps/web", true],
    ["**/web", "web", true],
    ["**/web", "apps/web/nested", false],
    ["apps/**/src/**/pkg", "apps/x/src/y/z/pkg", true],
    ["apps/**/src/**/pkg", "apps/x/lib/y/pkg", false],
    ["**/**/a", "a", true],
    // 5. single level
    ["apps/*", "apps/web", true],
    ["apps/*", "apps/web/nested", false],
    ["apps/*", "tools/cli", false],
    ["tools/cli", "tools/cli", true],
    // 6. "*" within a segment
    ["apps/app-*", "apps/app-web", true],
    ["apps/app-*", "apps/web", false],
    ["apps/*-svc", "apps/pay-svc", true],
    ["apps/a*b*c", "apps/axbyc", true],
    ["apps/a*b*c", "apps/acb", false],
  ])("%s / %s -> %s", (pattern, path, expected) => {
    expect(match(pattern, path).outcome).toBe(expected ? "match" : "no-match");
    expect(member([pattern], path).status).toBe(expected ? "member" : "not-member");
  });

  it("7. './' prefixes and trailing slashes are accepted", () => {
    expect(member(["./apps/*"], "apps/web").status).toBe("member");
    expect(member(["./packages/**/"], "packages/a/b").status).toBe("member");
  });

  it("8. negated and unsupported syntax stay unknown", () => {
    expect(member(["apps/*", "!apps/legacy"], "apps/web")).toEqual({ status: "unknown", reason: "negated-pattern" });
    expect(member(["{apps,libs}/*"], "apps/web")).toEqual({ status: "unknown", reason: "pattern-unsupported" });
    expect(member(["apps/**x"], "apps/ax")).toEqual({ status: "unknown", reason: "pattern-unsupported" });
    expect(member([stars(16, "h")], DEEP)).toEqual({ status: "unknown", reason: "pattern-unsupported" }); // more than 16 segments
  });

  it("supported patterns decide exactly as the previous matcher did", () => {
    let seed = 11;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const segments = ["a", "b", "ab", "*", "a*", "*b", "a*b", "**"];
    const names = ["a", "b", "ab", "ba", "aab", "abb"];
    for (let t = 0; t < 3000; t++) {
      const pattern = Array.from({ length: 1 + next(7) }, () => segments[next(segments.length)]);
      const path = Array.from({ length: 1 + next(8) }, () => names[next(names.length)]);
      expect(matchSegments(pattern, path, { remaining: MATCH_STATE_BUDGET }), `${pattern.join("/")} vs ${path.join("/")}`).toBe(referenceMatches(pattern, path) ? "match" : "no-match");
    }
  });

  it("13. running out of budget is unknown, never a negative result", () => {
    expect(match(stars(3, "absent"), DEEP, 5).outcome).toBe("budget-exceeded");
    expect(match(stars(3, "h"), DEEP, 5).outcome).toBe("budget-exceeded");
    expect(member([stars(3, "absent")], DEEP, {}, 5)).toEqual({ status: "unknown", reason: "match-budget-exceeded" });
    // Patterns after the exhausted one weren't checked, so even a would-be match stays unknown.
    expect(member([stars(3, "absent"), "a/**"], DEEP, {}, 5)).toEqual({ status: "unknown", reason: "match-budget-exceeded" });
    // A match found within budget is still a match.
    expect(member([DEEP, stars(3, "absent")], DEEP, {}, 10).status).toBe("member"); // a literal path costs one state per segment
  });

  it("the budget is per decision: an expensive pattern list doesn't affect other ancestors", () => {
    const result = scan({
      packages: [pkg("package.json", { workspaces: HOSTILE }), pkg("a/package.json", { workspaces: ["b/**"] }), pkg(`${DEEP}/package.json`)],
    });
    expect(workspaceMembership(result, ".", DEEP).status).toBe("unknown");
    expect(workspaceMembership(result, "a", DEEP)).toEqual({ status: "member", pattern: "b/**" });
    // A shallow package is cheap to check even against the same patterns, so it's decided exactly.
    expect(workspaceMembership(result, ".", "a")).toEqual({ status: "not-member", reason: "no-pattern-matches" });
  });

  it("realistic workspace lists stay far below the budget", () => {
    const patterns = ["apps/*", "packages/*", "packages/**", "libs/*/src", "services/svc-*", "tools/**/cli", "**/pkg-*"];
    for (const path of ["apps/web", "packages/ui/core", "libs/x/src", DEEP]) {
      const counter = { remaining: MATCH_STATE_BUDGET };
      for (const p of patterns) matchSegments(p.split("/"), path.split("/"), counter);
      expect(MATCH_STATE_BUDGET - counter.remaining).toBeLessThan(100);
    }
  });
});

describe("indeterminate matching in install suggestions", () => {
  const hostileRepo = (extra: ScanOptions["packages"] = []): ScanOptions => ({
    packages: [pkg("package.json", { workspaces: HOSTILE }), pkg(`${DEEP}/package.json`, { deps: ["express"], scripts: { start: "node i.js" } }), ...extra],
    files: ["package-lock.json"],
  });

  it("14. an unchecked package gets its own low install with the uncertainty spelled out, never 'independent'", () => {
    const list = installs(hostileRepo());
    expect(list.map((s) => [s.directory, s.confidence])).toEqual([
      [".", "high"],
      [DEEP, "low"],
    ]);
    const deep = at(list, DEEP);
    expect(codes(deep)).toContain("workspace-membership-unknown");
    expect(codes(deep)).not.toContain("independent-package");
    expect(text(deep)).toContain(`It couldn't be confirmed whether ${DEEP} is a workspace member of package.json (the workspaces patterns were too complex to check completely)`);
    expect(codes(at(list, "."))).toContain("members-unconfirmed");
    expect(text(at(list, "."))).not.toContain("share this install root");
  });

  it("9. direct nested membership still holds beside an expensive parent", () => {
    const list = installs(hostileRepo([pkg("a/package.json", { workspaces: ["b/**"] })]));
    // a's install claims the deep package directly; the root's patterns couldn't be checked, so ownership is ambiguous.
    expect(codes(at(list, DEEP))).toContain("workspace-ownership-ambiguous");
    expect(text(at(list, DEEP))).toContain("package.json and a/package.json could each claim it");
    expect(at(list, DEEP).confidence).toBe("low");
  });

  it("10. ambiguous nested ownership is unchanged for ordinary patterns", () => {
    const list = installs({
      packages: [pkg("package.json", { workspaces: ["packages/**"] }), pkg("packages/mono/package.json", { workspaces: ["apps/*"] }), pkg("packages/mono/apps/web/package.json")],
      files: ["package-lock.json"],
    });
    expect(list.map((s) => [s.directory, s.confidence])).toEqual([
      [".", "high"],
      ["packages/mono", "low"],
      ["packages/mono/apps/web", "low"],
    ]);
    expect(codes(at(list, "packages/mono/apps/web"))).toContain("workspace-ownership-ambiguous");
  });

  it("11. truncated workspace patterns stay unknown", () => {
    const result = scan({ packages: [{ ...pkg("package.json", { workspaces: ["apps/*"] }), workspacesTruncated: true }, pkg("tools/cli/package.json")] });
    expect(workspaceMembership(result, ".", "tools/cli")).toEqual({ status: "unknown", reason: "patterns-truncated" });
  });

  it("12. partial scans confirm nothing: matches and non-matches are unknown", () => {
    const partial = { status: "truncated" as const, limitsHit: ["entries" as const] };
    expect(member(["apps/*"], "apps/web", partial)).toEqual({ status: "unknown", reason: "scan-incomplete" });
    expect(member(["apps/*"], "tools/cli", partial)).toEqual({ status: "unknown", reason: "scan-incomplete" });
    expect(member(HOSTILE, DEEP, partial)).toEqual({ status: "unknown", reason: "match-budget-exceeded" });
  });

  it("15/16. pure and deterministic", () => {
    const result = deepFreeze(scan(hostileRepo([pkg("a/package.json", { workspaces: ["b/**"] })])));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(suggestCommands(result)).toEqual(first);
    expect(workspaceMembership(result, ".", DEEP)).toEqual(workspaceMembership(result, ".", DEEP));
  });
});
