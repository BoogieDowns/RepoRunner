# Known setup issues

RepoRunner runs the commands you save against the local repo path you choose. Most setup problems come from the project path, package scripts, missing environment variables, or ports that are already in use.

## Use npm.cmd or pnpm.cmd on Windows

On Windows, use `.cmd` commands in RepoRunner setup fields:

`npm.cmd install`

`npm.cmd run dev`

`pnpm.cmd install`

`pnpm.cmd run dev`

This avoids PowerShell execution policy problems that can happen with bare `npm` or `pnpm` commands.

## Choose the actual repo root folder

The repo path should point to the local folder you want RepoRunner to control.

Example:

`C:\Users\YourName\Desktop\MyProject`

If you choose the wrong folder, install, start, pull, or preview commands may fail because RepoRunner is running them from the wrong place.

## For monorepos, include cd in the command

For workspace or monorepo projects, keep the repo path at the workspace root. If the app lives in a subfolder, use `cd` inside the command.

Example frontend command:

`cd apps\web && pnpm.cmd run dev`

Example backend command:

`cd apps\api && pnpm.cmd run dev`

Change the folder names to match your repo.

## Make sure package scripts exist

RepoRunner does not create package scripts. It runs the command you give it.

If you use:

`pnpm.cmd run dev`

your `package.json` needs a matching `dev` script.

Example:

`"dev": "vite"`

If the script does not exist, the command will fail.

## Make sure environment variables are already configured

Some apps need local environment variables before they can start.

Common examples:

`DATABASE_URL`

`API_KEY`

`JWT_SECRET`

`NEXT_PUBLIC_API_URL`

Create the required `.env` file for your project before starting it from RepoRunner.

## Check ports if preview does not open

If the app starts but the preview does not open correctly, check that the configured port matches the app.

Common defaults:

`Vite: 5173`

`Next.js: 3000`

`Backend APIs: often 3001, 4000, 5000, or 8000`

If a port is already in use, stop the other process or change the port in your project and in RepoRunner setup.

## Frontend-only apps are supported

If your project does not have a backend service, leave the backend command and backend port fields empty.

RepoRunner will skip backend startup and only run the frontend command.

## Stop services before switching saved setups

RepoRunner can save multiple setups, but it runs one active repo at a time. Stop running services before switching saved setups.

## If saved repos can't be loaded

RepoRunner never treats a damaged saved-repos file as "no saved repos", and it never overwrites it on its own. If the file can't be read safely, the setup screen shows a notice instead of an empty setup, and saving, switching and deleting are paused until you choose what to do. Stop Engine keeps working, so anything already running can still be stopped.

The notice only offers the options that are safe for the problem it found:

- **Retry** reads the file again and changes nothing. Use it after closing a program that was using the file (antivirus, a sync tool) or fixing its permissions.
- **Restore Backup** appears only when RepoRunner has a backup that loads cleanly. It replaces the damaged file with the most recent backup. Changes made after that backup are not included.
- **Start Fresh** creates a new, empty saved-repos file. Nothing is deleted: the damaged file and the backup are kept as recovery copies first.
- **Show File Location** opens the folder that contains the saved-repos file.

Restore Backup and Start Fresh always ask you to confirm first, because they replace the file RepoRunner uses. They never run automatically and never start a repo.

### Some saved repos are unavailable

If only some saved repos have incomplete or invalid details, the others keep working. The notice shows how many can't be used and which field is the problem; the unavailable entries are not deleted and still count toward the 5-repo limit.

**Discard Unavailable Entries** removes them after you confirm. A full copy of the file is kept first. If the selected repo was one of the discarded entries, no repo is selected afterwards — RepoRunner won't pick a different one for you.

### Files from a newer RepoRunner

If the saved-repos file was written by a newer version of RepoRunner, this version can't be sure it understands it. It won't change the file or run commands from it. Update RepoRunner to use these saved repos again.

### Where backups and recovery copies are kept

Everything stays next to the saved-repos file (`reporunner-project.json`) in RepoRunner's app data folder:

- `reporunner-project.json.bak`: backup of the previous version, updated on each successful save.
- `reporunner-project.legacy.json`: one-time copy made when an older single-repo file is converted.
- `reporunner-project.recovery-<date>-<reason>-<id>.json`: copies made before Restore Backup, Start Fresh or Discard Unavailable Entries.

RepoRunner never deletes recovery copies. You can remove old ones yourself once you no longer need them.

### Only one RepoRunner window

RepoRunner runs as a single instance. Opening it again brings the existing window to the front instead of starting a second copy that could edit the same saved repos or lose track of running services.

## Unsigned Windows installer warning

RepoRunner is currently an unsigned Windows V0 app. Windows may show a security warning during install.

This is expected for now. Download RepoRunner from the official GitHub release or from the website link to the GitHub release.
