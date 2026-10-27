// Stage 4G: a failure generating the temp-file name is a "write-failed"
// result, never a rejected save, and nothing is written under a predictable
// name. Node's crypto is mocked in this file only; the store has no test seam.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ randomBytes: null as null | ((size: number) => Buffer) }));

vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  const randomBytes = ((size: number) => (h.randomBytes ? h.randomBytes(size) : actual.randomBytes(size))) as typeof actual.randomBytes;
  return { ...actual, randomBytes, default: { ...actual, randomBytes } };
});

const { AI_SETTINGS_FILE, AiSettingsStore } = await import("../../electron/aiSettingsStore.js");
const { AI_SETTINGS_FORMAT } = await import("../../src/lib/ai/settingsSchema.js");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-aisettings-rng-"));
  h.randomBytes = null;
});
afterEach(() => {
  h.randomBytes = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

const doc = (id: string) => ({ format: AI_SETTINGS_FORMAT, version: 1, active: id, configs: [{ id, kind: "local-endpoint", endpoint: "http://127.0.0.1:11434", apiStyle: "ollama-native", model: null }] });

/** Node's fs, recording which paths were opened for writing. */
function recordingFs() {
  const writeOpens: string[] = [];
  const f = {
    ...fs,
    openSync: (p: string, flags: string | number, mode?: number) => {
      if (typeof flags === "string" && /w/.test(flags)) writeOpens.push(p);
      return fs.openSync(p, flags, mode);
    },
  };
  return { fs: f as never, writeOpens };
}

describe("temp-name generation failure", () => {
  const failures: Array<[string, (size: number) => Buffer]> = [
    ["throws (the OS random source failed)", () => { throw Object.assign(new Error(`EIO: ${os.tmpdir()} entropy SYNTHETIC`), { code: "EIO" }); }],
    ["throws a non-Error", () => { throw "SYNTHETIC"; }],
    ["returns too few bytes", () => Buffer.alloc(4, 0xab)],
    ["returns nothing", () => Buffer.alloc(0)],
  ];

  it.each(failures)("when random generation %s, save reports write-failed and changes nothing", async (_name, failing) => {
    const first = await new AiSettingsStore({ dir }).save(doc("cfg-a1"), null);
    expect(first.ok).toBe(true);
    const before = fs.readFileSync(path.join(dir, AI_SETTINGS_FILE));

    const { fs: f, writeOpens } = recordingFs();
    const store = new AiSettingsStore({ dir, fs: f });
    h.randomBytes = failing;
    const result = await store.save(doc("cfg-b2"), first.ok ? first.revision : null);
    expect(result).toEqual({ ok: false, error: "write-failed" });
    // Nothing was opened for writing: no temp file under a fallback name, and not the target.
    expect(writeOpens).toEqual([]);
    expect(fs.readFileSync(path.join(dir, AI_SETTINGS_FILE)).equals(before)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([AI_SETTINGS_FILE]);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|EIO|entropy/);

    // The store keeps working once random generation does.
    h.randomBytes = null;
    const next = await store.save(doc("cfg-b2"), first.ok ? first.revision : null);
    expect(next.ok).toBe(true);
    expect(writeOpens).toHaveLength(1);
    expect(path.basename(writeOpens[0])).toMatch(/^reporunner-ai-settings\.json\.[0-9a-f]{16}\.tmp$/);
  });

  it("a failure on a first save leaves no file at all", async () => {
    h.randomBytes = () => { throw new Error("SYNTHETIC"); };
    expect(await new AiSettingsStore({ dir }).save(doc("cfg-a1"), null)).toEqual({ ok: false, error: "write-failed" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("loading never needs random generation", async () => {
    await new AiSettingsStore({ dir }).save(doc("cfg-a1"), null);
    h.randomBytes = () => { throw new Error("SYNTHETIC"); };
    expect((await new AiSettingsStore({ dir }).load()).status).toBe("valid");
  });
});
