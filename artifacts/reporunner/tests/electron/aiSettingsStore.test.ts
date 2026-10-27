// Stage 4F: the main-process AI settings store, on the real file system in
// temporary folders, with an injected file system for failures. Synthetic,
// non-secret configurations only; nothing here touches real userData,
// credentials or the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AI_SETTINGS_FILE, AiSettingsStore, type AiSettingsFs } from "../../electron/aiSettingsStore.js";
import { AI_SETTINGS_FORMAT, AI_SETTINGS_MAX_BYTES, emptyAiSettings, type AiSettings } from "../../src/lib/ai/settingsSchema.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-aisettings-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, AI_SETTINGS_FILE);
const sha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const listDir = () => fs.readdirSync(dir).sort();

const local = (id: string, endpoint = "http://127.0.0.1:11434", apiStyle = "ollama-native", model: string | null = "llama3.1:8b") => ({
  id,
  kind: "local-endpoint" as const,
  endpoint,
  apiStyle: apiStyle as AiSettings["configs"][number]["apiStyle"],
  model,
});
const doc = (over: Partial<Record<keyof AiSettings, unknown>> = {}) =>
  ({ format: AI_SETTINGS_FORMAT, version: 1, active: null, configs: [], ...over }) as AiSettings;
const THREE = [local("cfg-a1"), local("cfg-b2", "http://[::1]:8080/v1", "openai-compatible", null), local("cfg-c3", "http://127.0.0.1:80")];

/** Node's fs, with chosen methods replaced, recording every call. */
function fsWith(overrides: Partial<Record<keyof AiSettingsFs, (...args: never[]) => unknown>> = {}) {
  const calls: Array<{ op: keyof AiSettingsFs; args: unknown[] }> = [];
  const real = fs as unknown as Record<keyof AiSettingsFs, (...args: unknown[]) => unknown>;
  const ops: Array<keyof AiSettingsFs> = ["lstatSync", "openSync", "fstatSync", "readSync", "writeSync", "fsyncSync", "closeSync", "renameSync", "unlinkSync"];
  const wrapped = {} as Record<keyof AiSettingsFs, (...args: unknown[]) => unknown>;
  for (const op of ops) {
    wrapped[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      const override = overrides[op] as ((...a: unknown[]) => unknown) | undefined;
      return override ? override(...args) : real[op](...args);
    };
  }
  return { fs: wrapped as unknown as AiSettingsFs, calls };
}
const fsError = (code: string) => Object.assign(new Error(`${code}: synthetic failure`), { code });
const store = (fsImpl?: AiSettingsFs) => new AiSettingsStore({ dir, fs: fsImpl });

async function saveFresh(settings: AiSettings) {
  const result = await store().save(settings, null);
  if (!result.ok) throw new Error(`save failed: ${result.error}`);
  return result;
}

describe("construction", () => {
  it("touches nothing on disk", () => {
    const { fs: f, calls } = fsWith();
    new AiSettingsStore({ dir, fs: f });
    expect(calls).toEqual([]);
    expect(listDir()).toEqual([]);
  });

  it("needs an absolute directory", () => {
    for (const bad of ["relative/dir", "", ".", `${dir}\0x`, null, undefined, 42]) {
      expect(() => new AiSettingsStore({ dir: bad as string })).toThrow(TypeError);
    }
  });
});

describe("missing file", () => {
  it("gives the empty document with nothing selected, and writes nothing", async () => {
    const { fs: f, calls } = fsWith();
    const result = await store(f).load();
    expect(result).toEqual({ status: "missing", settings: emptyAiSettings(), revision: null });
    expect(listDir()).toEqual([]);
    expect(calls.map((c) => c.op)).toEqual(["lstatSync"]);
  });

  it("loading repeatedly still writes nothing", async () => {
    const s = store();
    for (let i = 0; i < 3; i++) expect((await s.load()).status).toBe("missing");
    expect(listDir()).toEqual([]);
  });
});

describe("saving and loading", () => {
  it("round-trips one to three configurations with each selection", async () => {
    for (let n = 1; n <= 3; n++) {
      for (const active of [null, ...THREE.slice(0, n).map((c) => c.id)]) {
        fs.rmSync(file(), { force: true });
        const settings = doc({ configs: THREE.slice(0, n), active });
        const saved = await saveFresh(settings);
        expect(saved.settings).toEqual(settings);
        const bytes = fs.readFileSync(file());
        expect(saved.revision).toBe(sha(bytes));
        expect(await store().load()).toEqual({ status: "valid", settings, revision: saved.revision });
      }
    }
  });

  it("saves the empty document", async () => {
    const saved = await saveFresh(emptyAiSettings());
    expect(await store().load()).toEqual({ status: "valid", settings: emptyAiSettings(), revision: saved.revision });
  });

  it("chains saves through revisions", async () => {
    const s = store();
    const first = await s.save(doc({ configs: THREE.slice(0, 1) }), null);
    expect(first.ok).toBe(true);
    const second = await s.save(doc({ configs: THREE, active: "cfg-b2" }), first.ok ? first.revision : "");
    expect(second.ok).toBe(true);
    expect(await s.load()).toMatchObject({ status: "valid", settings: { active: "cfg-b2" } });
  });

  it("writes the schema's own serialization: fixed field order, no extra fields", async () => {
    const settings = doc({ configs: THREE, active: "cfg-a1" });
    await saveFresh(settings);
    const text = fs.readFileSync(file(), "utf8");
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual(["format", "version", "active", "configs"]);
    for (const c of parsed.configs) expect(Object.keys(c)).toEqual(["id", "kind", "endpoint", "apiStyle", "model"]);
    expect(text).not.toMatch(/key|token|secret|password|credential|authorization|header|slot/i);
  });

  it("returns a copy: changing the input after saving changes nothing", async () => {
    const settings = doc({ configs: [local("cfg-a1")] });
    const saved = await saveFresh(settings);
    (settings.configs[0] as { endpoint: string }).endpoint = "http://192.168.0.1:1";
    expect(saved.ok && saved.settings.configs[0].endpoint).toBe("http://127.0.0.1:11434");
  });
});

describe("lost updates are refused", () => {
  it("a save based on an old revision is a conflict and changes nothing", async () => {
    const s = store();
    const first = await s.save(doc({ configs: [local("cfg-a1")] }), null);
    const before = fs.readFileSync(file());
    expect(await s.save(doc({ configs: [local("cfg-zz")] }), null)).toEqual({ ok: false, error: "conflict" });
    expect(await s.save(doc(), "0".repeat(64))).toEqual({ ok: false, error: "conflict" });
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(first.ok).toBe(true);
  });

  it("a save expecting a file when there is none is a conflict", async () => {
    expect(await store().save(doc(), sha(Buffer.from("x")))).toEqual({ ok: false, error: "conflict" });
    expect(listDir()).toEqual([]);
  });

  it("a change made outside the store is detected", async () => {
    const saved = await saveFresh(doc({ configs: [local("cfg-a1")] }));
    const other = JSON.stringify(doc({ configs: [local("cfg-b2")] }));
    fs.writeFileSync(file(), other);
    expect(await store().save(doc(), saved.revision)).toEqual({ ok: false, error: "conflict" });
    expect(fs.readFileSync(file(), "utf8")).toBe(other);
  });
});

describe("invalid documents are refused before anything is touched", () => {
  const cases: Array<[string, unknown, string]> = [
    ["a secret field", { ...doc(), apiKey: "sk-SYNTHETIC-NOT-A-KEY" }, "unknown-field"],
    ["a token in a configuration", doc({ configs: [{ ...local("cfg-a1"), token: "SYNTHETIC" }] }), "unknown-field"],
    ["a credential slot", doc({ configs: [{ ...local("cfg-a1"), authSlot: "byok-slot-1" }] }), "unknown-field"],
    ["localhost", doc({ configs: [local("cfg-a1", "http://localhost:11434")] }), "invalid-endpoint"],
    ["a LAN host", doc({ configs: [local("cfg-a1", "http://192.168.1.5:11434")] }), "invalid-endpoint"],
    ["a public host", doc({ configs: [local("cfg-a1", "http://example.com:80")] }), "invalid-endpoint"],
    ["https", doc({ configs: [local("cfg-a1", "https://127.0.0.1:8443")] }), "invalid-endpoint"],
    ["a remote provider", doc({ configs: [{ id: "cfg-a1", kind: "remote-provider", provider: "x", model: null }] }), "unsupported-kind"],
    ["duplicate ids", doc({ configs: [local("cfg-a1"), local("cfg-a1", "http://[::1]:1")] }), "duplicate-config-id"],
    ["an active id that points at nothing", doc({ configs: [local("cfg-a1")], active: "cfg-b2" }), "invalid-active"],
    ["four configurations", doc({ configs: [...THREE, local("cfg-d4")] }), "too-many-configs"],
    ["a newer version", doc({ version: 2 }), "unsupported-version"],
    ["a path as an id", doc({ configs: [local("../../etc")] }), "invalid-config-id"],
    ["not an object", "settings", "invalid-shape"],
  ];
  it.each(cases)("%s", async (_name, value, detail) => {
    const { fs: f, calls } = fsWith();
    expect(await store(f).save(value, null)).toEqual({ ok: false, error: "invalid-settings", detail });
    expect(calls).toEqual([]);
    expect(listDir()).toEqual([]);
  });
});

describe("damaged, newer or unsafe files are reported and never touched", () => {
  const VALID = JSON.stringify(doc({ configs: [local("cfg-a1")] }));
  const damaged: Array<[string, string | Buffer, string]> = [
    ["empty file", "", "invalid-json"],
    ["invalid JSON", "{", "invalid-json"],
    ["truncated JSON", VALID.slice(0, VALID.length - 5), "invalid-json"],
    ["a BOM", "﻿" + VALID, "invalid-json"],
    ["invalid UTF-8", Buffer.concat([Buffer.from(VALID.slice(0, 10)), Buffer.from([0xff, 0xfe]), Buffer.from(VALID.slice(10))]), "invalid-encoding"],
    ["wrong format marker", JSON.stringify(doc({ format: "reporunner-credentials" })), "invalid-format"],
    ["unknown field", JSON.stringify({ ...doc(), extra: 1 }), "unknown-field"],
    ["a secret field", JSON.stringify({ ...doc(), apiKey: "sk-SYNTHETIC" }), "unknown-field"],
    ["invalid endpoint", JSON.stringify(doc({ configs: [local("cfg-a1", "http://10.0.0.1:11434")] })), "invalid-endpoint"],
    ["non-canonical endpoint", JSON.stringify(doc({ configs: [local("cfg-a1", "http://127.0.0.1:11434/")] })), "invalid-endpoint"],
    ["duplicate ids", JSON.stringify(doc({ configs: [local("cfg-a1"), local("cfg-a1", "http://[::1]:2")] })), "duplicate-config-id"],
    ["invalid active id", JSON.stringify(doc({ configs: [local("cfg-a1")], active: "cfg-x" })), "invalid-active"],
    ["version 0", JSON.stringify(doc({ version: 0 })), "invalid-version"],
    ["a JSON array", "[]", "invalid-shape"],
    ["oversized", JSON.stringify(doc()).replace("{", "{" + " ".repeat(AI_SETTINGS_MAX_BYTES)), "too-large"],
  ];

  it.each(damaged)("%s", async (_name, contents, reason) => {
    fs.writeFileSync(file(), contents);
    const before = fs.readFileSync(file());
    const s = store();
    expect(await s.load()).toEqual({ status: "damaged", reason });
    expect(await s.save(doc(), null)).toEqual({ ok: false, error: "damaged" });
    expect(await s.save(doc(), sha(before))).toEqual({ ok: false, error: "damaged" });
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(listDir()).toEqual([AI_SETTINGS_FILE]);
  });

  it("a newer version is reported as such, not as damage or as empty, and isn't rewritten", async () => {
    const newer = JSON.stringify({ format: AI_SETTINGS_FORMAT, version: 2, active: null, configs: [], providers: [] });
    fs.writeFileSync(file(), newer);
    const s = store();
    expect(await s.load()).toEqual({ status: "unsupported-version" });
    expect(await s.save(doc(), null)).toEqual({ ok: false, error: "unsupported-version" });
    expect(await s.save(doc(), sha(Buffer.from(newer)))).toEqual({ ok: false, error: "unsupported-version" });
    expect(fs.readFileSync(file(), "utf8")).toBe(newer);
    expect(listDir()).toEqual([AI_SETTINGS_FILE]);
  });

  it("an oversized file isn't read at all", async () => {
    fs.writeFileSync(file(), Buffer.alloc(AI_SETTINGS_MAX_BYTES + 1, 0x20));
    const { fs: f, calls } = fsWith();
    expect(await store(f).load()).toEqual({ status: "damaged", reason: "too-large" });
    expect(calls.map((c) => c.op)).toEqual(["lstatSync"]);
  });

  it("a file that grows after the size check is still bounded", async () => {
    fs.writeFileSync(file(), JSON.stringify(doc()));
    const big = Buffer.alloc(AI_SETTINGS_MAX_BYTES * 4, 0x20);
    let served = 0;
    const { fs: f } = fsWith({
      readSync: ((_fd: number, buffer: Buffer, offset: number, length: number) => {
        const n = Math.min(length, big.length - served);
        big.copy(buffer, offset, served, served + n);
        served += n;
        return n;
      }) as never,
    });
    expect(await store(f).load()).toEqual({ status: "damaged", reason: "too-large" });
    expect(served).toBe(AI_SETTINGS_MAX_BYTES + 1);
  });

  it("short reads are assembled correctly", async () => {
    const settings = doc({ configs: THREE, active: "cfg-c3" });
    const saved = await saveFresh(settings);
    const { fs: f } = fsWith({ readSync: ((fd: number, b: Buffer, o: number, _l: number, p: number | null) => fs.readSync(fd, b, o, 1, p)) as never });
    expect(await store(f).load()).toEqual({ status: "valid", settings, revision: saved.revision });
  });

  it("a directory at the file's path", async () => {
    fs.mkdirSync(file());
    const s = store();
    expect(await s.load()).toEqual({ status: "damaged", reason: "not-a-regular-file" });
    expect(await s.save(doc(), null)).toEqual({ ok: false, error: "damaged" });
    expect(fs.statSync(file()).isDirectory()).toBe(true);
    expect(listDir()).toEqual([AI_SETTINGS_FILE]);
  });

  it("a link at the file's path is never followed or replaced", async () => {
    // A valid settings file elsewhere, linked into place. Windows creates a
    // junction (no privilege needed), POSIX a file symlink.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rr-aisettings-outside-"));
    try {
      const target = path.join(outside, "elsewhere.json");
      const valid = JSON.stringify(doc({ configs: [local("cfg-a1")] }));
      fs.writeFileSync(target, valid);
      if (process.platform === "win32") fs.symlinkSync(outside, file(), "junction");
      else fs.symlinkSync(target, file(), "file");
      expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
      const s = store();
      expect(await s.load()).toEqual({ status: "damaged", reason: "not-a-regular-file" });
      expect(await s.save(doc(), null)).toEqual({ ok: false, error: "damaged" });
      expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe(valid);
      expect(listDir()).toEqual([AI_SETTINGS_FILE]);
    } finally {
      fs.rmSync(file(), { force: true, recursive: false });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a symlink reported by the file system (any platform) is refused, and open doesn't follow one swapped in", async () => {
    fs.writeFileSync(file(), JSON.stringify(doc()));
    const asLink = fsWith({ lstatSync: (() => ({ isFile: () => false, size: 10 })) as never });
    expect(await store(asLink.fs).load()).toEqual({ status: "damaged", reason: "not-a-regular-file" });
    expect(asLink.calls.map((c) => c.op)).toEqual(["lstatSync"]);
    const swapped = fsWith({ openSync: (() => { throw fsError("ELOOP"); }) as never });
    expect(await store(swapped.fs).load()).toEqual({ status: "damaged", reason: "not-a-regular-file" });
    const notFile = fsWith({ fstatSync: (() => ({ isFile: () => false, size: 0 })) as never });
    expect(await store(notFile.fs).load()).toEqual({ status: "damaged", reason: "not-a-regular-file" });
  });

  it("never offers a reset: the store has only load and save", () => {
    const methods = Object.getOwnPropertyNames(AiSettingsStore.prototype).filter((n) => n !== "constructor");
    const publicMethods = methods.filter((n) => !["serialized", "filePath", "readCurrent", "readBounded", "replaceFile", "syncDirectory"].includes(n));
    expect(publicMethods.sort()).toEqual(["load", "save"]);
  });
});

describe("file system errors", () => {
  it("unreadable files are reported with a fixed status and never written", async () => {
    fs.writeFileSync(file(), JSON.stringify(doc()));
    const before = fs.readFileSync(file());
    const failures: Array<Partial<Record<keyof AiSettingsFs, (...args: never[]) => unknown>>> = [
      { lstatSync: () => { throw fsError("EACCES"); } },
      { openSync: () => { throw fsError("EBUSY"); } },
      { fstatSync: () => { throw fsError("EIO"); } },
      { readSync: () => { throw fsError("EIO"); } },
      { lstatSync: () => { throw "not even an Error"; } },
    ];
    for (const override of failures) {
      const { fs: f, calls } = fsWith(override);
      const s = store(f);
      expect(await s.load()).toEqual({ status: "unreadable" });
      expect(await s.save(doc(), sha(before))).toEqual({ ok: false, error: "unreadable" });
      expect(calls.some((c) => c.op === "writeSync" || c.op === "renameSync" || c.op === "unlinkSync")).toBe(false);
      expect(fs.readFileSync(file()).equals(before)).toBe(true);
    }
  });
});

describe("atomic replacement", () => {
  it("writes only a new exclusive temp file (owner-only), then renames it over the target", async () => {
    const first = await saveFresh(doc({ configs: [local("cfg-a1")] }));
    const { fs: f, calls } = fsWith();
    const result = await store(f).save(doc({ configs: THREE }), first.revision);
    expect(result.ok).toBe(true);
    const writeOpens = calls.filter((c) => c.op === "openSync" && typeof c.args[1] === "string" && /w/.test(c.args[1] as string));
    expect(writeOpens).toHaveLength(1);
    const tmp = writeOpens[0].args[0] as string;
    expect(writeOpens[0].args.slice(1)).toEqual(["wx+", 0o600]);
    expect(path.dirname(tmp)).toBe(dir);
    expect(path.basename(tmp)).toMatch(/^reporunner-ai-settings\.json\.[0-9a-f]{16}\.tmp$/);
    expect(calls.filter((c) => c.op === "renameSync").map((c) => c.args)).toEqual([[tmp, file()]]);
    // The target is never opened for writing, and the temp file is synced before the rename.
    const order = calls.map((c) => c.op);
    expect(order.indexOf("fsyncSync")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("fsyncSync")).toBeLessThan(order.indexOf("renameSync"));
    expect(listDir()).toEqual([AI_SETTINGS_FILE]);
    if (process.platform !== "win32") expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("temp names are unique per save", async () => {
    const names: string[] = [];
    const { fs: f } = fsWith({ openSync: ((p: string, flags: string, mode?: number) => (typeof flags === "string" && flags === "wx+" && names.push(p), fs.openSync(p, flags, mode))) as never });
    const s = store(f);
    let rev: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = await s.save(doc({ configs: [local(`cfg-a${i}`)] }), rev);
      rev = r.ok ? r.revision : null;
    }
    expect(new Set(names).size).toBe(5);
  });

  const failingSteps: Array<[string, Partial<Record<keyof AiSettingsFs, (...args: never[]) => unknown>>]> = [
    ["creating the temp file", { openSync: ((p: string, flags: string | number, mode?: number) => { if (flags === "wx+") throw fsError("EACCES"); return fs.openSync(p, flags, mode); }) as never }],
    ["writing", { writeSync: () => { throw fsError("ENOSPC"); } }],
    ["a write that makes no progress", { writeSync: () => 0 }],
    ["syncing", { fsyncSync: () => { throw fsError("EIO"); } }],
    ["reading it back (different bytes)", {
      readSync: ((fd: number, b: Buffer, o: number, l: number, p: number | null) => {
        const n = fs.readSync(fd, b, o, l, p);
        if (p !== null && n > 0) b[o] ^= 0xff;
        return n;
      }) as never,
    }],
    ["closing", { closeSync: ((fd: number) => { fs.closeSync(fd); throw fsError("EIO"); }) as never }],
    ["renaming (as when Windows has the file open elsewhere)", { renameSync: () => { throw fsError("EPERM"); } }],
    ["renaming (busy)", { renameSync: () => { throw fsError("EBUSY"); } }],
  ];

  it.each(failingSteps)("a failure while %s keeps the old document and leaves no temp file", async (_name, override) => {
    const settings = doc({ configs: [local("cfg-a1")], active: "cfg-a1" });
    const first = await saveFresh(settings);
    const before = fs.readFileSync(file());
    const { fs: f } = fsWith(override);
    const s = store(f);
    expect(await s.save(doc({ configs: THREE }), first.revision)).toEqual({ ok: false, error: "write-failed" });
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(listDir()).toEqual([AI_SETTINGS_FILE]);
    // The original document still loads, through a working store.
    expect(await store().load()).toEqual({ status: "valid", settings, revision: first.revision });
  });

  it("a write that makes no progress fails at once, before syncing or replacing anything", async () => {
    const first = await saveFresh(doc());
    const { fs: f, calls } = fsWith({ writeSync: () => 0 });
    expect(await store(f).save(doc({ configs: [local("cfg-a1")] }), first.revision)).toEqual({ ok: false, error: "write-failed" });
    expect(calls.some((c) => c.op === "fsyncSync" || c.op === "renameSync")).toBe(false);
    expect(listDir()).toEqual([AI_SETTINGS_FILE]);
  });

  it("a failed first save leaves no file at all", async () => {
    const { fs: f } = fsWith({ renameSync: () => { throw fsError("EPERM"); } });
    expect(await store(f).save(doc(), null)).toEqual({ ok: false, error: "write-failed" });
    expect(listDir()).toEqual([]);
  });

  it("refuses to rename over something that became a non-file after the check", async () => {
    const first = await saveFresh(doc());
    const before = fs.readFileSync(file());
    let lstats = 0;
    const { fs: f, calls } = fsWith({
      lstatSync: ((p: string) => (++lstats === 2 ? { isFile: () => false, size: 0 } : fs.lstatSync(p))) as never,
    });
    expect(await store(f).save(doc({ configs: [local("cfg-a1")] }), first.revision)).toEqual({ ok: false, error: "write-failed" });
    expect(calls.some((c) => c.op === "renameSync")).toBe(false);
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(listDir()).toEqual([AI_SETTINGS_FILE]);
  });

  it("a temp-file cleanup failure still reports the failure", async () => {
    const first = await saveFresh(doc());
    const { fs: f } = fsWith({ renameSync: () => { throw fsError("EPERM"); }, unlinkSync: () => { throw fsError("EPERM"); } });
    expect(await store(f).save(doc({ configs: [local("cfg-a1")] }), first.revision)).toEqual({ ok: false, error: "write-failed" });
  });

  it("leftover temp files are ignored by load", async () => {
    const saved = await saveFresh(doc({ configs: [local("cfg-a1")] }));
    fs.writeFileSync(path.join(dir, `${AI_SETTINGS_FILE}.0123456789abcdef.tmp`), "{garbage");
    expect(await store().load()).toMatchObject({ status: "valid", revision: saved.revision });
  });
});

describe("ordering", () => {
  it("operations run one at a time, in call order", async () => {
    const s = store();
    const a = doc({ configs: [local("cfg-a1")] });
    const b = doc({ configs: [local("cfg-b2")] });
    const [l1, s1, l2, s2, s3, l3] = await Promise.all([s.load(), s.save(a, null), s.load(), s.save(b, null), s.save(b, sha(Buffer.from("stale"))), s.load()]);
    expect(l1.status).toBe("missing");
    expect(s1.ok).toBe(true);
    expect(l2).toEqual({ status: "valid", settings: a, revision: s1.ok ? s1.revision : "" });
    // Both later saves were based on stale revisions: refused, not lost-update overwrites.
    expect(s2).toEqual({ ok: false, error: "conflict" });
    expect(s3).toEqual({ ok: false, error: "conflict" });
    expect(l3).toEqual(l2);
  });

  it("two saves from the same revision: exactly the first wins", async () => {
    const s = store();
    const base = await s.save(doc(), null);
    const rev = base.ok ? base.revision : "";
    const [x, y] = await Promise.all([s.save(doc({ configs: [local("cfg-x1")] }), rev), s.save(doc({ configs: [local("cfg-y1")] }), rev)]);
    expect(x.ok).toBe(true);
    expect(y).toEqual({ ok: false, error: "conflict" });
    expect(await s.load()).toMatchObject({ status: "valid", settings: { configs: [{ id: "cfg-x1" }] } });
  });

  it("file operations never interleave between calls", async () => {
    const { fs: f, calls } = fsWith();
    const s = store(f);
    const marks: number[] = [];
    const mark = <T>(p: Promise<T>) => p.then((r) => (marks.push(calls.length), r));
    await Promise.all([mark(s.save(doc(), null)), mark(s.load()), mark(s.load())]);
    // Each call's operations finished before the next began: the boundaries only grow.
    expect(marks).toEqual([...marks].sort((x, y) => x - y));
    const saveOps = calls.slice(0, marks[0]).map((c) => c.op);
    expect(saveOps.at(-1)).not.toBe("lstatSync");
    expect(calls.slice(marks[0], marks[1]).map((c) => c.op)[0]).toBe("lstatSync");
  });

  it("a failed operation doesn't stop the next one", async () => {
    let fail = true;
    const { fs: f } = fsWith({ lstatSync: ((p: string) => { if (fail) { fail = false; throw fsError("EACCES"); } return fs.lstatSync(p); }) as never });
    const s = store(f);
    const [first, second] = await Promise.all([s.load(), s.load()]);
    expect(first).toEqual({ status: "unreadable" });
    expect(second.status).toBe("missing");
  });
});

describe("results", () => {
  it("never contain paths, file contents or system messages", async () => {
    fs.writeFileSync(file(), "{ SYNTHETIC-CONTENT");
    const { fs: f } = fsWith({ renameSync: () => { throw fsError("EPERM"); } });
    const outputs = [await store().load(), await store(f).save(doc(), null), await store().save({ apiKey: "sk-SYNTHETIC" }, null)];
    const text = JSON.stringify(outputs);
    for (const leak of [dir, "SYNTHETIC", "synthetic failure", "EPERM", os.tmpdir()]) expect(text).not.toContain(leak);
  });

  it("use a small fixed set of codes", async () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/aiSettingsStore.ts"), "utf8");
    const statuses = [...new Set([...source.matchAll(/status: "([a-z-]+)"/g)].map((m) => m[1]))].sort();
    expect(statuses).toEqual(["damaged", "missing", "unreadable", "unsupported-version", "valid"]);
    const errors = [...new Set([...source.matchAll(/error: "([a-z-]+)"/g)].map((m) => m[1]))].sort();
    expect(errors).toEqual(["conflict", "invalid-settings", "write-failed"]);
  });
});

describe("module boundaries", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const source = fs.readFileSync(path.join(ROOT, "electron/aiSettingsStore.ts"), "utf8");
  const code = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

  it("imports only fs, path, crypto and the Stage 4E schema", () => {
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../src/lib/ai/settingsSchema.js", "crypto", "fs", "path"]);
  });

  it("has no Electron, network, credential, environment or dynamic-code access", () => {
    expect(code).not.toMatch(
      /["']electron["']|["']node:|\bfetch\(|XMLHttpRequest|WebSocket|["'](net|dns|http|https|tls|dgram|child_process)["']|\brequire\(|\bimport\(|credentialStore|credentialService|getCredential|safeStorage|process\.env|\beval\(|new Function|console\.|providerReadiness|localEndpoint|ipcMain|ipcRenderer/,
    );
  });

  it("nothing in the app imports or creates it, apart from the (unused) Stage 4G service", () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|cts|mts)$/.test(entry.name) && ![path.join(ROOT, "electron/aiSettingsStore.ts"), path.join(ROOT, "electron/aiSettingsService.ts")].includes(full) && /aiSettingsStore|AiSettingsStore|reporunner-ai-settings\.json/.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(path.join(ROOT, "src"));
    walk(path.join(ROOT, "electron"));
    expect(offenders).toEqual([]);
    // Only the service constructs a store.
    const electronDir = path.join(ROOT, "electron");
    const constructing = fs.readdirSync(electronDir).filter((f) => f.endsWith(".ts") && /new AiSettingsStore\(/.test(fs.readFileSync(path.join(electronDir, f), "utf8")));
    expect(constructing).toEqual(["aiSettingsService.ts"]);
  });
});
