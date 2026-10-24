// Stage 3C: the live-state rules around a setup draft, kept out of the Setup
// screen so they can be tested directly. Pure: no React, IPC, storage or
// execution. The Stage 3A planner stays the only judge of eligibility; this
// module only builds its context from the screen's state, records where field
// values came from, and decides when an open review has gone stale.
import type { RepoAnalysisState } from "./repoAnalysis";
import {
  applySetupDraft,
  planSetupDraft,
  type DraftField,
  type FieldOrigin,
  type SetupDraftContext,
  type SetupDraftForm,
  type SetupDraftPlan,
  type SetupDraftPlanResult,
  type SetupDraftRefusal,
  type SetupDraftStaleReason,
} from "./setupDraft";
import type { CommandSuggestion } from "./insights/types";

export type FieldOrigins = Partial<Record<DraftField, FieldOrigin>>;

/**
 * How the form got its values: RepoRunner's starting defaults (first run, no
 * saved setup), blank ("Add New"), or a saved setup being edited. Only the
 * first leaves untouched defaults; saved values count as entered by the user.
 */
export type FormSource = "initial-defaults" | "blank" | "saved";

export function initialFieldOrigins(source: FormSource): FieldOrigins {
  if (source === "initial-defaults") return { installCommand: "initial-default", frontendCommand: "initial-default" };
  if (source === "saved") return { installCommand: "user-entered", frontendCommand: "user-entered" };
  return {};
}

const DRAFT_FIELDS: readonly string[] = ["installCommand", "frontendCommand"];

/** The user typed in `field`: from now on it is theirs, whatever its text. */
export function fieldEdited(origins: FieldOrigins, field: string): FieldOrigins {
  return DRAFT_FIELDS.includes(field) && origins[field as DraftField] !== "user-entered" ? { ...origins, [field]: "user-entered" } : origins;
}

/** The analysis a plan may come from: only a completed one, with its identity. */
export function analysisForDraft(state: RepoAnalysisState): SetupDraftContext["analysis"] {
  return state.phase === "done" ? { id: state.id, repoPath: state.path, result: state.result } : null;
}

export interface SetupScreenDraftState {
  form: SetupDraftForm;
  fieldOrigins: FieldOrigins;
  /** The saved setup being edited, or null while adding a new one. */
  setupId: string | null;
  analysis: RepoAnalysisState;
}

export function draftContext(state: SetupScreenDraftState): SetupDraftContext {
  return { form: state.form, fieldOrigins: state.fieldOrigins, setupId: state.setupId, analysis: analysisForDraft(state.analysis) };
}

/**
 * Plans `suggestion` against the screen's state. Clicking one specific
 * alternative of conflicting package managers is the user's explicit choice of
 * that manager; the planner still checks the suggestion is one the current
 * analysis produced, and the plan keeps the conflict caveat.
 */
export function planFromScreen(suggestion: CommandSuggestion, state: SetupScreenDraftState): SetupDraftPlanResult {
  const options = suggestion.packageManagerAmbiguous && suggestion.packageManager ? { chosenPackageManager: suggestion.packageManager } : {};
  return planSetupDraft(suggestion, draftContext(state), options);
}

export function canUseSuggestion(suggestion: CommandSuggestion, state: SetupScreenDraftState): boolean {
  return planFromScreen(suggestion, state).status === "eligible";
}

/**
 * Why an open review no longer belongs to the screen, or null while it still
 * does: the repository path changed, the analysis was replaced, reset or
 * cancelled (any state but the same completed one), or another setup is
 * selected. Edits to the target field don't close it; Apply refuses them.
 */
export function reviewInvalidation(plan: SetupDraftPlan, state: SetupScreenDraftState): SetupDraftStaleReason | null {
  const { provenance } = plan;
  if (state.form.repoPath.trim() !== provenance.repoPath) return "repository-path-changed";
  const analysis = analysisForDraft(state.analysis);
  if (!analysis || analysis.id !== provenance.analysisId || analysis.result !== provenance.result) return "analysis-changed";
  if (state.setupId !== provenance.setupId) return "setup-changed";
  return null;
}

export type ApplyOutcome =
  | { status: "applied"; form: SetupDraftForm; fieldOrigins: FieldOrigins; field: DraftField }
  | { status: "not-applied"; reason: SetupDraftStaleReason | SetupDraftRefusal; message: string };

const NOT_APPLIED_TEXT: Record<SetupDraftStaleReason | "refused", string> = {
  "repository-path-changed": "The repository folder changed since this was reviewed, so nothing was applied.",
  "analysis-changed": "The analysis changed since this was reviewed, so nothing was applied. Review the suggestion again.",
  "setup-changed": "A different setup is selected now, so nothing was applied.",
  "field-changed": "That field was edited after the review opened, so nothing was applied. Review the suggestion again.",
  refused: "This suggestion can no longer be used, so nothing was applied.",
};

/**
 * Apply time: the plan is re-checked against the live state (never assumed
 * valid because its review is open). Only the target field changes; the
 * applied value then counts as the user's, so a later suggestion warns before
 * replacing it.
 */
export function applyFromScreen(plan: SetupDraftPlan, state: SetupScreenDraftState): ApplyOutcome {
  const out = applySetupDraft(plan, draftContext(state));
  if (out.status === "applied") {
    const field = plan.change.field;
    return { status: "applied", form: out.form, fieldOrigins: { ...state.fieldOrigins, [field]: "user-entered" }, field };
  }
  return { status: "not-applied", reason: out.reason, message: NOT_APPLIED_TEXT[out.status === "stale" ? out.reason : "refused"] };
}
