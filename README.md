# RepoRunner

> Import your repo once. Save the run setup once. Then pull, install, start, stop, restart, open preview, and inspect logs with buttons.

RepoRunner is a desktop Electron app for AI-assisted builders, vibe coders, and solo founders who want to run local GitHub repos without juggling terminals.

![Dashboard](artifacts/reporunner/docs/screenshots/dashboard.jpg)

---

## What it does

Save a project profile once — repo path, commands, ports, preview URL. Then drive everything from a single control panel:

- **Pull** — `git pull` in your repo directory
- **Install** — runs your install command (`npm install`, `pnpm install`, etc.)
- **Start Frontend / Start Backend** — spawns processes with live log output
- **Stop / Restart** — kills processes cleanly, verifies ports are free
- **Open** — opens your preview URL in the browser
- **Logs** — live terminal panel with color-coded source labels

RepoRunner is **not** an IDE, a deployment tool, or an AI assistant.

---

## Screenshots

**Setup screen** — configure your project once

![Setup](artifacts/reporunner/docs/screenshots/setup-modal.jpg)

**Dashboard with logs**

![Dashboard with logs](artifacts/reporunner/docs/screenshots/dashboard-logs.jpg)

---

## Tech stack

- **Electron** + **React** + **Vite** + **TypeScript**
- `tree-kill` + `tcp-port-used` for reliable process shutdown
- JSON persistence via Electron's `app.getPath("userData")`

---

## Full documentation

See [`artifacts/reporunner/README.md`](artifacts/reporunner/README.md) for complete setup, build, and run instructions.

---

## Status

Early build — single-project, core workflow functional. Electron desktop only.
