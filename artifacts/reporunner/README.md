# RepoRunner

> Paste a GitHub repo. Watch it wake up. No terminal required.

RepoRunner is a desktop app for AI-assisted builders who want to run GitHub repos locally without using Git Bash, juggling terminals, or reading setup guides. Paste a URL, let the scanner do its work, and hit Launch.

---

## Visual Direction — V1

RepoRunner V1 uses a **"classified launch console"** aesthetic:

- Near-black background with subtle grain texture and scanlines
- Sparse layout with generous negative space
- Small uppercase monospace labels throughout
- Red signal accent (`#cc2222`) used for active states, beams, and primary actions
- Muted grey body text — red is signal energy, not danger everywhere

---

## App Flow

```
LANDING → SCANNING → ANALYSIS → RUNNING
```

1. **Landing** — Paste a GitHub URL into the command input field
2. **Scanning** — 6-step repo analysis sequence with animated step indicators
3. **Analysis** — Detected run plan: framework, commands, port, env var requirements
4. **Running** — Preview online: live log stream, uptime, Open Preview / Restart / Stop

---

## Screens

### Landing
- Hero headline: "WAKE A REPO. NO LOCAL SETUP."
- Command-style URL input with red `›` prompt
- Full-width ANALYZE REPO button
- Slow red scan beam animation

### Scan Sequence
Steps with animated indicators (pending → active → done):
1. CLONING REPOSITORY
2. READING PACKAGE FILES
3. DETECTING FRAMEWORK
4. IDENTIFYING START COMMAND
5. SCANNING ENVIRONMENT VARIABLES
6. BUILDING RUN PLAN

### Analysis / Run Plan
Detected configuration panels:
- Framework, Package Manager, Install Command, Start Command, Port, Branch, Runtime

Environment requirements:
- Each env var with READY / MISSING / OPTIONAL status tag
- Missing required vars show a warning banner before launch

### Running
- PREVIEW ONLINE status with pulsing red dot
- System state panel: framework, runtime, port, branch, URL
- Full log stream: timestamped, colored by source (system / git / install / frontend / backend)
- Controls: Open Preview · Restart · Stop

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React + Vite + TypeScript |
| Styling | Tailwind CSS v4 + inline styles |
| Desktop | Electron |
| Font | Plus Jakarta Sans (UI) + JetBrains Mono (mono) |
| Process management | Node.js `child_process` + `tree-kill` |
| Port detection | `tcp-port-used` |
| Config storage | Electron `app.getPath('userData')` |
| Web preview | Browser mock via `window.repoRunner` |

---

## Local Development

### Install

```bash
pnpm install
```

### Web preview (no Electron required)

```bash
pnpm --filter @workspace/reporunner run dev
```

The browser mock simulates all IPC calls — scan steps, launch, logs — so you can develop the full flow without Electron.

### Full Electron mode

```bash
# 1. Compile Electron main process
pnpm --filter @workspace/reporunner run electron:build-main

# 2. Start Vite dev server
pnpm --filter @workspace/reporunner run dev

# 3. Launch Electron (second terminal)
pnpm --filter @workspace/reporunner run electron:dev
```

### Build for distribution

```bash
pnpm --filter @workspace/reporunner run electron:dist
```

Output: `artifacts/reporunner/release/`

---

## Project Structure

```
artifacts/reporunner/
├── electron/
│   ├── main.ts             # Electron entry point
│   ├── preload.ts          # Exposes window.repoRunner to renderer
│   ├── ipc.ts              # IPC handler setup
│   ├── processManager.ts   # Spawn and kill service processes
│   ├── portManager.ts      # Port readiness checks
│   └── projectStore.ts     # Project profile persistence
├── src/
│   ├── components/
│   │   ├── TopBar.tsx          # Shared top bar (phase-aware status)
│   │   ├── LandingScreen.tsx   # URL input hero screen
│   │   ├── ScanScreen.tsx      # Animated scan sequence
│   │   ├── AnalysisScreen.tsx  # Run plan panels + launch
│   │   └── RunningScreen.tsx   # Preview online + logs
│   ├── mock/
│   │   └── repoRunnerMock.ts   # Browser simulation of window.repoRunner
│   ├── types.ts                # All TypeScript types
│   ├── App.tsx                 # Phase state machine root
│   └── index.css               # Theme, grain, keyframes
├── electron-dist/              # Compiled Electron JS (git-ignored)
├── dist/                       # Vite build output (git-ignored)
└── release/                    # Electron-builder output (git-ignored)
```

---

## V1 Test Checklist

### Landing
- [ ] URL input accepts GitHub URL
- [ ] Enter key submits
- [ ] Empty submit shows error
- [ ] Invalid URL shows error

### Scan sequence
- [ ] Steps animate one at a time
- [ ] Active step shows red pulse dot
- [ ] Done steps show ✓
- [ ] Elapsed timer counts up
- [ ] Transitions to Analysis when complete

### Analysis
- [ ] Project name, framework, commands display correctly
- [ ] Env vars show correct READY / MISSING / OPTIONAL status
- [ ] Missing input warning banner appears for required vars
- [ ] Back button returns to landing
- [ ] Launch Preview starts the running phase

### Running
- [ ] PREVIEW ONLINE status shows with pulse dot
- [ ] Uptime counter increments
- [ ] Logs stream in real-time
- [ ] Open Preview opens in new tab
- [ ] Restart stops and restarts services
- [ ] Stop returns to landing

---

## Current Limitations

- **Browser mock only** — real process management requires Electron
- **Single repo at a time** — no project switcher
- **Simulated scan** — actual GitHub cloning + detection requires Electron IPC implementation
- **No env var input** — missing vars are flagged but not yet fillable in-app

---

## License

MIT
