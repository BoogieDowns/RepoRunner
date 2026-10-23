// Incomplete coverage must never be reported as a complete analysis:
// unreadable folders (at open or mid-listing), files that couldn't be
// analyzed, and workspace patterns beyond the cap. Faults are injected with
// fs spies, so the tests don't depend on permissions (which an elevated
// process might bypass).
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { FixtureSpace, pkg } from "./fixtures.js";

const CANARY = "CANARY-COVERAGE-41c9";
let space: FixtureSpace;
beforeAll(() => {
  space = new FixtureSpace();
});
afterAll(() => space.cleanup());
afterEach(() => vi.restoreAllMocks());

/** Makes opendir fail for one folder, as an unreadable folder would. */
function failOpendirFor(target: string) {
  const opendir = fs.promises.opendir;
  vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    if (path.resolve(String(p)) === target) {
      throw Object.assign(new Error(`EACCES: permission denied, opendir '${target}' ${CANARY}`), { code: "EACCES", path: target });
    }
    return (opendir as (...a: unknown[]) => unknown)(p, ...rest);
  }) as never);
}

/** Lets one folder open, then fails after its first entry (an error mid-listing). */
function failListingAfterFirstEntry(target: string) {
  const opendir = fs.promises.opendir;
  let yielded = 0;
  vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    const real = (await (opendir as (...a: unknown[]) => Promise<fs.Dir>)(p, ...rest)) as fs.Dir;
    if (path.resolve(String(p)) !== target) return real;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const entry of real) {
          yield entry;
          yielded++;
          throw Object.assign(new Error(`EIO: i/o error, scandir '${target}' ${CANARY}`), { code: "EIO" });
        }
      },
      close: () => real.close(),
    };
  }) as never);
  return () => yielded;
}

describe("unreadable folders", () => {
  it("a nested folder that can't be opened makes the result partial; other findings remain", async () => {
    const root = space.repo("locked nested", {
      "package.json": pkg({ name: "root-app" }),
      "apps/web/package.json": pkg({ name: "web" }),
      "apps/locked/package.json": pkg({ name: `locked-${CANARY}` }),
    });
    failOpendirFor(path.join(root, "apps", "locked"));

    const result = await scanRepository(root);

    expect(result.status).toBe("truncated");
    expect(result.partial).toBe(true);
    expect(result.limitsHit).toEqual([]); // not a limit: a coverage gap
    expect(result.skipped.unreadable).toBe(1);
    expect(result.warnings).toContainEqual({ code: "directory-unreadable", path: "apps/locked" });
    expect(result.packages.map((p) => p.name).sort()).toEqual(["root-app", "web"]);
    const json = JSON.stringify(result);
    expect(json).not.toContain(CANARY);
    expect(json).not.toMatch(/EACCES|permission denied/);
    expect(json).not.toContain(root);
  });

  it("a failure during listing (after opening) also makes the result partial", async () => {
    const root = space.repo("fails mid listing", {
      "package.json": pkg({ name: "root-app" }),
      "docs/a.md": "a",
      "docs/b.md": "b",
      "docs/c.md": "c",
      "lib/package.json": pkg({ name: "lib" }),
    });
    const yielded = failListingAfterFirstEntry(path.join(root, "docs"));

    const result = await scanRepository(root);

    expect(yielded()).toBe(1); // the folder opened and failed mid-iteration
    expect(result).toMatchObject({ status: "truncated", partial: true });
    expect(result.warnings).toContainEqual({ code: "directory-unreadable", path: "docs" });
    expect(result.packages.map((p) => p.name).sort()).toEqual(["lib", "root-app"]);
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`EIO|${CANARY}`));
  });

  it("an unreadable root listing is reported partial, not complete", async () => {
    const root = space.repo("locked root", { "package.json": pkg({ name: "x" }) });
    failOpendirFor(root);
    const result = await scanRepository(root);
    expect(result).toMatchObject({ status: "truncated", partial: true, packages: [] });
    expect(result.warnings).toEqual([{ code: "directory-unreadable", path: "" }]);
  });

  it("deliberately excluded folders and skipped links do not make a scan partial", async () => {
    const root = space.repo("excluded only", {
      "package.json": pkg({ name: "app" }),
      "node_modules/react/package.json": pkg({ name: "react" }),
      ".git/config": "[core]",
      "dist/out.js": "x",
      "coverage/index.html": "x",
      ".env": `KEY=${CANARY}`,
    });
    space.dirLink(path.join(root, "linked"), space.repo("link target", { "package.json": pkg({ name: "t" }) }));

    const result = await scanRepository(root);

    expect(result.skipped.excludedDirectories).toBe(4);
    expect(result.skipped.links).toBe(1);
    expect(result.skipped.sensitiveFiles).toBe(1);
    expect(result).toMatchObject({ status: "complete", partial: false });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe("allowed files that couldn't be analyzed (same inconsistency)", () => {
  it("an oversized package.json makes the result partial", async () => {
    const root = space.repo("oversized coverage", { "package.json": pkg({ name: "big", description: "x".repeat(5000) }) });
    const result = await scanRepository(root, { limits: { maxManifestBytes: 1000 } });
    expect(result).toMatchObject({ status: "truncated", partial: true });
    expect(result.skipped.oversized).toBe(1);
  });

  it("a package.json that changed during the scan is counted and makes the result partial", async () => {
    const root = space.repo("changed coverage", { "package.json": pkg({ name: "original" }) });
    const lstat = fs.promises.lstat;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike, opts?: never) => {
      const st = await lstat(p, opts);
      // Report the manifest as a non-file at its pre-open check.
      if (path.resolve(String(p)) === path.join(root, "package.json")) {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => false });
      }
      return st;
    }) as never);
    const result = await scanRepository(root);
    expect(result.skipped.changedDuringScan).toBe(1);
    expect(result.warnings).toEqual([{ code: "changed-during-scan", path: "package.json" }]);
    expect(result).toMatchObject({ status: "truncated", partial: true });
  });

  it("the changed-during-scan count survives a full warning list", async () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i < 5; i++) tree[`p${i}/package.json`] = pkg({ name: `p${i}` });
    const root = space.repo("changed many", tree);
    const lstat = fs.promises.lstat;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike, opts?: never) => {
      const st = await lstat(p, opts);
      if (String(p).endsWith("package.json")) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => false });
      return st;
    }) as never);
    const result = await scanRepository(root, { limits: { maxWarnings: 2 } });
    expect(result.warnings).toHaveLength(2);
    expect(result.warningsTruncated).toBe(true);
    expect(result.skipped.changedDuringScan).toBe(5);
    expect(result.status).toBe("truncated");
  });

  it("malformed manifests are read (repository content), so they alone don't make it partial", async () => {
    const root = space.repo("malformed coverage", { "package.json": "{ broken" });
    const result = await scanRepository(root);
    expect(result.warnings).toEqual([{ code: "manifest-malformed", path: "package.json" }]);
    expect(result).toMatchObject({ status: "complete", partial: false });
  });
});

describe("workspace pattern truncation", () => {
  const patterns = (n: number) => Array.from({ length: n }, (_, i) => `packages/group-${i}/*`);

  it("exactly 50 patterns: all listed, not truncated, complete", async () => {
    const root = space.repo("ws 50", { "package.json": pkg({ name: "mono", workspaces: patterns(50) }) });
    const result = await scanRepository(root);
    expect(result.workspace.patterns).toHaveLength(50);
    expect(result.workspace.patternsTruncated).toBe(false);
    expect(result.packages[0].workspacesTruncated).toBe(false);
    expect(result).toMatchObject({ status: "complete", partial: false });
  });

  it("more than 50 patterns: first 50 kept, flagged on the package and the result, partial", async () => {
    const root = space.repo("ws 51", { "package.json": pkg({ name: "mono", workspaces: patterns(51) }) });
    const result = await scanRepository(root);
    expect(result.workspace.patterns).toEqual(patterns(50));
    expect(result.workspace.patternsTruncated).toBe(true);
    expect(result.packages[0].workspaces).toHaveLength(50);
    expect(result.packages[0].workspacesTruncated).toBe(true);
    expect(result).toMatchObject({ status: "truncated", partial: true });
  });

  it("object form ({ packages: [...] }) is flagged the same way", async () => {
    const root = space.repo("ws object", { "package.json": pkg({ workspaces: { packages: patterns(60) } }) });
    const result = await scanRepository(root);
    expect(result.workspace.patterns).toHaveLength(50);
    expect(result.workspace.patternsTruncated).toBe(true);
    expect(result.status).toBe("truncated");
  });

  it("non-string entries don't count toward the cap", async () => {
    const root = space.repo("ws mixed", { "package.json": pkg({ workspaces: [...patterns(50), 1, null, { a: 1 }] }) });
    const result = await scanRepository(root);
    expect(result.workspace.patterns).toHaveLength(50);
    expect(result.workspace.patternsTruncated).toBe(false);
    expect(result.status).toBe("complete");
  });

  it("a nested package's truncated patterns also make the result partial", async () => {
    const root = space.repo("ws nested", { "package.json": pkg({ name: "root" }), "sub/package.json": pkg({ name: "sub", workspaces: patterns(55) }) });
    const result = await scanRepository(root);
    expect(result.workspace.patternsTruncated).toBe(false); // root package didn't declare any
    expect(result.packages.find((p) => p.name === "sub")?.workspacesTruncated).toBe(true);
    expect(result.status).toBe("truncated");
  });

  it("patterns stay text: none of them is traversed", async () => {
    const outside = space.repo("ws outside", { "package.json": pkg({ name: `outside-${CANARY}` }) });
    const root = space.repo("ws traversal", { "package.json": pkg({ workspaces: [...patterns(50), "../ws outside", outside] }) });
    const listed: string[] = [];
    const opendir = fs.promises.opendir;
    vi.spyOn(fs.promises, "opendir").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      listed.push(path.resolve(String(p)));
      return (opendir as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    const result = await scanRepository(root);
    expect(listed.every((p) => p === root || p.startsWith(root + path.sep))).toBe(true);
    expect(result.workspace.patternsTruncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("result-size fitting that drops patterns flags them and keeps the cap", async () => {
    const long = Array.from({ length: 50 }, (_, i) => `${"w".repeat(180)}/${i}`);
    const root = space.repo("ws fit", { "package.json": pkg({ name: "mono", workspaces: long }) });
    const limit = 2500;
    const result = await scanRepository(root, { limits: { maxResultBytes: limit } });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(limit);
    expect(result.workspace.patterns).toEqual([]);
    expect(result.workspace.patternsTruncated).toBe(true);
    expect(result.limitsHit).toContain("result-size");
    expect(result).toMatchObject({ status: "truncated", partial: true });
  });
});
