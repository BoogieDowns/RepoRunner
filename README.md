# RepoRunner

> Import your repo once. Save the run setup once. Then pull, install, start, stop, restart, open preview, and inspect logs with buttons.

RepoRunner is a desktop Electron app for AI-assisted builders, vibe coders, and solo founders who want to run local GitHub repos without juggling terminals.

![Dashboard](artifacts/reporunner/docs/screenshots/dashboard.jpg)

---

## What it does

Save a project profile once — repo path, commands, ports, and preview URL. Then drive everything from a single control panel:

- **Pull** — runs `git pull` in your repo directory
- **Install** — runs your install command, such as `npm install` or `pnpm install`
- **Start Frontend / Start Backend** — starts your configured services with live log output
- **Stop / Restart** — stops processes cleanly and verifies configured ports where possible
- **Open** — opens your preview URL in the browser
- **Logs** — shows terminal-style output with source labels, plus copy and clear actions
- **Setup validation** — catches missing repo paths before saving bad config

RepoRunner is **not** an IDE, deployment platform, or AI assistant.

---

## Screenshots

**Setup screen** — configure your project once

![Setup](artifacts/reporunner/docs/screenshots/setup-modal.jpg)

**Dashboard with logs**

![Dashboard with logs](artifacts/reporunner/docs/screenshots/dashboard-logs.jpg)

---

## Tech stack

- **Electron** + **React** + **Vite** + **TypeScript**
- `tree-kill` + `tcp-port-used` for process shutdown and port checks
- JSON persistence via Electron `app.getPath("userData")`
- GitHub Actions CI for typecheck and build validation

---

## Full documentation

See [artifacts/reporunner/README.md](artifacts/reporunner/README.md) for setup, build, and run instructions.

---

## Status

V0 desktop build. The single-project core workflow is functional and smoke-tested. Electron desktop only.
