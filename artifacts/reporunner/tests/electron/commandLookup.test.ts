// Stage 3C: cmd.exe current-directory lookup protection (issue #95) and the
// project-local tool hint. Unit level; synthetic values and scratch folders only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", async (original) => ({ ...(await original<typeof import("child_process")>()), spawn: h.spawn }));

import { RESERVED_SECRET_VARIABLES, WINDOWS_NO_CWD_LOOKUP_VARIABLE, withWindowsCommandLookupProtection } from "../../electron/childEnvironment.js";
import { prepareCommandForExecution, projectLocalToolHint, spawnPreparedCommand } from "../../electron/commandUtils.js";

describe("withWindowsCommandLookupProtection", () => {
  const base = Object.freeze({ PATH: "C:\\Windows\\system32", PATHEXT: ".COM;.EXE;.BAT;.CMD", RR_KEEP: "keep", npm_config_registry: "https://registry.example.invalid/" });

  it("Windows: adds NoDefaultCurrentDirectoryInExePath=1 and keeps everything else", () => {
    expect(withWindowsCommandLookupProtection(base, "win32")).toEqual({ ...base, NoDefaultCurrentDirectoryInExePath: "1" });
  });

  it("Windows: replaces an existing entry in any case or with any value, leaving exactly one", () => {
    for (const [name, value] of [["NoDefaultCurrentDirectoryInExePath", "0"], ["nodefaultcurrentdirectoryinexepath", ""], ["NODEFAULTCURRENTDIRECTORYINEXEPATH", "false"]]) {
      const env = withWindowsCommandLookupProtection({ ...base, [name]: value }, "win32");
      expect(Object.keys(env).filter((k) => k.toUpperCase() === WINDOWS_NO_CWD_LOOKUP_VARIABLE.toUpperCase()), name).toEqual([WINDOWS_NO_CWD_LOOKUP_VARIABLE]);
      expect(env[WINDOWS_NO_CWD_LOOKUP_VARIABLE]).toBe("1");
    }
  });

  it("Linux and macOS: an unchanged copy (no flag added, an existing one kept as is)", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(withWindowsCommandLookupProtection(base, platform), platform).toEqual(base);
      expect(withWindowsCommandLookupProtection({ ...base, NoDefaultCurrentDirectoryInExePath: "0" }, platform).NoDefaultCurrentDirectoryInExePath).toBe("0");
    }
  });

  it("returns a fresh object and never changes its input", () => {
    const input = Object.freeze({ ...base, nodefaultcurrentdirectoryinexepath: "0" });
    const before = JSON.stringify(input);
    const out = withWindowsCommandLookupProtection(input, "win32");
    expect(out).not.toBe(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("spawnPreparedCommand applies it, after the Stage 3B filter", () => {
  const SET = { ...Object.fromEntries(RESERVED_SECRET_VARIABLES.map((n) => [n, "sentinel-3c"])), RR_KEEP: "keep" };
  const realPlatform = process.platform;
  beforeEach(() => {
    h.spawn.mockReset();
    Object.assign(process.env, SET);
  });
  afterAll(() => {
    for (const name of Object.keys(SET)) delete process.env[name];
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });
  const envOf = () => (h.spawn.mock.calls[0].at(-1) as { env: NodeJS.ProcessEnv }).env;

  it("Windows: both launch branches get the flag; reserved names are still removed; process.env is untouched", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const before = process.env[WINDOWS_NO_CWD_LOOKUP_VARIABLE];
    for (const command of ["npm install", "cmd /c npm install", "powershell -NoProfile -Command npm install"]) {
      h.spawn.mockClear();
      const prepared = prepareCommandForExecution(command);
      spawnPreparedCommand(prepared, "C:\\fixture");
      const env = envOf();
      expect(env[WINDOWS_NO_CWD_LOOKUP_VARIABLE], command).toBe("1");
      for (const n of RESERVED_SECRET_VARIABLES) expect(Object.hasOwn(env, n), `${command} ${n}`).toBe(false);
      expect(env.RR_KEEP).toBe("keep");
    }
    expect(process.env[WINDOWS_NO_CWD_LOOKUP_VARIABLE]).toBe(before);
    // The saved command and its arguments are passed exactly as before.
    expect(prepareCommandForExecution("npm install")).toEqual({ kind: "file", file: "cmd.exe", args: ["/d", "/s", "/c", '"npm install"'], windowsVerbatimArguments: true });
  });

  it("Linux: no flag", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const saved = process.env[WINDOWS_NO_CWD_LOOKUP_VARIABLE];
    delete process.env[WINDOWS_NO_CWD_LOOKUP_VARIABLE];
    spawnPreparedCommand(prepareCommandForExecution("npm install"), "/fixture");
    expect(Object.hasOwn(envOf(), WINDOWS_NO_CWD_LOOKUP_VARIABLE)).toBe(false);
    if (saved !== undefined) process.env[WINDOWS_NO_CWD_LOOKUP_VARIABLE] = saved;
  });

  it("Git Pull is not part of it: ipc.ts builds Pull's environment with the Stage 3B builder only", () => {
    const ipc = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/ipc.ts"), "utf8");
    expect(ipc).toMatch(/spawn\("git", \["pull"\], \{[^}]*env: buildChildEnvironment\(process\.env\),/);
    expect(ipc).not.toMatch(/withWindowsCommandLookupProtection/);
  });
});

describe("projectLocalToolHint", () => {
  let project: string, pathDir: string;
  const env = () => ({ PATH: `${pathDir};C:\\Windows\\system32`, PATHEXT: ".COM;.EXE;.BAT;.CMD" });
  const hint = (command: string, code: number | null = 1, platform: NodeJS.Platform = "win32", e = env()) => {
    const prepared = command.startsWith("cmd ") || command.startsWith("powershell ")
      ? ({ kind: "shell", command } as const)
      : ({ kind: "file", file: "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true } as const);
    return projectLocalToolHint(prepared, project, code, platform, e);
  };
  beforeAll(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "rr-3c-project-"));
    pathDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-3c-path-"));
    for (const f of ["gradlew.bat", "mvnw.cmd", "run.bat", "npm.cmd", "echo.cmd", "cd.bat"]) fs.writeFileSync(path.join(project, f), "@echo marker\r\n");
    fs.mkdirSync(path.join(project, "tool.cmd")); // a folder, not a file
    fs.writeFileSync(path.join(pathDir, "npm.cmd"), "@echo marker\r\n");
  });
  afterAll(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(pathDir, { recursive: true, force: true });
  });

  it("bare launcher, lookup failure, file in the project: names that file and the explicit form", () => {
    expect(hint("gradlew build")).toBe("This project contains gradlew.bat. RepoRunner doesn't run project-folder tools by bare name. If you meant to run it, use .\\gradlew.bat in Setup.");
    expect(hint("mvnw -q package")).toContain(".\\mvnw.cmd");
    expect(hint("run.bat")).toContain(".\\run.bat");
  });

  it("no hint without a matching project file, or when the match is a folder", () => {
    expect(hint("missingtool --x")).toBeNull();
    expect(hint("tool")).toBeNull();
  });

  it("no hint for explicit relative or absolute paths, quoted commands or cmd/PowerShell wrappers", () => {
    for (const c of [".\\gradlew build", "./gradlew build", "C:\\tools\\gradlew.bat build", '"gradlew" build', "cmd /c gradlew", "powershell -Command gradlew"]) expect(hint(c), c).toBeNull();
  });

  it("any failed exit qualifies (cmd /c reports 'not recognized' as 1, interactive cmd as 9009)", () => {
    for (const code of [1, 9009, 2]) expect(hint("gradlew build", code), String(code)).toContain(".\\gradlew.bat");
  });

  it("no hint when the name is found on PATH (the failure came from elsewhere), on success, without an exit code, or off Windows", () => {
    expect(hint("npm install && gradlew")).toBeNull();
    for (const code of [0, null]) expect(hint("gradlew build", code), String(code)).toBeNull();
    expect(hint("gradlew build", 1, "linux")).toBeNull();
  });

  it("no hint for cmd.exe built-ins, even when a same-named file sits in the project", () => {
    expect(hint("echo hello && missing")).toBeNull();
    expect(hint("cd apps\\web && missing")).toBeNull();
    expect(hint("ECHO hi")).toBeNull();
  });

  it("only checks for the file: it never runs anything", () => {
    h.spawn.mockClear();
    hint("gradlew build");
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe("the hint is emitted once, after the existing failure message", () => {
  it("Install and Start emit it from their single exit handlers", () => {
    const ipc = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/ipc.ts"), "utf8");
    expect(ipc).toMatch(/emitLog\("install", failureMessage\);\s*const hint = projectLocalToolHint\(preparedCommand, cwd, code\);\s*if \(hint\) emitLog\("system", hint\);\s*reject\(new Error\(failureMessage\)\);/);
    const pm = fs.readFileSync(path.resolve(import.meta.dirname, "../../electron/processManager.ts"), "utf8");
    const exitLine = pm.indexOf("`Process exited with code ${code}");
    const hintLine = pm.indexOf("const hint = projectLocalToolHint(preparedCommand, cwd, code);\n    if (hint) emitLog(\"system\", hint);".replace(/\n/g, pm.includes("\r\n") ? "\r\n" : "\n"));
    expect(exitLine).toBeGreaterThan(-1);
    expect(hintLine).toBeGreaterThan(exitLine);
    expect(pm.slice(exitLine, hintLine).split(/\r?\n/).length).toBeLessThanOrEqual(3);
    expect(pm.match(/projectLocalToolHint\(/g)).toHaveLength(1);
    expect(ipc.match(/projectLocalToolHint\(/g)).toHaveLength(1);
  });
});
