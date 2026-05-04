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

A "classified repo launch console" — paste a GitHub URL, scan the stack, and boot a browser preview without touching a terminal. V1 visual redesign: near-black + red accent, sparse orbital terminal aesthetic.

**Tech stack:** Electron + React + Vite + TypeScript + Tailwind CSS v4

**App flow (phase state machine):**
`landing` → `scanning` → `analysis` → `running`

**Structure:**
```
artifacts/reporunner/
  electron/
    main.ts           — Electron main process
    preload.ts        — contextBridge IPC preload
    ipc.ts            — IPC handler setup
    processManager.ts — Child process management (spawn, tree-kill, port verify)
    portManager.ts    — Port utilities
    projectStore.ts   — JSON persistence via app.getPath("userData")
  src/
    types.ts          — AppPhase, ScanStep, RunPlan, EnvVar, RepoRunnerAPI + legacy types
    App.tsx           — Phase-based state machine root
    index.css         — Dark orbital theme (near-black + red), grain texture, keyframes
    mock/
      repoRunnerMock.ts — Browser mock: analyzeRepo (step callbacks) + launchPreview/stopPreview
    components/
      TopBar.tsx        — Fixed 32px top bar: brand, badge, phase status, system ID
      LandingScreen.tsx — Hero URL input with scan beam animation
      ScanScreen.tsx    — 6-step scan sequence with animated step indicators
      AnalysisScreen.tsx — Run plan panels, env var readiness, launch action
      RunningScreen.tsx  — Preview online state: info panels + live log stream + controls
```

**IPC API (window.repoRunner):**
New methods:
- `analyzeRepo(url, onStep)` — step-by-step analysis with callback, returns RunPlan
- `launchPreview()` — boots frontend + backend services
- `stopPreview()` — stops all services

Legacy methods (Electron IPC):
- `startFrontend()` / `startBackend()` / `stopServices()` / `restartAll()`
- `onLog(cb)` / `onStatus(cb)` — live event subscriptions

**Theme palette:**
- Background: `#080808`, Surface: `#0d0d0d`, Border: `rgba(255,255,255,0.07)`
- Accent: `#cc2222` (red signal), Text: `#b8b8b8`, Dim: `#444`
- Font: Plus Jakarta Sans (UI) + JetBrains Mono (mono labels/values)

**To run as Electron desktop app locally:**
```bash
pnpm --filter @workspace/reporunner run build
pnpm --filter @workspace/reporunner run electron:build-main
pnpm --filter @workspace/reporunner run electron:dev
```
