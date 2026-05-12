# RepoRunner Architecture Notes

## Product direction

RepoRunner should remain local-first.

The core app should help users run and verify local repos without terminal friction. It should not become a code-editing agent in the near term.

Code changes should continue to happen through the normal GitHub / Codex / branch / PR workflow. RepoRunner’s job is to help users pull, run, restart, inspect, and verify those changes locally.

## Core desktop workflow

RepoRunner’s core workflow should support:

- Importing a local repo folder
- Saving a run setup once
- Pulling the latest branch changes
- Running install when needed
- Starting frontend services
- Starting backend services
- Stopping services
- Restarting services
- Opening the local preview URL
- Showing logs
- Copying logs

The basic local repo-running workflow should not require login.

## Scope boundary

RepoRunner should not become Codex.

RepoRunner should not make source-code changes automatically in the near term. If future code-editing capabilities are considered, they should be optional, approval-based, and kept separate from the local runner core.

The product should focus first on being a reliable local repo cockpit.

## Future optional layers

The following layers may be added later, but they should sit around the local runner core rather than inside it:

- GitHub OAuth for repo, branch, and PR awareness
- Account/login for paid features
- Billing/subscription for Pro features
- Cloud sync for saved repo setups and settings
- AI/log diagnosis for common local run failures
- Smarter setup detection for package managers, scripts, ports, and changed lockfiles

## Architecture rule

Keep these concerns separate:

- Local runner logic
- Process management
- Repo configuration storage
- UI components
- GitHub integration
- Account/authentication
- Billing
- Cloud sync
- AI/log diagnosis

The local runner should continue to work even if account, billing, cloud, or AI features are unavailable.

## Possible pricing boundary later

Free:

- Limited saved repos
- Basic pull/install/start/stop/restart/logs

Pro:

- Unlimited saved repos
- Branch awareness
- Smarter setup detection
- Error diagnosis
- Sync/settings features

## UI reference

The README contains screenshots of the current or previous UI. Use those screenshots as visual reference when rebuilding or polishing the local app UI.

Future UI work should preserve the intended RepoRunner visual direction unless there is a clear reason to change it.
