# RepoRunner

> Import your repo once. Save the run setup once. Then pull, install, start, stop, restart, open preview, and inspect logs with buttons.

RepoRunner is a desktop-style app for AI-assisted builders, vibe coders, and solo founders who want to run local GitHub repos without terminals. Save your project config once, then drive everything from a button panel.

RepoRunner is **not** an IDE, deployment platform, or AI debugging assistant.

## Feedback

Tried RepoRunner? Found a bug or got stuck? Open an issue on GitHub or message [@RepoRunnerApp](https://x.com/RepoRunnerApp) on X.

For setup examples, see this README. For common problems, see [Known setup issues](docs/known-setup-issues.md).

---

## Who it's for

- **AI-assisted builders** who received a repo from Cursor, Replit, Claude, ChatGPT, Codex, or another AI coding tool and need to run it locally.
- **Vibe coders** who want to ship with less setup friction.
- **Solo founders** who want one project, one panel, and a simpler local run workflow.
- **Anyone running a local repo** who wants pull, install, start, stop, restart, open preview, and inspect logs in one place.

---

## Current status

V0 desktop build. The single-project core workflow is functional and has passed a local end-to-end smoke test.

RepoRunner is intentionally narrow right now: it focuses on running one local app reliably from a desktop control panel.

---

## Features

- Save one local project profile: repo path, commands, ports, and preview URL
- Validate the local repo path before saving setup
- **Pull latest** — runs `git pull` in your repo directory
- **Install** — runs your install command, such as `npm install` or `pnpm install`
- **Start Frontend** — starts your frontend server
- **Start Backend** — starts your backend server when configured
- **Frontend-only support** — skips backend start cleanly when no backend command is configured
- **Stop Engine** — stops frontend and backend services
- **Restart All** — sequentially restarts backend, then frontend
- **Open Preview** — opens your configured preview URL in a browser
- **View live logs** — colored by source: git, install, frontend, backend, and system
- **Copy Logs** — copies full log output to clipboard
- **Clear Logs** — clears the log panel
- **Edit Setup** — reopen the config modal without losing running services

---

## Usage

1. Open the app. The setup modal appears on first launch.
2. Fill in your project details:
   - Project name and local repo folder path
   - Preview URL, such as `http://localhost:3000`
   - Install, frontend, and optional backend commands
   - Frontend and optional backend ports for readiness checks
3. Click **Save Configuration**. The dashboard loads.
4. Use Quick Actions:
   - **Pull** to fetch the latest code
   - **Install** to run your install command
   - **Start Frontend / Start Backend** to spin up services
   - **Stop Engine** to kill running services cleanly
   - **Restart** to run a full stop-and-start cycle
   - **Open** to launch your preview URL
5. Watch the log panel for real-time output from each service.
6. Click **Edit Setup** in the header to adjust config at any time.

## Example setup recipes

These examples show the kind of commands you can save in RepoRunner. Use the commands that match your own project.

### Vite / React app

Use this for many frontend-only React, Vite, or similar projects.

**Repo path**

`C:\Users\YourName\Desktop\MyViteApp`

**Install command**

`npm.cmd install`

**Frontend command**

`npm.cmd run dev`

**Frontend port**

`5173`

**Preview URL**

`http://localhost:5173`

Leave the backend command and backend port empty.

### Next.js app

Use this for a standard Next.js project.

**Install command**

`npm.cmd install`

**Frontend command**

`npm.cmd run dev`

**Frontend port**

`3000`

**Preview URL**

`http://localhost:3000`

Leave the backend command and backend port empty unless your repo starts a separate backend service.

### pnpm workspace or monorepo app

Use this when your repo has multiple apps or packages and the app lives inside a subfolder.

**Repo path**

`C:\Users\YourName\Desktop\MyMonorepo`

**Install command**

`pnpm.cmd install`

**Frontend command**

`cd apps\web && pnpm.cmd run dev`

**Frontend port**

`3000`

**Preview URL**

`http://localhost:3000`

Change `apps\web` to the folder that contains your actual frontend app.

### Frontend + backend repo

Use this when your project has a frontend and a separate backend service.

**Install command**

`pnpm.cmd install`

**Frontend command**

`cd apps\web && pnpm.cmd run dev`

**Frontend port**

`3000`

**Backend command**

`cd apps\api && pnpm.cmd run dev`

**Backend port**

`4000`

**Preview URL**

`http://localhost:3000`

Make sure both services can already run locally from the command line before saving them in RepoRunner.

## Setup notes

On Windows, prefer `.cmd` commands in RepoRunner setup fields:

    npm.cmd install
    pnpm.cmd install
    npm.cmd run dev
    pnpm.cmd run dev

For monorepos and workspaces, use the repo/workspace root as the repo path. If the app lives in a subfolder, use `cd` inside the command:

    cd artifacts\my-app && pnpm.cmd run dev

For common setup problems, see [Known setup issues](docs/known-setup-issues.md).

---

## Screenshots

**Setup screen** — configure your project once

![Setup screen](docs/screenshots/setup-modal.jpg)

**Dashboard** — Quick Actions, Engine panel, and log output

![Dashboard](docs/screenshots/dashboard.jpg)

![Dashboard with logs](docs/screenshots/dashboard-logs.jpg)

---

## Tech stack

| Layer | Technology |
|---|---|
| UI | React + Vite + TypeScript |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Desktop | Electron |
| Forms | React state + Zod validation |
| Fonts | Plus Jakarta Sans + JetBrains Mono |
| Process management | Node.js child processes + `tree-kill` |
| Port detection | `tcp-port-used` |
| Config storage | Electron `app.getPath("userData")` |
| Web preview | Browser mock via `window.repoRunner` |
| CI | GitHub Actions |

---

## Local development

### Prerequisites

- Node.js 18+
- pnpm 8+

### Install dependencies

```bash
pnpm install

