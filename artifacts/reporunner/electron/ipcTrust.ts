import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { isAppPageUrl } from "./windowSecurity.js";

/*
 * Who may call RepoRunner's IPC handlers: only RepoRunner's own page, in the
 * main window's top-level frame. Every handler checks this before doing
 * anything, so a call from any other window, frame or page is refused before
 * it can read, save, run, stop or open anything.
 */

/** How the main process identifies its legitimate renderer. */
export interface TrustedRenderer {
  getMainWindow(): BrowserWindow | null;
  /** Exact URL of the app page (dev server or packaged index.html). */
  appPageUrl(): string;
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

/** The one message every refused call gets: it says nothing about paths, setups or state. */
export const UNTRUSTED_SENDER_MESSAGE = "This request isn't allowed from this page.";

export function untrustedSenderError(): Error {
  return new Error(UNTRUSTED_SENDER_MESSAGE);
}
