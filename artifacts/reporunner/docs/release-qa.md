# Release QA Checklist

This checklist is for preparing a RepoRunner Windows release. Work through every section in order; a release isn't ready until every item is checked.

## Pre-release setup

- Confirm branch is up to date with `main`
- Confirm release version in `package.json`
- Confirm release branch has no unrelated product/UI changes
- Confirm generated release artifacts are not committed

## Build environment

- Windows x64. The installer target is NSIS (`build.win.target` in `package.json`); Windows x64 is the only supported platform.
- Node.js 22 and pnpm 10, matching CI (`.github/workflows/reporunner-ci.yml`). The lockfile needs pnpm 9 or newer.
- Install with `pnpm install --frozen-lockfile` from the repository root.
- Build on a machine you can rebuild from: record the Node, pnpm and Windows versions used for the release build.

### Known issue: electron-builder can't extract winCodeSign

`electron-builder` downloads a `winCodeSign` tools archive that contains two macOS symbolic links. On Windows, creating symbolic links needs Developer Mode or administrator rights. Without them, extraction fails with `Cannot create symbolic link : A required privilege is not held by the client`, and `electron:dist` stops after packaging. The executable then has no icon or version information, and no installer is produced.

- The supported fix is to build where symbolic links can be created: enable Windows Developer Mode, or build from an elevated prompt.
- A workaround was tested once during the v0.1.4 audit, not as a supported process. It pre-extracts the archive into a separate cache folder (the two macOS links fail; the Windows tools extract), then points `ELECTRON_BUILDER_CACHE` at that folder. If you use it, check the result carefully (see "Verify the build output" below) and note it in the release record.
- Each failed attempt leaves a partial `winCodeSign\<number>` folder in `%LOCALAPPDATA%\electron-builder\Cache`. These can be deleted.

## Build validation

Run from `artifacts/reporunner`:

```powershell
pnpm.cmd run typecheck
pnpm.cmd run test
pnpm.cmd run electron:build-main
pnpm.cmd run build
pnpm.cmd run electron:dist
```

### Verify the build output

In `artifacts/reporunner/release/`:

- [ ] `RepoRunner Setup <version>.exe` exists, with the version from `package.json`. (The published asset has been named `RepoRunner.Setup.<version>.exe`.)
- [ ] `win-unpacked\RepoRunner.exe` shows Product name RepoRunner, Company BoogieDowns and the release version in its file properties, and shows the RepoRunner icon.
- [ ] The signature status is recorded. Current builds are unsigned (`Get-AuthenticodeSignature` reports `NotSigned`).
- [ ] The installer size is in line with the previous release (v0.1.3 was about 86.5 MB).

## Packaged-app checks

Run these against the packaged app (`win-unpacked\RepoRunner.exe` or the installed app), not `electron:dev`. Use a separate, disposable test profile and harmless local fixture repositories only. Never use an untrusted repository to test Install or Start.

- [ ] **Startup**: the app opens on the setup screen with no errors.
- [ ] **Open repository**: **Choose Folder** and typing a path both work.
- [ ] **Analyze Repo**: the scan finishes with **Analysis complete** and shows packages, scripts and warnings.
- [ ] **Repo Safety Check**: appears above Suggested Setup.
  - A fixture with a `postinstall` script shows a **Notice**.
  - A fixture that pipes a download into a shell shows a **Warning**.
  - A plain fixture shows **No obvious warning signs found in inspected scripts**.
  - The scope note (including the simplified shell reading line) is always visible.
- [ ] **Incomplete scan**: a very large fixture shows **Partial results**, and the Safety Check shows **Safety Check incomplete**.
- [ ] **Suggested Setup**: suggestions show confidence and evidence; nested packages and orchestration tools are informational only.
- [ ] **Review and Cancel**: **Use in Setup…** opens the review; **Cancel** leaves the form unchanged.
- [ ] **Apply and explicit Save**: **Apply to Setup** fills only the chosen field and saves nothing; **Save Repo Setup** saves it.
- [ ] **Restart and persistence**: after closing and reopening, the saved setup loads, **Edit Setup** shows the saved commands, and no old analysis is shown.
- [ ] **Install, Start and Stop** with a harmless fixture (for example `node print.cjs` as the install command, and a small local server script as the frontend command): Install finishes, Start Frontend runs and the port answers, Stop Engine stops it and frees the port.
- [ ] **Narrow layout and keyboard**:
  - At a narrow window size, analysis results scroll, long paths and commands wrap, and nothing is cut off sideways.
  - Tab reaches Analyze Repo and **Use in Setup…**, focus is visible, and Enter opens the review.
- [ ] **No scripts run during analysis**: while analyzing, no `node`, `npm`, `cmd` or other child processes start (check Task Manager), and fixture folders are unchanged.

## Installer smoke test (required before publishing)

Testing the unpacked app (`win-unpacked`) does not replace this. The installer itself must be tested.

1. [ ] Build the versioned NSIS installer for the release.
2. [ ] Check its file name, version and size, and that the expected assets are in the build output.
3. [ ] Install it on a clean or disposable Windows x64 environment (a VM or test account).
4. [ ] Launch RepoRunner from the Start menu or the installed shortcut.
5. [ ] Do a representative journey: Analyze Repo, review the Safety Check and Suggested Setup, Use in Setup… with Apply, then Save.
6. [ ] Close and reopen RepoRunner. The saved setup is still there.
7. [ ] Uninstall RepoRunner from Windows Settings.
8. [ ] Confirm the installer and uninstaller both finished without errors, and the Start menu entry is gone.
9. [ ] Record what SmartScreen and the signature check showed.

## Final publication gates

- [ ] The release version is correct in `package.json` and in the installer and executable metadata.
- [ ] The source tree is clean, and the release is built from the expected commit on `main`.
- [ ] CI passed on that commit.
- [ ] Windows verification (packaged-app checks above) passed.
- [ ] The installer smoke test is complete.
- [ ] The release notes and README are checked against the app, including the Repo Safety Check limitations.
- [ ] No tag or GitHub release was created before authorization.
- [ ] Explicit authorization to publish has been given.
