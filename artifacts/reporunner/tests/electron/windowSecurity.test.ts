// Window/session hardening: which URLs count as the app's own page, and that
// every restriction is wired onto a webContents and session.
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hardenSession, hardenWebContents, isAppPageUrl } from "../../electron/windowSecurity.js";

const realPlatform = process.platform;
afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform, configurable: true }));

const PROD = pathToFileURL("C:\\Program Files\\RepoRunner\\resources\\app.asar\\dist\\public\\index.html").href;
const DEV = "http://localhost:5173/";

describe("isAppPageUrl", () => {
  it.each([
    ["the packaged page itself", PROD, true],
    ["the packaged page with a fragment", `${PROD}#/setup`, true],
    ["the packaged page with a query", `${PROD}?x=1`, true],
    ["another file in the same folder", PROD.replace("index.html", "other.html"), false],
    ["a sibling directory with the same prefix", PROD.replace("public", "public-evil"), false],
    ["any other local file", "file:///C:/Windows/System32/drivers/etc/hosts", false],
    ["an https site", "https://example.com/", false],
    ["the dev server (not allowed in production)", DEV, false],
    ["javascript:", "javascript:alert(1)", false],
    ["data:", "data:text/html,<script>alert(1)</script>", false],
    ["about:blank", "about:blank", false],
    ["garbage", "not a url", false],
  ])("production: %s → %s", (_label, url, expected) => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(isAppPageUrl(url, PROD)).toBe(expected);
  });

  it("production on Windows: drive-letter case and percent-encoding don't matter", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(isAppPageUrl(PROD.replace("file:///C:", "file:///c:"), PROD)).toBe(true);
    expect(isAppPageUrl(PROD.replace("Program%20Files", "Program Files"), PROD)).toBe(true);
  });

  it.each([
    ["the dev page", DEV, true],
    ["the dev page without a trailing slash", "http://localhost:5173", true],
    ["a different port", "http://localhost:5174/", false],
    ["127.0.0.1 instead of localhost", "http://127.0.0.1:5173/", false],
    ["a lookalike host", "http://localhost:5173.evil.com/", false],
    ["credentials in the URL", "http://user:pw@localhost:5173/", false],
    ["https on the same host", "https://localhost:5173/", false],
    ["another path on the dev server", "http://localhost:5173/@fs/C:/secret", false],
    ["an https site", "https://example.com/", false],
  ])("development: %s → %s", (_label, url, expected) => {
    expect(isAppPageUrl(url, DEV)).toBe(expected);
  });
});

function fakeContents() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let windowOpenHandler: ((details: unknown) => unknown) | null = null;
  return {
    listeners,
    windowOpen: (details: unknown) => windowOpenHandler?.(details),
    contents: {
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      setWindowOpenHandler: (handler: (details: unknown) => unknown) => {
        windowOpenHandler = handler;
      },
    },
  };
}

const navigationEvent = (url?: string) => ({ url, preventDefault: vi.fn() });

describe("hardenWebContents", () => {
  it("denies every window.open", () => {
    const fake = fakeContents();
    hardenWebContents(fake.contents as never, PROD);

    for (const url of ["https://example.com", PROD, "about:blank"]) {
      expect(fake.windowOpen({ url })).toEqual({ action: "deny" });
    }
  });

  it.each(["will-navigate", "will-frame-navigate", "will-redirect"])("%s: blocks other URLs, allows the app page", (event) => {
    const fake = fakeContents();
    hardenWebContents(fake.contents as never, PROD);
    const handler = fake.listeners.get(event)!;
    expect(handler).toBeDefined();

    const external = navigationEvent("https://example.com/phish");
    handler(external);
    expect(external.preventDefault).toHaveBeenCalled();

    const own = navigationEvent(PROD);
    handler(own);
    expect(own.preventDefault).not.toHaveBeenCalled();
  });

  it("uses the legacy url argument when the event has no url", () => {
    const fake = fakeContents();
    hardenWebContents(fake.contents as never, PROD);
    const event = navigationEvent(undefined);

    fake.listeners.get("will-navigate")!(event, "https://example.com/");

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("a navigation with no URL at all is blocked", () => {
    const fake = fakeContents();
    hardenWebContents(fake.contents as never, PROD);
    const event = navigationEvent(undefined);

    fake.listeners.get("will-navigate")!(event);

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("blocks webview attachment", () => {
    const fake = fakeContents();
    hardenWebContents(fake.contents as never, PROD);
    const event = navigationEvent();

    fake.listeners.get("will-attach-webview")!(event, {}, {});

    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe("hardenSession", () => {
  it("denies all permission requests and checks", () => {
    let requestHandler: ((...args: unknown[]) => void) | null = null;
    let checkHandler: ((...args: unknown[]) => unknown) | null = null;
    hardenSession({
      setPermissionRequestHandler: (handler: never) => (requestHandler = handler),
      setPermissionCheckHandler: (handler: never) => (checkHandler = handler),
    } as never);

    for (const permission of ["media", "notifications", "clipboard-read", "clipboard-sanitized-write", "geolocation", "fullscreen"]) {
      const callback = vi.fn();
      requestHandler!({}, permission, callback, {});
      expect(callback).toHaveBeenCalledWith(false);
      expect(checkHandler!({}, permission, "file://", {})).toBe(false);
    }
  });
});
