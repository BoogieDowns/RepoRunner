// Recovery operations and storage status. Every test uses its own temp
// directory as Electron's userData; failures are injected by spying on fs.
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
  ProjectStoreError,
  RECOVERY_FILE_PREFIX,
  STORE_FILE,
  deleteProject,
  inspectProjectStore,
  loadProjectState,
  resolveProjectStoreIssue,
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
const write = (content: string | Buffer, name = STORE_FILE) => fs.writeFileSync(file(name), content);
const writeJson = (value: unknown, name = STORE_FILE) => write(JSON.stringify(value, null, 2), name);
const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const recoveryFiles = () => fs.readdirSync(h.userData).filter((n) => n.startsWith(RECOVERY_FILE_PREFIX)).sort();
const recoveryContents = () => recoveryFiles().map((n) => read(n));
const tempFiles = () => fs.readdirSync(h.userData).filter((n) => n.endsWith(".tmp"));

const GOOD_BACKUP = JSON.stringify({ profiles: [profile("a"), profile("b")], activeProfileId: "b" }, null, 2);
const DAMAGED = '{"profiles": [ {"id": "a", "name": "Repo a"';

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated, C:\\secret\\path`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function intercept<K extends "readFileSync" | "openSync" | "renameSync" | "writeSync">(
  name: K,
  fail: (args: unknown[], real: AnyFn) => unknown,
) {
  const real = (fs[name] as unknown as AnyFn).bind(fs);
  return vi.spyOn(fs, name as never).mockImplementation(((...args: unknown[]) => fail(args, real)) as never);
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
  expect((caught as Error).message).not.toMatch(/[A-Za-z]:\\|\/|npm|secret|simulated|\{/);
}

function snapshotDir() {
  return fs
    .readdirSync(h.userData)
    .sort()
    .map((name) => ({ name, bytes: fs.readFileSync(file(name)).toString("base64") }));
}

/** A damaged primary next to a good rolling backup. */
function damagedWithBackup() {
  write(GOOD_BACKUP, BACKUP_FILE);
  write(DAMAGED);
  return inspectProjectStore();
}

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "rr-p0b-rec-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe("storage status", () => {
  it("first launch", () => {
    expect(inspectProjectStore()).toEqual({
      state: "missing",
      reason: null,
      recoveryRequired: false,
      readOnly: false,
      backupAvailable: false,
      revision: null,
      totalEntries: 0,
      unavailableEntries: [],
      availableActions: ["retry"],
    });
  });

  it("healthy file", () => {
    const content = JSON.stringify({ profiles: [profile("a")], activeProfileId: "a" });
    write(content);

    expect(inspectProjectStore()).toMatchObject({
      state: "ok",
      recoveryRequired: false,
      readOnly: false,
      revision: sha(content),
      totalEntries: 1,
      unavailableEntries: [],
      availableActions: ["retry"],
    });
  });

  it("readable file with unavailable entries offers discard", () => {
    writeJson({ profiles: [profile("a"), { name: "x" }], activeProfileId: "a" });

    expect(inspectProjectStore()).toMatchObject({
      state: "ok",
      recoveryRequired: false,
      readOnly: false,
      totalEntries: 2,
      unavailableEntries: [{ index: 1, reason: "Invalid project profile: Repository path is required" }],
      availableActions: ["retry", "discard-invalid-entries"],
    });
  });

  it("damaged file with a valid backup offers restore", () => {
    expect(damagedWithBackup()).toMatchObject({
      state: "needs-recovery",
      reason: "malformed-json",
      recoveryRequired: true,
      readOnly: true,
      backupAvailable: true,
      revision: sha(DAMAGED),
      availableActions: ["retry", "restore-backup", "start-fresh"],
    });
  });

  it.each([
    ["no backup", null],
    ["a corrupted backup", "{ nope"],
    ["an empty backup", ""],
    ["a future-format backup", JSON.stringify({ schemaVersion: 9, profiles: [] })],
    ["a backup with an invalid legacy profile", JSON.stringify({ name: "x" })],
  ])("damaged file with %s does not offer restore", (_label, backup) => {
    if (backup !== null) write(backup, BACKUP_FILE);
    write(DAMAGED);

    expect(inspectProjectStore()).toMatchObject({
      state: "needs-recovery",
      backupAvailable: false,
      availableActions: ["retry", "start-fresh"],
    });
  });

  it("missing file with a backup needs recovery", () => {
    write(GOOD_BACKUP, BACKUP_FILE);

    expect(inspectProjectStore()).toMatchObject({
      state: "needs-recovery",
      reason: "missing-with-recovery-data",
      revision: null,
      backupAvailable: true,
      availableActions: ["retry", "restore-backup", "start-fresh"],
    });
  });

  it("unreadable file only offers retry", () => {
    write(GOOD_BACKUP);
    intercept("readFileSync", (args, real) => {
      if (args[0] === file()) throw errnoError("EACCES");
      return real(...args);
    });

    expect(inspectProjectStore()).toMatchObject({
      state: "unreadable",
      reason: "EACCES",
      recoveryRequired: true,
      readOnly: true,
      availableActions: ["retry"],
    });
  });

  it("future-format file is read-only and only offers retry", () => {
    write(JSON.stringify({ schemaVersion: 2, profiles: [] }));

    expect(inspectProjectStore()).toMatchObject({
      state: "unsupported-version",
      recoveryRequired: false,
      readOnly: true,
      availableActions: ["retry"],
    });
  });

  it("never exposes paths, commands, names or file contents", () => {
    const secret = {
      id: "s1",
      name: "TopSecretProject",
      repoPath: "C:\\Users\\someone\\secret-repo",
      installCommand: "set API_TOKEN=sk-live-123 && npm ci",
      frontendCommand: "npm run dev",
      backendCommand: "",
      previewUrl: "http://localhost:5173",
    };
    writeJson({ profiles: [secret, { ...secret, id: "s2", previewUrl: "ftp://sk-live-456" }], activeProfileId: "s1" }, BACKUP_FILE);
    write(`{"profiles": [${JSON.stringify(secret)}, "sk-live-789"`);

    const damaged = JSON.stringify(inspectProjectStore());
    write(JSON.stringify({ profiles: [secret, { ...secret, id: "s2", previewUrl: "ftp://sk-live-456" }], activeProfileId: "s1" }));
    const partial = JSON.stringify(inspectProjectStore());

    for (const serialized of [damaged, partial]) {
      expect(serialized).not.toMatch(/TopSecret|secret-repo|sk-live|API_TOKEN|npm|someone|Users/);
      expect(serialized).not.toContain(h.userData);
    }
  });
});

describe("retry", () => {
  it("re-reads the file and never writes anything", () => {
    const before = damagedWithBackup();
    const snapshot = snapshotDir();
    const mutators = (["writeFileSync", "writeSync", "renameSync", "unlinkSync", "mkdirSync", "copyFileSync"] as const).map(
      (name) => vi.spyOn(fs, name),
    );

    const after = resolveProjectStoreIssue("retry");

    for (const spy of mutators) expect(spy).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(snapshotDir()).toEqual(snapshot);
  });

  it("reflects an externally repaired file", () => {
    damagedWithBackup();
    write(GOOD_BACKUP);

    expect(resolveProjectStoreIssue("retry").state).toBe("ok");
  });
});

describe("revision requirement for recovery actions", () => {
  it.each(["restore-backup", "start-fresh"] as const)("%s without a revision or with a stale one changes nothing", (action) => {
    const status = damagedWithBackup();
    const snapshot = snapshotDir();

    expectStoreError(() => resolveProjectStoreIssue(action), "conflict");
    expectStoreError(() => resolveProjectStoreIssue(action, {}), "conflict");
    expectStoreError(() => resolveProjectStoreIssue(action, { expectedRevision: sha("something else") }), "conflict");
    expectStoreError(() => resolveProjectStoreIssue(action, { expectedRevision: null }), "conflict");

    expect(snapshotDir()).toEqual(snapshot);
    expect(status.revision).toBe(sha(DAMAGED));
  });

  it("a file that changed after the user saw the status is not touched", () => {
    const status = damagedWithBackup();
    write("{ different damage");

    expectStoreError(() => resolveProjectStoreIssue("start-fresh", { expectedRevision: status.revision }), "conflict");

    expect(read()).toBe("{ different damage");
    expect(recoveryFiles()).toEqual([]);
  });
});

describe("restore backup", () => {
  it("preserves the damaged file, then restores the validated backup", () => {
    const status = damagedWithBackup();

    const after = resolveProjectStoreIssue("restore-backup", { expectedRevision: status.revision });

    expect(read()).toBe(GOOD_BACKUP);
    expect(read(BACKUP_FILE)).toBe(GOOD_BACKUP);
    expect(recoveryContents()).toEqual([DAMAGED]);
    expect(recoveryFiles()[0]).toMatch(/^reporunner-project\.recovery-\d{8}T\d{6}-damaged-[0-9a-f]{8}\.json$/);
    expect(after).toMatchObject({ state: "ok", recoveryRequired: false, revision: sha(GOOD_BACKUP) });
    expect(loadProjectState()).toMatchObject({ activeProfileId: "b" });
    expect(tempFiles()).toEqual([]);
  });

  it("restores when the primary file is missing, without inventing a recovery copy", () => {
    write(GOOD_BACKUP, BACKUP_FILE);

    resolveProjectStoreIssue("restore-backup", { expectedRevision: null });

    expect(read()).toBe(GOOD_BACKUP);
    expect(recoveryFiles()).toEqual([]);
  });

  it("a failed restore of a missing primary leaves the backup available to retry", () => {
    write(GOOD_BACKUP, BACKUP_FILE);
    intercept("renameSync", (args, real) => {
      if (String(args[1]).endsWith(STORE_FILE)) throw errnoError("EPERM");
      return real(...args);
    });

    expectStoreError(() => resolveProjectStoreIssue("restore-backup", { expectedRevision: null }), "write-failed");
    vi.restoreAllMocks();

    expect(fs.existsSync(file())).toBe(false);
    expect(read(BACKUP_FILE)).toBe(GOOD_BACKUP);
    expect(tempFiles()).toEqual([]);
    expect(inspectProjectStore()).toMatchObject({ state: "needs-recovery", backupAvailable: true });

    resolveProjectStoreIssue("restore-backup", { expectedRevision: null });
    expect(read()).toBe(GOOD_BACKUP);
  });

  it.each([
    ["missing", null],
    ["corrupted", "{ nope"],
    ["future-format", JSON.stringify({ schemaVersion: 3, profiles: [] })],
  ])("refuses with a %s backup and changes nothing", (_label, backup) => {
    if (backup !== null) write(backup, BACKUP_FILE);
    write(DAMAGED);
    const snapshot = snapshotDir();

    expectStoreError(
      () => resolveProjectStoreIssue("restore-backup", { expectedRevision: sha(DAMAGED) }),
      "backup-unavailable",
    );
    expect(snapshotDir()).toEqual(snapshot);
  });

  it("is not available when the file is healthy", () => {
    write(GOOD_BACKUP, BACKUP_FILE);
    const content = JSON.stringify({ profiles: [profile("z")], activeProfileId: "z" });
    write(content);

    expectStoreError(() => resolveProjectStoreIssue("restore-backup", { expectedRevision: sha(content) }), "recovery-not-available");
    expect(read()).toBe(content);
  });

  it("never overwrites existing recovery copies", () => {
    write("older recovery copy", `${RECOVERY_FILE_PREFIX}20200101T000000-damaged-00000000.json`);
    const status = damagedWithBackup();

    resolveProjectStoreIssue("restore-backup", { expectedRevision: status.revision });

    expect(read(`${RECOVERY_FILE_PREFIX}20200101T000000-damaged-00000000.json`)).toBe("older recovery copy");
    expect(recoveryFiles()).toHaveLength(2);
  });

  it("if the recovery copy can't be written, nothing is restored", () => {
    const status = damagedWithBackup();
    intercept("openSync", (args, real) => {
      if (String(args[0]).includes(RECOVERY_FILE_PREFIX)) throw errnoError("ENOSPC");
      return real(...args);
    });

    expectStoreError(() => resolveProjectStoreIssue("restore-backup", { expectedRevision: status.revision }), "recovery-copy-failed");
    vi.restoreAllMocks();

    expect(read()).toBe(DAMAGED);
    expect(read(BACKUP_FILE)).toBe(GOOD_BACKUP);
    expect(recoveryFiles()).toEqual([]);
    expect(tempFiles()).toEqual([]);
  });

  it("a failed restore keeps the damaged file and its copy, and can be retried safely", () => {
    const status = damagedWithBackup();
    intercept("renameSync", (args, real) => {
      if (String(args[1]).endsWith(STORE_FILE)) throw errnoError("EPERM");
      return real(...args);
    });

    expectStoreError(() => resolveProjectStoreIssue("restore-backup", { expectedRevision: status.revision }), "write-failed");
    vi.restoreAllMocks();

    expect(read()).toBe(DAMAGED);
    expect(read(BACKUP_FILE)).toBe(GOOD_BACKUP);
    expect(recoveryContents()).toEqual([DAMAGED]);
    expect(tempFiles()).toEqual([]);
    expect(inspectProjectStore().availableActions).toContain("restore-backup");

    resolveProjectStoreIssue("restore-backup", { expectedRevision: status.revision });

    expect(read()).toBe(GOOD_BACKUP);
    expect(recoveryContents()).toEqual([DAMAGED, DAMAGED]);
  });

  it("an interrupted write of the restored file leaves the damaged original in place", () => {
    const status = damagedWithBackup();
    let calls = 0;
    intercept("writeSync", (args, real) => {
      // 1st write: recovery copy. 2nd: restored primary temp file.
      if (++calls === 2) return real(args[0], args[1], args[2], Math.min(7, args[3] as number));
      if (calls > 2) throw errnoError("ENOSPC");
      return real(...args);
    });

    expectStoreError(() => resolveProjectStoreIssue("restore-backup", { expectedRevision: status.revision }), "write-failed");
    vi.restoreAllMocks();

    expect(read()).toBe(DAMAGED);
    expect(recoveryContents()).toEqual([DAMAGED]);
    expect(tempFiles()).toEqual([]);
  });
});

describe("start fresh", () => {
  it("preserves the damaged file and the backup, then creates an empty store", () => {
    const status = damagedWithBackup();

    const after = resolveProjectStoreIssue("start-fresh", { expectedRevision: status.revision });

    expect(JSON.parse(read())).toEqual({ profiles: [], activeProfileId: null });
    expect(read(BACKUP_FILE)).toBe(GOOD_BACKUP);
    expect(recoveryContents().sort()).toEqual([DAMAGED, GOOD_BACKUP].sort());
    expect(after).toMatchObject({ state: "ok", totalEntries: 0, recoveryRequired: false });

    // Ordinary saves afterwards rotate .bak, but the old setups survive in the recovery copy.
    saveProject(profile("new"));
    saveProject(profile("newer"));
    expect(read(BACKUP_FILE)).not.toBe(GOOD_BACKUP);
    expect(recoveryContents()).toContain(GOOD_BACKUP);
  });

  it("works without a backup", () => {
    write(DAMAGED);

    resolveProjectStoreIssue("start-fresh", { expectedRevision: sha(DAMAGED) });

    expect(recoveryContents()).toEqual([DAMAGED]);
    expect(loadProjectState().profiles).toEqual([]);
  });

  it("works when the primary is missing but recovery data exists", () => {
    write(GOOD_BACKUP, BACKUP_FILE);

    resolveProjectStoreIssue("start-fresh", { expectedRevision: null });

    expect(recoveryContents()).toEqual([GOOD_BACKUP]);
    expect(read(BACKUP_FILE)).toBe(GOOD_BACKUP);
    expect(inspectProjectStore().state).toBe("ok");
  });

  it("if writing the new store fails, the preserved copies remain and it can be retried", () => {
    const status = damagedWithBackup();
    intercept("renameSync", (args, real) => {
      if (String(args[1]).endsWith(STORE_FILE)) throw errnoError("EPERM");
      return real(...args);
    });

    expectStoreError(() => resolveProjectStoreIssue("start-fresh", { expectedRevision: status.revision }), "write-failed");
    vi.restoreAllMocks();

    expect(read()).toBe(DAMAGED);
    expect(recoveryContents().sort()).toEqual([DAMAGED, GOOD_BACKUP].sort());

    resolveProjectStoreIssue("start-fresh", { expectedRevision: status.revision });
    expect(inspectProjectStore().state).toBe("ok");
    expect(recoveryFiles()).toHaveLength(4);
  });

  it("missing primary with a corrupt backup: never started fresh implicitly; explicit Start Fresh keeps the corrupt backup", () => {
    write("{ corrupt backup", BACKUP_FILE);

    expectStoreError(() => loadProjectState(), "needs-recovery");
    expectStoreError(() => saveProject(profile("a")), "needs-recovery");
    expect(fs.existsSync(file())).toBe(false);
    expect(inspectProjectStore()).toMatchObject({
      state: "needs-recovery",
      reason: "missing-with-recovery-data",
      backupAvailable: false,
      availableActions: ["retry", "start-fresh"],
    });
    expectStoreError(() => resolveProjectStoreIssue("restore-backup", { expectedRevision: null }), "backup-unavailable");

    resolveProjectStoreIssue("start-fresh", { expectedRevision: null });
    saveProject(profile("a"));
    saveProject(profile("b"));

    expect(read(BACKUP_FILE)).not.toBe("{ corrupt backup");
    expect(recoveryContents()).toEqual(["{ corrupt backup"]);
  });

  it("if the backup can't be read, Start Fresh changes nothing", () => {
    const status = damagedWithBackup();
    intercept("readFileSync", (args, real) => {
      if (args[0] === file(BACKUP_FILE)) throw errnoError("EACCES");
      return real(...args);
    });

    expectStoreError(() => resolveProjectStoreIssue("start-fresh", { expectedRevision: status.revision }), "recovery-copy-failed");
    vi.restoreAllMocks();

    expect(read()).toBe(DAMAGED);
    expect(read(BACKUP_FILE)).toBe(GOOD_BACKUP);
  });

  it("is not available for a healthy or a future-format file", () => {
    const healthy = JSON.stringify({ profiles: [profile("a")], activeProfileId: "a" });
    write(healthy);
    expectStoreError(() => resolveProjectStoreIssue("start-fresh", { expectedRevision: sha(healthy) }), "recovery-not-available");

    const future = JSON.stringify({ schemaVersion: 2, profiles: [] });
    write(future);
    expectStoreError(() => resolveProjectStoreIssue("start-fresh", { expectedRevision: sha(future) }), "recovery-not-available");
    expect(read()).toBe(future);
    expect(recoveryFiles()).toEqual([]);
  });
});

describe("discard invalid entries", () => {
  const MIXED = JSON.stringify(
    {
      meta: { theme: "dark" },
      profiles: [profile("a", { notes: "kept" }), { name: "broken" }, profile("b"), profile("a", { name: "dup" })],
      activeProfileId: "b",
    },
    null,
    2,
  );

  it("keeps valid profiles, unknown fields and the active profile; preserves a full copy first", () => {
    write(MIXED);
    const status = inspectProjectStore();

    const after = resolveProjectStoreIssue("discard-invalid-entries", { expectedRevision: status.revision });

    const saved = JSON.parse(read());
    expect(saved).toEqual({
      meta: { theme: "dark" },
      profiles: [profile("a", { notes: "kept" }), profile("b")],
      activeProfileId: "b",
    });
    expect(recoveryContents()).toEqual([MIXED]);
    expect(read(BACKUP_FILE)).toBe(MIXED);
    expect(after).toMatchObject({ state: "ok", unavailableEntries: [], availableActions: ["retry"] });
  });

  it("clears an active ID that pointed at a discarded entry", () => {
    writeJson({ profiles: [profile("a"), profile("broken", { previewUrl: "x" })], activeProfileId: "broken" });

    resolveProjectStoreIssue("discard-invalid-entries", { expectedRevision: inspectProjectStore().revision });

    expect(JSON.parse(read()).activeProfileId).toBeNull();
    expect(loadProjectState().profiles.map((p) => p.id)).toEqual(["a"]);
    expect(loadProjectState().activeProfileId).toBeNull();
  });

  it("no repo stays selected across reloads and an app restart until the user picks one", async () => {
    writeJson({ profiles: [profile("a"), profile("broken", { previewUrl: "x" }), profile("b"), profile("c")], activeProfileId: "broken" });
    expect(loadProjectState().activeProfileId).toBeNull();

    resolveProjectStoreIssue("discard-invalid-entries", { expectedRevision: inspectProjectStore().revision });

    // Reload in the same process.
    expect(loadProjectState().activeProfileId).toBeNull();

    // Simulated restart: a fresh copy of the store module reads the file.
    vi.resetModules();
    const restarted = await import("../../electron/projectStore.js");
    expect(restarted.loadProjectState()).toMatchObject({ activeProfileId: null });
    expect(restarted.loadProject()).toBeNull();

    // Unrelated edits keep the intentional no-selection.
    restarted.deleteProject("c");
    restarted.saveProject(profile("b", { name: "Edited B" }), undefined);
    expect(restarted.loadProjectState().activeProfileId).toBe("b"); // saving a setup selects it, as before

    restarted.setActiveProject("a");
    expect(restarted.loadProject()?.id).toBe("a");
  });

  it("deleting a non-active profile keeps an intentional no-selection", () => {
    writeJson({ profiles: [profile("a"), profile("b")], activeProfileId: null });

    deleteProject("b");

    expect(JSON.parse(read()).activeProfileId).toBeNull();
    expect(loadProjectState().activeProfileId).toBeNull();
  });

  it("is not available without unavailable entries, or when the file is damaged", () => {
    const healthy = JSON.stringify({ profiles: [profile("a")], activeProfileId: "a" });
    write(healthy);
    expectStoreError(
      () => resolveProjectStoreIssue("discard-invalid-entries", { expectedRevision: sha(healthy) }),
      "recovery-not-available",
    );

    write(DAMAGED);
    expectStoreError(
      () => resolveProjectStoreIssue("discard-invalid-entries", { expectedRevision: sha(DAMAGED) }),
      "recovery-not-available",
    );
    expect(read()).toBe(DAMAGED);
    expect(recoveryFiles()).toEqual([]);
  });

  it("if the recovery copy fails, no entry is discarded", () => {
    write(MIXED);
    const status = inspectProjectStore();
    intercept("openSync", (args, real) => {
      if (String(args[0]).includes(RECOVERY_FILE_PREFIX)) throw errnoError("EACCES");
      return real(...args);
    });

    expectStoreError(
      () => resolveProjectStoreIssue("discard-invalid-entries", { expectedRevision: status.revision }),
      "recovery-copy-failed",
    );
    vi.restoreAllMocks();

    expect(read()).toBe(MIXED);
    expect(fs.existsSync(file(BACKUP_FILE))).toBe(false);
  });

  it("ordinary save and switch still never discard invalid entries", () => {
    write(MIXED);

    saveProject(profile("c"));
    setActiveProject("a");

    expect(JSON.parse(read()).profiles).toHaveLength(5);
  });
});

describe("revision propagation", () => {
  it("loaded and saved states carry the file revision; stale ones are rejected", () => {
    const first = saveProject(profile("a"));
    expect(first.revision).toBe(sha(read()));
    expect(loadProjectState().revision).toBe(first.revision);
    expect(inspectProjectStore().revision).toBe(first.revision);

    const second = saveProject(profile("b"), { expectedRevision: first.revision });
    expect(second.revision).toBe(sha(read()));

    expectStoreError(() => setActiveProject("a", { expectedRevision: first.revision }), "conflict");
    expect(setActiveProject("a", { expectedRevision: second.revision }).activeProfileId).toBe("a");
  });

  it("an empty store has a null revision that guards the first save", () => {
    expect(loadProjectState().revision).toBeNull();

    saveProject(profile("a"), { expectedRevision: null });
    expectStoreError(() => saveProject(profile("b"), { expectedRevision: null }), "conflict");
  });
});
