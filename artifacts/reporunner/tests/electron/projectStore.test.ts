// Saved-setups store: classified loading, protected writes, backups and
// revision checks. Every test uses its own temp directory as Electron's
// userData; failures are injected by spying on fs, never by damaging real
// files outside that directory.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => h.userData },
}));

import {
  BACKUP_FILE,
  LEGACY_BACKUP_FILE,
  ProjectStoreError,
  STORE_FILE,
  deleteProject,
  inspectProjectStore,
  loadProject,
  loadProjectState,
  saveProject,
  setActiveProject,
} from "../../electron/projectStore.js";

type AnyFn = (...args: unknown[]) => unknown;

function profile(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Repo ${id}`,
    repoPath: `C:\\repos\\${id}`,
    installCommand: "npm install",
    frontendCommand: "npm run dev",
    backendCommand: "",
    previewUrl: "http://localhost:5173",
    ...extra,
  };
}

const file = (name = STORE_FILE) => path.join(h.userData, name);
const read = (name = STORE_FILE) => fs.readFileSync(file(name), "utf-8");
const readJson = (name = STORE_FILE) => JSON.parse(read(name));
const write = (content: string | Buffer, name = STORE_FILE) => fs.writeFileSync(file(name), content);
const writeJson = (value: unknown, name = STORE_FILE) => write(JSON.stringify(value, null, 2), name);
const ids = (state: { profiles: { id: string }[] }) => state.profiles.map((p) => p.id);
const storedIds = () => readJson().profiles.map((p: { id?: string }) => p.id);
const revisionOfFile = () => createHash("sha256").update(fs.readFileSync(file())).digest("hex");
const tempFiles = () => fs.readdirSync(h.userData).filter((name) => name.endsWith(".tmp"));

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated, C:\\secret\\path`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Bytes, names and mtimes of every file in the temp userData dir. */
function snapshotDir() {
  return fs
    .readdirSync(h.userData)
    .sort()
    .map((name) => {
      const full = path.join(h.userData, name);
      return { name, bytes: fs.readFileSync(full).toString("base64"), mtime: fs.statSync(full).mtimeMs };
    });
}

function expectStoreError(fn: () => unknown, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProjectStoreError);
  expect((caught as ProjectStoreError).code).toBe(code);
  // Never leak paths, file contents, commands or raw errno text.
  expect((caught as Error).message).not.toMatch(/[A-Za-z]:\\|\/|npm|secret|simulated|\{/);
}

/** Wraps an fs function so `fail` can throw for chosen calls; other calls go through. */
function intercept<K extends "readFileSync" | "openSync" | "renameSync" | "writeSync" | "fsyncSync" | "mkdirSync">(
  name: K,
  fail: (args: unknown[], real: AnyFn) => unknown,
) {
  const real = (fs[name] as unknown as AnyFn).bind(fs);
  return vi.spyOn(fs, name as never).mockImplementation(((...args: unknown[]) => fail(args, real)) as never);
}

/**
 * Runs `onFlush` instead of the real fsync when the new primary file's temp
 * copy is flushed. Identified by file descriptor rather than call order:
 * POSIX also fsyncs the folder after renames, Windows doesn't.
 */
function onPrimaryTempFlush(onFlush: (real: AnyFn, args: unknown[]) => unknown) {
  const primaryTempFds = new Set<number>();
  intercept("openSync", (args, real) => {
    const fd = real(...args) as number;
    const name = path.basename(String(args[0]));
    if (name.startsWith(`${STORE_FILE}.`) && !name.startsWith(BACKUP_FILE) && name.endsWith(".tmp")) {
      primaryTempFds.add(fd);
    }
    return fd;
  });
  intercept("fsyncSync", (args, real) =>
    primaryTempFds.has(args[0] as number) ? onFlush(real, args) : real(...args),
  );
}

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "rr-p0b-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe("loading", () => {
  it("missing file with no recovery data is a genuine first launch", () => {
    expect(loadProjectState()).toEqual({ profiles: [], activeProfileId: null, revision: null });
    expect(inspectProjectStore().state).toBe("missing");
  });

  it("missing file while a backup exists needs recovery and blocks writes", () => {
    writeJson({ profiles: [profile("a")], activeProfileId: "a" }, BACKUP_FILE);
    const backupBefore = read(BACKUP_FILE);

    expectStoreError(() => loadProjectState(), "needs-recovery");
    expect(inspectProjectStore()).toMatchObject({ state: "needs-recovery", reason: "missing-with-recovery-data" });
    expectStoreError(() => saveProject(profile("b")), "needs-recovery");

    expect(fs.existsSync(file())).toBe(false);
    expect(read(BACKUP_FILE)).toBe(backupBefore);
  });

  it.each([
    ["empty", "", "empty"],
    ["whitespace-only", "  \r\n\t ", "empty"],
    ["malformed JSON", '{"profiles": [', "malformed-json"],
    ["JSON null", "null", "invalid-structure"],
    ["top-level array", "[]", "invalid-structure"],
    ["profiles that is not an array", '{"profiles": {}}', "invalid-structure"],
    ["invalid legacy profile", JSON.stringify({ name: "only a name" }), "invalid-legacy-profile"],
  ])("%s file needs recovery and is never overwritten", (_label, content, reason) => {
    write(content);

    expectStoreError(() => loadProjectState(), "needs-recovery");
    expect(inspectProjectStore()).toMatchObject({ state: "needs-recovery", reason });
    expectStoreError(() => saveProject(profile("new")), "needs-recovery");
    expectStoreError(() => setActiveProject("a"), "needs-recovery");
    expectStoreError(() => deleteProject("a"), "needs-recovery");
    expectStoreError(() => loadProject(), "needs-recovery");

    expect(read()).toBe(content);
    expect(fs.readdirSync(h.userData)).toEqual([STORE_FILE]);
  });

  it("invalid UTF-8 needs recovery rather than being re-encoded", () => {
    const bytes = Buffer.from([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    write(bytes);

    expectStoreError(() => loadProjectState(), "needs-recovery");
    expect(inspectProjectStore().reason).toBe("invalid-encoding");
    expect(fs.readFileSync(file()).equals(bytes)).toBe(true);
  });

  it("an unreadable file (permission error) blocks reads and writes", () => {
    writeJson({ profiles: [profile("a")], activeProfileId: "a" });
    const before = read();
    intercept("readFileSync", (args, real) => {
      if (args[0] === file()) throw errnoError("EACCES");
      return real(...args);
    });

    expectStoreError(() => loadProjectState(), "unreadable");
    expect(inspectProjectStore()).toMatchObject({ state: "unreadable", reason: "EACCES" });
    expectStoreError(() => saveProject(profile("b")), "unreadable");
    expectStoreError(() => loadProject(), "unreadable");
    vi.restoreAllMocks();

    expect(read()).toBe(before);
    expect(fs.readdirSync(h.userData)).toEqual([STORE_FILE]);
  });

  it("valid file loads profiles and active ID", () => {
    writeJson({ profiles: [profile("a"), profile("b")], activeProfileId: "b" });

    expect(loadProjectState()).toEqual({ profiles: [profile("a"), profile("b")], activeProfileId: "b", revision: revisionOfFile() });
    expect(loadProject()?.id).toBe("b");
  });

  it("several good profiles and one bad one: good ones load, bad one is reported", () => {
    writeJson({ profiles: [profile("a"), profile("bad", { frontendPort: 70000 }), profile("b")], activeProfileId: "a" });

    expect(ids(loadProjectState())).toEqual(["a", "b"]);
    expect(inspectProjectStore()).toMatchObject({
      state: "ok",
      totalEntries: 3,
      unavailableEntries: [{ index: 1, reason: "Invalid project profile: Frontend port must be a valid port" }],
    });
  });

  it("entries that are not objects are held back, not dropped", () => {
    writeJson({ profiles: [42, profile("a"), null], activeProfileId: "a" });

    expect(ids(loadProjectState())).toEqual(["a"]);
    expect(inspectProjectStore().unavailableEntries.map((e) => e.index)).toEqual([0, 2]);
  });

  it("duplicate IDs: the first entry is usable, later ones are held back", () => {
    writeJson({ profiles: [profile("a"), profile("a", { name: "Second A" }), profile("b")], activeProfileId: "a" });

    const state = loadProjectState();
    expect(ids(state)).toEqual(["a", "b"]);
    expect(state.profiles[0].name).toBe("Repo a");
    expect(inspectProjectStore().unavailableEntries).toEqual([{ index: 1, reason: "Duplicate profile ID" }]);
  });

  it("deleting a duplicated ID removes exactly one entry", () => {
    const second = profile("a", { name: "Second A" });
    writeJson({ profiles: [profile("a"), second, profile("b")], activeProfileId: "b" });

    deleteProject("a");

    expect(readJson().profiles).toEqual([second, profile("b")]);
  });

  it("editing the usable first entry of a duplicated ID works and keeps the duplicate", () => {
    const second = profile("a", { name: "Second A" });
    writeJson({ profiles: [profile("a"), second], activeProfileId: "a" });

    saveProject(profile("a", { name: "Edited A" }));

    expect(readJson().profiles).toEqual([profile("a", { name: "Edited A" }), second]);
    expect(inspectProjectStore().unavailableEntries).toEqual([{ index: 1, reason: "Duplicate profile ID" }]);
  });

  it("entries without IDs get stable fallback IDs that are persisted on the next write", () => {
    const { id: _a, ...noIdA } = profile("x");
    const { id: _b, ...noIdB } = profile("y");
    writeJson({ profiles: [noIdA, noIdB], activeProfileId: null });

    const first = ids(loadProjectState());
    expect(first).toHaveLength(2);
    expect(new Set(first).size).toBe(2);
    expect(ids(loadProjectState())).toEqual(first);

    setActiveProject(first[1]);

    expect(storedIds()).toEqual(first);
    expect(loadProjectState().activeProfileId).toBe(first[1]);
  });

  it("active ID pointing at an invalid entry selects no repo instead of another one", () => {
    writeJson({ profiles: [profile("a"), profile("broken", { previewUrl: "nope" })], activeProfileId: "broken" });

    expect(loadProjectState().activeProfileId).toBeNull();
    expect(loadProject()).toBeNull();
    expectStoreError(() => setActiveProject("broken"), "profile-unavailable");
  });

  it.each([
    ["a removed profile", "gone"],
    ["an explicit null", null],
    ["an empty string", ""],
    ["a non-string value", 42],
  ])("a stored active ID naming %s selects no repo, never another one", (_label, active) => {
    writeJson({ profiles: [profile("a"), profile("b")], activeProfileId: active });

    expect(loadProjectState().activeProfileId).toBeNull();
    expect(loadProject()).toBeNull();
  });

  it("only a file with no activeProfileId field at all falls back to the first profile (previous behaviour)", () => {
    writeJson({ profiles: [profile("a"), profile("b")] });

    expect(loadProjectState().activeProfileId).toBe("a");
  });

  it("a file with no activeProfileId field and a held-back entry selects no repo", () => {
    writeJson({ profiles: [{ name: "broken" }, profile("a")] });

    expect(loadProjectState().activeProfileId).toBeNull();
  });

  it("UTF-8 BOM is accepted", () => {
    write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ profiles: [profile("a")], activeProfileId: "a" }))]));

    expect(ids(loadProjectState())).toEqual(["a"]);
  });

  it.each([2, "1", null, "next"])("schemaVersion %j is unsupported: read-only, never run, never rewritten", (version) => {
    const content = JSON.stringify({ schemaVersion: version, profiles: [profile("a")], activeProfileId: "a" });
    write(content);

    expectStoreError(() => loadProjectState(), "unsupported-version");
    expectStoreError(() => loadProject(), "unsupported-version");
    expectStoreError(() => saveProject(profile("b")), "unsupported-version");
    expect(read()).toBe(content);
  });

  it("schemaVersion 1 is supported and preserved", () => {
    writeJson({ schemaVersion: 1, profiles: [profile("a")], activeProfileId: "a" });

    saveProject(profile("b"));

    expect(readJson().schemaVersion).toBe(1);
  });

  it("valid legacy single-profile file loads as the active profile", () => {
    writeJson(profile("legacy"));

    expect(loadProjectState()).toEqual({ profiles: [profile("legacy")], activeProfileId: "legacy", revision: revisionOfFile() });
  });

  it("files with more than five entries still load in full", () => {
    const profiles = ["a", "b", "c", "d", "e", "f", "g"].map((id) => profile(id));
    writeJson({ profiles, activeProfileId: "g" });

    expect(ids(loadProjectState())).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("loading never writes, renames or deletes anything", () => {
    writeJson({ profiles: [profile("a"), { name: "bad" }], activeProfileId: "a", future: { x: 1 } });
    writeJson({ profiles: [], activeProfileId: null }, BACKUP_FILE);
    write("leftover", `${STORE_FILE}.123.abc.tmp`);
    const before = snapshotDir();
    const mutators = (["writeFileSync", "writeSync", "renameSync", "unlinkSync", "mkdirSync", "copyFileSync"] as const).map(
      (name) => vi.spyOn(fs, name),
    );
    // readFileSync opens files through fs.openSync, so only non-read opens count.
    const opens = vi.spyOn(fs, "openSync");

    loadProjectState();
    loadProject();
    inspectProjectStore();

    for (const spy of mutators) expect(spy).not.toHaveBeenCalled();
    expect(opens.mock.calls.filter(([, flags]) => flags !== undefined && flags !== "r")).toEqual([]);
    expect(snapshotDir()).toEqual(before);
  });
});

describe("writing", () => {
  it("first save creates the file without a backup", () => {
    const state = saveProject(profile("a"));

    expect(state).toEqual({ profiles: [profile("a")], activeProfileId: "a", revision: revisionOfFile() });
    expect(readJson()).toEqual({ profiles: [profile("a")], activeProfileId: "a" });
    expect(fs.existsSync(file(BACKUP_FILE))).toBe(false);
    expect(tempFiles()).toEqual([]);
  });

  it("a new profile without an ID gets one", () => {
    const { id: _omit, ...noId } = profile("n");
    const state = saveProject(noId);

    expect(state.profiles[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.activeProfileId).toBe(state.profiles[0].id);
  });

  it("repeated saves keep a rolling backup of the previous valid file", () => {
    saveProject(profile("a"));
    const afterFirst = read();
    saveProject(profile("b"));
    const afterSecond = read();
    saveProject(profile("a", { name: "Renamed" }));

    expect(read(BACKUP_FILE)).toBe(afterSecond);
    expect(read(BACKUP_FILE)).not.toBe(afterFirst);
    expect(ids(loadProjectState())).toEqual(["a", "b"]);
    expect(loadProjectState().profiles[0].name).toBe("Renamed");
    expect(tempFiles()).toEqual([]);
  });

  it("backups contain loadable data", () => {
    saveProject(profile("a"));
    saveProject(profile("b"));
    fs.copyFileSync(file(BACKUP_FILE), file());

    expect(loadProjectState()).toEqual({ profiles: [profile("a")], activeProfileId: "a", revision: revisionOfFile() });
  });

  it("unknown top-level and profile fields survive writes", () => {
    writeJson({
      appMeta: { theme: "dark" },
      profiles: [profile("a", { notes: "keep me", tags: ["x"] }), profile("b")],
      activeProfileId: "a",
      trailing: 1,
    });

    saveProject(profile("a", { name: "Edited" }));
    deleteProject("b");
    setActiveProject("a");

    const saved = readJson();
    expect(Object.keys(saved)).toEqual(["appMeta", "profiles", "activeProfileId", "trailing"]);
    expect(saved.appMeta).toEqual({ theme: "dark" });
    expect(saved.profiles).toEqual([{ ...profile("a", { notes: "keep me", tags: ["x"] }), name: "Edited" }]);
  });

  it("clearing an optional port removes it from the stored profile", () => {
    writeJson({ profiles: [profile("a", { frontendPort: 3000, custom: true })], activeProfileId: "a" });

    saveProject(profile("a"));

    expect(readJson().profiles[0]).toEqual(profile("a", { custom: true }));
  });

  it("invalid entries stay in place through save, edit, switch and delete", () => {
    const bad = { name: "broken", repoPath: 5 };
    writeJson({ profiles: [profile("a"), bad, profile("b")], activeProfileId: "a" });

    saveProject(profile("c"));
    saveProject(profile("a", { name: "Edited" }));
    setActiveProject("b");
    deleteProject("c");

    const saved = readJson();
    expect(saved.profiles[1]).toEqual(bad);
    expect(saved.profiles.map((p: { id?: string }) => p.id)).toEqual(["a", undefined, "b"]);
    expect(saved.activeProfileId).toBe("b");
  });

  it("deleting a non-active profile leaves the stored active ID untouched", () => {
    writeJson({ profiles: [profile("a"), profile("broken", { previewUrl: "x" }), profile("b")], activeProfileId: "broken" });

    deleteProject("b");

    expect(readJson().activeProfileId).toBe("broken");
  });

  it("unavailable entries cannot be removed through ordinary delete", () => {
    writeJson({ profiles: [profile("a"), profile("broken", { previewUrl: "x" })], activeProfileId: "a" });
    const before = read();

    expect(() => deleteProject("broken")).toThrow("Saved repo setup not found.");
    expect(read()).toBe(before);
  });

  it("saving with an ID held by an unavailable entry is refused", () => {
    writeJson({ profiles: [profile("broken", { previewUrl: "x" })], activeProfileId: null });

    expectStoreError(() => saveProject(profile("broken")), "profile-unavailable");
  });

  it("five-profile limit counts unavailable entries; editing is still allowed", () => {
    const entries = [profile("a"), profile("b"), profile("c"), profile("d"), { name: "broken" }];
    writeJson({ profiles: entries, activeProfileId: "a" });

    expect(() => saveProject(profile("f"))).toThrow(
      "Repo limit reached. RepoRunner Free currently supports up to 5 saved repo setups.",
    );
    expect(readJson().profiles).toHaveLength(5);

    saveProject(profile("b", { name: "Edited" }));
    expect(readJson().profiles).toHaveLength(5);
  });

  it("over-limit files load, refuse new profiles, and keep every entry on edit", () => {
    const profiles = ["a", "b", "c", "d", "e", "f"].map((id) => profile(id));
    writeJson({ profiles, activeProfileId: "a" });

    expect(() => saveProject(profile("g"))).toThrow("Repo limit reached");
    saveProject(profile("f", { name: "Edited" }));

    expect(storedIds()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("converting a legacy file keeps a one-time legacy copy and a rolling backup", () => {
    const legacy = JSON.stringify(profile("legacy", { extra: "kept" }), null, 2);
    write(legacy);

    saveProject(profile("b"));

    expect(read(LEGACY_BACKUP_FILE)).toBe(legacy);
    expect(read(BACKUP_FILE)).toBe(legacy);
    expect(readJson()).toEqual({
      profiles: [profile("legacy", { extra: "kept" }), profile("b")],
      activeProfileId: "b",
    });

    saveProject(profile("c"));
    expect(read(LEGACY_BACKUP_FILE)).toBe(legacy);
  });

  it("an existing, different legacy copy is never overwritten", () => {
    write("older legacy copy", LEGACY_BACKUP_FILE);
    const legacy = JSON.stringify(profile("legacy"));
    write(legacy);

    saveProject(profile("b"));

    expect(read(LEGACY_BACKUP_FILE)).toBe("older legacy copy");
    const copies = fs.readdirSync(h.userData).filter((n) => n.startsWith("reporunner-project.legacy-"));
    expect(copies).toHaveLength(1);
    expect(read(copies[0])).toBe(legacy);
  });

  it("a legacy file without an ID gets a stable ID on conversion", () => {
    const { id: _omit, ...noId } = profile("legacy");
    writeJson(noId);
    const [loadedId] = ids(loadProjectState());

    setActiveProject(loadedId);

    expect(readJson()).toEqual({ profiles: [{ id: loadedId, ...noId }], activeProfileId: loadedId });
  });
});

describe("backup integrity", () => {
  const goodBackup = () => JSON.stringify({ profiles: [profile("good")], activeProfileId: "good" }, null, 2);

  function attemptAllMutations() {
    for (const mutate of [() => saveProject(profile("x")), () => setActiveProject("good"), () => deleteProject("good")]) {
      expect(mutate).toThrow();
    }
  }

  it.each([
    ["corrupted", "{ broken"],
    ["empty", ""],
    ["future-format", JSON.stringify({ schemaVersion: 2, profiles: [] })],
  ])("a %s primary never overwrites a good backup", (_label, content) => {
    write(goodBackup(), BACKUP_FILE);
    write(content);

    attemptAllMutations();

    expect(read(BACKUP_FILE)).toBe(goodBackup());
    expect(read()).toBe(content);
    expect(tempFiles()).toEqual([]);
  });

  it("an interrupted backup write keeps the previous backup and the primary intact", () => {
    saveProject(profile("a"));
    saveProject(profile("b"));
    const primary = read();
    const backup = read(BACKUP_FILE);
    let calls = 0;
    intercept("writeSync", (args, real) => {
      // First write is the backup temp file: write a little, then fail.
      if (++calls === 1) return real(args[0], args[1], args[2], Math.min(5, args[3] as number));
      throw errnoError("ENOSPC");
    });

    expectStoreError(() => saveProject(profile("c")), "backup-failed");
    vi.restoreAllMocks();

    expect(read()).toBe(primary);
    expect(read(BACKUP_FILE)).toBe(backup);
    expect(tempFiles()).toEqual([]);
  });

  it("legacy conversion keeps the original bytes even if the legacy copy cannot be written", () => {
    const legacy = JSON.stringify(profile("legacy"));
    write(legacy);
    intercept("openSync", (args, real) => {
      if (String(args[0]).includes("legacy") && args[1] === "wx") throw errnoError("EACCES");
      return real(...args);
    });

    expectStoreError(() => saveProject(profile("b")), "backup-failed");
    vi.restoreAllMocks();

    expect(read()).toBe(legacy);
    expect(fs.existsSync(file(BACKUP_FILE))).toBe(false);
  });
});

describe("write failures leave the original intact", () => {
  let original: string;
  let originalBackup: string;

  beforeEach(() => {
    saveProject(profile("a"));
    saveProject(profile("b"));
    original = read();
    originalBackup = read(BACKUP_FILE);
  });

  function expectUntouched() {
    expect(read()).toBe(original);
    expect(read(BACKUP_FILE)).toBe(originalBackup);
    expect(tempFiles()).toEqual([]);
    expect(ids(loadProjectState())).toEqual(["a", "b"]);
  }

  it("failed backup creation: primary and old backup untouched, save refused", () => {
    intercept("openSync", (args, real) => {
      if (String(args[0]).includes(BACKUP_FILE)) throw errnoError("ENOSPC");
      return real(...args);
    });

    expectStoreError(() => saveProject(profile("c")), "backup-failed");
    vi.restoreAllMocks();
    expectUntouched();
  });

  it("failed backup rename (locked .bak): primary untouched", () => {
    intercept("renameSync", (args, real) => {
      if (String(args[1]).endsWith(BACKUP_FILE)) throw errnoError("EPERM");
      return real(...args);
    });

    expectStoreError(() => saveProject(profile("c")), "backup-failed");
    vi.restoreAllMocks();
    expectUntouched();
  });

  it("interrupted temp-file write (disk full mid-write)", () => {
    let calls = 0;
    intercept("writeSync", (args, real) => {
      calls++;
      // Let the backup through; fail the primary temp file after a partial write.
      if (calls === 1) return real(...args);
      if (calls === 2) return real(args[0], args[1], args[2], Math.min(10, args[3] as number));
      throw errnoError("ENOSPC");
    });

    expectStoreError(() => saveProject(profile("c")), "write-failed");
    vi.restoreAllMocks();
    expect(read()).toBe(original);
    expect(read(BACKUP_FILE)).toBe(original); // backup now mirrors the unchanged primary
    expect(tempFiles()).toEqual([]);
  });

  it("failed flush", () => {
    onPrimaryTempFlush(() => {
      throw errnoError("EIO");
    });

    expectStoreError(() => saveProject(profile("c")), "write-failed");
    vi.restoreAllMocks();
    expect(read()).toBe(original);
    expect(tempFiles()).toEqual([]);
  });

  it("read-back verification mismatch", () => {
    intercept("readFileSync", (args, real) => {
      const result = real(...args);
      const p = String(args[0]);
      if (p.endsWith(".tmp") && !p.includes(BACKUP_FILE)) return Buffer.from("corrupted");
      return result;
    });

    expectStoreError(() => saveProject(profile("c")), "write-failed");
    vi.restoreAllMocks();
    expect(read()).toBe(original);
    expect(tempFiles()).toEqual([]);
  });

  it("failed rename of the primary after all retries", () => {
    const spy = intercept("renameSync", (args, real) => {
      if (String(args[1]).endsWith(STORE_FILE)) throw errnoError("EPERM");
      return real(...args);
    });

    expectStoreError(() => saveProject(profile("c")), "write-failed");
    expect(spy.mock.calls.filter((call) => String(call[1]).endsWith(STORE_FILE))).toHaveLength(6);
    vi.restoreAllMocks();
    expect(read()).toBe(original);
    expect(tempFiles()).toEqual([]);
  });

  it("non-transient rename errors are not retried", () => {
    const spy = intercept("renameSync", (args, real) => {
      if (String(args[1]).endsWith(STORE_FILE)) throw errnoError("EXDEV");
      return real(...args);
    });

    expectStoreError(() => saveProject(profile("c")), "write-failed");
    expect(spy.mock.calls.filter((call) => String(call[1]).endsWith(STORE_FILE))).toHaveLength(1);
    vi.restoreAllMocks();
    expect(read()).toBe(original);
  });

  it("transient Windows-style locks are retried and the save succeeds", () => {
    let failures = 0;
    intercept("renameSync", (args, real) => {
      if (String(args[1]).endsWith(STORE_FILE) && failures < 2) {
        failures++;
        throw errnoError(failures === 1 ? "EBUSY" : "EPERM");
      }
      return real(...args);
    });

    saveProject(profile("c"));

    expect(failures).toBe(2);
    expect(storedIds()).toEqual(["a", "b", "c"]);
    expect(tempFiles()).toEqual([]);
  });

  it("transient read lock on load is retried", () => {
    let failures = 0;
    intercept("readFileSync", (args, real) => {
      if (args[0] === file() && failures < 1) {
        failures++;
        throw errnoError("EBUSY");
      }
      return real(...args);
    });

    expect(ids(loadProjectState())).toEqual(["a", "b"]);
    expect(failures).toBe(1);
  });

  it("permission error during save: refused with a message free of paths", () => {
    intercept("openSync", (args, real) => {
      if (args[1] === "wx") throw errnoError("EACCES");
      return real(...args);
    });

    expectStoreError(() => saveProject(profile("c")), "backup-failed");
    vi.restoreAllMocks();
    expectUntouched();
  });
});

describe("post-write verification", () => {
  /** Lets the real rename happen, then makes reads of the primary misbehave. */
  function breakReadsAfterRename(onRead: (real: AnyFn, args: unknown[]) => unknown) {
    let renamed = false;
    intercept("renameSync", (args, real) => {
      const result = real(...args);
      if (String(args[1]).endsWith(STORE_FILE)) renamed = true;
      return result;
    });
    intercept("readFileSync", (args, real) => (renamed && args[0] === file() ? onRead(real, args) : real(...args)));
  }

  beforeEach(() => {
    saveProject(profile("a"));
  });

  it("a read-back mismatch after the rename reports 'may have been saved', not 'not saved'", () => {
    breakReadsAfterRename(() => Buffer.from("something else"));

    expectStoreError(() => saveProject(profile("b")), "write-unverified");
    vi.restoreAllMocks();

    // The write did land.
    expect(storedIds()).toEqual(["a", "b"]);
  });

  it("an unreadable file after the rename is also reported as unverified", () => {
    breakReadsAfterRename(() => {
      throw errnoError("EIO");
    });

    expectStoreError(() => saveProject(profile("b")), "write-unverified");
  });

  it("messages distinguish rejected, failed and unverified writes", () => {
    const message = (code: ConstructorParameters<typeof ProjectStoreError>[0]) => new ProjectStoreError(code).message;

    expect(message("conflict")).toMatch(/not saved/);
    expect(message("write-failed")).toMatch(/not changed/);
    expect(message("backup-failed")).toMatch(/not changed/);
    expect(message("write-unverified")).toMatch(/may have been saved/);
    expect(message("write-unverified")).not.toMatch(/not saved|not changed|nothing/i);
  });

  it("errors cross IPC with a plain 'Error:' prefix the renderer already strips", () => {
    expect(String(new ProjectStoreError("conflict"))).toMatch(/^Error: Your saved repo setups/);
  });
});

describe("revision and conflict detection", () => {
  beforeEach(() => {
    saveProject(profile("a"));
  });

  it("a stale caller revision is rejected and the newer data is kept", () => {
    const stale = inspectProjectStore().revision;
    saveProject(profile("b"));
    const latest = read();

    expectStoreError(() => saveProject(profile("c"), { expectedRevision: stale }), "conflict");
    expectStoreError(() => setActiveProject("a", { expectedRevision: stale }), "conflict");
    expectStoreError(() => deleteProject("a", { expectedRevision: stale }), "conflict");
    expect(read()).toBe(latest);
  });

  it("the current revision is accepted", () => {
    const current = inspectProjectStore().revision;

    saveProject(profile("b"), { expectedRevision: current });

    expect(storedIds()).toEqual(["a", "b"]);
  });

  it("expectedRevision null means the file must not exist yet", () => {
    expectStoreError(() => saveProject(profile("b"), { expectedRevision: null }), "conflict");
  });

  it("revision is derived from the stored bytes", () => {
    const before = inspectProjectStore().revision;
    write(read() + "\n");

    expect(inspectProjectStore().revision).not.toBe(before);
  });

  it("an external change between load and replace is detected; the external data wins", () => {
    const external = JSON.stringify({ profiles: [profile("external")], activeProfileId: "external" });
    onPrimaryTempFlush((real, args) => {
      real(...args);
      // While the new primary temp file is being written, another program edits the store.
      fs.writeFileSync(file(), external);
    });

    expectStoreError(() => saveProject(profile("b")), "conflict");
    vi.restoreAllMocks();

    expect(read()).toBe(external);
    expect(tempFiles()).toEqual([]);
  });

  it("an external change before the backup step is detected before anything is written", () => {
    const external = JSON.stringify({ profiles: [profile("external")], activeProfileId: "external" });
    intercept("mkdirSync", (args, real) => {
      fs.writeFileSync(file(), external);
      return real(...args);
    });

    expectStoreError(() => saveProject(profile("b")), "conflict");
    vi.restoreAllMocks();

    expect(read()).toBe(external);
    expect(fs.existsSync(file(BACKUP_FILE))).toBe(false);
  });

  it("the store file being deleted externally mid-save is a conflict, not a fresh start", () => {
    onPrimaryTempFlush((real, args) => {
      real(...args);
      fs.unlinkSync(file());
    });

    expectStoreError(() => saveProject(profile("b")), "conflict");
    vi.restoreAllMocks();
    expect(fs.existsSync(file())).toBe(false);
  });
});

describe("round trip", () => {
  it("loaded profiles match the saved shape", () => {
    const p = profile("a", { frontendPort: 3000, backendPort: 3001 });
    saveProject(p);
    expect(loadProject()).toEqual(p);
  });
});
