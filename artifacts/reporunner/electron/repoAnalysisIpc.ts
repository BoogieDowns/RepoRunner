import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { cancelledBeforeStartResult } from "./repoScanner/scanRepository.js";
import { RepoScanSession } from "./repoScanner/scanSession.js";
import { RepoScanError, type RepoScanResult } from "./repoScanner/types.js";
import { isTrustedSender, type TrustedRenderer } from "./ipcTrust.js";
import { REPO_ANALYSIS_ERROR_MESSAGES, type RepoAnalysisErrorCode } from "../src/types.js";

/*
 * IPC for the read-only repository scanner: "analyze-repo" and
 * "cancel-repo-analysis". Only RepoRunner's own page, in the main window's
 * top-level frame, may call them. The scanner keeps its own root validation
 * and limits; nothing here runs commands or saves anything.
 */

// The sender check is shared with every other handler (see ipcTrust.ts).
export { isTrustedSender, type TrustedRenderer };

const MAX_REPO_PATH_LENGTH = 4096;
/** How long a new request waits for a cancelled or timed-out scan to finish its last filesystem call. */
const FINISHING_WAIT_MS = 2000;

function analysisError(code: RepoAnalysisErrorCode): Error {
  return new Error(REPO_ANALYSIS_ERROR_MESSAGES[code]);
}

/** Value-free error for anything the scan throws. */
function toAnalysisError(error: unknown): Error {
  return analysisError(error instanceof RepoScanError ? error.code : "failed");
}

/**
 * One analysis request at a time, owned by the webContents that made it.
 *
 * A request is "pending" while it waits (at most FINISHING_WAIT_MS) for a
 * cancelled or timed-out scan to finish its last filesystem call, then
 * "active" once it owns the scan session. It is registered, with its
 * lifecycle listeners, before any waiting, so Cancel, a renderer crash or
 * destroy, a reload or main-frame navigation, and quitting all reach it:
 * a pending request is abandoned and never starts a scan; an active one
 * aborts its scan. Session ownership itself ends only when the scan's work
 * has finished.
 */
interface AnalysisRequest {
  contents: WebContents;
  phase: "pending" | "active";
  cancelled: boolean;
  /** Ends a pending wait early (and clears its timer). */
  stopWaiting: AbortController;
}

export class RepoAnalysisService {
  private readonly session = new RepoScanSession();
  private request: AnalysisRequest | null = null;
  private closed = false;

  get isScanning(): boolean {
    return this.session.isScanning;
  }

  /** A request is waiting for a finishing scan. */
  get hasPendingRequest(): boolean {
    return this.request?.phase === "pending";
  }

  async analyze(sender: WebContents, repoPath: string): Promise<RepoScanResult> {
    if (this.closed) throw analysisError("unavailable");
    // Another request (pending or active), or a scan that hasn't answered yet.
    if (this.request || (this.session.isScanning && !this.session.isFinishing)) {
      throw analysisError("scan-in-progress");
    }

    const request: AnalysisRequest = { contents: sender, phase: "pending", cancelled: false, stopWaiting: new AbortController() };
    const abandon = () => this.abandon(request);
    // The page that asked is going away: a reload or main-frame navigation
    // (reloads never pass through will-navigate). Same-document changes such
    // as a hash update keep the page, and sub-frames are not the caller.
    // Anything not clearly one of those is treated as a navigation.
    const onNavigation = (details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (details?.isMainFrame === false || details?.isSameDocument === true) return;
      abandon();
    };
    const lifecycle: Array<[string, (...args: never[]) => void]> = [
      ["destroyed", abandon],
      ["render-process-gone", abandon],
      ["did-start-navigation", onNavigation],
    ];

    this.request = request;
    for (const [event, listener] of lifecycle) sender.on(event as "destroyed", listener);
    try {
      if (this.session.isScanning) {
        // A scan that already answered (cancelled or timed out) may still be
        // finishing a filesystem call; wait briefly instead of refusing.
        const idle = await this.session.waitUntilIdle(FINISHING_WAIT_MS, request.stopWaiting.signal);
        if (this.closed) throw analysisError("unavailable");
        if (request.cancelled) return cancelledBeforeStartResult(repoPath);
        if (!idle || this.session.isScanning) throw analysisError("scan-in-progress");
      }

      // Pending -> active with no await in between: a cancel either landed
      // before (handled above; nothing starts) or lands after (aborts the scan).
      request.phase = "active";
      try {
        // scan() claims the session synchronously, before its first await.
        return await this.session.scan(repoPath);
      } catch (error) {
        throw toAnalysisError(error);
      }
    } finally {
      for (const [event, listener] of lifecycle) sender.removeListener(event as "destroyed", listener);
      request.stopWaiting.abort();
      if (this.request === request) this.request = null;
    }
  }

  /** Abandons `request` once: a pending one never starts; an active one aborts its scan. */
  private abandon(request: AnalysisRequest): void {
    if (this.request !== request || request.cancelled) return;
    request.cancelled = true;
    if (request.phase === "active") this.session.cancel();
    else request.stopWaiting.abort();
  }

  /** Cancels the request (pending or active) if `sender` made it; none is a no-op. */
  cancel(sender: WebContents): void {
    const request = this.request;
    if (!request) return;
    if (request.contents !== sender) throw analysisError("not-allowed");
    this.abandon(request);
  }

  /** Quit: abandon any request, abort active work and refuse new scans. */
  shutdown(): void {
    this.closed = true;
    if (this.request) this.abandon(this.request);
    this.session.cancel();
  }
}

const repoAnalysis = new RepoAnalysisService();

/** Called when RepoRunner starts quitting. */
export function shutdownRepoAnalysis(): void {
  repoAnalysis.shutdown();
}

/** Registers both handlers. Without `trust`, every call is refused. */
export function registerRepoAnalysisIpc(
  trust: TrustedRenderer | undefined,
  service: RepoAnalysisService = repoAnalysis,
): void {
  ipcMain.handle("analyze-repo", async (event, ...args: unknown[]) => {
    if (!isTrustedSender(event, trust)) throw analysisError("not-allowed");
    if (args.length !== 1) throw analysisError("invalid-request");
    const [repoPath] = args;
    if (typeof repoPath !== "string" || repoPath.length === 0 || repoPath.length > MAX_REPO_PATH_LENGTH) {
      throw analysisError("invalid-path");
    }
    return service.analyze(event.sender, repoPath);
  });

  ipcMain.handle("cancel-repo-analysis", async (event, ...args: unknown[]) => {
    if (!isTrustedSender(event, trust)) throw analysisError("not-allowed");
    if (args.length !== 0) throw analysisError("invalid-request");
    service.cancel(event.sender);
  });
}
