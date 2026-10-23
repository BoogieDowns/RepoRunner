// Resource limits, partial results, timeout, cancellation and the
// one-scan-at-a-time session. Small limit overrides keep fixtures fast; one
// test runs the real defaults on a moderately large repository.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { SCAN_LIMITS } from "../../../electron/repoScanner/scanRules.js";
import { RepoScanSession } from "../../../electron/repoScanner/scanSession.js";
import { RepoScanError } from "../../../electron/repoScanner/types.js";
import { FixtureSpace, pkg } from "./fixtures.js";

let space: FixtureSpace;
beforeAll(() => {
  space = new FixtureSpace();
});
afterAll(() => space.cleanup());
afterEach(() => vi.restoreAllMocks());

const serialized = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

/** Delays every opendir so time-based behaviour is observable. Returns the call log. */
function slowOpendir(delayMs: number) {
  const calls: string[] = [];
  const opendir = fs.promises.opendir;
  vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    calls.push(String(p));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return (opendir as (...a: unknown[]) => unknown)(p, ...rest);
  }) as never);
  return calls;
}

function wideTree(dirs: number, filesPerDir = 0): Record<string, string> {
  const tree: Record<string, string> = {};
  for (let d = 0; d < dirs; d++) {
    tree[`d${d}/package.json`] = pkg({ name: `p${d}` });
    for (let f = 0; f < filesPerDir; f++) tree[`d${d}/f${f}.txt`] = "x";
  }
  return tree;
}

describe("default limits", () => {
  it("match the approved values", () => {
    expect(SCAN_LIMITS).toMatchObject({
      maxDepth: 8,
      maxEntries: 20_000,
      maxDirectories: 5_000,
      maxPackageJsonFiles: 200,
      maxManifestBytes: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      timeBudgetMs: 10_000,
      maxResultBytes: 512 * 1024,
      maxScriptsPerPackage: 100,
      maxDependencyNames: 300,
    });
  });

  it("a moderately large repository completes within the defaults", async () => {
    const root = space.repo("large default", wideTree(60, 30));
    const started = Date.now();
    const result = await scanRepository(root);
    expect(result.status).toBe("complete");
    expect(result.packages).toHaveLength(60);
    expect(result.stats.entriesExamined).toBe(60 + 60 * 31);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("limits produce clearly partial results", () => {
  it("depth: folders deeper than the limit are not entered", async () => {
    const deep = Array.from({ length: 12 }, (_, i) => `l${i}`).join("/");
    const root = space.repo("deep", { [`${deep}/package.json`]: pkg({ name: "too-deep" }), "l0/l1/package.json": pkg({ name: "shallow" }) });
    const result = await scanRepository(root);
    expect(result.packages.map((p) => p.name)).toEqual(["shallow"]);
    expect(result.limitsHit).toContain("depth");
    expect(result.skipped.depthLimited).toBe(1);
    expect(result).toMatchObject({ status: "truncated", partial: true });
  });

  it("entries examined", async () => {
    const root = space.repo("many entries", wideTree(1, 300));
    const result = await scanRepository(root, { limits: { maxEntries: 100 } });
    expect(result.stats.entriesExamined).toBe(100);
    expect(result.limitsHit).toContain("entries");
    expect(result.partial).toBe(true);
  });

  it("directories visited", async () => {
    const root = space.repo("many dirs", wideTree(30));
    const result = await scanRepository(root, { limits: { maxDirectories: 10 } });
    expect(result.stats.directoriesVisited).toBe(10);
    expect(result.limitsHit).toContain("directories");
  });

  it("package.json count", async () => {
    const root = space.repo("many packages", wideTree(8));
    const result = await scanRepository(root, { limits: { maxPackageJsonFiles: 3 } });
    expect(result.packages).toHaveLength(3);
    expect(result.limitsHit).toContain("manifests");
    expect(result.warnings.filter((w) => w.code === "manifest-limit-reached")).toHaveLength(1);
  });

  it("oversized package.json is not read", async () => {
    const root = space.repo("oversized", { "package.json": pkg({ name: "big", description: "x".repeat(5000) }) });
    const open = vi.spyOn(fs.promises, "open");
    const result = await scanRepository(root, { limits: { maxManifestBytes: 1000 } });
    expect(result.packages).toEqual([]);
    expect(result.skipped.oversized).toBe(1);
    expect(result.warnings).toEqual([{ code: "manifest-oversized", path: "package.json" }]);
    // Only the root directory handle; the oversized file itself is never opened.
    expect(open.mock.calls.map((call) => path.resolve(String(call[0])))).toEqual([root]);
  });

  it("total byte budget", async () => {
    const root = space.repo("byte budget", wideTree(6));
    const result = await scanRepository(root, { limits: { maxTotalBytes: 60 } });
    expect(result.stats.bytesRead).toBeLessThanOrEqual(60);
    expect(result.limitsHit).toContain("bytes");
    expect(result.packages.length).toBeLessThan(6);
  });

  it("scripts and dependency names per package", async () => {
    const scripts = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`s${i}`, "echo"]));
    const dependencies = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`dep${i}`, "1"]));
    const root = space.repo("big package", { "package.json": pkg({ name: "big", scripts, dependencies }) });
    const [summary] = (await scanRepository(root)).packages;
    expect(summary.scripts).toHaveLength(100);
    expect(summary.scriptsTruncated).toBe(true);
    expect(summary.dependencies).toHaveLength(300);
    expect(summary.dependenciesTruncated).toBe(true);
  });

  it("serialized result size", async () => {
    const dependencies = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`some-fairly-long-dependency-name-${i}`, "1"]));
    const tree: Record<string, string> = {};
    for (let i = 0; i < 10; i++) tree[`pkg${i}/package.json`] = pkg({ name: `p${i}`, dependencies });
    const root = space.repo("result size", tree);
    const result = await scanRepository(root, { limits: { maxResultBytes: 20_000 } });
    expect(serialized(result)).toBeLessThanOrEqual(20_000);
    expect(result.limitsHit).toContain("result-size");
    expect(result.status).toBe("truncated");
  });

  it("size enforcement also covers warnings, long file names and metadata", async () => {
    const tree: Record<string, string> = {
      "package.json": pkg({ name: "root", workspaces: Array.from({ length: 50 }, (_, i) => `${"w".repeat(180)}/${i}`) }),
    };
    const longDir = "d".repeat(120);
    for (let i = 0; i < 60; i++) {
      tree[`${longDir}${i}/package.json`] = "{ broken"; // one warning each, long paths
      tree[`${longDir}${i}/.env.${"e".repeat(60)}`] = "x";
      tree[`${longDir}${i}/tsconfig.${"t".repeat(60)}.json`] = "{}";
    }
    const root = space.repo("size metadata", tree);
    for (const limit of [64_000, 16_000, 4_000]) {
      const result = await scanRepository(root, { limits: { maxResultBytes: limit } });
      expect(serialized(result), `limit ${limit}`).toBeLessThanOrEqual(limit);
      expect(result.limitsHit).toContain("result-size");
      expect(result.partial).toBe(true);
    }
  });

  it("the default 512 KiB cap holds for a maximal repository", async () => {
    const dependencies = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`dependency-name-${"x".repeat(60)}-${i}`, "1"]));
    const tree: Record<string, string> = {};
    for (let i = 0; i < 40; i++) tree[`pkg${i}/package.json`] = pkg({ name: `p${i}`, dependencies, devDependencies: dependencies });
    const result = await scanRepository(space.repo("max result", tree));
    expect(serialized(result)).toBeLessThanOrEqual(512 * 1024);
  });
});

describe("timeout and cancellation", () => {
  it("the time budget stops further work and marks the result timed-out", async () => {
    const root = space.repo("slow", wideTree(20));
    const calls = slowOpendir(40);
    const result = await scanRepository(root, { limits: { timeBudgetMs: 150 } });
    const callsAtEnd = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(result).toMatchObject({ status: "timed-out", partial: true });
    expect(result.limitsHit).toContain("time");
    expect(callsAtEnd).toBeLessThan(21);
    expect(calls.length).toBe(callsAtEnd); // nothing scheduled afterwards
  });

  it("aborting stops further reads and returns a cancelled result", async () => {
    const root = space.repo("cancel me", wideTree(20));
    const calls = slowOpendir(20);
    const controller = new AbortController();
    const scanning = scanRepository(root, { signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    const result = await scanning;
    const callsAtEnd = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(result).toMatchObject({ status: "cancelled", partial: true });
    expect(result.limitsHit).not.toContain("time");
    expect(callsAtEnd).toBeLessThan(21);
    expect(calls.length).toBe(callsAtEnd);
  });

  it("an already-aborted signal reads nothing", async () => {
    const root = space.repo("pre-aborted", { "package.json": pkg({ name: "x" }) });
    const opendir = vi.spyOn(fs.promises, "opendir");
    const controller = new AbortController();
    controller.abort();
    const result = await scanRepository(root, { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(opendir).not.toHaveBeenCalled();
  });

  it("no timers are left behind after complete, timed-out or cancelled scans", async () => {
    const root = space.repo("timer check", wideTree(3));
    const before = timers();
    await scanRepository(root);
    await scanRepository(root, { limits: { timeBudgetMs: 0 } });
    const controller = new AbortController();
    controller.abort();
    await scanRepository(root, { signal: controller.signal });
    expect(timers()).toBe(before);
  });
});

describe("one scan at a time", () => {
  it("a concurrent request is rejected; ownership is released afterwards", async () => {
    const root = space.repo("session", wideTree(5));
    slowOpendir(20);
    const session = new RepoScanSession();

    const first = session.scan(root);
    expect(session.isScanning).toBe(true);
    const second = await session.scan(root).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(RepoScanError);
    expect((second as RepoScanError).code).toBe("scan-in-progress");

    await first;
    expect(session.isScanning).toBe(false);
    await expect(session.scan(root)).resolves.toMatchObject({ status: "complete" });
  });

  it("cancel() stops the active scan; a new scan waits for ownership and is unaffected", async () => {
    const root = space.repo("session cancel", wideTree(10));
    slowOpendir(20);
    const session = new RepoScanSession();

    const first = session.scan(root);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.cancel()).toBe(true);
    // Still owned until the cancelled scan has actually finished.
    await expect(session.scan(root)).rejects.toMatchObject({ code: "scan-in-progress" });
    const cancelled = await first;
    expect(cancelled.status).toBe("cancelled");

    vi.restoreAllMocks();
    const next = await session.scan(root);
    expect(next.status).toBe("complete");
    expect(next).not.toBe(cancelled);
    expect(next.packages).toHaveLength(10);
    expect(cancelled.status).toBe("cancelled"); // the old result was not modified
    expect(session.cancel()).toBe(false);
  });

  it("ownership is released when the scan fails", async () => {
    const session = new RepoScanSession();
    await expect(session.scan("relative/path")).rejects.toMatchObject({ code: "invalid-path" });
    expect(session.isScanning).toBe(false);
  });
});
