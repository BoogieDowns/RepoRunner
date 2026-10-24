// Stage 4A: Repo Safety Check over a scanner result. Pure, deterministic and
// bounded: no filesystem, IPC, network, storage or execution. Only the
// display-safe script commands the scanner already returns are inspected;
// nothing is read, resolved, decoded or run. The report never says a
// repository is safe: "no-indicators" only means nothing matched within what
// was inspected, and anything that limited the inspection makes it
// "incomplete" instead.
import type { RepoScanResult, RepoScanWarningCode } from "../../types";
import { credentialPath, destructiveOutsideProject, downloadExecute, encodedExecution, parseScript } from "./rules";
import type { CoverageLimitation, SafetyEvidence, SafetyFinding, SafetyLevel, SafetyReport, SafetyRuleId } from "./types";

/** At most this many findings are listed; `findingsOmitted` says when more exist. */
export const MAX_FINDINGS = 100;
/** The scanner's limit for script command text (TEXT_LIMITS.scriptCommand); a command this long ending in "…" was cut. */
export const SCANNER_COMMAND_LIMIT = 500;
const EXCERPT_BEFORE = 40;
const EXCERPT_LENGTH = 160;

/** What this check can and can't see. Always part of the report. */
export const SAFETY_SCOPE: readonly string[] = [
  "Only package.json script commands are inspected for these indicators.",
  "Files those scripts run or refer to are not opened.",
  "Dependencies' own install scripts are not inspected.",
  "Commands are read with a simplified shell reading: conditionals and loops (if, then, for, while), variables and functions aren't interpreted, so indicators inside them can be missed.",
  "No match is not evidence that the repository is free of malicious behavior.",
];

/** Install-time lifecycle scripts: package managers run them during an install. */
export const INSTALL_SCRIPTS: readonly string[] = ["preinstall", "install", "postinstall", "prepare"];

const RULES: Record<SafetyRuleId, { level: SafetyLevel; explanation: string; action: string }> = {
  "install-script": {
    level: "notice",
    explanation: "This script runs automatically when dependencies are installed. Install scripts are common and usually harmless, but they run before you've used the project.",
    action: "Read this script, and any file it runs, before installing.",
  },
  "download-execute": {
    level: "warning",
    explanation: "This script appears to download something and run it straight away, without saving it for review first.",
    action: "Don't run this script until you've checked where the download comes from and what it does.",
  },
  "encoded-execution": {
    level: "warning",
    explanation: "This script appears to run a command that is encoded or produced at run time, which hides what it actually does.",
    action: "Don't run this script until you know what the hidden command does.",
  },
  "destructive-outside-project": {
    level: "warning",
    explanation: "This script appears to delete files recursively outside this project folder: a drive root, a home or user-profile folder, a system folder, or a parent folder beyond the analyzed folder.",
    action: "Don't run this script until you've confirmed what it deletes.",
  },
  "credential-path": {
    level: "caution",
    explanation: "This script refers to a place where credentials are commonly stored (SSH keys, cloud or package-registry credentials, or browser profiles). Referring to it doesn't mean anything is read or sent.",
    action: "Check why this script needs that location before running it.",
  },
};

/** For callers without a completed analysis. */
export function unavailableReport(reason: "no-analysis" | "analysis-failed"): SafetyReport {
  return { status: "unavailable", reason, scope: SAFETY_SCOPE };
}

const MANIFEST_NOT_INSPECTED: ReadonlySet<RepoScanWarningCode> = new Set(["manifest-malformed", "manifest-not-object", "manifest-oversized", "manifest-unreadable", "manifest-limit-reached"]);
const FOLDER_NOT_EXAMINED: ReadonlySet<RepoScanWarningCode> = new Set(["directory-unreadable", "entry-unreadable", "byte-budget-exhausted", "changed-during-scan"]);
const isPackageJson = (path: string) => path === "package.json" || path.endsWith("/package.json");

function isShortened(command: string, exact: boolean): boolean {
  return !exact && command.endsWith("…") && Array.from(command).length >= SCANNER_COMMAND_LIMIT;
}

function excerpt(command: string, at: number): string {
  const chars = Array.from(command);
  // `at` is a UTF-16 offset; convert to a code-point index for slicing.
  const index = Math.max(0, Array.from(command.slice(0, Math.max(0, at))).length);
  const from = Math.max(0, index - EXCERPT_BEFORE);
  const to = Math.min(chars.length, from + EXCERPT_LENGTH);
  return `${from > 0 ? "…" : ""}${chars.slice(from, to).join("")}${to < chars.length ? "…" : ""}`;
}

function coverageOf(result: RepoScanResult): CoverageLimitation[] {
  const limitations: CoverageLimitation[] = [];
  if (result.status === "truncated") limitations.push({ code: "scan-truncated", text: "The analysis stopped at a limit, so some folders or files weren't examined." });
  if (result.status === "cancelled") limitations.push({ code: "scan-cancelled", text: "The analysis was cancelled before it finished." });
  if (result.status === "timed-out") limitations.push({ code: "scan-timed-out", text: "The analysis ran out of time before it finished." });
  if (result.packagesTruncated) limitations.push({ code: "packages-omitted", text: "Some package.json files were found but left out of the results, so their scripts weren't inspected." });
  if (result.manifestsTruncated) limitations.push({ code: "manifests-truncated", text: "The list of project files was cut short, so some package.json files may not have been seen." });

  const inspected = new Set(result.packages.map((p) => p.path));
  const notInspected = new Set<string>();
  for (const w of result.warnings) if (MANIFEST_NOT_INSPECTED.has(w.code) && isPackageJson(w.path)) notInspected.add(w.path);
  for (const m of result.manifests) if (m.kind === "package-json" && !inspected.has(m.path)) notInspected.add(m.path);
  if (notInspected.size > 0) limitations.push({ code: "package-json-not-inspected", text: "Some package.json files couldn't be read or understood, so their scripts weren't inspected.", count: notInspected.size });

  const cut = result.packages.filter((p) => p.scriptsTruncated).length;
  if (cut > 0) limitations.push({ code: "scripts-truncated", text: "Some packages have more scripts than were listed; those weren't inspected.", count: cut });

  const folderWarnings = result.warnings.filter((w) => FOLDER_NOT_EXAMINED.has(w.code)).length;
  const skipped = result.skipped.depthLimited + result.skipped.unreadable + result.skipped.changedDuringScan;
  if (folderWarnings + skipped > 0) {
    limitations.push({ code: "folders-not-examined", text: "Some folders or files were too deep, unreadable or changing during the analysis, so package.json files in them may have been missed.", count: folderWarnings + skipped });
  }
  if (result.warningsTruncated) limitations.push({ code: "warnings-truncated", text: "The analysis had more warnings than were listed, so other problems may not be shown." });

  let altered = 0;
  let shortened = 0;
  for (const p of result.packages) {
    for (const s of p.scripts) {
      if (s.commandExact === true) continue;
      if (isShortened(s.command, false)) shortened++;
      else altered++;
    }
  }
  if (shortened > 0) limitations.push({ code: "scripts-shortened", text: "Some script commands were cut at the analysis's length limit, so parts of them weren't inspected.", count: shortened });
  if (altered > 0) limitations.push({ code: "scripts-altered", text: "Some script commands were changed for display (line breaks, spacing or hidden characters removed), so what was inspected isn't exactly what runs.", count: altered });
  return limitations;
}

/**
 * Inspects every package's scripts. Findings come in package, script and rule
 * order, at most one per rule per script, and at most MAX_FINDINGS in all;
 * once the cap is reached the rest isn't examined.
 */
export function checkRepository(result: RepoScanResult): SafetyReport {
  const findings: SafetyFinding[] = [];
  let findingsOmitted = false;

  scan: for (const pkg of result.packages) {
    const depth = pkg.path.split("/").length - 1;
    for (const script of pkg.scripts) {
      const exact = script.commandExact === true;
      const command = script.command;
      const matches: Array<[SafetyRuleId, number]> = [];
      if (script.nameExact === true && INSTALL_SCRIPTS.includes(script.name)) matches.push(["install-script", 0]);
      const parsed = parseScript(command);
      const checks: Array<[SafetyRuleId, number]> = [
        ["download-execute", downloadExecute(parsed)],
        ["encoded-execution", encodedExecution(parsed)],
        ["destructive-outside-project", destructiveOutsideProject(parsed, depth)],
        ["credential-path", credentialPath(command)],
      ];
      for (const [rule, at] of checks) if (at >= 0) matches.push([rule, at]);
      for (const [ruleId, at] of matches) {
        if (findings.length >= MAX_FINDINGS) {
          findingsOmitted = true;
          break scan;
        }
        const evidence: SafetyEvidence = { excerpt: excerpt(command, at), commandExact: exact, shortened: isShortened(command, exact), altered: !exact && !isShortened(command, exact) };
        const rule = RULES[ruleId];
        findings.push({ ruleId, level: rule.level, packagePath: pkg.path, scriptName: script.name, evidence, explanation: rule.explanation, action: rule.action });
      }
    }
  }

  const limitations = coverageOf(result);
  const coverage = { scanStatus: result.status, complete: limitations.length === 0, limitations };
  const status = findings.length > 0 ? "findings" : coverage.complete ? "no-indicators" : "incomplete";
  return { status, findings, findingsOmitted, coverage, scope: SAFETY_SCOPE };
}
