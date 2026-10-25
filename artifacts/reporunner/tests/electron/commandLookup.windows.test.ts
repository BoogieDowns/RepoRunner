// Stage 3C: real cmd.exe on Windows. A scratch "repository" contains harmless
// marker files named like common tools; a scratch PATH folder holds a shim that
// calls bare `node`. The parent environment has NoDefaultCurrentDirectoryInExePath
// removed (the Windows default), so only RepoRunner's protection can stop the
// repository's files from running.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareCommandForExecution, projectLocalToolHint, spawnPreparedCommand } from "../../electron/commandUtils.js";

let repo: string, shims: string;
let savedPath: [string, string] | null = null;
let savedFlag: [string, string][] = [];

function run(command: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnPreparedCommand(prepareCommandForExecution(command), repo);
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, out }));
  });
}

describe.runIf(process.platform === "win32")("real cmd.exe: repository files can't stand in for tools", () => {
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "rr-3c-repo-"));
    shims = fs.mkdtempSync(path.join(os.tmpdir(), "rr-3c-shims-"));
    for (const name of ["npm.cmd", "pnpm.cmd", "node.cmd", "git.cmd", "gradlew.bat", "rrtool.cmd"]) {
      fs.writeFileSync(path.join(repo, name), `@echo REPO-FILE-RAN-${name}\r\n`);
    }
    fs.writeFileSync(path.join(shims, "rrnodeuser.cmd"), "@node -e \"console.log('SHIM-CALLED-NODE')\"\r\n");
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH")!;
    savedPath = [key, process.env[key]!];
    process.env[key] = `${shims};${process.env[key]}`;
    for (const k of Object.keys(process.env).filter((k) => k.toUpperCase() === "NODEFAULTCURRENTDIRECTORYINEXEPATH")) {
      savedFlag.push([k, process.env[k]!]);
      delete process.env[k];
    }
  });
  afterAll(() => {
    if (savedPath) process.env[savedPath[0]] = savedPath[1];
    for (const [k, v] of savedFlag) process.env[k] = v;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(shims, { recursive: true, force: true });
  });

  it.each([
    ["npm --version", /^\d+\.\d+\.\d+/],
    ["npm.cmd --version", /^\d+\.\d+\.\d+/],
    ["pnpm --version", /^\d+\.\d+\.\d+/],
    ["pnpm.cmd --version", /^\d+\.\d+\.\d+/],
    ["node --version", /^v\d+\./],
    ["git --version", /^git version/],
    ["cmd /c npm --version", /^\d+\.\d+\.\d+/],
    ["rrnodeuser", /^SHIM-CALLED-NODE/],
  ])("%s runs the real tool, not the repository's file", async (command, expected) => {
    const { code, out } = await run(command);
    expect(out, command).not.toContain("REPO-FILE-RAN");
    expect(code, command).toBe(0);
    expect(out.trim(), command).toMatch(expected);
  }, 60_000);

  it.each([".\\gradlew.bat", ".\\gradlew", ".\\rrtool", "cmd /c .\\rrtool"])("%s: an explicit project-folder tool still runs", async (command) => {
    const { code, out } = await run(command);
    expect(code, command).toBe(0);
    expect(out, command).toContain("REPO-FILE-RAN");
  }, 30_000);

  it("an absolute path still runs", async () => {
    const { code, out } = await run(`"${path.join(repo, "rrtool.cmd")}"`);
    expect([code, out.trim()]).toEqual([0, "REPO-FILE-RAN-rrtool.cmd"]);
  }, 30_000);

  it("a bare project-folder launcher no longer runs; it fails as not found, and the hint explains it", async () => {
    const { code, out } = await run("gradlew build");
    expect(out).not.toContain("REPO-FILE-RAN");
    // cmd /c reports "is not recognized" with exit code 1.
    expect(code).toBe(1);
    expect(projectLocalToolHint(prepareCommandForExecution("gradlew build"), repo, code)).toContain(".\\gradlew.bat");
  }, 30_000);

  it("an unrelated failure gets no hint", async () => {
    const { code } = await run("node -e process.exit(3)");
    expect(code).toBe(3);
    expect(projectLocalToolHint(prepareCommandForExecution("node -e process.exit(3)"), repo, code)).toBeNull();
  }, 30_000);
});
