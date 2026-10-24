// Analyze Repo controls and results for the Setup screen. Everything taken
// from the repository is rendered as plain React text: no HTML, no links,
// no buttons that act on it. Relative imports keep it renderable in tests.
import * as React from "react";
import { Loader2, ScanSearch, X } from "lucide-react";
import type { PackageSummary, RepoScanResult } from "../types";
import { RepoSuggestedSetup, type SuggestedSetupActions } from "./RepoSuggestedSetup";
import {
  MAX_DEPENDENCIES_SHOWN,
  packageManagerSummary,
  summarizeStatus,
  warningText,
  WORKSPACE_PATTERNS_NOTE,
  type RepoAnalysisState,
} from "../lib/repoAnalysis";

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

export const LOCAL_ANALYSIS_NOTE = "RepoRunner inspects project files locally. No commands are run or saved.";

export function AnalyzeRepoButton({
  disabled,
  running,
  onClick,
}: {
  disabled: boolean;
  running: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid="analyze-repo"
      className="inline-flex h-10 flex-none items-center justify-center whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{ background: "#0d0809", border: "1px solid #351318", color: "#c8a2a6" }}
    >
      {running ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 flex-none animate-spin" aria-hidden="true" />
      ) : (
        <ScanSearch className="mr-1.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
      )}
      {running ? "Analyzing..." : "Analyze Repo"}
    </button>
  );
}

const sectionLabel: React.CSSProperties = {
  color: "#706d69",
  fontSize: "10px",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="font-medium" style={sectionLabel}>
        {title}
      </p>
      {children}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-block max-w-full truncate rounded px-1.5 py-0.5 text-[11px]"
      style={{ ...MONO, background: "#0f0f0f", border: "1px solid #1f1c1b", color: "#b8b4af" }}
    >
      {children}
    </span>
  );
}

function DependencyList({ label, names, truncated }: { label: string; names: string[]; truncated: boolean }) {
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX_DEPENDENCIES_SHOWN);
  const hidden = names.length - shown.length;
  return (
    <div className="space-y-1">
      <p className="text-[11px]" style={{ color: "#858280" }}>
        {label} ({names.length}
        {truncated ? "+" : ""})
      </p>
      <div className="flex flex-wrap gap-1">
        {shown.map((name, index) => (
          <Chip key={`${index}:${name}`}>{name}</Chip>
        ))}
        {hidden > 0 && (
          <span className="text-[11px]" style={{ color: "#5a5856" }}>
            +{hidden} more
          </span>
        )}
      </div>
    </div>
  );
}

function PackageCard({ pkg, open }: { pkg: PackageSummary; open: boolean }) {
  return (
    <details
      open={open}
      className="rounded-md"
      style={{ background: "#080808", border: "1px solid #1a1717" }}
      data-testid="analysis-package"
    >
      <summary className="cursor-pointer px-3 py-2 text-xs" style={{ color: "#dedad5" }}>
        <span className="font-medium">{pkg.name ?? "(unnamed package)"}</span>
        {pkg.version && (
          <span className="ml-2" style={{ ...MONO, color: "#706d69" }}>
            {pkg.version}
          </span>
        )}
        <span className="ml-2" style={{ ...MONO, color: "#5a5856", fontSize: "11px" }}>
          {pkg.path}
        </span>
      </summary>
      <div className="space-y-2 px-3 pb-3">
        {(pkg.packageManager || pkg.engines.node) && (
          <p className="text-[11px]" style={{ color: "#858280" }}>
            {pkg.packageManager && <>packageManager: <span style={MONO}>{pkg.packageManager}</span> </>}
            {pkg.engines.node && <>node: <span style={MONO}>{pkg.engines.node}</span></>}
          </p>
        )}
        {pkg.scripts.length > 0 ? (
          <div className="space-y-1">
            <p className="text-[11px]" style={{ color: "#858280" }}>
              Scripts ({pkg.scripts.length}
              {pkg.scriptsTruncated ? "+" : ""}) — shown for reference, not run
            </p>
            <table className="w-full table-fixed text-[11px]" style={MONO}>
              <tbody>
                {pkg.scripts.map((script, index) => (
                  <tr key={`${index}:${script.name}`} className="align-top">
                    <td className="w-1/4 truncate py-0.5 pr-2" style={{ color: "#c8a2a6" }}>
                      {script.name}
                    </td>
                    <td className="break-all py-0.5" style={{ color: "#9a9896" }}>
                      {script.command}
                      {script.commandExact !== true && (
                        <span style={{ color: "#5a5856" }} data-testid="script-command-altered">
                          {" "}
                          (changed for display)
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[11px]" style={{ color: "#5a5856" }}>
            No scripts.
          </p>
        )}
        <DependencyList label="Dependencies" names={pkg.dependencies} truncated={pkg.dependenciesTruncated} />
        <DependencyList label="Dev dependencies" names={pkg.devDependencies} truncated={pkg.dependenciesTruncated} />
        {pkg.workspaces.length > 0 && (
          <p className="text-[11px]" style={{ color: "#858280" }}>
            Workspaces{pkg.workspacesTruncated ? " (first 50)" : ""}: <span style={MONO}>{pkg.workspaces.join(", ")}</span>
          </p>
        )}
      </div>
    </details>
  );
}

const TONE_COLORS = {
  ok: { border: "#1d2a1d", text: "#9bd59b" },
  partial: { border: "#3a2a14", text: "#ffb06a" },
  stopped: { border: "#4a1218", text: "#ff8a94" },
} as const;

function Results({ result, suggestionActions }: { result: RepoScanResult; suggestionActions?: SuggestedSetupActions }) {
  const status = summarizeStatus(result);
  const colors = TONE_COLORS[status.tone];
  const manager = packageManagerSummary(result);
  const otherManifests = result.manifests.filter((m) => m.kind !== "package-json");

  return (
    <div className="space-y-4">
      <div
        className="rounded-md px-3 py-2"
        style={{ background: "#0a0909", border: `1px solid ${colors.border}` }}
        role="status"
        data-testid="analysis-status"
      >
        <p className="text-xs font-semibold" style={{ color: colors.text }}>
          {status.title}
          <span className="ml-2 font-normal" style={{ color: "#858280" }}>
            {result.rootName}
          </span>
        </p>
        {status.notes.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]" style={{ color: "#b8b4af" }}>
            {status.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[10px]" style={{ color: "#5a5856" }}>
          {result.stats.directoriesVisited} folders, {result.stats.entriesExamined} entries, {result.stats.filesRead} files read
          in {result.stats.durationMs} ms
        </p>
      </div>

      <RepoSuggestedSetup result={result} actions={suggestionActions} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Section title="Package manager">
          <p className="text-xs" style={{ ...MONO, color: "#b8b4af" }}>
            {manager ?? "Not detected"}
          </p>
          {result.packageManager.lockfiles.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {result.packageManager.lockfiles.map((lock, index) => (
                <Chip key={`${index}:${lock.path}`}>{lock.path}</Chip>
              ))}
            </div>
          )}
        </Section>
        <Section title="Workspace">
          <p className="text-xs" style={{ color: "#b8b4af" }}>
            {result.workspace.signals.length > 0 ? result.workspace.signals.join(", ") : "No workspace signals"}
          </p>
          {result.workspace.patterns.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {result.workspace.patterns.map((pattern, index) => (
                <Chip key={`${index}:${pattern}`}>{pattern}</Chip>
              ))}
            </div>
          )}
          {result.workspace.patternsTruncated && (
            <p className="text-[10px]" style={{ color: "#5a5856" }}>
              {WORKSPACE_PATTERNS_NOTE}
            </p>
          )}
        </Section>
        <Section title="Node version">
          {result.nodeVersionFiles.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {result.nodeVersionFiles.map((file, index) => (
                <Chip key={`${index}:${file.path}`}>
                  {file.path}: {file.version ?? "unrecognized"}
                </Chip>
              ))}
            </div>
          ) : (
            <p className="text-xs" style={{ color: "#5a5856" }}>
              No .nvmrc or .node-version
            </p>
          )}
        </Section>
        <Section title="Environment files">
          {result.envFiles.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1">
                {result.envFiles.map((name, index) => (
                  <Chip key={`${index}:${name}`}>{name}</Chip>
                ))}
              </div>
              <p className="text-[10px]" style={{ color: "#5a5856" }}>
                Names only. Their contents are never opened.
              </p>
            </>
          ) : (
            <p className="text-xs" style={{ color: "#5a5856" }}>
              None found
            </p>
          )}
        </Section>
      </div>

      <Section title={`Packages (${result.packages.length}${result.packagesTruncated ? "+" : ""})`}>
        {result.packages.length > 0 ? (
          <div className="space-y-2">
            {result.packages.map((pkg, index) => (
              <PackageCard key={`${index}:${pkg.path}`} pkg={pkg} open={index === 0} />
            ))}
          </div>
        ) : (
          <p className="text-xs" style={{ color: "#5a5856" }}>
            No readable package.json found.
          </p>
        )}
      </Section>

      {otherManifests.length > 0 && (
        <Section title="Other project files">
          <div className="flex flex-wrap gap-1">
            {otherManifests.map((manifest, index) => (
              <Chip key={`${index}:${manifest.path}`}>{manifest.path}</Chip>
            ))}
          </div>
        </Section>
      )}

      {result.warnings.length > 0 && (
        <Section title={`Warnings (${result.warnings.length}${result.warningsTruncated ? "+" : ""})`}>
          <ul className="space-y-0.5 text-[11px]" style={{ color: "#ffb06a" }}>
            {result.warnings.map((warning, index) => (
              <li key={`${warning.code}:${warning.path}:${index}`}>
                <span style={MONO}>{warning.path}</span>: {warningText(warning.code)}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export function RepoAnalysisPanel({
  state,
  onCancel,
  suggestionActions,
  draftReview,
}: {
  state: RepoAnalysisState;
  onCancel: () => void;
  /** Optional "Use in Setup…" actions, passed through to Suggested Setup. */
  suggestionActions?: SuggestedSetupActions;
  /** A setup-draft review (or notice) shown above the results, outside their scroll area. */
  draftReview?: React.ReactNode;
}) {
  if (state.phase === "idle") return null;

  return (
    <section
      aria-label="Repository analysis"
      aria-busy={state.phase === "running"}
      className="rounded-lg p-3"
      style={{ background: "#080808", border: "1px solid #181818" }}
      data-testid="analysis-panel"
    >
      <p className="mb-3 text-[11px] leading-snug" style={{ color: "#706d69" }}>
        {LOCAL_ANALYSIS_NOTE}
      </p>

      {state.phase === "running" && (
        <div className="flex items-center justify-between gap-3" role="status">
          <p className="flex items-center gap-2 text-xs" style={{ color: "#b8b4af" }}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {state.cancelling ? "Cancelling..." : "Analyzing repository..."}
          </p>
          <button
            type="button"
            onClick={onCancel}
            disabled={state.cancelling}
            data-testid="analysis-cancel"
            className="inline-flex h-8 items-center rounded-md px-2.5 text-xs disabled:opacity-50"
            style={{ background: "#0d0d0d", border: "1px solid #242020", color: "#9a9896" }}
          >
            <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Cancel analysis
          </button>
        </div>
      )}

      {state.phase === "error" && (
        <p
          className="rounded-md border border-[#4a1218]/70 bg-[#1a080a]/70 px-2.5 py-1.5 text-[0.72rem] font-medium leading-snug text-[#ff8a94]"
          role="alert"
          data-testid="analysis-error"
        >
          {state.message}
        </p>
      )}

      {state.phase === "done" && draftReview}

      {state.phase === "done" && (
        <div className="max-h-[360px] overflow-y-auto pr-1" data-testid="analysis-results">
          <Results result={state.result} suggestionActions={suggestionActions} />
        </div>
      )}
    </section>
  );
}
