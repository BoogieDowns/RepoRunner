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
- Billing: a one-time license for BYOK Pro and a subscription for Cloud Pro
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

This Free/Pro split is superseded by the three-edition model below. "Pro" survives only as part of two edition names, RepoRunner BYOK Pro and RepoRunner Cloud Pro; there is no separate "RepoRunner Pro" edition. The app's current "RepoRunner Pro" wording is a pending terminology migration (see below).

## Three-edition direction

Status: **approved direction, not implemented.** Each stage needs its own authorization (see `artifacts/reporunner/AGENTS.md`, "Approved future directions" and "Guardrails").

RepoRunner is planned as **one Electron app** with three editions, not separate builds. The names below are planning names, not yet published branding.

### Confirmed product decisions

**RepoRunner Free**

- Free to use, with no mandatory RepoRunner account.
- The local-first capabilities keep working offline: saved setups, pull, install, start, stop, restart, preview, logs, Analyze Repo, Suggested Setup, Use in Setup and the Repo Safety Check.
- No managed AI service is required.
- The current limit of 5 saved setups stays unchanged. Limits for other editions aren't decided.

**RepoRunner BYOK Pro**

- A paid edition, bought once. There is no recurring RepoRunner subscription.
- The user supplies a supported AI provider API key, or connects a compatible local AI. External provider charges, where they apply, are the user's; local models may work without external API charges.
- Users are intended to keep access to the software they bought. This doesn't promise every future major-version upgrade (upgrade rights are undecided).
- An account-light, offline-capable license design is preferred, but account-free activation is **not** decided.
- License validity and AI readiness are separate states: a valid license permits AI features; they are usable only once a key or local AI endpoint is configured.
- No licensing functionality exists yet.

**RepoRunner Cloud Pro**

- A recurring paid subscription with a RepoRunner account and sign-in.
- A managed AI service, with entitlements, quotas and usage limits enforced by the backend.
- The shared local core stays available on its own, independent of the subscription.
- Cloud Pro does **not** imply repository sync, source-code hosting or remote command execution.

**AI features, in priority order**

1. **AI-assisted repository setup recommendations** (first). It builds on the deterministic Analyze Repo and Suggested Setup:

   Analyze Repo → Suggested Setup → opt-in AI assistance → review the recommendations → edit or apply manually → explicit Save.

   - No automatic AI request.
   - Before anything goes to a remote provider, show exactly what would be sent, and ask for consent.
   - AI-generated commands are untrusted: never executed or saved automatically.
   - The scanner's read-only boundaries stay as they are.
   - It must work with both remote APIs and compatible local models.
   - The exact input, model interface and consent design are still to be designed and validated.

2. **Explanations of failed runs and errors from user-approved log excerpts** (second; deferred until separately authorized).
   - Opt-in only, with a clear preview of the log data before any remote transmission.
   - Secrets are redacted.
   - No automatic fixes and no command execution.

### Implemented today

Verified in code at `0ebf03a`; none of the edition features exist yet.

- Local core: saved setups (up to 5, `MAX_FREE_REPO_PROFILES`, enforced in the main process by `electron/projectStore.ts` and shown in the UI), pull, install, start, stop, restart, preview, logs.
- Analyze Repo, Suggested Setup, Use in Setup and the Repo Safety Check: local and read-only, with no network access.
- Electron hardening: sandbox, context isolation, no Node integration, navigation and new-window blocking, permission denial, and a production Content Security Policy with `connect-src 'none'`, so the renderer can't make network requests.
- Saved setups in `reporunner-project.json` under Electron's user-data folder, written atomically with backups and recovery copies. A newer schema version is opened read-only.
- No accounts, sign-in, licensing, AI integration, settings screen, auto-update or network calls (apart from opening the preview URL in the browser).

Security groundwork added since then (none of it is visible in the app):

- **Stage 2, IPC sender validation:** every IPC handler checks its caller first with `isTrustedSender` (`electron/ipcTrust.ts`): only RepoRunner's own page, in the main window's top-level frame. Anything else is refused with one fixed message, before any side effect.
- **Stage 3B, child environment:** commands RepoRunner starts (Install, Start, Pull) get the main process's environment through `buildChildEnvironment` (`electron/childEnvironment.ts`), which removes the names reserved for RepoRunner secrets (`REPORUNNER_BYOK_API_KEY`, `REPORUNNER_CLOUD_ACCESS_TOKEN`, `REPORUNNER_CLOUD_REFRESH_TOKEN`, `REPORUNNER_LICENSE_KEY`). It is not a full allowlist: everything else is still inherited.
- **Stage 3C, Windows command lookup:** saved commands run on Windows with `NoDefaultCurrentDirectoryInExePath` set, so `cmd.exe` doesn't run a same-named program from the repository folder instead of the intended tool.
- **Stage 3D, credential store:** `electron/credentialStore.ts` stores BYOK credentials in their own file, `reporunner-credentials.json` in user data, encrypted with Electron `safeStorage` (DPAPI on Windows). There is no plaintext fallback: remembering a key is refused when encryption is unavailable, or on Linux when the backend is `basic_text` or unknown. A key can instead be kept for the session only, in memory. Damaged or newer files are refused and never rewritten.
- **Stage 4B, credential service and IPC:** `electron/credentialService.ts` creates the one store lazily, on the first credential call, never at startup; Free workflows never read the credentials file. `electron/credentialIpc.ts` handles three channels, registered in `ipc.ts` through the same sender guard: `credential-status`, `credential-set` and `credential-remove`, for one slot (`byok-slot-1`). They return metadata and fixed error codes only.
- **Stage 4C, internal credential Settings:** a small "AI provider key" dialog (status, save for the session or remember, replace, remove with confirmation) for internal testing only. It and its three preload methods exist only in an unpackaged launch started with `REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS=1`; every packaged build ignores that, so **users never see it**. The typed key stays in a password field until Save, which clears the field before sending; it is never shown again, stored in the page or returned. Saving a key connects to nothing: no provider, validation or AI feature exists yet.
- **Stage 4K, AI configuration editing IPC (main process only, not exposed):** `ai-config-edit-load` and `ai-config-edit-save` (`artifacts/reporunner/electron/aiConfigEditIpc.ts`), registered in `ipc.ts` through the shared sender guard and behind the same startup-decided internal gate as the credential handlers (27 handlers in all). Order: sender check, gate (`not-available` when off, before the request is looked at), exact arguments, then the AI settings service.
  - **Load** (no arguments): `{ ok: true, state: "missing" | "valid", revision, settings }` with the validated v1 document copied field by field (a missing file gives the empty document and `revision: null` and creates nothing), or a fixed `damaged` (with the fixed reason), `unsupported-version`, `unreadable` or `failed`. Never the file's contents, a path or a system error.
  - **Save** (exactly `(settings, expectedRevision)`; a plain object, and `null` or 64 lowercase hex characters): whole-document replacement through the existing service, so the Stage 4E schema (loopback-only endpoints, at most three configurations, no secrets, 16 KiB), the store's revision check and its atomic write all apply. Returns the document as parsed back from the bytes written, with the new revision, or a fixed `invalid-settings` (with the schema's detail code), `conflict` (no document), `damaged`, `unsupported-version`, `unreadable`, `write-failed` or `failed`. Damaged, newer and non-regular files are never replaced.
  - No preload method, renderer API or UI reaches these channels (that's a later stage); `ai-config-status` still carries no revision. No credentials, endpoint connections or network access; readiness stays `none`.
- **Stage 4L, internal AI configuration editor:** in the same internal launches, the preload adds `aiConfigEditLoad()` and `aiConfigEditSave(settings, expectedRevision)` (exact arguments, one channel each), and the internal Settings dialog gains a "Local AI configurations" section. Internal users can add a local endpoint (address, API style, optional model label), edit or remove one (removal asks inline, and clears the selection when it was active), choose the active configuration or none, and save the whole document.
  - Addresses are checked as typed with the Stage 4E validator, with fixed messages; a valid address written differently shows its exact canonical form and is used only after "Use this address". The main process validates everything again.
  - New ids are `cfg-` plus 16 characters from `crypto.getRandomValues` (rejection-sampled), never derived from the endpoint; edits keep the id.
  - The editor loads once per opening (never at startup), keeps the revision only in memory, saves with it, and chains to the returned one. A conflict shows a fixed message and a Reload (which asks before discarding unsaved changes); nothing is retried or merged. Damaged, newer and unreadable files disable editing, with no reset. Late or stale answers are ignored, nothing is sent after close, a save can't be submitted twice, and closing with unsaved changes (including text typed into an open form) asks first (Escape keeps editing). While a save or key change is in flight the dialog can't close, even after confirming; if the save finishes while the question is showing, the question is withdrawn.
  - The edit and status contracts are shared in `src/types.ts`; `electron/aiConfigEditIpc.ts` uses the same types. The focus trap now includes `select` and `textarea`. After a save the read-only status line is re-read.
  - A saved configuration is never described as connected or ready: "Saved. Not connected — no AI connection is available in this version." No credentials, endpoint connections or network access; readiness stays `none`. Packaged builds and ordinary launches expose neither the methods nor the UI.
- **Stage 4N, local probe transport (not wired up):** `src/lib/ai/probeSpec.ts` (pure, shared so a future preview shows exactly what is sent) and `electron/localProbe.ts` (main process) implement one bounded, loopback-only compatibility request for a saved configuration, following the Stage 4M design.
  - Request: `GET {basePath}/api/version` (ollama-native) or `GET {basePath}/models` (openai-compatible), with no fallback or implied `/v1`, exactly five headers and no body, cookie or credential. Only canonical `http://127.0.0.1:<port>` or `http://[::1]:<port>` endpoints (the Stage 4E validator, re-run); anything else is refused before any socket exists.
  - Transport: Node `http.request` over a socket the module opens itself to the literal address and family, with a lookup that refuses, so there's no DNS. There is no agent (Node writes straight to that socket), so proxy settings, including Node 24's `NODE_USE_ENV_PROXY`, pooling and keep-alive don't apply. The client follows no redirects and uses strict parsing with a 16 KiB header limit. Before anything is written, the socket's remote address, port and family, and its loopback local address, must match. A note for later work: in Node, `agent: false` doesn't mean "no agent"; it creates a fresh Agent that ignores `createConnection`.
  - Answers: anything but 200 is a fixed result without reading the body (3xx `redirect-refused`, 401/403 `auth-required`, 404 `not-found-at-path`, others `http-error` with the status class). A 200 needs `application/json` and no compression, and the body is counted while streaming (8 KiB or 256 KiB; one byte more is `response-too-large`). The body is then decoded as strict UTF-8 and JSON, and only the expected fields are read as own data properties: a bounded version, or `object: "list"` with at most 1,000 entries whose ids are 1–256 characters. Only a model count comes back; never a version, model name, header, body or error text.
  - Time: connect 2 s, headers 3 s after connecting, 2 s between chunks, 8 s overall, each its own timer; a caller may shorten them, never lengthen them. A caller-owned AbortSignal cancels in any phase. Every call settles once, clears its timers, removes its abort listener and destroys its request and socket. There are no retries, caches, global state, logs or files. One-at-a-time and cooldown limits are left to a future IPC service.
  - Reachable only through the Stage 4O probe IPC (below); no preload, UI, startup or timer calls it. The renderer CSP keeps `connect-src 'none'`. A compatible answer says only that something on that loopback port answered in the expected shape: not which program, not trust, not readiness.
  - **Upgrade-sensitive:** the guarantees above depend on Node's HTTP client behavior (no agent plus `createConnection` means the checked socket is used; no proxy settings; no redirect following). Re-verify with `tests/electron/localProbe.test.ts` and a real-Electron probe on every Electron or Node upgrade.
- **Stage 4O, probe IPC (internal only, no renderer exposure):** `ai-config-probe` in `electron/aiProbeIpc.ts`, registered in `ipc.ts` through the sender guard and the startup-decided internal gate (28 guarded handlers).
  - Contract: exactly `(configId, expectedRevision)`: a saved configuration id and the 64-hex revision of the document the caller loaded. No URL, host, port, path or object is accepted. The destination always comes from the saved file.
  - Order: sender, gate, arguments, saved settings (through the shared service; missing, damaged, newer and unreadable files are fixed errors and nothing is created), revision (`conflict`), the id in that document (`not-found`), the stored endpoint checked again (`invalid-configuration`), project ports (`port-in-use-by-project`), then busy and cooldown, then the Stage 4N transport (which validates the endpoint once more).
  - Project ports (`getTrackedServicePorts()` in `processManager.ts`; read-only, and service start and stop behavior is unchanged):
    - **Launch port:** the port a service's process was actually spawned with, set at spawn. A later setup edit never changes it, and Stop's port (the current setup's, used only for its existing diagnostics) is never recorded. It's reported while that process is tracked or a stop is in progress.
    - **Possible orphans:** when a root process exits, its launch port is recorded for that service immediately, before any await and whatever run is current. A service keeps a set, so several orphaned ports (for example after the setup's port changed between runs) are all kept, deduplicated, and frontend and backend are separate. A refused restart, a Stop that finds nothing tracked, and later runs never remove entries.
    - **Clearing:** an entry is removed only by a check of that exact port that finds it free (the exit's own check, the next start's port check, or Stop Engine re-checking the service's recorded ports one by one), and only if the entry still has the generation the check began with. So an older check can never clear a newer run's record of the same port. A port found in use is never recorded, so an unrelated process is never attributed to a run. A recorded port that was freed and then taken by something else before any check stays protected (the conservative direction) until a check sees it free. While RepoRunner is quitting, nothing is checked.
    - **Not known:** a project process RepoRunner didn't start, or a service started without a configured port. An unrelated local server on a port nobody recorded is probed, which is the probe's purpose. The dev server's port (development launches only) is added. No port is scanned or checked, and no process is enumerated. Limitations: a project process RepoRunner didn't start, or a service started without a configured port, isn't known; an unrelated local server on the configured port is probed, which is the probe's purpose.
  - One shared coordinator per main process: at most one probe at a time (`busy`), and none within 2 s (monotonic clock) after the last probe finished (`rate-limited`). These are checked and taken in one synchronous step, with no retries or queue. Calls refused earlier never touch either. State is in memory only.
  - Cancellation: the coordinator owns the transport's AbortController. The calling webContents being destroyed or its renderer gone aborts it (`cancelled`), and the transport's own 8 s deadline always applies. There is no cancellation channel, and closing the Settings dialog doesn't cancel.
  - Results: `{ ok: true, outcome }` with at most a bounded model count or a status class, or `{ ok: false, error }` with a fixed code, copied field by field. Never server text, model names, versions, headers, the endpoint, paths or messages. Nothing is persisted or logged, and readiness, capabilities, licensing, the active selection and credentials are untouched.
  - Not exposed: no preload method, renderer API, mock, UI, startup or automatic probe. Ordinary, packaged and packaged-with-flag launches answer `not-available`. Stage 4P (request preview, explicit consent, UI) needs its own authorization.
- **Main-process credential gate:**
- **Main-process credential gate:** the Stage 4C internal gate is also enforced in the main process. `main.ts` decides it once at startup (unpackaged and `REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS=1`, via `isInternalCredentialSettingsEnabled`), uses that decision for the preload switch, and passes it to `setupIpc`. When it's off (every packaged build, and ordinary development launches), `credential-status`, `credential-set` and `credential-remove` answer a fixed `{ ok: false, error: "not-available" }` after the sender check and before any argument, store, `safeStorage`, userData or file access. A missing or non-`true` option means off. The other handlers, including `ai-config-status`, are unchanged.
- **Stage 4E, AI configuration foundation (pure, unused):** three modules in `artifacts/reporunner/src/lib/ai/` that nothing in the app imports yet. None touches files, the network, DNS, the environment, Electron or the credential store.
  - `localEndpoint.ts` validates a user-entered local AI endpoint. Only `http://127.0.0.1:<port>` and `http://[::1]:<port>` are accepted, with an explicit port and an optional base path. The raw text is checked before the URL parser can rewrite it, so `localhost`, other 127/8 addresses, `127.1` or hexadecimal spellings, `0.0.0.0`, IPv4-mapped IPv6, LAN and public hosts, HTTPS, userinfo, `?`/`#`, %-encoding, dot segments, backslashes and non-ASCII text are all refused with fixed codes.
  - `settingsSchema.ts` is the strict, non-secret `reporunner-ai-settings` document (version 1): at most three local-endpoint configurations, each with an id, a canonical endpoint, an API-style label (`openai-compatible` or `ollama-native`) and an optional model label, plus the active id or null. It holds no keys, headers, tokens or credential slots. Anything unexpected is refused, never repaired; a newer version is reported apart from damage. No file is read or written yet.
  - `providerReadiness.ts` turns the settings into the Stage 1 `ProviderReadiness` input. It gives `none` unless the active configuration validates **and** this build contains an adapter for its kind and API style (and, if that adapter needs a credential, metadata says one is configured). The production adapter registry is empty, so every real configuration gives `none`. A saved key or an entered endpoint alone is never readiness, and only credential metadata is read, never a key.

  "Ready" in the capability model means **configured for an adapter this build contains**, nothing more. Connectivity, whether a model can do the task, license entitlement and the user's consent to a request are separate facts, checked elsewhere (the last at request time, for each request); none may be inferred from configuration. Naming an API style is a label only: support for one arrives with its adapter, as an entry in the registry. Remote providers arrive in a later settings version, once they're chosen.

  **Credential binding (for the stage that stores these settings):** credential slots stay generic. A configuration that uses a credential must never have it sent to a destination the user didn't save it for: changing a configuration's provider or endpoint requires the user to explicitly replace or remove the bound credential (never silently, never deleted without confirmation); a remote provider key is never reassigned to a local endpoint, nor the reverse; and if settings and credential bindings disagree, readiness is `none`.
- **Stage 4F, AI settings store (main process, unused):** `artifacts/reporunner/electron/aiSettingsStore.ts` reads and writes `reporunner-ai-settings.json` in a directory the caller supplies (userData in a future stage). Nothing creates an instance yet: no startup, IPC, preload or UI uses it, so the app's behavior is unchanged.
  - Every byte goes through the Stage 4E schema (`parseAiSettings` / `serializeAiSettings`); there is no second validator. The file holds no secrets, and a valid file says nothing about connectivity or AI readiness. The store never touches credentials, `safeStorage` or the network.
  - `load()` reports `missing` (the empty document, in memory only, nothing selected; nothing is written), `valid`, `damaged` (with a fixed reason), `unsupported-version` or `unreadable`. Damaged, newer or unreadable files, and anything at the path that isn't a regular file (a symlink or directory), are never overwritten, deleted, repaired or treated as empty. There is no reset.
  - `save(settings, expectedRevision)` replaces the whole document: it validates and serializes first, refuses a stale revision (`conflict`), writes a new exclusive temp file (owner-only where supported), syncs and reads it back, then renames it over the old file. A failed save leaves the old file as it was and removes its temp file. No backups are kept.
  - Operations on one store run one at a time, in call order. Other processes aren't guarded against; RepoRunner's single-instance lock keeps a second instance away. On Windows the rename replaces the existing file, but fails if another program has it open (an antivirus scan, an editor); the save then reports `write-failed` and isn't retried.
  - So the Electron build can compile the schema, `settingsSchema.ts` now imports `./localEndpoint.js` (Node ESM needs the extension); nothing else in Stage 4E changed.
- **Stage 4G, AI settings service (main process, unused):** `artifacts/reporunner/electron/aiSettingsService.ts` owns **the one** `AiSettingsStore`, created on first use from `app.getPath("userData")`, never at startup. Importing it does nothing, and nothing calls it yet (no startup, IPC, preload or UI). Future main-process consumers use its functions and never construct a store.
  - `loadAiSettings()` and `saveAiSettings(settings, expectedRevision)` pass through to the store. `getAiConfigurationStatus()` reports metadata only: the file's state (`missing`, `valid`, `damaged` with its reason, `unsupported-version` or `unreadable`, never reinterpreted as empty), the revision, how many configurations there are, and the active one's id, kind and API style (no endpoint or model). If userData can't be resolved, results are `unreadable` and no store is kept.
  - `providerReadiness` comes from `deriveProviderReadiness` with the real, empty `PRODUCTION_AI_ADAPTERS`, so it is `none` in every state. It is the capability model's input, not a claim that AI works. The service passes no credential metadata, never touches the credential service, and makes no network request. Other processes aren't guarded against; the single-instance lock covers that.
  - The same stage moved the store's temp-name generation inside its error handling, so a random-number failure is a `write-failed` result rather than a rejected save, and nothing is written under a fallback name. `providerReadiness.ts` now uses `.js` import specifiers so the Electron build can compile it; its behavior is unchanged.
- **Stage 4H, read-only AI configuration IPC (not exposed):** one channel, `ai-config-status` (`artifacts/reporunner/electron/aiConfigIpc.ts`), registered in `ipc.ts` through the same sender guard as every other handler (25 in all). It takes no arguments (any argument is refused) and returns `{ ok: true, status }` with the Stage 4G metadata copied field by field, or a fixed `invalid-request` / `failed`. It never returns an endpoint, model, settings document, credential, path or system error (and, since Stage 4I, no revision), never writes (a missing file stays missing), and doesn't touch credentials or the network. Readiness is `none`. **No preload method, renderer API, mock entry or UI reaches it**, so the renderer can't call it; exposing it needs its own authorization. The service stays lazy: registering the handler reads nothing; the first trusted call creates the one store.
- **Stage 4I, internal AI configuration status:** in the same internal development launches as the Stage 4C credential methods (unpackaged and `REPORUNNER_INTERNAL_CREDENTIAL_SETTINGS=1`; no second gate), the preload adds `aiConfigStatus()`, which invokes only `ai-config-status` with no arguments, and the internal Settings dialog shows a read-only "Local AI configuration" section: whether settings are missing, valid, damaged, from a newer version or unreadable; how many configurations there are; and the selected one's id and API style. It always says "No AI connection is available in this version." It shows no endpoint, model, revision, key, path or error text, and offers no field, button or test. The status is read once per opening of the dialog (never at startup), late or stale answers are ignored, and the renderer re-checks every result. The IPC result no longer carries the settings revision; the store and service keep it. Packaged builds and ordinary launches expose neither the method nor the dialog.

### Approved architectural direction

- **Shared local core** stays identical in every edition and works offline without an account.
- **Central capability and entitlement model**: one pure module decides what is available from the edition state. UI components ask it; they don't check editions themselves.
- **Main-process enforcement** for desktop-sensitive operations: license state, credential storage, provider and local-AI requests, and anything that leaves the machine. The renderer only displays.
- **Backend enforcement** for Cloud Pro: authentication, entitlements, quotas, usage metering and the AI provider calls. A tampered local state can only change what the app shows.
- **BYOK Pro AI configuration**: a provider key is held by the main process in OS-backed encrypted storage (Electron `safeStorage`), separate from setup files, and requests go from the main process to the chosen provider. A local AI endpoint is configured by the user and treated as a named endpoint with the same consent rules.
- **Cloud Pro sign-in**: the system browser with OAuth/OIDC and PKCE, using a managed identity service. No passwords handled by RepoRunner.
- **Managed AI is not repository sync.** Cloud Pro sends only what the user approves for a specific AI request. Uploading repositories, syncing setups and remote execution are not part of it.

### Security prerequisites

These must be addressed before the related stage ships:

1. **Consistent IPC sender validation.** Done in Stage 2: every handler, including the Stage 4B credential handlers, checks its caller with `isTrustedSender` (`electron/ipcTrust.ts`) before doing anything.
2. **Secret storage and the same-user risk.** Partly addressed. Stage 3D stores keys encrypted with `safeStorage` and offers session-only keys that are never written. **The underlying risk remains:** DPAPI ties the data to the Windows user, not to RepoRunner, so any program running as that user, including a repository script RepoRunner starts, can ask Windows to decrypt it, and a session-only key is still in memory while the app runs. Encryption protects against reading the file elsewhere, not against code running as the same user. Provider-side spending limits stay the real mitigation; how the UI explains this is still to be decided.
3. **Environment inheritance.** Partly addressed in Stage 3B: the reserved secret names are removed from every started command's environment, and RepoRunner never puts a credential into `process.env`. Moving to an explicit environment allowlist still needs compatibility testing with users' toolchains (PATH, nvm, Volta, corepack).
4. **Consent and disclosure for AI requests.** Before anything is sent, show exactly what will be sent and to whom; logs can contain secrets and need redaction.
5. **Secure browser sign-in and backend enforcement.** A single-use loopback callback with `state` and PKCE, short-lived tokens with refresh rotation, and entitlements and quotas checked by the backend, never trusted from the client.

### Still open (product owner)

Confirmed decisions above don't settle any of these:

- **Prices:** the BYOK Pro purchase price and the Cloud Pro subscription price.
- **BYOK Pro licensing:**
  - how licenses are issued and activated;
  - offline verification;
  - device limits and transfers;
  - refunds and license recovery;
  - upgrade rights.
- **Vendors:** payment and licensing vendor; Cloud Pro billing provider; identity provider.
- **AI:** supported AI providers, models and local runtimes.
- **Cloud Pro terms:**
  - included usage and quotas;
  - the offline entitlement grace period;
  - data retention;
  - cancellation and downgrade behavior.
- **Saved-setup limits** for each edition, and what a downgrade does to setups over the limit.

### Pending terminology migration

The Setup screen (`src/components/SetupScreen.tsx`) and the saved-setup limit message (`electron/projectStore.ts`) say "RepoRunner Free", and the Setup screen promises that "RepoRunner Pro will unlock unlimited saved repos and repo library features". The planned names are **RepoRunner Free, RepoRunner BYOK Pro and RepoRunner Cloud Pro**, and unlimited saved setups aren't decided for any edition. Changing this wording is a separate, authorized UI task once the edition limits are decided. Until then the existing copy and the 5-setup limit stay as they are.

### Release state

The app's internal version is 0.1.4; the latest public release is v0.1.3. The three-edition work takes priority over publishing v0.1.4 now. Nothing has been tagged, packaged or published for v0.1.4.

### Proposed stages

Each stage needs separate authorization:

0. Governance and architecture alignment (this section and the `AGENTS.md` guardrails), including the product decisions above.
1. Pure capability and entitlement model, with no runtime change (see below).
2. IPC sender validation on every handler.
3. Environment allowlist for started commands, with compatibility testing.
4. Settings file and Settings screen (Free only).
5. BYOK Pro AI configuration: provider key storage and local AI endpoint settings.
6. BYOK Pro license handling, once the activation design is decided.
7. First AI feature: AI-assisted setup recommendations, with consent and disclosure, for remote and local AI.
8. Cloud Pro backend MVP.
9. Cloud Pro sign-in and entitlements in the app.
10. Cloud Pro billing.
11. Second AI feature: failed-run explanations from approved log excerpts.

#### What Stage 1 models

The Stage 1 module should model, without changing any runtime behavior:

- **Edition identity:** Free, BYOK Pro, Cloud Pro.
- **BYOK Pro license state**, separate from AI readiness: none, valid, invalid or not verifiable.
- **AI provider readiness:** no provider, a user API key, or a local AI endpoint.
- **Cloud Pro account and entitlement state:** signed out or signed in; entitlement active, expired, revoked or unknown; online or offline, with the time of the last check.
- **Shared local capabilities**, always available.
- **The planned AI capabilities:** setup assistance and failed-run explanations.
- **The existing 5-setup limit**, reported as is, with no change to how it's enforced.

It must keep **entitled** apart from **usable**:

- A valid BYOK Pro license entitles AI setup assistance, but it isn't usable until a supported key or local AI is configured.
- Cloud Pro AI needs a signed-in account and a backend-confirmed entitlement.
- Free local features stay available whatever the AI, license or account state.

## UI reference

The README contains screenshots of the current UI and prior visual direction. Use those screenshots as visual reference when rebuilding or polishing the local app UI.

Future UI work should preserve the intended RepoRunner visual direction unless there is a clear reason to change it.
