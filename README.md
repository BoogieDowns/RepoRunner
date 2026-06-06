# RepoRunner

## Download

RepoRunner v0.1.3 is available for Windows.

- Website: https://reporunnerapp.com
- Latest release: https://github.com/BoogieDowns/RepoRunner/releases/latest
- Direct installer: https://github.com/BoogieDowns/RepoRunner/releases/download/v0.1.3/RepoRunner.Setup.0.1.3.exe

Note: RepoRunner v0.1.3 is currently unsigned, so Windows may show a security warning during install.

> Import your repo once. Save the run setup once. Then pull, install, start, stop, restart, open preview, and inspect logs with buttons.

RepoRunner is a desktop Electron app for AI-assisted builders, vibe coders, and solo founders who want to run local GitHub repos without terminals.

![Dashboard](artifacts/reporunner/docs/screenshots/dashboard.jpg)

## Feedback

Tried RepoRunner? Found a bug or got stuck? Open an issue on GitHub or message [@RepoRunnerApp](https://x.com/RepoRunnerApp) on X.

For setup examples, see the [full documentation](artifacts/reporunner/README.md). For common problems, see [Known setup issues](artifacts/reporunner/docs/known-setup-issues.md).

---

## What it does

Save up to 5 repo setups in RepoRunner Free — repo paths, commands, ports, and preview URLs. Select one active repo, then drive it from a single control panel:

- **Saved repo setups** — add, save, select, and delete setups from Edit RepoRunner Setup
- **One active repo at a time** — switching saved setups is blocked while services are running
- **Safe setup deletion** — removes the setup from RepoRunner without deleting project files
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

## Download

Download the latest Windows installer from the GitHub Releases page:

[Download latest Windows installer](https://github.com/BoogieDowns/RepoRunner/releases/latest)

Windows may show an unsigned-app warning because RepoRunner is not code-signed yet.

---

## Tech stack

- **Electron** + **React** + **Vite** + **TypeScript**
- `tree-kill` + `tcp-port-used` for process shutdown and port checks
- JSON persistence via Electron `app.getPath("userData")`
- GitHub Actions CI for typecheck and build validation

---

## Full documentation

See [artifacts/reporunner/README.md](artifacts/reporunner/README.md) for setup, build, and run instructions.
For common setup problems, see [Known setup issues](artifacts/reporunner/docs/known-setup-issues.md).
---

## Status

RepoRunner v0.1.3 is the current Windows desktop release. The multiple saved repo setup workflow is functional and smoke-tested. Windows desktop only.



