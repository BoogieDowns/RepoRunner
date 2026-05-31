# RepoRunner

> Import your repo once. Save the run setup once. Then pull, install, start, stop, restart, open preview, and inspect logs with buttons.

RepoRunner is a desktop-style app for AI-assisted builders, vibe coders, and solo founders who want to run local GitHub repos without juggling terminals. Save your project config once, then drive everything from a button panel.

RepoRunner is **not** an IDE, deployment platform, or AI debugging assistant.

---

## Who it's for

- **AI-assisted builders** who received a repo from Cursor, Replit, Claude, ChatGPT, Codex, or another AI coding tool and need to run it locally
- **Vibe coders** who want to ship without managing shell context all day
- **Solo founders** who want one project, one panel, and fewer terminals
- **Anyone running a local repo** who does not want Git Bash, npm scripts, and multiple terminals open at the same time

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

