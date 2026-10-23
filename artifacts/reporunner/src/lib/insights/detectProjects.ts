// Stage 2A: interprets a RepoScanResult into project insights. Pure and
// synchronous: no filesystem, network, IPC, storage or process access, and the
// input is never modified. Every conclusion lists its evidence; incomplete
// scans and truncated lists cap confidence and make absence "unknown".
import type { ManifestKind, PackageManagerName, PackageSummary, RepoScanResult } from "../../types";
import {
  BUN_RUNNERS,
  FRAMEWORK_RULES,
  NODE_RUNNERS,
  ORCHESTRATORS,
  RUN_SCRIPT_CANDIDATES,
  classifyScript,
  commandSegments,
  invokedTool,
  runEvidenceText,
  runStrength,
  packageManagerFromField,
  type FrameworkRule,
  type ScriptTool,
} from "./frameworkRules";
import type {
  Confidence,
  Evidence,
  FrameworkDetection,
  OrchestrationSignal,
  PackageInsight,
  PackageManagerCandidate,
  PackageManagerInsight,
  PackageRole,
  ProjectInsights,
  RepositoryKind,
  RunnabilityInsight,
  RuntimeSignal,
  UncertaintyCode,
} from "./types";

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const capAt = (value: Confidence, max: Confidence): Confidence => (RANK[value] > RANK[max] ? max : value);

const OTHER_ECOSYSTEMS: Partial<Record<ManifestKind, string>> = {
  python: "Python",
  go: "Go",
  rust: "Rust",
  ruby: "Ruby",
  php: "PHP",
  java: "Java",
  deno: "Deno",
};

const PACKAGE_JSON_WARNINGS = new Set([
  "manifest-malformed",
  "manifest-not-object",
  "manifest-unreadable",
  "manifest-oversized",
  "manifest-limit-reached",
  "byte-budget-exhausted",
]);

/** "apps/web/package.json" -> "apps/web"; "package.json" -> ".". */
export function directoryOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "." : relativePath.slice(0, slash);
}
const basenameOf = (relativePath: string) => relativePath.slice(relativePath.lastIndexOf("/") + 1);
const parentOf = (dir: string) => (dir === "." ? null : directoryOf(dir));
const quote = (value: string) => `"${value}"`;

interface Context {
  result: RepoScanResult;
  scanComplete: boolean;
  /** Highest confidence any conclusion may have in this scan. */
  scanCap: Confidence;
  lockfilesMayBeMissing: boolean;
  filesByDir: Map<string, string[]>;
  lockfilesByDir: Map<string, Array<{ path: string; manager: PackageManagerName }>>;
  nodeVersionDirs: Set<string>;
  isWorkspaceRoot: (dir: string) => boolean;
}

export function detectProjects(result: RepoScanResult): ProjectInsights {
  const scanComplete = result.status === "complete";
  const uncertainties = new Set<UncertaintyCode>();
  if (!scanComplete) uncertainties.add("scan-incomplete");
  if (result.status === "cancelled") uncertainties.add("scan-cancelled");
  if (result.status === "timed-out") uncertainties.add("scan-timed-out");

  const traversalLimited = result.limitsHit.some((l) => l === "entries" || l === "directories" || l === "depth" || l === "time" || l === "manifests");
  if (traversalLimited || result.packagesTruncated || !scanComplete) uncertainties.add("packages-incomplete");
  if (traversalLimited || result.manifestsTruncated || !scanComplete) uncertainties.add("project-files-incomplete");
  // Result fitting can drop the lockfile list entirely.
  const lockfilesMayBeMissing = result.limitsHit.includes("result-size") || result.manifestsTruncated || !scanComplete || traversalLimited;
  if (lockfilesMayBeMissing) uncertainties.add("lockfiles-may-be-missing");
  if (result.warnings.some((w) => PACKAGE_JSON_WARNINGS.has(w.code))) uncertainties.add("unreadable-manifests");

  const filesByDir = new Map<string, string[]>();
  for (const manifest of result.manifests) {
    const dir = directoryOf(manifest.path);
    filesByDir.set(dir, [...(filesByDir.get(dir) ?? []), basenameOf(manifest.path)]);
  }
  const lockfilesByDir = new Map<string, Array<{ path: string; manager: PackageManagerName }>>();
  for (const lockfile of result.packageManager.lockfiles) {
    const dir = directoryOf(lockfile.path);
    lockfilesByDir.set(dir, [...(lockfilesByDir.get(dir) ?? []), lockfile]);
  }
  const nodeVersionDirs = new Set(result.nodeVersionFiles.map((f) => directoryOf(f.path)));

  const packages = [...result.packages].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const rootPackage = packages.find((p) => directoryOf(p.path) === ".") ?? null;
  const nestedCount = packages.filter((p) => directoryOf(p.path) !== ".").length;
  const workspaceEvidence = workspaceEvidenceOf(result, rootPackage);
  const isWorkspaceRoot = (dir: string) => dir === "." && workspaceEvidence.length > 0 && nestedCount > 0;

  const context: Context = {
    result,
    scanComplete,
    scanCap: scanComplete ? "high" : "medium",
    lockfilesMayBeMissing,
    filesByDir,
    lockfilesByDir,
    nodeVersionDirs,
    isWorkspaceRoot,
  };

  const insights = packages.map((pkg) => analyzePackage(pkg, context));
  const otherEcosystems = [...new Set(result.manifests.map((m) => OTHER_ECOSYSTEMS[m.kind]).filter((x): x is string => Boolean(x)))].sort();
  const { kind, kindEvidence } = repositoryKind(packages.length, nestedCount, workspaceEvidence, otherEcosystems, result);

  return {
    scanStatus: result.status,
    scanComplete,
    kind,
    kindEvidence,
    packages: insights,
    orchestration: rootPackage ? orchestrationOf(rootPackage) : [],
    otherEcosystems,
    uncertainties: [...uncertainties],
  };
}

function workspaceEvidenceOf(result: RepoScanResult, rootPackage: PackageSummary | null): Evidence[] {
  const evidence: Evidence[] = [];
  for (const signal of result.workspace.signals) {
    evidence.push(
      signal === "npm-workspaces"
        ? { kind: "workspace-file", text: "The root package.json declares workspaces" }
        : { kind: "workspace-file", text: `Workspace configuration found at the root (${signal})` },
    );
  }
  if (rootPackage && rootPackage.workspaces.length > 0 && !result.workspace.signals.includes("npm-workspaces")) {
    evidence.push({ kind: "workspace-file", text: "The root package.json declares workspaces" });
  }
  return evidence;
}

function repositoryKind(
  packageCount: number,
  nestedCount: number,
  workspaceEvidence: Evidence[],
  otherEcosystems: string[],
  result: RepoScanResult,
): { kind: RepositoryKind; kindEvidence: Evidence[] } {
  if (packageCount === 0) {
    if (otherEcosystems.length > 0) {
      const files = result.manifests.filter((m) => OTHER_ECOSYSTEMS[m.kind]).slice(0, 5);
      return { kind: "non-node", kindEvidence: files.map((f) => ({ kind: "project-file", text: `${f.path} is present` })) };
    }
    return { kind: "unknown", kindEvidence: [{ kind: "absence", text: "No readable package.json was found" }] };
  }
  if (workspaceEvidence.length > 0) {
    return { kind: "monorepo", kindEvidence: [...workspaceEvidence, { kind: "project-file", text: `${packageCount} package.json files were read` }] };
  }
  if (nestedCount > 0 && packageCount > 1) {
    return { kind: "multi-package", kindEvidence: [{ kind: "project-file", text: `${packageCount} package.json files were read, with no workspace configuration` }] };
  }
  return { kind: "single-package", kindEvidence: [{ kind: "project-file", text: "One package.json was read" }] };
}

function orchestrationOf(rootPackage: PackageSummary): OrchestrationSignal[] {
  const signals: OrchestrationSignal[] = [];
  for (const script of rootPackage.scripts) {
    for (const tokens of commandSegments(script.command)) {
      const match = ORCHESTRATORS.find((o) => o.match(tokens));
      if (match) {
        signals.push({ scriptName: script.name, tool: match.id, evidence: [{ kind: "script", text: `Root script ${quote(script.name)} invokes ${match.id}` }] });
        break;
      }
    }
  }
  return signals;
}

function analyzePackage(pkg: PackageSummary, context: Context): PackageInsight {
  const directory = directoryOf(pkg.path);
  const uncertainties = new Set<UncertaintyCode>();
  if (!context.scanComplete) uncertainties.add("scan-incomplete");
  if (pkg.dependenciesTruncated) uncertainties.add("dependencies-truncated");
  if (pkg.scriptsTruncated) uncertainties.add("scripts-truncated");

  const frameworks = detectFrameworks(pkg, directory, context);
  if (frameworks.length > 1) uncertainties.add("multiple-frameworks");
  const packageManager = detectPackageManager(pkg, directory, context);
  for (const code of packageManager.uncertainties) uncertainties.add(code);
  const runnability = detectRunnability(pkg, frameworks, context);
  const runtimes = detectRuntimes(pkg, directory, frameworks, packageManager, context);

  return {
    packagePath: pkg.path,
    directory,
    name: pkg.name,
    frameworks,
    runtimes,
    packageManager,
    role: roleOf(directory, frameworks, runnability, pkg, context),
    runnability,
    uncertainties: [...uncertainties],
  };
}

function detectFrameworks(pkg: PackageSummary, directory: string, context: Context): FrameworkDetection[] {
  const dependencies = new Set(pkg.dependencies);
  const devDependencies = new Set(pkg.devDependencies);
  const files = context.filesByDir.get(directory) ?? [];
  const detections: Array<{ rule: FrameworkRule; detection: FrameworkDetection }> = [];

  for (const rule of FRAMEWORK_RULES) {
    const evidence: Evidence[] = [];
    let allFromRuntimeDeps = true;
    let depsMatched = true;
    for (const group of rule.dependencyGroups) {
      const runtime = group.find((name) => dependencies.has(name));
      const dev = runtime ? undefined : group.find((name) => devDependencies.has(name));
      if (runtime) evidence.push({ kind: "dependency", text: `${quote(runtime)} is listed in dependencies` });
      else if (dev) {
        allFromRuntimeDeps = false;
        evidence.push({ kind: "dev-dependency", text: `${quote(dev)} is listed in devDependencies` });
      } else {
        depsMatched = false;
      }
    }
    if (!depsMatched) evidence.length = 0;

    const config = files.find((file) => rule.configFiles.some((pattern) => pattern.test(file)));
    const script = rule.scriptTools.length > 0 ? pkg.scripts.find((s) => invokedTool(s.command, rule.scriptTools)) : undefined;
    const identifiedIndirectly = (config && rule.configIdentifies) || (script && rule.scriptIdentifies);
    if (!depsMatched && !identifiedIndirectly) continue;

    if (config) evidence.push({ kind: "config-file", text: `${directory === "." ? config : `${directory}/${config}`} is present` });
    if (script) {
      const tool = invokedTool(script.command, rule.scriptTools) as ScriptTool;
      evidence.push({ kind: "script", text: `Script ${quote(script.name)} invokes ${tool.tool}` });
    }

    const uncertainties: UncertaintyCode[] = [];
    let confidence: Confidence;
    if (depsMatched) {
      const corroborated = Boolean(config || script);
      confidence = corroborated || (rule.dependencyIsDirect && allFromRuntimeDeps) ? "high" : "medium";
    } else {
      confidence = "low";
      uncertainties.push("indirect-evidence-only");
      if (pkg.dependenciesTruncated) {
        uncertainties.push("dependencies-truncated");
      } else {
        evidence.push({ kind: "absence", text: `No ${rule.label} dependency is listed in ${pkg.path}` });
      }
    }
    if (pkg.dependenciesTruncated) {
      confidence = capAt(confidence, "medium");
      if (!uncertainties.includes("dependencies-truncated")) uncertainties.push("dependencies-truncated");
    }
    if (!context.scanComplete) {
      confidence = capAt(confidence, context.scanCap);
      uncertainties.push("scan-incomplete");
    }

    detections.push({
      rule,
      detection: {
        id: rule.id,
        label: rule.label,
        category: rule.category,
        suggestionsSupported: rule.suggestionsSupported,
        confidence,
        evidence,
        uncertainties,
      },
    });
  }

  // A meta-framework (SvelteKit, Nuxt, Remix) is reported instead of the
  // Vite-based framework it is built on, not alongside it.
  const ids = new Set(detections.map((d) => d.detection.id));
  return detections.filter((d) => !d.rule.supersededBy.some((meta) => ids.has(meta))).map((d) => d.detection);
}

function detectPackageManager(pkg: PackageSummary, directory: string, context: Context): PackageManagerInsight {
  const { result } = context;
  const candidates = new Map<PackageManagerName, Evidence[]>();
  const add = (manager: PackageManagerName, evidence: Evidence) => candidates.set(manager, [...(candidates.get(manager) ?? []), evidence]);
  const uncertainties: UncertaintyCode[] = [];
  let hasLockfile = false;
  let hasField = false;

  const own = packageManagerFromField(pkg.packageManager);
  if (own) {
    hasField = true;
    add(own, { kind: "package-manager-field", text: `${pkg.path} declares packageManager ${own}` });
  } else if (pkg.packageManager) {
    uncertainties.push("unrecognized-package-manager-field");
  }
  if (directory !== ".") {
    const root = packageManagerFromField(result.packageManager.declared);
    if (root) {
      hasField = true;
      add(root, { kind: "package-manager-field", text: `The root package.json declares packageManager ${root}` });
    }
  }

  // Lockfiles in this folder, else the nearest parent folder that has any.
  for (let dir: string | null = directory; dir !== null; dir = parentOf(dir)) {
    const lockfiles = context.lockfilesByDir.get(dir);
    if (!lockfiles) continue;
    for (const lockfile of lockfiles) {
      hasLockfile = true;
      add(lockfile.manager, {
        kind: "lockfile",
        text: dir === directory ? `${lockfile.path} is present` : `${lockfile.path} is present in a parent folder`,
      });
    }
    break;
  }

  if (result.workspace.signals.includes("pnpm-workspace")) {
    add("pnpm", { kind: "workspace-file", text: "pnpm-workspace.yaml is present at the root" });
  }

  const list: PackageManagerCandidate[] = [...candidates.entries()].map(([manager, evidence]) => ({ manager, evidence }));
  let status: PackageManagerInsight["status"];
  let confidence: Confidence | null;
  if (list.length === 0) {
    status = "unknown";
    confidence = null;
    uncertainties.push("package-manager-unknown");
  } else if (list.length > 1) {
    status = "conflict";
    confidence = "low";
    uncertainties.push("package-manager-conflict");
  } else {
    status = "single";
    confidence = hasLockfile ? "high" : hasField ? "medium" : "low";
  }
  if (confidence && context.lockfilesMayBeMissing) {
    confidence = capAt(confidence, "medium");
  }
  if (context.lockfilesMayBeMissing) uncertainties.push("lockfiles-may-be-missing");
  if (confidence && !context.scanComplete) confidence = capAt(confidence, context.scanCap);
  return { status, candidates: list, confidence, uncertainties };
}

function detectRunnability(pkg: PackageSummary, frameworks: FrameworkDetection[], context: Context): RunnabilityInsight {
  const present = new Set(pkg.scripts.map((s) => s.name));
  const candidates = RUN_SCRIPT_CANDIDATES.filter((name) => present.has(name));
  const frameworkIds = frameworks.map((f) => f.id);
  const runScripts: string[] = [];
  const buildOnlyScripts: string[] = [];
  const evidence: Evidence[] = [];
  const uncertainties: UncertaintyCode[] = [];

  // A script name alone is weak. What its command actually does decides the
  // strength: a development or production server is strong, a preview or an
  // unclassified invocation is weak, and a build-only command (dev: "vite
  // build") isn't a run script at all. Nothing here was run or verified.
  let confidence: Confidence = "low";
  for (const name of candidates) {
    const script = pkg.scripts.find((s) => s.name === name)!;
    const classification = classifyScript(script.command, frameworkIds);
    evidence.push({ kind: "script", text: runEvidenceText(name, classification) });
    if (classification.kind === "build") {
      buildOnlyScripts.push(name);
      continue;
    }
    runScripts.push(name);
    // The command decides, not the name: "vite preview" is low via its invocation kind.
    const strength = runStrength(classification, frameworks);
    if (RANK[strength] > RANK[confidence]) confidence = strength;
  }

  if (runScripts.length === 0) {
    if (pkg.scriptsTruncated) {
      uncertainties.push("scripts-truncated");
      return { status: "unknown", runScripts, buildOnlyScripts, confidence: null, evidence, uncertainties };
    }
    return {
      status: "no-run-script",
      runScripts,
      buildOnlyScripts,
      confidence: capAt("high", context.scanCap),
      evidence: [
        ...evidence,
        buildOnlyScripts.length > 0
          ? { kind: "absence", text: `${pkg.path} has no script that starts a server (${buildOnlyScripts.join(", ")} only ${buildOnlyScripts.length > 1 ? "build" : "builds"})` }
          : { kind: "absence", text: `${pkg.path} defines no ${RUN_SCRIPT_CANDIDATES.join(", ")} script` },
      ],
      uncertainties: context.scanComplete ? [] : ["scan-incomplete"],
    };
  }

  if (runScripts.length === 1 && runScripts[0] === "preview") {
    evidence.push({ kind: "script", text: "Only a preview script exists; it usually serves a production build" });
  }
  if (pkg.scriptsTruncated) {
    uncertainties.push("scripts-truncated");
    confidence = capAt(confidence, "medium");
  }
  if (!context.scanComplete) {
    uncertainties.push("scan-incomplete");
    confidence = capAt(confidence, context.scanCap);
  }
  return { status: "has-run-script", runScripts, buildOnlyScripts, confidence, evidence, uncertainties };
}

function detectRuntimes(
  pkg: PackageSummary,
  directory: string,
  frameworks: FrameworkDetection[],
  packageManager: PackageManagerInsight,
  context: Context,
): RuntimeSignal[] {
  const signals: RuntimeSignal[] = [];

  const node: Evidence[] = [];
  let nodeConfidence: Confidence = "low";
  if (pkg.engines.node) {
    node.push({ kind: "engines-field", text: `${pkg.path} requires Node ${pkg.engines.node}` });
    nodeConfidence = "high";
  }
  for (let dir: string | null = directory; dir !== null; dir = parentOf(dir)) {
    if (context.nodeVersionDirs.has(dir)) {
      node.push({ kind: "node-version-file", text: `A Node version file is present${dir === directory ? "" : " in a parent folder"}` });
      nodeConfidence = "high";
      break;
    }
  }
  const nodeScript = pkg.scripts.find((s) => invokedTool(s.command, NODE_RUNNERS));
  if (nodeScript) {
    node.push({ kind: "script", text: `Script ${quote(nodeScript.name)} starts ${invokedTool(nodeScript.command, NODE_RUNNERS)!.tool}` });
    nodeConfidence = "high";
  }
  if (frameworks.length > 0) {
    node.push({ kind: "dependency", text: `${frameworks.map((f) => f.label).join(", ")} runs on Node.js` });
    if (nodeConfidence === "low") nodeConfidence = "medium";
  }
  if (node.length === 0) node.push({ kind: "project-file", text: "package.json is a JavaScript package manifest" });
  signals.push({ runtime: "node", confidence: capAt(nodeConfidence, context.scanCap), evidence: node });

  const bun: Evidence[] = [];
  let bunConfidence: Confidence = "low";
  const bunCandidate = packageManager.candidates.find((c) => c.manager === "bun");
  if (bunCandidate) {
    bun.push(...bunCandidate.evidence);
    bunConfidence = bunCandidate.evidence.some((e) => e.kind === "lockfile" || e.kind === "package-manager-field") ? "high" : "medium";
  }
  const bunScript = pkg.scripts.find((s) => invokedTool(s.command, BUN_RUNNERS));
  if (bunScript) {
    bun.push({ kind: "script", text: `Script ${quote(bunScript.name)} runs ${invokedTool(bunScript.command, BUN_RUNNERS)!.tool}` });
    if (bunConfidence === "low") bunConfidence = "medium";
  }
  if (bun.length > 0) signals.push({ runtime: "bun", confidence: capAt(bunConfidence, context.scanCap), evidence: bun });

  const files = context.filesByDir.get(directory) ?? [];
  const deno = files.find((f) => /^deno\.jsonc?$/i.test(f));
  if (deno) {
    signals.push({ runtime: "deno", confidence: capAt("medium", context.scanCap), evidence: [{ kind: "project-file", text: `${directory === "." ? deno : `${directory}/${deno}`} is present` }] });
  }
  return signals;
}

function roleOf(directory: string, frameworks: FrameworkDetection[], runnability: RunnabilityInsight, pkg: PackageSummary, context: Context): PackageRole {
  if (context.isWorkspaceRoot(directory)) return "workspace-root";
  const categories = new Set(frameworks.map((f) => f.category));
  if (categories.size > 0) {
    // e.g. a React component library. Backend code without a run script stays
    // "backend"; its runnability already says no run script exists.
    if (runnability.status === "no-run-script" && categories.size === 1 && categories.has("frontend")) return "library";
    if (categories.has("fullstack")) return "fullstack";
    if (categories.has("frontend") && categories.has("backend")) return "mixed";
    return categories.has("frontend") ? "frontend" : "backend";
  }
  if (runnability.status === "has-run-script") {
    const startsNode = runnability.runScripts.some((name) => {
      const script = pkg.scripts.find((s) => s.name === name);
      return script ? invokedTool(script.command, NODE_RUNNERS) !== null : false;
    });
    if (startsNode) return "node-app";
  }
  return "unknown";
}
