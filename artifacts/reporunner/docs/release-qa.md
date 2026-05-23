# Release QA Checklist

This checklist is for preparing a RepoRunner Windows V0 release.

## Pre-release setup

- Confirm branch is up to date with `main`
- Confirm release version in `package.json`
- Confirm release branch has no unrelated product/UI changes
- Confirm generated release artifacts are not committed

## Build validation

Run from `artifacts/reporunner`:

```powershell
pnpm.cmd run typecheck
pnpm.cmd run electron:build-main
pnpm.cmd run build
pnpm.cmd run electron:dist
