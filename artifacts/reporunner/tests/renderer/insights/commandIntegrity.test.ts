// PR #76 Codex finding: display cleaning can change what a script command
// says ("vite build\nvite preview" shows as one command, "vite build vite
// preview"), so the scanner reports whether the shown command is exactly the
// package.json value (commandExact), and Stage 2 analyzes only exact commands.
// An altered one is never build-only, never a server claim, never High or
// Medium, and never an unsupported-framework match: it stays a Low, explained
// candidate when its name is usable.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePackageJson } from "../../../electron/repoScanner/parseManifests.js";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { TEXT_LIMITS } from "../../../electron/repoScanner/scanRules.js";
import { RepoAnalysisPanel } from "../../../src/components/RepoAnalysisPanel";
import { RepoSuggestedSetup } from "../../../src/components/RepoSuggestedSetup";
import { detectProjects } from "../../../src/lib/insights/detectProjects";
import { classifyPackageScript } from "../../../src/lib/insights/frameworkRules";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../../src/lib/insights/types";
import type { PackageSummary, RepoScanResult } from "../../../src/types";
import { FixtureSpace, pkg as filePkg } from "../../electron/repoScanner/fixtures.js";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const ZWSP = String.fromCodePoint(0x200b);
const CANARY = "CANARY-CMD-INTEGRITY-71d3";
/** The scripts the real manifest parser reports for a package.json. */
function parsed(manifest: Record<string, unknown>): PackageSummary {
  const out = parsePackageJson(new TextEncoder().encode(JSON.stringify(manifest)), "package.json");
  if (!out.ok) throw new Error(out.warning);
  return out.summary;
}
const scriptsOf = (scripts: Record<string, unknown>) => parsed({ name: "x", scripts }).scripts;
/** A Vite app whose scripts come from the real parser. */
const viteFrom = (scripts: Record<string, string>): ScanOptions => ({
  packages: [{ ...parsed({ name: "web", scripts, dependencies: { react: "18" }, devDependencies: { vite: "5" } }) }],
  files: ["package-lock.json", "vite.config.ts"],
});
const runs = (options: ScanOptions | RepoScanResult) => suggestCommands("manifests" in options ? options : scan(options)).suggestions.filter((s) => s.source === "script");
const runnability = (options: ScanOptions) => detectProjects(scan(options)).packages[0].runnability;
const text = (s: CommandSuggestion) => [...s.evidence.map((e) => e.text), ...s.caveats.map((c) => c.text)].join(" ");
const codes = (s: CommandSuggestion) => s.caveats.map((c) => c.code);

/** Kept as a Low, explained, unverified candidate in both runnability and suggestions. */
function expectAlteredCandidate(options: ScanOptions, name: string) {
  const r = runnability(options);
  expect(r).toMatchObject({ status: "has-run-script", runScripts: [name], buildOnlyScripts: [], confidence: "low" });
  expect(r.uncertainties).toContain("script-commands-altered");
  const list = runs(options);
  expect(list.map((s) => [s.scriptName, s.command, s.confidence, s.scriptCommandExact])).toEqual([[name, `npm run ${name}`, "low", false]]);
  expect(codes(list[0])).toContain("script-command-altered");
  expect(text(list[0])).toContain("changed or shortened for display");
  for (const t of [text(list[0]), r.evidence.map((e) => e.text).join(" ")]) {
    expect(t).not.toContain("doesn't start a server");
    expect(t).not.toMatch(/starts \S+'s (development|production) server/);
  }
}

describe("scanner: commandExact", () => {
  it.each<[string, string, string, boolean]>([
    ["ordinary single-line command", "vite", "vite", true],
    ["several commands on one line", "vite build && vite preview", "vite build && vite preview", true],
    ["empty command", "", "", true],
    ["newline between commands", "vite build\nvite preview", "vite build vite preview", false],
    ["CRLF between commands", "vite build\r\nvite preview", "vite build vite preview", false],
    ["tab", "vite\t--host", "vite --host", false],
    ["repeated spaces", "vite  --host", "vite --host", false],
    ["leading or trailing whitespace", " vite ", "vite", false],
    ["removed control character", "vite\u0007 dev", "vite dev", false],
    ["removed invisible character", `vi${ZWSP}te`, "vite", false],
    ["direction override", "vite \u202Eved", "vite ved", false],
  ])("%s", (_, command, shown, exact) => {
    expect(scriptsOf({ dev: command })).toEqual([{ name: "dev", nameExact: true, command: shown, commandExact: exact }]);
  });

  it("a command cut at the length limit is not exact", () => {
    const long = `vite build && ${"x".repeat(TEXT_LIMITS.scriptCommand)} && vite preview`;
    const [script] = scriptsOf({ start: long });
    expect(script.commandExact).toBe(false);
    expect(Array.from(script.command).length).toBe(TEXT_LIMITS.scriptCommand);
    expect(script.command.endsWith("…")).toBe(true);
    const fits = "y".repeat(TEXT_LIMITS.scriptCommand);
    expect(scriptsOf({ start: fits })[0].commandExact).toBe(true);
  });

  it("non-string script values are still skipped; the original text is never included", () => {
    expect(scriptsOf({ a: 7, b: null, c: ["vite"], d: { x: 1 } })).toEqual([]);
    const raw = `vite build\n${CANARY}${ZWSP}\r\nvite preview`;
    const json = JSON.stringify(scriptsOf({ start: raw }));
    expect(json).not.toContain("\\n");
    expect(json).not.toContain("\\r");
    expect(json).not.toContain(ZWSP);
    expect(Object.keys(JSON.parse(json)[0]).sort()).toEqual(["command", "commandExact", "name", "nameExact"]);
  });

  it("names and commands are checked independently", () => {
    expect(scriptsOf({ dev: "vite" })[0]).toMatchObject({ nameExact: true, commandExact: true });
    expect(scriptsOf({ [`dev${ZWSP}`]: "vite" })[0]).toMatchObject({ name: "dev", nameExact: false, commandExact: true });
    expect(scriptsOf({ dev: "vite\nvite preview" })[0]).toMatchObject({ nameExact: true, commandExact: false });
    expect(scriptsOf({ [` dev${ZWSP}`]: "vite\n" })[0]).toMatchObject({ name: "dev", nameExact: false, commandExact: false });
  });
});

describe("Stage 2: altered commands are not evidence of what runs", () => {
  it('Codex case: start: "vite build\\nvite preview" is kept at Low, not withheld as build-only', () => {
    const options = viteFrom({ start: "vite build\nvite preview" });
    expectAlteredCandidate(options, "start");
    expect(runs(options)[0].scriptCommandText).toBe("vite build vite preview");
  });

  it("a build followed by an unknown command, unrelated commands, CRLF: all Low and explained", () => {
    expectAlteredCandidate(viteFrom({ start: "vite build\n./deploy.sh" }), "start");
    expectAlteredCandidate(viteFrom({ dev: "echo hi\nvite" }), "dev");
    expectAlteredCandidate(viteFrom({ dev: "vite build\r\nvite" }), "dev");
  });

  it("an altered command that looks like a dev server gets no High or Medium and no server claim", () => {
    for (const command of ["vite  --host", " vite", `vite${ZWSP}`, "vite\t--host", "vite\n"]) expectAlteredCandidate(viteFrom({ dev: command }), "dev");
  });

  it("a shortened command is treated the same", () => {
    expectAlteredCandidate(viteFrom({ start: `vite build && ${"x".repeat(TEXT_LIMITS.scriptCommand)} && vite preview` }), "start");
  });

  it("missing integrity metadata is unverified, not exact", () => {
    const options = viteFrom({ dev: "vite" });
    const { commandExact: _, ...withoutFlag } = options.packages![0].scripts[0];
    options.packages![0].scripts[0] = withoutFlag as never;
    expectAlteredCandidate(options, "dev");
    expect(classifyPackageScript({ command: "vite" }, ["react-vite"])).toEqual({ kind: null, frameworkId: null, tool: null, commandAltered: true });
  });

  it("exact commands keep their current behavior", () => {
    expect(runs(viteFrom({ dev: "vite" }))[0]).toMatchObject({ confidence: "high", scriptCommandExact: true });
    expect(codes(runs(viteFrom({ dev: "vite" }))[0])).not.toContain("script-command-altered");
    expect(runnability(viteFrom({ dev: "vite build" }))).toMatchObject({ status: "no-run-script", buildOnlyScripts: ["dev"] });
    expect(runnability(viteFrom({ start: "vite build && npm run launch" }))).toMatchObject({ runScripts: ["start"], confidence: "low" });
    expect(runs(viteFrom({ dev: 'echo "ready && vite"' }))[0].confidence).toBe("low");
    expect(text(runs(viteFrom({ dev: 'echo "ready && vite"' }))[0])).toContain("uses quotes or escapes");
  });

  it("script-name integrity still applies: an altered name gives no command, whatever its command", () => {
    for (const command of ["vite", "vite\nvite preview"]) {
      expect(runs(viteFrom({ [`dev${ZWSP}`]: command }))).toEqual([]);
    }
    // An exact name with an altered command is still a candidate (covered above); both altered: nothing.
    expect(runs(viteFrom({ [`dev${ZWSP}`]: "vite\n" }))).toEqual([]);
  });

  it("frameworks still come from dependencies and config files, not from altered text", () => {
    const exact = detectProjects(scan(viteFrom({ dev: "vite" }))).packages[0].frameworks.map((f) => [f.id, f.confidence]);
    const altered = detectProjects(scan(viteFrom({ dev: "vite\n" }))).packages[0].frameworks.map((f) => [f.id, f.confidence]);
    expect(altered).toEqual(exact);
    // A framework only an altered script mentions isn't identified from it.
    const astroOnly = detectProjects(scan({ packages: [parsed({ name: "x", scripts: { dev: "astro dev\n" }, dependencies: { express: "4" } })], files: ["package-lock.json"] }));
    expect(astroOnly.packages[0].frameworks.map((f) => f.id)).toEqual(["express"]);
  });

  it("unsupported-framework restrictions: exact invocations withheld; altered text doesn't trigger them", () => {
    const astro = (dev: string): ScanOptions => ({ packages: [parsed({ name: "x", scripts: { dev, start: "node server.js" }, dependencies: { express: "4" } })], files: ["package-lock.json"] });
    expect(suggestCommands(scan(astro("astro dev"))).skipped.map((s) => s.reason)).toContain("unsupported-framework");
    const altered = suggestCommands(scan(astro("astro\ndev")));
    expect(altered.skipped.map((s) => s.reason)).not.toContain("unsupported-framework");
    expect(altered.suggestions.filter((s) => s.source === "script").map((s) => [s.scriptName, s.confidence])).toEqual([["dev", "low"], ["start", "medium"]]);
  });

  it("orchestration isn't read from an altered root script", () => {
    const orchestration = (dev: string) => detectProjects(scan({ packages: [parsed({ name: "top", private: true, workspaces: ["apps/*"], scripts: { dev } })], files: ["package-lock.json"] })).orchestration.map((o) => o.tool);
    expect(orchestration("turbo run dev")).toEqual(["turbo"]);
    expect(orchestration("turbo run\ndev")).toEqual([]);
  });

  it("incomplete scans: altered candidates stay Low and flagged", () => {
    for (const status of ["truncated", "cancelled", "timed-out"] as const) {
      const [s] = runs({ ...viteFrom({ start: "vite build\nvite preview" }), status });
      expect([s.confidence, s.scanIncomplete]).toEqual(["low", true]);
      expect(codes(s)).toEqual(expect.arrayContaining(["scan-incomplete", "script-command-altered"]));
    }
  });

  it("nothing executed or mutated; deterministic; commands only from the template", () => {
    const result = deepFreeze(scan(viteFrom({ start: "vite build\nvite preview", dev: "vite" })));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(suggestCommands(result))).toBe(JSON.stringify(first));
    expect(JSON.stringify(detectProjects(result))).toBe(JSON.stringify(detectProjects(result)));
    expect(JSON.stringify(result)).toBe(before);
    expect(first.suggestions.filter((s) => s.source === "script").map((s) => s.command).sort()).toEqual(["npm run dev", "npm run start"]);
  });
});

describe("display: an altered command is never shown as an exact copy", () => {
  it("Suggested Setup labels it; exact commands keep 'The script runs:'", () => {
    const flat = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    const altered = flat(renderToStaticMarkup(createElement(RepoSuggestedSetup, { result: scan(viteFrom({ start: "vite build\nvite preview" })) })));
    expect(altered).toContain("The script's command, changed for display (not an exact copy): vite build vite preview");
    expect(altered).not.toContain("The script runs: vite build vite preview");
    expect(flat(renderToStaticMarkup(createElement(RepoSuggestedSetup, { result: scan(viteFrom({ dev: "vite" })) })))).toContain("The script runs: vite");
  });

  it("the analysis panel marks altered commands only", () => {
    const result = scan(viteFrom({ start: "vite build\nvite preview", dev: "vite" }));
    const html = renderToStaticMarkup(createElement(RepoAnalysisPanel, { state: { phase: "done", path: "C:\\repo", result }, onCancel: () => {} }));
    expect(html.match(/data-testid="script-command-altered"/g)).toHaveLength(1);
  });
});

describe("end to end: real scanner, result fitting and suggestion engine", () => {
  let space: FixtureSpace;
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());

  it("a multi-line start script stays a Low candidate; no raw text leaks; fitting keeps the flag", async () => {
    const root = space.repo("command integrity", {
      "package.json": filePkg({ name: "web", scripts: { start: `vite build\n${CANARY}\nvite preview`, dev: "vite" }, dependencies: { react: "18" }, devDependencies: { vite: "5" } }),
      "package-lock.json": "{}",
      "vite.config.ts": "export default {}",
    });
    const result = await scanRepository(root);
    expect(result.packages[0].scripts).toEqual([
      { name: "start", nameExact: true, command: `vite build ${CANARY} vite preview`, commandExact: false },
      { name: "dev", nameExact: true, command: "vite", commandExact: true },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/\\n|\\r/);
    const list = runs(result);
    expect(list.map((s) => [s.scriptName, s.confidence])).toEqual([["dev", "high"], ["start", "low"]]);
    // Result-size fitting trims dependency lists and packages, never script integrity.
    const full = JSON.stringify(result).length;
    const fitted = await scanRepository(root, { limits: { maxResultBytes: full - 40 } });
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(full - 40);
    for (const p of fitted.packages) for (const s of p.scripts) expect(typeof s.commandExact).toBe("boolean");
    expect(fitted.packages[0].scripts.find((s) => s.name === "start")?.commandExact).toBe(false);
  });
});
