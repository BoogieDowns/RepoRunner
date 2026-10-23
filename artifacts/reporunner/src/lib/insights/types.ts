// Project insights: a deterministic interpretation of a RepoScanResult.
// Plain data only. Every conclusion carries the evidence it was drawn from,
// and "unknown" is used wherever the scan can't support a conclusion.
import type { PackageManagerName, RepoScanStatus } from "../../types";

/** How strongly the evidence supports a conclusion. Not a probability. */
export type Confidence = "high" | "medium" | "low";

export type EvidenceKind =
  | "dependency"
  | "dev-dependency"
  | "config-file"
  | "script"
  | "lockfile"
  | "package-manager-field"
  | "workspace-file"
  | "engines-field"
  | "node-version-file"
  | "project-file"
  | "absence";

/** One fact the scan supports, as plain text built from fixed templates. */
export interface Evidence {
  kind: EvidenceKind;
  text: string;
}

/** Why a conclusion is uncertain or incomplete. */
export type UncertaintyCode =
  | "scan-incomplete"
  | "scan-cancelled"
  | "scan-timed-out"
  | "dependencies-truncated"
  | "scripts-truncated"
  | "packages-incomplete"
  | "project-files-incomplete"
  | "lockfiles-may-be-missing"
  | "unreadable-manifests"
  | "package-manager-conflict"
  | "package-manager-unknown"
  | "unrecognized-package-manager-field"
  | "multiple-frameworks"
  | "indirect-evidence-only"
  | "script-names-unusable";

export type FrameworkId =
  | "react-vite"
  | "vue-vite"
  | "svelte-vite"
  | "sveltekit"
  | "nextjs"
  | "angular"
  | "express"
  | "fastify"
  | "nestjs"
  | "nuxt"
  | "astro"
  | "remix";

export type FrameworkCategory = "frontend" | "fullstack" | "backend";

export interface FrameworkDetection {
  id: FrameworkId;
  label: string;
  category: FrameworkCategory;
  /** Whether later stages may suggest commands for it (Nuxt, Astro, Remix: recognized only). */
  suggestionsSupported: boolean;
  confidence: Confidence;
  evidence: Evidence[];
  uncertainties: UncertaintyCode[];
}

export type RuntimeId = "node" | "bun" | "deno";

export interface RuntimeSignal {
  runtime: RuntimeId;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface PackageManagerCandidate {
  manager: PackageManagerName;
  evidence: Evidence[];
}

export interface PackageManagerInsight {
  /** single: one manager indicated; conflict: several; unknown: no evidence (npm is never assumed). */
  status: "single" | "conflict" | "unknown";
  candidates: PackageManagerCandidate[];
  confidence: Confidence | null;
  uncertainties: UncertaintyCode[];
}

/**
 * What the package appears to be. "library": a framework is used but no run
 * script exists (and the script list is complete); "node-app": no framework,
 * but a run script starts Node directly.
 */
export type PackageRole =
  | "frontend"
  | "fullstack"
  | "backend"
  | "mixed"
  | "node-app"
  | "library"
  | "workspace-root"
  | "unknown";

export interface RunnabilityInsight {
  /**
   * has-run-script: a candidate run script exists (never tested or verified);
   * no-run-script: the complete script list has none; unknown: the script list
   * was truncated, so absence can't be concluded.
   */
  status: "has-run-script" | "no-run-script" | "unknown";
  /** Candidate run scripts present in package.json, in preference order. Never invented. */
  runScripts: string[];
  /** Run-named scripts whose command only builds (e.g. dev: "vite build"); not counted as run scripts. */
  buildOnlyScripts: string[];
  confidence: Confidence | null;
  evidence: Evidence[];
  uncertainties: UncertaintyCode[];
}

export interface PackageInsight {
  /** Root-relative path of the package.json, e.g. "apps/web/package.json". */
  packagePath: string;
  /** Root-relative folder containing it; "." for the repository root. */
  directory: string;
  name: string | null;
  frameworks: FrameworkDetection[];
  runtimes: RuntimeSignal[];
  packageManager: PackageManagerInsight;
  role: PackageRole;
  runnability: RunnabilityInsight;
  uncertainties: UncertaintyCode[];
}

export type RepositoryKind = "single-package" | "monorepo" | "multi-package" | "non-node" | "unknown";

/** A root script that appears to run several workspace packages at once. */
export interface OrchestrationSignal {
  scriptName: string;
  tool: "turbo" | "nx" | "lerna" | "pnpm-recursive" | "npm-workspaces" | "yarn-workspaces" | "concurrently";
  evidence: Evidence[];
}

export interface ProjectInsights {
  scanStatus: RepoScanStatus;
  /** False for truncated, cancelled and timed-out scans: conclusions may be missing. */
  scanComplete: boolean;
  kind: RepositoryKind;
  kindEvidence: Evidence[];
  packages: PackageInsight[];
  orchestration: OrchestrationSignal[];
  /** Non-Node ecosystems recognized by project-file name (e.g. "python"). */
  otherEcosystems: string[];
  uncertainties: UncertaintyCode[];
}

// ---------------------------------------------------------------------------
// Stage 2B: command suggestions. Informational only: nothing here is run,
// applied or saved, and no suggestion has been tested.

export type SuggestionPurpose = "develop" | "start" | "install";

export type CaveatCode =
  | "not-verified"
  | "runs-repository-script"
  | "package-manager-ambiguous"
  | "package-manager-unknown"
  | "unsafe-script-name"
  | "scan-incomplete"
  | "scripts-truncated"
  | "hooks-may-be-incomplete"
  | "lifecycle-hooks"
  | "install-runs-project-scripts"
  | "install-runs-dependency-scripts"
  | "preview-serves-build"
  | "runs-multiple-packages"
  | "framework-uncertain"
  | "multiple-frameworks"
  | "independent-package"
  | "no-lockfile-here"
  | "workspace-membership-unknown"
  | "members-unconfirmed"
  | "nested-workspace-root"
  | "workspace-ownership-ambiguous";

export interface Caveat {
  code: CaveatCode;
  text: string;
}

export interface CommandSuggestion {
  /** Stable identifier: directory, purpose, script and package manager. */
  id: string;
  packagePath: string;
  /** Root-relative folder the command belongs to ("." for the root). */
  directory: string;
  packageName: string | null;
  purpose: SuggestionPurpose;
  /** "script": runs an existing package.json script; "install": a package manager's standard install command. */
  source: "script" | "install";
  /** The existing script's name (scripts only). */
  scriptName: string | null;
  /** What that script runs, as passive text for review. Never part of `command`. */
  scriptCommandText: string | null;
  /** The package manager this alternative uses; null when it couldn't be determined. */
  packageManager: PackageManagerName | null;
  /**
   * Built from a fixed template plus an allowlisted script name, or null when
   * no command could be built (see `unavailableReason`). This constrains the
   * command's syntax only. It is NOT a safety guarantee: the script it runs is
   * defined by the repository and can execute arbitrary commands, and nothing
   * was run, verified or security-reviewed.
   */
  command: string | null;
  unavailableReason: "package-manager-unknown" | "unsafe-script-name" | null;
  /** True when this is one of several alternatives because package-manager evidence conflicts. */
  packageManagerAmbiguous: boolean;
  scanIncomplete: boolean;
  /** Set when a root script runs several workspace packages. */
  orchestration: OrchestrationSignal["tool"] | null;
  frameworks: FrameworkId[];
  /** Null when no command could be built. Never "verified". */
  confidence: Confidence | null;
  evidence: Evidence[];
  caveats: Caveat[];
}

export type SkipReason =
  | "no-run-script"
  | "scripts-truncated"
  | "script-name-unusable"
  | "unsupported-framework"
  | "workspace-root-without-run-script"
  | "non-node-project"
  | "no-packages";

/** A package (or the repository) for which nothing was suggested, and why. */
export interface SuggestionSkip {
  packagePath: string | null;
  directory: string | null;
  reason: SkipReason;
  text: string;
}

export interface CommandSuggestions {
  scanComplete: boolean;
  suggestions: CommandSuggestion[];
  /** True if the suggestion limit was reached and some were left out. */
  suggestionsTruncated: boolean;
  skipped: SuggestionSkip[];
}
