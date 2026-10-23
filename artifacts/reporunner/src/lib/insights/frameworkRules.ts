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
