// Production CSP content, the Vite plugin that writes it into index.html, and
// the removal of remote font loading.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_CSP,
  PRODUCTION_CSP_DIRECTIVES,
  contentSecurityPolicyPlugin,
  developmentCspDirectives,
  serializeCsp,
} from "../../scripts/contentSecurityPolicy.mjs";

const APP_DIR = path.resolve(import.meta.dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(APP_DIR, relative), "utf8");

type Tag = { tag: string; attrs: Record<string, string>; injectTo: string };
function runPlugin(command: "build" | "serve") {
  const plugin = contentSecurityPolicyPlugin({ devPort: 5173 }) as {
    configResolved(config: { command: string }): void;
    transformIndexHtml: { handler(html: string): { tags: Tag[] } };
  };
  plugin.configResolved({ command });
  return plugin.transformIndexHtml.handler("<html><head></head></html>").tags;
}

describe("production CSP", () => {
  it("denies everything by default and only allows the app's own scripts", () => {
    expect(PRODUCTION_CSP_DIRECTIVES["default-src"]).toEqual(["'none'"]);
    expect(PRODUCTION_CSP_DIRECTIVES["script-src"]).toEqual(["'self'"]);
  });

  it("allows no network connections, plugins, frames, workers or base/form tricks", () => {
    expect(PRODUCTION_CSP_DIRECTIVES["connect-src"]).toEqual(["'none'"]);
    for (const directive of ["object-src", "frame-src", "worker-src", "base-uri", "form-action", "media-src", "manifest-src"]) {
      expect(PRODUCTION_CSP_DIRECTIVES[directive as keyof typeof PRODUCTION_CSP_DIRECTIVES]).toEqual(["'none'"]);
    }
  });

  it("has no wildcards, remote hosts, eval or inline scripts", () => {
    expect(PRODUCTION_CSP).not.toMatch(/\*|https?:|wss?:|unsafe-eval|googleapis|gstatic/);
    expect(PRODUCTION_CSP_DIRECTIVES["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("is what the plugin writes into the production build's index.html, before any other tag", () => {
    const [tag] = runPlugin("build");
    expect(tag).toEqual({
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: PRODUCTION_CSP },
      injectTo: "head-prepend",
    });
  });

  it("development uses a separate policy that never reaches builds", () => {
    const [tag] = runPlugin("serve");
    const dev = serializeCsp(developmentCspDirectives(5173));
    expect(tag.attrs.content).toBe(dev);
    expect(dev).not.toBe(PRODUCTION_CSP);
    expect(dev).not.toMatch(/\*|https?:\/\/|unsafe-eval/);
    expect(developmentCspDirectives(5173)["connect-src"]).toEqual(["'self'", "ws://localhost:5173", "ws://127.0.0.1:5173"]);
  });
});

describe("no remote fonts", () => {
  it("index.html and index.css no longer reference Google Fonts", () => {
    for (const file of ["index.html", "src/index.css"]) {
      expect(read(file)).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
  });

  it("the stylesheet imports the bundled fonts", () => {
    expect(read("src/index.css")).toContain('@import "./assets/fonts/bundled/fonts.css";');
  });

  it("every bundled @font-face points at a local WOFF2 file that exists", () => {
    const css = read("src/assets/fonts/bundled/fonts.css");
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBe(10);
    for (const url of urls) {
      expect(url).toMatch(/^\.\/[a-z-]+\.woff2$/);
      const bytes = fs.readFileSync(path.join(APP_DIR, "src/assets/fonts/bundled", url));
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
    expect(css).toMatch(/font-family: 'Plus Jakarta Sans';[\s\S]*font-weight: 400 700;/);
    expect(css).toMatch(/font-family: 'JetBrains Mono';[\s\S]*font-weight: 400 500;/);
  });

  it("license texts are bundled with the fonts", () => {
    for (const license of ["PlusJakartaSans-OFL.txt", "JetBrainsMono-OFL.txt"]) {
      expect(read(`src/assets/fonts/bundled/${license}`)).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
    }
  });
});
