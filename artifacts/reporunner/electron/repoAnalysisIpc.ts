import { ipcMain } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import { RepoScanSession } from "./repoScanner/scanSession.js";
import { RepoScanError, type RepoScanResult } from "./repoScanner/types.js";
import { isAppPageUrl } from "./windowSecurity.js";
import { REPO_ANALYSIS_ERROR_MESSAGES, type RepoAnalysisErrorCode } from "../src/types.js";

/*
 * IPC for the read-only repository scanner: "analyze-repo" and
 * "cancel-repo-analysis". Only RepoRunner's own page, in the main window's
 * top-level frame, may call them. The scanner keeps its own root validation
 * and limits; nothing here runs commands or saves anything.
 */

/** How the main process identifies its legitimate renderer. */
export interface TrustedRenderer {
  getMainWindow(): BrowserWindow | null;
  /** Exact URL of the app page (dev server or packaged index.html). */
  appPageUrl(): string;
}

const MAX_REPO_PATH_LENGTH = 4096;

function analysisError(code: RepoAnalysisErrorCode): Error {
  return new Error(REPO_ANALYSIS_ERROR_MESSAGES[code]);
}

/**
 * True only for a call from the main window's own webContents, from its
 * top-level frame, showing the app page. Every value comes from the main
 * process (the event and the window), never from renderer arguments.
 */
export function isTrustedSender(event: IpcMainInvokeEvent, trust: TrustedRenderer | undefined): boolean {
  if (!trust) return false;
  try {
    const window = trust.getMainWindow();
    if (!window || window.isDestroyed()) return false;
    const contents = window.webContents;
    const sender = event.sender;
    if (!sender || sender !== contents || sender.isDestroyed()) return false;

    const frame = event.senderFrame;
    const mainFrame = contents.mainFrame;
    if (!frame || !mainFrame || frame.detached || frame.parent !== null) return false;
    if (frame.processId !== mainFrame.processId || frame.routingId !== mainFrame.routingId) return false;

    const appUrl = trust.appPageUrl();
    return isAppPageUrl(frame.url, appUrl) && isAppPageUrl(sender.getURL(), appUrl);
  } catch {
    // A destroyed frame or window throws on access: not trusted.
    return false;
  }
}

/** Value-free error for anything the scan throws. */
function toAnalysisError(error: unknown): Error {
  return analysisError(error instanceof RepoScanError ? error.code : "failed");
}

/**
 * One analysis at a time, owned by the webContents that started it. The scan
 * is aborted when that webContents is destroyed, its renderer crashes, or its
 * page reloads or navigates, and when RepoRunner quits. Ownership ends only
 * when the scan has finished.
 */
export class RepoAnalysisService {
  private readonly session = new RepoScanSession();
  private owner: { contents: WebContents } | null = null;
  private closed = false;

  get isScanning(): boolean {
    return this.session.isScanning;
  }

  async analyze(sender: WebContents, repoPath: string): Promise<RepoScanResult> {
    if (this.closed) throw analysisError("unavailable");
    if (this.session.isScanning) throw analysisError("scan-in-progress");

    const owner = { contents: sender };
    let aborted = false;
    const abort = () => {
      if (aborted || this.owner !== owner) return;
      aborted = true;
      this.session.cancel();
    };
    // The page that asked is going away: a reload or main-frame navigation
    // (reloads never pass through will-navigate). Same-document changes such
    // as a hash update keep the page, and sub-frames are not the caller.
    // Anything not clearly one of those is treated as a navigation.
    const onNavigation = (details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (details?.isMainFrame === false || details?.isSameDocument === true) return;
      abort();
    };
    const lifecycle: Array<[string, (...args: never[]) => void]> = [
      ["destroyed", abort],
      ["render-process-gone", abort],
      ["did-start-navigation", onNavigation],
    ];

    this.owner = owner;
    for (const [event, listener] of lifecycle) sender.on(event as "destroyed", listener);
    try {
      // scan() claims the session synchronously, before its first await.
      return await this.session.scan(repoPath);
    } catch (error) {
      throw toAnalysisError(error);
    } finally {
      for (const [event, listener] of lifecycle) sender.removeListener(event as "destroyed", listener);
      if (this.owner === owner) this.owner = null;
    }
  }

  /** Cancels the active scan if `sender` owns it; no scan is a no-op. */
  cancel(sender: WebContents): void {
    const owner = this.owner;
    if (!owner) return;
    if (owner.contents !== sender) throw analysisError("not-allowed");
    this.session.cancel();
  }

  /** Quit: abort active work and refuse new scans. */
  shutdown(): void {
    this.closed = true;
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
