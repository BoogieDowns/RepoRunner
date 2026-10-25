// Exercises the real storage IPC handlers against the real store in a temp
// userData directory. Electron's shell is mocked: nothing is opened, and no
// process is started or stopped (nothing is tracked).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event?: unknown, ...args: unknown[]) => Promise<unknown>;

const h = vi.hoisted(() => ({
  userData: "",
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => h.userData },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
  shell: { showItemInFolder: h.showItemInFolder, openPath: h.openPath },
  dialog: {},
  clipboard: { writeText: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { setupIpc } from "../../electron/ipc.js";
import { BACKUP_FILE, RECOVERY_FILE_PREFIX, STORE_FILE } from "../../electron/projectStore.js";
import { trustedRenderer } from "./fakeSender.js";

const file = (name = STORE_FILE) => path.join(h.userData, name);
const read = (name = STORE_FILE) => fs.readFileSync(file(name), "utf-8");
const write = (content: string, name = STORE_FILE) => fs.writeFileSync(file(name), content);
const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const listDir = () => fs.readdirSync(h.userData).sort();

/** RepoRunner's own window and page: the only caller the handlers accept. */
const app = trustedRenderer();

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return (fn as Handler)(app.event(), ...args);
}

function profile(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Repo ${id}`,
    repoPath: h.userData, // must be an existing directory for save-project
    installCommand: "npm install",
    frontendCommand: "npm run dev",
    backendCommand: "",
    previewUrl: "http://localhost:5173",
    ...extra,
  };
}

const DAMAGED = '{"profiles": [ {"id": "a", "name": "Secret Project", "installCommand": "set TOKEN=sk-live-1';

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "rr-p0b-ipc-"));
  h.handlers.clear();
  h.showItemInFolder.mockReset();
  h.openPath.mockReset().mockResolvedValue("");
  vi.spyOn(console, "error").mockImplementation(() => {});
  setupIpc(app.trust);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe("get-project-store-status", () => {
  it("returns the value-free status, with no paths or contents", async () => {
    const backup = JSON.stringify({ profiles: [profile("a")], activeProfileId: "a" });
    write(backup, BACKUP_FILE);
    write(DAMAGED);

    const status = await invoke("get-project-store-status");

    expect(status).toMatchObject({
      state: "needs-recovery",
      recoveryRequired: true,
      backupAvailable: true,
      revision: sha(DAMAGED),
      availableActions: ["retry", "restore-backup", "start-fresh"],
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(h.userData);
    expect(serialized).not.toMatch(/Secret|sk-live|TOKEN|npm|rr-p0b/);
  });
});

describe("resolve-project-store-issue argument validation", () => {
  it.each([undefined, null, 42, "", "RETRY", "delete-everything", "../reporunner-project.json", { action: "retry" }, ["retry"]])(
    "rejects action %j without touching files",
    async (action) => {
      write(DAMAGED);
      const before = listDir();

      await expect(invoke("resolve-project-store-issue", action, sha(DAMAGED))).rejects.toThrow("Unknown recovery action.");

      expect(listDir()).toEqual(before);
      expect(read()).toBe(DAMAGED);
    },
  );

  it.each([42, "", "abc", "C:\\Users\\x\\file.json", sha(DAMAGED).toUpperCase(), { revision: "x" }, [sha(DAMAGED)]])(
    "rejects revision %j without touching files",
    async (revision) => {
      write(DAMAGED);

      await expect(invoke("resolve-project-store-issue", "start-fresh", revision)).rejects.toThrow(
        "Invalid saved repo setups revision.",
      );

      expect(listDir()).toEqual([STORE_FILE]);
    },
  );

  it.each(["restore-backup", "start-fresh", "discard-invalid-entries"])(
    "%s requires a revision",
    async (action) => {
      write(DAMAGED);

      await expect(invoke("resolve-project-store-issue", action)).rejects.toThrow("require the saved repo setups revision");

      expect(listDir()).toEqual([STORE_FILE]);
    },
  );

  it("retry needs no revision and writes nothing", async () => {
    write(DAMAGED);

    await expect(invoke("resolve-project-store-issue", "retry")).resolves.toMatchObject({ state: "needs-recovery" });

    expect(listDir()).toEqual([STORE_FILE]);
  });

  it("a valid explicit request performs the action", async () => {
    write(DAMAGED);

    const status = await invoke("resolve-project-store-issue", "start-fresh", sha(DAMAGED));

    expect(status).toMatchObject({ state: "ok" });
    expect(listDir().filter((n) => n.startsWith(RECOVERY_FILE_PREFIX))).toHaveLength(1);
    await expect(invoke("load-project-state")).resolves.toMatchObject({ profiles: [], activeProfileId: null });
  });

  it("a stale revision is rejected as a conflict", async () => {
    write(DAMAGED);

    await expect(invoke("resolve-project-store-issue", "start-fresh", sha("old"))).rejects.toThrow("changed since RepoRunner last read them");

    expect(listDir()).toEqual([STORE_FILE]);
  });
});

describe("reveal-project-store-file", () => {
  it("reveals RepoRunner's own store file", async () => {
    write("{}");

    await invoke("reveal-project-store-file");

    expect(h.showItemInFolder).toHaveBeenCalledWith(file());
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it("opens the store folder when the file does not exist", async () => {
    await invoke("reveal-project-store-file");

    expect(h.openPath).toHaveBeenCalledWith(h.userData);
    expect(h.showItemInFolder).not.toHaveBeenCalled();
  });

  it("ignores no input: any argument (such as a path) is rejected", async () => {
    await expect(invoke("reveal-project-store-file", "C:\\Windows\\System32")).rejects.toThrow("Unexpected arguments.");
    await expect(invoke("reveal-project-store-file", undefined)).rejects.toThrow("Unexpected arguments.");

    expect(h.showItemInFolder).not.toHaveBeenCalled();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it("reports a folder that can't be opened without leaking the path", async () => {
    h.openPath.mockResolvedValue("Access denied");

    const error = await invoke("reveal-project-store-file").catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(h.userData);
  });
});

describe("existing mutations with optional revisions", () => {
  it("save, switch and delete still work without a revision (compatibility)", async () => {
    await invoke("save-project", profile("a"));
    await invoke("save-project", profile("b"));
    await invoke("set-active-project", "a");
    const state = (await invoke("delete-project", "b")) as { profiles: { id: string }[]; activeProfileId: string };

    expect(state.profiles.map((p) => p.id)).toEqual(["a"]);
    expect(state.activeProfileId).toBe("a");
  });

  it("returned states carry the revision that the next call can use", async () => {
    const first = (await invoke("save-project", profile("a"), null)) as { revision: string };
    expect(first.revision).toBe(sha(read()));

    const second = (await invoke("save-project", profile("b"), first.revision)) as { revision: string };
    const third = (await invoke("set-active-project", "a", second.revision)) as { revision: string };
    await invoke("delete-project", "b", third.revision);

    expect(JSON.parse(read()).profiles.map((p: { id: string }) => p.id)).toEqual(["a"]);
  });

  it("a stale revision is rejected and newer data is kept", async () => {
    const first = (await invoke("save-project", profile("a"))) as { revision: string };
    await invoke("save-project", profile("b"));
    const latest = read();

    for (const call of [
      () => invoke("save-project", profile("c"), first.revision),
      () => invoke("set-active-project", "a", first.revision),
      () => invoke("delete-project", "a", first.revision),
    ]) {
      await expect(call()).rejects.toThrow("changed since RepoRunner last read them");
    }
    expect(read()).toBe(latest);
  });

  it.each([42, "abc", {}, "C:\\x"])("a malformed revision %j is rejected before anything is written", async (revision) => {
    await invoke("save-project", profile("a"));
    const before = read();

    await expect(invoke("save-project", profile("b"), revision)).rejects.toThrow("Invalid saved repo setups revision.");
    await expect(invoke("set-active-project", "a", revision)).rejects.toThrow("Invalid saved repo setups revision.");
    await expect(invoke("delete-project", "a", revision)).rejects.toThrow("Invalid saved repo setups revision.");

    expect(read()).toBe(before);
  });

  it("mutations stay blocked on a damaged file even with its current revision", async () => {
    write(DAMAGED);

    for (const call of [
      () => invoke("save-project", profile("c"), sha(DAMAGED)),
      () => invoke("set-active-project", "a", sha(DAMAGED)),
      () => invoke("delete-project", "a", sha(DAMAGED)),
    ]) {
      await expect(call()).rejects.toThrow("problem with your saved repo setups");
    }
    expect(listDir()).toEqual([STORE_FILE]);
  });
});

describe("stop compatibility", () => {
  it("Stop Engine still resolves when the store is damaged (nothing tracked, nothing killed)", async () => {
    write(DAMAGED);
    const kill = vi.spyOn(process, "kill");

    await expect(invoke("stop-services")).resolves.toBeUndefined();

    expect(kill).not.toHaveBeenCalled();
    expect(read()).toBe(DAMAGED);
  });

  it("with no repo selected, no command-running handler picks another repo", async () => {
    write(JSON.stringify({ profiles: [profile("a"), profile("b")], activeProfileId: null }));

    await expect(invoke("load-project")).resolves.toBeNull();
    for (const channel of ["start-frontend", "start-backend", "restart-all", "run-install", "pull-latest", "open-preview"]) {
      await expect(invoke(channel)).rejects.toThrow("No project configured");
    }
    await expect(invoke("get-statuses")).resolves.toEqual({ frontend: "stopped", backend: "stopped" });
    await expect(invoke("stop-services")).resolves.toBeUndefined();
  });

  it("after discarding an invalid active repo, commands still refuse instead of switching repos", async () => {
    write(JSON.stringify({ profiles: [profile("a"), profile("broken", { previewUrl: "x" })], activeProfileId: "broken" }));
    const status = (await invoke("get-project-store-status")) as { revision: string };

    await invoke("resolve-project-store-issue", "discard-invalid-entries", status.revision);

    await expect(invoke("load-project-state")).resolves.toMatchObject({ activeProfileId: null });
    await expect(invoke("start-frontend")).rejects.toThrow("No project configured");
  });

  it("no command-running handler accepts a damaged store", async () => {
    write(DAMAGED);

    for (const channel of ["start-frontend", "start-backend", "restart-all", "run-install", "pull-latest", "open-preview"]) {
      await expect(invoke(channel)).rejects.toThrow("problem with your saved repo setups");
    }
  });
});
