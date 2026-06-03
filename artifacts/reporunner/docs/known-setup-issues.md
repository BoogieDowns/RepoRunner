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

## Unsigned Windows installer warning

RepoRunner is currently an unsigned Windows V0 app. Windows may show a security warning during install.

This is expected for now. Download RepoRunner from the official GitHub release or from the website link to the GitHub release.
