// Blocked filesystem calls (Finding A) and unknown directory-entry types
// (Finding B). Blocking is simulated with deferred gates on fs.promises, so
// no real hanging drive is needed.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scanRepository, startScan } from "../../../electron/repoScanner/scanRepository.js";
import { RepoScanSession } from "../../../electron/repoScanner/scanSession.js";
import { FixtureSpace, pkg } from "./fixtures.js";

const CANARY = "CANARY-BLOCKING-5d0e";
let space: FixtureSpace;
beforeAll(() => {
  space = new FixtureSpace();
});
afterAll(() => space.cleanup());
afterEach(() => vi.restoreAllMocks());

type FsMethod = "realpath" | "open" | "opendir" | "lstat";

/** Holds the first matching call to fs.promises[method] until released. */
function blockFs(method: FsMethod, matches: (p: string) => boolean) {
  const original = fs.promises[method] as (...a: unknown[]) => Promise<unknown>;
  let release!: (error?: Error) => void;
  const gate = new Promise<Error | undefined>((resolve) => (release = resolve));
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  let blocked = false;
  vi.spyOn(fs.promises, method).mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    if (!blocked && matches(path.resolve(String(p)))) {
      blocked = true;
      enter();
      const error = await gate;
      if (error) throw error;
    }
    return original(p, ...rest);
  }) as never);
  return { entered, release };
}

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms))]);
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

describe("Finding A: cancel and timeout answer promptly while a filesystem call is blocked", () => {
  it("cancel during root resolution: prompt cancelled answer; ownership held until the call returns; no overlap", async () => {
    const root = space.repo("block realpath", { "package.json": pkg({ name: "x" }) });
    const gate = blockFs("realpath", (p) => p === root);
    const opendir = vi.spyOn(fs.promises, "opendir");
    const session = new RepoScanSession();

    const scanning = session.scan(root);
    await gate.entered;
    session.cancel();
    const result = await within(scanning, 500);

    expect(result).toMatchObject({ status: "cancelled", partial: true, rootName: "block realpath", packages: [] });
    expect(session.isScanning).toBe(true);
    expect(session.isFinishing).toBe(true);
    await expect(session.scan(root)).rejects.toMatchObject({ code: "scan-in-progress" });

    gate.release();
    expect(await session.waitUntilIdle(2000)).toBe(true);
    expect(opendir).not.toHaveBeenCalled(); // the stopped work did nothing more
    vi.restoreAllMocks();
    await expect(session.scan(root)).resolves.toMatchObject({ status: "complete" });
  });

  it("timeout during root-device detection answers timed-out at the budget", async () => {
    const root = space.repo("block root handle", { "package.json": pkg({ name: "x" }) });
    const gate = blockFs("open", (p) => p === root);
    const run = startScan(root, { limits: { timeBudgetMs: 100 } });
    await gate.entered;
    const started = Date.now();
    const result = await within(run.result, 1000);
    expect(Date.now() - started).toBeLessThan(800);
    expect(result).toMatchObject({ status: "timed-out", partial: true });
    expect(result.limitsHit).toContain("time");
    gate.release();
    await within(run.settled, 2000);
  });

  it("cancel during a pending directory listing keeps earlier findings; the late listing changes nothing", async () => {
    const root = space.repo("block opendir", { "package.json": pkg({ name: "root-app" }), "sub/package.json": pkg({ name: `sub-${CANARY}` }) });
    const gate = blockFs("opendir", (p) => p === path.join(root, "sub"));
    const controller = new AbortController();
    const run = startScan(root, { signal: controller.signal });
    await gate.entered;
    controller.abort();
    const result = await within(run.result, 500);
    const delivered = JSON.stringify(result);

    expect(result.status).toBe("cancelled");
    expect(result.packages.map((p) => p.name)).toEqual(["root-app"]);
    gate.release();
    await within(run.settled, 2000);
    expect(JSON.stringify(result)).toBe(delivered); // not mutated by the late work
    expect(delivered).not.toContain(CANARY);
  });

  it("timeout during a pending file open: prompt answer, and the late handle is closed", async () => {
    const root = space.repo("block file open", { "package.json": pkg({ name: `late-${CANARY}` }) });
    const manifest = path.join(root, "package.json");
    const gate = blockFs("open", (p) => p === manifest);
    const run = startScan(root, { limits: { timeBudgetMs: 100 } });
    await gate.entered;
    const result = await within(run.result, 1000);
    expect(result).toMatchObject({ status: "timed-out", partial: true, packages: [] });
    const delivered = JSON.stringify(result);

    const before = process.getActiveResourcesInfo().filter((r) => r === "FileHandle").length;
    gate.release();
    await within(run.settled, 2000);
    expect(process.getActiveResourcesInfo().filter((r) => r === "FileHandle").length).toBeLessThanOrEqual(before);
    expect(JSON.stringify(result)).toBe(delivered);
    expect(delivered).not.toContain(CANARY);
  });

  it("a late failure after the answer causes no second result and no unhandled rejection", async () => {
    const root = space.repo("late failure", { "package.json": pkg({ name: "x" }) });
    const gate = blockFs("realpath", (p) => p === root);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new AbortController();
      const run = startScan(root, { signal: controller.signal });
      let answers = 0;
      const answered = run.result.then((r) => {
        answers++;
        return r;
      });
      await gate.entered;
      controller.abort();
      expect((await within(answered, 500)).status).toBe("cancelled");
      gate.release(Object.assign(new Error(`ENOENT ${CANARY}`), { code: "ENOENT" }));
      await within(run.settled, 2000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(answers).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("no timers or abort listeners are left once the work settles", async () => {
    const root = space.repo("timer cleanup", { "package.json": pkg({ name: "x" }) });
    const before = timers();
    const gate = blockFs("realpath", (p) => p === root);
    const controller = new AbortController();
    const run = startScan(root, { signal: controller.signal });
    await gate.entered;
    controller.abort();
    await run.result;
    gate.release();
    await run.settled;
    expect(timers()).toBe(before);
  });

  it("the time budget now covers root resolution (it used to start after it)", async () => {
    const root = space.repo("budget covers root", { "package.json": pkg({ name: "x" }) });
    const gate = blockFs("realpath", (p) => p === root);
    const result = await within(scanRepository(root, { limits: { timeBudgetMs: 80 } }), 1000);
    expect(result.status).toBe("timed-out");
    gate.release();
  });
});

describe("Finding B: unknown directory-entry types are classified safely", () => {
  /** Directory listings report the named entries with an unknown type (all is*() false). */
  function unknownTypes(names: Set<string>) {
    const opendir = fs.promises.opendir;
    vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      const real = (await (opendir as (...a: unknown[]) => Promise<fs.Dir>)(p, ...rest)) as fs.Dir;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const entry of real) {
            if (!names.has(entry.name)) {
              yield entry;
              continue;
            }
            const no = () => false;
            yield Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, {
              isFile: no, isDirectory: no, isSymbolicLink: no, isFIFO: no, isSocket: no, isBlockDevice: no, isCharacterDevice: no,
            });
          }
        },
        close: () => real.close().catch(() => undefined),
      };
    }) as never);
  }

  it("unknown-type files and folders are classified with lstat and analyzed normally", async () => {
    const root = space.repo("unknown types", {
      "package.json": pkg({ name: "root-app" }),
      "apps/web/package.json": pkg({ name: "web" }),
      ".nvmrc": "20",
      ".env": `KEY=${CANARY}`,
    });
    unknownTypes(new Set(["package.json", "apps", "web", ".nvmrc", ".env"]));
    const lstat = vi.spyOn(fs.promises, "lstat");
    const result = await scanRepository(root);
    expect(result.packages.map((p) => p.name).sort()).toEqual(["root-app", "web"]);
    expect(result.nodeVersionFiles).toEqual([{ path: ".nvmrc", version: "20" }]);
    expect(result.envFiles).toEqual([".env"]); // name only; never opened
    expect(result.skipped.otherTypes).toBe(0);
    expect(result).toMatchObject({ status: "complete", partial: false });
    expect(lstat.mock.calls.some((c) => path.resolve(String(c[0])) === path.join(root, "apps"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("an unknown-type junction/symlink is recognised as a link and never followed", async () => {
    const outside = space.repo("unknown link target", { "package.json": pkg({ name: `outside-${CANARY}` }) });
    const root = space.repo("unknown link", { "package.json": pkg({ name: "inside" }) });
    space.dirLink(path.join(root, "escape"), outside);
    unknownTypes(new Set(["escape"]));
    const listed: string[] = [];
    const wrapped = vi.mocked(fs.promises.opendir).getMockImplementation()!;
    vi.spyOn(fs.promises, "opendir").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      listed.push(path.resolve(String(p)));
      return (wrapped as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    const result = await scanRepository(root);
    expect(result.skipped.links).toBe(1);
    expect(listed.every((p) => !p.startsWith(outside))).toBe(true);
    expect(result.packages.map((p) => p.name)).toEqual(["inside"]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.status).toBe("complete");
  });

  it("an unknown-type entry that can't be classified makes the result partial", async () => {
    const root = space.repo("unknown fails", { "package.json": pkg({ name: "root-app" }), "mystery.txt": CANARY });
    unknownTypes(new Set(["mystery.txt"]));
    const lstat = fs.promises.lstat;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike, opts?: never) => {
      if (path.resolve(String(p)) === path.join(root, "mystery.txt")) throw Object.assign(new Error(`EIO ${CANARY}`), { code: "EIO" });
      return lstat(p, opts);
    }) as never);
    const result = await scanRepository(root);
    expect(result.warnings).toEqual([{ code: "entry-unreadable", path: "mystery.txt" }]);
    expect(result.skipped.unreadable).toBe(1);
    expect(result).toMatchObject({ status: "truncated", partial: true });
    expect(result.packages.map((p) => p.name)).toEqual(["root-app"]);
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`EIO|${CANARY}`));
  });

  it("cancel while classifying an unknown entry answers promptly", async () => {
    const root = space.repo("unknown cancel", { "package.json": pkg({ name: "x" }), "slow.bin": "x" });
    unknownTypes(new Set(["slow.bin"]));
    const gate = blockFs("lstat", (p) => p === path.join(root, "slow.bin"));
    const controller = new AbortController();
    const run = startScan(root, { signal: controller.signal });
    await gate.entered;
    controller.abort();
    expect((await within(run.result, 500)).status).toBe("cancelled");
    gate.release();
    await within(run.settled, 2000);
  });

  it("unknown entries still count toward the entry limit", async () => {
    const tree: Record<string, string> = {};
    const names = new Set<string>();
    for (let i = 0; i < 30; i++) {
      tree[`f${i}.txt`] = "x";
      names.add(`f${i}.txt`);
    }
    const root = space.repo("unknown limit", tree);
    unknownTypes(names);
    const result = await scanRepository(root, { limits: { maxEntries: 10 } });
    expect(result.stats.entriesExamined).toBe(10);
    expect(result.limitsHit).toContain("entries");
  });
});
