// PR #76 Codex finding: a recognized build step says a build happens, not that
// the whole script only builds. "vite build && npm run launch" may start a
// server through launch, so it stays a Low run candidate; a script is
// build-only (and withheld) only when every segment is recognized.
import { describe, expect, it } from "vitest";
import { detectProjects } from "../../../src/lib/insights/detectProjects";
import { classifyScript, onlyBuilds } from "../../../src/lib/insights/frameworkRules";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../../src/lib/insights/types";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const viteApp = (scripts: Record<string, string>, extra: Partial<ScanOptions> = {}): ScanOptions => ({
  packages: [pkg("package.json", { deps: ["react"], dev: ["vite"], scripts })],
  files: ["package-lock.json", "vite.config.ts"],
  ...extra,
});
const nextApp = (scripts: Record<string, string>): ScanOptions => ({ packages: [pkg("package.json", { deps: ["next", "react"], scripts })], files: ["package-lock.json", "next.config.mjs"] });
const viteAndNext = (scripts: Record<string, string>): ScanOptions => ({
  packages: [pkg("package.json", { deps: ["next", "react"], dev: ["vite"], scripts })],
  files: ["package-lock.json", "vite.config.ts", "next.config.mjs"],
});
const runnability = (options: ScanOptions) => detectProjects(scan(options)).packages[0].runnability;
const runs = (options: ScanOptions) => suggestCommands(scan(options)).suggestions.filter((s) => s.source === "script");
const skipped = (options: ScanOptions) => suggestCommands(scan(options)).skipped;
const text = (s: CommandSuggestion) => [...s.evidence.map((e) => e.text), ...s.caveats.map((c) => c.text)].join(" ");
const evidenceText = (options: ScanOptions) => runnability(options).evidence.map((e) => e.text).join(" ");

/** Retained as a Low candidate by both runnability and suggestions, with no claim about servers. */
function expectLowCandidate(options: ScanOptions, name: string) {
  expect(runnability(options)).toMatchObject({ status: "has-run-script", runScripts: [name], buildOnlyScripts: [], confidence: "low" });
  const list = runs(options);
  expect(list.map((s) => [s.scriptName, s.command, s.confidence])).toEqual([[name, `npm run ${name}`, "low"]]);
  for (const t of [text(list[0]), evidenceText(options)]) {
    expect(t).not.toContain("doesn't start a server");
    expect(t).not.toMatch(/starts \S+'s (development|production) server/);
  }
}
/** Withheld as build-only by both, explained. */
function expectBuildOnly(options: ScanOptions, name: string) {
  expect(runnability(options)).toMatchObject({ status: "no-run-script", runScripts: [], buildOnlyScripts: [name] });
  expect(runs(options)).toEqual([]);
  expect(skipped(options)[0]).toMatchObject({ reason: "no-run-script", text: expect.stringContaining(`${name} only builds`) });
}

describe("classifier: build-only needs every segment recognized", () => {
  it.each<[string, boolean]>([
    ["vite build", true],
    ["vite build && vite build --mode staging", true],
    ["vite build && npm run launch", false],
    ["vite build && pnpm run launch", false],
    ["vite build && ./deploy.sh", false],
    ["prepare-assets && vite build", false],
    ["vite build && next build", false], // Next.js isn't detected here, so next build isn't recognized
    ["vite build && (launch)", false],
    ["vite build ||| launch", false],
    ["vite build &&", true], // an empty trailing segment isn't a command
  ])("%s -> build-only %s", (command, expected) => {
    const c = classifyScript(command, ["react-vite"]);
    expect(c.kind).toBe("build");
    expect(onlyBuilds(c)).toBe(expected);
    expect(c.unclassifiedSegments === true).toBe(!expected);
  });

  it("unrecognized segments never raise the strongest kind or name a tool", () => {
    expect(classifyScript("vite build && npm run launch", ["react-vite"])).toEqual({ kind: "build", frameworkId: "react-vite", tool: "vite", unclassifiedSegments: true });
    expect(classifyScript("npm run launch", ["react-vite"])).toEqual({ kind: null, frameworkId: null, tool: null, unclassifiedSegments: true });
    expect(classifyScript("vite build && vite", ["react-vite"])).toEqual({ kind: "develop", frameworkId: "react-vite", tool: "vite" });
  });
});

describe("runnability and suggestions agree", () => {
  it('start: "vite build && npm run launch" is kept at Low, with no server claim (Codex case)', () => {
    const options = viteApp({ start: "vite build && npm run launch", launch: "vite preview" });
    expectLowCandidate(options, "start");
    expect(evidenceText(options)).toContain("other commands RepoRunner doesn't classify, so whether it starts a server isn't known");
    expect(text(runs(options)[0])).toContain("whether it starts a server isn't known");
  });

  it.each([
    ["vite build", viteApp],
    ["next build", nextApp],
    ["vite build && vite build --mode staging", viteApp],
  ] as const)('dev: "%s" is still build-only and withheld', (command, make) => {
    expectBuildOnly(make({ dev: command }), "dev");
    expect(evidenceText(make({ dev: command }))).toContain("doesn't start a server");
  });

  it("vite build && next build: two recognized builds are build-only", () => {
    expectBuildOnly(viteAndNext({ dev: "vite build && next build" }), "dev");
    // Next.js is also identified from the script itself, so next build is recognized here too.
    expectBuildOnly(viteApp({ dev: "vite build && next build" }), "dev");
  });

  it.each(["vite build && ./deploy.sh", "prepare-assets && vite build", "vite build && pnpm run launch", "vite build && npm run launch", "vite build && (launch)"])(
    "%s is a Low candidate",
    (command) => expectLowCandidate(viteApp({ start: command }), "start"),
  );

  it("a known dev or production server next to a build is unchanged", () => {
    expect(runs(viteApp({ dev: "vite build && vite" }))[0].confidence).toBe("high");
    expect(runs(nextApp({ start: "next build && next start" }))[0].confidence).toBe("high");
    // ...and an unknown segment beside it doesn't raise or lower that.
    expect(runs(viteApp({ dev: "vite build && vite && npm run x" }))[0].confidence).toBe("high");
  });

  it("start with unknown operations only stays Low; nothing is invented for it", () => {
    expectLowCandidate(viteApp({ start: "custom-server --port 3000" }), "start");
  });

  it("quoted commands stay conservative: unclassified, Low, never build-only", () => {
    for (const command of ['vite build && npm run "launch"', 'vite build "x"']) {
      expect(runnability(viteApp({ start: command }))).toMatchObject({ runScripts: ["start"], buildOnlyScripts: [], confidence: "low" });
      expect(text(runs(viteApp({ start: command }))[0])).toContain("uses quotes or escapes");
    }
  });

  it("recognized unsupported framework invocations are still withheld", () => {
    const options = viteApp({ dev: "vite build && astro dev", start: "vite build && npm run launch" });
    expect(skipped(options)).toContainEqual(expect.objectContaining({ reason: "unsupported-framework", text: expect.stringContaining('Script "dev"') }));
    expect(runs(options).map((s) => [s.scriptName, s.confidence])).toEqual([["start", "low"]]);
  });

  it("incomplete scans: still Low and flagged; build-only still withheld", () => {
    for (const status of ["truncated", "cancelled", "timed-out"] as const) {
      const mixed = viteApp({ start: "vite build && npm run launch" }, { status });
      const [s] = runs(mixed);
      expect([s.confidence, s.scanIncomplete]).toEqual(["low", true]);
      expect(s.caveats.map((c) => c.code)).toContain("scan-incomplete");
      expect(runs(viteApp({ dev: "vite build" }, { status }))).toEqual([]);
    }
  });

  it("lifecycle-hook caveats and script-name integrity still apply", () => {
    const hooked = runs(viteApp({ start: "vite build && npm run launch", prestart: "echo hi" }))[0];
    expect(hooked.caveats.map((c) => c.code)).toContain("lifecycle-hooks");
    const scanned = scan(viteApp({ start: "vite build && npm run launch" }));
    scanned.packages[0].scripts[0] = { ...scanned.packages[0].scripts[0], nameExact: false };
    expect(suggestCommands(scanned).suggestions.filter((s) => s.source === "script")).toEqual([]);
  });

  it("nothing executed or mutated; deterministic; commands only from the template", () => {
    const result = deepFreeze(scan(viteApp({ start: "vite build && npm run launch", dev: "vite build" })));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(suggestCommands(result))).toBe(JSON.stringify(first));
    expect(JSON.stringify(detectProjects(result))).toBe(JSON.stringify(detectProjects(result)));
    expect(JSON.stringify(result)).toBe(before);
    expect(first.suggestions.filter((s) => s.source === "script").map((s) => s.command)).toEqual(["npm run start"]);
  });
});
