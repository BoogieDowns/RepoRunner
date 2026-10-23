// Declarative, bounded detection rules. All patterns here are fixed; nothing
// is ever built from repository content. Script text is untrusted data and is
// only split into tokens and compared for exact equality.
import type { FrameworkCategory, FrameworkId } from "./types";

export interface ScriptTool {
  /** Executable name, compared exactly with a command segment's first token. */
  tool: string;
  /** When given, the next token must be one of these (e.g. "next dev"). */
  subcommands?: readonly string[];
}

export interface FrameworkRule {
  id: FrameworkId;
  label: string;
  category: FrameworkCategory;
  suggestionsSupported: boolean;
  /**
   * Every group must be satisfied by at least one listed dependency name
   * (dependencies or devDependencies), e.g. [["vite"], ["react", ...]].
   */
  dependencyGroups: readonly (readonly string[])[];
  /** Config files (exact basenames, matched case-insensitively) in the package's own folder. */
  configFiles: readonly RegExp[];
  /** True when a config file alone identifies this framework (vite.config doesn't). */
  configIdentifies: boolean;
  scriptTools: readonly ScriptTool[];
  /** True when invoking the script tool alone identifies this framework (plain "vite" doesn't). */
  scriptIdentifies: boolean;
  /** Meta-frameworks built on this one; when one is detected, this one is reported as part of it. */
  supersededBy: readonly FrameworkId[];
  /** Backend libraries have no config or CLI to corroborate them; a runtime dependency is direct evidence. */
  dependencyIsDirect: boolean;
}

const VITE_CONFIG = /^vite\.config\.(js|cjs|mjs|ts|cts|mts)$/i;
const VITE_TOOLS: readonly ScriptTool[] = [{ tool: "vite" }];

export const FRAMEWORK_RULES: readonly FrameworkRule[] = [
  {
    id: "react-vite",
    label: "React + Vite",
    category: "frontend",
    suggestionsSupported: true,
    dependencyGroups: [["vite"], ["react", "@vitejs/plugin-react", "@vitejs/plugin-react-swc"]],
    configFiles: [VITE_CONFIG],
    configIdentifies: false,
    scriptTools: VITE_TOOLS,
    scriptIdentifies: false,
    supersededBy: ["remix"],
    dependencyIsDirect: false,
  },
  {
    id: "vue-vite",
    label: "Vue + Vite",
    category: "frontend",
    suggestionsSupported: true,
    dependencyGroups: [["vite"], ["vue", "@vitejs/plugin-vue"]],
    configFiles: [VITE_CONFIG],
    configIdentifies: false,
    scriptTools: VITE_TOOLS,
    scriptIdentifies: false,
    supersededBy: ["nuxt"],
    dependencyIsDirect: false,
  },
  {
    id: "svelte-vite",
    label: "Svelte + Vite",
    category: "frontend",
    suggestionsSupported: true,
    dependencyGroups: [["vite"], ["svelte", "@sveltejs/vite-plugin-svelte"]],
    configFiles: [VITE_CONFIG],
    configIdentifies: false,
    scriptTools: VITE_TOOLS,
    scriptIdentifies: false,
    supersededBy: ["sveltekit"],
    dependencyIsDirect: false,
  },
  {
    id: "sveltekit",
    label: "SvelteKit",
    category: "fullstack",
    suggestionsSupported: true,
    dependencyGroups: [["@sveltejs/kit"]],
    configFiles: [/^svelte\.config\.(js|cjs|mjs|ts)$/i],
    configIdentifies: false, // svelte.config is also used by plain Svelte
    scriptTools: [{ tool: "vite", subcommands: ["dev", "build", "preview"] }, { tool: "svelte-kit" }],
    scriptIdentifies: false,
    supersededBy: [],
    dependencyIsDirect: false,
  },
  {
    id: "nextjs",
    label: "Next.js",
    category: "fullstack",
    suggestionsSupported: true,
    dependencyGroups: [["next"]],
    configFiles: [/^next\.config\.(js|cjs|mjs|ts|mts)$/i],
    configIdentifies: true,
    scriptTools: [{ tool: "next", subcommands: ["dev", "start", "build"] }],
    scriptIdentifies: true,
    supersededBy: [],
    dependencyIsDirect: false,
  },
  {
    id: "angular",
    label: "Angular",
    category: "frontend",
    suggestionsSupported: true,
    dependencyGroups: [["@angular/core"]],
    configFiles: [/^angular\.json$/i],
    configIdentifies: true,
    scriptTools: [{ tool: "ng", subcommands: ["serve", "start", "build"] }],
    scriptIdentifies: true,
    supersededBy: [],
    dependencyIsDirect: false,
  },
  {
    id: "nestjs",
    label: "NestJS",
    category: "backend",
    suggestionsSupported: true,
    dependencyGroups: [["@nestjs/core"]],
    configFiles: [],
    configIdentifies: false,
    scriptTools: [{ tool: "nest", subcommands: ["start"] }],
    scriptIdentifies: true,
    supersededBy: [],
    dependencyIsDirect: false,
  },
  {
    id: "express",
    label: "Express",
    category: "backend",
    suggestionsSupported: true,
    dependencyGroups: [["express"]],
    configFiles: [],
    configIdentifies: false,
    scriptTools: [],
    scriptIdentifies: false,
    supersededBy: [],
    dependencyIsDirect: true,
  },
  {
    id: "fastify",
    label: "Fastify",
    category: "backend",
    suggestionsSupported: true,
    dependencyGroups: [["fastify"]],
    configFiles: [],
    configIdentifies: false,
    scriptTools: [{ tool: "fastify", subcommands: ["start"] }],
    scriptIdentifies: true,
    supersededBy: [],
    dependencyIsDirect: true,
  },
  {
    id: "nuxt",
    label: "Nuxt",
    category: "fullstack",
    suggestionsSupported: false,
    dependencyGroups: [["nuxt"]],
    configFiles: [/^nuxt\.config\.(js|mjs|ts)$/i],
    configIdentifies: true,
    scriptTools: [{ tool: "nuxt" }, { tool: "nuxi" }],
    scriptIdentifies: true,
    supersededBy: [],
    dependencyIsDirect: false,
  },
  {
    id: "astro",
    label: "Astro",
    category: "frontend",
    suggestionsSupported: false,
    dependencyGroups: [["astro"]],
    configFiles: [/^astro\.config\.(js|cjs|mjs|ts|mts)$/i],
    configIdentifies: true,
    scriptTools: [{ tool: "astro" }],
    scriptIdentifies: true,
    supersededBy: [],
    dependencyIsDirect: false,
  },
  {
    id: "remix",
    label: "Remix",
    category: "fullstack",
    suggestionsSupported: false,
    dependencyGroups: [["@remix-run/dev", "@remix-run/react", "@remix-run/node", "@remix-run/serve"]],
    configFiles: [/^remix\.config\.(js|cjs|mjs|ts)$/i],
    configIdentifies: true,
    scriptTools: [{ tool: "remix" }],
    scriptIdentifies: true,
    supersededBy: [],
    dependencyIsDirect: false,
  },
];

/** Script names that suggest a package can be started, in preference order. */
export const RUN_SCRIPT_CANDIDATES: readonly string[] = ["dev", "start", "serve", "develop", "start:dev", "preview"];

/** Tools that start a Node program directly (evidence for a generic Node app). */
export const NODE_RUNNERS: readonly ScriptTool[] = [{ tool: "node" }, { tool: "nodemon" }, { tool: "ts-node" }, { tool: "tsx" }];

export const BUN_RUNNERS: readonly ScriptTool[] = [{ tool: "bun" }, { tool: "bunx" }];

/** Root-script tools that run several workspace packages. */
export const ORCHESTRATORS = [
  { id: "turbo", match: (t: string[]) => t[0] === "turbo" },
  { id: "nx", match: (t: string[]) => t[0] === "nx" },
  { id: "lerna", match: (t: string[]) => t[0] === "lerna" },
  { id: "pnpm-recursive", match: (t: string[]) => t[0] === "pnpm" && t.some((x) => x === "-r" || x === "--recursive" || x === "--filter" || x.startsWith("--filter=")) },
  { id: "npm-workspaces", match: (t: string[]) => t[0] === "npm" && t.some((x) => x === "-w" || x === "--workspace" || x === "--workspaces" || x.startsWith("--workspace=")) },
  { id: "yarn-workspaces", match: (t: string[]) => t[0] === "yarn" && (t[1] === "workspaces" || t[1] === "workspace") },
  { id: "concurrently", match: (t: string[]) => t[0] === "concurrently" },
] as const;

const MAX_SEGMENTS = 16;
const MAX_TOKENS = 32;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["cross-env", "npx", "bunx", "dotenv"]);

/**
 * Splits a script's command text into command segments (on &&, ||, ;, |, &)
 * and each segment into whitespace tokens, skipping leading environment
 * assignments and simple wrappers (cross-env, npx). Bounded; never executes
 * or evaluates anything. Quotes are not interpreted: a quoted program name
 * simply won't match, which errs on the side of not detecting.
 */
export function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  for (const raw of command.split(/&&|\|\||[;|&]/).slice(0, MAX_SEGMENTS)) {
    let tokens = raw.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
    let guard = 0;
    while (tokens.length > 0 && guard++ < 8) {
      if (ENV_ASSIGNMENT.test(tokens[0])) tokens = tokens.slice(1);
      else if (WRAPPERS.has(tokens[0])) tokens = tokens.slice(1);
      else if ((tokens[0] === "pnpm" || tokens[0] === "npm") && (tokens[1] === "exec" || tokens[1] === "dlx")) tokens = tokens.slice(2);
      else break;
    }
    if (tokens.length > 0) segments.push(tokens);
  }
  return segments;
}

/** The first tool from `tools` that some segment of `command` invokes, if any. */
export function invokedTool(command: string, tools: readonly ScriptTool[]): ScriptTool | null {
  for (const tokens of commandSegments(command)) {
    for (const tool of tools) {
      if (tokens[0] !== tool.tool) continue;
      if (!tool.subcommands || (tokens[1] !== undefined && tool.subcommands.includes(tokens[1]))) return tool;
    }
  }
  return null;
}

/** "pnpm@9.1.0" -> "pnpm"; anything else -> null. */
export function packageManagerFromField(value: string | null): "npm" | "pnpm" | "yarn" | "bun" | null {
  if (!value) return null;
  const name = value.split("@")[0]?.trim().toLowerCase();
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : null;
}

// ---------------------------------------------------------------------------
// What a recognized CLI invocation does. Used to judge run scripts: invoking a
// framework's tool says the framework is used, but only some invocations start
// an application. Small explicit tables; anything not listed is "other" (not
// classified), and a tool that isn't recognized at all is left unclassified.

/** develop: dev server; start: production server; preview: serves a built app; build: builds and exits. */
export type InvocationKind = "develop" | "start" | "preview" | "build" | "other";

export interface RunInvocation {
  tool: string;
  /** The next token; null for the bare tool (or when the next token is an option). */
  subcommand: string | null;
  kind: InvocationKind;
  /** "--watch" / "-w" / "--dev" turns this into a development server (e.g. "nest start --watch"). */
  watchMeansDevelop?: boolean;
}

const VITE_INVOCATIONS: readonly RunInvocation[] = [
  { tool: "vite", subcommand: null, kind: "develop" },
  { tool: "vite", subcommand: "dev", kind: "develop" },
  { tool: "vite", subcommand: "serve", kind: "develop" },
  { tool: "vite", subcommand: "preview", kind: "preview" },
  { tool: "vite", subcommand: "build", kind: "build" },
];

export const RUN_INVOCATIONS: Readonly<Record<FrameworkId, readonly RunInvocation[]>> = {
  "react-vite": VITE_INVOCATIONS,
  "vue-vite": VITE_INVOCATIONS,
  "svelte-vite": VITE_INVOCATIONS,
  sveltekit: VITE_INVOCATIONS,
  nextjs: [
    { tool: "next", subcommand: null, kind: "develop" }, // bare `next` runs the dev server
    { tool: "next", subcommand: "dev", kind: "develop" },
    { tool: "next", subcommand: "start", kind: "start" },
    { tool: "next", subcommand: "build", kind: "build" },
  ],
  angular: [
    { tool: "ng", subcommand: "serve", kind: "develop" },
    { tool: "ng", subcommand: "s", kind: "develop" },
    { tool: "ng", subcommand: "build", kind: "build" },
  ],
  nestjs: [
    { tool: "nest", subcommand: "start", kind: "start", watchMeansDevelop: true },
    { tool: "nest", subcommand: "build", kind: "build" },
  ],
  express: [],
  fastify: [{ tool: "fastify", subcommand: "start", kind: "start", watchMeansDevelop: true }],
  nuxt: [
    { tool: "nuxt", subcommand: "dev", kind: "develop" },
    { tool: "nuxi", subcommand: "dev", kind: "develop" },
    { tool: "nuxt", subcommand: "preview", kind: "preview" },
    { tool: "nuxi", subcommand: "preview", kind: "preview" },
    { tool: "nuxt", subcommand: "build", kind: "build" },
    { tool: "nuxi", subcommand: "build", kind: "build" },
    { tool: "nuxt", subcommand: "generate", kind: "build" },
    { tool: "nuxi", subcommand: "generate", kind: "build" },
  ],
  astro: [
    { tool: "astro", subcommand: "dev", kind: "develop" },
    { tool: "astro", subcommand: "preview", kind: "preview" },
    { tool: "astro", subcommand: "build", kind: "build" },
  ],
  remix: [
    { tool: "remix", subcommand: "dev", kind: "develop" },
    { tool: "remix", subcommand: "vite:dev", kind: "develop" },
    { tool: "remix", subcommand: "build", kind: "build" },
    { tool: "remix", subcommand: "vite:build", kind: "build" },
  ],
};

/** Classifies one command segment against one framework's table; null if its tool isn't invoked. */
export function classifySegment(tokens: readonly string[], invocations: readonly RunInvocation[]): InvocationKind | null {
  const [tool, next] = tokens;
  const forTool = invocations.filter((i) => i.tool === tool);
  if (forTool.length === 0) return null;
  const subcommand = next === undefined || next.startsWith("-") ? null : next;
  const hit = forTool.find((i) => i.subcommand === subcommand);
  if (!hit) return "other";
  if (hit.watchMeansDevelop && tokens.some((t) => t === "--watch" || t === "-w" || t === "--dev")) return "develop";
  return hit.kind;
}

export interface ScriptClassification {
  /** The script's strongest action; "runner" = starts node / nodemon / tsx / ts-node / bun directly; null = nothing recognized. */
  kind: InvocationKind | "runner" | null;
  /** The framework whose tool produced `kind` (null for runners or nothing recognized). */
  frameworkId: FrameworkId | null;
  tool: string | null;
}

const KIND_ORDER: Record<InvocationKind | "runner", number> = { develop: 5, start: 4, runner: 3, preview: 2, other: 1, build: 0 };

/**
 * Classifies a script by its strongest recognized segment, so
 * "tsc && node dist/index.js" starts something while "vite build" only builds.
 * Only the given frameworks' tables are consulted. Bounded, never executes.
 */
export function classifyScript(command: string, frameworkIds: readonly FrameworkId[]): ScriptClassification {
  let best: ScriptClassification = { kind: null, frameworkId: null, tool: null };
  const better = (kind: InvocationKind | "runner") => best.kind === null || KIND_ORDER[kind] > KIND_ORDER[best.kind];
  for (const tokens of commandSegments(command)) {
    for (const id of frameworkIds) {
      const kind = classifySegment(tokens, RUN_INVOCATIONS[id]);
      if (kind && better(kind)) best = { kind, frameworkId: id, tool: tokens[0] };
    }
    if ([...NODE_RUNNERS, ...BUN_RUNNERS].some((r) => r.tool === tokens[0]) && better("runner")) {
      best = { kind: "runner", frameworkId: null, tool: tokens[0] };
    }
  }
  return best;
}

/** Shared by runnability (Stage 2A) and suggestions (Stage 2B), so both read a script the same way. */
export function runStrength(classification: ScriptClassification, frameworks: readonly { id: FrameworkId; confidence: "high" | "medium" | "low" }[]): "high" | "medium" | "low" {
  switch (classification.kind) {
    case "develop":
    case "start": {
      const framework = frameworks.find((f) => f.id === classification.frameworkId);
      return framework?.confidence === "high" ? "high" : "medium";
    }
    case "runner":
      return "medium";
    default:
      // preview serves a build; "other" and unrecognized invocations aren't classified; build doesn't run.
      return "low";
  }
}

export function runEvidenceText(scriptName: string, classification: ScriptClassification): string {
  const label = FRAMEWORK_RULES.find((r) => r.id === classification.frameworkId)?.label ?? classification.tool ?? "";
  const script = `Script "${scriptName}"`;
  switch (classification.kind) {
    case "develop":
      return `${script} starts ${label}'s development server`;
    case "start":
      return `${script} starts ${label}'s production server`;
    case "preview":
      return `${script} runs ${label}'s preview of a production build`;
    case "build":
      return `${script} runs a ${label} build and doesn't start a server`;
    case "runner":
      return `${script} starts ${classification.tool}`;
    case "other":
      return `${script} invokes ${classification.tool} in a way RepoRunner doesn't classify`;
    default:
      return `${script} is defined`;
  }
}
