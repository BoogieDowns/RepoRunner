// PR #76 nested-workspace correction: workspace membership is direct, not
// transitive. A package belongs to the ancestor whose own "workspaces" patterns
// match it; a nested workspace root keeps its own install scope for its own
// members while still being a member of its parent; conflicting direct claims
// are reported as ambiguous instead of picking one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../../src/lib/insights/types";
import { FixtureSpace, pkg as filePkg } from "../../electron/repoScanner/fixtures.js";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const installs = (options: ScanOptions) => suggestCommands(scan(options)).suggestions.filter((s) => s.source === "install");
const rows = (list: CommandSuggestion[]) => list.map((s) => [s.directory, s.command, s.confidence]);
const codes = (s: CommandSuggestion) => s.caveats.map((c) => c.code);
const text = (s: CommandSuggestion) => [...s.evidence.map((e) => e.text), ...s.caveats.map((c) => c.text)].join(" ");
const at = (list: CommandSuggestion[], dir: string) => list.find((s) => s.directory === dir)!;
const app = (dir: string) => pkg(`${dir}/package.json`, { deps: ["express"], scripts: { start: "node i.js" } });

/** repository/ package.json (rootWorkspaces) + packages/mono (workspaces: apps/*) + packages/mono/apps/web */
const nested = (files: string[], rootWorkspaces = ["packages/*"], monoWorkspaces = ["apps/*"]): ScanOptions => ({
  packages: [pkg("package.json", { workspaces: rootWorkspaces }), pkg("packages/mono/package.json", { workspaces: monoWorkspaces }), app("packages/mono/apps/web")],
  files,
});

describe("nested workspace install scopes", () => {
  it("1/14. a simple root workspace installs once, with an accurate count", () => {
    const list = installs({ packages: [pkg("package.json", { workspaces: ["apps/*"] }), app("apps/a"), app("apps/b")], files: ["package-lock.json"] });
    expect(rows(list)).toEqual([[".", "npm install", "high"]]);
    expect(text(list[0])).toContain('3 packages share this install root: 2 matched by the "workspaces" patterns in package.json');
  });

  it("2. a nested workspace with its own lockfile keeps its own install for its own members", () => {
    const list = installs(nested(["package-lock.json", "packages/mono/package-lock.json"]));
    expect(rows(list)).toEqual([
      [".", "npm install", "high"],
      ["packages/mono", "npm install", "medium"],
    ]);
    expect(text(at(list, "packages/mono"))).toContain('2 packages share this install root: 1 matched by the "workspaces" patterns in packages/mono/package.json');
    expect(codes(at(list, "packages/mono"))).toContain("nested-workspace-root");
    expect(codes(at(list, "packages/mono"))).not.toContain("no-lockfile-here");
  });

  it("3/4/5. a nested workspace root without its own lockfile: member of the root, own (low) install for apps/web", () => {
    const list = installs(nested(["package-lock.json"]));
    expect(rows(list)).toEqual([
      [".", "npm install", "high"],
      ["packages/mono", "npm install", "low"],
    ]);
    const root = at(list, ".");
    const mono = at(list, "packages/mono");
    // The root counts only its direct member (packages/mono), never apps/web.
    expect(text(root)).toContain('2 packages share this install root: 1 matched by the "workspaces" patterns in package.json');
    expect(text(root)).not.toContain("apps/web");
    expect(text(mono)).toContain('packages/mono is a workspace member of package.json (pattern "packages/*")');
    expect(text(mono)).toContain("Installing at the repository root doesn't install the packages in packages/mono's own workspace (packages/mono/apps/web)");
    expect(codes(mono)).toEqual(expect.arrayContaining(["nested-workspace-root", "no-lockfile-here"]));
    expect(list.some((s) => s.directory === "packages/mono/apps/web")).toBe(false); // covered by packages/mono's install
  });

  it.each([
    [["packages/*", "packages/mono/apps/*"]],
    [["packages/**"]],
  ])("6. a nested app matching both the parent's (%j) and the child's patterns is ambiguous, not assigned", (rootWorkspaces) => {
    const list = installs(nested(["package-lock.json"], rootWorkspaces));
    expect(rows(list)).toEqual([
      [".", "npm install", "high"],
      ["packages/mono", "npm install", "low"],
      ["packages/mono/apps/web", "npm install", "low"],
    ]);
    const web = at(list, "packages/mono/apps/web");
    expect(codes(web)).toContain("workspace-ownership-ambiguous");
    expect(text(web)).toContain("package.json and packages/mono/package.json could each claim it");
    for (const dir of [".", "packages/mono"]) expect(codes(at(list, dir))).toContain("members-unconfirmed");
    // Neither root counts the ambiguous package as a confirmed member.
    expect(text(at(list, "."))).toContain("1 matched by");
    expect(text(at(list, "packages/mono"))).not.toContain("share this install root");
  });

  it("7. a nested package outside all workspace patterns is independent", () => {
    const options = nested(["package-lock.json"]);
    options.packages!.push(app("tools/cli"));
    const cli = at(installs(options), "tools/cli");
    expect([cli.confidence, codes(cli).includes("independent-package")]).toEqual(["medium", true]);
  });

  it("8. an unsupported pattern in the nested root: unknown, and the nested root's install exists for the caveat to point at", () => {
    const list = installs(nested(["package-lock.json"], ["packages/*"], ["{apps,libs}/*"]));
    expect(rows(list)).toEqual([
      [".", "npm install", "high"],
      ["packages/mono", "npm install", "low"],
      ["packages/mono/apps/web", "npm install", "low"],
    ]);
    expect(text(at(list, "packages/mono/apps/web"))).toContain("whether packages/mono/apps/web is a workspace member of packages/mono/package.json");
    expect(codes(at(list, "packages/mono"))).toContain("members-unconfirmed");
  });

  it("8b. an unread workspace file in the nested root that could also claim a package directly matched by the parent: ambiguous", () => {
    const list = installs(nested(["package-lock.json", "packages/mono/pnpm-workspace.yaml"], ["packages/**"], []));
    expect(codes(at(list, "packages/mono/apps/web"))).toContain("workspace-ownership-ambiguous");
  });

  it("9. partial evidence: truncated nested patterns are unknown; an incomplete scan confirms no membership", () => {
    const truncated = nested(["package-lock.json"], ["packages/*"], ["libs/*"]);
    truncated.packages![1] = { ...truncated.packages![1], workspacesTruncated: true };
    expect(codes(at(installs(truncated), "packages/mono/apps/web"))).toContain("workspace-membership-unknown");

    const partial = installs({ ...nested(["package-lock.json"]), status: "truncated", limitsHit: ["entries"] });
    // A file that decides membership may not have been scanned, so every package keeps a qualified install.
    expect(partial.map((s) => [s.directory, s.confidence])).toEqual([
      [".", "medium"],
      ["packages/mono", "low"],
      ["packages/mono/apps/web", "low"],
    ]);
  });

  it("10. conflicting package managers: every alternative for the nested root, ambiguous and at most low", () => {
    const mono = installs(nested(["package-lock.json", "yarn.lock"])).filter((s) => s.directory === "packages/mono");
    expect(mono.map((s) => s.command).sort()).toEqual(["npm install", "yarn install"]);
    for (const s of mono) expect([s.packageManagerAmbiguous, s.confidence]).toEqual([true, "low"]);
  });

  it("11. no duplicate installs: one suggestion per install root and manager", () => {
    for (const options of [nested(["package-lock.json"]), nested(["package-lock.json", "packages/mono/package-lock.json"]), nested(["package-lock.json"], ["packages/**"])]) {
      const ids = installs(options).map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("13. no transitive membership: three levels each install from their direct parent only", () => {
    const list = installs({
      packages: [
        pkg("package.json", { workspaces: ["a"] }),
        pkg("a/package.json", { workspaces: ["b"] }),
        pkg("a/b/package.json", { workspaces: ["c"] }),
        app("a/b/c"),
      ],
      files: ["package-lock.json"],
    });
    expect(list.map((s) => s.directory)).toEqual([".", "a", "a/b"]);
    for (const s of list) expect(text(s)).toMatch(/2 packages share this install root: 1 matched/);
  });

  it("a member with its own lockfile and no members of its own: counted by the root and installable on its own (medium)", () => {
    const list = installs({ packages: [pkg("package.json", { workspaces: ["apps/*"] }), app("apps/a")], files: ["package-lock.json", "apps/a/package-lock.json"] });
    expect(rows(list)).toEqual([
      [".", "npm install", "high"],
      ["apps/a", "npm install", "medium"],
    ]);
    expect(text(at(list, "."))).toContain("1 matched by");
  });

  it("15. pure: input untouched and deterministic", () => {
    const result = deepFreeze(scan(nested(["package-lock.json"], ["packages/**"])));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(suggestCommands(result)).toEqual(first);
  });
});

describe("nested workspaces from real scans", () => {
  let space: FixtureSpace;
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());

  it("Codex case: root packages/* + packages/mono apps/* with lockfiles at both levels", async () => {
    const root = space.repo("nested workspaces", {
      "package.json": filePkg({ name: "top", private: true, workspaces: ["packages/*"] }),
      "package-lock.json": "{}",
      "packages/mono/package.json": filePkg({ name: "mono", private: true, workspaces: ["apps/*"] }),
      "packages/mono/package-lock.json": "{}",
      "packages/mono/apps/web/package.json": filePkg({ name: "web", scripts: { start: "node index.js" }, dependencies: { express: "^4" } }),
    });
    const list = suggestCommands(await scanRepository(root)).suggestions.filter((s) => s.source === "install");
    expect(rows(list)).toEqual([
      [".", "npm install", "high"],
      ["packages/mono", "npm install", "medium"],
    ]);
    expect(text(at(list, "."))).toContain("2 packages share this install root: 1 matched");
    expect(text(at(list, "packages/mono"))).toContain("2 packages share this install root: 1 matched by the \"workspaces\" patterns in packages/mono/package.json");
  });

  it("without the nested lockfile: the nested root's install is low and qualified", async () => {
    const root = space.repo("nested workspaces no lock", {
      "package.json": filePkg({ name: "top", private: true, workspaces: ["packages/*"] }),
      "package-lock.json": "{}",
      "packages/mono/package.json": filePkg({ name: "mono", private: true, workspaces: ["apps/*"] }),
      "packages/mono/apps/web/package.json": filePkg({ name: "web", scripts: { start: "node index.js" }, dependencies: { express: "^4" } }),
    });
    const list = suggestCommands(await scanRepository(root)).suggestions.filter((s) => s.source === "install");
    expect(rows(list)).toEqual([
      [".", "npm install", "high"],
      ["packages/mono", "npm install", "low"],
    ]);
    expect(codes(at(list, "packages/mono"))).toContain("nested-workspace-root");
  });
});
