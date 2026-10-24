// PR #76 Codex finding: pnpm ignores package.json "workspaces" and decides
// membership from pnpm-workspace.yaml (Rush, from rush.json). RepoRunner
// doesn't read those files, so where one governs, a matching "workspaces"
// pattern is evidence but not confirmed membership: the package keeps its own
// qualified install and no parent install claims to cover it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../../src/lib/insights/types";
import { MATCH_STATE_BUDGET, workspaceMembership } from "../../../src/lib/insights/workspaceMembership";
import type { RepoScanResult } from "../../../src/types";
import { FixtureSpace, pkg as filePkg } from "../../electron/repoScanner/fixtures.js";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const app = (dir: string) => pkg(`${dir}/package.json`, { deps: ["express"], scripts: { start: "node i.js" } });
const installs = (options: ScanOptions | RepoScanResult) =>
  suggestCommands("packages" in options && "stats" in options ? (options as RepoScanResult) : scan(options as ScanOptions)).suggestions.filter((s) => s.source === "install");
const rows = (list: CommandSuggestion[]) => list.map((s) => [s.directory, s.command, s.confidence]);
const at = (list: CommandSuggestion[], dir: string) => list.find((s) => s.directory === dir)!;
const codes = (s: CommandSuggestion) => s.caveats.map((c) => c.code);
const text = (s: CommandSuggestion) => [...s.evidence.map((e) => e.text), ...s.caveats.map((c) => c.text)].join(" ");

/** Codex's example: package.json says packages/*, pnpm-workspace.yaml (unread) may list only apps/*. */
const codexCase = (files: string[] = ["pnpm-lock.yaml", "pnpm-workspace.yaml"]): ScanOptions => ({
  packages: [pkg("package.json", { workspaces: ["packages/*"] }), app("packages/web")],
  files,
});
const membership = (options: ScanOptions, ancestor: string, dir: string) => workspaceMembership(scan(options), ancestor, dir);

describe("workspace files that govern membership", () => {
  it("1. package.json workspaces with no competing file: confirmed member, one root install", () => {
    const options = codexCase(["package-lock.json"]);
    expect(membership(options, ".", "packages/web")).toEqual({ status: "member", pattern: "packages/*" });
    expect(rows(installs(options))).toEqual([[".", "npm install", "high"]]);
  });

  it("2. pnpm-workspace.yaml beside a matching pattern: unknown, with the pattern kept as evidence", () => {
    expect(membership(codexCase(), ".", "packages/web")).toEqual({ status: "unknown", reason: "workspace-file-governs", pattern: "packages/*", file: "pnpm-workspace.yaml" });
  });

  it("3. pnpm-workspace.yaml beside a non-matching pattern: unknown (unread), never 'not a member'", () => {
    const options = { ...codexCase(), packages: [pkg("package.json", { workspaces: ["libs/*"] }), app("packages/web")] };
    expect(membership(options, ".", "packages/web")).toEqual({ status: "unknown", reason: "workspace-file-unread" });
  });

  it("4/5/6/13. Codex's example: a separate low install for packages/web; the root install doesn't claim it", () => {
    const list = installs(codexCase());
    expect(rows(list)).toEqual([
      [".", "pnpm install", "high"],
      ["packages/web", "pnpm install", "low"],
    ]);
    const web = at(list, "packages/web");
    expect(codes(web)).toContain("workspace-membership-unknown");
    expect(codes(web)).not.toContain("independent-package");
    expect(text(web)).toContain(
      `It couldn't be confirmed whether packages/web is a workspace member of package.json (it matches the "workspaces" pattern "packages/*", but pnpm-workspace.yaml decides workspace membership for the package manager, and RepoRunner doesn't read it). If it is, installing at the repository root already covers it; if not, it needs this separate install.`,
    );
    const root = at(list, ".");
    expect(text(root)).not.toContain("share this install root");
    expect(codes(root)).toContain("members-unconfirmed");
    expect(text(root)).toContain("this install may not cover it");
  });

  it("rush.json governs the same way; lerna.json doesn't (npm and Yarn still install from \"workspaces\")", () => {
    expect(membership(codexCase(["package-lock.json", "rush.json"]), ".", "packages/web")).toMatchObject({ status: "unknown", reason: "workspace-file-governs", file: "rush.json" });
    expect(membership(codexCase(["package-lock.json", "lerna.json"]), ".", "packages/web")).toEqual({ status: "member", pattern: "packages/*" });
    expect(rows(installs(codexCase(["package-lock.json", "lerna.json"])))).toEqual([[".", "npm install", "high"]]);
    // turbo.json and nx.json don't define membership at all.
    expect(membership(codexCase(["package-lock.json", "turbo.json", "nx.json"]), ".", "packages/web").status).toBe("member");
  });

  it("7/10. nested: a governing file at the root also governs a nested package's \"workspaces\"", () => {
    const options: ScanOptions = {
      packages: [pkg("package.json", { workspaces: ["packages/*"] }), pkg("packages/mono/package.json", { workspaces: ["apps/*"] }), app("packages/mono/apps/web")],
      files: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
    };
    expect(membership(options, "packages/mono", "packages/mono/apps/web")).toMatchObject({ status: "unknown", reason: "workspace-file-governs", file: "pnpm-workspace.yaml" });
    expect(rows(installs(options))).toEqual([
      [".", "pnpm install", "high"],
      ["packages/mono", "pnpm install", "low"],
      ["packages/mono/apps/web", "pnpm install", "low"],
    ]);
  });

  it("7/10. nested: a governing file in a nested root affects that root's claims only, not the parent's", () => {
    const options: ScanOptions = {
      packages: [pkg("package.json", { workspaces: ["packages/*"] }), pkg("packages/mono/package.json", { workspaces: ["apps/*"] }), app("packages/mono/apps/web")],
      files: ["package-lock.json", "packages/mono/pnpm-workspace.yaml"],
    };
    expect(membership(options, ".", "packages/mono")).toEqual({ status: "member", pattern: "packages/*" });
    expect(membership(options, "packages/mono", "packages/mono/apps/web")).toMatchObject({ status: "unknown", reason: "workspace-file-governs", file: "packages/mono/pnpm-workspace.yaml" });
    const list = installs(options);
    expect(rows(list)).toEqual([
      [".", "npm install", "high"],
      ["packages/mono", "npm install", "low"],
      ["packages/mono/apps/web", "npm install", "low"],
    ]);
    expect(text(at(list, "."))).toContain("2 packages share this install root: 1 matched"); // mono is still a confirmed member
  });

  it("8. conflicting direct claims: a parent match plus a governed nested claim stays ambiguous", () => {
    const options: ScanOptions = {
      packages: [pkg("package.json", { workspaces: ["packages/**"] }), pkg("packages/mono/package.json", { workspaces: ["apps/*"] }), app("packages/mono/apps/web")],
      files: ["package-lock.json", "packages/mono/pnpm-workspace.yaml"],
    };
    const web = at(installs(options), "packages/mono/apps/web");
    expect([web.confidence, codes(web).includes("workspace-ownership-ambiguous")]).toEqual(["low", true]);
  });

  it("9. an independent nested package outside every pattern is unchanged by an unrelated nested governing file", () => {
    const options: ScanOptions = { ...codexCase(["package-lock.json", "other/pnpm-workspace.yaml"]), packages: [...codexCase().packages!, pkg("other/package.json"), app("tools/cli")] };
    expect(membership(options, ".", "packages/web")).toEqual({ status: "member", pattern: "packages/*" });
    const cli = at(installs(options), "tools/cli");
    expect([cli.confidence, codes(cli).includes("independent-package")]).toEqual(["medium", true]);
  });

  it("11. truncated and partial scans stay unknown (and never better than before)", () => {
    const truncated = codexCase();
    truncated.packages![0] = { ...truncated.packages![0], workspacesTruncated: true };
    expect(membership(truncated, ".", "packages/web").status).toBe("unknown");
    const partial = installs({ ...codexCase(), status: "truncated", limitsHit: ["entries"] });
    expect(at(partial, "packages/web").confidence).toBe("low");
    expect(at(partial, ".").confidence).not.toBe("high");
  });

  it("12. the matching work budget still applies first", () => {
    const hostile = Array.from({ length: 50 }, (_, k) => [...Array(15).fill("**"), `absent${k}`].join("/"));
    const options: ScanOptions = { packages: [pkg("package.json", { workspaces: hostile }), app("a/b/c/d/e/f/g/h")], files: ["pnpm-workspace.yaml"] };
    expect(membership(options, ".", "a/b/c/d/e/f/g/h")).toEqual({ status: "unknown", reason: "match-budget-exceeded" });
    expect(MATCH_STATE_BUDGET).toBe(2048);
  });

  it("15. pure and deterministic", () => {
    const result = deepFreeze(scan(codexCase()));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(suggestCommands(result)).toEqual(first);
  });
});

describe("pnpm workspaces from a real scan", () => {
  let space: FixtureSpace;
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());

  it("4/14. Codex's repository: packages/web keeps its own qualified install, and only scanner output is used", async () => {
    const root = space.repo("pnpm excludes packages", {
      "package.json": filePkg({ name: "top", private: true, workspaces: ["packages/*"], packageManager: "pnpm@10.28.1" }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "packages/web/package.json": filePkg({ name: "web", scripts: { start: "node index.js" }, dependencies: { express: "^4" } }),
    });
    const result = await scanRepository(root);
    // The scanner lists pnpm-workspace.yaml but never reads it (2 package.json files read).
    expect(result.manifests.map((m) => m.path)).toContain("pnpm-workspace.yaml");
    expect(result.stats.filesRead).toBe(2);
    const list = installs(result);
    expect(rows(list)).toEqual([
      [".", "pnpm install", "high"],
      ["packages/web", "pnpm install", "low"],
    ]);
    expect(text(at(list, "packages/web"))).toContain("pnpm-workspace.yaml decides workspace membership");
  });
});
