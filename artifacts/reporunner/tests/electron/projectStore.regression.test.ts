// Regression tests for the original P0-B data-loss bug: a saved-setups file
// that failed to load was treated as "no profiles", and the next save (or the
// load itself) replaced the user's file. All files live in a per-test temp
// directory; the real RepoRunner user-data folder is never touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => h.userData },
}));

import {
  deleteProject,
  loadProjectState,
  saveProject,
  setActiveProject,
} from "../../electron/projectStore.js";

const STORE = "reporunner-project.json";

function profile(id: string, name = `Repo ${id}`) {
  return {
    id,
    name,
    repoPath: `C:\repos\${id}`,
    installCommand: "npm install",
    frontendCommand: "npm run dev",
    backendCommand: "",
    previewUrl: "http://localhost:5173",
  };
}

function storePath() {
  return path.join(h.userData, STORE);
}

function writeStore(content: string | Buffer) {
  fs.writeFileSync(storePath(), content);
}

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "rr-p0b-reg-"));
});

afterEach(() => {
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe("original data-loss bug", () => {
  it("a truncated file is not replaced by the next save", () => {
    const original = JSON.stringify({ profiles: [profile("a"), profile("b")], activeProfileId: "a" }, null, 2);
    const truncated = original.slice(0, original.length - 40);
    writeStore(truncated);

    let saveError: unknown = null;
    try {
      saveProject(profile("new"));
    } catch (error) {
      saveError = error;
    }

    // Old behaviour: the save succeeded and the file now held only "new".
    expect(fs.readFileSync(storePath(), "utf-8")).toBe(truncated);
    expect(saveError).toBeInstanceOf(Error);
    expect(() => loadProjectState()).toThrow();
  });

  it("one invalid profile does not hide or erase the other saved profiles", () => {
    const bad = { ...profile("bad"), previewUrl: "not a url" };
    writeStore(JSON.stringify({ profiles: [profile("a"), bad, profile("b")], activeProfileId: "a" }, null, 2));

    expect(loadProjectState().profiles.map((p) => p.id)).toEqual(["a", "b"]);

    saveProject(profile("c"));

    const saved = JSON.parse(fs.readFileSync(storePath(), "utf-8"));
    expect(saved.profiles.map((p: { id: string }) => p.id)).toEqual(["a", "bad", "b", "c"]);
    expect(saved.profiles[1]).toEqual(bad);
  });

  it("a file with a UTF-8 byte-order mark still loads and is not replaced", () => {
    writeStore(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ profiles: [profile("a")], activeProfileId: "a" }))]));

    expect(loadProjectState().profiles.map((p) => p.id)).toEqual(["a"]);

    saveProject(profile("b"));
    const saved = JSON.parse(fs.readFileSync(storePath(), "utf-8"));
    expect(saved.profiles.map((p: { id: string }) => p.id)).toEqual(["a", "b"]);
  });

  it("loading never rewrites the file (missing IDs used to trigger a rewrite)", () => {
    const { id: _omit, ...noId } = profile("x");
    const content = JSON.stringify({ profiles: [noId], activeProfileId: null, extra: { keep: true } }, null, 2);
    writeStore(content);

    loadProjectState();
    loadProjectState();

    expect(fs.readFileSync(storePath(), "utf-8")).toBe(content);
  });

  it("setActive and delete refuse to write over an unreadable file", () => {
    // (Old code also threw here, but only because the file looked empty.)
    writeStore("{ this is not json");

    expect(() => setActiveProject("a")).toThrow();
    expect(() => deleteProject("a")).toThrow();

    expect(fs.readFileSync(storePath(), "utf-8")).toBe("{ this is not json");
  });
});
