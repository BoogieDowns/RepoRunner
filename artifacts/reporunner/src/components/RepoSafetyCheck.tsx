// Stage 4B: "Repo Safety Check", a read-only view of a Stage 4A SafetyReport.
// Purely presentational: it runs no detection, changes nothing, reads no files
// and calls no IPC. Everything from the repository (paths, script names,
// evidence) is rendered as plain React text. There are no controls: no run,
// install, apply, dismiss or approve. It never says a repository is safe; a
// report without findings only means nothing matched in what was inspected,
// and the fixed scope note is always shown. No hooks, so it renders the same
// everywhere.
// Relative imports keep it renderable in tests.
import * as React from "react";
import type { CoverageLimitation, SafetyFinding, SafetyLevel, SafetyReport, SafetyRuleId } from "../lib/safety/types";

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };
const body = { color: "#b8b4af" } as const;
const subtle = { color: "#858280" } as const;
const warn = { color: "#ffb06a" } as const;

/** Concern levels in words (never conveyed by color alone). */
export const LEVEL_LABEL: Record<SafetyLevel, string> = { notice: "Notice", caution: "Caution", warning: "Warning" };
const LEVEL_STYLE: Record<SafetyLevel, { color: string; border: string }> = {
  notice: { color: "#b8b4af", border: "#2a2626" },
  caution: { color: "#ffb06a", border: "#3a2a14" },
  warning: { color: "#ff8a94", border: "#4a1218" },
};

/** A short name for each rule, for display only. */
export const RULE_LABEL: Record<SafetyRuleId, string> = {
  "install-script": "Runs during install",
  "download-execute": "Downloads and runs code",
  "encoded-execution": "Runs an encoded or hidden command",
  "destructive-outside-project": "Deletes files outside the project",
  "credential-path": "Refers to a credential location",
};

export const STATUS_HEADING: Record<SafetyReport["status"], string> = {
  findings: "Things worth reviewing",
  "no-indicators": "No obvious warning signs found in inspected scripts",
  incomplete: "Safety Check incomplete",
  unavailable: "Safety Check unavailable",
};

export const NO_INDICATORS_NOTE =
  "None of the checked warning signs appear in the package.json scripts that were inspected. This is not a security review of the repository.";
export const INCOMPLETE_NOTE = "No warning signs were found in what could be inspected, but not everything could be inspected.";
export const FINDINGS_INCOMPLETE_NOTE = "Not everything could be inspected, so there may be more than is listed here.";
export const UNAVAILABLE_NOTE: Record<"no-analysis" | "analysis-failed", string> = {
  "no-analysis": "There is no completed analysis to check.",
  "analysis-failed": "The analysis didn't complete, so nothing was checked.",
};
export const SHORTENED_NOTE = "Shortened for display: the script continues beyond what is shown.";
export const ALTERED_NOTE = "Changed for display (line breaks, spacing or hidden characters), so this isn't an exact copy.";

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "2 warnings, 1 notice", most serious first. */
export function levelSummary(findings: readonly SafetyFinding[]): string {
  const order: SafetyLevel[] = ["warning", "caution", "notice"];
  return order
    .map((level) => [level, findings.filter((f) => f.level === level).length] as const)
    .filter(([, n]) => n > 0)
    .map(([level, n]) => plural(n, LEVEL_LABEL[level].toLowerCase(), `${LEVEL_LABEL[level].toLowerCase()}s`))
    .join(", ");
}

function FindingRow({ finding }: { finding: SafetyFinding }) {
  const level = LEVEL_STYLE[finding.level];
  const { evidence } = finding;
  return (
    <li className="space-y-1 rounded border px-2 py-1.5" style={{ borderColor: "#1a1717", background: "#090808" }} data-testid="safety-finding" data-rule={finding.ruleId} data-level={finding.level}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ border: `1px solid ${level.border}`, color: level.color }} data-testid="safety-level">
          {LEVEL_LABEL[finding.level]}
        </span>
        <span className="text-[11px] font-medium" style={{ color: "#dedad5" }} data-testid="safety-rule">
          {RULE_LABEL[finding.ruleId]}
        </span>
      </div>
      <p className="break-all text-[10px]" style={{ ...MONO, ...subtle }} data-testid="safety-location">
        {finding.packagePath} · script {JSON.stringify(finding.scriptName)}
      </p>
      <code
        className="block max-w-full whitespace-pre-wrap break-all rounded px-1.5 py-1 text-[11px]"
        style={{ ...MONO, background: "#0f0f0f", border: "1px solid #241f1f", color: "#dedad5" }}
        data-testid="safety-evidence"
      >
        {evidence.excerpt}
      </code>
      {evidence.shortened && (
        <p className="text-[10px]" style={warn} data-testid="safety-evidence-shortened">
          {SHORTENED_NOTE}
        </p>
      )}
      {evidence.altered && (
        <p className="text-[10px]" style={warn} data-testid="safety-evidence-altered">
          {ALTERED_NOTE}
        </p>
      )}
      <p className="text-[11px]" style={body} data-testid="safety-explanation">
        {finding.explanation}
      </p>
      <p className="text-[11px]" style={{ color: "#c8a2a6" }} data-testid="safety-action">
        {finding.action}
      </p>
    </li>
  );
}

function Limitations({ limitations }: { limitations: readonly CoverageLimitation[] }) {
  if (limitations.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-medium uppercase" style={{ color: "#706d69", letterSpacing: "0.08em" }}>
        What couldn't be inspected
      </p>
      <ul className="list-disc space-y-0.5 pl-4 text-[11px]" style={warn} data-testid="safety-limitations">
        {limitations.map((l, i) => (
          <li key={`${l.code}:${i}`} className="break-words" data-code={l.code}>
            {l.text}
            {l.count !== undefined ? ` (${l.count})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RepoSafetyCheck({ report }: { report: SafetyReport }) {
  const headingId = "repo-safety-check-heading";
  return (
    <section
      className="min-w-0 space-y-2 rounded-md px-3 py-2.5"
      style={{ background: "#0a0909", border: "1px solid #241a1b" }}
      aria-labelledby={headingId}
      data-testid="repo-safety-check"
      data-status={report.status}
    >
      <h3 id={headingId} className="text-xs font-semibold" style={{ color: "#dedad5" }}>
        Repo Safety Check
      </h3>
      <p className="text-[11px] font-medium" style={{ color: "#c8a2a6" }} data-testid="safety-status">
        {STATUS_HEADING[report.status]}
      </p>

      {report.status === "unavailable" && (
        <p className="text-[11px]" style={body} data-testid="safety-unavailable">
          {UNAVAILABLE_NOTE[report.reason]}
        </p>
      )}
      {report.status === "no-indicators" && (
        <p className="text-[11px]" style={body} data-testid="safety-no-indicators">
          {NO_INDICATORS_NOTE}
        </p>
      )}
      {report.status === "incomplete" && (
        <p className="text-[11px]" style={warn} data-testid="safety-incomplete">
          {INCOMPLETE_NOTE}
        </p>
      )}

      {report.status === "findings" && (
        <>
          <p className="text-[11px]" style={body} data-testid="safety-summary">
            {levelSummary(report.findings)}
            {report.findingsOmitted ? `. Only the first ${report.findings.length} are listed; more were found.` : ""}
          </p>
          {!report.coverage.complete && (
            <p className="text-[11px] font-medium" style={warn} data-testid="safety-findings-incomplete">
              {FINDINGS_INCOMPLETE_NOTE}
            </p>
          )}
          <ul className="space-y-1" data-testid="safety-findings">
            {report.findings.map((f, i) => (
              <FindingRow key={`${f.packagePath}:${f.scriptName}:${f.ruleId}:${i}`} finding={f} />
            ))}
          </ul>
        </>
      )}

      {report.status !== "unavailable" && <Limitations limitations={report.coverage.limitations} />}

      <ul className="list-disc space-y-0.5 pl-4 text-[10px] leading-snug" style={subtle} data-testid="safety-scope">
        {report.scope.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}
