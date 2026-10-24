// Stage 4A: Repo Safety Check result types. An advisory, read-only check of
// the package.json script commands the scanner already returns. It can point
// out warning signs; it can never show that a repository is safe, so there is
// deliberately no "safe" or "clean" status.
import type { RepoScanStatus } from "../../types";

export type SafetyRuleId =
  | "install-script"
  | "download-execute"
  | "encoded-execution"
  | "destructive-outside-project"
  | "credential-path";

/** How much attention a finding deserves. Never "safe". */
export type SafetyLevel = "notice" | "caution" | "warning";

export interface SafetyEvidence {
  /** At most ~160 characters of the scanner's display-safe command text around the match. */
  excerpt: string;
  /** The script's command is exactly the package.json value (the scanner's commandExact). */
  commandExact: boolean;
  /** The scanner cut the command at its length limit, so the script may do more than is shown. */
  shortened: boolean;
  /** The scanner changed the command for display (line breaks, spacing, hidden characters). */
  altered: boolean;
}

export interface SafetyFinding {
  ruleId: SafetyRuleId;
  level: SafetyLevel;
  /** Root-relative package.json path, e.g. "apps/web/package.json". */
  packagePath: string;
  /** Display-safe script name. */
  scriptName: string;
  evidence: SafetyEvidence;
  /** Fixed text for the rule. */
  explanation: string;
  /** Fixed text for the rule. */
  action: string;
}

export type CoverageLimitationCode =
  | "scan-truncated"
  | "scan-cancelled"
  | "scan-timed-out"
  | "packages-omitted"
  | "manifests-truncated"
  | "package-json-not-inspected"
  | "scripts-truncated"
  | "folders-not-examined"
  | "warnings-truncated"
  | "scripts-altered"
  | "scripts-shortened";

export interface CoverageLimitation {
  code: CoverageLimitationCode;
  text: string;
  /** How many packages, files or scripts it concerns, when known. */
  count?: number;
}

export interface SafetyCoverage {
  scanStatus: RepoScanStatus;
  /** True only when nothing limited what could be inspected (no limitations). */
  complete: boolean;
  limitations: CoverageLimitation[];
}

/**
 * - findings: something matched (coverage may still be incomplete).
 * - no-indicators: nothing matched and nothing limited the inspection. This
 *   is not a clearance: see `scope`.
 * - incomplete: nothing matched, but the inspection didn't see everything.
 * - unavailable: there was no completed analysis to inspect.
 */
export type SafetyStatus = "findings" | "no-indicators" | "incomplete" | "unavailable";

export type SafetyReport =
  | { status: "unavailable"; reason: "no-analysis" | "analysis-failed"; scope: readonly string[] }
  | {
      status: "findings" | "no-indicators" | "incomplete";
      findings: SafetyFinding[];
      /** True when more findings existed than the cap allows; the rest weren't listed. */
      findingsOmitted: boolean;
      coverage: SafetyCoverage;
      scope: readonly string[];
    };
