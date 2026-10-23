// Stage 2B: evidence-backed command suggestions. Pure and synchronous; no
// filesystem, network, IPC, storage or process access; nothing is run,
// applied or saved, and the inputs are never modified.
//
// Commands are only ever built from fixed templates plus a script name that
// exists in the scanned package.json and passes a strict allowlist. A
// script's own command text is never put into a suggested command; it is
// returned separately as passive text for review.
//
// That makes a suggested command syntactically constrained, NOT safe to
// execute: `npm run dev` runs whatever the repository's "dev" script says, and
// installs can run project and dependency scripts. Suggestions are never run,
// verified or security-reviewed here, and must not be presented as such.
//
// On Windows, RepoRunner runs configured commands through `cmd.exe /d /s /c`,
// which resolves npm.cmd, pnpm.cmd/.exe, yarn.cmd and bun.exe from PATH, so
// the plain forms below work as typed. The managers differ in one way that
// matters here: whether `<pm> run <script>` also runs pre<script>/post<script>
// hooks depends on the manager and its settings (npm and Yarn 1 do; Yarn 2+
// doesn't; pnpm and Bun depend on version and configuration). Hook caveats
// therefore say "may run".
import type { PackageManagerName, PackageSummary, RepoScanResult } from "../../types";
import { detectProjects, directoryOf } from "./detectProjects";
import { BUN_RUNNERS, FRAMEWORK_RULES, NODE_RUNNERS, invokedTool } from "./frameworkRules";
import type {
  Caveat,
  CommandSuggestion,
  CommandSuggestions,
  Confidence,
  Evidence,
  PackageInsight,
  ProjectInsights,
  SuggestionPurpose,
  SuggestionSkip,
} from "./types";

/** Script names allowed into a command: letters, digits and ":_.-", starting with a letter or digit. */
export const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
export const MAX_SUGGESTIONS = 300;

const RUN_COMMAND: Record<PackageManagerName, (script: string) => string> = {
  npm: (script) => `npm run ${script}`,
  pnpm: (script) => `pnpm run ${script}`,
  yarn: (script) => `yarn run ${script}`,
  bun: (script) => `bun run ${script}`,
};
const INSTALL_COMMAND: Record<PackageManagerName, string> = {
  npm: "npm install",
  pnpm: "pnpm install",
  yarn: "yarn install",
  bun: "bun install",
};
const MANAGER_ORDER: readonly PackageManagerName[] = ["npm", "pnpm", "yarn", "bun"];
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];
/** Root scripts that run several packages are suggested when their name looks like a run script (e.g. "dev:all"). */
const ORCHESTRATED_RUN_NAME = /^(dev|develop|start|serve)(:.*)?$/;

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const lowest = (...values: Confidence[]): Confidence => values.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
const quote = (value: string) => `"${value}"`;

const NOT_VERIFIED_SCRIPT: Caveat = { code: "not-verified", text: "Suggested from package.json. Not run or verified." };
const RUNS_REPOSITORY_SCRIPT: Caveat = {
  code: "runs-repository-script",
  text: "This runs a script defined by the repository, which can execute any command. RepoRunner hasn't run, reviewed or security-checked it.",
};
const NOT_VERIFIED_INSTALL: Caveat = {
  code: "not-verified",
  text: "A standard install command for this package manager, not a package.json script. Not run or verified.",
};

export function isSafeScriptName(name: string): boolean {
  return SAFE_SCRIPT_NAME.test(name);
}

function purposeOf(scriptName: string): SuggestionPurpose {
  const starts = scriptName === "start" || scriptName === "preview" || (scriptName.startsWith("start:") && scriptName !== "start:dev");
  return starts ? "start" : "develop";
}

export function suggestCommands(result: RepoScanResult, insights: ProjectInsights = detectProjects(result)): CommandSuggestions {
  const summaries = new Map(result.packages.map((p) => [p.path, p]));
  const suggestions: CommandSuggestion[] = [];
  const skipped: SuggestionSkip[] = [];

  if (insights.packages.length === 0) {
    skipped.push(
      insights.kind === "non-node"
        ? {
            packagePath: null,
            directory: null,
            reason: "non-node-project",
            text: `Recognized ${insights.otherEcosystems.join(", ")} project files; RepoRunner doesn't suggest commands for these yet.`,
          }
        : { packagePath: null, directory: null, reason: "no-packages", text: "No readable package.json was found, so there is nothing to suggest." },
    );
  }

  for (const insight of insights.packages) {
    const pkg = summaries.get(insight.packagePath);
    if (!pkg) continue;
    suggestions.push(...scriptSuggestions(insight, pkg, insights, skipped));
  }
  suggestions.push(...installSuggestions(result, insights, summaries));

  const suggestionsTruncated = suggestions.length > MAX_SUGGESTIONS;
  return {
    scanComplete: insights.scanComplete,
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
    suggestionsTruncated,
    skipped,
  };
}

function scriptSuggestions(insight: PackageInsight, pkg: PackageSummary, insights: ProjectInsights, skipped: SuggestionSkip[]): CommandSuggestion[] {
  const skip = (reason: SuggestionSkip["reason"], text: string) => {
    skipped.push({ packagePath: insight.packagePath, directory: insight.directory, reason, text });
    return [];
  };

  if (insight.frameworks.length > 0 && insight.frameworks.every((f) => !f.suggestionsSupported)) {
    return skip("unsupported-framework", `${insight.frameworks.map((f) => f.label).join(", ")} was recognized; RepoRunner doesn't suggest commands for it yet.`);
  }

  const orchestrated = insight.directory === "." ? insights.orchestration.filter((o) => ORCHESTRATED_RUN_NAME.test(o.scriptName)) : [];
  const names = [...insight.runnability.runScripts];
  for (const signal of orchestrated) if (!names.includes(signal.scriptName)) names.push(signal.scriptName);

  if (names.length === 0) {
    if (insight.runnability.status === "unknown") {
      return skip("scripts-truncated", `The script list of ${insight.packagePath} was cut short, so a run script may exist that wasn't seen.`);
    }
    if (insight.role === "workspace-root") {
      return skip("workspace-root-without-run-script", `${insight.packagePath} is the workspace root and has no script that runs the apps; see the individual packages.`);
    }
    return skip("no-run-script", `${insight.packagePath} defines no dev, start, serve, develop, start:dev or preview script.`);
  }

  const out: CommandSuggestion[] = [];
  for (const name of names) {
    const script = pkg.scripts.find((s) => s.name === name);
    if (!script) continue; // never invented
    const orchestration = orchestrated.find((o) => o.scriptName === name)?.tool ?? null;
    out.push(...forEachManager(insight, pkg, name, script.command, orchestration));
  }
  return out;
}

/** How strongly the script itself points to a runnable app (independent of the package manager). */
function scriptStrength(insight: PackageInsight, name: string, command: string): { strength: Confidence; evidence: Evidence[] } {
  const evidence: Evidence[] = [];
  for (const framework of insight.frameworks) {
    const rule = FRAMEWORK_RULES.find((r) => r.id === framework.id);
    if (rule && rule.scriptTools.length > 0 && invokedTool(command, rule.scriptTools)) {
      evidence.push({ kind: "script", text: `Script ${quote(name)} invokes ${framework.label}'s command-line tool` });
      return { strength: framework.confidence === "high" ? "high" : "medium", evidence };
    }
  }
  const runner = invokedTool(command, [...NODE_RUNNERS, ...BUN_RUNNERS]);
  if (runner) {
    evidence.push({ kind: "script", text: `Script ${quote(name)} starts ${runner.tool}` });
    return { strength: "medium", evidence };
  }
  return { strength: "low", evidence };
}

function forEachManager(
  insight: PackageInsight,
  pkg: PackageSummary,
  name: string,
  scriptText: string,
  orchestration: CommandSuggestion["orchestration"],
): CommandSuggestion[] {
  const purpose = purposeOf(name);
  const base = {
    packagePath: insight.packagePath,
    directory: insight.directory,
    packageName: insight.name,
    purpose,
    source: "script" as const,
    scriptName: name,
    scriptCommandText: scriptText,
    scanIncomplete: insight.uncertainties.includes("scan-incomplete"),
    orchestration,
    frameworks: insight.frameworks.map((f) => f.id),
  };
  const evidence: Evidence[] = [{ kind: "script", text: `Script ${quote(name)} is defined in ${pkg.path}` }];
  const caveats: Caveat[] = [NOT_VERIFIED_SCRIPT, RUNS_REPOSITORY_SCRIPT];
  const caps: Confidence[] = [];

  const { strength, evidence: strengthEvidence } = scriptStrength(insight, name, scriptText);
  evidence.push(...strengthEvidence);
  caps.push(strength);

  if (name === "preview") {
    caveats.push({ code: "preview-serves-build", text: "preview usually serves a production build, which has to be built first." });
    caps.push("low");
  }
  if (orchestration) {
    evidence.push({ kind: "script", text: `Root script ${quote(name)} invokes ${orchestration}` });
    caveats.push({ code: "runs-multiple-packages", text: `This root script uses ${orchestration} and may start several packages at once.` });
    caps.push("medium");
  }
  const hooks = [`pre${name}`, `post${name}`].filter((hook) => pkg.scripts.some((s) => s.name === hook));
  if (hooks.length > 0) {
    caveats.push({
      code: "lifecycle-hooks",
      text: `This package also defines ${hooks.join(" and ")}; depending on the package manager and its settings, ${hooks.length > 1 ? "they" : "it"} may run too.`,
    });
  }
  if (pkg.scriptsTruncated) {
    caveats.push({ code: "scripts-truncated", text: "The script list was cut short; other scripts, including hooks, may exist." });
    caveats.push({ code: "hooks-may-be-incomplete", text: `It can't be confirmed that no pre${name} or post${name} hook exists.` });
    caps.push("medium");
  }
  if (insight.frameworks.length > 1) {
    caveats.push({ code: "multiple-frameworks", text: `Several frameworks were detected here (${insight.frameworks.map((f) => f.label).join(", ")}).` });
  }
  if (insight.frameworks.some((f) => f.confidence === "low")) {
    caveats.push({ code: "framework-uncertain", text: "Some framework evidence here is indirect." });
  }
  if (base.scanIncomplete) {
    caveats.push({ code: "scan-incomplete", text: "The analysis didn't finish, so some information may be missing." });
    caps.push("medium");
  }

  if (!isSafeScriptName(name)) {
    return [
      {
        ...base,
        id: suggestionId(insight.directory, purpose, name, null),
        packageManager: null,
        command: null,
        unavailableReason: "unsafe-script-name",
        packageManagerAmbiguous: false,
        confidence: null,
        evidence,
        caveats: [...caveats, { code: "unsafe-script-name", text: "This script name has characters RepoRunner won't put into a command. Review it in package.json." }],
      },
    ];
  }

  return withManagers(insight, (manager, managerEvidence, ambiguous, managerConfidence) => ({
    ...base,
    id: suggestionId(insight.directory, purpose, name, manager),
    packageManager: manager,
    command: manager ? RUN_COMMAND[manager](name) : null,
    unavailableReason: manager ? null : "package-manager-unknown",
    packageManagerAmbiguous: ambiguous,
    confidence: manager && managerConfidence ? lowest(managerConfidence, ...caps) : null,
    evidence: [...evidence, ...managerEvidence],
    caveats: [...caveats, ...managerCaveats(manager, ambiguous)],
  }));
}

/**
 * One result per package-manager alternative: the single manager, every
 * conflicting candidate (each marked ambiguous, at most Low), or one
 * unresolved result with no command when there is no evidence.
 */
function withManagers(
  insight: PackageInsight,
  build: (manager: PackageManagerName | null, evidence: Evidence[], ambiguous: boolean, confidence: Confidence | null) => CommandSuggestion,
): CommandSuggestion[] {
  const pm = insight.packageManager;
  if (pm.status === "unknown") return [build(null, [], false, null)];
  const candidates = [...pm.candidates].sort((a, b) => MANAGER_ORDER.indexOf(a.manager) - MANAGER_ORDER.indexOf(b.manager));
  if (pm.status === "conflict") return candidates.map((c) => build(c.manager, c.evidence, true, "low"));
  return [build(candidates[0].manager, candidates[0].evidence, false, pm.confidence)];
}

function managerCaveats(manager: PackageManagerName | null, ambiguous: boolean): Caveat[] {
  if (!manager) {
    return [{ code: "package-manager-unknown", text: "No lockfile or packageManager field was found, so the package manager is unknown. No command is suggested." }];
  }
  if (ambiguous) {
    return [{ code: "package-manager-ambiguous", text: "Package-manager evidence conflicts; this is one of several alternatives." }];
  }
  return [];
}

function suggestionId(directory: string, purpose: SuggestionPurpose, script: string | null, manager: PackageManagerName | null): string {
  return [directory, purpose, script ?? "install", manager ?? "unresolved"].join("|");
}

/**
 * One install suggestion per package-manager root: the folder of the nearest
 * lockfile; else, in a monorepo, the workspace root; else the package itself.
 */
function installSuggestions(result: RepoScanResult, insights: ProjectInsights, summaries: Map<string, PackageSummary>): CommandSuggestion[] {
  const lockfileDirs = new Set(result.packageManager.lockfiles.map((l) => directoryOf(l.path)));
  const packageDirs = new Map(insights.packages.map((p) => [p.directory, p]));
  const rootOf = (dir: string): string => {
    for (let d: string | null = dir; d !== null; d = d === "." ? null : directoryOf(d)) {
      if (lockfileDirs.has(d) && packageDirs.has(d)) return d;
    }
    if (insights.kind === "monorepo" && packageDirs.has(".")) return ".";
    return dir;
  };

  const members = new Map<string, PackageInsight[]>();
  for (const insight of insights.packages) {
    const root = rootOf(insight.directory);
    members.set(root, [...(members.get(root) ?? []), insight]);
  }

  const out: CommandSuggestion[] = [];
  for (const [root, group] of [...members.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const rootInsight = packageDirs.get(root)!;
    const evidence: Evidence[] = [{ kind: "project-file", text: `${rootInsight.packagePath} is present` }];
    if (group.length > 1) evidence.push({ kind: "workspace-file", text: `${group.length} packages share this install root` });
    const caveats: Caveat[] = [NOT_VERIFIED_INSTALL];

    const hooks: string[] = [];
    let hooksIncomplete = false;
    for (const member of group) {
      const pkg = summaries.get(member.packagePath);
      if (!pkg) continue;
      if (pkg.scriptsTruncated) hooksIncomplete = true;
      for (const hook of INSTALL_HOOKS) if (pkg.scripts.some((s) => s.name === hook)) hooks.push(member.directory === "." ? hook : `${hook} (${member.directory})`);
    }
    if (hooks.length > 0) {
      caveats.push({ code: "install-runs-project-scripts", text: `Installing may run scripts this project defines: ${hooks.slice(0, 10).join(", ")}${hooks.length > 10 ? ", …" : ""}.` });
    }
    if (hooksIncomplete) {
      caveats.push({ code: "hooks-may-be-incomplete", text: "A script list was cut short, so it can't be confirmed which install scripts the project defines." });
    }
    caveats.push({ code: "install-runs-dependency-scripts", text: "Installing can also run scripts from dependencies." });
    const scanIncomplete = !insights.scanComplete;
    if (scanIncomplete) caveats.push({ code: "scan-incomplete", text: "The analysis didn't finish, so some information may be missing." });

    out.push(
      ...withManagers(rootInsight, (manager, managerEvidence, ambiguous, managerConfidence) => ({
        id: suggestionId(root, "install", null, manager),
        packagePath: rootInsight.packagePath,
        directory: root,
        packageName: rootInsight.name,
        purpose: "install",
        source: "install",
        scriptName: null,
        scriptCommandText: null,
        packageManager: manager,
        command: manager ? INSTALL_COMMAND[manager] : null,
        unavailableReason: manager ? null : "package-manager-unknown",
        packageManagerAmbiguous: ambiguous,
        scanIncomplete,
        orchestration: null,
        frameworks: [],
        confidence: manager && managerConfidence ? (scanIncomplete ? lowest(managerConfidence, "medium") : managerConfidence) : null,
        evidence: [...evidence, ...managerEvidence],
        caveats: [...caveats, ...managerCaveats(manager, ambiguous)],
      })),
    );
  }
  return out;
}
