# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### RepoRunner (`artifacts/reporunner/`)

A desktop Electron app for vibe coders / solo founders who want to run local GitHub repos without juggling terminals.

**Tech stack:** Electron + React + Vite + TypeScript

**Structure:**
```
artifacts/reporunner/
  electron/
    main.ts          — Electron main process
    preload.ts       — contextBridge IPC preload
    ipc.ts           — IPC handler setup
    processManager.ts — Child process management (spawn, tree-kill, port verify)
    portManager.ts   — Port utilities (isPortInUse, waitUntilPortIsFree, killProcessUsingPort)
    projectStore.ts  — JSON persistence via app.getPath("userData")
  src/
    types.ts         — Shared types (ProjectProfile, ServiceStatus, LogEntry, RepoRunnerAPI)
    App.tsx          — Root app (setup vs dashboard state)
    mock/
      repoRunnerMock.ts — Browser mock of window.repoRunner for Replit preview
    components/
      SetupScreen.tsx  — First-run project configuration form
      Dashboard.tsx    — Main control dashboard (buttons + live log panel)
      CommandButton.tsx — Reusable action button with icon + loading state
```

**IPC API (window.repoRunner):**
- `selectFolder()` — opens native folder picker
- `saveProject(profile)` / `loadProject()` — JSON persistence
- `pullLatest()` / `runInstall()` — git pull + install command
- `startFrontend()` / `startBackend()` — spawn processes
- `stopServices()` — tree-kill + port verification
- `restartAll()` — stop → start backend → start frontend
- `openPreview()` — shell.openExternal(previewUrl)
- `copyLogs()` / `clearLogs()` — clipboard + log management
- `onLog(cb)` / `onStatus(cb)` — live event subscriptions

**Service lifecycle (stop is trustworthy):**
1. tree-kill the process
2. Wait for port to be free (tcp-port-used)
3. If still in use → killProcessUsingPort (netstat/lsof)
4. Re-verify → set "stopped" only when confirmed

**To run as Electron desktop app locally:**
```bash
# Build renderer
pnpm --filter @workspace/reporunner run build
# Compile Electron main process
pnpm --filter @workspace/reporunner run electron:build-main
# Launch Electron
pnpm --filter @workspace/reporunner run electron:dev
```

---

## RepoRunner UI Direction & Preservation Notes

### Product purpose

RepoRunner is a desktop-style app for running local repos with saved setup and button-based actions.

It helps users:
- import a local repo once
- save setup once
- pull latest code
- run install
- start frontend / start backend
- stop services / restart
- open preview
- view and copy logs

It is not an IDE, deployment tool, or AI debugging tool.

### Visual direction

RepoRunner uses a dark sci-fi control-panel aesthetic. Do not drift toward generic SaaS styling.

- Black / near-black background
- Premium dark crimson glass buttons (red actions)
- Smoked-glass neutral buttons (secondary actions)
- RR logo in the top-left header
- Cinematic red/crimson meteor background effects
- Technical terminal/log panel
- Square red plastic/ribbed engine status lights

### Dashboard layout — do not change without explicit instruction

Quick Actions button layout:

**Top row:** Start Frontend · Start Backend · Stop Engine
**Bottom row:** Pull · Install · Restart · Open

Do not change labels, order, sizing, or layout unless explicitly asked.

### Button system — preserve

Quick Actions buttons use a glossy physical glass material system (`btn-glass` in `index.css`).

- **Red/primary buttons:** dark crimson/ruby glass, premium reflective surface — not flat, not neon
- **Neutral/secondary buttons:** smoked grey glass, readable but dark and restrained
- Custom icon components in `Dashboard.tsx` — do not replace with generic Lucide icons unless asked

### Engine status lights — preserve

Engine lights are square red plastic/ribbed lens modules. Key rules:

- The **stopped state** is blank and dark but the **same physical size and shell** as the running state
- An invisible `"Running"` placeholder text (`opacity: 0`) holds the layout box in the stopped state
- **Active and transition states all display `RUNNING`** — no `STARTING`, `STOPPING`, or `STOPPED` text inside the light
- No spinner, no pulse
- Preserve fade-on animation (`rr-lens-active`), fade-off animation (`rr-lens-off-opacity`), and shutdown flicker (`rr-glow-flicker`)
- Status text crossfade uses `StatusTextFade` component (`rr-status-text-out` / `rr-status-text-in` at 0.7s) — but since all active states show the same word, the crossfade is currently dormant
- Do not change the underlying `ServiceStatus` logic or service timing

**Visual display mapping (display only, not status logic):**
```
STARTING → RUNNING (light fading on)
RUNNING  → RUNNING (light fully on)
STOPPING → RUNNING (light fading off)
STOPPED  → blank   (dark shell, same size)
```

### Setup modal — preserve

Modal title: **RepoRunner Setup**

Field layout (top to bottom):
1. **Project Name** | **Local Repository Folder** + Choose button
2. **Preview URL** — full-width wide row
3. **Install Command** | **Frontend Command** | **Backend Command** — 3-col row
4. **Frontend Port** | **Backend Port** — compact 2-col pair (left-anchored, ~50% width)
5. **Save Configuration** button — crimson glass style matching the primary button system

### Log panel — preserve

Terminal-style log panel. Source label colors:

| Source | Color |
|---|---|
| `[SYSTEM]` | `#D9D7D5` — near-white light grey |
| `[GIT]` | `#7CFF6B` — neon green |
| `[INSTALL]` | `#FFB06A` — saturated peach/amber |
| `[BACKEND]` | `#9B3F67` — maroon/purple-red |
| `[FRONTEND]` | `#cc4444` — crimson/red |

Do not change log behavior during visual polish passes.

### Meteor/background system — preserve

- Red/crimson meteors on the dark background
- Divider impact ripple on the log panel separator
- Current speed and density unless explicitly changed
- Do not rework this system without explicit instruction

### Files that must not be modified

- `artifacts/reporunner/src/mock/repoRunnerMock.ts` — browser mock, never touch
- `artifacts/reporunner/src/types.ts` — shared types, never touch

### Rules for future UI edits

- Make narrow, targeted changes only
- Do not redesign large areas unless explicitly asked
- Do not change functionality during visual polish passes
- Do not "improve" completed areas unless specifically requested
- Preserve working behavior across all changes
- Avoid broad refactors during small UI tasks
- Check the live preview before editing where possible
