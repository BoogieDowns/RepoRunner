// Whether a nested package is a workspace member of an ancestor package, from
// the bounded scan only. A lockfile in a parent folder says which package
// manager is used; it doesn't make the parent's install cover a nested
// package. Only workspace configuration does, so membership is established
// from the ancestor's package.json "workspaces" patterns, and anything that
// can't be decided is reported as unknown rather than guessed. Patterns are
// untrusted text: they're matched by hand, segment by segment, and nothing is
// built from them.
import type { RepoScanResult } from "../../types";

export type Membership =
  | { status: "member"; pattern: string }
  | { status: "not-member"; reason: "no-workspaces" | "no-pattern-matches" }
  | { status: "unknown"; reason: "workspace-file-unread" | "pattern-unsupported" | "patterns-truncated" | "negated-pattern" | "scan-incomplete" };

/** Workspace files that define membership themselves; RepoRunner doesn't read them. (turbo.json and nx.json don't define it.) */
const MEMBERSHIP_FILES = new Set(["pnpm-workspace.yaml", "lerna.json", "rush.json"]);
const MAX_SEGMENTS = 16;
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

function pathMatches(pattern: readonly string[], path: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === "**") {
    for (let skip = 0; skip <= path.length; skip++) if (pathMatches(rest, path.slice(skip))) return true;
    return false;
  }
  return path.length > 0 && segmentMatches(head, path[0]) && pathMatches(rest, path.slice(1));
}

/** Folder "a/b" relative to ancestor "a" ("." for the root); null when it isn't below it. */
export function relativeTo(ancestor: string, directory: string): string[] | null {
  if (ancestor === directory) return null;
  if (ancestor === ".") return directory.split("/");
  return directory.startsWith(`${ancestor}/`) ? directory.slice(ancestor.length + 1).split("/") : null;
}

export function workspaceMembership(result: RepoScanResult, ancestor: string, directory: string): Membership {
  const relative = relativeTo(ancestor, directory);
  const ancestorPath = ancestor === "." ? "package.json" : `${ancestor}/package.json`;
  const ancestorPkg = result.packages.find((p) => p.path === ancestorPath);
  if (!relative || !ancestorPkg) return { status: "not-member", reason: "no-workspaces" };

  const negations = ancestorPkg.workspaces.filter((w) => w.trim().startsWith("!"));
  let unsupported = false;
  for (const pattern of ancestorPkg.workspaces) {
    if (pattern.trim().startsWith("!")) continue;
    const segments = patternSegments(pattern);
    if (!segments) {
      unsupported = true;
      continue;
    }
    if (pathMatches(segments, relative)) {
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
};

export function unknownMembershipText(membership: Extract<Membership, { status: "unknown" }>): string {
  return UNKNOWN_TEXT[membership.reason];
}
