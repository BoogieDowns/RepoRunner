# Changelog

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
