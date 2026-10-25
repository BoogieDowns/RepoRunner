/*
 * The environment for processes RepoRunner starts in a repository (Install,
 * Start, Restart and Git Pull). It is RepoRunner's own environment, unchanged,
 * except for the few variable names reserved below, so users' toolchains
 * (PATH, PATHEXT, ComSpec, SystemRoot, TEMP, nvm, Volta, npm_config_*,
 * proxies, Git and SSH settings, their own tokens) keep working exactly as
 * before.
 *
 * Defense in depth only: RepoRunner's own secrets (provider keys, Cloud
 * tokens, license keys) must never be put in process.env in the first place.
 * These names are reserved so that, if one ever is, it still can't reach
 * repository code. This filter is not a sandbox: repository processes run as
 * the same Windows user.
 *
 * Pure: no logging, no credential stores, no reading of the real environment
 * (the caller passes it in).
 */

/**
 * Names reserved for RepoRunner-owned secrets. Never set by RepoRunner today.
 * Exact names only, so no user variable is removed by accident.
 */
export const RESERVED_SECRET_VARIABLES: readonly string[] = Object.freeze([
  "REPORUNNER_BYOK_API_KEY",
  "REPORUNNER_CLOUD_ACCESS_TOKEN",
  "REPORUNNER_CLOUD_REFRESH_TOKEN",
  "REPORUNNER_LICENSE_KEY",
]);

const RESERVED_UPPER = new Set(RESERVED_SECRET_VARIABLES.map((name) => name.toUpperCase()));
const RESERVED_EXACT = new Set(RESERVED_SECRET_VARIABLES);

/** Whether `name` is reserved. Windows environment names are case-insensitive; elsewhere they are not. */
export function isReservedSecretVariable(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? RESERVED_UPPER.has(name.toUpperCase()) : RESERVED_EXACT.has(name);
}

/**
 * A fresh copy of `base` without the reserved names. Only string values are
 * kept (an undefined value would mean "unset" anyway); `base` is not changed.
 */
export function buildChildEnvironment(base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== "string") continue;
    if (isReservedSecretVariable(name, platform)) continue;
    // defineProperty keeps every name as data, even one such as "__proto__".
    Object.defineProperty(env, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return env;
}
