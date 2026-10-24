// Analyze Repo state rules, with a fake API whose calls the tests resolve by
// hand: request identity, stale results, cancellation, unmount and errors.
import { describe, expect, it, vi } from "vitest";
import {
  IPC_UNAVAILABLE_MESSAGE,
  canStartAnalysis,
  classifyAnalysisError,
  createRepoAnalysisController,
  type AnalysisCoordinator,
  type RepoAnalysisState,
} from "../../src/lib/repoAnalysis";
import { REPO_ANALYSIS_ERROR_MESSAGES, type RepoRunnerAPI, type RepoScanResult } from "../../src/types";

function result(overrides: Partial<RepoScanResult> = {}): RepoScanResult {
  return {
    status: "complete",
    partial: false,
    limitsHit: [],
    rootName: "app",
    stats: { directoriesVisited: 1, entriesExamined: 1, filesRead: 1, bytesRead: 10, durationMs: 1 },
    manifests: [],
    manifestsTruncated: false,
    packages: [],
    packagesTruncated: false,
    nodeVersionFiles: [],
    workspace: { signals: [], patterns: [], patternsTruncated: false },
    packageManager: { lockfiles: [], declared: null },
    envFiles: [],
    envFilesTruncated: false,
    skipped: { links: 0, excludedDirectories: 0, sensitiveFiles: 0, depthLimited: 0, unreadable: 0, oversized: 0, otherTypes: 0, changedDuringScan: 0 },
    warnings: [],
    warningsTruncated: false,
    ...overrides,
  };
}

const remote = (text: string) => new Error(`Error invoking remote method 'analyze-repo': Error: ${text}`);

/** A full fake API: analysis calls are resolved by hand; every other method is a spy. */
function fakeApi() {
  const calls: Array<{ path: string; resolve(r: RepoScanResult): void; reject(e: unknown): void }> = [];
  const others = Object.fromEntries(
    ["saveProject", "setActiveProject", "deleteProject", "runInstall", "startFrontend", "startBackend", "restartAll", "pullLatest", "stopServices", "openPreview", "resolveProjectStoreIssue"].map((name) => [name, vi.fn()]),
  );
  const api = {
    ...others,
    analyzeRepo: vi.fn(
      (path: string) =>
        new Promise<RepoScanResult>((resolve, reject) => {
          calls.push({ path, resolve, reject });
        }),
    ),
    cancelRepoAnalysis: vi.fn(async () => {}),
  };
  return { api: api as unknown as RepoRunnerAPI & typeof api, calls, others };
}

function setup(apiOverride?: unknown, coordinator: AnalysisCoordinator = { active: null }) {
  const fake = fakeApi();
  const states: RepoAnalysisState[] = [];
  const api = apiOverride === undefined ? fake.api : apiOverride;
  const controller = createRepoAnalysisController(() => api as never, (s) => states.push(s), coordinator);
  return { ...fake, controller, states, coordinator };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("availability", () => {
  it("Analyze needs a non-empty path and no running analysis", () => {
    expect(canStartAnalysis("", { phase: "idle" })).toBe(false);
    expect(canStartAnalysis("   ", { phase: "idle" })).toBe(false);
    expect(canStartAnalysis("C:\\repo", { phase: "idle" })).toBe(true);
    expect(canStartAnalysis("C:\\repo", { phase: "running", path: "C:\\repo", cancelling: false })).toBe(false);
    expect(canStartAnalysis("C:\\repo", { phase: "done", path: "C:\\repo", result: result() })).toBe(true);
    expect(canStartAnalysis("C:\\repo", { phase: "error", path: "C:\\repo", code: "failed", message: "" })).toBe(true);
  });
});

describe("a normal analysis", () => {
  it("calls analyzeRepo with the trimmed path, shows loading, then the result", async () => {
    const { controller, api, calls, states } = setup();
    const done = controller.start("  C:\\Projects\\my app  ");
    expect(api.analyzeRepo).toHaveBeenCalledWith("C:\\Projects\\my app");
    expect(controller.state).toEqual({ phase: "running", path: "C:\\Projects\\my app", cancelling: false });

    const r = result({ rootName: "my app" });
    calls[0].resolve(r);
    await done;
    expect(controller.state).toEqual({ phase: "done", path: "C:\\Projects\\my app", result: r, id: expect.any(String) });
    expect(states.map((s) => s.phase)).toEqual(["running", "done"]);
  });

  it("ignores empty paths and a second start while running", async () => {
    const { controller, api, calls } = setup();
    await controller.start("   ");
    expect(api.analyzeRepo).not.toHaveBeenCalled();
    const first = controller.start("C:\\a");
    await controller.start("C:\\a");
    expect(api.analyzeRepo).toHaveBeenCalledTimes(1);
    calls[0].resolve(result());
    await first;
  });

  it("keeps a timed-out or truncated result marked as such", async () => {
    const { controller, calls } = setup();
    const done = controller.start("C:\\big");
    calls[0].resolve(result({ status: "timed-out", partial: true, limitsHit: ["time"] }));
    await done;
    expect(controller.state.phase === "done" && controller.state.result.status).toBe("timed-out");
  });

  it("never calls save, install, start, run or any other action", async () => {
    const { controller, calls, others, api } = setup();
    const done = controller.start("C:\\repo");
    calls[0].resolve(result());
    await done;
    controller.cancel();
    controller.pathChanged("C:\\other");
    controller.dispose();
    for (const spy of Object.values(others)) expect(spy).not.toHaveBeenCalled();
    expect(api.cancelRepoAnalysis).not.toHaveBeenCalled(); // nothing was running
  });
});

describe("cancellation", () => {
  it("sends one cancel and shows the call's own cancelled result", async () => {
    const { controller, api, calls } = setup();
    const done = controller.start("C:\\repo");
    controller.cancel();
    controller.cancel();
    expect(api.cancelRepoAnalysis).toHaveBeenCalledTimes(1);
    expect(controller.state).toMatchObject({ phase: "running", cancelling: true });
    calls[0].resolve(result({ status: "cancelled", partial: true }));
    await done;
    expect(controller.state).toMatchObject({ phase: "done", result: { status: "cancelled", partial: true } });
  });

  it("a cancel before the call is sent (queued behind an earlier one) sends nothing", async () => {
    const coordinator: AnalysisCoordinator = { active: null };
    const a = setup(undefined, coordinator);
    const b = setup(a.api, coordinator);
    const first = a.controller.start("C:\\a");
    const queued = b.controller.start("C:\\b");
    b.controller.cancel();
    expect(b.controller.state).toEqual({ phase: "idle" });
    expect(a.api.cancelRepoAnalysis).not.toHaveBeenCalled(); // would have stopped A's scan
    a.calls[0].resolve(result());
    await first;
    await queued;
    expect(a.api.analyzeRepo).toHaveBeenCalledTimes(1); // B never sent its call
  });
});

describe("stale results", () => {
  it("changing the path during a scan cancels it and drops its late result", async () => {
    const { controller, api, calls, states } = setup();
    const old = controller.start("C:\\old");
    controller.pathChanged("C:\\new");
    expect(api.cancelRepoAnalysis).toHaveBeenCalledTimes(1);
    expect(controller.state).toEqual({ phase: "idle" });

    calls[0].resolve(result({ rootName: "old" }));
    await old;
    expect(controller.state).toEqual({ phase: "idle" });
    expect(states.some((s) => s.phase === "done")).toBe(false);
  });

  it("a new analysis waits for the invalidated call to settle, then only its own result is shown", async () => {
    const { controller, api, calls } = setup();
    const old = controller.start("C:\\old");
    controller.pathChanged("C:\\new");
    const fresh = controller.start("C:\\new");
    await flush();
    expect(api.analyzeRepo).toHaveBeenCalledTimes(1); // not sent until the old call settles
    expect(controller.state).toMatchObject({ phase: "running", path: "C:\\new" });

    calls[0].resolve(result({ rootName: "old", status: "cancelled", partial: true }));
    await old;
    await flush();
    expect(api.analyzeRepo).toHaveBeenCalledTimes(2);
    expect(calls[1].path).toBe("C:\\new");
    calls[1].resolve(result({ rootName: "new" }));
    await fresh;
    expect(controller.state).toMatchObject({ phase: "done", path: "C:\\new", result: { rootName: "new" } });
  });

  it("a late error from an invalidated call is ignored too", async () => {
    const { controller, calls } = setup();
    const old = controller.start("C:\\old");
    controller.pathChanged("C:\\other");
    calls[0].reject(remote(REPO_ANALYSIS_ERROR_MESSAGES.unreadable));
    await old;
    expect(controller.state).toEqual({ phase: "idle" });
  });

  it("results stay while the path is unchanged (whitespace aside) and are cleared when it changes", async () => {
    const { controller, calls } = setup();
    const done = controller.start("C:\\repo");
    calls[0].resolve(result());
    await done;
    controller.pathChanged("C:\\repo  ");
    expect(controller.state.phase).toBe("done");
    controller.pathChanged("C:\\repo2");
    expect(controller.state).toEqual({ phase: "idle" });
  });
});

describe("unmount", () => {
  it("cancels this page's running analysis and reports nothing afterwards", async () => {
    const { controller, api, calls, states } = setup();
    const done = controller.start("C:\\repo");
    const reported = states.length;
    controller.dispose();
    expect(api.cancelRepoAnalysis).toHaveBeenCalledTimes(1);
    calls[0].resolve(result({ status: "cancelled", partial: true }));
    await done;
    expect(states.length).toBe(reported);
  });

  it("does not cancel a scan that belongs to another controller", async () => {
    const coordinator: AnalysisCoordinator = { active: null };
    const a = setup(undefined, coordinator);
    const b = setup(a.api, coordinator);
    const first = a.controller.start("C:\\a");
    a.calls[0].resolve(result());
    await first;
    const second = b.controller.start("C:\\b");
    a.controller.dispose(); // A is finished: must not stop B
    expect(a.api.cancelRepoAnalysis).not.toHaveBeenCalled();
    a.calls[1].resolve(result());
    await second;
    expect(b.controller.state.phase).toBe("done");
  });

  it("a controller unmounted while queued neither sends its call nor cancels the running one", async () => {
    const coordinator: AnalysisCoordinator = { active: null };
    const a = setup(undefined, coordinator);
    const b = setup(a.api, coordinator);
    const first = a.controller.start("C:\\a");
    const queued = b.controller.start("C:\\b");
    b.controller.dispose();
    expect(a.api.cancelRepoAnalysis).not.toHaveBeenCalled();
    a.calls[0].resolve(result());
    await first;
    await queued;
    expect(a.api.analyzeRepo).toHaveBeenCalledTimes(1);
    expect(coordinator.active).toBeNull();
  });
});

describe("errors use the fixed contract", () => {
  it.each(Object.entries(REPO_ANALYSIS_ERROR_MESSAGES))("maps %s from its exact IPC message", async (code, text) => {
    const { controller, calls } = setup();
    const done = controller.start("C:\\repo");
    calls[0].reject(remote(text));
    await done;
    expect(controller.state).toEqual({ phase: "error", path: "C:\\repo", code, message: text });
  });

  it("the busy message tells the user a previous analysis may still be finishing", () => {
    expect(REPO_ANALYSIS_ERROR_MESSAGES["scan-in-progress"]).toMatch(/still running or finishing/);
  });

  it("an unexpected error shows the generic message, never its raw text", async () => {
    const { controller, calls } = setup();
    const done = controller.start("C:\\repo");
    calls[0].reject(new Error("EACCES: permission denied, open 'C:\\Users\\me\\secret.txt'\n    at Object.open (node:fs)"));
    await done;
    expect(controller.state).toMatchObject({ phase: "error", code: "failed", message: REPO_ANALYSIS_ERROR_MESSAGES.failed });
    expect(JSON.stringify(controller.state)).not.toMatch(/EACCES|secret|node:fs/);
  });

  it("does not match a message that merely contains a fixed text", () => {
    expect(classifyAnalysisError(new Error(`${REPO_ANALYSIS_ERROR_MESSAGES["not-found"]} C:\\leak`))).toBe("failed");
    expect(classifyAnalysisError("not an error")).toBe("failed");
    expect(classifyAnalysisError(undefined)).toBe("failed");
  });

  it("IPC unavailable", async () => {
    for (const api of [null, {}, { analyzeRepo: "nope" }]) {
      const { controller } = setup(api);
      await controller.start("C:\\repo");
      expect(controller.state).toEqual({ phase: "error", path: "C:\\repo", code: "ipc-unavailable", message: IPC_UNAVAILABLE_MESSAGE });
    }
  });
});
