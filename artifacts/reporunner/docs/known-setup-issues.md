# Known setup issues

RepoRunner runs your local project commands from the repo path you save in setup. Most setup problems come from the local project, not from RepoRunner itself.

## Wrong repo path

Make sure the repo path points to the folder that contains the project you want RepoRunner to control.

For monorepos, this is often the workspace root, not the frontend app folder.

Example repo path:

    C:\Users\OEM\MyProject

If your commands need to run inside a subfolder, keep the repo path at the project root and use cd inside the command.

Example frontend command:

    cd artifacts\my-app && pnpm.cmd run dev

## Missing package script

If RepoRunner says a command failed, check that the script exists in the target package.json.

Example command:

    pnpm.cmd run dev

That requires a package.json script such as:

    "scripts": {
      "dev": "vite"
    }

## Missing environment variables

Some apps need local environment variables before they can start.

Common examples:

    DATABASE_URL
    API_KEY
    JWT_SECRET

Create the required .env file for your project before starting it from RepoRunner.

## Port already in use

If a frontend or backend fails to start, another process may already be using the configured port.

Close the other app, stop the old server, or change the port in your project or RepoRunner setup.

## PowerShell blocks npm or pnpm

On Windows, PowerShell execution policy can block bare npm or pnpm commands because they may resolve to .ps1 shims.

Use the .cmd versions in RepoRunner commands:

    npm.cmd install
    pnpm.cmd install
    pnpm.cmd run dev

For monorepos:

    cd artifacts\my-app && pnpm.cmd run dev
## Frontend-only apps

RepoRunner can run frontend-only projects.

If your project does not have a backend service, leave the backend command and backend port fields empty in setup. RepoRunner will skip backend startup and only run the frontend command.
