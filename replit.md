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
