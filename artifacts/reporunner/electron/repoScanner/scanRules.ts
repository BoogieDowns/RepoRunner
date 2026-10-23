import type { ManifestKind, PackageManagerName, WorkspaceSignal } from "./types.js";

/** Default resource limits for one scan. */
export const SCAN_LIMITS = {
  maxDepth: 8,
  maxEntries: 20_000,
  maxDirectories: 5_000,
  maxPackageJsonFiles: 200,
  maxManifestBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  timeBudgetMs: 10_000,
  maxResultBytes: 512 * 1024,
  maxScriptsPerPackage: 100,
  maxDependencyNames: 300,
  maxWorkspacePatterns: 50,
  maxManifests: 500,
  maxEnvFiles: 100,
  maxWarnings: 200,
  maxNodeVersionBytes: 64,
} as const;

export type ScanLimits = { -readonly [K in keyof typeof SCAN_LIMITS]: number };

/** Maximum lengths (in characters) for strings copied from the repository. */
export const TEXT_LIMITS = {
  path: 512,
  packageName: 214,
  version: 64,
  scriptName: 200,
  scriptCommand: 500,
  dependencyName: 214,
  packageManager: 100,
  engine: 100,
  workspacePattern: 200,
  nodeVersion: 32,
  rootName: 200,
} as const;

/** Directories never entered (dependencies, VCS data, build output, caches). */
export const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  ".pnpm-store",
  ".yarn",
  "bower_components",
  ".expo",
  ".vercel",
  ".angular",
  ".gradle",
  ".terraform",
]);

export function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORIES.has(name.toLowerCase());
}

/** .env, .env.local, .env.production, ... — reported by name only. */
export function isEnvFile(name: string): boolean {
  return /^\.env(\..+)?$/i.test(name);
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|ppk|asc|gpg|tfvars|tfstate)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /^(\.npmrc|\.yarnrc|\.yarnrc\.yml|\.netrc|_netrc|\.pgpass|\.htpasswd|\.git-credentials|\.dockercfg|\.pypirc)$/i,
  /credential/i,
  /secret/i,
  /^service-account.*\.json$/i,
];

/** Files whose contents could hold secrets. Never opened; only counted. */
export function isSensitiveFile(name: string): boolean {
  return isEnvFile(name) || SENSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}

/** The only files whose contents the scanner may read. */
export type ReadableFile = "package-json" | "node-version";

export function readableFileType(name: string): ReadableFile | null {
  const lower = name.toLowerCase();
  if (lower === "package.json") return "package-json";
  if (lower === ".nvmrc" || lower === ".node-version") return "node-version";
  return null;
}

const LOCKFILES: Record<string, PackageManagerName> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
};

export function lockfileManager(name: string): PackageManagerName | null {
  return LOCKFILES[name.toLowerCase()] ?? null;
}

const WORKSPACE_FILES: Record<string, WorkspaceSignal> = {
  "pnpm-workspace.yaml": "pnpm-workspace",
  "lerna.json": "lerna",
  "nx.json": "nx",
  "turbo.json": "turbo",
  "rush.json": "rush",
};

export function workspaceSignalForFile(name: string): WorkspaceSignal | null {
  return WORKSPACE_FILES[name.toLowerCase()] ?? null;
}

/** Project files recognised by name. Detected only; never opened (except readable files above). */
const MANIFEST_PATTERNS: Array<[RegExp, ManifestKind]> = [
  [/^package\.json$/i, "package-json"],
  [/^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i, "lockfile"],
  [/^(pnpm-workspace\.yaml|lerna\.json|nx\.json|turbo\.json|rush\.json)$/i, "workspace-config"],
  [/^(\.nvmrc|\.node-version)$/i, "node-version"],
  [/^(tsconfig(\..+)?\.json|jsconfig\.json)$/i, "typescript-config"],
  [
    /^(vite|vitest|next|nuxt|svelte|astro|remix|vue|gatsby-config|gatsby-node|tailwind|postcss|angular)(\.config)?\.(js|cjs|mjs|ts|cts|mts|json)$/i,
    "framework-config",
  ],
  [/^angular\.json$/i, "framework-config"],
  [/^(webpack|rollup|esbuild|babel|tsup)(\.config)?\.(js|cjs|mjs|ts|cts|mts|json)$/i, "build-config"],
  [/^\.babelrc(\.json)?$/i, "build-config"],
  [/^(dockerfile|containerfile|docker-compose\.ya?ml|compose\.ya?ml)$/i, "container"],
  [/^procfile$/i, "process-file"],
  [/^(requirements(-.+)?\.txt|pyproject\.toml|pipfile|setup\.py|setup\.cfg)$/i, "python"],
  [/^go\.(mod|work)$/i, "go"],
  [/^cargo\.toml$/i, "rust"],
  [/^gemfile$/i, "ruby"],
  [/^composer\.json$/i, "php"],
  [/^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/i, "java"],
  [/^deno\.jsonc?$/i, "deno"],
  [/^makefile$/i, "make"],
];

export function manifestKind(name: string): ManifestKind | null {
  for (const [pattern, kind] of MANIFEST_PATTERNS) {
    if (pattern.test(name)) return kind;
  }
  return null;
}
