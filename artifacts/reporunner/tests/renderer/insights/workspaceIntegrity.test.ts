// PR #76 Codex findings: a "workspaces" match confirms membership only when
// the list is complete, exactly as written in package.json, fully
// interpretable, has no exclusions, isn't overruled by a workspace file
// RepoRunner doesn't read, and the scan finished. Anything else is unknown: the
// package keeps its own qualified install and no parent claims to cover it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePackageJson } from "../../../electron/repoScanner/parseManifests.js";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../../src/lib/insights/types";
import { workspaceMembership } from "../../../src/lib/insights/workspaceMembership";
import type { PackageSummary, RepoScanResult } from "../../../src/types";
import { FixtureSpace, pkg as filePkg } from "../../electron/repoScanner/fixtures.js";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const ZWSP = String.fromCodePoint(0x200b);
const app = (dir: string) => pkg(`${dir}/package.json`, { deps: ["express"], scripts: { start: "node i.js" } });
const appFile = () => filePkg({ name: "web", scripts: { start: "node index.js" }, dependencies: { express: "^4" } });
/** The root summary from the real manifest parser. */
function parsedRoot(workspaces: unknown): PackageSummary {
  const out = parsePackageJson(new TextEncoder().encode(JSON.stringify({ name: "top", private: true, workspaces })), "package.json");
  if (!out.ok) throw new Error(out.warning);
  return out.summary;
}
const repo = (root: PackageSummary, extra: Partial<ScanOptions> = {}, dir = "packages/web"): ScanOptions => ({ packages: [root, app(dir)], files: ["package-lock.json"], ...extra });
const membership = (options: ScanOptions, dir = "packages/web", ancestor = ".") => workspaceMembership(scan(options), ancestor, dir);
const installsOf = (result: RepoScanResult) => suggestCommands(result).suggestions.filter((s) => s.source === "install");
const installs = (options: ScanOptions) => installsOf(scan(options));
const rows = (list: CommandSuggestion[]) => list.map((s) => [s.directory, s.command, s.confidence]);
const at = (list: CommandSuggestion[], dir: string) => list.find((s) => s.directory === dir)!;
const codes = (s: CommandSuggestion) => s.caveats.map((c) => c.code);
const text = (s: CommandSuggestion) => [...s.evidence.map((e) => e.text), ...s.caveats.map((c) => c.text)].join(" ");
/** packages/*, 49 other patterns, then an exclusion that the 50-pattern limit cuts off. */
const LOST_NEGATION = ["packages/*", ...Array.from({ length: 49 }, (_, i) => `other${i}/*`), "!packages/web"];

/** The install suggestions when membership couldn't be verified: root High, the package its own Low install, nothing claimed. */
function expectUnverified(list: CommandSuggestion[], reasonText: string, rootConfidence = "high", dir = "packages/web") {
  expect(rows(list)).toEqual([
    [".", "npm install", rootConfidence],
    [dir, "npm install", "low"],
  ]);
  expect(codes(at(list, dir))).toContain("workspace-membership-unknown");
  expect(codes(at(list, dir))).not.toContain("independent-package");
  expect(text(at(list, dir))).toContain(reasonText);
  expect(text(at(list, "."))).not.toContain("share this install root");
  expect(codes(at(list, "."))).toContain("members-unconfirmed");
}

describe("scanner: workspace-pattern integrity metadata", () => {
  it.each<[string, unknown, boolean, boolean]>([
    ["no workspaces field", undefined, true, false],
    ["ordinary list", ["apps/*", "packages/**"], true, false],
    ["Yarn object form", { packages: ["apps/*"], nohoist: ["**/x"] }, true, false],
    ["zero-width character", [`packages/${ZWSP}*`], false, false],
    ["leading whitespace", [" packages/*"], false, false],
    ["entry that cleans to nothing", ["apps/*", ZWSP], false, false],
    ["non-string entry", ["apps/*", 7], false, false],
    ["unexpected shape", "apps/*", false, false],
    ["object without a packages list", { packages: "apps/*" }, false, false],
    ["longer than the pattern limit", [`apps/${"x".repeat(250)}`], false, false],
    ["more than 50 patterns: truncated, retained ones exact", LOST_NEGATION, true, true],
  ])("%s", (_label, workspaces, exact, truncated) => {
    const root = parsedRoot(workspaces);
    expect([root.workspacesExact, root.workspacesTruncated]).toEqual([exact, truncated]);
    expect(JSON.stringify(root)).not.toContain(ZWSP);
  });

  it("8. collisions: two strings that display alike leave the list unverified", () => {
    const root = parsedRoot(["packages/*", `packages/${ZWSP}*`]);
    expect(root.workspaces).toEqual(["packages/*", "packages/*"]);
    expect(root.workspacesExact).toBe(false);
  });
});

describe("the verified-membership gate", () => {
  it("1/2. a complete, exact list with no competing evidence confirms membership; one root install", () => {
    const options = repo(parsedRoot(["packages/*"]));
    expect(membership(options)).toEqual({ status: "member", pattern: "packages/*" });
    const list = installs(options);
    expect(rows(list)).toEqual([[".", "npm install", "high"]]);
    expect(text(list[0])).toContain('2 packages share this install root: 1 matched by the "workspaces" patterns in package.json');
  });

  it("3/4. a truncated list never confirms a match (Codex: an exclusion beyond the 50-pattern limit)", () => {
    const options = repo(parsedRoot(LOST_NEGATION));
    expect(membership(options)).toEqual({ status: "unknown", reason: "patterns-truncated" });
    expectUnverified(installs(options), "(the workspaces list was cut short)");
  });

  it("5/6. an altered pattern never confirms a match (Codex: packages/\\u200b* shown as packages/*)", () => {
    const options = repo(parsedRoot([`packages/${ZWSP}*`]));
    expect(scan(options).packages[0].workspaces).toEqual(["packages/*"]);
    expect(membership(options)).toEqual({ status: "unknown", reason: "patterns-altered" });
    expectUnverified(installs(options), "the workspaces list had characters or entries RepoRunner removed for display");
  });

  it("7. exact and altered patterns in one list: the whole list is unverified, even for the exact pattern's match", () => {
    expect(membership(repo(parsedRoot(["packages/*", `libs/${ZWSP}*`])))).toEqual({ status: "unknown", reason: "patterns-altered" });
  });

  it("9. missing integrity metadata is treated as unverified", () => {
    const legacy = { ...pkg("package.json", { workspaces: ["packages/*"] }) } as Partial<PackageSummary>;
    delete legacy.workspacesExact;
    expect(membership(repo(legacy as PackageSummary))).toEqual({ status: "unknown", reason: "patterns-altered" });
  });

  it("10. unsupported syntax anywhere makes the list unverified, matched or not", () => {
    expect(membership(repo(parsedRoot(["packages/*", "{apps,libs}/*"])))).toEqual({ status: "unknown", reason: "pattern-unsupported" });
    expect(membership(repo(parsedRoot(["{apps,libs}/*"])))).toEqual({ status: "unknown", reason: "pattern-unsupported" });
  });

  it("11. exclusions: a match is unknown; a package no positive pattern matches is still not a member", () => {
    expect(membership(repo(parsedRoot(["packages/*", "!packages/legacy"])))).toEqual({ status: "unknown", reason: "negated-pattern" });
    expect(membership(repo(parsedRoot(["apps/*", "!apps/legacy"])), "tools/cli")).toEqual({ status: "not-member", reason: "no-pattern-matches" });
  });

  it("12/13/14. governing workspace files overrule a match; others don't", () => {
    for (const file of ["pnpm-workspace.yaml", "rush.json"]) {
      expect(membership(repo(parsedRoot(["packages/*"]), { files: ["package-lock.json", file] }))).toMatchObject({ status: "unknown", reason: "workspace-file-governs", file });
    }
    for (const file of ["lerna.json", "turbo.json", "nx.json"]) {
      expect(membership(repo(parsedRoot(["packages/*"]), { files: ["package-lock.json", file] })).status).toBe("member");
    }
  });

  it("15. nested roots: an altered nested list leaves its own packages unknown while its own membership stays verified", () => {
    const mono = { ...pkg("packages/mono/package.json", { workspaces: ["apps/*"] }), workspacesExact: false };
    const options: ScanOptions = { packages: [parsedRoot(["packages/*"]), mono, app("packages/mono/apps/web")], files: ["package-lock.json"] };
    expect(membership(options, "packages/mono")).toEqual({ status: "member", pattern: "packages/*" });
    expect(membership(options, "packages/mono/apps/web", "packages/mono")).toEqual({ status: "unknown", reason: "patterns-altered" });
    expect(rows(installs(options))).toEqual([
      [".", "npm install", "high"],
      ["packages/mono", "npm install", "low"],
      ["packages/mono/apps/web", "npm install", "low"],
    ]);
  });

  it("16. competing direct owners stay ambiguous", () => {
    const options: ScanOptions = {
      packages: [parsedRoot(["packages/**"]), pkg("packages/mono/package.json", { workspaces: ["apps/*"] }), app("packages/mono/apps/web")],
      files: ["package-lock.json"],
    };
    expect(codes(at(installs(options), "packages/mono/apps/web"))).toContain("workspace-ownership-ambiguous");
  });

  it.each<[string, Partial<ScanOptions>]>([
    ["partial", { status: "truncated", limitsHit: ["entries"] }],
    ["timed out", { status: "timed-out" }],
    ["cancelled", { status: "cancelled" }],
    ["manifest list cut short", { manifestsTruncated: true }],
    ["package list cut short", { packagesTruncated: true }],
  ])("17/18. %s scan: no confirmed membership", (_label, extra) => {
    expect(membership(repo(parsedRoot(["packages/*"]), extra))).toEqual({ status: "unknown", reason: "scan-incomplete" });
    const list = installs(repo(parsedRoot(["packages/*"]), extra));
    expect(at(list, "packages/web").confidence).toBe("low");
    expect(text(at(list, "."))).not.toContain("share this install root");
  });

  it("19. the matching-work budget still applies to an exact, complete list", () => {
    const hostile = Array.from({ length: 50 }, (_, k) => [...Array(15).fill("**"), `absent${k}`].join("/"));
    expect(membership(repo(parsedRoot(hostile), {}, "a/b/c/d/e/f/g/h"), "a/b/c/d/e/f/g/h")).toEqual({ status: "unknown", reason: "match-budget-exceeded" });
  });

  it("20/21. the root install keeps its own confidence and counts only verified members", () => {
    const options: ScanOptions = { packages: [parsedRoot(["packages/*", "!packages/legacy"]), app("packages/web"), app("tools/cli")], files: ["package-lock.json"] };
    const list = installs(options);
    expect(at(list, ".").confidence).toBe("high");
    expect(text(at(list, "."))).not.toContain("share this install root");
    expect(at(list, "packages/web").confidence).toBe("low");
    expect([at(list, "tools/cli").confidence, codes(at(list, "tools/cli")).includes("independent-package")]).toEqual(["medium", true]);
  });

  it("22. pure: input untouched and deterministic", () => {
    const result = deepFreeze(scan(repo(parsedRoot([`packages/${ZWSP}*`]))));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(suggestCommands(result)).toEqual(first);
  });
});

describe("real scanner to detection to suggestions", () => {
  let space: FixtureSpace;
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());

  it("an ordinary workspace with complete, exact evidence keeps one root install", async () => {
    const root = space.repo("verified workspace", { "package.json": filePkg({ name: "top", private: true, workspaces: ["packages/*"] }), "package-lock.json": "{}", "packages/web/package.json": appFile() });
    const result = await scanRepository(root);
    expect(result.packages.find((p) => p.path === "package.json")?.workspacesExact).toBe(true);
    expect(rows(installsOf(result))).toEqual([[".", "npm install", "high"]]);
  });

  it("Codex truncation case: the lost exclusion leaves packages/web with its own qualified install", async () => {
    const root = space.repo("lost negation", { "package.json": filePkg({ name: "top", private: true, workspaces: LOST_NEGATION }), "package-lock.json": "{}", "packages/web/package.json": appFile() });
    const result = await scanRepository(root);
    // A cut-short list also marks the scan itself truncated, which already caps the root install at medium.
    expect(result.status).toBe("truncated");
    expectUnverified(installsOf(result), "(the workspaces list was cut short)", "medium");
  });

  it("Codex altered-pattern case: packages/\\u200b* gives no false membership", async () => {
    const root = space.repo("altered pattern", { "package.json": filePkg({ name: "top", private: true, workspaces: [`packages/${ZWSP}*`] }), "package-lock.json": "{}", "packages/web/package.json": appFile() });
    const result = await scanRepository(root);
    expect(result.packages.find((p) => p.path === "package.json")).toMatchObject({ workspaces: ["packages/*"], workspacesExact: false });
    expectUnverified(installsOf(result), "removed for display");
  });
});
