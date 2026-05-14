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
    return {
      kind: "file",
      file: "cmd.exe",
      args: ["/d", "/s", "/c", sanitizedCommand],
    };
  }

  return {
    kind: "shell",
    command: sanitizedCommand,
  };
}
