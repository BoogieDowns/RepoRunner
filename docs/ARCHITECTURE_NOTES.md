# RepoRunner Architecture Notes

## Product direction

RepoRunner should remain local-first.

The core app should help users run and verify local repos without terminal friction. It should not become a code-editing agent in the near term.

Code changes should continue to happen through the normal GitHub / Codex / branch / PR workflow. RepoRunner’s job is to help users pull, run, restart, inspect, and verify those changes locally.

## Core desktop workflow

RepoRunner’s core workflow should support:

- Importing a local repo folder
- Saving a run setup once
- Pulling the latest branch changes
- Running install when needed
- Starting frontend services
- Starting backend services
- Stopping services
- Restarting services
- Opening the local preview URL
- Showing logs
- Copying logs

The basic local repo-running workflow should not require login.

## Scope boundary

RepoRunner should not become Codex.

RepoRunner should not make source-code changes automatically in the near term. If future code-editing capabilities are considered, they should be optional, approval-based, and kept separate from the local runner core.

The product should focus first on being a reliable local repo cockpit.

## Future optional layers

The following layers may be added later, but they should sit around the local runner core rather than inside it:

- GitHub OAuth for repo, branch, and PR awareness
- Account/login for paid features
- Billing/subscription for Pro features
- Cloud sync for saved repo setups and settings
- AI/log diagnosis for common local run failures
- Smarter setup detection for package managers, scripts, ports, and changed lockfiles

## Architecture rule

Keep these concerns separate:

- Local runner logic
- Process management
- Repo configuration storage
- UI components
- GitHub integration
- Account/authentication
- Billing
- Cloud sync
- AI/log diagnosis

The local runner should continue to work even if account, billing, cloud, or AI features are unavailable.

Account/authentication, billing and AI features are now an approved direction (see "Three-edition direction" below). GitHub OAuth and cloud sync of repositories or setups remain future layers that need their own approval.

## Possible pricing boundary later

Free:

- Limited saved repos
- Basic pull/install/start/stop/restart/logs

Pro:

- Unlimited saved repos
- Branch awareness
- Smarter setup detection
- Error diagnosis
- Sync/settings features

This Free/Pro split is superseded as a direction by the three-edition model below. The "Pro" wording is still in the app (see "Pending terminology migration").

## Three-edition direction

Status: **approved direction, not implemented.** Each stage needs its own authorization (see `artifacts/reporunner/AGENTS.md`, "Approved future directions" and "Guardrails").

RepoRunner is planned as **one Electron app** with three editions, not separate builds:

- **Free:** the shared local core, no account.
- **BYOK** (bring your own key): Free, plus optional AI features using the user's own AI provider key.
- **Cloud:** Free, plus a RepoRunner account and managed AI features run by a RepoRunner backend.

### Implemented today

Verified in code at `0ebf03a`; none of the edition features exist yet.

- Local core: saved setups (up to 5, `MAX_FREE_REPO_PROFILES`, enforced in the main process by `electron/projectStore.ts` and shown in the UI), pull, install, start, stop, restart, preview, logs.
- Analyze Repo, Suggested Setup, Use in Setup and the Repo Safety Check: local and read-only, with no network access.
- Electron hardening: sandbox, context isolation, no Node integration, navigation and new-window blocking, permission denial, and a production Content Security Policy with `connect-src 'none'`, so the renderer can't make network requests.
- Saved setups in `reporunner-project.json` under Electron's user-data folder, written atomically with backups and recovery copies. A newer schema version is opened read-only.
- No accounts, sign-in, AI integration, credential storage, settings screen, auto-update or network calls (apart from opening the preview URL in the browser).

### Approved architectural direction

- **Shared local core** stays identical in every edition and works offline without an account.
- **Central capability and entitlement model**: one pure module decides what is available from the edition state (signed in or not, provider key configured or not, entitlement active, expired or revoked, online or offline). UI components ask it; they don't check editions themselves.
- **Main-process enforcement** for desktop-sensitive operations: credential storage, provider requests, and anything that leaves the machine. The renderer only displays.
- **Backend enforcement** for managed Cloud services: authentication, entitlements, quotas, usage metering and the AI provider calls. A tampered local state can only change what the app shows.
- **BYOK**: the provider key is held by the main process in OS-backed encrypted storage (Electron `safeStorage`), separate from setup files; requests go from the main process to the chosen provider.
- **Cloud sign-in**: the system browser with OAuth/OIDC and PKCE, using a managed identity service. No passwords handled by RepoRunner.
- **Managed AI is not repository sync.** Cloud v1 sends only what the user approves for a specific AI request. Uploading repositories, syncing setups and remote execution are not part of it.

### Security prerequisites

These must be addressed before the related stage ships:

1. **Consistent IPC sender validation.** Today only `analyze-repo` and `cancel-repo-analysis` check the sender (`isTrustedSender`); the other handlers in `electron/ipc.ts` don't. Every handler should, before any credential, account or AI IPC is added.
2. **Secret storage and the same-user risk.** Commands RepoRunner starts run as the same Windows user, so a malicious repository script could ask Windows to decrypt secrets stored with OS-backed storage. This needs a prototype and an explicit, documented risk decision (for example a "don't remember this key" option and provider-side spending limits).
3. **Environment inheritance.** Every command RepoRunner starts gets a copy of the main process's environment (`electron/commandUtils.ts`, and `git pull` in `electron/ipc.ts`). Secrets must never be placed there; moving to an explicit environment allowlist needs compatibility testing with users' toolchains (PATH, nvm, Volta, corepack).
4. **Consent and disclosure for AI requests.** Before anything is sent, show exactly what will be sent and to whom; logs can contain secrets and need redaction.
5. **Secure browser sign-in and backend enforcement.** A single-use loopback callback with `state` and PKCE, short-lived tokens with refresh rotation, and entitlements and quotas checked by the backend, never trusted from the client.

### Undecided (product owner)

- Edition names in the app, and whether "Pro" survives (see below).
- Whether BYOK is paid. If it is, it needs a license or an account; if not, it can stay account-free.
- The saved-setup limit for each edition, and what a downgrade does to setups over the limit.
- The first AI features and exactly what data each one sends.
- AI providers, billing provider, offline grace period for Cloud entitlements, and data-retention terms.

### Pending terminology migration

The Setup screen (`src/components/SetupScreen.tsx`) and the saved-setup limit message (`electron/projectStore.ts`) say "RepoRunner Free", and the Setup screen promises that "RepoRunner Pro will unlock unlimited saved repos and repo library features". The planned vocabulary is **Free, BYOK, Cloud**. Changing this wording is a separate, authorized UI task once the editions and the saved-setup limits are decided. Until then the existing copy and the 5-setup limit stay as they are.

### Release state

The app's internal version is 0.1.4; the latest public release is v0.1.3. The three-edition work takes priority over publishing v0.1.4 now. Nothing has been tagged, packaged or published for v0.1.4.

### Proposed stages

Each stage needs separate authorization:

0. Governance and architecture alignment (this section and the `AGENTS.md` guardrails).
1. Pure capability and entitlement model, with no runtime change.
2. IPC sender validation on every handler.
3. Environment allowlist for started commands, with compatibility testing.
4. Settings file and Settings screen (Free only).
5. BYOK credential storage.
6. A first BYOK AI feature with consent and disclosure.
7. Cloud backend MVP.
8. Cloud sign-in and entitlements in the app.
9. Billing.

## UI reference

The README contains screenshots of the current UI and prior visual direction. Use those screenshots as visual reference when rebuilding or polishing the local app UI.

Future UI work should preserve the intended RepoRunner visual direction unless there is a clear reason to change it.
