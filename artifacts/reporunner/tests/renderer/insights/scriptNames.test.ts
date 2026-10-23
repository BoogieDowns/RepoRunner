// PR #76 Codex finding: the scanner cleans script names for display, so a
// displayed name isn't necessarily the real one ("dev​" is shown as "dev"),
// and different scripts can be displayed alike. Only an exact, unique name is
// ever put into a command.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePackageJson } from "../../../electron/repoScanner/parseManifests.js";
import { fitResultSize, scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { detectProjects } from "../../../src/lib/insights/detectProjects";
import { invocableScripts, scriptNameProblem } from "../../../src/lib/insights/scriptNames";
import { isSafeScriptName, suggestCommands } from "../../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../../src/lib/insights/types";
import type { PackageSummary, RepoScanLimit, RepoScanResult } from "../../../src/types";
import { FixtureSpace, pkg as filePkg } from "../../electron/repoScanner/fixtures.js";
import { deepFreeze, pkg, scan, type ScanOptions } from "./builders";

const cp = (n: number) => String.fromCodePoint(n);
const ZWSP = cp(0x200b);

/** A package summary from the real manifest parser. */
function parsed(manifest: Record<string, unknown>, path = "package.json"): PackageSummary {
  const out = parsePackageJson(new TextEncoder().encode(JSON.stringify(manifest)), path);
  if (!out.ok) throw new Error(out.warning);
  return out.summary;
}
const repo = (scripts: Record<string, string>, extra: Partial<ScanOptions> = {}, manifest: Record<string, unknown> = {}): RepoScanResult =>
  scan({ packages: [parsed({ name: "app", scripts, dependencies: { express: "4" }, ...manifest })], files: ["package-lock.json"], ...extra });

const runs = (result: RepoScanResult) => suggestCommands(result).suggestions.filter((s) => s.source === "script");
const commands = (list: CommandSuggestion[]) => list.map((s) => s.command);
const skips = (result: RepoScanResult) => suggestCommands(result).skipped;
const runnability = (result: RepoScanResult) => detectProjects(result).packages[0].runnability;

describe("scanner: script-name integrity metadata", () => {
  it.each<[string, string, boolean]>([
    ["1. ordinary name", "dev", true],
    ["2. zero-width character removed", `dev${ZWSP}`, false],
    ["6. leading whitespace trimmed", " dev", false],
    ["6. trailing whitespace trimmed", "dev ", false],
    ["6. inner whitespace collapsed", "my  dev", false],
    ["7. control character removed", `dev${cp(0x07)}`, false],
    ["7. bidi override removed", `${cp(0x202e)}dev`, false],
    ["7. newline turned into a space", "dev\nx", false],
    ["8. longer than the name limit (shortened)", "d".repeat(201), false],
    ["8. exactly at the name limit", "d".repeat(200), true],
    ["9. shell metacharacters kept as they are", "dev;rm -rf /", true],
  ])("%s", (_label, raw, exact) => {
    const [script] = parsed({ scripts: { [raw]: "vite" } }).scripts;
    expect(script.nameExact).toBe(exact);
    if (exact) expect(script.name).toBe(raw);
    else expect(script.name).not.toBe(raw);
  });

  it("2. the raw name is never exposed, only the cleaned one", () => {
    const summary = parsed({ scripts: { [`dev${ZWSP}`]: "vite" } });
    expect(summary.scripts).toEqual([{ name: "dev", nameExact: false, command: "vite" }]);
    expect(JSON.stringify(summary)).not.toContain(ZWSP);
  });

  it("5. distinct keys that clean to the same name are all listed, and only the exact one is marked exact", () => {
    const summary = parsed({ scripts: { dev: "vite", [`dev${ZWSP}`]: "node evil.js", " dev": "x", [`d${ZWSP}ev`]: "y" } });
    expect(summary.scripts.map((s) => [s.name, s.nameExact])).toEqual([
      ["dev", true],
      ["dev", false],
      ["dev", false],
      ["dev", false],
    ]);
  });

  it("12. the script-count limit is unchanged", () => {
    const scripts = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`s${i}`, "x"]));
    const summary = parsed({ scripts });
    expect([summary.scripts.length, summary.scriptsTruncated]).toEqual([100, true]);
    expect(summary.scripts.every((s) => s.nameExact)).toBe(true);
  });

  it("13. result-size trimming drops whole packages and keeps the metadata of the rest", () => {
    const packages = Array.from({ length: 30 }, (_, i) => parsed({ name: `p${i}`, scripts: { dev: "vite", [`start${ZWSP}`]: "node x" } }, `p${i}/package.json`));
    const result = scan({ packages });
    const limits = new Set<RepoScanLimit>();
    fitResultSize(result, JSON.stringify(result).length / 2, limits);
    expect(limits.has("result-size")).toBe(true);
    expect(result.packages.length).toBeLessThan(30);
    for (const p of result.packages) expect(p.scripts.map((s) => [s.name, s.nameExact])).toEqual([["dev", true], ["start", false]]);
  });
});

describe("suggestions: only exact, unique script names are used in commands", () => {
  it("1. an ordinary dev script is suggested as before", () => {
    const result = repo({ dev: "nodemon server.js", start: "node server.js" });
    expect(commands(runs(result))).toEqual(["npm run dev", "npm run start"]);
    // Same conclusions as a summary built without any names in question.
    const baseline = scan({ packages: [pkg("package.json", { name: "app", deps: ["express"], scripts: { dev: "nodemon server.js", start: "node server.js" } })], files: ["package-lock.json"] });
    expect(runnability(result)).toEqual(runnability(baseline));
    expect(runs(result).map((s) => [s.command, s.confidence])).toEqual(runs(baseline).map((s) => [s.command, s.confidence]));
  });

  it("3. a changed name alone: no command, no claim that the package has no run script, an explanation instead", () => {
    const result = repo({ [`dev${ZWSP}`]: "nodemon server.js" });
    expect(runs(result)).toEqual([]);
    const r = runnability(result);
    expect([r.status, r.confidence, r.runScripts]).toEqual(["unknown", null, []]);
    expect(r.uncertainties).toContain("script-names-unusable");
    expect(r.evidence.map((e) => e.text).join(" ")).not.toContain("defines no");
    const skip = skips(result).find((s) => s.reason === "script-name-unusable")!;
    expect(skip.text).toContain(`Script "dev" in package.json isn't suggested: its name in package.json has characters that were removed or shortened for display`);
    expect(skips(result).some((s) => s.reason === "no-run-script")).toBe(false);
  });

  it("4. both \"dev\" and \"dev\\u200b\": ambiguous, so no command, and neither body is attributed to the other", () => {
    const result = repo({ dev: "nodemon server.js", [`dev${ZWSP}`]: "node evil.js" });
    expect(runs(result)).toEqual([]);
    expect(skips(result).find((s) => s.reason === "script-name-unusable")!.text).toContain('more than one script is shown as "dev"');
    const r = runnability(result);
    expect(r.status).toBe("unknown");
    expect(JSON.stringify(r.evidence)).not.toMatch(/nodemon|evil/);
    // The order of the keys doesn't change that.
    expect(runs(repo({ [`dev${ZWSP}`]: "node evil.js", dev: "nodemon server.js" }))).toEqual([]);
  });

  it("4b. an ambiguous name doesn't hide a different, exact run script", () => {
    const result = repo({ dev: "nodemon server.js", [`dev${ZWSP}`]: "node evil.js", start: "node server.js" });
    expect(commands(runs(result))).toEqual(["npm run start"]);
    expect(runs(result)[0].evidence.map((e) => e.text).join(" ")).not.toContain("evil");
    expect(runnability(result).uncertainties).toContain("script-names-unusable");
  });

  it("5/6/7. every kind of change and collision withholds the command", () => {
    for (const raw of [" dev", "dev ", `dev${cp(0x07)}`, `${cp(0x202e)}dev`, `de${ZWSP}v`]) {
      expect(runs(repo({ [raw]: "nodemon server.js" })), JSON.stringify(raw)).toEqual([]);
    }
    expect(runs(repo({ " start": "node a.js", "start ": "node b.js" }))).toEqual([]);
  });

  it("8. a shortened long name never becomes a command", () => {
    const result = repo({ [`start:dev${"x".repeat(300)}`]: "node server.js" });
    expect(runs(result)).toEqual([]);
  });

  it("9/11. shell metacharacters: exact but outside the allowlist, so still no command", () => {
    expect(isSafeScriptName("dev")).toBe(true);
    expect(isSafeScriptName("start:dev")).toBe(true);
    expect(isSafeScriptName("dev;rm")).toBe(false);
    expect(isSafeScriptName(`dev${ZWSP}`)).toBe(false);
    const result = scan({ packages: [parsed({ scripts: { "dev:all;rm -rf ~": "turbo run dev" } })], files: ["package-lock.json", "turbo.json"] });
    const unsafe = runs(result);
    expect(unsafe.map((s) => [s.command, s.unavailableReason])).toEqual([[null, "unsafe-script-name"]]);
  });

  it("10. missing metadata is treated as a changed name, never as known-good", () => {
    const summary = parsed({ scripts: { dev: "nodemon server.js" } });
    const legacy = { ...summary, scripts: summary.scripts.map(({ name, command }) => ({ name, command })) } as unknown as PackageSummary;
    expect(scriptNameProblem(legacy, legacy.scripts[0])).toBe("altered");
    expect(invocableScripts(legacy)).toEqual([]);
    expect(runs(scan({ packages: [legacy], files: ["package-lock.json"] }))).toEqual([]);
  });

  it("orchestration: a root script with a changed name isn't used either", () => {
    const result = scan({
      packages: [parsed({ private: true, workspaces: ["apps/*"], scripts: { [`dev${ZWSP}`]: "turbo run dev" } })],
      files: ["package-lock.json", "turbo.json"],
    });
    expect(commands(runs(result))).not.toContain("npm run dev");
    expect(skips(result).some((s) => s.reason === "script-name-unusable")).toBe(true);
  });

  it("12. truncated script lists keep their own explanation beside the name problem", () => {
    const scripts: Record<string, string> = { [`dev${ZWSP}`]: "nodemon server.js" };
    for (let i = 0; i < 120; i++) scripts[`s${i}`] = "x";
    const result = repo(scripts);
    expect(runs(result)).toEqual([]);
    expect(skips(result).map((s) => s.reason).sort()).toEqual(["script-name-unusable", "scripts-truncated"]);
  });

  it.each<[string, Partial<ScanOptions>]>([
    ["partial", { status: "truncated", limitsHit: ["entries"] }],
    ["cancelled", { status: "cancelled" }],
    ["timed out", { status: "timed-out" }],
  ])("14. %s scans: still no command for a changed name; exact names are capped as before", (_label, options) => {
    expect(runs(repo({ [`dev${ZWSP}`]: "nodemon server.js" }, options))).toEqual([]);
    const exact = runs(repo({ dev: "nodemon server.js" }, options));
    expect(commands(exact)).toEqual(["npm run dev"]);
    expect(exact[0].confidence).not.toBe("high");
  });

  it("15/16. no invented commands and no misleading confidence across hostile names", () => {
    const hostile = [
      { [`dev${ZWSP}`]: "vite" },
      { dev: "vite", [`dev${ZWSP}`]: "vite build" },
      { [`start${cp(0x202e)}`]: "node server.js", [`serve${cp(0x07)}`]: "serve" },
      { [`preview `]: "vite preview" },
    ];
    for (const scripts of hostile) {
      const result = scan({ packages: [parsed({ scripts, dependencies: { react: "18" }, devDependencies: { vite: "5" } })], files: ["package-lock.json", "vite.config.ts"] });
      const exactNames = new Set(invocableScripts(result.packages[0]).map((s) => s.name));
      for (const s of runs(result)) expect(s.command === null || exactNames.has(s.command.replace(/^npm run /, "")), s.command ?? "").toBe(true);
      expect(runs(result)).toEqual([]);
      const insight = detectProjects(result).packages[0];
      expect(insight.runnability.status).not.toBe("has-run-script");
      expect(insight.runnability.confidence).toBeNull();
      expect(insight.appKind).not.toBe("node-app");
    }
  });

  it("17. pure: input untouched and deterministic", () => {
    const result = deepFreeze(repo({ dev: "nodemon server.js", [`dev${ZWSP}`]: "node evil.js", start: "node server.js" }));
    const before = JSON.stringify(result);
    const first = suggestCommands(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(suggestCommands(result)).toEqual(first);
  });
});

describe("end to end: real scanner and suggestion engine", () => {
  let space: FixtureSpace;
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());

  it("Codex case: only \"dev\\u200b\": \"vite\" gives no npm run dev; an ordinary repository is unchanged", async () => {
    const hostile = space.repo("zero width dev", {
      "package.json": filePkg({ name: "zw", scripts: { [`dev${ZWSP}`]: "vite" }, dependencies: { react: "18" }, devDependencies: { vite: "5" } }),
      "package-lock.json": "{}",
      "vite.config.ts": "export default {}",
    });
    const result = await scanRepository(hostile);
    expect(result.packages[0].scripts).toEqual([{ name: "dev", nameExact: false, command: "vite" }]);
    const set = suggestCommands(result);
    expect(set.suggestions.filter((s) => s.source === "script")).toEqual([]);
    expect(set.skipped.some((s) => s.reason === "script-name-unusable")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(ZWSP); // 18. the raw name never leaves the scanner

    const ordinary = space.repo("ordinary dev", {
      "package.json": filePkg({ name: "ok", scripts: { dev: "vite" }, dependencies: { react: "18" }, devDependencies: { vite: "5" } }),
      "package-lock.json": "{}",
      "vite.config.ts": "export default {}",
    });
    const ok = suggestCommands(await scanRepository(ordinary)).suggestions.filter((s) => s.source === "script");
    expect(ok.map((s) => [s.command, s.confidence])).toEqual([["npm run dev", "high"]]);
  });

  it("both \"dev\" and \"dev\\u200b\" through the real scanner: listed passively, no command", async () => {
    const root = space.repo("dev collision", {
      "package.json": filePkg({ name: "c", scripts: { dev: "vite", [`dev${ZWSP}`]: "node evil.js" }, dependencies: { react: "18" }, devDependencies: { vite: "5" } }),
      "package-lock.json": "{}",
    });
    const result = await scanRepository(root);
    expect(result.packages[0].scripts.map((s) => [s.name, s.nameExact])).toEqual([["dev", true], ["dev", false]]);
    expect(suggestCommands(result).suggestions.filter((s) => s.source === "script")).toEqual([]);
  });
});
