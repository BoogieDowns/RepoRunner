import { spawn, type ChildProcess } from "child_process";
import { buildChildEnvironment } from "./childEnvironment.js";

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
  // RepoRunner's environment minus reserved secret names (see childEnvironment.ts).
  const env = buildChildEnvironment(process.env);
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
