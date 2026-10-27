# AGENTS.md — RepoRunner

Guidelines for Codex, Replit agents, and other AI coding assistants working in this repo.

---

## Project purpose

RepoRunner is a focused desktop-style app that lets users run local GitHub repos through a saved setup profile and a fixed button panel. It is a thin, opinionated control panel — not a platform.

The core user flow is:
1. Fill setup once
2. Pull, install, start, stop, restart, open preview, view logs — all with buttons

---

## Product boundaries

Do not expand RepoRunner into:

- An IDE or code editor
- A deployment or hosting platform
- An autonomous agent that edits code or runs commands on its own
- A project management or task tracking tool
- A multi-project runner (RepoRunner keeps up to 5 saved setups but runs one active repo at a time)
- A GitHub OAuth integration
- A repo cloning tool

If a feature request falls outside the core run-loop (pull → install → start → stop → restart → preview → logs), ask for explicit confirmation before implementing it.

### Approved future directions (each needs separate authorization)

RepoRunner is planned to become one app with three editions (planning names, not yet published branding): **RepoRunner Free**, **RepoRunner BYOK Pro** (one-time purchase; the user's own AI provider key or a compatible local AI) and **RepoRunner Cloud Pro** (subscription; managed AI with a RepoRunner account). There is no separate fourth "RepoRunner Pro" edition. See [Architecture notes](../../docs/ARCHITECTURE_NOTES.md#three-edition-direction) for the confirmed decisions and what is still open. None of this is implemented yet. The following may be built **only when a task explicitly authorizes that stage**:

- Free, BYOK Pro and Cloud Pro edition capabilities, through one central capability and entitlement model
- Optional AI-powered repository assistance that explains or suggests, and never acts by itself. Planned in this order: (1) AI-assisted setup recommendations, (2) explanations of failed runs from user-approved log excerpts
- BYOK Pro AI configuration: a supported provider API key, or a compatible local AI endpoint
- BYOK Pro license handling (the activation and verification design is not decided yet)
- Browser-based sign-in for Cloud Pro accounts (system browser, OAuth/OIDC with PKCE)
- Server-side managed AI operations for Cloud Pro
- Entitlement, quota and usage enforcement

### Guardrails for edition, account and AI work

These always apply, whatever a task authorizes, unless the product owner explicitly changes them:

- **No mandatory login.** The Free/local workflow (setups, pull, install, start, stop, restart, preview, logs, Analyze Repo, Suggested Setup, Use in Setup, Repo Safety Check) must keep working without an account, offline.
- **Opt-in only.** Accounts, provider keys and AI features are additions the user turns on. Nothing is enabled or sent by default.
- **No automatic upload.** Repository content (files, scripts, logs, paths) is never sent anywhere automatically. Each AI request shows what will be sent and needs the user's consent.
- **No automatic execution.** AI output is shown as plain text. It never runs repository scripts or commands, and never applies or saves setup changes by itself.
- **A license is not readiness.** A valid BYOK Pro license only permits AI features; they are usable only once a supported provider key or local AI endpoint is configured. Cloud Pro features need a signed-in account and an entitlement confirmed by the backend. Free local features never depend on AI, a license or an account.
- **Secrets stay in the main process.** Provider keys, license secrets and account tokens are never returned to the renderer over IPC, never written to `reporunner-project.json` or other ordinary setup/settings files, never logged, and never put in the environment of processes RepoRunner starts.
- **Enforcement at the right boundary.** The renderer only displays capabilities. Desktop-sensitive operations are enforced in the main process; managed Cloud services are enforced by the backend. A disabled button is not security.
- **Hardening stays.** Keep the Electron sandbox, context isolation, the production Content Security Policy (including `connect-src 'none'` for the renderer), navigation and new-window blocking, permission denial, and the read-only scanner and its limits. Don't loosen them to add accounts or AI.
- **Narrow network access.** Each new network integration must be explicitly authorized and limited to named endpoints for a named purpose. No general-purpose proxy, no arbitrary URLs, no unrestricted AI network access. A local AI endpoint is also a named endpoint the user configures, and it gets the same consent and data-disclosure rules.
- **Out of scope unless separately approved:** cloud sync of repositories or setups, remote command execution, broader scanner access, and GitHub OAuth.

Don't remove the 5-saved-setup limit (`MAX_FREE_REPO_PROFILES`) or change edition wording in the UI unless a task authorizes it. The Setup screen's current "RepoRunner Pro" text is a pending terminology migration, not a fourth edition and not permission to change the copy.

---

## UI direction — preserve

RepoRunner uses a dark sci-fi control-panel aesthetic. Do not drift toward generic SaaS styling or light themes.

Current visual direction:
- Black / near-black background
- Crimson glass action buttons (dark ruby/crimson, premium reflective surface)
- Smoked-glass neutral buttons (secondary actions)
- RR logo in the top-left header
- Red plastic ribbed engine status lights
- Terminal-style log panel with colored source labels
- Cinematic red/crimson meteor background effects
- Ripple animation on the log panel divider

---

## Layout preservation rules

Do not change the following without explicit instruction:

### Dashboard layout

Quick Actions button order:
- Row 1: **Start Frontend · Start Backend · Stop Engine**
- Row 2: **Pull · Install · Restart · Open**

Do not change button labels, order, row assignment, or sizing.

### Engine card

- Frontend and Backend service rows with status lights
- Lights are square red plastic/ribbed lens modules
- Stopped state = blank dark shell (same physical size as active)
- Active/transition states all display `RUNNING` inside the lens
- No spinner, no `STARTING` / `STOPPING` / `STOPPED` text inside the light

### Setup modal

Field layout (top to bottom):
1. Project Name | Local Repository Folder + Choose button
2. Preview URL (full width)
3. Install Command | Frontend Command | Backend Command (3-column)
4. Frontend Port | Backend Port (2-column, left-anchored at ~50% width)
5. Save button: **Save Repo Setup** for a new setup, **Update Repo Setup** for a saved one

### Log panel

Source label colors — do not change:
| Source | Color |
|---|---|
| `[SYSTEM]` | `#D9D7D5` |
| `[GIT]` | `#7CFF6B` |
| `[INSTALL]` | `#FFB06A` |
| `[BACKEND]` | `#9B3F67` |
| `[FRONTEND]` | `#cc4444` |

---

## Protected shared files

| File | Reason |
|---|---|
| `src/types.ts` | Shared type contract used by renderer, Electron, and mock |
| `src/mock/repoRunnerMock.ts` | Browser mock for Replit preview — must stay in sync with the real IPC surface |

Do not modify these files unless the task explicitly authorizes it.

When a feature is explicitly authorized and needs them, **additive** changes are permitted: new shared types or constants, new optional fields, new `RepoRunnerAPI` methods or optional parameters, and the matching mock implementations. Do not remove, rename or change the meaning of existing definitions unless explicitly instructed, and do not make unrelated edits to either file.

---

## Development rules

- Make **narrow, targeted changes** only — do not refactor unrelated code while implementing a feature
- Inspect the live preview before making UI changes where possible
- Do not change functionality during visual polish passes
- Do not "improve" completed areas unless explicitly asked
- Keep the browser mock (`repoRunnerMock.ts`) in sync with any IPC surface changes
- When adding a new IPC handler: update `ipc.ts`, `preload.cts`, `types.ts` (the `RepoRunnerAPI` interface), and `repoRunnerMock.ts` together
- Avoid broad refactors during small, scoped tasks
- If a change affects the Electron main process, rebuild with `electron:build-main` before testing

---

## IPC surface

All renderer ↔ main communication goes through `window.repoRunner` (injected via `contextBridge` in `preload.cts`).

Current API methods:
- `selectFolder()` — native folder picker
- `saveProject(profile)` / `loadProject()` — JSON persistence
- `pullLatest()` — `git pull` in repo directory
- `runInstall()` — runs install command
- `startFrontend()` / `startBackend()` — spawn service processes
- `stopServices()` — tree-kill + port verification
- `restartAll()` — stop → start backend → start frontend (sequential)
- `openPreview()` — `shell.openExternal(previewUrl)`
- `copyLogs()` / `clearLogs()` — clipboard + log management
- `onLog(cb)` / `onStatus(cb)` — live event subscriptions (return unsubscribe functions)

The `RepoRunnerAPI` interface in `src/types.ts` is the authoritative contract; the list above is not complete (it predates saved-setup management, store recovery and Analyze Repo).

Every IPC handler checks its sender first with `isTrustedSender` (`electron/ipcTrust.ts`). Handlers in `ipc.ts` are registered only through its `handle()` guard; any new handler must go through that guard (or the same check), before any side effect.

### Credentials (main process only)

- `electron/credentialStore.ts` encrypts remembered keys with `safeStorage` into `reporunner-credentials.json`, or keeps them for the session only. No plaintext fallback.
- `electron/credentialService.ts` owns **the one** store, created lazily on first use. Never construct another `CredentialStore`; future main-process consumers (such as a provider adapter) use `getCredentialStore()`.
- `credential-status`, `credential-set` and `credential-remove` (`electron/credentialIpc.ts`, registered in `ipc.ts`) return metadata and fixed error codes only.
- **Internal-only Settings (Stage 4C).** The preload adds `credentialStatus`, `setCredential` and `removeCredential` (optional in `RepoRunnerAPI`, absent from the mock), and the Dashboard shows a Settings button, **only** in an internal development launch: unpackaged and started with `REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS=1` (`electron/internalFeatures.ts`). Every packaged build ignores this, so users never see it. Making it available to users needs its own authorization. Hiding isn't the security boundary: the handlers check the sender and arguments either way.
- **One-way rule:** a newly entered key may travel renderer → main once, as the secret argument of `credential-set`. A stored key is **never** returned to the renderer: no "get" channel, and no key in any result, error or log.
- The same-user limitation stays: any program running as the same Windows user, including repository scripts RepoRunner starts, can ask Windows to decrypt the stored key. Don't describe this storage as fully secure.

### AI settings (main process only)

- `electron/aiSettingsService.ts` owns **the one** `AiSettingsStore` (`reporunner-ai-settings.json`, non-secret, validated by the Stage 4E schema in `src/lib/ai/`), created lazily on first use. Never construct another store; use the service's functions. Nothing calls it yet: wiring it to startup, IPC or UI needs its own authorization.
- Provider readiness stays `none` while `PRODUCTION_AI_ADAPTERS` is empty. A saved configuration is not connectivity, a license or consent, and never makes an AI feature usable.
- `ai-config-status` (`electron/aiConfigIpc.ts`, registered in `ipc.ts` through the guard) is read-only and returns that metadata only. No preload method exposes it; adding one, or any AI settings write channel, needs its own authorization.

---

## Testing and validation

After any non-trivial change, verify:

- [ ] Setup save and load (config persists on reload)
- [ ] All Quick Actions buttons: Pull, Install, Start Frontend, Start Backend, Stop Engine, Restart, Open
- [ ] Log panel: output appears, source colors are correct, Copy and Clear work, count updates
- [ ] Engine lights: stopped = blank dark, active = RUNNING (no spinner, no status text inside)
- [ ] Setup modal: opens via Edit Setup, fields populate if project exists, Save updates dashboard, X closes without saving
- [ ] No console errors or runtime exceptions
- [ ] Browser mock behaves correctly in Replit web preview

---

## Crimson color anchor

Primary brand color: `#9F0D1C` — dark crimson (hsl 354 82% 34%).

CSS variables are defined in `src/index.css` under `:root`. The glass button system is in `.btn-glass`, `.btn-glass-primary`, `.btn-glass-danger`, and `.btn-glass-secondary` classes. Do not introduce separate color systems or override these with inline styles unless making a targeted, documented change.
