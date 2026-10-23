// Result-size fitting: the optimized trimming must make exactly the same
// decisions as the previous algorithm (kept below as a reference), never
// exceed the cap, keep every truncation flag, and not re-serialize the whole
// result after each removed item.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fitResultSize, scanRepository, startScan } from "../../../electron/repoScanner/scanRepository.js";
import type { PackageSummary, RepoScanLimit, RepoScanResult } from "../../../electron/repoScanner/types.js";
import { FixtureSpace, cp, pkg } from "./fixtures.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const clone = <T>(value: T): T => structuredClone(value);

/** The previous implementation, verbatim apart from the measuring hook. */
function referenceFit(result: RepoScanResult, maxBytes: number, limitsHit: Set<RepoScanLimit>, measure = bytes): void {
  const steps: Array<() => boolean> = [
    () => {
      if (result.warnings.length === 0) return false;
      result.warnings.splice(Math.floor(result.warnings.length / 2));
      result.warningsTruncated = true;
      return true;
    },
    () => {
      const p = result.packages.find((x) => x.dependencies.length > 0 || x.devDependencies.length > 0);
      if (!p) return false;
      p.dependencies = [];
      p.devDependencies = [];
      p.dependenciesTruncated = true;
      return true;
    },
    () => {
      if (result.manifests.length === 0) return false;
      result.manifests.splice(Math.floor(result.manifests.length / 2));
      result.manifestsTruncated = true;
      return true;
    },
    () => {
      if (result.packages.length === 0) return false;
      result.packages.pop();
      result.packagesTruncated = true;
      return true;
    },
    () => {
      if (result.envFiles.length === 0) return false;
      result.envFiles.splice(Math.floor(result.envFiles.length / 2));
      result.envFilesTruncated = true;
      return true;
    },
    () => {
      if (result.packageManager.lockfiles.length === 0 && result.nodeVersionFiles.length === 0) return false;
      result.packageManager.lockfiles = [];
      result.nodeVersionFiles = [];
      return true;
    },
    () => {
      if (result.workspace.patterns.length === 0) return false;
      result.workspace.patterns = [];
      result.workspace.patternsTruncated = true;
      return true;
    },
  ];
  let size = measure(result);
  for (const step of steps) {
    while (size > maxBytes && step()) {
      limitsHit.add("result-size");
      size = measure(result);
    }
    if (size <= maxBytes) return;
  }
}

/** A deterministic result with every trimmable section, including multi-byte and JSON-escaped text. */
function bigResult(packages: number, depsPerPackage: number): RepoScanResult {
  const odd = `名前ü🙂"\\${cp(0x07)}`; // multi-byte, quote, backslash, control char (escaped in JSON)
  const pkgs: PackageSummary[] = Array.from({ length: packages }, (_, i) => ({
    path: `packages/p${i}/package.json`,
    name: `pkg-${i}-${odd}`,
    version: "1.0.0",
    private: i % 2 === 0,
    packageManager: i === 0 ? "pnpm@9.1.0" : null,
    engines: { node: i % 3 === 0 ? ">=20" : null },
    scripts: Array.from({ length: 5 }, (_, s) => ({ name: `s${s}`, command: `node ${odd} --flag ${s}` })),
    scriptsTruncated: false,
    dependencies: Array.from({ length: depsPerPackage }, (_, d) => `dep-${i}-${d}-${odd}`),
    devDependencies: Array.from({ length: Math.floor(depsPerPackage / 2) }, (_, d) => `dev-${i}-${d}`),
    dependenciesTruncated: i % 5 === 0, // some already flagged
    workspaces: i === 0 ? ["apps/*", "packages/*"] : [],
    workspacesTruncated: false,
  }));
  return {
    status: "complete",
    partial: false,
    limitsHit: [],
    rootName: `root ${odd}`,
    stats: { directoriesVisited: 10, entriesExamined: 100, filesRead: packages, bytesRead: 1000, durationMs: 5 },
    manifests: Array.from({ length: 40 }, (_, i) => ({ path: `m${i}/package.json`, kind: "package-json" as const })),
    manifestsTruncated: false,
    packages: pkgs,
    packagesTruncated: false,
    nodeVersionFiles: [{ path: ".nvmrc", version: "20" }],
    workspace: { signals: ["npm-workspaces"], patterns: Array.from({ length: 20 }, (_, i) => `group-${i}/*`), patternsTruncated: false },
    packageManager: { lockfiles: [{ path: "pnpm-lock.yaml", manager: "pnpm" }], declared: "pnpm@9.1.0" },
    envFiles: Array.from({ length: 12 }, (_, i) => `.env.${i}`),
    envFilesTruncated: false,
    skipped: { links: 0, excludedDirectories: 0, sensitiveFiles: 12, depthLimited: 0, unreadable: 0, oversized: 0, otherTypes: 0, changedDuringScan: 0 },
    warnings: Array.from({ length: 30 }, (_, i) => ({ code: "manifest-malformed" as const, path: `w${i}/package.json` })),
    warningsTruncated: false,
  };
}

function runBoth(source: RepoScanResult, cap: number) {
  const a = clone(source);
  const b = clone(source);
  const limitsA = new Set<RepoScanLimit>();
  const limitsB = new Set<RepoScanLimit>();
  const exact = fitResultSize(a, cap, limitsA);
  referenceFit(b, cap, limitsB);
  return { optimized: a, reference: b, limitsA, limitsB, exact };
}

describe("same decisions as the previous algorithm", () => {
  it.each([
    ["a few packages", 8, 40, 60],
    ["many packages", 120, 60, 24],
    ["maximum package count", 200, 30, 12], // fewer caps: the old algorithm is slow here
  ])("%s: identical output and flags at every cap from tiny to above the full size", (_label, packages, deps, steps) => {
    const source = bigResult(packages, deps);
    const full = bytes(source);
    const caps = new Set<number>([full + 100, full, full - 1, 1, 10, 500, 2_000]);
    for (let i = 1; i < steps; i++) caps.add(Math.floor((full * i) / steps));
    for (const cap of caps) {
      const { optimized, reference, limitsA, limitsB, exact } = runBoth(source, cap);
      expect(optimized, `cap ${cap}`).toEqual(reference);
      // The byte accounting was exact: the slow safety net was never needed.
      if (bytes(reference) <= cap) expect(exact, `cap ${cap}`).toBe(true);
      expect([...limitsA], `cap ${cap}`).toEqual([...limitsB]);
      if (bytes(reference) <= cap) expect(bytes(optimized), `cap ${cap}`).toBeLessThanOrEqual(cap);
    }
  }, 60_000);

  it("caps exactly at every intermediate size: identical stopping points (catches any byte-accounting error)", () => {
    for (const [packages, deps] of [[12, 15], [40, 8]] as const) {
      const source = bigResult(packages, deps);
      // Every size the previous algorithm passes through while trimming down to 1 byte.
      const sizes: number[] = [];
      referenceFit(clone(source), 1, new Set(), (v) => {
        const n = bytes(v);
        sizes.push(n);
        return n;
      });
      for (const cap of new Set(sizes.flatMap((n) => [n, n - 1]))) {
        const { optimized, reference, exact } = runBoth(source, cap);
        expect(optimized, `cap ${cap}`).toEqual(reference);
        if (bytes(reference) <= cap) expect(exact, `cap ${cap}`).toBe(true);
      }
    }
  }, 60_000);

  it("each priority stage is reached in order, with its flag set", () => {
    const source = bigResult(30, 40);
    const full = bytes(source);
    const seen = new Set<string>();
    const caps = [...Array.from({ length: 59 }, (_, i) => Math.floor((full * (59 - i)) / 60)), 3_000, 2_000, 1_500, 1_200, 1_000, 800, 1];
    for (const cap of caps) {
      const { optimized } = runBoth(source, cap);
      if (optimized.warningsTruncated) seen.add("warnings");
      if (optimized.packages.some((p, idx) => p.dependenciesTruncated && !source.packages[idx].dependenciesTruncated)) seen.add("dependencies");
      if (optimized.manifestsTruncated) seen.add("manifests");
      if (optimized.packagesTruncated) seen.add("packages");
      if (optimized.envFilesTruncated) seen.add("env files");
      if (optimized.packageManager.lockfiles.length === 0) seen.add("lockfiles");
      if (optimized.workspace.patternsTruncated) seen.add("patterns");
    }
    expect([...seen]).toEqual(["warnings", "dependencies", "manifests", "packages", "env files", "lockfiles", "patterns"]);
  });

  it("a result already under the cap is left untouched", () => {
    const source = bigResult(5, 5);
    const copy = clone(source);
    const limits = new Set<RepoScanLimit>();
    fitResultSize(copy, bytes(source), limits);
    expect(copy).toEqual(source);
    expect([...limits]).toEqual([]);
  });

  it("a result one byte over the cap is trimmed minimally, like before", () => {
    const source = bigResult(10, 10);
    const { optimized, reference } = runBoth(source, bytes(source) - 1);
    expect(optimized).toEqual(reference);
    expect(optimized.warningsTruncated).toBe(true);
    expect(optimized.packagesTruncated).toBe(false);
  });

  it("output stays plain, stable JSON", () => {
    const source = bigResult(50, 20);
    const { optimized } = runBoth(source, Math.floor(bytes(source) / 3));
    expect(JSON.parse(JSON.stringify(optimized))).toEqual(optimized);
  });
});

describe("cost: no full re-serialization per removed item", () => {
  it("measures the whole result a bounded number of times while dropping hundreds of items", () => {
    const source = bigResult(200, 30);
    const cap = Math.floor(bytes(source) / 20); // forces dependency clearing and many package drops
    let optimizedMeasures = 0;
    let referenceMeasures = 0;
    const a = clone(source);
    const b = clone(source);
    fitResultSize(a, cap, new Set(), (v) => (optimizedMeasures++, bytes(v)));
    referenceFit(b, cap, new Set(), (v) => (referenceMeasures++, bytes(v)));
    expect(a).toEqual(b);
    const removedItems = 200 - a.packages.length + a.packages.filter((p) => p.dependenciesTruncated).length;
    expect(removedItems).toBeGreaterThan(150);
    expect(referenceMeasures).toBeGreaterThan(removedItems); // the old cost grew with every item
    expect(optimizedMeasures).toBeLessThanOrEqual(25); // now bounded by the ~log2 halving steps
  });

  it("if the byte accounting were ever off, the cap still holds and the outcome is unchanged (safety net)", () => {
    const source = bigResult(60, 20);
    // A measure smaller than the real bytes makes the accounting overestimate each saving.
    const deflated = (v: unknown) => Math.floor(bytes(v) * 0.8);
    const cap = Math.floor(deflated(source) / 4);
    const copy = clone(source);
    const exact = fitResultSize(copy, cap, new Set(), deflated);
    expect(exact).toBe(false); // the safety net ran
    expect(deflated(copy)).toBeLessThanOrEqual(cap);
    const reference = clone(source);
    referenceFit(reference, cap, new Set(), deflated);
    expect(copy).toEqual(reference);
  });
});

describe("in real scans", () => {
  let space: FixtureSpace;
  const CANARY = "CANARY-FIT-73ab";
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());
  afterEach(() => vi.restoreAllMocks());

  function manyPackages(n: number) {
    const tree: Record<string, string> = { ".env": `SECRET=${CANARY}` };
    const deps = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`dependency-name-${i}-${"x".repeat(40)}`, "1"]));
    for (let i = 0; i < n; i++) tree[`p${i}/package.json`] = pkg({ name: `p${i}`, dependencies: deps, scripts: { build: "tsc" } });
    return tree;
  }

  it("small caps are enforced with flags and partial status; secrets never appear", async () => {
    const root = space.repo("fit real", manyPackages(40));
    const fullSize = bytes(await scanRepository(root));
    for (const cap of [Math.floor(fullSize * 0.9), Math.floor(fullSize / 3), 8_000, 2_000]) {
      const result = await scanRepository(root, { limits: { maxResultBytes: cap } });
      expect(bytes(result), `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(result.limitsHit).toContain("result-size");
      expect(result).toMatchObject({ status: "truncated", partial: true });
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
    const full = await scanRepository(root);
    expect(full.status).toBe("complete"); // the default cap isn't reached here
  });

  it("cancelled and timed-out snapshots are fitted too and keep their status", async () => {
    // "zz/late" is at depth 2: breadth-first order lists it only after every
    // depth-1 folder (all 30 packages), whatever order the OS returns entries in.
    const root = space.repo("fit snapshot", { ...manyPackages(30), "zz/late/readme.txt": "x" });
    // Hold that listing so the scan is stopped after the packages were read.
    const opendir = fs.promises.opendir;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === path.join(root, "zz", "late")) {
        enter();
        await gate;
      }
      return (opendir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as never);

    const controller = new AbortController();
    const run = startScan(root, { signal: controller.signal, limits: { maxResultBytes: 6_000 } });
    await entered;
    controller.abort();
    const cancelled = await run.result;
    expect(cancelled.stats.filesRead).toBe(30); // stopped after all packages were read
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.partial).toBe(true);
    expect(bytes(cancelled)).toBeLessThanOrEqual(6_000);
    expect(cancelled.limitsHit).toContain("result-size");
    release();
    await run.settled;
  });
});
