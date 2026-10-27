// Stage 4B: the credential service and its three IPC handlers, end to end
// through the real ipc.ts registration and sender guard, the real service and
// the real credential store, with a fake safeStorage and a temporary userData
// folder. Synthetic secrets only; assertions compare booleans or known values
// and never print a secret.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  userData: "",
  /** Options passed to every CredentialStore constructed. */
  constructed: [] as unknown[],
  available: true,
  getPathThrows: false,
  calls: { isEncryptionAvailable: 0, encryptString: 0, decryptString: 0 },
}));

const fakeSafeStorage = {
  isEncryptionAvailable: () => (h.calls.isEncryptionAvailable++, h.available),
  encryptString: (s: string) => (h.calls.encryptString++, Buffer.concat([Buffer.from("ENC1"), Buffer.from(s, "utf8").map((b) => b ^ 0x5a)])),
  decryptString: (b: Buffer) => (h.calls.decryptString++, Buffer.from(b.subarray(4).map((x) => x ^ 0x5a)).toString("utf8")),
  getSelectedStorageBackend: () => "gnome_libsecret",
};

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
  app: {
    getPath: (name: string) => {
      if (h.getPathThrows) throw new Error(`EACCES: C:\\secret\\${name}`);
      if (name !== "userData") throw new Error(`unexpected path ${name}`);
      return h.userData;
    },
  },
  get safeStorage() {
    return fakeSafeStorage;
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  clipboard: { writeText: () => {} },
  shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
}));
// Counts every store construction; otherwise the real store.
vi.mock("../../electron/credentialStore.js", async (original) => {
  const real = await original<typeof import("../../electron/credentialStore.js")>();
  class CountingStore extends real.CredentialStore {
    constructor(options: import("../../electron/credentialStore.js").CredentialStoreOptions) {
      super(options);
      h.constructed.push(options);
    }
  }
  return { ...real, CredentialStore: CountingStore };
});
// The general handlers' collaborators: inert, so the Free handlers can be exercised.
vi.mock("child_process", () => ({ spawn: vi.fn(), execFile: vi.fn(), exec: vi.fn() }));
vi.mock("../../electron/projectStore.js", () => ({
  loadProject: () => null,
  loadProjectState: () => ({ profiles: [], activeProfileId: null, revision: null }),
  saveProject: vi.fn(),
  setActiveProject: vi.fn(),
  deleteProject: vi.fn(),
  inspectProjectStore: () => ({ state: "ok" }),
  resolveProjectStoreIssue: vi.fn(),
  getProjectStoreRevealTarget: () => ({ kind: "file", path: "C:\\x" }),
}));
vi.mock("../../electron/processManager.js", () => ({
  startService: vi.fn(async () => {}),
  stopAllServices: vi.fn(async () => {}),
  waitForServiceSettled: vi.fn(async () => {}),
  getStatuses: () => ({ frontend: "stopped", backend: "stopped" }),
}));
vi.mock("../../electron/logSink.js", () => ({ emitLog: vi.fn(), clearLogs: vi.fn(), formatLogsForClipboard: () => "logs" }));

import { DEV_URL, FakeContents, FakeFrame, PACKAGED_URL, trustedRenderer } from "./fakeSender.js";
import { UNTRUSTED_SENDER_MESSAGE } from "../../electron/ipcTrust.js";
import { CREDENTIAL_FILE, MAX_SECRET_BYTES } from "../../electron/credentialStore.js";

const KEY_1 = "rr-synthetic-ipc-key-ONE-5c2e";
const KEY_2 = "rr-synthetic-ipc-key-TWO-a913";
const CHANNELS = ["credential-status", "credential-set", "credential-remove"] as const;
const GENERAL_CALLS: Array<[string, unknown[]]> = [
  ["load-project", []], ["load-project-state", []], ["get-project-store-status", []], ["get-statuses", []],
  ["select-folder", []], ["copy-logs", []], ["clear-logs", []], ["stop-services", []],
];

let app: ReturnType<typeof trustedRenderer>;
const file = () => path.join(h.userData, CREDENTIAL_FILE);
const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!(app.event(), ...args) as Promise<Record<string, unknown>>;
const leaks = (value: unknown, keys = [KEY_1, KEY_2]) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return keys.some((k) => text.includes(k) || text.includes(Buffer.from(k).toString("base64")));
};
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
let envBefore = "";

/** A fresh main process: module state (the store singleton, the busy flag) starts over; userData stays. */
async function startApp(trustUrl = PACKAGED_URL) {
  vi.resetModules();
  h.handlers.clear();
  const { setupIpc } = await import("../../electron/ipc.js");
  app = trustedRenderer(trustUrl);
  setupIpc(app.trust);
}

beforeEach(async () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "rr-4b-ipc-"));
  h.constructed.length = 0;
  h.available = true;
  h.getPathThrows = false;
  h.calls = { isEncryptionAvailable: 0, encryptString: 0, decryptString: 0 };
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
  envBefore = JSON.stringify(Object.entries(process.env).sort());
  await startApp();
});
afterEach(() => {
  for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();
  expect(JSON.stringify(Object.entries(process.env).sort())).toBe(envBefore);
  vi.restoreAllMocks();
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe("one lazy credential store", () => {
  it("app startup and ordinary Free handlers never create the store or touch its file", async () => {
    for (const [channel, args] of GENERAL_CALLS) await h.handlers.get(channel)!(app.event(), ...args);
    expect(h.constructed).toHaveLength(0);
    expect(h.calls.isEncryptionAvailable).toBe(0);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("importing the service does nothing", async () => {
    vi.resetModules();
    await import("../../electron/credentialService.js");
    expect(h.constructed).toHaveLength(0);
  });

  it("the first credential call creates exactly one store, in userData with Electron's safeStorage; later calls share it", async () => {
    await call("credential-status", "byok-slot-1");
    expect(h.constructed).toHaveLength(1);
    const options = h.constructed[0] as { dir: string; safeStorage: unknown; fs?: unknown; platform?: unknown };
    expect(options.dir).toBe(h.userData);
    expect(options.safeStorage).toBe(fakeSafeStorage);
    expect([options.fs, options.platform]).toEqual([undefined, undefined]);
    await call("credential-set", "byok-slot-1", KEY_1, { remember: false });
    await call("credential-remove", "byok-slot-1");
    await call("credential-status", "byok-slot-1");
    expect(h.constructed).toHaveLength(1);
    const { getCredentialStore } = await import("../../electron/credentialService.js");
    expect(getCredentialStore()).toBe(getCredentialStore());
    expect(h.constructed).toHaveLength(1);
  });

  it("a session key set over IPC is visible to a main-process consumer of the shared store", async () => {
    await call("credential-set", "byok-slot-1", KEY_1, { remember: false });
    const { getCredentialStore } = await import("../../electron/credentialService.js");
    expect((await getCredentialStore().getCredential("byok-slot-1")) === KEY_1).toBe(true);
  });
});

describe("sender guard comes first", () => {
  const untrusted = (): Array<[string, unknown]> => {
    const other = new FakeContents(PACKAGED_URL, 9, 1);
    const sub = new FakeFrame(PACKAGED_URL, 4, 2);
    sub.parent = app.contents.mainFrame;
    const stale = { sender: app.contents, get senderFrame(): never { throw new Error("Render frame was disposed"); } };
    return [
      ["another window", { sender: other, senderFrame: other.mainFrame }],
      ["a subframe", { sender: app.contents, senderFrame: sub }],
      ["wrong process/routing ids", { sender: app.contents, senderFrame: new FakeFrame(PACKAGED_URL, 7, 3) }],
      ["a stale frame that throws", stale],
      ["a forged plain object", { sender: { getURL: () => PACKAGED_URL, isDestroyed: () => false }, senderFrame: { url: PACKAGED_URL, parent: null, processId: 4, routingId: 1 } }],
      ["no sender", { senderFrame: app.contents.mainFrame }],
      ["an empty event", {}],
    ];
  };
  const argsFor: Record<string, unknown[]> = {
    "credential-status": ["byok-slot-1"],
    "credential-set": ["byok-slot-1", KEY_1, { remember: true }],
    "credential-remove": ["byok-slot-1"],
  };
  const expectNoEffect = () => {
    expect(h.constructed).toHaveLength(0);
    expect(h.calls).toEqual({ isEncryptionAvailable: 0, encryptString: 0, decryptString: 0 });
    expect(fs.readdirSync(h.userData)).toEqual([]);
  };
  const refused = async (channel: string, event: unknown, label: string) => {
    const error = await h.handlers.get(channel)!(event, ...argsFor[channel]).then(() => null, (e: Error) => e);
    expect(error?.message, `${channel} / ${label}`).toBe(UNTRUSTED_SENDER_MESSAGE);
    expect(leaks(`${error?.message} ${error?.stack}`), label).toBe(false);
  };

  it("untrusted windows, frames and events are refused before the store exists", async () => {
    for (const channel of CHANNELS) for (const [label, event] of untrusted()) await refused(channel, event, label);
    expectNoEffect();
  });

  it("a navigated, destroyed or detached sender, or a closed window, is refused", async () => {
    const cases: Array<[string, () => void, () => void]> = [
      ["navigated page", () => (app.contents.url = "https://example.invalid/"), () => (app.contents.url = PACKAGED_URL)],
      ["destroyed sender", () => (app.contents.destroyed = true), () => (app.contents.destroyed = false)],
      ["detached frame", () => (app.contents.mainFrame.detached = true), () => (app.contents.mainFrame.detached = false)],
      ["destroyed window", () => (app.window.current!.destroyed = true), () => (app.window.current!.destroyed = false)],
    ];
    for (const [label, breakIt, fixIt] of cases) {
      breakIt();
      for (const channel of CHANNELS) await refused(channel, app.event(), label);
      fixIt();
    }
    expectNoEffect();
  });

  it("the development page isn't trusted by a packaged app, nor the reverse", async () => {
    const dev = trustedRenderer(DEV_URL);
    for (const channel of CHANNELS) await refused(channel, dev.event(), "dev page vs packaged app");
    await startApp(DEV_URL);
    const packaged = trustedRenderer(PACKAGED_URL);
    for (const channel of CHANNELS) await refused(channel, packaged.event(), "packaged page vs dev app");
    expectNoEffect();
  });
});

describe("contracts", () => {
  it("status is metadata only", async () => {
    expect(await call("credential-status", "byok-slot-1")).toEqual({ ok: true, status: { configured: false, mode: null, persistence: "available" } });
  });

  it("session-only: set, status, and gone after a restart; never written", async () => {
    expect(await call("credential-set", "byok-slot-1", KEY_1, { remember: false })).toEqual({ ok: true, status: { configured: true, mode: "session", persistence: "available" } });
    expect(fs.existsSync(file())).toBe(false);
    await startApp();
    expect(await call("credential-status", "byok-slot-1")).toEqual({ ok: true, status: { configured: false, mode: null, persistence: "available" } });
  });

  it("remembered: encrypted on disk, kept across a restart", async () => {
    expect(await call("credential-set", "byok-slot-1", KEY_1, { remember: true })).toEqual({ ok: true, status: { configured: true, mode: "remembered", persistence: "available" } });
    expect(leaks(fs.readFileSync(file(), "utf8"))).toBe(false);
    await startApp();
    expect(await call("credential-status", "byok-slot-1")).toMatchObject({ ok: true, status: { configured: true, mode: "remembered" } });
    const { getCredentialStore } = await import("../../electron/credentialService.js");
    expect((await getCredentialStore().getCredential("byok-slot-1")) === KEY_1).toBe(true);
  });

  it("replacement and removal", async () => {
    await call("credential-set", "byok-slot-1", KEY_1, { remember: true });
    await call("credential-set", "byok-slot-1", KEY_2, { remember: true });
    const { getCredentialStore } = await import("../../electron/credentialService.js");
    expect((await getCredentialStore().getCredential("byok-slot-1")) === KEY_2).toBe(true);
    expect(await call("credential-remove", "byok-slot-1")).toEqual({ ok: true, status: { configured: false, mode: null, persistence: "available" } });
    expect(await getCredentialStore().getCredential("byok-slot-1")).toBeNull();
    // Removing again is fine.
    expect(await call("credential-remove", "byok-slot-1")).toMatchObject({ ok: true });
  });

  it("encryption unavailable: remembering is refused with nothing written; session-only works", async () => {
    h.available = false;
    expect(await call("credential-status", "byok-slot-1")).toMatchObject({ ok: true, status: { persistence: "unavailable" } });
    expect(await call("credential-set", "byok-slot-1", KEY_1, { remember: true })).toEqual({ ok: false, error: "encryption-unavailable" });
    expect(fs.existsSync(file())).toBe(false);
    expect(await call("credential-set", "byok-slot-1", KEY_1, { remember: false })).toMatchObject({ ok: true, status: { mode: "session" } });
  });

  it("an insecure Linux backend is reported and refused", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const backend = vi.spyOn(fakeSafeStorage, "getSelectedStorageBackend").mockReturnValue("basic_text");
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(await call("credential-status", "byok-slot-1")).toMatchObject({ ok: true, status: { persistence: "insecure" } });
      expect(await call("credential-set", "byok-slot-1", KEY_1, { remember: true })).toEqual({ ok: false, error: "encryption-insecure" });
    } finally {
      Object.defineProperty(process, "platform", platform);
      backend.mockRestore();
    }
    expect(fs.existsSync(file())).toBe(false);
  });

  it.each([
    ["damaged", "{not json", "store-corrupt"],
    ["newer version", JSON.stringify({ format: "reporunner-credentials", version: 2, credentials: {} }), "unsupported-version"],
  ])("a %s credentials file is reported, never rewritten", async (_n, content, code) => {
    fs.writeFileSync(file(), content);
    expect(await call("credential-status", "byok-slot-1")).toEqual({ ok: false, error: code });
    expect(await call("credential-set", "byok-slot-1", KEY_1, { remember: true })).toEqual({ ok: false, error: code });
    expect(await call("credential-remove", "byok-slot-1")).toEqual({ ok: false, error: code });
    expect(fs.readFileSync(file(), "utf8")).toBe(content);
  });

  it("an unexpected failure gives a fixed code, without its message", async () => {
    h.getPathThrows = true;
    const result = await call("credential-status", "byok-slot-1");
    expect(result).toEqual({ ok: false, error: "failed" });
    expect(JSON.stringify(result)).not.toMatch(/secret|EACCES|\\/);
  });
});

describe("strict arguments, checked before the store is touched", () => {
  const validOptions = { remember: false };
  const withSymbol = Object.assign({ remember: false }, { [Symbol("x")]: 1 });
  const nullProto = Object.assign(Object.create(null), { remember: false });
  class Options { remember = false; }
  const cases: Array<[string, string, unknown[], string]> = [
    ["status: no slot", "credential-status", [], "invalid-request"],
    ["status: other slot", "credential-status", ["byok-slot-2"], "invalid-request"],
    ["status: case changed", "credential-status", ["BYOK-SLOT-1"], "invalid-request"],
    ["status: padded", "credential-status", [" byok-slot-1"], "invalid-request"],
    ["status: String object", "credential-status", [new String("byok-slot-1")], "invalid-request"],
    ["status: array", "credential-status", [["byok-slot-1"]], "invalid-request"],
    ["status: extra argument", "credential-status", ["byok-slot-1", "x"], "invalid-request"],
    ["remove: other slot", "credential-remove", ["byok-slot-3"], "invalid-request"],
    ["remove: extra argument", "credential-remove", ["byok-slot-1", {}], "invalid-request"],
    ["set: too few arguments", "credential-set", ["byok-slot-1", KEY_1], "invalid-request"],
    ["set: too many arguments", "credential-set", ["byok-slot-1", KEY_1, validOptions, 1], "invalid-request"],
    ["set: other slot", "credential-set", ["byok-slot-2", KEY_1, validOptions], "invalid-request"],
    ["set: prototype slot", "credential-set", ["__proto__", KEY_1, validOptions], "invalid-request"],
    ["set: no options", "credential-set", ["byok-slot-1", KEY_1, undefined], "invalid-request"],
    ["set: null options", "credential-set", ["byok-slot-1", KEY_1, null], "invalid-request"],
    ["set: array options", "credential-set", ["byok-slot-1", KEY_1, [false]], "invalid-request"],
    ["set: empty options", "credential-set", ["byok-slot-1", KEY_1, {}], "invalid-request"],
    ["set: string remember", "credential-set", ["byok-slot-1", KEY_1, { remember: "true" }], "invalid-request"],
    ["set: number remember", "credential-set", ["byok-slot-1", KEY_1, { remember: 1 }], "invalid-request"],
    ["set: extra option", "credential-set", ["byok-slot-1", KEY_1, { remember: true, provider: "x" }], "invalid-request"],
    ["set: nested option", "credential-set", ["byok-slot-1", KEY_1, { remember: { value: true } }], "invalid-request"],
    ["set: symbol key", "credential-set", ["byok-slot-1", KEY_1, withSymbol], "invalid-request"],
    ["set: null prototype", "credential-set", ["byok-slot-1", KEY_1, nullProto], "invalid-request"],
    ["set: class instance", "credential-set", ["byok-slot-1", KEY_1, new Options()], "invalid-request"],
    ["set: empty key", "credential-set", ["byok-slot-1", "", validOptions], "invalid-secret"],
    ["set: number key", "credential-set", ["byok-slot-1", 12345, validOptions], "invalid-secret"],
    ["set: String object key", "credential-set", ["byok-slot-1", new String(KEY_1), validOptions], "invalid-secret"],
    ["set: array key", "credential-set", ["byok-slot-1", [KEY_1], validOptions], "invalid-secret"],
    ["set: key with a line feed", "credential-set", ["byok-slot-1", `${KEY_1}\nx`, validOptions], "invalid-secret"],
    ["set: key with a carriage return", "credential-set", ["byok-slot-1", `${KEY_1}\rx`, validOptions], "invalid-secret"],
    ["set: key with NUL", "credential-set", ["byok-slot-1", `${KEY_1}\u0000`, validOptions], "invalid-secret"],
    ["set: too many characters", "credential-set", ["byok-slot-1", "k".repeat(MAX_SECRET_BYTES + 1), validOptions], "invalid-secret"],
    ["set: few characters, too many UTF-8 bytes", "credential-set", ["byok-slot-1", "€".repeat(3000), validOptions], "invalid-secret"],
    ["set: huge string", "credential-set", ["byok-slot-1", "k".repeat(5_000_000), validOptions], "invalid-secret"],
  ];
  it.each(cases)("%s", async (_name, channel, args, code) => {
    const result = await call(channel, ...args);
    expect(result).toEqual({ ok: false, error: code });
    expect(leaks(result)).toBe(false);
    expect(h.constructed).toHaveLength(0);
    expect(fs.readdirSync(h.userData)).toEqual([]);
  });

  it("the byte limit is exact: 8,192 UTF-8 bytes is accepted, one more is not", async () => {
    const exact = "€".repeat(2730) + "kk"; // 8,190 + 2 bytes
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_SECRET_BYTES);
    expect(await call("credential-set", "byok-slot-1", exact, { remember: true })).toMatchObject({ ok: true });
    expect(await call("credential-set", "byok-slot-1", `${exact}k`, { remember: true })).toEqual({ ok: false, error: "invalid-secret" });
  });
});

describe("nothing is disclosed", () => {
  it("no result, refusal or file contains the key, and only the three credential channels exist", async () => {
    const results = [
      await call("credential-set", "byok-slot-1", KEY_1, { remember: true }),
      await call("credential-status", "byok-slot-1"),
      await call("credential-set", "byok-slot-1", KEY_2, { remember: false }),
      await call("credential-status", "byok-slot-1"),
      await call("credential-set", "byok-slot-1", `${KEY_1}\n`, { remember: true }),
      await call("credential-remove", "byok-slot-1"),
    ];
    for (const r of results) expect(leaks(r)).toBe(false);
    expect(results.every((r) => typeof r === "object" && !Object.values(r).some((v) => typeof v === "string" && v.startsWith("rr-")))).toBe(true);
    expect([...h.handlers.keys()].filter((c) => /cred|key|secret|token/i.test(c)).sort()).toEqual([...CHANNELS].sort());
  });

  it("the handler modules have no path to a stored key, no logging and no environment access", () => {
    const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../../electron", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const f of ["credentialIpc.ts", "credentialService.ts"]) expect(read(f), f).not.toMatch(/getCredential\(|decryptString|console\.|process\.env/);
    // ipc.ts logs and builds child environments for other reasons; it must still have no path to a stored key.
    expect(read("ipc.ts")).not.toMatch(/getCredential\(|getCredentialStore|decryptString|credentialStore/);
    // Only the service constructs a store.
    const dir = path.resolve(import.meta.dirname, "../../electron");
    const constructing = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && /new CredentialStore\(/.test(fs.readFileSync(path.join(dir, f), "utf8")));
    expect(constructing).toEqual(["credentialService.ts"]);
    // Not reachable from the renderer in this stage.
    expect(fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/preload.cts"), "utf8")).not.toMatch(/credential/i);
  });
});

describe("concurrency", () => {
  it("a second set or remove while one is in flight is refused as busy; status still answers, after it", async () => {
    const first = call("credential-set", "byok-slot-1", KEY_1, { remember: true });
    const second = call("credential-set", "byok-slot-1", KEY_2, { remember: true });
    const removing = call("credential-remove", "byok-slot-1");
    const status = call("credential-status", "byok-slot-1");
    expect(await second).toEqual({ ok: false, error: "busy" });
    expect(await removing).toEqual({ ok: false, error: "busy" });
    expect(await first).toMatchObject({ ok: true });
    expect(await status).toMatchObject({ ok: true, status: { configured: true, mode: "remembered" } });
    const { getCredentialStore } = await import("../../electron/credentialService.js");
    expect((await getCredentialStore().getCredential("byok-slot-1")) === KEY_1).toBe(true);
  });

  it("the busy guard is released after every failure", async () => {
    h.available = false;
    expect(await call("credential-set", "byok-slot-1", KEY_1, { remember: true })).toEqual({ ok: false, error: "encryption-unavailable" });
    h.available = true;
    fs.writeFileSync(file(), "{bad");
    expect(await call("credential-remove", "byok-slot-1")).toEqual({ ok: false, error: "store-corrupt" });
    fs.rmSync(file());
    h.getPathThrows = true;
    await startApp();
    h.getPathThrows = true;
    expect(await call("credential-set", "byok-slot-1", KEY_1, { remember: true })).toEqual({ ok: false, error: "failed" });
    h.getPathThrows = false;
    expect(await call("credential-set", "byok-slot-1", KEY_1, { remember: true })).toMatchObject({ ok: true });
    expect(await call("credential-remove", "byok-slot-1")).toMatchObject({ ok: true });
  });
});
