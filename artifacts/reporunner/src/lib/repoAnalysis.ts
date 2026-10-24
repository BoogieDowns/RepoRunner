// Renderer-side state for "Analyze Repo". Pure TypeScript (no React, no
// window access of its own) so the async rules can be tested directly:
//  - one analysis call outstanding per page; a new one waits for the last to
//    settle, so the main process never sees two from this page;
//  - every call has a request id, and only the latest id may set results;
//  - changing the path, cancelling or unmounting invalidates the old request;
//  - cancel is only sent while this page's own request is outstanding.
import {
  REPO_ANALYSIS_ERROR_MESSAGES,
  type RepoAnalysisErrorCode,
  type RepoRunnerAPI,
  type RepoScanResult,
} from "../types";

export type AnalysisApi = Pick<RepoRunnerAPI, "analyzeRepo" | "cancelRepoAnalysis">;

/** Analysis error codes plus the renderer's own "no IPC" case. */
export type AnalysisFailureCode = RepoAnalysisErrorCode | "ipc-unavailable";

export type RepoAnalysisState =
  | { phase: "idle" }
  | { phase: "running"; path: string; cancelling: boolean }
  /** `id` is new for every completed analysis, even of the same path; it names this exact `result`. */
  | { phase: "done"; path: string; result: RepoScanResult; id: string }
  | { phase: "error"; path: string; code: AnalysisFailureCode; message: string };

export const IPC_UNAVAILABLE_MESSAGE = "Repository analysis isn't available in this window.";

export function analysisFailureMessage(code: AnalysisFailureCode): string {
  return code === "ipc-unavailable" ? IPC_UNAVAILABLE_MESSAGE : REPO_ANALYSIS_ERROR_MESSAGES[code];
}

/**
 * Maps an error that crossed IPC to its fixed code by the exact message text
 * (Electron prefixes "Error invoking remote method ..."). Anything else is
 * "failed": raw messages are never shown.
 */
export function classifyAnalysisError(error: unknown): RepoAnalysisErrorCode {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  for (const [code, text] of Object.entries(REPO_ANALYSIS_ERROR_MESSAGES) as Array<[RepoAnalysisErrorCode, string]>) {
    if (message === text || message.endsWith(`: ${text}`)) return code;
  }
  return "failed";
}

/** The one outstanding analysis call from this page (shared by all controllers). */
export interface AnalysisCoordinator {
  active: { owner: object; settled: Promise<void> } | null;
}

export const pageAnalysisCoordinator: AnalysisCoordinator = { active: null };

export interface RepoAnalysisController {
  readonly state: RepoAnalysisState;
  /** Starts an analysis of `path` (trimmed). Ignored while one is running. */
  start(path: string): Promise<void>;
  /** Asks the main process to stop this page's running analysis. */
  cancel(): void;
  /** The path field changed: results or a running scan for another path are dropped. */
  pathChanged(path: string): void;
  /** Unmount: cancel our own running analysis and stop reporting. */
  dispose(): void;
}

export function canStartAnalysis(path: string, state: RepoAnalysisState): boolean {
  return path.trim().length > 0 && state.phase !== "running";
}

export function createRepoAnalysisController(
  getApi: () => AnalysisApi | undefined,
  onChange: (state: RepoAnalysisState) => void,
  coordinator: AnalysisCoordinator = pageAnalysisCoordinator,
): RepoAnalysisController {
  let state: RepoAnalysisState = { phase: "idle" };
  let currentRequest = 0;
  let disposed = false;
  // Set while this controller's call is the page's outstanding call.
  const owner = {};

  const set = (next: RepoAnalysisState) => {
    state = next;
    if (!disposed) onChange(next);
  };

  const ownsOutstandingCall = () => coordinator.active?.owner === owner;

  const sendCancel = () => {
    if (!ownsOutstandingCall()) return;
    const api = getApi();
    void api?.cancelRepoAnalysis?.().catch(() => {});
  };

  /** Invalidates the current request; its result will be ignored. */
  const invalidate = (cancelRunning: boolean) => {
    const wasRunning = state.phase === "running";
    currentRequest++;
    if (wasRunning && cancelRunning) sendCancel();
  };

  return {
    get state() {
      return state;
    },

    async start(rawPath: string) {
      if (disposed || state.phase === "running") return;
      const path = rawPath.trim();
      if (!path) return;

      const api = getApi();
      if (!api || typeof api.analyzeRepo !== "function") {
        set({ phase: "error", path, code: "ipc-unavailable", message: IPC_UNAVAILABLE_MESSAGE });
        return;
      }

      const request = ++currentRequest;
      set({ phase: "running", path, cancelling: false });

      // Wait for any earlier call from this page (for example one just
      // cancelled by a path change) so it can't be mistaken for ours.
      while (coordinator.active) {
        await coordinator.active.settled;
        if (request !== currentRequest) return;
      }

      let settle!: () => void;
      const settled = new Promise<void>((resolve) => (settle = resolve));
      coordinator.active = { owner, settled };

      try {
        const result = await api.analyzeRepo(path);
        if (request === currentRequest) set({ phase: "done", path, result, id: globalThis.crypto.randomUUID() });
      } catch (error) {
        if (request === currentRequest) {
          const code = classifyAnalysisError(error);
          set({ phase: "error", path, code, message: analysisFailureMessage(code) });
        }
      } finally {
        if (coordinator.active?.owner === owner) coordinator.active = null;
        settle();
      }
    },

    cancel() {
      if (state.phase !== "running" || state.cancelling) return;
      if (!ownsOutstandingCall()) {
        // Still waiting for an earlier call to settle: ours was never sent.
        currentRequest++;
        set({ phase: "idle" });
        return;
      }
      set({ ...state, cancelling: true });
      // The call itself resolves with status "cancelled" and is shown as such.
      sendCancel();
    },

    pathChanged(rawPath: string) {
      if (state.phase === "idle") return;
      if (state.path === rawPath.trim()) return;
      invalidate(true);
      set({ phase: "idle" });
    },

    dispose() {
      if (disposed) return;
      invalidate(true);
      disposed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers (plain data; the panel renders them as text).

export const MAX_DEPENDENCIES_SHOWN = 24;

export type NoticeTone = "ok" | "partial" | "stopped";

export interface StatusSummary {
  tone: NoticeTone;
  title: string;
  /** Short plain-language notes about anything incomplete. */
  notes: string[];
}

const LIMIT_NOTES: Record<RepoScanResult["limitsHit"][number], string> = {
  depth: "Folders nested deeper than 8 levels were not inspected.",
  entries: "Results limited for a large repository (file count).",
  directories: "Results limited for a large repository (folder count).",
  manifests: "Only the first 200 package.json files were read.",
  bytes: "Some manifests were not read because of the size budget.",
  time: "The 10-second time limit was reached.",
  "result-size": "Some details were left out to keep the results small.",
};

export const UNANALYZED_NOTE = "Some files or folders could not be analyzed";
export const WORKSPACE_PATTERNS_NOTE = "Not all workspace patterns are listed.";
export const PACKAGE_DETAILS_NOTE = "Some packages have more scripts or dependencies than are listed.";

export function summarizeStatus(result: RepoScanResult): StatusSummary {
  const notes: string[] = [];
  for (const limit of result.limitsHit) {
    if (limit === "time" && result.status === "timed-out") continue;
    notes.push(LIMIT_NOTES[limit]);
  }
  if (result.manifestsTruncated || result.packagesTruncated || result.envFilesTruncated || result.warningsTruncated) {
    if (!result.limitsHit.includes("result-size")) notes.push("Some lists were shortened.");
  }
  if (result.workspace.patternsTruncated || result.packages.some((pkg) => pkg.workspacesTruncated)) {
    notes.push(WORKSPACE_PATTERNS_NOTE);
  }
  if (result.packages.some((pkg) => pkg.scriptsTruncated || pkg.dependenciesTruncated)) {
    notes.push(PACKAGE_DETAILS_NOTE);
  }
  const skipped = result.skipped;
  const unanalyzed = skipped.unreadable + skipped.oversized + skipped.changedDuringScan;
  if (unanalyzed > 0) notes.push(`${UNANALYZED_NOTE} (${unanalyzed}).`);
  if (skipped.links > 0) notes.push(`${skipped.links} linked ${skipped.links === 1 ? "folder or file was" : "folders or files were"} not followed.`);

  switch (result.status) {
    case "complete":
      return { tone: "ok", title: "Analysis complete", notes };
    case "truncated":
      return { tone: "partial", title: "Partial results", notes };
    case "cancelled":
      return { tone: "stopped", title: "Analysis cancelled", notes: ["Results are incomplete.", ...notes] };
    case "timed-out":
      return { tone: "stopped", title: "Analysis timed out", notes: ["Results are incomplete.", ...notes] };
  }
}

const WARNING_TEXT: Record<RepoScanResult["warnings"][number]["code"], string> = {
  "manifest-malformed": "package.json is not valid JSON",
  "manifest-not-object": "package.json does not contain an object",
  "manifest-oversized": "package.json is too large to read",
  "manifest-unreadable": "package.json could not be read",
  "manifest-limit-reached": "package.json limit reached; later files skipped",
  "byte-budget-exhausted": "read budget used up; file skipped",
  "directory-unreadable": "folder could not be read",
  "entry-unreadable": "could not be inspected",
  "changed-during-scan": "changed during analysis; skipped",
  "node-version-unrecognized": "Node version file not recognized",
};

export function warningText(code: RepoScanResult["warnings"][number]["code"]): string {
  return WARNING_TEXT[code];
}

export function packageManagerSummary(result: RepoScanResult): string | null {
  const managers = [...new Set(result.packageManager.lockfiles.map((lock) => lock.manager))];
  const parts: string[] = [];
  if (result.packageManager.declared) parts.push(`declared ${result.packageManager.declared}`);
  if (managers.length > 0) parts.push(`lockfile: ${managers.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
