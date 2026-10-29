// Stage 4N: the main-process probe transport against synthetic local servers
// (raw TCP, so every request byte is captured and every response byte is
// chosen). No real AI provider is contacted. Synthetic values only.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { probeLocalEndpoint } from "../../electron/localProbe";

const SERVER_TEXT = "SYNTHETIC-SERVER-TEXT-7f3a";
const MARKER = "SYNTHETIC-REPO-MARKER-91c4";

type Reply = (socket: net.Socket, request: string) => void;
interface Server {
  host: string;
  port: number;
  /** Every byte each connection sent, in order. */
  received: string[];
  connections: number;
  open: Set<net.Socket>;
  close(): Promise<void>;
}
const servers: Server[] = [];

/** A raw TCP server: replies once the request head (up to the blank line) has arrived. */
function serve(reply: Reply, host = "127.0.0.1"): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s: Server = { host, port: 0, received: [], connections: 0, open: new Set(), close: () => Promise.resolve() };
    const server = net.createServer((socket) => {
      s.connections++;
      s.open.add(socket);
      const index = s.received.push("") - 1;
      let replied = false;
      socket.on("error", () => {});
      socket.on("close", () => s.open.delete(socket));
      socket.on("data", (chunk) => {
        s.received[index] += chunk.toString("latin1");
        if (!replied && s.received[index].includes("\r\n\r\n")) {
          replied = true;
          reply(socket, s.received[index]);
        }
      });
    });
    server.on("error", reject);
    server.listen(0, host, () => {
      s.port = (server.address() as net.AddressInfo).port;
      s.close = () =>
        new Promise((done) => {
          for (const socket of s.open) socket.destroy();
          server.close(() => done());
        });
      servers.push(s);
      resolve(s);
    });
  });
}

const head = (status: string, headers: Record<string, string | number>) =>
  `HTTP/1.1 ${status}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
/** A complete JSON response with a correct Content-Length. */
const json = (body: string, extra: Record<string, string | number> = {}, status = "200 OK") => (socket: net.Socket) => {
  socket.end(head(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...extra }) + body);
};
const chunked = (parts: string[], extra: Record<string, string> = {}) => (socket: net.Socket) => {
  socket.write(head("200 OK", { "Content-Type": "application/json", "Transfer-Encoding": "chunked", ...extra }));
  for (const p of parts) socket.write(`${Buffer.byteLength(p).toString(16)}\r\n${p}\r\n`);
  socket.end("0\r\n\r\n");
};
const ollama = (s: Server, base = "") => ({ endpoint: `http://${s.host === "::1" ? "[::1]" : s.host}:${s.port}${base}`, apiStyle: "ollama-native" });
const openai = (s: Server, base = "") => ({ endpoint: `http://${s.host === "::1" ? "[::1]" : s.host}:${s.port}${base}`, apiStyle: "openai-compatible" });
const VERSION = JSON.stringify({ version: "0.5.7" });
const MODELS = (n: number) => JSON.stringify({ object: "list", data: Array.from({ length: n }, (_, i) => ({ id: `${SERVER_TEXT}-${i}`, object: "model", owned_by: SERVER_TEXT })) });

async function closedEventually(s: Server, ms = 3000) {
  const end = Date.now() + ms;
  while (s.open.size > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return s.open.size === 0;
}
async function closedPort(): Promise<number> {
  const s = await serve(() => {});
  const port = s.port;
  await s.close();
  servers.splice(servers.indexOf(s), 1);
  return port;
}

let ipv6 = false;
beforeAll(async () => {
  try {
    const s = await serve(() => {}, "::1");
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    ipv6 = true;
  } catch {
    ipv6 = false;
  }
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.unstubAllEnvs();
});

describe("compatible answers", () => {
  it("ollama-native: compatible, and the exact request bytes: five headers, no body", async () => {
    const s = await serve(json(VERSION));
    const result = await probeLocalEndpoint(ollama(s));
    expect(result).toEqual({ outcome: "compatible", modelCount: null });
    expect(Object.isFrozen(result)).toBe(true);
    expect(s.received).toEqual([
      `GET /api/version HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: RepoRunner-LocalProbe/1\r\n\r\n`,
    ]);
    expect(await closedEventually(s)).toBe(true);
  });

  it("openai-compatible with a base path: GET /v1/models, only the count comes back", async () => {
    const s = await serve(json(MODELS(3)));
    const result = await probeLocalEndpoint(openai(s, "/v1"));
    expect(result).toEqual({ outcome: "compatible", modelCount: 3 });
    expect(s.received[0].split("\r\n")[0]).toBe("GET /v1/models HTTP/1.1");
    expect(JSON.stringify(result)).not.toContain(SERVER_TEXT);
  });

  it("no implied /v1 and no fallback: a 404 at /models is the answer, with one request", async () => {
    const s = await serve((socket, req) => (req.startsWith("GET /v1/models ") ? json(MODELS(1))(socket) : json("{}", {}, "404 Not Found")(socket)));
    expect(await probeLocalEndpoint(openai(s))).toEqual({ outcome: "not-found-at-path" });
    expect(s.connections).toBe(1);
    expect(s.received[0].startsWith("GET /models HTTP/1.1\r\n")).toBe(true);
  });

  it("IPv6 loopback ([::1]) where available", async (ctx) => {
    if (!ipv6) ctx.skip();
    const s = await serve(json(VERSION), "::1");
    expect(await probeLocalEndpoint(ollama(s))).toEqual({ outcome: "compatible", modelCount: null });
    expect(s.received[0]).toContain(`\r\nHost: [::1]:${s.port}\r\n`);
  });

  it("chunked bodies are accepted", async () => {
    const s = await serve(chunked(['{"object":"list",', '"data":[{"id":"a"}]}']));
    expect(await probeLocalEndpoint(openai(s))).toEqual({ outcome: "compatible", modelCount: 1 });
  });

  it("prototype-like keys from the server don't pollute anything", async () => {
    const s = await serve(json('{"version":"0.5.7","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}'));
    expect(await probeLocalEndpoint(ollama(s))).toEqual({ outcome: "compatible", modelCount: null });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("each probe opens its own connection: nothing is reused", async () => {
    const s = await serve(json(VERSION));
    await probeLocalEndpoint(ollama(s));
    await probeLocalEndpoint(ollama(s));
    expect(s.connections).toBe(2);
  });
});

describe("refused answers", () => {
  it.each([
    ["301", "301 Moved Permanently"],
    ["302", "302 Found"],
    ["307", "307 Temporary Redirect"],
    ["308", "308 Permanent Redirect"],
  ])("a %s redirect is refused and never followed", async (_name, status) => {
    const target = await serve(json(VERSION));
    const s = await serve(json("{}", { Location: `http://127.0.0.1:${target.port}/api/version` }, status));
    expect(await probeLocalEndpoint(ollama(s))).toEqual({ outcome: "redirect-refused" });
    await new Promise((r) => setTimeout(r, 100));
    expect(target.connections).toBe(0);
  });

  it.each([
    ["401 Unauthorized", { outcome: "auth-required" }],
    ["403 Forbidden", { outcome: "auth-required" }],
    ["404 Not Found", { outcome: "not-found-at-path" }],
    ["418 I'm a teapot", { outcome: "http-error", statusClass: "4xx" }],
    ["500 Internal Server Error", { outcome: "http-error", statusClass: "5xx" }],
    ["503 Service Unavailable", { outcome: "http-error", statusClass: "5xx" }],
    ["204 No Content", { outcome: "incompatible-response" }],
  ])("%s", async (status, expected) => {
    const s = await serve(json(JSON.stringify({ error: SERVER_TEXT }), {}, status));
    const result = await probeLocalEndpoint(ollama(s));
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(SERVER_TEXT);
    expect(await closedEventually(s)).toBe(true);
  });

  it("a 101 protocol switch is incompatible and the socket is closed", async () => {
    const s = await serve((socket) => socket.write(head("101 Switching Protocols", { Upgrade: "websocket", Connection: "Upgrade" }) + "junk"));
    expect(await probeLocalEndpoint(ollama(s))).toEqual({ outcome: "incompatible-response" });
    expect(await closedEventually(s)).toBe(true);
  });

  it.each([
    ["gzip", { "Content-Encoding": "gzip" }],
    ["br", { "Content-Encoding": "br" }],
    ["deflate", { "Content-Encoding": "deflate" }],
  ])("a %s-compressed body is refused", async (_name, extra) => {
    const s = await serve(json(VERSION, extra));
    expect(await probeLocalEndpoint(ollama(s))).toEqual({ outcome: "incompatible-response" });
  });

  it("HTML or another content type is refused, and none of it comes back", async () => {
    const html = `<html><script>alert("${SERVER_TEXT}")</script></html>`;
    const s = await serve((socket) => socket.end(head("200 OK", { "Content-Type": "text/html", "Content-Length": html.length }) + html));
    const result = await probeLocalEndpoint(ollama(s));
    expect(result).toEqual({ outcome: "incompatible-response" });
    expect(JSON.stringify(result)).not.toMatch(/html|script|SYNTHETIC/i);
  });

  it.each([
    ["missing version", "{}"],
    ["malformed JSON", '{"version":'],
    ["a list instead of a version", MODELS(1)],
  ])("ollama: %s is incompatible", async (_name, body) => {
    const s = await serve(json(body));
    expect(await probeLocalEndpoint(ollama(s))).toEqual({ outcome: "incompatible-response" });
  });

  it("openai: a version answer, too many models or too-long ids are incompatible", async () => {
    for (const body of [VERSION, JSON.stringify({ object: "list", data: Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}` })) }), JSON.stringify({ object: "list", data: [{ id: "a".repeat(257) }] })]) {
      const s = await serve(json(body));
      expect(await probeLocalEndpoint(openai(s))).toEqual({ outcome: "incompatible-response" });
    }
  });

  it("invalid UTF-8 is incompatible", async () => {
    const s = await serve((socket) => {
      const body = Buffer.concat([Buffer.from('{"version":"0.5.7","x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
      socket.end(Buffer.concat([Buffer.from(head("200 OK", { "Content-Type": "application/json", "Content-Length": body.length })), body]));
    });
    expect(await probeLocalEndpoint(ollama(s))).toEqual({ outcome: "incompatible-response" });
  });

  it("garbage instead of HTTP, or a close without an answer, is incompatible", async () => {
    const garbage = await serve((socket) => socket.end(`HELLO ${SERVER_TEXT}\r\n\r\n`));
    expect(await probeLocalEndpoint(ollama(garbage))).toEqual({ outcome: "incompatible-response" });
    const hangup = await serve((socket) => socket.end());
    expect(await probeLocalEndpoint(ollama(hangup))).toEqual({ outcome: "incompatible-response" });
    const reset = await serve((socket) => socket.resetAndDestroy());
    expect(await probeLocalEndpoint(ollama(reset))).toEqual({ outcome: "incompatible-response" });
  });

  it("nothing listening: connection-refused", async () => {
    const port = await closedPort();
    expect(await probeLocalEndpoint({ endpoint: `http://127.0.0.1:${port}`, apiStyle: "ollama-native" })).toEqual({ outcome: "connection-refused" });
  });
});

describe("size limits", () => {
  const padded = (bytes: number) => {
    const base = JSON.stringify({ version: "0.5.7", pad: "" }).length;
    return JSON.stringify({ version: "0.5.7", pad: "x".repeat(bytes - base) });
  };

  it("exactly 8 KiB is accepted; one byte more is too large (with and without Content-Length)", async () => {
    expect(padded(8192).length).toBe(8192);
    for (const [body, expected] of [[padded(8192), "compatible"], [padded(8193), "response-too-large"]] as const) {
      const withLength = await serve(json(body));
      expect((await probeLocalEndpoint(ollama(withLength))).outcome).toBe(expected);
      const chunks = body.match(/[\s\S]{1,1000}/g)!;
      const noLength = await serve(chunked(chunks));
      expect((await probeLocalEndpoint(ollama(noLength))).outcome).toBe(expected);
    }
  });

  it("a huge chunked body is cut off at the limit, not buffered", async () => {
    const s = await serve((socket) => {
      socket.write(head("200 OK", { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }));
      const chunk = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 200 && !socket.destroyed && socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`)) sent++;
        if (sent < 200 && !socket.destroyed) socket.once("drain", pump);
      };
      pump();
    });
    expect(await probeLocalEndpoint(openai(s))).toEqual({ outcome: "response-too-large" });
    expect(await closedEventually(s)).toBe(true);
  });

  it("a declared Content-Length over the limit is refused before reading", async () => {
    const s = await serve((socket) => socket.write(head("200 OK", { "Content-Type": "application/json", "Content-Length": 300000 })));
    expect(await probeLocalEndpoint(openai(s), { deadlines: { idleMs: 5000 } })).toEqual({ outcome: "response-too-large" });
  });

  it("a lying Content-Length: shorter reads only that much; longer then closing is incompatible", async () => {
    const shorter = await serve((socket) => socket.end(head("200 OK", { "Content-Type": "application/json", "Content-Length": 5 }) + "x".repeat(100000)));
    expect(await probeLocalEndpoint(ollama(shorter))).toEqual({ outcome: "incompatible-response" });
    const longer = await serve((socket) => socket.end(head("200 OK", { "Content-Type": "application/json", "Content-Length": 4000 }) + VERSION));
    expect(await probeLocalEndpoint(ollama(longer))).toEqual({ outcome: "incompatible-response" });
  });

  it("headers over 16 KiB are too large", async () => {
    const s = await serve(json(VERSION, { "X-Fill": "a".repeat(17 * 1024) }));
    expect(await probeLocalEndpoint(ollama(s))).toEqual({ outcome: "response-too-large" });
    const ok = await serve(json(VERSION, { "X-Fill": "a".repeat(15 * 1024) }));
    expect(await probeLocalEndpoint(ollama(ok))).toEqual({ outcome: "compatible", modelCount: null });
  });
});

describe("deadlines and cancellation", () => {
  const never = () => {};
  /** A socket that stays "connecting" forever (as a hung TCP connect would): writes queue and nothing arrives. */
  const hangingSocket = () => {
    const socket = new net.Socket();
    (socket as unknown as { connecting: boolean }).connecting = true;
    return socket;
  };

  it("connect deadline", async () => {
    const t = Date.now();
    expect(await probeLocalEndpoint({ endpoint: "http://127.0.0.1:9", apiStyle: "ollama-native" }, { createSocket: hangingSocket, deadlines: { connectMs: 150 } })).toEqual({ outcome: "timeout" });
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it("header deadline, at its default of 3 s; a longer requested deadline is ignored", async () => {
    const s = await serve(never);
    const t = Date.now();
    expect(await probeLocalEndpoint(ollama(s), { deadlines: { headersMs: 60000, totalMs: 60000 } })).toEqual({ outcome: "timeout" });
    const elapsed = Date.now() - t;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(5000);
    expect(await closedEventually(s)).toBe(true);
  });

  it("inactivity between body chunks", async () => {
    const s = await serve((socket) => socket.write(head("200 OK", { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }) + '5\r\n{"ver\r\n'));
    const t = Date.now();
    expect(await probeLocalEndpoint(ollama(s), { deadlines: { idleMs: 200 } })).toEqual({ outcome: "timeout" });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(await closedEventually(s)).toBe(true);
  });

  it("overall deadline, even while bytes keep trickling in", async () => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const s = await serve((socket) => {
      socket.write(head("200 OK", { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }));
      interval = setInterval(() => !socket.destroyed && socket.write("1\r\n \r\n"), 50);
      socket.on("close", () => clearInterval(interval));
    });
    const t = Date.now();
    expect(await probeLocalEndpoint(ollama(s), { deadlines: { totalMs: 400 } })).toEqual({ outcome: "timeout" });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(await closedEventually(s)).toBe(true);
    clearInterval(interval);
  });

  it("an already-aborted signal: nothing is opened", async () => {
    const connect = vi.spyOn(net, "connect");
    const s = await serve(json(VERSION));
    const controller = new AbortController();
    controller.abort();
    expect(await probeLocalEndpoint(ollama(s), { signal: controller.signal })).toEqual({ outcome: "cancelled" });
    expect(connect).not.toHaveBeenCalled();
    expect(s.connections).toBe(0);
  });

  it.each([
    ["while connecting", "connect"],
    ["while waiting for headers", "headers"],
    ["while reading the body", "body"],
  ])("cancelling %s settles at once and closes the connection", async (_name, phase) => {
    const s = await serve((socket) => {
      if (phase === "body") socket.write(head("200 OK", { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }) + '5\r\n{"ver\r\n');
    });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const options = phase === "connect" ? { signal: controller.signal, createSocket: hangingSocket } : { signal: controller.signal };
    const pending = probeLocalEndpoint(ollama(s), options);
    await new Promise((r) => setTimeout(r, phase === "connect" ? 50 : 200));
    const t = Date.now();
    controller.abort();
    expect(await pending).toEqual({ outcome: "cancelled" });
    expect(Date.now() - t).toBeLessThan(200);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(await closedEventually(s)).toBe(true);
  });

  it("a late abort or late data after settling changes nothing", async () => {
    const s = await serve(json(VERSION));
    const controller = new AbortController();
    const result = await probeLocalEndpoint(ollama(s), { signal: controller.signal });
    controller.abort();
    expect(result).toEqual({ outcome: "compatible", modelCount: null });
  });

  it("no timers are left behind", async () => {
    const s = await serve(json(VERSION));
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await probeLocalEndpoint(ollama(s));
    const created = set.mock.results.map((r) => r.value);
    const cleared = new Set(clear.mock.calls.map((c) => c[0]));
    expect(created.length).toBeGreaterThanOrEqual(3);
    for (const t of created) expect(cleared.has(t)).toBe(true);
  });
});

describe("destination", () => {
  it("connects to the literal address with a lookup that refuses: no DNS", async () => {
    const s = await serve(json(VERSION));
    const connect = vi.spyOn(net, "connect");
    await probeLocalEndpoint(ollama(s));
    expect(connect).toHaveBeenCalledTimes(1);
    const opts = connect.mock.calls[0][0] as unknown as { host: string; port: number; family: number; lookup: (h: string, o: unknown, cb: (e: Error | null) => void) => void };
    expect(opts).toMatchObject({ host: "127.0.0.1", port: s.port, family: 4 });
    const error = await new Promise<Error | null>((r) => opts.lookup("localhost", {}, (e) => r(e)));
    expect(error).toBeInstanceOf(Error);
  });

  it("a socket connected anywhere else: address-mismatch, and not one byte is sent", async () => {
    const s = await serve(json(VERSION));
    // The configuration says [::1] (or another port), but the socket reaches 127.0.0.1.
    const toIpv4 = () => net.connect({ host: "127.0.0.1", port: s.port });
    expect(await probeLocalEndpoint({ endpoint: `http://[::1]:${s.port}`, apiStyle: "ollama-native" }, { createSocket: toIpv4 })).toEqual({ outcome: "address-mismatch" });
    expect(await probeLocalEndpoint({ endpoint: `http://127.0.0.1:${s.port === 65535 ? 1 : s.port + 1}`, apiStyle: "ollama-native" }, { createSocket: toIpv4 })).toEqual({ outcome: "address-mismatch" });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.received.every((r) => r === "")).toBe(true);
    expect(await closedEventually(s)).toBe(true);
  });

  it.each([
    "http://localhost:11434",
    "http://127.0.0.2:11434",
    "http://192.168.1.5:11434",
    "http://10.0.0.1:11434",
    "http://8.8.8.8:80",
    "http://[::ffff:127.0.0.1]:11434",
    "http://127.0.0.1",
    "https://127.0.0.1:443",
    "http://u:p@127.0.0.1:1",
    "http://127.0.0.1:1/?q",
    "http://127.0.0.1:1/#f",
    "http://127.0.0.1:1/%2e",
    "http://127.0.0.1:1/a/../b",
    "http://127.0.0.1:1/",
    "HTTP://127.0.0.1:1",
  ])("refuses %s without opening anything", async (endpoint) => {
    const connect = vi.spyOn(net, "connect");
    const request = vi.spyOn(http, "request");
    expect(await probeLocalEndpoint({ endpoint, apiStyle: "ollama-native" })).toEqual({ outcome: "invalid-request" });
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses an unknown API style or a URL string", async () => {
    expect(await probeLocalEndpoint({ endpoint: "http://127.0.0.1:1", apiStyle: "anthropic" })).toEqual({ outcome: "invalid-request" });
    expect(await probeLocalEndpoint("http://127.0.0.1:1/api/version")).toEqual({ outcome: "invalid-request" });
  });
});

describe("isolation", () => {
  it("proxy environment variables and a replaced global agent are never used", async () => {
    const trap = await serve(json(VERSION));
    const trapUrl = `http://127.0.0.1:${trap.port}`;
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, trapUrl);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    const original = http.globalAgent;
    let globalAgentUsed = 0;
    http.globalAgent = new http.Agent();
    (http.globalAgent as unknown as { createConnection: () => never }).createConnection = () => {
      globalAgentUsed++;
      throw new Error("global agent used");
    };
    try {
      const s = await serve(json(VERSION));
      expect(await probeLocalEndpoint(ollama(s))).toEqual({ outcome: "compatible", modelCount: null });
      expect(s.connections).toBe(1);
    } finally {
      http.globalAgent = original;
    }
    expect(trap.connections).toBe(0);
    expect(globalAgentUsed).toBe(0);
  });

  it("nothing secret, repository or environment-derived is sent, and nothing is logged or written", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "rr4n-repo-"));
    fs.writeFileSync(path.join(repo, ".env"), `TOKEN=${MARKER}\n`);
    vi.stubEnv("REPORUNNER_BYOK_API_KEY", MARKER);
    vi.stubEnv("OPENAI_API_KEY", MARKER);
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const writes = [vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "writeFile"), vi.spyOn(fs, "appendFileSync"), vi.spyOn(fs, "openSync")];
    const s = await serve(json(MODELS(2)));
    const result = await probeLocalEndpoint({ ...openai(s), id: "cfg-a1", kind: "local-endpoint", model: MARKER, credential: MARKER });
    expect(result).toEqual({ outcome: "compatible", modelCount: 2 });
    const sent = s.received.join("");
    expect(sent).not.toContain(MARKER);
    expect(sent).not.toMatch(/authorization|cookie|content-length|transfer-encoding/i);
    for (const spy of [...logs, ...writes]) expect(spy).not.toHaveBeenCalled();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("source: only http, net and the probe specification; only the gated probe IPC imports it", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const code = fs.readFileSync(path.join(root, "electron/localProbe.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect([...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["../src/lib/ai/probeSpec.js", "node:http", "node:net"]);
    expect(code).not.toMatch(/console\.|process\.|require\(|import\(|keepAlive: true|maxRedirects|follow|Authorization|Cookie|credential|safeStorage|electron"|retry/i);
    // No agent: Node then uses the module's own checked socket (agent: false would make a new Agent that ignores it).
    expect(code).toMatch(/agent: undefined,\s*createConnection: \(\) => sock,/);
    expect(code).not.toMatch(/agent: (false|http|new)/);
    expect(code).toMatch(/insecureHTTPParser: false/);
    expect(code).toMatch(/maxHeaderSize: PROBE_MAX_HEADER_BYTES/);
    const runtime = [
      ...fs.readdirSync(path.join(root, "electron"), { recursive: true }).map((f) => path.join("electron", String(f))),
      ...fs.readdirSync(path.join(root, "src"), { recursive: true }).map((f) => path.join("src", String(f))),
    ].filter((f) => /\.(c?ts|tsx)$/.test(f));
    const importers = runtime.filter((f) => /localProbe|probeSpec/.test(fs.readFileSync(path.join(root, f), "utf8"))).map((f) => f.replace(/\\/g, "/")).sort();
    // Stage 4O: only the gated probe IPC (aiProbeIpc.ts) uses it, and only ipc.ts registers that.
    expect(importers).toEqual(["electron/aiProbeIpc.ts", "electron/localProbe.ts", "src/lib/ai/probeSpec.ts"]);
    const probeIpcImporters = runtime.filter((f) => /aiProbeIpc/.test(fs.readFileSync(path.join(root, f), "utf8"))).map((f) => f.replace(/\\/g, "/")).sort();
    expect(probeIpcImporters).toEqual(["electron/ipc.ts"]);
  });
});
