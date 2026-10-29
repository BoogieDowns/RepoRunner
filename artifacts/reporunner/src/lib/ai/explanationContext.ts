// Stage 4R: the safe context for a future, optional "explain these analysis
// results" AI request. Pure: no files, network, environment, clock, logging
// or Electron, and nothing in the app uses it yet (no IPC, preload or UI).
//
// It projects RepoRunner's own deterministic analysis (the scan result,
// detectProjects, suggestCommands and checkRepository) into a closed,
// versioned document made only of codes RepoRunner itself defines, booleans
// and bounded counts:
// - No repository-controlled text at all: no root name, paths, manifest or
//   package names, versions, dependency or script names, script commands,
//   safety excerpts, evidence or caveat text, .env names, warnings' paths or
//   Setup values. Packages appear as opaque ids (pkg-1, pkg-2, ...) assigned
//   in path order; the paths themselves are only used here to link records.
//   An opaque id is not anonymity: counts and classifications can still say
//   something about a repository's shape.
// - Every value is read as an own data property and checked at runtime
//   against an exact allowlist (compile-time checked to equal the real code
//   unions). Unknown codes, malformed values, inconsistent inputs or
//   anything over a limit fail closed with a fixed code; nothing is passed
//   through, dropped silently or replaced.
// - Serialization is deterministic: keys in a fixed order, sets sorted by
//   their allowlist order, at most 8 KiB of UTF-8. The digest of those exact
//   bytes is computed separately (contextDigest.ts).
// It contains no instructions or prompt text; that belongs to a later stage.
import type {
  CaveatCode,
  CommandSuggestions,
  Confidence,
  EvidenceKind,
  FrameworkCategory,
  FrameworkId,
  OrchestrationSignal,
  PackageRole,
  ProjectInsights,
  RepositoryKind,
  RuntimeId,
  SkipReason,
  SuggestionPurpose,
  UncertaintyCode,
} from "../insights/types";
import type { CoverageLimitationCode, SafetyLevel, SafetyReport, SafetyRuleId } from "../safety/types";
import type { ManifestKind, PackageManagerName, RepoScanLimit, RepoScanResult, RepoScanStatus, WorkspaceSignal } from "../../types";

export const AI_CONTEXT_FORMAT = "reporunner-ai-explanation-context";
export const AI_CONTEXT_VERSION = 1;

export const AI_CONTEXT_LIMITS = Object.freeze({
  packages: 25,
  /** Per package. All twelve known frameworks fit. */
  frameworksPerPackage: 12,
  suggestions: 20,
  skipped: 25,
  safetyFindings: 20,
  /** Per uncertainty list (scan-level, each package, each framework, package manager and runnability). */
  uncertainties: 30,
  /** The largest count accepted anywhere (scripts, packages, limitation counts...). */
  count: 100_000,
  /** Canonical JSON, UTF-8. */
  bytes: 8 * 1024,
});

// ---------------------------------------------------------------------------
// Allowlists: exactly the codes the analysis defines (checked at compile time).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const SCAN_STATUSES = ["complete", "truncated", "cancelled", "timed-out"] as const;
const SCAN_LIMITS = ["depth", "entries", "directories", "manifests", "bytes", "time", "result-size"] as const;
const MANIFEST_KINDS = [
  "package-json", "lockfile", "workspace-config", "node-version", "typescript-config", "framework-config", "build-config",
  "container", "process-file", "python", "go", "rust", "ruby", "php", "java", "deno", "make",
] as const;
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
const WORKSPACE_SIGNALS = ["npm-workspaces", "pnpm-workspace", "lerna", "nx", "turbo", "rush"] as const;
const REPOSITORY_KINDS = ["single-package", "monorepo", "multi-package", "non-node", "unknown"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;
const EVIDENCE_KINDS = [
  "dependency", "dev-dependency", "config-file", "script", "lockfile", "package-manager-field", "workspace-file",
  "engines-field", "node-version-file", "project-file", "absence",
] as const;
const UNCERTAINTIES = [
  "scan-incomplete", "scan-cancelled", "scan-timed-out", "dependencies-truncated", "scripts-truncated", "packages-incomplete",
  "project-files-incomplete", "lockfiles-may-be-missing", "unreadable-manifests", "package-manager-conflict",
  "package-manager-unknown", "unrecognized-package-manager-field", "multiple-frameworks", "indirect-evidence-only",
  "script-names-unusable", "script-commands-altered",
] as const;
const FRAMEWORK_IDS = ["react-vite", "vue-vite", "svelte-vite", "sveltekit", "nextjs", "angular", "express", "fastify", "nestjs", "nuxt", "astro", "remix"] as const;
const FRAMEWORK_CATEGORIES = ["frontend", "fullstack", "backend"] as const;
const RUNTIMES = ["node", "bun", "deno"] as const;
const PACKAGE_ROLES = ["frontend", "fullstack", "backend", "mixed", "node-app", "library", "workspace-root", "unknown"] as const;
const PM_STATUSES = ["single", "conflict", "unknown"] as const;
const RUNNABILITY = ["has-run-script", "no-run-script", "unknown"] as const;
const ORCHESTRATION_TOOLS = ["turbo", "nx", "lerna", "pnpm-recursive", "npm-workspaces", "yarn-workspaces", "concurrently"] as const;
const PURPOSES = ["develop", "start", "install"] as const;
const SOURCES = ["script", "install"] as const;
const UNAVAILABLE = ["package-manager-unknown", "unsafe-script-name"] as const;
const CAVEATS = [
  "not-verified", "runs-repository-script", "package-manager-ambiguous", "package-manager-unknown", "unsafe-script-name",
  "scan-incomplete", "scripts-truncated", "hooks-may-be-incomplete", "lifecycle-hooks", "install-runs-project-scripts",
  "install-runs-dependency-scripts", "preview-serves-build", "runs-multiple-packages", "framework-uncertain",
  "multiple-frameworks", "independent-package", "no-lockfile-here", "workspace-membership-unknown", "members-unconfirmed",
  "nested-workspace-root", "workspace-ownership-ambiguous", "script-command-altered",
] as const;
const SKIP_REASONS = [
  "no-run-script", "scripts-truncated", "script-name-unusable", "unsupported-framework", "workspace-root-without-run-script",
  "non-node-project", "no-packages",
] as const;
const SAFETY_STATUSES = ["findings", "no-indicators", "incomplete", "unavailable"] as const;
const SAFETY_UNAVAILABLE = ["no-analysis", "analysis-failed"] as const;
const SAFETY_RULES = ["install-script", "download-execute", "encoded-execution", "destructive-outside-project", "credential-path"] as const;
const SAFETY_LEVELS = ["notice", "caution", "warning"] as const;
const LIMITATIONS = [
  "scan-truncated", "scan-cancelled", "scan-timed-out", "packages-omitted", "manifests-truncated", "package-json-not-inspected",
  "scripts-truncated", "folders-not-examined", "warnings-truncated", "scripts-altered", "scripts-shortened",
] as const;
/** detectProjects' fixed labels for other ecosystems, and the code each becomes. */
const OTHER_ECOSYSTEMS = [
  ["Python", "python"], ["Go", "go"], ["Rust", "rust"], ["Ruby", "ruby"], ["PHP", "php"], ["Java", "java"], ["Deno", "deno"],
] as const;
const ECOSYSTEM_CODES = OTHER_ECOSYSTEMS.map(([, code]) => code);

const allowlistsMatch: [
  Exact<(typeof SCAN_STATUSES)[number], RepoScanStatus>,
  Exact<(typeof SCAN_LIMITS)[number], RepoScanLimit>,
  Exact<(typeof MANIFEST_KINDS)[number], ManifestKind>,
  Exact<(typeof PACKAGE_MANAGERS)[number], PackageManagerName>,
  Exact<(typeof WORKSPACE_SIGNALS)[number], WorkspaceSignal>,
  Exact<(typeof REPOSITORY_KINDS)[number], RepositoryKind>,
  Exact<(typeof CONFIDENCES)[number], Confidence>,
  Exact<(typeof EVIDENCE_KINDS)[number], EvidenceKind>,
  Exact<(typeof UNCERTAINTIES)[number], UncertaintyCode>,
  Exact<(typeof FRAMEWORK_IDS)[number], FrameworkId>,
  Exact<(typeof FRAMEWORK_CATEGORIES)[number], FrameworkCategory>,
  Exact<(typeof RUNTIMES)[number], RuntimeId>,
  Exact<(typeof PACKAGE_ROLES)[number], PackageRole>,
  Exact<(typeof ORCHESTRATION_TOOLS)[number], OrchestrationSignal["tool"]>,
  Exact<(typeof PURPOSES)[number], SuggestionPurpose>,
  Exact<(typeof CAVEATS)[number], CaveatCode>,
  Exact<(typeof SKIP_REASONS)[number], SkipReason>,
  Exact<(typeof SAFETY_STATUSES)[number], SafetyReport["status"]>,
  Exact<(typeof SAFETY_RULES)[number], SafetyRuleId>,
  Exact<(typeof SAFETY_LEVELS)[number], SafetyLevel>,
  Exact<(typeof LIMITATIONS)[number], CoverageLimitationCode>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
void allowlistsMatch;

// ---------------------------------------------------------------------------
// The closed schema.
type Code<T extends readonly string[]> = T[number];

export interface AiContextPackage {
  id: string;
  root: boolean;
  role: Code<typeof PACKAGE_ROLES>;
  frameworks: Array<{
    id: Code<typeof FRAMEWORK_IDS>;
    category: Code<typeof FRAMEWORK_CATEGORIES>;
    confidence: Code<typeof CONFIDENCES>;
    suggestionsSupported: boolean;
    evidenceKinds: Array<Code<typeof EVIDENCE_KINDS>>;
    uncertainties: Array<Code<typeof UNCERTAINTIES>>;
  }>;
  runtimes: Array<{ runtime: Code<typeof RUNTIMES>; confidence: Code<typeof CONFIDENCES>; evidenceKinds: Array<Code<typeof EVIDENCE_KINDS>> }>;
  packageManager: {
    status: Code<typeof PM_STATUSES>;
    candidates: Array<{ manager: Code<typeof PACKAGE_MANAGERS>; evidenceKinds: Array<Code<typeof EVIDENCE_KINDS>> }>;
    confidence: Code<typeof CONFIDENCES> | null;
    uncertainties: Array<Code<typeof UNCERTAINTIES>>;
  };
  runnability: {
    status: Code<typeof RUNNABILITY>;
    runScriptCount: number;
    buildOnlyScriptCount: number;
    confidence: Code<typeof CONFIDENCES> | null;
    evidenceKinds: Array<Code<typeof EVIDENCE_KINDS>>;
    uncertainties: Array<Code<typeof UNCERTAINTIES>>;
  };
  uncertainties: Array<Code<typeof UNCERTAINTIES>>;
}

export interface AiExplanationContext {
  format: typeof AI_CONTEXT_FORMAT;
  version: typeof AI_CONTEXT_VERSION;
  scan: {
    status: Code<typeof SCAN_STATUSES>;
    complete: boolean;
    partial: boolean;
    limitsHit: Array<Code<typeof SCAN_LIMITS>>;
    repositoryKind: Code<typeof REPOSITORY_KINDS>;
    otherEcosystems: Array<(typeof ECOSYSTEM_CODES)[number]>;
    orchestrationTools: Array<Code<typeof ORCHESTRATION_TOOLS>>;
    uncertainties: Array<Code<typeof UNCERTAINTIES>>;
  };
  counts: {
    packages: number;
    packagesTruncated: boolean;
    manifests: Array<{ kind: Code<typeof MANIFEST_KINDS>; count: number }>;
    manifestsTruncated: boolean;
    lockfiles: Array<{ manager: Code<typeof PACKAGE_MANAGERS>; count: number }>;
    workspaceSignals: Array<Code<typeof WORKSPACE_SIGNALS>>;
    declaredPackageManager: boolean;
  };
  packages: AiContextPackage[];
  suggestions: {
    complete: boolean;
    truncated: boolean;
    items: Array<{
      package: string;
      purpose: Code<typeof PURPOSES>;
      source: Code<typeof SOURCES>;
      packageManager: Code<typeof PACKAGE_MANAGERS> | null;
      available: boolean;
      unavailableReason: Code<typeof UNAVAILABLE> | null;
      packageManagerAmbiguous: boolean;
      scanIncomplete: boolean;
      orchestration: Code<typeof ORCHESTRATION_TOOLS> | null;
      frameworks: Array<Code<typeof FRAMEWORK_IDS>>;
      confidence: Code<typeof CONFIDENCES> | null;
      evidenceKinds: Array<Code<typeof EVIDENCE_KINDS>>;
      caveats: Array<Code<typeof CAVEATS>>;
    }>;
    skipped: Array<{ package: string | null; reason: Code<typeof SKIP_REASONS> }>;
  };
  safety:
    | { status: "unavailable"; reason: Code<typeof SAFETY_UNAVAILABLE> }
    | {
        status: "findings" | "no-indicators" | "incomplete";
        findingsOmitted: boolean;
        coverageComplete: boolean;
        limitations: Array<{ code: Code<typeof LIMITATIONS>; count: number | null }>;
        findings: Array<{ package: string; rule: Code<typeof SAFETY_RULES>; level: Code<typeof SAFETY_LEVELS>; commandExact: boolean; shortened: boolean; altered: boolean }>;
      };
}

export type AiContextError = "invalid-input" | "unsupported-code" | "too-many-entries" | "context-too-large" | "failed";

export type AiContextResult =
  | { ok: true; context: AiExplanationContext; canonicalJson: string; byteLength: number }
  | { ok: false; error: AiContextError };

export interface AiContextInput {
  scan: RepoScanResult;
  insights: ProjectInsights;
  suggestions: CommandSuggestions;
  safety: SafetyReport;
}

// ---------------------------------------------------------------------------
// Strict readers: own data properties only, fixed codes, no input text in errors.
class ContextFailure {
  constructor(readonly code: AiContextError) {}
}
const fail = (code: AiContextError): never => {
  throw new ContextFailure(code);
};

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("invalid-input");
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && "value" in d ? d.value : undefined;
}
function bool(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail("invalid-input");
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= AI_CONTEXT_LIMITS.count ? value : fail("invalid-input");
}
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : fail("invalid-input");
}
function code<T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== "string") return fail("invalid-input");
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : fail("unsupported-code");
}
function codeOrNull<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return value === null ? null : code(value, allowed);
}
/** A set of codes: every entry checked, duplicates merged, sorted in allowlist order. */
function codeSet<T extends readonly string[]>(value: unknown, allowed: T, max: number): Array<T[number]> {
  const seen = new Set<T[number]>(list(value).map((v) => code(v, allowed)));
  if (seen.size > max) fail("too-many-entries");
  return (allowed as readonly T[number][]).filter((c) => seen.has(c));
}
const byAllowlist = <T extends readonly string[]>(allowed: T) => (a: T[number], b: T[number]) => allowed.indexOf(a) - allowed.indexOf(b);
/** Evidence: only its kind, never its text. */
function evidenceKinds(value: unknown) {
  return codeSet(list(value).map((e) => own(e, "kind")), EVIDENCE_KINDS, EVIDENCE_KINDS.length);
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
/** Code-unit order, independent of locale. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------

function projectPackage(pkg: unknown, id: string): AiContextPackage {
  const frameworksIn = list(own(pkg, "frameworks"));
  if (frameworksIn.length > AI_CONTEXT_LIMITS.frameworksPerPackage) fail("too-many-entries");
  const frameworks = frameworksIn
    .map((f) => ({
      id: code(own(f, "id"), FRAMEWORK_IDS),
      category: code(own(f, "category"), FRAMEWORK_CATEGORIES),
      confidence: code(own(f, "confidence"), CONFIDENCES),
      suggestionsSupported: bool(own(f, "suggestionsSupported")),
      evidenceKinds: evidenceKinds(own(f, "evidence")),
      uncertainties: codeSet(own(f, "uncertainties"), UNCERTAINTIES, AI_CONTEXT_LIMITS.uncertainties),
    }))
    .sort((a, b) => byAllowlist(FRAMEWORK_IDS)(a.id, b.id));
  if (new Set(frameworks.map((f) => f.id)).size !== frameworks.length) fail("invalid-input");

  const runtimesIn = list(own(pkg, "runtimes"));
  const runtimes = runtimesIn
    .map((r) => ({ runtime: code(own(r, "runtime"), RUNTIMES), confidence: code(own(r, "confidence"), CONFIDENCES), evidenceKinds: evidenceKinds(own(r, "evidence")) }))
    .sort((a, b) => byAllowlist(RUNTIMES)(a.runtime, b.runtime));
  if (new Set(runtimes.map((r) => r.runtime)).size !== runtimes.length) fail("invalid-input");

  const pm = own(pkg, "packageManager");
  const candidates = list(own(pm, "candidates"))
    .map((c) => ({ manager: code(own(c, "manager"), PACKAGE_MANAGERS), evidenceKinds: evidenceKinds(own(c, "evidence")) }))
    .sort((a, b) => byAllowlist(PACKAGE_MANAGERS)(a.manager, b.manager));
  if (new Set(candidates.map((c) => c.manager)).size !== candidates.length) fail("invalid-input");

  const run = own(pkg, "runnability");
  return {
    id,
    root: own(pkg, "directory") === ".",
    role: code(own(pkg, "role"), PACKAGE_ROLES),
    frameworks,
    runtimes,
    packageManager: {
      status: code(own(pm, "status"), PM_STATUSES),
      candidates,
      confidence: codeOrNull(own(pm, "confidence"), CONFIDENCES),
      uncertainties: codeSet(own(pm, "uncertainties"), UNCERTAINTIES, AI_CONTEXT_LIMITS.uncertainties),
    },
    runnability: {
      status: code(own(run, "status"), RUNNABILITY),
      // Only how many: the script names themselves are repository text.
      runScriptCount: count(list(own(run, "runScripts")).length),
      buildOnlyScriptCount: count(list(own(run, "buildOnlyScripts")).length),
      confidence: codeOrNull(own(run, "confidence"), CONFIDENCES),
      evidenceKinds: evidenceKinds(own(run, "evidence")),
      uncertainties: codeSet(own(run, "uncertainties"), UNCERTAINTIES, AI_CONTEXT_LIMITS.uncertainties),
    },
    uncertainties: codeSet(own(pkg, "uncertainties"), UNCERTAINTIES, AI_CONTEXT_LIMITS.uncertainties),
  };
}

function project(input: AiContextInput): AiExplanationContext {
  const { scan, insights, suggestions, safety } = input as unknown as Record<string, unknown>;

  // Scan-level facts, consistent across the inputs.
  const status = code(own(scan, "status"), SCAN_STATUSES);
  if (own(insights, "scanStatus") !== status) fail("invalid-input");
  const complete = bool(own(insights, "scanComplete"));
  if (complete !== (status === "complete")) fail("invalid-input");
  if (bool(own(suggestions, "scanComplete")) !== complete) fail("invalid-input");

  // Packages: opaque ids in path order (the paths are only used to link records here).
  const packagesIn = list(own(insights, "packages"));
  if (packagesIn.length > AI_CONTEXT_LIMITS.packages) fail("too-many-entries");
  const ordered = packagesIn.map((p) => {
    const path = own(p, "packagePath");
    return typeof path === "string" ? { path, pkg: p } : fail("invalid-input");
  });
  ordered.sort((a, b) => compareText(a.path, b.path));
  const ids = new Map<string, string>();
  ordered.forEach(({ path }, i) => {
    if (ids.has(path)) fail("invalid-input");
    ids.set(path, `pkg-${i + 1}`);
  });
  const idFor = (path: unknown): string => (typeof path === "string" && ids.has(path) ? ids.get(path)! : fail("invalid-input"));
  const packages = ordered.map(({ path, pkg }) => projectPackage(pkg, ids.get(path)!));

  const otherEcosystems = codeSet(
    list(own(insights, "otherEcosystems")).map((label) => {
      const match = OTHER_ECOSYSTEMS.find(([l]) => l === label);
      return match ? match[1] : typeof label === "string" ? fail("unsupported-code") : fail("invalid-input");
    }),
    ECOSYSTEM_CODES,
    ECOSYSTEM_CODES.length,
  );

  // Counts by fixed code (never by path or name).
  const manifestCounts = new Map<Code<typeof MANIFEST_KINDS>, number>();
  for (const m of list(own(scan, "manifests"))) {
    const kind = code(own(m, "kind"), MANIFEST_KINDS);
    manifestCounts.set(kind, (manifestCounts.get(kind) ?? 0) + 1);
  }
  const pmInfo = own(scan, "packageManager");
  const lockCounts = new Map<Code<typeof PACKAGE_MANAGERS>, number>();
  for (const l of list(own(pmInfo, "lockfiles"))) {
    const manager = code(own(l, "manager"), PACKAGE_MANAGERS);
    lockCounts.set(manager, (lockCounts.get(manager) ?? 0) + 1);
  }
  const declared = own(pmInfo, "declared");
  if (declared !== null && typeof declared !== "string") fail("invalid-input");
  const scanPackages = list(own(scan, "packages"));

  // Deterministic suggestions: their order is the analysis' preference order, so it's kept.
  const items = list(own(suggestions, "suggestions"));
  if (items.length > AI_CONTEXT_LIMITS.suggestions) fail("too-many-entries");
  const suggestionItems = items.map((s) => {
    const command = own(s, "command");
    if (command !== null && typeof command !== "string") fail("invalid-input");
    const unavailableReason = codeOrNull(own(s, "unavailableReason"), UNAVAILABLE);
    if ((command === null) !== (unavailableReason !== null)) fail("invalid-input");
    return {
      package: idFor(own(s, "packagePath")),
      purpose: code(own(s, "purpose"), PURPOSES),
      source: code(own(s, "source"), SOURCES),
      packageManager: codeOrNull(own(s, "packageManager"), PACKAGE_MANAGERS),
      // Whether a command could be built, never the command.
      available: command !== null,
      unavailableReason,
      packageManagerAmbiguous: bool(own(s, "packageManagerAmbiguous")),
      scanIncomplete: bool(own(s, "scanIncomplete")),
      orchestration: codeOrNull(own(s, "orchestration"), ORCHESTRATION_TOOLS),
      frameworks: codeSet(own(s, "frameworks"), FRAMEWORK_IDS, FRAMEWORK_IDS.length),
      confidence: codeOrNull(own(s, "confidence"), CONFIDENCES),
      evidenceKinds: evidenceKinds(own(s, "evidence")),
      caveats: codeSet(list(own(s, "caveats")).map((c) => own(c, "code")), CAVEATS, CAVEATS.length),
    };
  });
  const skippedIn = list(own(suggestions, "skipped"));
  if (skippedIn.length > AI_CONTEXT_LIMITS.skipped) fail("too-many-entries");
  const skipped = skippedIn
    .map((k) => {
      const path = own(k, "packagePath");
      return { package: path === null ? null : idFor(path), reason: code(own(k, "reason"), SKIP_REASONS) };
    })
    .sort((a, b) => compareText(a.package ?? "", b.package ?? "") || byAllowlist(SKIP_REASONS)(a.reason, b.reason));

  // Safety: rules and levels only; never excerpts, script names or explanation text.
  const safetyStatus = code(own(safety, "status"), SAFETY_STATUSES);
  let safetyContext: AiExplanationContext["safety"];
  if (safetyStatus === "unavailable") {
    safetyContext = { status: "unavailable", reason: code(own(safety, "reason"), SAFETY_UNAVAILABLE) };
  } else {
    const findingsIn = list(own(safety, "findings"));
    if (findingsIn.length > AI_CONTEXT_LIMITS.safetyFindings) fail("too-many-entries");
    const coverage = own(safety, "coverage");
    if (own(coverage, "scanStatus") !== status) fail("invalid-input");
    const limitations = list(own(coverage, "limitations"))
      .map((l) => {
        const n = own(l, "count");
        return { code: code(own(l, "code"), LIMITATIONS), count: n === undefined ? null : count(n) };
      })
      .sort((a, b) => byAllowlist(LIMITATIONS)(a.code, b.code));
    if (new Set(limitations.map((l) => l.code)).size !== limitations.length) fail("invalid-input");
    const findings = findingsIn
      .map((f) => {
        const evidence = own(f, "evidence");
        return {
          package: idFor(own(f, "packagePath")),
          rule: code(own(f, "ruleId"), SAFETY_RULES),
          level: code(own(f, "level"), SAFETY_LEVELS),
          commandExact: bool(own(evidence, "commandExact")),
          shortened: bool(own(evidence, "shortened")),
          altered: bool(own(evidence, "altered")),
        };
      })
      .sort(
        (a, b) =>
          compareText(a.package, b.package) ||
          byAllowlist(SAFETY_RULES)(a.rule, b.rule) ||
          byAllowlist(SAFETY_LEVELS)(a.level, b.level) ||
          Number(a.commandExact) - Number(b.commandExact) ||
          Number(a.shortened) - Number(b.shortened) ||
          Number(a.altered) - Number(b.altered),
      );
    safetyContext = {
      status: safetyStatus,
      findingsOmitted: bool(own(safety, "findingsOmitted")),
      coverageComplete: bool(own(coverage, "complete")),
      limitations,
      findings,
    };
  }

  return {
    format: AI_CONTEXT_FORMAT,
    version: AI_CONTEXT_VERSION,
    scan: {
      status,
      complete,
      partial: bool(own(scan, "partial")),
      limitsHit: codeSet(own(scan, "limitsHit"), SCAN_LIMITS, SCAN_LIMITS.length),
      repositoryKind: code(own(insights, "kind"), REPOSITORY_KINDS),
      otherEcosystems,
      orchestrationTools: codeSet(list(own(insights, "orchestration")).map((o) => own(o, "tool")), ORCHESTRATION_TOOLS, ORCHESTRATION_TOOLS.length),
      uncertainties: codeSet(own(insights, "uncertainties"), UNCERTAINTIES, AI_CONTEXT_LIMITS.uncertainties),
    },
    counts: {
      packages: count(scanPackages.length),
      packagesTruncated: bool(own(scan, "packagesTruncated")),
      manifests: MANIFEST_KINDS.filter((k) => manifestCounts.has(k)).map((kind) => ({ kind, count: count(manifestCounts.get(kind)) })),
      manifestsTruncated: bool(own(scan, "manifestsTruncated")),
      lockfiles: PACKAGE_MANAGERS.filter((m) => lockCounts.has(m)).map((manager) => ({ manager, count: count(lockCounts.get(manager)) })),
      workspaceSignals: codeSet(own(own(scan, "workspace"), "signals"), WORKSPACE_SIGNALS, WORKSPACE_SIGNALS.length),
      declaredPackageManager: declared !== null,
    },
    packages,
    suggestions: {
      complete,
      truncated: bool(own(suggestions, "suggestionsTruncated")),
      items: suggestionItems,
      skipped,
    },
    safety: safetyContext,
  };
}

/** Canonical JSON: the context's fixed key order, no whitespace. */
export function canonicalJson(context: AiExplanationContext): string {
  return JSON.stringify(context);
}

/** The exact UTF-8 bytes a later stage would hash, preview and send. */
export function canonicalBytes(json: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(json);
}

/**
 * Builds the context, or a fixed error. Never throws; never returns any of
 * the input's text; never changes the input.
 */
export function buildAiExplanationContext(input: AiContextInput): AiContextResult {
  try {
    if (typeof input !== "object" || input === null) return { ok: false, error: "invalid-input" };
    const context = freeze(project(input));
    const json = canonicalJson(context);
    const byteLength = canonicalBytes(json).byteLength;
    if (byteLength > AI_CONTEXT_LIMITS.bytes) return { ok: false, error: "context-too-large" };
    return Object.freeze({ ok: true as const, context, canonicalJson: json, byteLength });
  } catch (error) {
    return { ok: false, error: error instanceof ContextFailure ? error.code : "failed" };
  }
}
