/*
 * Internal-development gate for the credential Settings UI (Stage 4C).
 *
 * The UI and its three preload methods exist only when BOTH hold:
 * - RepoRunner runs unpackaged (from a source checkout: `electron .` or the
 *   dev script). Every packaged build (installer or unpacked release folder)
 *   reports app.isPackaged, so it can never turn this on.
 * - The developer launched it with REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS=1.
 *
 * It is off by default, and nothing in a URL, the page, local storage, a
 * repository or the network can turn it on. When on, main.ts passes
 * INTERNAL_CREDENTIAL_SETTINGS_SWITCH to the main window's renderer only, and
 * preload.cts adds the methods only when it sees that switch (Chromium doesn't
 * forward unknown launch switches to renderers). Hiding is not the security
 * boundary: the credential handlers check the sender and every argument
 * whether or not the UI exists.
 */

export const INTERNAL_CREDENTIAL_SETTINGS_ENV = "REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS";
/** Must match the literal in preload.cts (a sandboxed preload can't import this module). */
export const INTERNAL_CREDENTIAL_SETTINGS_SWITCH = "--reporunner-internal-credential-settings";

export function isInternalCredentialSettingsEnabled(isPackaged: boolean, env: Readonly<Record<string, string | undefined>>): boolean {
  return isPackaged === false && env[INTERNAL_CREDENTIAL_SETTINGS_ENV] === "1";
}
