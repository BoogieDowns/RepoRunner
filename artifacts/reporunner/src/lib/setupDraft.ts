// Stage 3A: turns one read-only Suggested Setup suggestion into a proposed
// change to the Setup form, for the user to review. Pure and deterministic: no
// IPC, filesystem, storage, saving or execution. Nothing here trusts a
// suggestion object as given: a plan is only made for a suggestion that is
// exactly one Stage 2 derives from the analysis it claims to come from, whose
// command matches a fixed template, and applying re-checks everything against
// the live form and analysis.
//
// Only the repository root can be mapped: every Setup command runs in the
// repository folder, so a nested package's command has no field to go in.
// Only installCommand and frontendCommand can change; every other field is
// left exactly as it is.
import type { PackageManagerName, RepoScanResult } from "../types";
import { SAFE_SCRIPT_NAME, suggestCommands } from "./insights/suggestCommands";
import type { Caveat, CommandSuggestion, Confidence, Evidence, SuggestionPurpose } from "./insights/types";

/** The Setup form's fields, as the form holds them (all strings). Mirrors SetupScreen's form state. */
export interface SetupDraftForm {
  name: string;
  repoPath: string;
  installCommand: string;
  frontendCommand: string;
  backendCommand: string;
  previewUrl: string;
  frontendPort: string;
  backendPort: string;
}

/** The only fields a draft can change. */
export type DraftField = "installCommand" | "frontendCommand";

/**
 * Where a field's current value came from, as recorded by the form (never
 * guessed from the value): "initial-default" for a value RepoRunner pre-filled
 * and the user hasn't edited, "user-entered" for anything typed, chosen or
 * saved. A blank value is "blank" whatever its origin.
 */
export type FieldOrigin = "initial-default" | "user-entered";
export type ValueKind = "blank" | FieldOrigin;

/** The live state a plan is made against and re-checked against at Apply time. */
export interface SetupDraftContext {
  /** The form as it is now. */
  form: Readonly<SetupDraftForm>;
  /** Recorded origins of the form's values. A field without one counts as user-entered. */
  fieldOrigins: Readonly<Partial<Record<DraftField, FieldOrigin>>>;
  /** The saved setup being edited, or null for a new, unsaved one. */
  setupId: string | null;
  /** The completed analysis the suggestion comes from, or null when there is none. */
  analysis: {
    /** Identifies this analysis run; a new run at the same path has a different id. */
    id: string;
    /** The repository path that was analyzed (as the form held it). */
    repoPath: string;
    result: RepoScanResult;
  } | null;
}

export interface SetupDraftOptions {
  /** Required when the suggestion is one of several package-manager alternatives: the manager the user chose. */
  chosenPackageManager?: PackageManagerName;
}

export type SetupDraftRefusal =
  | "no-analysis"
  | "analysis-path-mismatch"
  | "not-from-analysis"
  | "not-repository-root"
  | "orchestration"
  | "no-command"
  | "command-unavailable"
  | "package-manager-unknown"
  | "package-manager-choice-required"
  | "unsupported-command"
  | "unsafe-script-name"
  | "script-name-unverified";

export interface SetupDraftChange {
  field: DraftField;
  currentValue: string;
  proposedValue: string;
  currentKind: ValueKind;
}

export interface SetupDraftPlan {
  status: "eligible";
  change: SetupDraftChange;
  purpose: SuggestionPurpose;
  /** Always set for an eligible plan; Stage 2 never builds a command without one. */
  confidence: Confidence;
  /** False when the analysis didn't finish: some suggestions may be missing and none are rated High. */
  scanComplete: boolean;
  packageManager: PackageManagerName;
  scriptName: string | null;
  evidence: readonly Evidence[];
  caveats: readonly Caveat[];
  /** What the plan was made against; Apply refuses if any of it changed. */
  provenance: {
    analysisId: string;
    repoPath: string;
    setupId: string | null;
    suggestionId: string;
    result: RepoScanResult;
  };
  /** The suggestion the plan was made from, for re-planning at Apply time. */
  suggestion: CommandSuggestion;
  options: SetupDraftOptions;
}

export type SetupDraftPlanResult = SetupDraftPlan | { status: "refused"; reason: SetupDraftRefusal };

export type SetupDraftStaleReason = "repository-path-changed" | "analysis-changed" | "setup-changed" | "field-changed";

export type SetupDraftApplyResult =
  | { status: "applied"; form: SetupDraftForm }
  | { status: "stale"; reason: SetupDraftStaleReason }
  | { status: "refused"; reason: SetupDraftRefusal };

// Fixed command templates, checked here independently of Stage 2.
const MANAGERS: readonly PackageManagerName[] = ["npm", "pnpm", "yarn", "bun"];
const installCommandFor = (manager: PackageManagerName) => `${manager} install`;
const runCommandFor = (manager: PackageManagerName, script: string) => `${manager} run ${script}`;

const refused = (reason: SetupDraftRefusal): SetupDraftPlanResult => ({ status: "refused", reason });
const isManager = (value: unknown): value is PackageManagerName => typeof value === "string" && (MANAGERS as readonly string[]).includes(value);

/**
 * The suggestion Stage 2 derives from `result` with this suggestion's id, if
 * it is identical to the one given (field for field), else null. A forged,
 * edited or out-of-date object never matches.
 */
function derivedMatch(suggestion: CommandSuggestion, result: RepoScanResult): CommandSuggestion | null {
  if (typeof suggestion?.id !== "string") return null;
  const derived = suggestCommands(result).suggestions.find((s) => s.id === suggestion.id);
  return derived && JSON.stringify(derived) === JSON.stringify(suggestion) ? derived : null;
}

function valueKind(context: SetupDraftContext, field: DraftField): ValueKind {
  if (context.form[field].trim() === "") return "blank";
  return context.fieldOrigins[field] === "initial-default" ? "initial-default" : "user-entered";
}

/**
 * The Setup field a suggestion's command belongs in, if the command is exactly
 * one of the fixed templates: "<manager> install" for an install, "<manager>
 * run <script>" with an allowlisted script name for a develop or start script.
 * Checked on its own, independently of where the suggestion came from.
 */
export function checkCommandTemplate(suggestion: CommandSuggestion): { field: DraftField } | { reason: SetupDraftRefusal } {
  const s = suggestion;
  if (!isManager(s.packageManager) || typeof s.command !== "string") return { reason: "unsupported-command" };
  if (s.source === "install" && s.purpose === "install" && s.scriptName === null) {
    return s.command === installCommandFor(s.packageManager) ? { field: "installCommand" } : { reason: "unsupported-command" };
  }
  if (s.source === "script" && (s.purpose === "develop" || s.purpose === "start") && typeof s.scriptName === "string") {
    if (!SAFE_SCRIPT_NAME.test(s.scriptName)) return { reason: "unsafe-script-name" };
    return s.command === runCommandFor(s.packageManager, s.scriptName) ? { field: "frontendCommand" } : { reason: "unsupported-command" };
  }
  return { reason: "unsupported-command" };
}

/**
 * Whether `suggestion` can fill a Setup field, and the change it would make.
 * Refuses (with a stable reason) anything that isn't a root install, develop
 * or start command built from a fixed template for the current analysis.
 */
export function planSetupDraft(suggestion: CommandSuggestion, context: SetupDraftContext, options: SetupDraftOptions = {}): SetupDraftPlanResult {
  const analysis = context.analysis;
  if (!analysis) return refused("no-analysis");
  if (analysis.repoPath.trim() === "" || analysis.repoPath.trim() !== context.form.repoPath.trim()) return refused("analysis-path-mismatch");
  const s = derivedMatch(suggestion, analysis.result);
  if (!s) return refused("not-from-analysis");

  if (s.directory !== "." || s.packagePath !== "package.json") return refused("not-repository-root");
  if (s.orchestration !== null) return refused("orchestration");
  if (s.unavailableReason === "package-manager-unknown") return refused("package-manager-unknown");
  if (s.unavailableReason !== null) return refused("command-unavailable");
  if (s.command === null || s.confidence === null) return refused("no-command");
  if (!isManager(s.packageManager)) return refused("package-manager-unknown");
  if (s.packageManagerAmbiguous && options.chosenPackageManager !== s.packageManager) return refused("package-manager-choice-required");

  const template = checkCommandTemplate(s);
  if ("reason" in template) return refused(template.reason);
  const field = template.field;
  if (field === "frontendCommand") {
    // The script must exist in the root package.json under exactly this name, once.
    const root = analysis.result.packages.find((p) => p.path === "package.json");
    const named = root?.scripts.filter((script) => script.name === s.scriptName) ?? [];
    if (named.length !== 1 || named[0].nameExact !== true) return refused("script-name-unverified");
  }

  return {
    status: "eligible",
    change: { field, currentValue: context.form[field], proposedValue: s.command, currentKind: valueKind(context, field) },
    purpose: s.purpose,
    confidence: s.confidence,
    scanComplete: !s.scanIncomplete && analysis.result.status === "complete",
    packageManager: s.packageManager,
    scriptName: s.scriptName,
    evidence: s.evidence,
    caveats: s.caveats,
    provenance: { analysisId: analysis.id, repoPath: analysis.repoPath.trim(), setupId: context.setupId, suggestionId: s.id, result: analysis.result },
    suggestion: s,
    options: { ...options },
  };
}

/**
 * Applies an approved plan to a copy of `context.form`, after checking that
 * nothing it was made against has changed: the repository path, the analysis
 * (id and result), the setup being edited, and the target field's value. The
 * suggestion is then planned again against the live context and must propose
 * the same change. Only the target field differs in the returned form.
 */
export function applySetupDraft(plan: SetupDraftPlan, context: SetupDraftContext): SetupDraftApplyResult {
  const { provenance, change } = plan;
  if (context.form.repoPath.trim() !== provenance.repoPath) return { status: "stale", reason: "repository-path-changed" };
  if (!context.analysis || context.analysis.id !== provenance.analysisId || context.analysis.result !== provenance.result) {
    return { status: "stale", reason: "analysis-changed" };
  }
  if (context.setupId !== provenance.setupId) return { status: "stale", reason: "setup-changed" };
  if (context.form[change.field] !== change.currentValue) return { status: "stale", reason: "field-changed" };

  const again = planSetupDraft(plan.suggestion, context, plan.options);
  if (again.status === "refused") return again;
  if (again.change.field !== change.field || again.change.proposedValue !== change.proposedValue || again.provenance.suggestionId !== provenance.suggestionId) {
    return { status: "stale", reason: "analysis-changed" };
  }
  return { status: "applied", form: { ...context.form, [change.field]: change.proposedValue } };
}
