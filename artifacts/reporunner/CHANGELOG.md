# Changelog

## v0.1.4 (release candidate, not yet released)

Proposed entry for v0.1.4. It isn't published yet: the current public release is v0.1.3. The release date goes here when v0.1.4 is published.

RepoRunner v0.1.4 adds Analyze Repo: it reads a project's files locally and suggests install and start commands that you can review and apply to your setup. It also adds an advisory Repo Safety Check of `package.json` scripts. Nothing is run, installed or saved during analysis.

### New features

- **Analyze Repo**: a local, read-only scan of the chosen repo folder. It shows package managers and lockfiles, workspaces, Node version files, environment file names (never their contents), `package.json` scripts and dependency names, and warnings. Size, depth and time limits keep large repositories from stalling the app, and incomplete scans are labeled as such (#75).
- **Framework and command detection**, and **Suggested Setup**: install, development and start command suggestions for recognized projects, each with a confidence level and its evidence (#76).
- **Use in Setup**: review a root-level suggestion, then **Apply to Setup** to fill the Install Command or Frontend Command field, or **Cancel** to change nothing. Applying doesn't save or run anything; saving stays explicit (#78, #79, #80).

### Security-related advisory functionality

- **Repo Safety Check**: advisory warning signs in `package.json` scripts: install-time scripts, download-and-run, encoded or hidden commands, deletion outside the project, and credential locations. Shown in the analysis results above Suggested Setup, with its scope note always visible. It never blocks anything and isn't a malware scan. Known limitation: shell control flow isn't interpreted (#82) (#81, #84, #85).
- Electron hardening: navigation and new windows are blocked, browser permission requests are denied, a strict Content Security Policy is used in builds, and fonts are bundled locally (#74).

### Usability

- Setup guidance overlay, clearer saved-setup limit and button labels (#68).
- Closable setup overlay, a guided empty state when no repo is selected, and an "Edit Repo Setup" title (#69).
- The Use in Setup review names the real save buttons, Save Repo Setup and Update Repo Setup (#88).

### Reliability

- Stop and Restart terminate only the processes RepoRunner started (#70).
- Saved setups are protected: damaged files are never overwritten, with backups and recovery options (#71).
- Closing RepoRunner stops the services it started (#72).
- Windows command quoting is preserved, and log retention is bounded (#73).

### Internal

- Test reliability fixes for Windows timers and scanner result-size boundaries (#77, #86).
- Release documentation and release QA checklist (#87).

### Known limitations

- Windows x64 only. The installer isn't code-signed, so Windows may show a security warning, and RepoRunner doesn't update itself.
- The Repo Safety Check is advisory. It only reads `package.json` script text: files those scripts run and dependencies' install scripts aren't inspected.
- Its simplified shell reading doesn't interpret conditionals, loops, variables or functions, so warning signs inside them can be missed (#82).
- "No obvious warning signs" doesn't mean a repository is safe, and findings never block installing or running a project.
- Analysis never runs, installs or saves anything. Apply to Setup fills one field; saving is a separate, explicit step.

## v0.1.3

Released 2026-06-06 (GitHub release).

- Save up to 5 local repo setups in RepoRunner Free.
- Switch between saved repos from the setup screen.
- Add a new repo setup with blank fields and example placeholders.
- Delete a saved setup without deleting project files.
- The active repo selection is remembered between restarts.
- Switching saved repos is blocked while services are running.

## v0.1.2

Released 2026-05-27 (GitHub release).

### Changed

- Clarified Windows installer download guidance in the README.
- Added Windows `.cmd` command examples for setup.
- Expanded the known setup issues documentation.
- Added an explicit Windows Tailwind native dependency to prevent broken production renderer styling on Windows.
- Updated the Windows installer asset to include the final transparent app icon.

### Fixed

- Fixed a Windows production build issue where the installed app could open with broken dashboard layout styling.

## v0.1.1

Tagged 2026-05-24. There is no GitHub release page for this version; these entries come from the commits in the tag.

- Added the Windows app icon and packaging dependencies.
- Polished setup guidance in the documentation.
- Removed release build artifacts and a mockup sandbox from the repository.

## v0.1.0 - Windows V0

RepoRunner v0.1.0 is the first Windows-first downloadable release.

### Included

- Single local project profile
- Setup modal for saving local repo configuration
- Repo path validation before save
- Polished inline setup errors
- Duplicate-save protection
- Pull and install command streaming
- Final partial log lines preserved
- Start frontend/backend
- Frontend-only backend skip behavior
- Stop, restart, and open preview actions
- Live logs
- Copy and clear logs
- Persisted setup between restarts
- GitHub Actions validation for install, typecheck, Electron main build, and renderer build
- Windows NSIS installer build

### Platform

- Windows first
- macOS deferred
- Linux polish deferred

### Install note

This early Windows build is currently unsigned. Windows may show a security warning during install or first launch.

Only download RepoRunner from the official GitHub Releases page for this repository.

### Known issue

The production build may show a non-blocking Vite sourcemap warning for `src/components/ui/tooltip.tsx`. The build completes successfully.
