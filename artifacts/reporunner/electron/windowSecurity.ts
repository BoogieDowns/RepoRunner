import type { Session, WebContents } from "electron";

/*
 * Window and session hardening. RepoRunner shows only its own bundled page:
 * it never opens other windows, navigates elsewhere, embeds webviews or needs
 * browser permissions (clipboard and file dialogs go through the main
 * process). Everything outside that is refused.
 */

/**
 * True only for navigation to the app's own page: same scheme, host, port
 * and path as `appUrl` (query and fragment ignored). No prefix matching.
 */
export function isAppPageUrl(target: string, appUrl: string): boolean {
  let candidate: URL;
  let app: URL;
  try {
    candidate = new URL(target);
    app = new URL(appUrl);
  } catch {
    return false;
  }

  if (candidate.protocol !== app.protocol) return false;
  if (candidate.username || candidate.password) return false;
  if (candidate.host !== app.host) return false;

  if (app.protocol === "file:") {
    // Windows paths are case-insensitive and may be percent-encoded differently.
    const normalize = (pathname: string) => {
      const decoded = safeDecode(pathname);
      return process.platform === "win32" ? decoded.toLowerCase() : decoded;
    };
    return normalize(candidate.pathname) === normalize(app.pathname);
  }

  return candidate.pathname === app.pathname;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type NavigationEvent = { preventDefault(): void; url?: string };

/** Applies window-level restrictions to one webContents (every window, frame and future webContents). */
export function hardenWebContents(contents: WebContents, appUrl: string): void {
  // No renderer-opened windows of any kind.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));

  const guard = (event: NavigationEvent, url?: string) => {
    const target = event.url ?? url ?? "";
    if (!isAppPageUrl(target, appUrl)) event.preventDefault();
  };

  // Top-level, sub-frame and server-redirect navigations.
  contents.on("will-navigate", guard as never);
  contents.on("will-frame-navigate", guard as never);
  contents.on("will-redirect", guard as never);

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

/** Denies every permission request and permission check (camera, notifications, clipboard-read, ...). */
export function hardenSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
