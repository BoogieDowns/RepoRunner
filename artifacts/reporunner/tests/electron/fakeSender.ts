// Minimal stand-ins for Electron's BrowserWindow, webContents and WebFrameMain,
// with the properties the IPC sender check reads (see electron/ipcTrust.ts).
import { EventEmitter } from "node:events";
import type { TrustedRenderer } from "../../electron/ipcTrust.js";

export const PACKAGED_URL = "file:///C:/Program%20Files/RepoRunner/resources/app.asar/dist/public/index.html";
export const DEV_URL = "http://localhost:5173/";

export class FakeFrame {
  detached = false;
  parent: FakeFrame | null = null;
  constructor(public url: string, public processId = 4, public routingId = 1) {}
}

export class FakeContents extends EventEmitter {
  destroyed = false;
  mainFrame: FakeFrame;
  constructor(public url: string, processId = 4, routingId = 1) {
    super();
    this.mainFrame = new FakeFrame(url, processId, routingId);
  }
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return this.url;
  }
}

export class FakeWindow {
  destroyed = false;
  constructor(public webContents: FakeContents) {}
  isDestroyed() {
    return this.destroyed;
  }
}

/** RepoRunner's main window showing `appUrl`, the trust built from it, and its legitimate event. */
export function trustedRenderer(appUrl = PACKAGED_URL) {
  const contents = new FakeContents(appUrl);
  const window: { current: FakeWindow | null } = { current: new FakeWindow(contents) };
  const trust: TrustedRenderer = { getMainWindow: () => window.current as never, appPageUrl: () => appUrl };
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  return { contents, window, trust, event };
}
