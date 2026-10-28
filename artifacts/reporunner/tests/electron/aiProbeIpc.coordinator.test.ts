// Stage 4O: the probe coordinator on its own, with fake settings, transport
// and clock: the check order, the exact contract, one probe at a time, the
// cooldown, cancellation and what crosses IPC. No sockets here (see
// aiProbeIpc.test.ts for the real handler, store and transport).
import { describe, expect, it, vi } from "vitest";
import { AI_PROBE_COOLDOWN_MS, AiProbeCoordinator, devServerPorts, type AiProbeDependencies } from "../../electron/aiProbeIpc";
import type { ProbeResult } from "../../src/lib/ai/probeSpec";

const REV = "a".repeat(64);
const OTHER_REV = "b".repeat(64);
const config = (id = "cfg-a1", endpoint = "http://127.0.0.1:11434", apiStyle = "ollama-native", model: string | null = "SYNTHETIC-MODEL") => ({ id, kind: "local-endpoint", endpoint, apiStyle, model });
const settings = (configs = [config()], active: string | null = "cfg-a1") => ({ format: "reporunner-ai-settings", version: 1, active, configs });

function setup(load: unknown = { status: "valid", revision: REV, settings: settings() }) {
  let clock = 1_000_000;
  const pending: Array<{ resolve: (r: ProbeResult) => void; reject: (e: unknown) => void; signal: AbortSignal; config: unknown }> = [];
  const loadSettings = vi.fn(async () => load as never);
  const probe = vi.fn((cfg: unknown, options?: { signal?: AbortSignal }) => new Promise<ProbeResult>((resolve, reject) => pending.push({ resolve, reject, signal: options!.signal!, config: cfg })));
  const deps: AiProbeDependencies = { loadSettings, probe: probe as never, now: () => clock };
  const c = new AiProbeCoordinator(deps);
  const ports = vi.fn((): readonly number[] => []);
  const run = (args: unknown[], signal?: AbortSignal) => c.run(args, { signal, projectPorts: ports });
  return { c, run, loadSettings, probe, pending, ports, tick: (ms: number) => (clock += ms) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Runs one probe to completion with the given transport result. */
async function complete(s: ReturnType<typeof setup>, result: ProbeResult = { outcome: "compatible", modelCount: null }) {
  const p = s.run(["cfg-a1", REV]);
  await flush();
  s.pending.shift()!.resolve(result);
  return p;
}

describe("exact arguments, checked before anything is read", () => {
  it.each([
    ["no arguments", []],
    ["one argument", ["cfg-a1"]],
    ["three arguments", ["cfg-a1", REV, {}]],
    ["explicit undefined revision", ["cfg-a1", undefined]],
    ["null revision", ["cfg-a1", null]],
    ["upper-case revision", ["cfg-a1", "A".repeat(64)]],
    ["short revision", ["cfg-a1", "a".repeat(63)]],
    ["long revision", ["cfg-a1", "a".repeat(65)]],
    ["non-hex revision", ["cfg-a1", "g".repeat(64)]],
    ["bad id", ["CFG-A1", REV]],
    ["empty id", ["cfg-", REV]],
    ["prototype id", ["__proto__", REV]],
    ["a URL instead of an id", ["http://127.0.0.1:11434", REV]],
    ["an endpoint object", [{ endpoint: "http://127.0.0.1:1", apiStyle: "ollama-native" }, REV]],
    ["a number", [1, REV]],
    ["arguments swapped", [REV, "cfg-a1"]],
  ])("%s: invalid-request, nothing loaded or sent", async (_name, args) => {
    const s = setup();
    expect(await s.run(args)).toEqual({ ok: false, error: "invalid-request" });
    expect(s.loadSettings).not.toHaveBeenCalled();
    expect(s.ports).not.toHaveBeenCalled();
    expect(s.probe).not.toHaveBeenCalled();
  });
});

describe("saved settings, revision, lookup, re-validation, ports", () => {
  it.each([
    [{ status: "missing", revision: null, settings: settings([], null) }, "missing"],
    [{ status: "damaged", reason: "invalid-json" }, "damaged"],
    [{ status: "unsupported-version" }, "unsupported-version"],
    [{ status: "unreadable" }, "unreadable"],
    [{ status: "something-else" }, "failed"],
  ])("settings %o: a fixed error, nothing sent", async (load, error) => {
    const s = setup(load);
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error });
    expect(s.probe).not.toHaveBeenCalled();
  });

  it("a load that throws is a fixed failure, never its message", async () => {
    const s = setup();
    s.loadSettings.mockRejectedValueOnce(new Error("EACCES C:\\Users\\SYNTHETIC"));
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "failed" });
  });

  it("a different revision: conflict, nothing sent", async () => {
    const s = setup();
    expect(await s.run(["cfg-a1", OTHER_REV])).toEqual({ ok: false, error: "conflict" });
    expect(s.ports).not.toHaveBeenCalled();
    expect(s.probe).not.toHaveBeenCalled();
  });

  it("an id not in that document: not-found", async () => {
    const s = setup();
    expect(await s.run(["cfg-zz9", REV])).toEqual({ ok: false, error: "not-found" });
    expect(s.probe).not.toHaveBeenCalled();
  });

  it.each(["http://localhost:11434", "http://192.168.1.5:11434", "http://127.0.0.1:1/", "HTTP://127.0.0.1:1", "https://127.0.0.1:1"])(
    "a stored endpoint that isn't canonical loopback (%s) is refused here, even if the store let it through",
    async (endpoint) => {
      const s = setup({ status: "valid", revision: REV, settings: settings([config("cfg-a1", endpoint)]) });
      expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "invalid-configuration" });
      expect(s.probe).not.toHaveBeenCalled();
    },
  );

  it("an unknown API style is refused", async () => {
    const s = setup({ status: "valid", revision: REV, settings: settings([config("cfg-a1", "http://127.0.0.1:1", "anthropic")]) });
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "invalid-configuration" });
  });

  it("a port RepoRunner's project uses: refused before any network; another port is fine", async () => {
    const s = setup();
    s.ports.mockReturnValue([3000, 11434]);
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "port-in-use-by-project" });
    expect(s.probe).not.toHaveBeenCalled();
    s.ports.mockReturnValue([3000, 5173]);
    expect(await complete(s)).toEqual({ ok: true, outcome: "compatible", modelCount: null });
  });

  it("port information that can't be read: fail closed", async () => {
    const s = setup();
    s.ports.mockImplementation(() => {
      throw new Error("SYNTHETIC");
    });
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "failed" });
    s.ports.mockReturnValue("3000" as never);
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "failed" });
    expect(s.probe).not.toHaveBeenCalled();
  });

  it("the transport gets only the stored endpoint and API style, and a signal", async () => {
    const s = setup();
    await complete(s);
    expect(s.probe).toHaveBeenCalledTimes(1);
    expect(s.probe.mock.calls[0][0]).toEqual({ endpoint: "http://127.0.0.1:11434", apiStyle: "ollama-native" });
    expect(s.probe.mock.calls[0][1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("the order: arguments, settings, revision, lookup, endpoint, ports, then the permit", async () => {
    const order: string[] = [];
    const s = setup();
    s.loadSettings.mockImplementation(async () => (order.push("load"), { status: "valid", revision: REV, settings: settings() }) as never);
    s.ports.mockImplementation(() => (order.push("ports"), []));
    s.probe.mockImplementation(async () => (order.push("probe"), { outcome: "compatible", modelCount: null }));
    await s.run(["cfg-a1", REV]);
    expect(order).toEqual(["load", "ports", "probe"]);
  });
});

describe("one probe at a time, then a cooldown", () => {
  it("a second call while one is running: busy, nothing sent", async () => {
    const s = setup();
    const first = s.run(["cfg-a1", REV]);
    await flush();
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "busy" });
    expect(s.probe).toHaveBeenCalledTimes(1);
    s.pending.shift()!.resolve({ outcome: "timeout" });
    expect(await first).toEqual({ ok: true, outcome: "timeout" });
  });

  it("two calls arriving together: exactly one probe", async () => {
    const s = setup();
    const a = s.run(["cfg-a1", REV]);
    const b = s.run(["cfg-a1", REV]);
    await flush();
    expect(s.probe).toHaveBeenCalledTimes(1);
    s.pending.shift()!.resolve({ outcome: "compatible", modelCount: null });
    const results = await Promise.all([a, b]);
    expect(results).toContainEqual({ ok: false, error: "busy" });
    expect(results).toContainEqual({ ok: true, outcome: "compatible", modelCount: null });
  });

  it("2 s after a probe finishes: rate-limited before, allowed at exactly 2 s", async () => {
    const s = setup();
    await complete(s);
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "rate-limited" });
    s.tick(AI_PROBE_COOLDOWN_MS - 1);
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "rate-limited" });
    expect(s.probe).toHaveBeenCalledTimes(1);
    s.tick(1);
    expect(await complete(s)).toEqual({ ok: true, outcome: "compatible", modelCount: null });
    expect(AI_PROBE_COOLDOWN_MS).toBe(2000);
  });

  it("the cooldown runs from when the probe finished, not when it started", async () => {
    const s = setup();
    const p = s.run(["cfg-a1", REV]);
    await flush();
    s.tick(5000);
    s.pending.shift()!.resolve({ outcome: "timeout" });
    await p;
    s.tick(1999);
    expect(await s.run(["cfg-a1", REV])).toEqual({ ok: false, error: "rate-limited" });
  });

  it("refused calls never start or extend the cooldown", async () => {
    const s = setup();
    for (const args of [[], ["bad", REV], ["cfg-a1", OTHER_REV], ["cfg-zz9", REV]]) await s.run(args);
    s.ports.mockReturnValueOnce([11434]);
    await s.run(["cfg-a1", REV]);
    expect(await complete(s)).toEqual({ ok: true, outcome: "compatible", modelCount: null });
    // Busy and rate-limited answers don't push the cooldown out either.
    s.tick(1500);
    await s.run(["cfg-a1", REV]);
    s.tick(500);
    expect(await complete(s)).toEqual({ ok: true, outcome: "compatible", modelCount: null });
  });

  it("released after a transport error or a thrown exception", async () => {
    const s = setup();
    const p = s.run(["cfg-a1", REV]);
    await flush();
    s.pending.shift()!.reject(new Error("SYNTHETIC socket explosion"));
    expect(await p).toEqual({ ok: false, error: "failed" });
    s.tick(2000);
    expect(await complete(s, { outcome: "connection-refused" })).toEqual({ ok: true, outcome: "connection-refused" });
  });
});

describe("cancellation", () => {
  it("the caller's signal aborts the transport, which settles as cancelled; the permit is released", async () => {
    const s = setup();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const p = s.run(["cfg-a1", REV], controller.signal);
    await flush();
    const inFlight = s.pending.shift()!;
    expect(inFlight.signal.aborted).toBe(false);
    controller.abort();
    expect(inFlight.signal.aborted).toBe(true);
    inFlight.resolve({ outcome: "cancelled" });
    expect(await p).toEqual({ ok: false, error: "cancelled" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    s.tick(2000);
    expect(await complete(s)).toMatchObject({ ok: true });
  });

  it("already aborted before the permit: cancelled, nothing sent, no cooldown", async () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await s.run(["cfg-a1", REV], controller.signal)).toEqual({ ok: false, error: "cancelled" });
    expect(s.probe).not.toHaveBeenCalled();
    expect(await complete(s)).toMatchObject({ ok: true });
  });
});

describe("only fixed codes and bounded metadata cross IPC", () => {
  it.each<[ProbeResult, unknown]>([
    [{ outcome: "compatible", modelCount: null }, { ok: true, outcome: "compatible", modelCount: null }],
    [{ outcome: "compatible", modelCount: 7 }, { ok: true, outcome: "compatible", modelCount: 7 }],
    [{ outcome: "http-error", statusClass: "5xx" }, { ok: true, outcome: "http-error", statusClass: "5xx" }],
    [{ outcome: "incompatible-response" }, { ok: true, outcome: "incompatible-response" }],
    [{ outcome: "redirect-refused" }, { ok: true, outcome: "redirect-refused" }],
    [{ outcome: "auth-required" }, { ok: true, outcome: "auth-required" }],
    [{ outcome: "not-found-at-path" }, { ok: true, outcome: "not-found-at-path" }],
    [{ outcome: "connection-refused" }, { ok: true, outcome: "connection-refused" }],
    [{ outcome: "timeout" }, { ok: true, outcome: "timeout" }],
    [{ outcome: "response-too-large" }, { ok: true, outcome: "response-too-large" }],
    [{ outcome: "address-mismatch" }, { ok: true, outcome: "address-mismatch" }],
    [{ outcome: "invalid-request" }, { ok: false, error: "invalid-configuration" }],
    [{ outcome: "cancelled" }, { ok: false, error: "cancelled" }],
    [{ outcome: "failed" }, { ok: false, error: "failed" }],
  ])("%o", async (result, expected) => {
    expect(await complete(setup(), result)).toEqual(expected);
  });

  it("anything unexpected from the transport is stripped or refused", async () => {
    const odd = [
      { outcome: "compatible", modelCount: 7, models: ["SYNTHETIC-name"], version: "0.5.7" },
      { outcome: "http-error", statusClass: "5xx", body: "SYNTHETIC body", headers: { server: "SYNTHETIC" } },
      { outcome: "timeout", detail: "SYNTHETIC" },
    ];
    for (const r of odd) {
      const s = setup();
      const out = await complete(s, r as never);
      expect(JSON.stringify(out)).not.toContain("SYNTHETIC");
      expect(JSON.stringify(out)).not.toContain("0.5.7");
    }
    for (const r of [{ outcome: "compatible", modelCount: 5000 }, { outcome: "compatible", modelCount: 1.5 }, { outcome: "http-error", statusClass: "SYNTHETIC" }, { outcome: "SYNTHETIC" }]) {
      expect(await complete(setup(), r as never)).toEqual({ ok: false, error: "failed" });
    }
  });

  it("never the endpoint, model label, revision or id", async () => {
    const out = JSON.stringify(await complete(setup(), { outcome: "compatible", modelCount: 1 }));
    for (const leak of ["127.0.0.1", "11434", "SYNTHETIC-MODEL", REV, "cfg-a1"]) expect(out).not.toContain(leak);
  });
});

describe("devServerPorts", () => {
  it("the dev server's port when the page is served over http; nothing for a packaged file page", () => {
    expect(devServerPorts("http://localhost:5173/")).toEqual([5173]);
    expect(devServerPorts("http://127.0.0.1/")).toEqual([80]);
    expect(devServerPorts("file:///C:/Program%20Files/RepoRunner/resources/app.asar/dist/public/index.html")).toEqual([]);
    expect(devServerPorts(undefined)).toEqual([]);
    expect(devServerPorts("not a url")).toEqual([]);
  });
});
