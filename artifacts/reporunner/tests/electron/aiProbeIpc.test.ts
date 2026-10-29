// Stage 4O: "ai-config-probe" end to end: the real ipc.ts registration,
// sender guard and internal gate, the real AI settings service and store in a
// temporary userData folder, and the real Stage 4N transport against
// synthetic raw-TCP loopback servers. Only the project's tracked service
// ports are stubbed (their source is tested in
// processManager.trackedPorts.test.ts). Synthetic, non-secret values only.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  userData: "",
  getPathCalls: 0,
  getPathThrows: false,
  credentialCalls: 0,
  ports: [] as number[],
  portCalls: 0,
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
  app: {
    getPath: () => {
      h.getPathCalls++;
      if (h.getPathThrows) throw new Error("EACCES: C:\\Users\\SYNTHETIC");
      return h.userData;
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  clipboard: { writeText: () => {} },
  shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
}));
vi.mock("../../electron/credentialService.js", () => ({
  getCredentialStore: () => {
    h.credentialCalls++;
    throw new Error("the probe must not use credentials");
  },
}));
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
  getTrackedServicePorts: () => {
    h.portCalls++;
    return [...h.ports];
  },
}));
vi.mock("../../electron/logSink.js", () => ({ emitLog: vi.fn(), clearLogs: vi.fn(), formatLogsForClipboard: () => "logs" }));

import { DEV_URL, FakeContents, PACKAGED_URL, trustedRenderer } from "./fakeSender.js";
import { UNTRUSTED_SENDER_MESSAGE } from "../../electron/ipcTrust.js";

const PROBE = "ai-config-probe";
const FILE = "reporunner-ai-settings.json";
const MARKER = "SYNTHETIC-REPO-MARKER-4o";

let app: ReturnType<typeof trustedRenderer>;
let clock = 0;
const servers: Array<{ server: net.Server; open: Set<net.Socket> }> = [];
const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!(app.event(), ...args) as Promise<Record<string, unknown>>;
const file = () => path.join(h.userData, FILE);

interface Srv { port: number; received: string[]; connections: number; open: Set<net.Socket> }
/** A raw TCP server; `reply` answers once the request head arrived (or never, if it does nothing). */
function serve(reply: (socket: net.Socket) => void): Promise<Srv> {
  return new Promise((resolve) => {
    const s: Srv = { port: 0, received: [], connections: 0, open: new Set() };
    const server = net.createServer((socket) => {
      s.connections++;
      s.open.add(socket);
      const i = s.received.push("") - 1;
      let replied = false;
      socket.on("error", () => {});
      socket.on("close", () => s.open.delete(socket));
      socket.on("data", (c) => {
        s.received[i] += c.toString("latin1");
        if (!replied && s.received[i].includes("\r\n\r\n")) {
          replied = true;
          reply(socket);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      s.port = (server.address() as net.AddressInfo).port;
      servers.push({ server, open: s.open });
      resolve(s);
    });
  });
}
const json = (body: string) => (socket: net.Socket) =>
  socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
const VERSION = json('{"version":"0.5.7"}');
const MODELS = json(JSON.stringify({ object: "list", data: [{ id: "SYNTHETIC-name-1" }, { id: "SYNTHETIC-name-2" }] }));
const cfg = (id: string, port: number, apiStyle = "ollama-native", base = "") => ({ id, kind: "local-endpoint", endpoint: `http://127.0.0.1:${port}${base}`, apiStyle, model: "SYNTHETIC-model-label" });
async function closed(s: Srv, ms = 4000) {
  const end = Date.now() + ms;
  while (s.open.size && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return s.open.size === 0;
}

/** Saves a document through the real edit handler and returns its revision. */
async function save(configs: unknown[], active: string | null = null): Promise<string> {
  const loaded = (await call("ai-config-edit-load")) as { revision: string | null };
  const saved = (await call("ai-config-edit-save", { format: "reporunner-ai-settings", version: 1, active, configs }, loaded.revision)) as { ok: boolean; revision: string };
  expect(saved.ok).toBe(true);
  return saved.revision;
}
const OPEN = { internalCredentialSettings: true };
/** Registers the handlers again (same modules, so the same shared coordinator). Pass undefined to mean "no options". */
async function freshIpc(options: { internalCredentialSettings?: boolean } | undefined, appUrl = PACKAGED_URL) {
  h.handlers.clear();
  app = trustedRenderer(appUrl);
  const { setupIpc } = await import("../../electron/ipc.js");
  setupIpc(app.trust, options);
}

beforeEach(async () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "rr4o-"));
  h.getPathCalls = 0;
  h.getPathThrows = false;
  h.credentialCalls = 0;
  h.ports = [];
  h.portCalls = 0;
  // Monotonic clock for the shared coordinator's cooldown: each test starts well past any earlier cooldown.
  clock += 1_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  // A fresh main process: the AI settings service caches its one store (and its userData folder).
  vi.resetModules();
  await freshIpc(OPEN);
});
afterEach(async () => {
  for (const { server, open } of servers.splice(0)) {
    for (const s of open) s.destroy();
    await new Promise((r) => server.close(r));
  }
  fs.rmSync(h.userData, { recursive: true, force: true });
  expect(h.credentialCalls).toBe(0);
});

describe("gate and sender", () => {
  it.each([[undefined], [{ internalCredentialSettings: false }]])("gate closed (%o): not-available, nothing read or contacted", async (options) => {
    const s = await serve(VERSION);
    const rev = await save([cfg("cfg-a1", s.port)]);
    await freshIpc(options);
    const before = h.getPathCalls;
    const connect = vi.spyOn(net, "connect");
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: false, error: "not-available" });
    expect(h.getPathCalls).toBe(before);
    expect(h.portCalls).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(s.connections).toBe(0);
  });

  it("untrusted senders are refused by the guard, before anything", async () => {
    const s = await serve(VERSION);
    const rev = await save([cfg("cfg-a1", s.port)]);
    const other = new FakeContents(PACKAGED_URL, 9, 1);
    const before = h.getPathCalls;
    for (const event of [{ sender: other, senderFrame: other.mainFrame }, { sender: app.contents, senderFrame: other.mainFrame }, { sender: app.contents, senderFrame: null }]) {
      const error = await h.handlers.get(PROBE)!(event, "cfg-a1", rev).then(() => null, (e: Error) => e);
      expect(error?.message).toBe(UNTRUSTED_SENDER_MESSAGE);
    }
    expect(h.getPathCalls).toBe(before);
    expect(s.connections).toBe(0);
  });
});

describe("saved configurations only", () => {
  it("ollama-native: compatible, the stored endpoint and fixed path, nothing else in the answer", async () => {
    const s = await serve(VERSION);
    const rev = await save([cfg("cfg-a1", s.port)], "cfg-a1");
    const before = fs.readFileSync(file());
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: true, outcome: "compatible", modelCount: null });
    expect(s.received).toEqual([`GET /api/version HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: RepoRunner-LocalProbe/1\r\n\r\n`]);
    // Nothing stored or changed: same file, no new files, same active selection.
    expect(fs.readFileSync(file()).equals(before)).toBe(true);
    expect(fs.readdirSync(h.userData)).toEqual([FILE]);
    expect(await call("ai-config-status")).toMatchObject({ ok: true, status: { active: { id: "cfg-a1" }, providerReadiness: "none" } });
    expect(await closed(s)).toBe(true);
  });

  it("openai-compatible with a base path: only the model count", async () => {
    const s = await serve(MODELS);
    const rev = await save([cfg("cfg-b2", s.port, "openai-compatible", "/v1")]);
    const result = await call(PROBE, "cfg-b2", rev);
    expect(result).toEqual({ ok: true, outcome: "compatible", modelCount: 2 });
    expect(s.received[0].startsWith("GET /v1/models HTTP/1.1\r\n")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });

  it("a stale revision: conflict, no connection", async () => {
    const s = await serve(VERSION);
    const old = await save([cfg("cfg-a1", s.port)]);
    await save([cfg("cfg-a1", s.port), cfg("cfg-b2", s.port + 1 > 65535 ? 1 : s.port + 1)]);
    expect(await call(PROBE, "cfg-a1", old)).toEqual({ ok: false, error: "conflict" });
    expect(s.connections).toBe(0);
  });

  it("an id not in the saved document: not-found", async () => {
    const s = await serve(VERSION);
    const rev = await save([cfg("cfg-a1", s.port)]);
    expect(await call(PROBE, "cfg-zz9", rev)).toEqual({ ok: false, error: "not-found" });
    expect(s.connections).toBe(0);
  });

  it("no settings file: missing, and none is created", async () => {
    expect(await call(PROBE, "cfg-a1", "a".repeat(64))).toEqual({ ok: false, error: "missing" });
    expect(fs.existsSync(file())).toBe(false);
  });

  it.each([
    ["damaged", "{ SYNTHETIC", "damaged"],
    ["a non-loopback endpoint written by hand", JSON.stringify({ format: "reporunner-ai-settings", version: 1, active: null, configs: [cfg("cfg-a1", 1)].map((c) => ({ ...c, endpoint: "http://192.168.1.5:11434" })) }), "damaged"],
    ["newer", JSON.stringify({ format: "reporunner-ai-settings", version: 2, active: null, configs: [] }), "unsupported-version"],
  ])("%s file: a fixed error, the file unchanged", async (_name, content, error) => {
    fs.writeFileSync(file(), content);
    expect(await call(PROBE, "cfg-a1", "a".repeat(64))).toEqual({ ok: false, error });
    expect(fs.readFileSync(file(), "utf8")).toBe(content);
  });

  it("unreadable settings: a fixed error", async () => {
    h.getPathThrows = true;
    vi.resetModules();
    await freshIpc(OPEN);
    expect(await call(PROBE, "cfg-a1", "a".repeat(64))).toEqual({ ok: false, error: "unreadable" });
  });

  it("a URL, host, port or object instead of an id: invalid-request, nothing read", async () => {
    const s = await serve(VERSION);
    const rev = await save([cfg("cfg-a1", s.port)]);
    const before = h.getPathCalls;
    for (const args of [[`http://127.0.0.1:${s.port}`, rev], [{ endpoint: `http://127.0.0.1:${s.port}`, apiStyle: "ollama-native" }, rev], ["cfg-a1", rev, `http://127.0.0.1:${s.port}/api/version`], ["cfg-a1"], ["cfg-a1", undefined], ["cfg-a1", null], []]) {
      expect(await call(PROBE, ...args)).toEqual({ ok: false, error: "invalid-request" });
    }
    expect(h.getPathCalls).toBe(before);
    expect(s.connections).toBe(0);
  });
});

describe("project ports", () => {
  it("a port RepoRunner's project service uses: refused with no connection; an unrelated local server on another port is probed", async () => {
    const s = await serve(VERSION);
    const rev = await save([cfg("cfg-a1", s.port)]);
    h.ports = [s.port];
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: false, error: "port-in-use-by-project" });
    expect(s.connections).toBe(0);
    h.ports = [s.port === 3000 ? 3001 : 3000];
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: true, outcome: "compatible", modelCount: null });
  });

  it("the app's own dev server port is refused", async () => {
    await freshIpc(OPEN, DEV_URL);
    const rev = await save([{ ...cfg("cfg-a1", 5173) }]);
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: false, error: "port-in-use-by-project" });
  });
});

describe("busy, cooldown, window loss, timeouts", () => {
  it("one probe at a time across registrations, then a 2 s cooldown measured from the end", async () => {
    // The first request is held until released; later ones are answered at once.
    let release!: () => void;
    let released = false;
    const s = await serve((socket) => {
      if (released) VERSION(socket);
      else release = () => VERSION(socket);
    });
    const rev = await save([cfg("cfg-a1", s.port)]);
    const firstHandler = h.handlers.get(PROBE)!;
    const first = firstHandler(app.event(), "cfg-a1", rev);
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: false, error: "busy" });
    // A second registration (setupIpc again) shares the same coordinator.
    await freshIpc(OPEN);
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: false, error: "busy" });
    released = true;
    release();
    expect(await first).toEqual({ ok: true, outcome: "compatible", modelCount: null });
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: false, error: "rate-limited" });
    clock += 1999;
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: false, error: "rate-limited" });
    expect(s.connections).toBe(1);
    clock += 1;
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: true, outcome: "compatible", modelCount: null });
  });

  it.each(["destroyed", "render-process-gone"])("the window's webContents %s: the probe is aborted, its socket closed, listeners removed", async (eventName) => {
    const s = await serve(() => {});
    const rev = await save([cfg("cfg-a1", s.port)]);
    const pending = call(PROBE, "cfg-a1", rev);
    await vi.waitFor(() => expect(s.connections).toBe(1));
    expect(app.contents.listenerCount(eventName)).toBe(1);
    const t = Date.now();
    app.contents.emit(eventName);
    expect(await pending).toEqual({ ok: false, error: "cancelled" });
    expect(Date.now() - t).toBeLessThan(500);
    expect(await closed(s)).toBe(true);
    expect(app.contents.listenerCount("destroyed")).toBe(0);
    expect(app.contents.listenerCount("render-process-gone")).toBe(0);
  });

  it("a server that never answers: the transport's own 3 s header deadline, then cleanup and a released permit", async () => {
    const s = await serve(() => {});
    const rev = await save([cfg("cfg-a1", s.port)]);
    const t = Date.now();
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: true, outcome: "timeout" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(2900);
    expect(await closed(s)).toBe(true);
    expect(app.contents.listenerCount("destroyed")).toBe(0);
    clock += 2000;
    const ok = await serve(VERSION);
    const rev2 = await save([cfg("cfg-a1", ok.port)]);
    expect(await call(PROBE, "cfg-a1", rev2)).toEqual({ ok: true, outcome: "compatible", modelCount: null });
  });

  it("nothing listening: connection-refused", async () => {
    const s = await serve(VERSION);
    const port = s.port;
    const rev = await save([cfg("cfg-a1", port)]);
    for (const { server, open } of servers.splice(0)) {
      for (const sock of open) sock.destroy();
      await new Promise((r) => server.close(r));
    }
    expect(await call(PROBE, "cfg-a1", rev)).toEqual({ ok: true, outcome: "connection-refused" });
  });
});

describe("isolation", () => {
  it("no credential, cookie, body or repository data is sent", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "rr4o-repo-"));
    fs.writeFileSync(path.join(repo, ".env"), `TOKEN=${MARKER}\n`);
    vi.stubEnv("REPORUNNER_BYOK_API_KEY", MARKER);
    const s = await serve(VERSION);
    const rev = await save([cfg("cfg-a1", s.port)]);
    await call(PROBE, "cfg-a1", rev);
    const sent = s.received.join("");
    expect(sent).not.toContain(MARKER);
    expect(sent).not.toContain("SYNTHETIC-model-label");
    expect(sent).not.toMatch(/authorization|cookie|content-length|transfer-encoding/i);
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("renderer exposure (Stage 4P): only the gated preload method reaches the channel; the mock and App never do", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    // Never the main-process transport, anywhere in the renderer; never the channel outside the preload; never in the mock or App.
    for (const f of ["src/types.ts", "src/mock/repoRunnerMock.ts", "src/App.tsx", "src/components/CredentialSettingsDialog.tsx", "src/components/AiConfigEditor.tsx", "src/lib/aiConfigEditor.ts"]) {
      expect(fs.readFileSync(path.join(root, f), "utf8"), f).not.toMatch(/ai-config-probe|probeLocalEndpoint|localProbe/);
    }
    for (const f of ["src/mock/repoRunnerMock.ts", "src/App.tsx"]) expect(fs.readFileSync(path.join(root, f), "utf8"), f).not.toMatch(/aiConfigProbe/);
    // The preload: exactly one method, inside the internal-switch block, forwarding exactly the id and the revision.
    const preload = fs.readFileSync(path.join(root, "electron/preload.cts"), "utf8");
    expect(preload.match(/ai-config-probe/g)).toHaveLength(1);
    const gated = preload.slice(preload.indexOf("const credentialMethods = process.argv.includes(INTERNAL_CREDENTIAL_SETTINGS_SWITCH)"), preload.indexOf(": {};"));
    expect(gated).toMatch(/aiConfigProbe: \(configId: string, expectedRevision: string\) =>\s*ipcRenderer\.invoke\("ai-config-probe", configId, expectedRevision\),/);
  });

  it("registration: through the guard, behind the gate, in the required order", () => {
    const ipc = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/ipc.ts"), "utf8");
    expect(ipc).toContain('handle("ai-config-probe", async (event, ...args: unknown[]) => (credentialsAllowed ? aiConfigProbe(args, event.sender, projectPorts) : aiConfigProbeNotAvailable()));');
    expect(ipc).toContain("const projectPorts = () => [...getTrackedServicePorts(), ...devServerPorts(trustedRenderer?.appPageUrl())];");
    // The gate is the startup decision passed to setupIpc; the probe registration reads nothing else.
    const registration = ipc.slice(ipc.indexOf("// Local AI connection probe (Stage 4O)"));
    expect(registration).not.toMatch(/process\.env|isPackaged/);
    const mod = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/aiProbeIpc.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(mod).not.toMatch(/process\.env|isPackaged|credential|safeStorage|console\.|fs\.|writeFile|saveAiSettings|setInterval/);
    const at = (needle: string) => mod.indexOf(needle);
    const order = ["args.length !== 2", "this.deps.loadSettings()", "loaded.revision !== expectedRevision", "configs.find(", "buildProbeRequest(", "context.projectPorts()", "if (this.active)", "this.active = true", "this.deps.probe("].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Taken in the same synchronous step: no await between the busy check and taking the permit.
    expect(mod.slice(at("if (this.active)"), at("this.active = true"))).not.toContain("await");
  });

  it("nothing probes at startup: registering the handlers contacts nothing", async () => {
    const connect = vi.spyOn(net, "connect");
    h.getPathCalls = 0;
    await freshIpc(OPEN);
    expect(connect).not.toHaveBeenCalled();
    expect(h.getPathCalls).toBe(0);
    expect(h.portCalls).toBe(0);
  });
});
