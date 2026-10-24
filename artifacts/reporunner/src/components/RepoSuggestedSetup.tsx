// "Suggested Setup": a read-only view of Stage 2A/2B insights for the result
// the Analyze Repo panel already holds. No scan, IPC, storage or execution;
// everything from the repository is rendered as plain React text, and there
// are no Run / Save / Copy controls. The only control is the optional "Use in
// Setup…" button (Stage 3B), shown only when the caller passes `actions` and
// its canUse() accepts that suggestion; it just reports the choice so the
// caller can show a review. Without `actions` nothing is clickable.
// Relative imports keep it renderable in tests.
import * as React from "react";
import { detectProjects } from "../lib/insights/detectProjects";
import { suggestCommands, MAX_SUGGESTIONS } from "../lib/insights/suggestCommands";
import type {
  CommandSuggestion,
  Confidence,
  FrameworkDetection,
  ProjectInsights,
  SuggestionSkip,
} from "../lib/insights/types";
import type { RepoScanResult } from "../types";

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };
const APPS_SHOWN = 6;

/**
 * Optional "Use in Setup…" actions. Whether a suggestion can be used is decided
 * by the caller (with the Stage 3A planner and the live Setup state), never
 * here: a button is shown only where canUse() returns true, and clicking it
 * only calls onUse(). canUse() is called while rendering, so it must be pure.
 */
export interface SuggestedSetupActions {
  canUse: (suggestion: CommandSuggestion) => boolean;
  onUse: (suggestion: CommandSuggestion) => void;
}

export const SAFETY_NOTICE = "Suggestions are based on repository files. Commands have not been run, tested or security-checked.";
export const SAFETY_DETAIL =
  "A package script can run any command, and installing can run project and dependency scripts. Confidence describes how strong the evidence is, not whether a command is safe or will work.";
export const INCOMPLETE_NOTICE = "This analysis didn't finish, so some suggestions may be missing and none are rated High.";

// ---------------------------------------------------------------------------
// View model (pure)

export interface AppGroup {
  packagePath: string;
  directory: string;
  name: string | null;
  frameworks: FrameworkDetection[];
  runs: CommandSuggestion[];
  best: Confidence | null;
  notes: string[];
}

export interface SuggestedSetupView {
  scanComplete: boolean;
  apps: AppGroup[];
  orchestration: CommandSuggestion[];
  installs: CommandSuggestion[];
  skipped: SuggestionSkip[];
  truncated: boolean;
  /** True when nothing at all could be suggested. */
  empty: boolean;
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const PURPOSE_ORDER = { develop: 0, start: 1, install: 2 } as const;

export function buildSuggestedSetupView(result: RepoScanResult, insights: ProjectInsights = detectProjects(result)): SuggestedSetupView {
  const set = suggestCommands(result, insights);
  const byPath = new Map(insights.packages.map((p) => [p.packagePath, p]));
  const groups = new Map<string, AppGroup>();

  for (const suggestion of set.suggestions) {
    if (suggestion.source !== "script" || suggestion.orchestration) continue;
    let group = groups.get(suggestion.packagePath);
    if (!group) {
      const insight = byPath.get(suggestion.packagePath);
      const notes: string[] = [];
      if (insight?.uncertainties.includes("scripts-truncated")) notes.push("Its script list was cut short; other scripts may exist.");
      if (insight?.uncertainties.includes("dependencies-truncated")) notes.push("Its dependency list was cut short; framework detection may be incomplete.");
      if (insight?.packageManager.status === "conflict") notes.push("Package-manager evidence conflicts; each alternative is shown.");
      group = { packagePath: suggestion.packagePath, directory: suggestion.directory, name: suggestion.packageName, frameworks: insight?.frameworks ?? [], runs: [], best: null, notes };
      groups.set(suggestion.packagePath, group);
    }
    group.runs.push(suggestion);
    if (suggestion.confidence && (group.best === null || RANK[suggestion.confidence] > RANK[group.best])) group.best = suggestion.confidence;
  }

  const apps = [...groups.values()];
  for (const app of apps) {
    // Stable: develop before start; otherwise the engine's preference order.
    app.runs = app.runs.map((s, i) => [s, i] as const).sort(([a, i], [b, j]) => PURPOSE_ORDER[a.purpose] - PURPOSE_ORDER[b.purpose] || i - j).map(([s]) => s);
  }
  // Strongest evidence first; packages with no buildable command last.
  apps.sort((a, b) => (b.best === null ? -1 : RANK[b.best]) - (a.best === null ? -1 : RANK[a.best]) || (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0));

  const orchestration = set.suggestions.filter((s) => s.source === "script" && s.orchestration);
  const installs = set.suggestions.filter((s) => s.source === "install");
  return {
    scanComplete: set.scanComplete,
    apps,
    orchestration,
    installs,
    skipped: set.skipped,
    truncated: set.suggestionsTruncated,
    empty: apps.length === 0 && orchestration.length === 0 && installs.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Rendering

export const CONFIDENCE_STYLE: Record<Confidence, { label: string; color: string; border: string }> = {
  high: { label: "High confidence", color: "#9bd59b", border: "#1d2a1d" },
  medium: { label: "Medium confidence", color: "#ffb06a", border: "#3a2a14" },
  low: { label: "Low confidence: weak evidence", color: "#ff8a94", border: "#4a1218" },
};

const muted = { color: "#5a5856" } as const;
const subtle = { color: "#858280" } as const;
const body = { color: "#b8b4af" } as const;

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-medium uppercase" style={{ color: "#706d69", letterSpacing: "0.08em" }}>
      {children}
    </p>
  );
}

function ConfidenceBadge({ confidence }: { confidence: Confidence | null }) {
  if (!confidence) {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ border: "1px solid #2a2626", ...muted }} data-testid="suggestion-confidence">
        No confidence: no command
      </span>
    );
  }
  const style = CONFIDENCE_STYLE[confidence];
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ border: `1px solid ${style.border}`, color: style.color }} data-testid="suggestion-confidence">
      {style.label}
    </span>
  );
}

/** "Use in Setup…" for one suggestion. Clicking only reports the choice; nothing is applied. */
export function UseInSetupButton({ suggestion, onUse }: { suggestion: CommandSuggestion; onUse: (suggestion: CommandSuggestion) => void }) {
  return (
    <button
      type="button"
      className="rounded px-2 py-0.5 text-[10px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ background: "#160a0c", border: "1px solid #4a1a20", color: "#e6c9cc" }}
      onClick={() => onUse(suggestion)}
      aria-label={`Use in Setup: review ${suggestion.command ?? "this suggestion"} before it fills a Setup field`}
      data-testid="suggestion-use"
      data-suggestion-id={suggestion.id}
    >
      Use in Setup…
    </button>
  );
}

function CommandRow({ suggestion, actions }: { suggestion: CommandSuggestion; actions?: SuggestedSetupActions }) {
  const unavailable =
    suggestion.unavailableReason === "package-manager-unknown"
      ? "No command: the package manager is unknown"
      : suggestion.unavailableReason === "unsafe-script-name"
        ? "No command: the script name needs manual review"
        : null;
  return (
    <div className="space-y-1 rounded border px-2 py-1.5" style={{ borderColor: "#1a1717", background: "#090808" }} data-testid="suggestion-row">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {suggestion.command ? (
          <code className="max-w-full break-all rounded px-1.5 py-0.5 text-[11px]" style={{ ...MONO, background: "#0f0f0f", border: "1px solid #241f1f", color: "#dedad5" }} data-testid="suggestion-command">
            {suggestion.command}
          </code>
        ) : (
          <span className="text-[11px]" style={{ color: "#ffb06a" }} data-testid="suggestion-unavailable">
            {unavailable}
          </span>
        )}
        <ConfidenceBadge confidence={suggestion.confidence} />
        {suggestion.packageManager && (
          <span className="text-[10px]" style={subtle}>
            {suggestion.packageManager}
            {suggestion.packageManagerAmbiguous ? " (one of several alternatives)" : ""}
          </span>
        )}
        <span className="text-[10px]" style={muted}>
          {suggestion.purpose === "develop" ? "develop" : suggestion.purpose === "start" ? "start" : "install"}
          {suggestion.scriptName ? ` · script ${JSON.stringify(suggestion.scriptName)}` : ""}
        </span>
        {actions && actions.canUse(suggestion) && <UseInSetupButton suggestion={suggestion} onUse={actions.onUse} />}
      </div>
      <details>
        <summary className="cursor-pointer text-[10px]" style={subtle}>
          Why this suggestion?
        </summary>
        <div className="mt-1 space-y-1 pl-2 text-[11px]">
          <ul className="list-disc space-y-0.5 pl-4" style={body}>
            {suggestion.evidence.map((e, i) => (
              <li key={i}>{e.text}</li>
            ))}
          </ul>
          {suggestion.scriptCommandText !== null && (
            <p className="break-all" style={subtle}>
              {suggestion.scriptCommandExact === true ? "The script runs: " : "The script's command, changed for display (not an exact copy): "}
              <span style={{ ...MONO, color: "#9a9896" }}>{suggestion.scriptCommandText}</span>
            </p>
          )}
          <ul className="list-disc space-y-0.5 pl-4" style={{ color: "#c8a2a6" }} data-testid="suggestion-caveats">
            {suggestion.caveats.map((c, i) => (
              <li key={i}>{c.text}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

function AppCard({ app, actions }: { app: AppGroup; actions?: SuggestedSetupActions }) {
  return (
    <div className="space-y-1.5 rounded-md px-3 py-2" style={{ background: "#080808", border: "1px solid #1a1717" }} data-testid="suggestion-app" data-directory={app.directory}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="max-w-full truncate text-xs font-medium" style={{ color: "#dedad5" }}>
          {app.name ?? "(unnamed package)"}
        </span>
        <span className="max-w-full truncate text-[11px]" style={{ ...MONO, ...muted }}>
          {app.directory === "." ? "repository root" : app.directory}
        </span>
      </div>
      {app.frameworks.length > 0 && (
        <p className="text-[11px]" style={subtle}>
          {app.frameworks.map((f) => `${f.label} (${f.confidence})`).join(", ")}
        </p>
      )}
      {app.notes.map((note, i) => (
        <p key={i} className="text-[10px]" style={{ color: "#ffb06a" }}>
          {note}
        </p>
      ))}
      <div className="space-y-1">
        {app.runs.map((s) => (
          <CommandRow key={s.id} suggestion={s} actions={actions} />
        ))}
      </div>
    </div>
  );
}

export function RepoSuggestedSetup({ result, actions }: { result: RepoScanResult; actions?: SuggestedSetupActions }) {
  const view = React.useMemo(() => buildSuggestedSetupView(result), [result]);
  const shownApps = view.apps.slice(0, APPS_SHOWN);
  const moreApps = view.apps.slice(APPS_SHOWN);

  return (
    <section className="min-w-0 space-y-2.5 rounded-md px-3 py-2.5" style={{ background: "#0a0909", border: "1px solid #241a1b" }} aria-label="Suggested Setup" data-testid="suggested-setup">
      <div className="space-y-1">
        <p className="text-xs font-semibold" style={{ color: "#dedad5" }}>
          Suggested Setup
        </p>
        <p className="text-[11px] font-medium" style={{ color: "#c8a2a6" }} data-testid="suggested-setup-notice">
          {SAFETY_NOTICE}
        </p>
        <p className="text-[10px] leading-snug" style={subtle}>
          {SAFETY_DETAIL}
        </p>
        {!view.scanComplete && (
          <p className="text-[11px]" style={{ color: "#ffb06a" }} data-testid="suggested-setup-incomplete">
            {INCOMPLETE_NOTICE}
          </p>
        )}
        {view.truncated && (
          <p className="text-[11px]" style={{ color: "#ffb06a" }}>
            Only the first {MAX_SUGGESTIONS} suggestions are shown.
          </p>
        )}
      </div>

      {view.empty && (
        <p className="text-[11px]" style={body} data-testid="suggested-setup-empty">
          No setup suggestions could be made for this repository.
        </p>
      )}

      {view.apps.length > 0 && (
        <div className="space-y-1.5" data-testid="suggestion-apps">
          <SubHeading>Applications</SubHeading>
          {shownApps.map((app) => (
            <AppCard key={app.packagePath} app={app} actions={actions} />
          ))}
          {moreApps.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px]" style={subtle}>
                Show {moreApps.length} more {moreApps.length === 1 ? "package" : "packages"}
              </summary>
              <div className="mt-1.5 space-y-1.5">
                {moreApps.map((app) => (
                  <AppCard key={app.packagePath} app={app} actions={actions} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {view.orchestration.length > 0 && (
        <div className="space-y-1" data-testid="suggestion-orchestration">
          <SubHeading>Run several packages at once (root scripts)</SubHeading>
          <p className="text-[10px]" style={muted}>
            These root scripts start packages through a workspace tool. Which packages they start isn't known.
          </p>
          {view.orchestration.map((s) => (
            <CommandRow key={s.id} suggestion={s} />
          ))}
        </div>
      )}

      {view.installs.length > 0 && (
        <div className="space-y-1" data-testid="suggestion-installs">
          <SubHeading>Install dependencies</SubHeading>
          {view.installs.map((s) => (
            <div key={s.id} className="space-y-0.5">
              <p className="text-[10px]" style={{ ...MONO, ...muted }}>
                {s.directory === "." ? "repository root" : s.directory}
              </p>
              <CommandRow suggestion={s} actions={actions} />
            </div>
          ))}
        </div>
      )}

      {view.skipped.length > 0 && (
        <details data-testid="suggestion-skipped">
          <summary className="cursor-pointer text-[11px]" style={subtle}>
            Not suggested ({view.skipped.length})
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]" style={body}>
            {view.skipped.map((skip, i) => (
              <li key={i} className="break-all">
                {skip.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
