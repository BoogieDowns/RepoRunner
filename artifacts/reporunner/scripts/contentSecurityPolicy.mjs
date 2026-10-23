// Content-Security-Policy for the RepoRunner window.
//
// The production policy is written into the built dist/public/index.html,
// which Electron loads from file://. The renderer talks to the app only over
// IPC, so it needs no network access at all. Development (Vite dev server)
// gets a separate policy because Vite's dev client and React Refresh use
// inline scripts and a websocket; it is never used in builds.

const shared = {
  "default-src": ["'none'"],
  "img-src": ["'self'", "data:"],
  // Vite inlines very small assets (including tiny font subsets) as data: URLs.
  "font-src": ["'self'", "data:"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-src": ["'none'"],
  "worker-src": ["'none'"],
  "media-src": ["'none'"],
  "manifest-src": ["'none'"],
};

export const PRODUCTION_CSP_DIRECTIVES = {
  ...shared,
  "script-src": ["'self'"],
  // Radix UI (Select, Dialog, AlertDialog) injects <style> elements for
  // scroll locking, so inline styles must stay allowed. Scripts must not.
  "style-src": ["'self'", "'unsafe-inline'"],
  "connect-src": ["'none'"],
};

export function developmentCspDirectives(port) {
  return {
    ...shared,
    "script-src": ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "connect-src": ["'self'", `ws://localhost:${port}`, `ws://127.0.0.1:${port}`],
  };
}

export function serializeCsp(directives) {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export const PRODUCTION_CSP = serializeCsp(PRODUCTION_CSP_DIRECTIVES);

/** Vite plugin: prepends the CSP <meta> to index.html (production policy for builds). */
export function contentSecurityPolicyPlugin({ devPort }) {
  let isBuild = true;
  return {
    name: "reporunner-content-security-policy",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const policy = isBuild ? PRODUCTION_CSP : serializeCsp(developmentCspDirectives(devPort));
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: { "http-equiv": "Content-Security-Policy", content: policy },
              injectTo: "head-prepend",
            },
          ],
        };
      },
    },
  };
}
