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

// PR #76: the cap applies to the response as sent. limitsHit, status and
// partial are filled in after trimming, which made results up to ~15 bytes
// larger than the cap at some caps (2,004 bytes at a 2,000-byte cap on Linux).
describe("the cap includes the final metadata", () => {
  let space: FixtureSpace;
  const CANARY = "CANARY-FIT-FINAL-5c21";
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());
  afterEach(() => vi.restoreAllMocks());

  /** 40 packages with long dependency lists and a root workspace declaration (so workspacesExact is present). */
  function workspaceRepo(extra: Record<string, string> = {}) {
    const deps = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`dependency-name-${i}-${"x".repeat(40)}`, "1"]));
    const tree: Record<string, string> = { ".env": `SECRET=${CANARY}`, "package.json": pkg({ name: "root", private: true, workspaces: ["p*"] }), ...extra };
    for (let i = 0; i < 40; i++) tree[`p${i}/package.json`] = pkg({ name: `p${i}`, dependencies: deps, scripts: { build: "tsc" } });
    return tree;
  }
  /**
   * A scan whose stats.durationMs is exactly `ms`. The size cap counts the
   * result as sent, durationMs included, so a cap taken from one scan's size
   * only means the same thing for a later scan if both report a duration of
   * the same width (issue #83: 10 ms vs 9 ms is one byte). Date.now() returns
   * the scan's start on the first call and start + ms afterwards.
   */
  async function scanTaking(ms: number, root: string, options?: Parameters<typeof scanRepository>[1]) {
    const realNow = Date.now.bind(Date);
    let start: number | undefined;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (start === undefined ? (start = realNow()) : start + ms));
    try {
      return await scanRepository(root, options);
    } finally {
      clock.mockRestore();
    }
  }
  const DURATION_MS = 7;

  it("every cap in a dense sweep: never over the cap, flagged, partial, no secrets", async () => {
    const root = space.repo("fit final sweep", workspaceRepo());
    const fullSize = bytes(await scanTaking(DURATION_MS, root));
    const caps = new Set<number>([2_000]);
    for (let cap = 1_500; cap <= 4_000; cap += 9) caps.add(cap);
    for (let cap = 1_990; cap <= 2_010; cap++) caps.add(cap);
    for (const cap of [Math.floor(fullSize / 2), fullSize - 20, fullSize - 1]) caps.add(cap);
    for (const cap of caps) {
      const result = await scanTaking(DURATION_MS, root, { limits: { maxResultBytes: cap } });
      expect(result.stats.durationMs).toBe(DURATION_MS);
      expect(bytes(result), `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(result.limitsHit, `cap ${cap}`).toContain("result-size");
      expect(result, `cap ${cap}`).toMatchObject({ status: "truncated", partial: true });
      expect(result.packagesTruncated || result.packages.some((p) => p.dependenciesTruncated), `cap ${cap}`).toBe(true);
      expect(JSON.stringify(result)).not.toContain(CANARY);
      for (const p of result.packages) expect(typeof p.workspacesExact).toBe("boolean");
    }
  }, 120_000);

  it("at and above the full size nothing changes: complete, no flags, identical output", async () => {
    const root = space.repo("fit final unchanged", workspaceRepo());
    const full = await scanTaking(DURATION_MS, root);
    expect(full.status).toBe("complete");
    for (const cap of [bytes(full), bytes(full) + 1, bytes(full) + 5_000]) {
      const result = await scanTaking(DURATION_MS, root, { limits: { maxResultBytes: cap } });
      expect(result, `cap ${cap}`).toEqual(full);
    }
  });

  it("just below the full size: the smallest trim, and the status turns truncated within the cap", async () => {
    const root = space.repo("fit final threshold", workspaceRepo());
    const full = await scanTaking(DURATION_MS, root);
    const cap = bytes(full) - 1;
    const result = await scanTaking(DURATION_MS, root, { limits: { maxResultBytes: cap } });
    expect(bytes(result)).toBeLessThanOrEqual(cap);
    expect([result.status, result.partial, result.limitsHit]).toEqual(["truncated", true, ["result-size"]]);
    // Priority order: warnings (none here), then dependency lists from the first package on.
    expect(result.packages.length).toBe(full.packages.length);
    expect(result.packages.find((p) => p.dependencies.length > 0 || p.devDependencies.length > 0)).toBeDefined();
    const firstWithDeps = full.packages.findIndex((p) => p.dependencies.length > 0 || p.devDependencies.length > 0);
    expect(result.packages.findIndex((p) => p.dependenciesTruncated)).toBe(firstWithDeps);
  });

  it("the cap counts the result's own durationMs: one digit fewer can fit a cap a longer-running scan would exceed (#83)", async () => {
    const root = space.repo("fit final duration", workspaceRepo());
    const tenMs = await scanTaking(10, root);
    const cap = bytes(tenMs) - 1;
    // The same result, taking 9 ms, is one byte smaller and fits untouched...
    const nineMs = await scanTaking(9, root, { limits: { maxResultBytes: cap } });
    expect(bytes(nineMs)).toBe(cap);
    expect(nineMs).toEqual({ ...tenMs, stats: { ...tenMs.stats, durationMs: 9 } });
    // ...while taking 10 ms it's one byte over, so it's trimmed within the cap.
    const trimmed = await scanTaking(10, root, { limits: { maxResultBytes: cap } });
    expect(bytes(trimmed)).toBeLessThanOrEqual(cap);
    expect([trimmed.status, trimmed.partial, trimmed.limitsHit]).toEqual(["truncated", true, ["result-size"]]);
  });

  it("limitsHit that is already long before trimming is counted too", async ({ signal }) => {
    // depth > maxDepth adds "depth" before fitting, so limitsHit ends as ["depth", "result-size"].
    const root = space.repo("fit final depth", workspaceRepo({ "a/b/c/d/package.json": pkg({ name: "deep" }) }));
    const caps: number[] = [];
    for (let cap = 1_800; cap <= 2_400; cap += 7) caps.push(cap);
    expect(caps).toHaveLength(86);
    // Issue #93: 86 real scans one after another took about 5 s on Windows
    // (each scan awaits ~450 filesystem calls in turn), over the default test
    // timeout. The scans only read the same fixture and share no state, so
    // they run at most four at a time. Each batch settles completely before
    // its results are checked or the next batch starts, so no scan outlives
    // the test; after a timeout no further batch is started.
    const BATCH = 4;
    const checked: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const scan = async (cap: number) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        return await scanRepository(root, { limits: { maxResultBytes: cap, maxDepth: 2 } });
      } finally {
        inFlight--;
      }
    };
    for (let i = 0; i < caps.length; i += BATCH) {
      signal.throwIfAborted();
      const batch = caps.slice(i, i + BATCH);
      const outcomes = await Promise.allSettled(batch.map(scan));
      outcomes.forEach((outcome, j) => {
        const cap = batch[j];
        // A failed scan fails the test with its own error.
        if (outcome.status === "rejected") throw outcome.reason;
        const result = outcome.value;
        expect(bytes(result), `cap ${cap}`).toBeLessThanOrEqual(cap);
        expect(result.limitsHit, `cap ${cap}`).toEqual(expect.arrayContaining(["depth", "result-size"]));
        checked.push(cap);
      });
    }
    // Every cap was scanned and checked, in order, never more than four at a time.
    expect(checked).toEqual(caps);
    expect(maxInFlight).toBeLessThanOrEqual(BATCH);
    expect(inFlight).toBe(0);
  });

  /** A scan stopped (cancelled or timed out) while a late folder's listing is held, after all packages were read. */
  async function stoppedScan(root: string, cap: number, how: "cancel" | "timeout") {
    const opendir = fs.promises.opendir;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const spy = vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === path.join(root, "zz", "late")) {
        enter();
        await gate;
      }
      return (opendir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as never);
    const controller = new AbortController();
    const run = startScan(root, { signal: controller.signal, limits: { maxResultBytes: cap, ...(how === "timeout" ? { timeBudgetMs: 400 } : {}) } });
    await entered;
    if (how === "cancel") controller.abort();
    const result = await run.result;
    release();
    await run.settled;
    spy.mockRestore();
    return result;
  }

  it.each(["cancel", "timeout"] as const)("%s: stopped snapshots stay within the cap and keep their status", async (how) => {
    const root = space.repo(`fit final ${how}`, workspaceRepo({ "zz/late/readme.txt": "x" }));
    for (const cap of [1_700, 2_000, 2_003, 3_100]) {
      const result = await stoppedScan(root, cap, how);
      expect(bytes(result), `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect([result.status, result.partial], `cap ${cap}`).toEqual([how === "cancel" ? "cancelled" : "timed-out", true]);
      expect(result.limitsHit, `cap ${cap}`).toContain("result-size");
      if (how === "timeout") expect(result.limitsHit).toContain("time");
      expect(JSON.stringify(result)).not.toContain(CANARY);
    }
  }, 60_000);
});
