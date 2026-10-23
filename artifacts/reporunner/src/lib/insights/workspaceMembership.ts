// Whether a nested package is a workspace member of an ancestor package, from
// the bounded scan only. A lockfile in a parent folder says which package
// manager is used; it doesn't make the parent's install cover a nested
// package. Only workspace configuration does, so membership is established
// from the ancestor's package.json "workspaces" patterns, and anything that
// can't be decided is reported as unknown rather than guessed. Patterns are
// untrusted text: they're matched by hand, segment by segment, and nothing is
// built from them. Matching work is bounded: see MATCH_STATE_BUDGET.
import type { RepoScanResult } from "../../types";

export type Membership =
  | { status: "member"; pattern: string }
  | { status: "not-member"; reason: "no-workspaces" | "no-pattern-matches" }
  | { status: "unknown"; reason: "workspace-file-unread" | "pattern-unsupported" | "patterns-truncated" | "negated-pattern" | "scan-incomplete" | "match-budget-exceeded" };

/** Workspace files that define membership themselves; RepoRunner doesn't read them. (turbo.json and nx.json don't define it.) */
const MEMBERSHIP_FILES = new Set(["pnpm-workspace.yaml", "lerna.json", "rush.json"]);
const MAX_SEGMENTS = 16;
/**
 * Most pattern-matching work spent on one membership decision (one ancestor,
 * one package), counted in matching states: a (pattern segment, path segment)
 * position pair, each evaluated at most once per pattern. A pattern costs at
 * most (segments + 1) x (path segments + 1) states: 17 x 10 = 170 within the
 * scanner's limits (16 segments, depth 8), so its 50 patterns could reach
 * 8,500. Ordinary patterns ("apps/*", "packages/**") need a handful each, so a
 * whole real workspaces list stays far below this; only long chains of "**"
 * get near it. When the budget runs out the decision is unknown, never "not a
 * member". It's scoped to the one decision, so an expensive pattern list only
 * makes its own packages' membership unknown, and a full analysis (at most 200
 * packages, each with at most 8 ancestors) evaluates at most 1,600 x 2,048
 * states.
 */
export const MATCH_STATE_BUDGET = 2048;
const SAFE_SEGMENT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._@-*";

/** Splits a pattern into segments, or null when it uses syntax RepoRunner doesn't interpret (braces, character classes, "..", etc.). */
function patternSegments(pattern: string): string[] | null {
  let p = pattern.trim();
  if (p.startsWith("./")) p = p.slice(2);
  while (p.endsWith("/")) p = p.slice(0, -1);
  if (p === "") return null;
  const segments = p.split("/");
  if (segments.length > MAX_SEGMENTS) return null;
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return null;
    if (s.includes("**") && s !== "**") return null;
    for (const c of s) if (!SAFE_SEGMENT_CHARS.includes(c)) return null;
  }
  return segments;
}

/** "*" in a segment matches any run of characters (not "/"). */
function segmentMatches(pattern: string, name: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === name;
  if (!name.startsWith(parts[0]) || !name.endsWith(parts[parts.length - 1])) return false;
  let at = parts[0].length;
  const end = name.length - parts[parts.length - 1].length;
  if (at > end) return false;
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

export type MatchOutcome = "match" | "no-match" | "budget-exceeded";

/**
 * Whether pattern segments match path segments ("**" matches zero or more
 * folders). Each (pattern position, path position) state is evaluated once and
 * remembered, so repeated "**" can't revisit the same splits; every evaluation
 * is taken from `budget`, and running out gives "budget-exceeded".
 */
export function matchSegments(pattern: readonly string[], path: readonly string[], budget: { remaining: number }): MatchOutcome {
  const width = path.length + 1;
  const memo = new Int8Array((pattern.length + 1) * width); // 0 not evaluated, 1 match, 2 no match
  let exhausted = false;
  const matchesFrom = (i: number, j: number): boolean => {
    const key = i * width + j;
    if (memo[key] !== 0) return memo[key] === 1;
    if (exhausted || budget.remaining <= 0) {
      exhausted = true;
      return false;
    }
    budget.remaining--;
    let ok: boolean;
    if (i === pattern.length) ok = j === path.length;
    else if (pattern[i] === "**") ok = matchesFrom(i + 1, j) || (j < path.length && matchesFrom(i, j + 1));
    else ok = j < path.length && segmentMatches(pattern[i], path[j]) && matchesFrom(i + 1, j + 1);
    if (exhausted) return false;
    memo[key] = ok ? 1 : 2;
    return ok;
  };
  const ok = matchesFrom(0, 0);
  return exhausted ? "budget-exceeded" : ok ? "match" : "no-match";
}

/** Folder "a/b" relative to ancestor "a" ("." for the root); null when it isn't below it. */
export function relativeTo(ancestor: string, directory: string): string[] | null {
  if (ancestor === directory) return null;
  if (ancestor === ".") return directory.split("/");
  return directory.startsWith(`${ancestor}/`) ? directory.slice(ancestor.length + 1).split("/") : null;
}

export function workspaceMembership(result: RepoScanResult, ancestor: string, directory: string, matchBudget = MATCH_STATE_BUDGET): Membership {
  const relative = relativeTo(ancestor, directory);
  const ancestorPath = ancestor === "." ? "package.json" : `${ancestor}/package.json`;
  const ancestorPkg = result.packages.find((p) => p.path === ancestorPath);
  if (!relative || !ancestorPkg) return { status: "not-member", reason: "no-workspaces" };

  const negations = ancestorPkg.workspaces.filter((w) => w.trim().startsWith("!"));
  let unsupported = false;
  const budget = { remaining: matchBudget };
  for (const pattern of ancestorPkg.workspaces) {
    if (pattern.trim().startsWith("!")) continue;
    const segments = patternSegments(pattern);
    if (!segments) {
      unsupported = true;
      continue;
    }
    const outcome = matchSegments(segments, relative, budget);
    // Patterns left unchecked could still match it.
    if (outcome === "budget-exceeded") return { status: "unknown", reason: "match-budget-exceeded" };
    if (outcome === "match") {
      // A negation could exclude it; RepoRunner doesn't interpret exclusions.
      return negations.length > 0 ? { status: "unknown", reason: "negated-pattern" } : { status: "member", pattern };
    }
  }

  // Nothing matched. That's a definite "not a member" only when every way of
  // declaring membership was seen and understood.
  const workspaceFileHere = result.manifests.some((m) => {
    const slash = m.path.lastIndexOf("/");
    const dir = slash < 0 ? "." : m.path.slice(0, slash);
    return dir === ancestor && MEMBERSHIP_FILES.has(m.path.slice(slash + 1).toLowerCase());
  });
  if (workspaceFileHere) return { status: "unknown", reason: "workspace-file-unread" };
  if (unsupported) return { status: "unknown", reason: "pattern-unsupported" };
  if (ancestorPkg.workspacesTruncated || (ancestor === "." && result.workspace.patternsTruncated)) return { status: "unknown", reason: "patterns-truncated" };
  if (result.status !== "complete" || result.manifestsTruncated || result.packagesTruncated) return { status: "unknown", reason: "scan-incomplete" };
  return { status: "not-member", reason: ancestorPkg.workspaces.length > 0 ? "no-pattern-matches" : "no-workspaces" };
}

const UNKNOWN_TEXT: Record<Extract<Membership, { status: "unknown" }>["reason"], string> = {
  "workspace-file-unread": "workspace membership is set in a workspace file RepoRunner doesn't read",
  "pattern-unsupported": "a workspaces pattern uses syntax RepoRunner doesn't interpret",
  "patterns-truncated": "the workspaces list was cut short",
  "negated-pattern": "the workspaces list has exclusions RepoRunner doesn't interpret",
  "scan-incomplete": "the analysis didn't finish",
  "match-budget-exceeded": "the workspaces patterns were too complex to check completely",
};

export function unknownMembershipText(membership: Extract<Membership, { status: "unknown" }>): string {
  return UNKNOWN_TEXT[membership.reason];
}
