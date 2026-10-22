// Renderer-side recovery decisions (no DOM needed) and the browser mock's
// revision behaviour (with an in-memory localStorage).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyStoreError,
  createSingleFlight,
  displayErrorMessage,
  getNoticeContent,
  getNoticeKind,
  getRecoveryConfirmation,
  isStoreBlocked,
  readStoreForDisplay,
  recoveryRevision,
  requiresConfirmation,
  runStoreMutation,
} from "../../src/lib/projectStoreRecovery";
import {
  PROJECT_STORE_ERROR_MESSAGES,
  type ProjectStoreErrorCode,
  type ProjectStoreStatus,
} from "../../src/types";

const REV = "a".repeat(64);

function status(overrides: Partial<ProjectStoreStatus>): ProjectStoreStatus {
  return {
    state: "ok",
    reason: null,
    recoveryRequired: false,
    readOnly: false,
    backupAvailable: false,
    revision: REV,
    totalEntries: 1,
    unavailableEntries: [],
    availableActions: ["retry"],
    ...overrides,
  };
}

const damaged = (backup: boolean) =>
  status({
    state: "needs-recovery",
    reason: "malformed-json",
    recoveryRequired: true,
    readOnly: true,
    backupAvailable: backup,
    totalEntries: 0,
    availableActions: backup ? ["retry", "restore-backup", "start-fresh"] : ["retry", "start-fresh"],
  });
const unreadable = status({ state: "unreadable", reason: "EACCES", recoveryRequired: true, readOnly: true, revision: null, totalEntries: 0 });
const unsupported = status({ state: "unsupported-version", readOnly: true, totalEntries: 0 });
const withUnavailable = status({
  totalEntries: 3,
  unavailableEntries: [
    { index: 1, reason: "Invalid project profile: Preview URL must be valid" },
    { index: 2, reason: "Duplicate profile ID" },
  ],
  availableActions: ["retry", "discard-invalid-entries"],
});

/** What Electron's ipcRenderer.invoke rejects with for a main-process error. */
const ipcError = (channel: string, code: ProjectStoreErrorCode) =>
  new Error(`Error invoking remote method '${channel}': Error: ${PROJECT_STORE_ERROR_MESSAGES[code]}`);

describe("notice state selection", () => {
  it.each([
    [status({ state: "missing", revision: null, totalEntries: 0 }), null],
    [status({}), null],
    [damaged(true), "damaged"],
    [unreadable, "unreadable"],
    [unsupported, "unsupported"],
    [withUnavailable, "unavailable-entries"],
  ] as const)("%#: %s", (s, kind) => {
    expect(getNoticeKind(s)).toBe(kind);
  });

  it("no status (still loading or unavailable) shows no notice", () => {
    expect(getNoticeKind(null)).toBeNull();
    expect(getNoticeContent(null)).toBeNull();
  });

  it("blocks mutations for damaged, unreadable and unsupported files only", () => {
    expect(isStoreBlocked(damaged(false))).toBe(true);
    expect(isStoreBlocked(unreadable)).toBe(true);
    expect(isStoreBlocked(unsupported)).toBe(true);
    expect(isStoreBlocked(withUnavailable)).toBe(false);
    expect(isStoreBlocked(status({ state: "missing", revision: null }))).toBe(false);
    expect(isStoreBlocked(null)).toBe(false);
  });
});

describe("available actions", () => {
  const actionsOf = (s: ProjectStoreStatus) => getNoticeContent(s)!.actions.map((a) => a.action);

  it("offers exactly the backend's actions plus Show File Location", () => {
    expect(actionsOf(damaged(true))).toEqual(["retry", "restore-backup", "start-fresh", "reveal"]);
    expect(actionsOf(damaged(false))).toEqual(["retry", "start-fresh", "reveal"]);
    expect(actionsOf(unreadable)).toEqual(["retry", "reveal"]);
    expect(actionsOf(unsupported)).toEqual(["retry", "reveal"]);
    expect(actionsOf(withUnavailable)).toEqual(["retry", "discard-invalid-entries", "reveal"]);
  });

  it("never offers an action the backend did not report", () => {
    const content = getNoticeContent({ ...damaged(true), availableActions: ["retry"] })!;
    expect(content.actions.map((a) => a.action)).toEqual(["retry", "reveal"]);
  });

  it("labels the discard action with the exact number of entries", () => {
    const discard = getNoticeContent(withUnavailable)!.actions.find((a) => a.action === "discard-invalid-entries")!;
    expect(discard.label).toBe("Discard 2 Unavailable Entries");
  });
});

describe("notice wording", () => {
  it("damaged: says the original was kept and mentions the backup only when usable", () => {
    const withBackup = getNoticeContent(damaged(true))!;
    expect(withBackup.message.join(" ")).toMatch(/left exactly as it was/);
    expect(withBackup.message.join(" ")).toMatch(/usable backup is available/);
    expect(withBackup.details).toEqual(["The saved setups file is incomplete or not valid JSON."]);
    expect(getNoticeContent(damaged(false))!.message.join(" ")).toMatch(/No usable backup/);
  });

  it("unreadable and unsupported are distinguished", () => {
    expect(getNoticeContent(unreadable)!.title).toMatch(/can't be opened/);
    expect(getNoticeContent(unreadable)!.message.join(" ")).toMatch(/permissions|another program/i);
    expect(getNoticeContent(unsupported)!.title).toMatch(/newer RepoRunner/);
    expect(getNoticeContent(unsupported)!.message.join(" ")).toMatch(/won't change or run them/);
  });

  it("unavailable entries: counts, field-only reasons, nothing deleted, others usable", () => {
    const content = getNoticeContent(withUnavailable)!;
    expect(content.title).toBe("2 saved setups are unavailable");
    expect(content.message.join(" ")).toMatch(/not been deleted/);
    expect(content.message.join(" ")).toMatch(/other saved setups work normally/);
    expect(content.details).toEqual([
      "Saved setup 2: Preview URL must be valid",
      "Saved setup 3: Uses the same ID as an earlier saved setup",
    ]);
  });

  it("only uses value-free inputs: unknown reason codes add no detail", () => {
    const content = getNoticeContent({ ...damaged(false), reason: "C:\\Users\\someone\\secret" })!;
    expect(JSON.stringify(content)).not.toMatch(/someone|secret|C:\\\\/);
  });
});

describe("confirmation boundaries", () => {
  it("Restore, Start Fresh and Discard need confirmation; Retry and Show File Location don't", () => {
    expect(requiresConfirmation("restore-backup")).toBe(true);
    expect(requiresConfirmation("start-fresh")).toBe(true);
    expect(requiresConfirmation("discard-invalid-entries")).toBe(true);
    expect(requiresConfirmation("retry")).toBe(false);
    expect(requiresConfirmation("reveal")).toBe(false);
    expect(getRecoveryConfirmation("retry", damaged(true))).toBeNull();
    expect(getRecoveryConfirmation("reveal", damaged(true))).toBeNull();
  });

  it("Restore explains the damaged original is preserved", () => {
    const text = getRecoveryConfirmation("restore-backup", damaged(true))!.description.join(" ");
    expect(text).toMatch(/damaged file is kept as a recovery copy/);
  });

  it("Start Fresh never claims to delete data and says nothing will start", () => {
    const confirmation = getRecoveryConfirmation("start-fresh", damaged(true))!;
    const text = confirmation.description.join(" ");
    expect(text).toMatch(/new, empty saved setups file/);
    expect(text).toMatch(/kept as recovery copies/);
    expect(text).toMatch(/Nothing is permanently deleted/);
    expect(text).toMatch(/No repo will be started/);
    expect(confirmation.confirmLabel).toBe("Start Fresh");
  });

  it("Discard shows the exact count, keeps a copy and never picks another repo", () => {
    const confirmation = getRecoveryConfirmation("discard-invalid-entries", withUnavailable)!;
    expect(confirmation.title).toBe("Discard 2 unavailable saved setups?");
    expect(confirmation.description.join(" ")).toMatch(/recovery copy/);
    expect(confirmation.description.join(" ")).toMatch(/no repo will be selected/);
    expect(confirmation.confirmLabel).toBe("Discard 2");
  });

  it("recovery actions carry the revision the user saw; Retry carries none", () => {
    expect(recoveryRevision("retry", damaged(true))).toBeUndefined();
    expect(recoveryRevision("restore-backup", damaged(true))).toBe(REV);
    expect(recoveryRevision("start-fresh", { ...damaged(true), revision: null })).toBeNull();
  });
});

describe("error classification and safe messages", () => {
  it("recognises every saved-setups error after crossing IPC", () => {
    for (const code of Object.keys(PROJECT_STORE_ERROR_MESSAGES) as ProjectStoreErrorCode[]) {
      expect(classifyStoreError(ipcError("save-project", code))).toBe(code);
    }
  });

  it("ignores unrelated errors", () => {
    expect(classifyStoreError(new Error("Invalid project profile: Preview URL must be valid"))).toBeNull();
    expect(classifyStoreError(new Error("Repo limit reached."))).toBeNull();
    expect(classifyStoreError(undefined)).toBeNull();
    expect(classifyStoreError(42)).toBeNull();
  });

  it("strips Electron's IPC prefixes for display", () => {
    expect(displayErrorMessage(ipcError("set-active-project", "conflict"), "x")).toBe(PROJECT_STORE_ERROR_MESSAGES.conflict);
    expect(displayErrorMessage(null, "Fallback")).toBe("Fallback");
  });
});

describe("runStoreMutation", () => {
  it("returns the result without refreshing on success", async () => {
    const refresh = vi.fn(async () => {});
    await expect(runStoreMutation(async () => "ok", refresh)).resolves.toBe("ok");
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["conflict", "write-unverified", "needs-recovery", "unreadable", "unsupported-version"] as const)(
    "%s: re-reads once, never retries, passes the error on",
    async (code) => {
      const mutate = vi.fn(async () => {
        throw ipcError("save-project", code);
      });
      const refresh = vi.fn(async () => {});

      await expect(runStoreMutation(mutate, refresh)).rejects.toThrow(PROJECT_STORE_ERROR_MESSAGES[code]);

      expect(mutate).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("does not refresh for ordinary validation errors", async () => {
    const refresh = vi.fn(async () => {});
    await expect(runStoreMutation(async () => { throw new Error("Saved repo setup not found."); }, refresh)).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a failing refresh doesn't hide the original error", async () => {
    await expect(
      runStoreMutation(
        async () => { throw ipcError("delete-project", "conflict"); },
        async () => { throw new Error("refresh failed"); },
      ),
    ).rejects.toThrow(PROJECT_STORE_ERROR_MESSAGES.conflict);
  });
});

describe("createSingleFlight", () => {
  it("ignores repeated calls while one is running", async () => {
    const run = createSingleFlight();
    let release!: () => void;
    const task = vi.fn(() => new Promise<string>((resolve) => { release = () => resolve("done"); }));

    const first = run(task);
    const second = await run(task);
    expect(second).toEqual({ ran: false });
    release();
    await expect(first).resolves.toEqual({ ran: true, value: "done" });
    expect(task).toHaveBeenCalledTimes(1);

    await run(async () => "again");
    expect(await run(async () => "third")).toEqual({ ran: true, value: "third" });
  });

  it("allows a new call after a failure", async () => {
    const run = createSingleFlight();
    await expect(run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(run(async () => 1)).resolves.toEqual({ ran: true, value: 1 });
  });
});

describe("readStoreForDisplay (startup and refresh)", () => {
  function api(s: ProjectStoreStatus | Error, state: unknown = { profiles: [], activeProfileId: null, revision: null }) {
    return {
      getProjectStoreStatus: vi.fn(async () => {
        if (s instanceof Error) throw s;
        return s;
      }),
      loadProjectState: vi.fn(async () => {
        if (state instanceof Error) throw state;
        return state as never;
      }),
      // Any recovery or mutation call would be a bug: make it loud.
      resolveProjectStoreIssue: vi.fn(() => { throw new Error("recovery must not run automatically"); }),
      saveProject: vi.fn(() => { throw new Error("no writes during display"); }),
    };
  }

  it("a blocked file is reported without loading (never shown as empty)", async () => {
    const fake = api(damaged(true));
    await expect(readStoreForDisplay(fake)).resolves.toEqual({ status: damaged(true), state: null });
    expect(fake.loadProjectState).not.toHaveBeenCalled();
    expect(fake.resolveProjectStoreIssue).not.toHaveBeenCalled();
  });

  it("a healthy or first-launch store loads the setups", async () => {
    const state = { profiles: [], activeProfileId: null, revision: null };
    const fake = api(status({ state: "missing", revision: null, totalEntries: 0 }), state);
    await expect(readStoreForDisplay(fake)).resolves.toMatchObject({ state });
  });

  it("unavailable entries don't block the usable setups", async () => {
    const state = { profiles: [{ id: "a" }], activeProfileId: null, revision: REV };
    const fake = api(withUnavailable, state);
    await expect(readStoreForDisplay(fake)).resolves.toEqual({ status: withUnavailable, state });
  });

  it("if the file breaks between the two reads, reports the new status and no state", async () => {
    const fake = api(status({}), new Error("RepoRunner found a problem"));
    fake.getProjectStoreStatus.mockResolvedValueOnce(status({})).mockResolvedValueOnce(damaged(false));

    await expect(readStoreForDisplay(fake)).resolves.toEqual({ status: damaged(false), state: null });
    expect(fake.resolveProjectStoreIssue).not.toHaveBeenCalled();
    expect(fake.saveProject).not.toHaveBeenCalled();
  });
});

describe("browser mock", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    });
    vi.resetModules();
  });

  const profile = (id: string) => ({
    id, name: id, repoPath: "/tmp", installCommand: "npm i", frontendCommand: "npm run dev",
    backendCommand: "", previewUrl: "http://localhost:3000",
  });

  it("propagates revisions and rejects stale ones like the desktop app", async () => {
    const { mockRepoRunnerAPI: api } = await import("../../src/mock/repoRunnerMock");
    expect((await api.loadProjectState()).revision).toBeNull();

    const first = await api.saveProject(profile("a"), null);
    const second = await api.saveProject(profile("b"), first.revision);
    expect(second.revision).not.toBe(first.revision);
    expect((await api.getProjectStoreStatus()).revision).toBe(second.revision);

    await expect(api.setActiveProject("a", first.revision)).rejects.toThrow(PROJECT_STORE_ERROR_MESSAGES.conflict);
    await expect(api.deleteProject("a", first.revision)).rejects.toThrow(PROJECT_STORE_ERROR_MESSAGES.conflict);
    await expect(api.setActiveProject("a", second.revision)).resolves.toMatchObject({ activeProfileId: "a" });
    await expect(api.setActiveProject("b")).resolves.toMatchObject({ activeProfileId: "b" }); // omitted: unchanged behaviour
  });

  it("reading does not change the revision", async () => {
    const { mockRepoRunnerAPI: api } = await import("../../src/mock/repoRunnerMock");
    const saved = await api.saveProject(profile("a"));
    await api.loadProjectState();
    await api.loadProjectState();
    expect((await api.loadProjectState()).revision).toBe(saved.revision);
  });

  it("an intentional no-selection is kept; it never falls back to another repo", async () => {
    localStorage.setItem("reporunner_project_state", JSON.stringify({ profiles: [profile("a"), profile("b")], activeProfileId: null }));
    const { mockRepoRunnerAPI: api } = await import("../../src/mock/repoRunnerMock");

    expect((await api.loadProjectState()).activeProfileId).toBeNull();
    expect(await api.loadProject()).toBeNull();
  });

  it("only offers Retry; other recovery actions are refused", async () => {
    const { mockRepoRunnerAPI: api } = await import("../../src/mock/repoRunnerMock");
    await expect(api.resolveProjectStoreIssue("retry")).resolves.toMatchObject({ availableActions: ["retry"] });
    await expect(api.resolveProjectStoreIssue("start-fresh", null)).rejects.toThrow(
      PROJECT_STORE_ERROR_MESSAGES["recovery-not-available"],
    );
  });
});
