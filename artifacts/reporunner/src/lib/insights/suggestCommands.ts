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
import { classifyScript, runEvidenceText, runStrength, unsupportedInvocations } from "./frameworkRules";
import { relativeTo, unknownMembershipText, workspaceMembership, type Membership } from "./workspaceMembership";
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
    const buildOnly = insight.runnability.buildOnlyScripts;
    if (buildOnly.length > 0) {
      return skip("no-run-script", `${insight.packagePath} has no script that starts a server: ${buildOnly.join(", ")} only ${buildOnly.length > 1 ? "build" : "builds"}.`);
    }
    return skip("no-run-script", `${insight.packagePath} defines no dev, start, serve, develop, start:dev or preview script.`);
  }

  const out: CommandSuggestion[] = [];
  for (const name of names) {
    const script = pkg.scripts.find((s) => s.name === name);
    if (!script) continue; // never invented
    // A script that invokes a recognized-but-unsupported framework (Nuxt,
    // Astro, Remix) anywhere isn't suggested, even when it also starts a
    // supported one ("vite & astro dev") or the package uses a supported one.
    const unsupported = unsupportedInvocations(script.command);
    if (unsupported.length > 0) {
      const labels = unsupported.map((u) => u.label).join(" and ");
      skip("unsupported-framework", `Script "${name}" in ${insight.packagePath} runs ${labels}, which RepoRunner doesn't suggest commands for yet.`);
      continue;
    }
    const orchestration = orchestrated.find((o) => o.scriptName === name)?.tool ?? null;
    out.push(...forEachManager(insight, pkg, name, script.command, orchestration));
  }
  return out;
}

/** How strongly the script itself points to a runnable app (independent of the package manager). */
/**
 * How strongly the script's command supports the suggestion's purpose
 * (independent of the package manager). What the command does decides, not
 * the script's name: a development server for "develop", a production server
 * for "start". A mismatch (dev: "next start") is at most medium; a preview,
 * a build or an unclassified invocation is low.
 */
function scriptStrength(
  insight: PackageInsight,
  name: string,
  command: string,
  purpose: SuggestionPurpose,
): { strength: Confidence; evidence: Evidence[]; servesPreview: boolean } {
  const classification = classifyScript(command, insight.frameworks.map((f) => f.id));
  const evidence: Evidence[] = [];
  if (classification.kind !== null) evidence.push({ kind: "script", text: runEvidenceText(name, classification) });
  let strength = runStrength(classification, insight.frameworks);
  const serves = classification.kind === "develop" ? "develop" : classification.kind === "start" ? "start" : null;
  if (serves && serves !== purpose) {
    evidence.push({ kind: "script", text: `Script ${quote(name)} is named for ${purpose === "develop" ? "development" : "starting"}, but its command ${serves === "develop" ? "starts a development server" : "starts a production server"}` });
    strength = lowest(strength, "medium");
  }
  return { strength, evidence, servesPreview: classification.kind === "preview" };
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

  const { strength, evidence: strengthEvidence, servesPreview } = scriptStrength(insight, name, scriptText, purpose);
  evidence.push(...strengthEvidence);
  caps.push(strength);

  // Low confidence for a preview comes from the command's invocation kind
  // (scriptStrength); the name alone doesn't decide.
  if (name === "preview" || servesPreview) {
    caveats.push({ code: "preview-serves-build", text: "A preview usually serves a production build, which has to be built first." });
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
/**
 * Where a package's dependencies get installed. Only confirmed workspace
 * membership puts a nested package under a parent's install; a lockfile in a
 * parent folder is package-manager evidence, not install scope.
 */
type InstallScope =
  | { kind: "own" }
  | { kind: "member"; root: string; pattern: string }
  | { kind: "independent"; ancestor: string; reason: Extract<Membership, { status: "not-member" }>["reason"] }
  | { kind: "unknown"; ancestor: string; membership: Extract<Membership, { status: "unknown" }> };

function installScopes(result: RepoScanResult, insights: ProjectInsights, lockfileDirs: Set<string>): Map<string, InstallScope> {
  const dirs = insights.packages.map((p) => p.directory);
  const scopes = new Map<string, InstallScope>();
  const scopeOf = (dir: string): InstallScope => {
    const known = scopes.get(dir);
    if (known) return known;
    let scope: InstallScope = { kind: "own" };
    // A package with its own lockfile installs on its own (a separate install root).
    if (dir !== "." && !lockfileDirs.has(dir)) {
      const ancestors = dirs.filter((a) => relativeTo(a, dir) !== null).sort((a, b) => b.length - a.length); // nearest first
      let unknown: InstallScope | null = null;
      let independent: InstallScope | null = null;
      for (const ancestor of ancestors) {
        const m = workspaceMembership(result, ancestor, dir);
        if (m.status === "member") {
          const parent = scopeOf(ancestor);
          scope = { kind: "member", root: parent.kind === "member" ? parent.root : ancestor, pattern: m.pattern };
          break;
        }
        if (m.status === "unknown") unknown ??= { kind: "unknown", ancestor, membership: m };
        else independent ??= { kind: "independent", ancestor, reason: m.reason };
      }
      if (scope.kind === "own") scope = unknown ?? independent ?? scope;
    }
    scopes.set(dir, scope);
    return scope;
  };
  for (const dir of dirs) scopeOf(dir);
  return scopes;
}

const where = (dir: string) => (dir === "." ? "the repository root" : dir);

function installSuggestions(result: RepoScanResult, insights: ProjectInsights, summaries: Map<string, PackageSummary>): CommandSuggestion[] {
  const lockfileDirs = new Set(result.packageManager.lockfiles.map((l) => directoryOf(l.path)));
  const packageDirs = new Map(insights.packages.map((p) => [p.directory, p]));
  const scopes = installScopes(result, insights, lockfileDirs);

  const members = new Map<string, PackageInsight[]>();
  for (const insight of insights.packages) {
    const scope = scopes.get(insight.directory)!;
    const root = scope.kind === "member" ? scope.root : insight.directory;
    members.set(root, [...(members.get(root) ?? []), insight]);
  }

  const out: CommandSuggestion[] = [];
  for (const [root, group] of [...members.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const rootInsight = packageDirs.get(root)!;
    const scope = scopes.get(root)!;
    const evidence: Evidence[] = [{ kind: "project-file", text: `${rootInsight.packagePath} is present` }];
    if (group.length > 1) {
      evidence.push({ kind: "workspace-file", text: `${group.length} packages share this install root: ${group.length - 1} matched by the "workspaces" patterns in ${rootInsight.packagePath}` });
    }
    const caveats: Caveat[] = [NOT_VERIFIED_INSTALL];
    let scopeCap: Confidence = "high";
    const hasParentLockfile = [...lockfileDirs].some((d) => relativeTo(d, root) !== null);
    if (scope.kind === "independent") {
      const parent = packageDirs.get(scope.ancestor)!;
      evidence.push({
        kind: "workspace-file",
        text: scope.reason === "no-workspaces"
          ? `${parent.packagePath} declares no workspaces, so installing at ${where(scope.ancestor)} doesn't install ${root}`
          : `${root} doesn't match the "workspaces" patterns in ${parent.packagePath}, so installing at ${where(scope.ancestor)} doesn't install it`,
      });
      caveats.push({ code: "independent-package", text: `${root} is a separate package and needs its own install.` });
      scopeCap = "medium";
    } else if (scope.kind === "unknown") {
      const parent = packageDirs.get(scope.ancestor)!;
      caveats.push({
        code: "workspace-membership-unknown",
        text: `It couldn't be confirmed whether ${root} is a workspace member of ${parent.packagePath} (${unknownMembershipText(scope.membership)}). If it is, installing at ${where(scope.ancestor)} already covers it; if not, it needs this separate install.`,
      });
      scopeCap = "low";
    }
    if (scope.kind !== "own" && hasParentLockfile && !lockfileDirs.has(root)) {
      caveats.push({ code: "no-lockfile-here", text: `There's no lockfile in ${root}; the package manager comes from a lockfile in a parent folder, and installing here may create a new lockfile.` });
    }
    const unconfirmed = insights.packages
      .map((p) => [p.directory, scopes.get(p.directory)!] as const)
      .filter(([, sc]) => sc.kind === "unknown" && sc.ancestor === root)
      .map(([dir]) => dir);
    if (unconfirmed.length > 0) {
      const many = unconfirmed.length > 1;
      caveats.push({
        code: "members-unconfirmed",
        text: `Workspace membership couldn't be confirmed for ${unconfirmed.length} nested ${many ? "packages" : "package"} (${unconfirmed.slice(0, 5).join(", ")}${unconfirmed.length > 5 ? ", …" : ""}), so this install may not cover ${many ? "them" : "it"}; ${many ? "each has" : "it has"} a separate suggestion.`,
      });
    }

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
        confidence: manager && managerConfidence ? lowest(scanIncomplete ? lowest(managerConfidence, "medium") : managerConfidence, scopeCap) : null,
        evidence: [...evidence, ...managerEvidence],
        caveats: [...caveats, ...managerCaveats(manager, ambiguous)],
      })),
    );
  }
  return out;
}
