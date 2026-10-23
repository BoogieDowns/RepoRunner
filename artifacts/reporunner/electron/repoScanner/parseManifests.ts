import { SCAN_LIMITS, TEXT_LIMITS } from "./scanRules.js";
import type { PackageScript, PackageSummary, RepoScanWarningCode } from "./types.js";

// Characters removed from untrusted text: C0/C1 controls (incl. ESC for ANSI
// sequences), bidirectional overrides/isolates and marks, zero-width
// characters, BOM and line/paragraph separators. Lone surrogates are removed
// separately.
const UNSAFE_RANGES: Array<[number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f], // DEL + C1 controls
  [0x061c, 0x061c], // Arabic letter mark
  [0x200b, 0x200f], // zero-width characters, LRM/RLM
  [0x2028, 0x202e], // line/paragraph separators, bidi embeddings/overrides
  [0x2060, 0x2069], // word joiner, invisible operators, bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];
// Built from code points so no invisible characters appear in this source file.
const UNSAFE_CHARACTERS = new RegExp(
  `[${UNSAFE_RANGES.map(([from, to]) => (from === to ? String.fromCodePoint(from) : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`)).join("")}]`,
  "gu",
);
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Makes untrusted text safe to display as plain text: removes control and
 * direction-changing characters, collapses whitespace and limits the length
 * (counted in code points; truncated text ends with "…").
 */
export function sanitizeText(value: string, maxLength: number): string {
  const cleaned = value
    .replace(LONE_SURROGATES, "")
    .replace(/[\t\n\r]+/g, " ")
    .replace(UNSAFE_CHARACTERS, "")
    .replace(/ {2,}/g, " ")
    .trim();
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= maxLength) return cleaned;
  return `${codePoints.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

/** Root-relative path for display: "/" separators, hazardous characters replaced. */
export function sanitizePathSegments(segments: string[]): string {
  const joined = segments
    .map((segment) => segment.replace(LONE_SURROGATES, "?").replace(UNSAFE_CHARACTERS, "?").replace(/[\t\n\r]/g, "?"))
    .join("/");
  return sanitizeText(joined, TEXT_LIMITS.path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = sanitizeText(value, maxLength);
  return text.length > 0 ? text : null;
}

function dependencyNames(value: unknown, limit: number): { names: string[]; truncated: boolean } {
  if (!isRecord(value)) return { names: [], truncated: false };
  const keys = Object.keys(value);
  return {
    names: keys
      .slice(0, limit)
      .map((key) => sanitizeText(key, TEXT_LIMITS.dependencyName))
      .filter((key) => key.length > 0),
    truncated: keys.length > limit,
  };
}

function workspacePatterns(value: unknown): { patterns: string[]; truncated: boolean; exact: boolean } {
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.packages) ? value.packages : [];
  const recognized = value === undefined || Array.isArray(value) || (isRecord(value) && (value.packages === undefined || Array.isArray(value.packages)));
  const declared = list.filter((pattern): pattern is string => typeof pattern === "string");
  const kept = declared.slice(0, SCAN_LIMITS.maxWorkspacePatterns);
  const patterns = kept.map((pattern) => sanitizeText(pattern, TEXT_LIMITS.workspacePattern)).filter((pattern) => pattern.length > 0);
  // Nothing dropped (so positions line up) and nothing changed.
  const exact = recognized && declared.length === list.length && patterns.length === kept.length && patterns.every((p, i) => p === kept[i]);
  return { patterns, truncated: declared.length > SCAN_LIMITS.maxWorkspacePatterns, exact };
}

export type PackageJsonParseResult =
  | { ok: true; summary: PackageSummary }
  | { ok: false; warning: Extract<RepoScanWarningCode, "manifest-malformed" | "manifest-not-object"> };

/**
 * Parses package.json bytes as data only (JSON.parse; nothing is evaluated).
 * Only own properties are read, so "__proto__"/"constructor" keys are inert.
 */
export function parsePackageJson(
  bytes: Uint8Array,
  relativePath: string,
  limits: { maxScriptsPerPackage: number; maxDependencyNames: number } = SCAN_LIMITS,
): PackageJsonParseResult {
  let data: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    data = JSON.parse(text);
  } catch {
    return { ok: false, warning: "manifest-malformed" };
  }
  if (!isRecord(data)) return { ok: false, warning: "manifest-not-object" };

  const scripts: PackageScript[] = [];
  let scriptsTruncated = false;
  if (isRecord(data.scripts)) {
    const entries = Object.entries(data.scripts).filter(([, command]) => typeof command === "string");
    scriptsTruncated = entries.length > limits.maxScriptsPerPackage;
    for (const [name, command] of entries.slice(0, limits.maxScriptsPerPackage)) {
      const safeName = sanitizeText(name, TEXT_LIMITS.scriptName);
      if (!safeName) continue;
      scripts.push({ name: safeName, nameExact: safeName === name, command: sanitizeText(command as string, TEXT_LIMITS.scriptCommand) });
    }
  }

  const workspaces = workspacePatterns(data.workspaces);
  const dependencies = dependencyNames(data.dependencies, limits.maxDependencyNames);
  const devDependencies = dependencyNames(data.devDependencies, limits.maxDependencyNames);
  const engines = isRecord(data.engines) ? data.engines : {};

  return {
    ok: true,
    summary: {
      path: relativePath,
      name: optionalText(data.name, TEXT_LIMITS.packageName),
      version: optionalText(data.version, TEXT_LIMITS.version),
      private: data.private === true,
      packageManager: optionalText(data.packageManager, TEXT_LIMITS.packageManager),
      engines: { node: optionalText(engines.node, TEXT_LIMITS.engine) },
      scripts,
      scriptsTruncated,
      dependencies: dependencies.names,
      devDependencies: devDependencies.names,
      dependenciesTruncated: dependencies.truncated || devDependencies.truncated,
      workspaces: workspaces.patterns,
      workspacesTruncated: workspaces.truncated,
      workspacesExact: workspaces.exact,
    },
  };
}

const NODE_VERSION_PATTERN = /^(v?\d{1,3}(\.\d{1,4}){0,2}|lts\/[a-z*-]{1,20}|node|stable|latest)$/i;

/** First line of .nvmrc / .node-version, returned only if it looks like a Node version. */
export function parseNodeVersion(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = withoutBom.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!NODE_VERSION_PATTERN.test(firstLine)) return null;
  return sanitizeText(firstLine, TEXT_LIMITS.nodeVersion);
}
