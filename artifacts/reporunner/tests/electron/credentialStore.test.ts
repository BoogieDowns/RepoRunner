// Stage 3D: the main-process credential store, with a fake safeStorage and the
// real file system in temporary folders. Synthetic secrets only; no assertion
// prints a secret (checks compare booleans or use toBe on known values).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESERVED_SECRET_VARIABLES } from "../../electron/childEnvironment.js";
import {
  CREDENTIAL_FILE,
  CREDENTIAL_SLOTS,
  CredentialStore,
  CredentialStoreError,
  MAX_FILE_BYTES,
  MAX_SECRET_LENGTH,
  type CredentialFs,
  type SafeStorageLike,
} from "../../electron/credentialStore.js";

const SECRET_1 = "rr-synthetic-secret-ONE-7f3a";
const SECRET_2 = "rr-synthetic-secret-TWO-91bc";
const SECRET_3 = "rr-synthetic-secret-THREE-0d4e";

/** "Encryption" that visibly transforms the bytes (XOR plus a marker), so plaintext never appears. */
function fakeSafeStorage(over: Partial<SafeStorageLike> & { backend?: string } = {}) {
  const calls = { encrypt: 0, decrypt: 0, backend: 0 };
  const store: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => (calls.encrypt++, Buffer.concat([Buffer.from("ENC1"), Buffer.from(s, "utf8").map((b) => b ^ 0x5a)])),
    decryptString: (b: Buffer) => {
      calls.decrypt++;
      if (b.subarray(0, 4).toString() !== "ENC1") throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return Buffer.from(b.subarray(4).map((x) => x ^ 0x5a)).toString("utf8");
    },
    getSelectedStorageBackend: () => (calls.backend++, over.backend ?? "gnome_libsecret"),
    ...over,
  };
  return { store, calls };
}

let dir: string;
const file = () => path.join(dir, CREDENTIAL_FILE);
const make = (safeStorage = fakeSafeStorage().store, extra: Partial<ConstructorParameters<typeof CredentialStore>[0]> = {}) =>
  new CredentialStore({ dir, safeStorage, platform: "win32", ...extra });
const listDir = () => fs.readdirSync(dir).sort();
const containsAny = (text: string, secrets = [SECRET_1, SECRET_2, SECRET_3]) => secrets.some((s) => text.includes(s) || text.includes(Buffer.from(s).toString("base64")));
async function failure(p: Promise<unknown>): Promise<CredentialStoreError> {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(CredentialStoreError);
  const e = error as CredentialStoreError;
  // No secret, path or system detail in any refusal.
  expect(containsAny(`${e.message} ${e.stack ?? ""}`)).toBe(false);
  expect(e.message.includes(dir)).toBe(false);
  return e;
}
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-3d-store-"));
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
});
afterEach(() => {
  // The store never logs.
  for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("remembered credentials", () => {
  it("are encrypted to their own file, never in plaintext, and a new store instance reads them back", async () => {
    await make().setCredential("byok-slot-1", SECRET_1, { remember: true });
    expect(listDir()).toEqual([CREDENTIAL_FILE]);
    const raw = fs.readFileSync(file(), "utf8");
    expect(containsAny(raw)).toBe(false);
    const parsed = JSON.parse(raw);
    expect([parsed.format, parsed.version, Object.keys(parsed.credentials)]).toEqual(["reporunner-credentials", 1, ["byok-slot-1"]]);
    expect((await make().getCredential("byok-slot-1")) === SECRET_1).toBe(true);
  });

  it("keep each slot separate: no slot ever returns another's credential", async () => {
    const store = make();
    await store.setCredential("byok-slot-1", SECRET_1, { remember: true });
    await store.setCredential("byok-slot-2", SECRET_2, { remember: true });
    await store.setCredential("byok-slot-3", SECRET_3, { remember: false });
    const fresh = make();
    expect([(await fresh.getCredential("byok-slot-1")) === SECRET_1, (await fresh.getCredential("byok-slot-2")) === SECRET_2, await fresh.getCredential("byok-slot-3")]).toEqual([true, true, null]);
    await fresh.removeCredential("byok-slot-1");
    expect([await fresh.getCredential("byok-slot-1"), (await fresh.getCredential("byok-slot-2")) === SECRET_2]).toEqual([null, true]);
  });

  it("replacing a credential keeps only the new one", async () => {
    const store = make();
    await store.setCredential("byok-slot-1", SECRET_1, { remember: true });
    await store.setCredential("byok-slot-1", SECRET_2, { remember: true });
    expect((await make().getCredential("byok-slot-1")) === SECRET_2).toBe(true);
    expect(containsAny(fs.readFileSync(file(), "utf8"))).toBe(false);
  });

  it("leave no temporary files behind", async () => {
    const store = make();
    for (const slot of CREDENTIAL_SLOTS) await store.setCredential(slot, SECRET_1, { remember: true });
    await store.removeCredential("byok-slot-2");
    expect(listDir()).toEqual([CREDENTIAL_FILE]);
  });
});

describe("session-only credentials", () => {
  it("are never written, and are gone in a new store (as after a restart)", async () => {
    const store = make();
    await store.setCredential("byok-slot-1", SECRET_1, { remember: false });
    expect((await store.getCredential("byok-slot-1")) === SECRET_1).toBe(true);
    expect(listDir()).toEqual([]);
    expect(await make().getCredential("byok-slot-1")).toBeNull();
  });

  it("remembered → session-only removes the remembered copy, so it can't come back", async () => {
    const store = make();
    await store.setCredential("byok-slot-1", SECRET_1, { remember: true });
    await store.setCredential("byok-slot-1", SECRET_2, { remember: false });
    expect(JSON.parse(fs.readFileSync(file(), "utf8")).credentials).toEqual({});
    expect((await store.getCredential("byok-slot-1")) === SECRET_2).toBe(true);
    expect(await make().getCredential("byok-slot-1")).toBeNull();
  });

  it("session-only → remembered clears the session copy", async () => {
    const store = make();
    await store.setCredential("byok-slot-1", SECRET_1, { remember: false });
    await store.setCredential("byok-slot-1", SECRET_2, { remember: true });
    expect(await store.status("byok-slot-1")).toEqual({ configured: true, mode: "remembered" });
    expect((await store.getCredential("byok-slot-1")) === SECRET_2).toBe(true);
  });

  it("if the remembered copy can't be removed, nothing changes", async () => {
    const store = make();
    await store.setCredential("byok-slot-1", SECRET_1, { remember: true });
    const before = fs.readFileSync(file());
    const failing = make(undefined, { fs: { ...(fs as unknown as CredentialFs), renameSync: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } } });
    expect((await failure(failing.setCredential("byok-slot-1", SECRET_2, { remember: false }))).code).toBe("write-failed");
    expect(await failing.status("byok-slot-1")).toEqual({ configured: true, mode: "remembered" });
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
  });

  it("removal clears the session copy too", async () => {
    const store = make();
    await store.setCredential("byok-slot-1", SECRET_1, { remember: false });
    await store.removeCredential("byok-slot-1");
    expect(await store.getCredential("byok-slot-1")).toBeNull();
    expect(await store.status("byok-slot-1")).toEqual({ configured: false, mode: null });
  });
});

describe("encryption backend checks", () => {
  it("unavailable encryption: remembering is refused with nothing written; session-only still works", async () => {
    const { store: safe } = fakeSafeStorage({ isEncryptionAvailable: () => false });
    const store = make(safe);
    expect(store.persistenceAvailability()).toEqual({ available: false, reason: "encryption-unavailable" });
    expect((await failure(store.setCredential("byok-slot-1", SECRET_1, { remember: true }))).code).toBe("encryption-unavailable");
    expect(listDir()).toEqual([]);
    await store.setCredential("byok-slot-1", SECRET_1, { remember: false });
    expect((await store.getCredential("byok-slot-1")) === SECRET_1).toBe(true);
  });

  it("Linux basic_text or unknown backend: refused as insecure; a real keyring is accepted", async () => {
    for (const backend of ["basic_text", "unknown"]) {
      const store = make(fakeSafeStorage({ backend }).store, { platform: "linux" });
      expect(store.persistenceAvailability(), backend).toEqual({ available: false, reason: "encryption-insecure" });
      expect((await failure(store.setCredential("byok-slot-1", SECRET_1, { remember: true }))).code, backend).toBe("encryption-insecure");
    }
    expect(listDir()).toEqual([]);
    const ok = make(fakeSafeStorage({ backend: "gnome_libsecret" }).store, { platform: "linux" });
    await ok.setCredential("byok-slot-1", SECRET_1, { remember: true });
    expect((await ok.getCredential("byok-slot-1")) === SECRET_1).toBe(true);
  });

  it("Windows doesn't consult the Linux-only backend check", () => {
    const { store: safe, calls } = fakeSafeStorage();
    expect(make(safe).persistenceAvailability()).toEqual({ available: true });
    expect(calls.backend).toBe(0);
  });

  it("a remembered credential can't be read when encryption becomes unavailable", async () => {
    await make().setCredential("byok-slot-1", SECRET_1, { remember: true });
    expect((await failure(make(fakeSafeStorage({ isEncryptionAvailable: () => false }).store).getCredential("byok-slot-1"))).code).toBe("encryption-unavailable");
  });

  it("encryption and decryption failures are refused without detail", async () => {
    const encryptFails = make(fakeSafeStorage({ encryptString: () => { throw new Error(`boom ${SECRET_1}`); } }).store);
    expect((await failure(encryptFails.setCredential("byok-slot-1", SECRET_1, { remember: true }))).code).toBe("encrypt-failed");
    expect(listDir()).toEqual([]);
    await make().setCredential("byok-slot-1", SECRET_1, { remember: true });
    const decryptFails = make(fakeSafeStorage({ decryptString: () => { throw new Error(`boom ${SECRET_1}`); } }).store);
    expect((await failure(decryptFails.getCredential("byok-slot-1"))).code).toBe("decrypt-failed");
  });
});

describe("damaged, newer and oversized files are refused and never rewritten", () => {
  const good = () => JSON.stringify({ format: "reporunner-credentials", version: 1, credentials: {} });
  const cases: Array<[string, string | Buffer, string]> = [
    ["not JSON", "{not json", "store-corrupt"],
    ["wrong format marker", JSON.stringify({ format: "other", version: 1, credentials: {} }), "store-corrupt"],
    ["extra top-level key", JSON.stringify({ format: "reporunner-credentials", version: 1, credentials: {}, plaintext: "x" }), "store-corrupt"],
    ["unknown slot", JSON.stringify({ format: "reporunner-credentials", version: 1, credentials: { "../evil": "QUJD" } }), "store-corrupt"],
    ["prototype key", '{"format":"reporunner-credentials","version":1,"credentials":{"__proto__":"QUJD"}}', "store-corrupt"],
    ["non-base64 value", JSON.stringify({ format: "reporunner-credentials", version: 1, credentials: { "byok-slot-1": "not base64!" } }), "store-corrupt"],
    ["array credentials", JSON.stringify({ format: "reporunner-credentials", version: 1, credentials: [] }), "store-corrupt"],
    ["older/invalid version", JSON.stringify({ format: "reporunner-credentials", version: 0, credentials: {} }), "store-corrupt"],
    ["newer version", JSON.stringify({ format: "reporunner-credentials", version: 2, credentials: { "byok-slot-1": "QUJD" } }), "unsupported-version"],
    ["oversized", Buffer.alloc(MAX_FILE_BYTES + 1, 0x20), "store-corrupt"],
  ];
  it.each(cases)("%s", async (_name, content, code) => {
    fs.writeFileSync(file(), content);
    const before = fs.readFileSync(file());
    const store = make();
    expect((await failure(store.getCredential("byok-slot-1"))).code).toBe(code);
    expect((await failure(store.setCredential("byok-slot-2", SECRET_2, { remember: true }))).code).toBe(code);
    expect((await failure(store.removeCredential("byok-slot-1"))).code).toBe(code);
    expect((await failure(store.setCredential("byok-slot-1", SECRET_1, { remember: false }))).code).toBe(code);
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(listDir()).toEqual([CREDENTIAL_FILE]);
    void good;
  });

  it("an oversized file is refused from its size alone, without being read into memory", async () => {
    fs.writeFileSync(file(), Buffer.alloc(MAX_FILE_BYTES + 1, 0x20));
    const readFileSync = vi.fn((f: string) => fs.readFileSync(f));
    const store = make(undefined, { fs: { ...(fs as unknown as CredentialFs), readFileSync } });
    expect((await failure(store.getCredential("byok-slot-1"))).code).toBe("store-corrupt");
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("a truncated encrypted value fails to decrypt", async () => {
    fs.writeFileSync(file(), JSON.stringify({ format: "reporunner-credentials", version: 1, credentials: { "byok-slot-1": Buffer.from("EN").toString("base64") } }));
    expect((await failure(make().getCredential("byok-slot-1"))).code).toBe("decrypt-failed");
  });
});

describe("file-system failures leave the previous file intact", () => {
  const withFs = (over: Partial<CredentialFs>) => make(undefined, { fs: { ...(fs as unknown as CredentialFs), ...over } });
  const errno = (code: string) => () => { throw Object.assign(new Error(`${code}: ${dir}`), { code }); };

  it.each([
    ["permission denied creating the temp file", { openSync: errno("EACCES") }],
    ["disk full while writing", { writeSync: errno("ENOSPC") }],
    ["flush failure", { fsyncSync: errno("EIO") }],
    ["interrupted replacement (rename fails)", { renameSync: errno("EPERM") }],
  ] as Array<[string, Partial<CredentialFs>]>)("%s", async (_name, over) => {
    await make().setCredential("byok-slot-1", SECRET_1, { remember: true });
    const before = fs.readFileSync(file());
    expect((await failure(withFs(over).setCredential("byok-slot-1", SECRET_2, { remember: true }))).code).toBe("write-failed");
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(listDir()).toEqual([CREDENTIAL_FILE]);
    expect((await make().getCredential("byok-slot-1")) === SECRET_1).toBe(true);
  });

  it("an unreadable file is reported as read-failed", async () => {
    await make().setCredential("byok-slot-1", SECRET_1, { remember: true });
    expect((await failure(withFs({ statSync: errno("EACCES") }).getCredential("byok-slot-1"))).code).toBe("read-failed");
  });

  it("removing an absent credential is fine and writes nothing", async () => {
    await make().removeCredential("byok-slot-2");
    expect(listDir()).toEqual([]);
  });
});

describe("input validation", () => {
  it("only the exact slot labels are accepted", async () => {
    const store = make();
    for (const slot of ["byok-slot-4", "BYOK-SLOT-1", " byok-slot-1", "../byok-slot-1", "__proto__", "constructor", "toString", "", 1, null]) {
      expect((await failure(store.setCredential(slot as never, SECRET_1, { remember: true }))).code, String(slot)).toBe("invalid-slot");
      expect((await failure(store.getCredential(slot as never))).code, String(slot)).toBe("invalid-slot");
      expect((await failure(store.status(slot as never))).code, String(slot)).toBe("invalid-slot");
    }
    expect(listDir()).toEqual([]);
  });

  it("empty, oversized, multi-line or non-string secrets are refused", async () => {
    for (const secret of ["", "x".repeat(MAX_SECRET_LENGTH + 1), "line1\nline2", "a\u0000b", 42, null]) {
      expect((await failure(make().setCredential("byok-slot-1", secret as never, { remember: true }))).code).toBe("invalid-secret");
    }
    expect(listDir()).toEqual([]);
  });
});

describe("isolation", () => {
  it("status is metadata only", async () => {
    const store = make();
    await store.setCredential("byok-slot-1", SECRET_1, { remember: true });
    await store.setCredential("byok-slot-2", SECRET_2, { remember: false });
    const statuses = [await store.status("byok-slot-1"), await store.status("byok-slot-2"), await store.status("byok-slot-3")];
    expect(statuses).toEqual([{ configured: true, mode: "remembered" }, { configured: true, mode: "session" }, { configured: false, mode: null }]);
    expect(containsAny(JSON.stringify(statuses))).toBe(false);
  });

  it("never touches process.env (no reserved name is set; nothing is added or changed)", async () => {
    const before = JSON.stringify(Object.entries(process.env).sort());
    const store = make();
    await store.setCredential("byok-slot-1", SECRET_1, { remember: true });
    await store.setCredential("byok-slot-2", SECRET_2, { remember: false });
    await store.getCredential("byok-slot-1");
    expect(JSON.stringify(Object.entries(process.env).sort())).toBe(before);
    for (const name of RESERVED_SECRET_VARIABLES) expect(process.env[name]).toBeUndefined();
    expect(containsAny(JSON.stringify(process.env))).toBe(false);
  });

  it("concurrent operations on one store don't lose updates", async () => {
    const store = make();
    await Promise.all([
      store.setCredential("byok-slot-1", SECRET_1, { remember: true }),
      store.setCredential("byok-slot-2", SECRET_2, { remember: true }),
      store.setCredential("byok-slot-3", SECRET_3, { remember: true }),
      store.removeCredential("byok-slot-2"),
      store.setCredential("byok-slot-2", SECRET_2, { remember: true }),
    ]);
    const fresh = make();
    expect([(await fresh.getCredential("byok-slot-1")) === SECRET_1, (await fresh.getCredential("byok-slot-2")) === SECRET_2, (await fresh.getCredential("byok-slot-3")) === SECRET_3]).toEqual([true, true, true]);
    // A failing operation doesn't block the ones after it.
    await expect(store.setCredential("nope" as never, SECRET_1, { remember: true })).rejects.toThrow();
    await store.removeCredential("byok-slot-3");
    expect(await make().getCredential("byok-slot-3")).toBeNull();
  });

  it("the module has no import-time effects and no logging, environment, IPC or network use", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/credentialStore.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/console\.|process\.env|ipcMain|ipcRenderer|contextBridge|from "electron"|\bfetch\(|https?\.|child_process|REPORUNNER_/);
    expect([...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort()).toEqual(["crypto", "fs", "path"]);
    // Top level is declarations only: nothing runs on import.
    expect(code.split(/\r?\n/).filter((l) => /^[A-Za-z_$][\w$.]*\(/.test(l))).toEqual([]);
  });
});
