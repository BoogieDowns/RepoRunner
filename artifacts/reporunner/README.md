# RepoRunner

> Run local GitHub repos with buttons — no terminal juggling required.

RepoRunner is a simple desktop app for AI-assisted builders who want to run local GitHub/local repo apps without using Git Bash or juggling terminals. Save your project config once, then pull, install, start, stop, and restart your services with a single click.

---

## Who it's for

Developers and AI-assisted builders who:
- Clone AI-generated repos and need a simple way to run them locally
- Don't want to manage multiple terminal windows
- Want a clean interface for starting frontend and backend services

---

## V0 Feature Scope

### What RepoRunner V0 does

- Save one local project profile (repo path, commands, ports, preview URL)
- **Pull latest** — runs `git pull` in your repo directory
- **Install** — runs your install command (e.g. `npm install`)
- **Start Frontend** — starts your frontend dev server
- **Start Backend** — starts your backend server
- **Stop Services** — stops both frontend and backend
- **Restart All** — sequentially restarts backend then frontend
- **Open Preview** — opens your configured preview URL in a browser
- **View live logs** — colored by source (git / install / frontend / backend / system)
- **Copy logs** — copies full log output to clipboard
- **Clear logs** — clears the log panel

### What V0 does not include

- IDE or editor features
- Deployment or hosting
- GitHub OAuth or authentication
- Repo cloning
- Branch switching
- AI-assisted debugging
- Multi-project support (only one project profile at a time)

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React + Vite + TypeScript |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Desktop | Electron |
| Forms | react-hook-form + Zod |
| Font | Plus Jakarta Sans + JetBrains Mono |
| Process management | Node.js `child_process` + `tree-kill` |
| Port detection | `tcp-port-used` |
| Config storage | Electron `app.getPath('userData')` |
| Web preview | Browser mock via `window.repoRunner` |

---

## Local Development

### Prerequisites

- Node.js 18+
- pnpm 8+

### Install dependencies

```bash
pnpm install
```

### Run web preview (browser mock — no Electron required)

```bash
pnpm --filter @workspace/reporunner run dev
```

Open the URL shown in your terminal. The browser mock simulates all IPC calls so you can develop the UI without Electron.

### Run as Electron app (full desktop mode)

```bash
# 1. Compile the Electron main process
pnpm --filter @workspace/reporunner run electron:build-main

# 2. Start the Vite dev server
pnpm --filter @workspace/reporunner run dev

# 3. In a second terminal, launch Electron
pnpm --filter @workspace/reporunner run electron:dev
```

### Build for distribution

```bash
pnpm --filter @workspace/reporunner run electron:dist
```

Output goes to `artifacts/reporunner/release/`.

---

## Project Structure

```
artifacts/reporunner/
├── electron/               # Electron main process
│   ├── main.ts             # Entry point
│   ├── preload.ts          # Exposes window.repoRunner to renderer
│   ├── ipc.ts              # IPC handlers (pull, install, start, stop...)
│   ├── processManager.ts   # Spawns and kills service processes
│   ├── portManager.ts      # Port readiness checks
│   └── projectStore.ts     # Reads/writes project profile to disk
├── src/                    # React renderer
│   ├── components/
│   │   ├── Dashboard.tsx   # Main app view (actions, services, logs)
│   │   ├── SetupScreen.tsx # Project config form
│   │   └── CommandButton.tsx
│   ├── mock/
│   │   └── repoRunnerMock.ts  # Browser mock of window.repoRunner
│   ├── types.ts            # Shared TypeScript types
│   └── App.tsx             # Root component and routing state
├── electron-dist/          # Compiled Electron JS (git-ignored)
├── dist/                   # Vite build output (git-ignored)
└── release/                # electron-builder output (git-ignored)
```

---

## V0 Test Checklist

- [ ] Save project config
- [ ] Reopen app and confirm config persists
- [ ] Pull latest
- [ ] Run install
- [ ] Start frontend
- [ ] Start backend
- [ ] Stop services
- [ ] Restart all
- [ ] Open preview
- [ ] Copy logs
- [ ] Clear logs
- [ ] Edit setup (pencil icon)
- [ ] Close edit without saving (X button)

---

## Current Limitations

- **Single project only** — no project switcher yet
- **No process health checks** — if a process crashes silently, the pill stays "Running"
- **No env var support** — commands must not require `.env` injection through the UI
- **Browser preview only** — the Replit web preview runs the browser mock; real process management requires Electron

---

## License

MIT
