import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { buildChildEnvironment, withWindowsCommandLookupProtection } from "./childEnvironment.js";

const COMMAND_LABEL_PATTERN =
  /^(?:install|frontend|backend|pull)\s+command\s*:\s*/i;

const CMD_WRAPPER_PATTERN = /^cmd(?:\.exe)?\s+(?:(?:\/d|\/s)\s+)*\/c\b/i;
const POWERSHELL_WRAPPER_PATTERN =
  /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/i;

export type PreparedCommand =
  | {
      kind: "shell";
      command: string;
    }
  | {
      kind: "file";
      file: string;
      args: string[];
      /** Pass `args` to the process exactly as given (Windows only). */
      windowsVerbatimArguments?: boolean;
    };

export function sanitizeCommandInput(command: string): string {
  return command.trim().replace(COMMAND_LABEL_PATTERN, "").trim();
}

export function isAlreadyShellWrapped(command: string): boolean {
  const normalizedCommand = sanitizeCommandInput(command);
  return (
    CMD_WRAPPER_PATTERN.test(normalizedCommand) ||
    POWERSHELL_WRAPPER_PATTERN.test(normalizedCommand)
  );
}

export function prepareCommandForExecution(command: string): PreparedCommand {
  const sanitizedCommand = sanitizeCommandInput(command);

  if (
    process.platform === "win32" &&
    !isAlreadyShellWrapped(sanitizedCommand)
  ) {
    // `cmd /s /c "<command>"` strips exactly the outer pair of quotes and runs
    // <command> as if typed at a cmd prompt (this is also how Node runs
    // `shell: true`). The arguments must be passed verbatim: Node's default
    // argument quoting would turn every `"` in the command into `\"`, which
    // cmd.exe keeps as a literal backslash and breaks quoted paths.
    return {
      kind: "file",
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `"${sanitizedCommand}"`],
      windowsVerbatimArguments: true,
    };
  }

  return {
    kind: "shell",
    command: sanitizedCommand,
  };
}

/** Starts a prepared command in `cwd`. The only place RepoRunner spawns configured commands. */
export function spawnPreparedCommand(preparedCommand: PreparedCommand, cwd: string): ChildProcess {
  // RepoRunner's environment minus reserved secret names, and on Windows with
  // cmd.exe's current-directory lookup turned off (see childEnvironment.ts).
  const env = withWindowsCommandLookupProtection(buildChildEnvironment(process.env));
  return preparedCommand.kind === "file"
    ? spawn(preparedCommand.file, preparedCommand.args, {
        cwd,
        shell: false,
        env,
        windowsVerbatimArguments: preparedCommand.windowsVerbatimArguments,
      })
    : spawn(preparedCommand.command, {
        cwd,
        shell: true,
        env,
      });
}

/** cmd.exe's built-in commands: never looked up as files, so never a project tool. */
const CMD_BUILTINS = new Set(
  "assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol".split(" "),
);
/** A plain command name: no path, drive, quotes or leading dot. */
const BARE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_+-]*(?:\.[A-Za-z0-9]+)?(?=\s|$)/;

function candidateFileNames(name: string, pathext: string): string[] {
  const exts = pathext.split(";").map((e) => e.trim().toLowerCase()).filter((e) => /^\.[a-z0-9]+$/.test(e));
  const ext = path.extname(name).toLowerCase();
  return ext && exts.includes(ext) ? [name] : exts.map((e) => name + e);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Guidance for a saved command that failed because its tool lives only in the
 * project folder, which cmd.exe no longer searches (see
 * withWindowsCommandLookupProtection). Returns a message only when all of
 * these hold: Windows, the plain cmd.exe launch path, a failed exit, the
 * command starts with a bare name that is not a cmd.exe built-in and is not
 * found on PATH, and a matching file exists in `cwd`. With the current
 * directory not searched (and AutoRun off with /d), cmd.exe cannot have run
 * such a first command, so it failed as "not recognized". (cmd /c exits with
 * 1 for that, not 9009, and the message is localized, so neither is used.)
 * It only checks file existence; it never runs anything.
 */
export function projectLocalToolHint(
  preparedCommand: PreparedCommand,
  cwd: string,
  exitCode: number | null,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform !== "win32" || exitCode === 0 || exitCode === null || preparedCommand.kind !== "file") return null;
  const quoted = preparedCommand.args[preparedCommand.args.length - 1] ?? "";
  const command = quoted.startsWith('"') && quoted.endsWith('"') ? quoted.slice(1, -1) : quoted;
  const name = BARE_NAME_PATTERN.exec(command)?.[0];
  if (!name || CMD_BUILTINS.has(name.toLowerCase())) return null;
  const lookup = (key: string) => Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1] ?? "";
  const candidates = candidateFileNames(name, lookup("PATHEXT") || ".COM;.EXE;.BAT;.CMD");
  // Found on PATH: the failure came from something else.
  for (const dir of lookup("PATH").split(";")) {
    if (dir && path.isAbsolute(dir) && candidates.some((c) => isFile(path.join(dir, c)))) return null;
  }
  const local = candidates.find((c) => isFile(path.join(cwd, c)));
  if (!local) return null;
  return `This project contains ${local}. RepoRunner doesn't run project-folder tools by bare name. If you meant to run it, use .\\${local} in Setup.`;
}

