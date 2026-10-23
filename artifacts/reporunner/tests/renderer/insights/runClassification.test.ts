// PR #76 Codex P2 regressions: run scripts are judged by what their command
// does (not by the tool's mere presence), and scripts that run an unsupported
// framework are never suggested, even in packages that also use a supported one.
import { describe, expect, it } from "vitest";
import { detectProjects } from "../../../src/lib/insights/detectProjects";
import { classifyScript } from "../../../src/lib/insights/frameworkRules";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { Confidence, FrameworkId } from "../../../src/lib/insights/types";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const rank = (c: Confidence | null) => (c === null ? -1 : { low: 0, medium: 1, high: 2 }[c]);
const runs = (options: ScanOptions) => suggestCommands(scan(options)).suggestions.filter((s) => s.source === "script");
const insight = (options: ScanOptions) => detectProjects(scan(options)).packages[0];
const vite = (scripts: Record<string, string>, extra: Parameters<typeof pkg>[1] = {}): ScanOptions => ({
  packages: [pkg("package.json", { deps: ["react"], dev: ["vite"], scripts, ...extra })],
  files: ["package-lock.json", "vite.config.ts"],
});
const next = (scripts: Record<string, string>): ScanOptions => ({
  packages: [pkg("package.json", { deps: ["next", "react"], scripts })],
  files: ["package-lock.json", "next.config.mjs"],
});

describe("classifyScript: explicit invocation tables", () => {
  it.each<[string, FrameworkId[], string | null]>([
    ["vite", ["react-vite"], "develop"],
    ["vite dev", ["react-vite"], "develop"],
    ["vite serve", ["react-vite"], "develop"],
    ["vite --port 3000", ["react-vite"], "develop"],
    ["vite preview", ["react-vite"], "preview"],
    ["vite build", ["react-vite"], "build"],
    ["vite optimize", ["react-vite"], "other"],
    ["next", ["nextjs"], "develop"],
    ["next dev", ["nextjs"], "develop"],
    ["next start", ["nextjs"], "start"],
    ["next build", ["nextjs"], "build"],
    ["next lint", ["nextjs"], "other"],
    ["ng serve", ["angular"], "develop"],
    ["ng build", ["angular"], "build"],
    ["nest start", ["nestjs"], "start"],
    ["nest start --watch", ["nestjs"], "develop"],
    ["nest build", ["nestjs"], "build"],
    ["fastify start -w app.js", ["fastify"], "develop"],
    ["nuxt dev", ["nuxt"], "develop"],
    ["nuxt build", ["nuxt"], "build"],
    ["astro preview", ["astro"], "preview"],
    ["remix vite:dev", ["remix"], "develop"],
    ["node server.js", [], "runner"],
    ["tsc && node dist/index.js", [], "runner"],
    ["vite build && vite preview", ["react-vite"], "preview"],
    ["dotenv -e .env -- vite", ["react-vite"], null], // unknown wrapper form: left unclassified
    ["sh -c \"vite\"", ["react-vite"], null],
    ["custom-dev-server", ["react-vite"], null],
  ])("%s -> %s", (command, frameworks, kind) => {
    expect(classifyScript(command, frameworks).kind).toBe(kind);
  });

  it("only the given frameworks' tables are consulted (no guessing)", () => {
    expect(classifyScript("next dev", ["react-vite"]).kind).toBeNull();
  });
});

describe("P2 #2: subcommands must match before confidence is raised", () => {
  it.each([
    ["vite build", vite],
    ["next build", next],
  ] as const)('dev: "%s" is not a run script, gets no suggestion, and is explained', (command, make) => {
    const options = make({ dev: command });
    const detected = insight(options);
    expect(detected.runnability).toMatchObject({ status: "no-run-script", runScripts: [], buildOnlyScripts: ["dev"] });
    expect(detected.runnability.evidence.map((e) => e.text).join(" ")).toMatch(/doesn't start a server/);
    expect(runs(options)).toEqual([]);
    const set = suggestCommands(scan(options));
    expect(set.skipped[0].text).toContain("dev only builds");
  });

  it("a build-only dev script doesn't hide a real start script", () => {
    const options = next({ dev: "next build", start: "next start" });
    expect(insight(options).runnability).toMatchObject({ runScripts: ["start"], buildOnlyScripts: ["dev"] });
    expect(runs(options).map((s) => [s.scriptName, s.confidence])).toEqual([["start", "high"]]);
  });

  it.each(["vite", "vite dev", "vite serve"])('legitimate dev: "%s" stays high', (command) => {
    const options = vite({ dev: command });
    expect(insight(options).runnability.confidence).toBe("high");
    expect(runs(options)[0]).toMatchObject({ command: "npm run dev", purpose: "develop", confidence: "high" });
  });

  it("legitimate next dev / next start stay high for their purposes", () => {
    const options = next({ dev: "next dev", start: "next start" });
    expect(runs(options).map((s) => [s.scriptName, s.purpose, s.confidence])).toEqual([
      ["dev", "develop", "high"],
      ["start", "start", "high"],
    ]);
  });

  it("preview stays low, whether by name or by command", () => {
    expect(runs(vite({ preview: "vite preview" }))[0].confidence).toBe("low");
    const dev = runs(vite({ dev: "vite preview" }))[0];
    expect(dev.confidence).toBe("low");
    expect(insight(vite({ dev: "vite preview" })).runnability.confidence).toBe("low");
  });

  it("script names don't override contradictory commands: a production server named dev is at most medium", () => {
    const [dev] = runs(next({ dev: "next start" }));
    expect(dev.purpose).toBe("develop");
    expect(dev.confidence).toBe("medium");
    expect(dev.evidence.map((e) => e.text).join(" ")).toMatch(/named for development, but its command starts a production server/);
    const [start] = runs(next({ start: "next dev" }));
    expect(start.confidence).toBe("medium");
  });

  it("an unclassified invocation or an unknown wrapper stays low", () => {
    expect(runs(vite({ dev: "vite optimize" }))[0].confidence).toBe("low");
    expect(runs(vite({ dev: "dotenv -e .env -- vite" }))[0].confidence).toBe("low");
    expect(insight(vite({ dev: "dotenv -e .env -- vite" })).runnability.confidence).toBe("low");
  });

  it("incomplete scans and truncated scripts still cap at medium", () => {
    for (const extra of [{ status: "truncated" as const, limitsHit: ["entries" as const] }, { status: "cancelled" as const }]) {
      for (const s of runs({ ...vite({ dev: "vite" }), ...extra })) expect(rank(s.confidence)).toBeLessThanOrEqual(1);
    }
    expect(runs(vite({ dev: "vite" }, { scriptsTruncated: true }))[0].confidence).toBe("medium");
  });
});

describe("P2 #1: unsupported-framework scripts are withheld per script", () => {
  const mixed = (scripts: Record<string, string>): ScanOptions => ({
    packages: [pkg("package.json", { deps: ["express", "nuxt"], scripts })],
    files: ["package-lock.json", "nuxt.config.ts"],
  });

  it('Express + Nuxt with dev: "nuxt dev": Nuxt recognized, its script not suggested, with a reason', () => {
    const options = mixed({ dev: "nuxt dev" });
    expect(insight(options).frameworks.map((f) => f.id).sort()).toEqual(["express", "nuxt"]);
    expect(runs(options)).toEqual([]);
    const set = suggestCommands(scan(options));
    expect(set.skipped).toContainEqual(expect.objectContaining({ reason: "unsupported-framework", text: expect.stringContaining('Script "dev" in package.json runs Nuxt') }));
  });

  it("supported scripts in the same package remain eligible", () => {
    const options = mixed({ dev: "nuxt dev", start: "node server.js" });
    expect(runs(options).map((s) => s.scriptName)).toEqual(["start"]);
  });

  it("an unsupported-only package is still skipped as a whole (unchanged)", () => {
    const set = suggestCommands(scan({ packages: [pkg("package.json", { deps: ["nuxt"], scripts: { dev: "nuxt dev", start: "node .output/server/index.mjs" } })], files: ["package-lock.json"] }));
    expect(set.suggestions.filter((s) => s.source === "script")).toEqual([]);
    expect(set.skipped[0].reason).toBe("unsupported-framework");
  });

  it("in a monorepo, only the affected package's script is withheld", () => {
    const set = suggestCommands(scan({
      packages: [
        pkg("package.json", { workspaces: ["apps/*"] }),
        pkg("apps/site/package.json", { deps: ["express", "astro"], scripts: { dev: "astro dev" } }),
        pkg("apps/web/package.json", { deps: ["react"], dev: ["vite"], scripts: { dev: "vite" } }),
      ],
      files: ["pnpm-lock.yaml"],
    }));
    expect(set.suggestions.filter((s) => s.source === "script").map((s) => s.directory)).toEqual(["apps/web"]);
    expect(set.skipped.map((s) => s.reason)).toContain("unsupported-framework");
  });
});

describe("no invention, no side effects", () => {
  it("never invents scripts or commands; inputs untouched; deterministic", () => {
    const options = next({ dev: "next build", start: "next start", lint: "next lint" });
    const result = deepFreeze(scan(options));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(suggestCommands(result)).toEqual(first);
    for (const s of first.suggestions) {
      if (s.scriptName) expect(Object.keys({ dev: 1, start: 1, lint: 1 })).toContain(s.scriptName);
      if (s.command) expect(s.command).toMatch(/^(npm run (dev|start)|npm install)$/);
    }
  });
});

describe("preview: the command decides, the name informs", () => {
  it("a script named preview that actually starts the dev server is judged by its command (medium: name/command mismatch)", () => {
    const options = vite({ preview: "vite" });
    expect(insight(options).runnability.confidence).toBe("high"); // it starts the dev server
    const [s] = runs(options);
    expect(s.purpose).toBe("start");
    expect(s.confidence).toBe("medium");
    expect(s.caveats.map((c) => c.code)).toContain("preview-serves-build");
  });

  it("a dev script that only previews a build is low and carries the preview caveat", () => {
    const [s] = runs(vite({ dev: "vite preview" }));
    expect(s.confidence).toBe("low");
    expect(s.caveats.map((c) => c.code)).toContain("preview-serves-build");
  });
});
