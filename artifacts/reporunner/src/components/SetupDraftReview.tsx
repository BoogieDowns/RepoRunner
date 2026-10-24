// Stage 3B: reviews one Stage 3A setup-draft plan before it is applied. Purely
// presentational: it shows the field, the exact before and after values and
// the evidence, and reports the user's choice through onApply / onCancel. It
// never changes the form, saves, installs, runs anything or calls IPC; the
// caller re-checks the plan against live state when Apply is chosen. Nothing
// happens because it is shown, and it has no hooks, so it renders the same
// everywhere.
// Relative imports keep it renderable in tests.
import * as React from "react";
import type { DraftField, SetupDraftPlan, ValueKind } from "../lib/setupDraft";
import { CONFIDENCE_STYLE, INCOMPLETE_NOTICE } from "./RepoSuggestedSetup";

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };
const body = { color: "#b8b4af" } as const;
const subtle = { color: "#858280" } as const;
const warn = { color: "#ffb06a" } as const;
const EVIDENCE_SHOWN = 4;

/** The Setup form's own labels for the fields a draft can change. */
export const DRAFT_FIELD_LABEL: Record<DraftField, string> = {
  installCommand: "Install Command",
  frontendCommand: "Frontend Command",
};

const PURPOSE_TEXT: Record<SetupDraftPlan["purpose"], string> = {
  install: "Install dependencies (a standard install command)",
  develop: "Start a development server (a package.json script)",
  start: "Start the app (a package.json script)",
};

export const CURRENT_KIND_TEXT: Record<ValueKind, string> = {
  blank: "Currently blank",
  "initial-default": "RepoRunner's starting value, not edited yet",
  "user-entered": "A value you entered or saved",
};

export function reviewSafetyText(field: DraftField): string[] {
  return [
    `Apply to Setup only fills the ${DRAFT_FIELD_LABEL[field]} field in this form. You can still edit it.`,
    "It doesn't save the setup: use Save Configuration when you're ready.",
    "It doesn't install dependencies or run any command.",
    "Ports, Preview URL, Backend Command and the repository folder aren't changed.",
  ];
}

export interface SetupDraftReviewProps {
  plan: SetupDraftPlan;
  /** The user chose Apply. The caller re-checks the plan before changing the form. */
  onApply: () => void;
  /** The user chose Cancel. Nothing is changed. */
  onCancel: () => void;
}

function ValueBox({ label, value, testId, emphasis }: { label: string; value: string; testId: string; emphasis?: boolean }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-[10px] font-medium uppercase" style={{ color: "#706d69", letterSpacing: "0.08em" }}>
        {label}
      </p>
      <code
        className="block max-w-full whitespace-pre-wrap break-all rounded px-1.5 py-1 text-[11px]"
        style={{ ...MONO, background: "#0f0f0f", border: `1px solid ${emphasis ? "#6a3a14" : "#241f1f"}`, color: value === "" ? "#5a5856" : "#dedad5" }}
        data-testid={testId}
      >
        {value === "" ? "(blank)" : value}
      </code>
    </div>
  );
}

export function SetupDraftReview({ plan, onApply, onCancel }: SetupDraftReviewProps) {
  const { change } = plan;
  const fieldLabel = DRAFT_FIELD_LABEL[change.field];
  const unchanged = change.currentValue === change.proposedValue;
  const replacesUserValue = change.currentKind === "user-entered" && !unchanged;
  const confidence = CONFIDENCE_STYLE[plan.confidence];
  const headingId = `setup-draft-review-${plan.provenance.suggestionId}`;

  return (
    <section
      className="min-w-0 space-y-2 rounded-md px-3 py-2.5"
      style={{ background: "#0b0909", border: "1px solid #3a2224" }}
      aria-labelledby={headingId}
      data-testid="setup-draft-review"
      data-field={change.field}
    >
      <p id={headingId} className="text-xs font-semibold" style={{ color: "#dedad5" }}>
        Review change to {fieldLabel}
      </p>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
        <span style={body} data-testid="setup-draft-purpose">
          {PURPOSE_TEXT[plan.purpose]}
        </span>
        <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ border: `1px solid ${confidence.border}`, color: confidence.color }} data-testid="setup-draft-confidence">
          {confidence.label}
        </span>
        <span className="text-[10px]" style={subtle}>
          {plan.packageManager}
          {plan.scriptName !== null ? ` · script ${JSON.stringify(plan.scriptName)}` : ""}
        </span>
      </div>

      {plan.confidence === "low" && (
        <p className="text-[11px]" style={warn} data-testid="setup-draft-low">
          Weak evidence: check that this command is right for this repository before you use it.
        </p>
      )}
      {!plan.scanComplete && (
        <p className="text-[11px]" style={warn} data-testid="setup-draft-incomplete">
          {INCOMPLETE_NOTICE}
        </p>
      )}
      {plan.suggestion.packageManagerAmbiguous && (
        <p className="text-[11px]" style={warn} data-testid="setup-draft-manager-choice">
          The package-manager evidence conflicts. This uses {plan.packageManager}, the alternative you chose.
        </p>
      )}

      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <div className="min-w-0 space-y-0.5">
          <ValueBox label={`Current ${fieldLabel}`} value={change.currentValue} testId="setup-draft-current" emphasis={replacesUserValue} />
          <p className="text-[10px]" style={replacesUserValue ? warn : subtle} data-testid="setup-draft-current-kind">
            {CURRENT_KIND_TEXT[change.currentKind]}
            {replacesUserValue ? ". It will be replaced." : ""}
          </p>
        </div>
        <ValueBox label={`Proposed ${fieldLabel}`} value={change.proposedValue} testId="setup-draft-proposed" />
      </div>
      {unchanged && (
        <p className="text-[11px]" style={subtle} data-testid="setup-draft-unchanged">
          The field already has this value, so applying changes nothing.
        </p>
      )}

      {plan.evidence.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[10px]" style={subtle}>
            Evidence
          </p>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px]" style={body} data-testid="setup-draft-evidence">
            {plan.evidence.slice(0, EVIDENCE_SHOWN).map((e, i) => (
              <li key={i} className="break-words">
                {e.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.caveats.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[10px]" style={subtle}>
            Caveats
          </p>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px]" style={{ color: "#c8a2a6" }} data-testid="setup-draft-caveats">
            {plan.caveats.map((c, i) => (
              <li key={i} className="break-words">
                {c.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="list-disc space-y-0.5 pl-4 text-[10px] leading-snug" style={subtle} data-testid="setup-draft-safety">
        {reviewSafetyText(change.field).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="rounded px-3 py-1 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ background: "#0d0d0d", border: "1px solid #2a2a2a", color: "#b8b4af" }}
          onClick={onCancel}
          aria-label={`Cancel: keep the current ${fieldLabel}`}
          data-testid="setup-draft-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded px-3 py-1 text-[11px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ background: "#2a0b10", border: "1px solid #9f0d1c", color: "#f4e9ea" }}
          onClick={onApply}
          aria-label={`Apply to Setup: put ${change.proposedValue} in ${fieldLabel}`}
          data-testid="setup-draft-apply"
        >
          Apply to Setup
        </button>
      </div>
    </section>
  );
}
