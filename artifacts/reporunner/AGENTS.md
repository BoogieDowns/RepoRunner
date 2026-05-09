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
- An AI debugging assistant
- A project management or task tracking tool
- A multi-project manager (currently single-project by design)
- A GitHub OAuth / authentication system
- A repo cloning tool

If a feature request falls outside the core run-loop (pull → install → start → stop → restart → preview → logs), ask for explicit confirmation before implementing it.

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
5. Save Configuration button

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

## Files that must never be modified

| File | Reason |
|---|---|
| `src/types.ts` | Shared type contract used by renderer, Electron, and mock |
| `src/mock/repoRunnerMock.ts` | Browser mock for Replit preview — must stay in sync with the real IPC surface |

If you need new types, add them. Do not modify existing type definitions unless explicitly instructed.

---

## Development rules

- Make **narrow, targeted changes** only — do not refactor unrelated code while implementing a feature
- Inspect the live preview before making UI changes where possible
- Do not change functionality during visual polish passes
- Do not "improve" completed areas unless explicitly asked
- Keep the browser mock (`repoRunnerMock.ts`) in sync with any IPC surface changes
- When adding a new IPC handler: update `ipc.ts`, `preload.ts`, `types.ts` (the `RepoRunnerAPI` interface), and `repoRunnerMock.ts` together
- Avoid broad refactors during small, scoped tasks
- If a change affects the Electron main process, rebuild with `electron:build-main` before testing

---

## IPC surface

All renderer ↔ main communication goes through `window.repoRunner` (injected via `contextBridge` in `preload.ts`).

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

The `RepoRunnerAPI` interface in `src/types.ts` is the authoritative contract.

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
