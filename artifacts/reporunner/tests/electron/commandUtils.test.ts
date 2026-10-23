// Command preparation, plus real Windows execution through the same
// spawnPreparedCommand() that Start and Install use. Real runs only use
// harmless commands (echo, node printing its args, npm/pnpm --version and
// "type nul > X.mark" markers) inside a fresh temp directory whose name
// contains spaces. A marker file proves a command segment really ran.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareCommandForExecution,
  sanitizeCommandInput,
  spawnPreparedCommand,
} from "../../electron/commandUtils.js";

const realPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value: platform, configurable: true });

describe("prepareCommandForExecution", () => {
  afterEach(() => setPlatform(realPlatform));

  it("Windows: wraps the command in one pair of quotes and passes it verbatim to cmd /s /c", () => {
    setPlatform("win32");
    expect(prepareCommandForExecution('cd "apps\\my web" && pnpm.cmd run dev')).toEqual({
      kind: "file",
      file: "cmd.exe",
      args: ["/d", "/s", "/c", '"cd "apps\\my web" && pnpm.cmd run dev"'],
      windowsVerbatimArguments: true,
    });
  });

  it("Windows: still strips a pasted label and surrounding whitespace first", () => {
    setPlatform("win32");
    const prepared = prepareCommandForExecution("  Frontend command: npm run dev  ");
    expect(prepared).toMatchObject({ args: ["/d", "/s", "/c", '"npm run dev"'] });
  });

  it("Windows: commands that are already cmd/PowerShell invocations keep using the shell path", () => {
    setPlatform("win32");
    expect(prepareCommandForExecution("cmd /c npm run dev")).toEqual({ kind: "shell", command: "cmd /c npm run dev" });
    expect(prepareCommandForExecution("powershell -Command npm run dev")).toMatchObject({ kind: "shell" });
  });

  it("POSIX: unchanged shell path", () => {
    setPlatform("linux");
    expect(prepareCommandForExecution('cd "my app" && npm run dev')).toEqual({ kind: "shell", command: 'cd "my app" && npm run dev' });
  });

  it("sanitizeCommandInput is unchanged", () => {
    expect(sanitizeCommandInput("  Install command:  npm ci ")).toBe("npm ci");
  });
});

describe.runIf(process.platform === "win32")("real Windows execution (cmd.exe)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr command test "));
    fs.mkdirSync(path.join(dir, "sub dir"));
    fs.writeFileSync(path.join(dir, "sub dir", "print.cjs"), "console.log('ARGS=' + JSON.stringify(process.argv.slice(2)));\n");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs `command` exactly as RepoRunner does; returns exit code, output and created markers. */
  function runAsRepoRunner(command: string): Promise<{ code: number | null; out: string; err: string; marks: string[] }> {
    return new Promise((resolve, reject) => {
      const child = spawnPreparedCommand(prepareCommandForExecution(command), dir);
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("exit", (code) => {
        const marks = fs.readdirSync(dir).filter((n) => n.endsWith(".mark")).sort();
        resolve({ code, out: out.replace(/\r/g, "").trim(), err: err.trim(), marks });
      });
    });
  }

  const args = (out: string) => JSON.parse(out.replace(/^ARGS=/, "")) as string[];

  describe("previously broken commands now work", () => {
    it("quoted relative script path with spaces", async () => {
      const r = await runAsRepoRunner('node "sub dir\\print.cjs" a b');
      expect(r.code).toBe(0);
      expect(args(r.out)).toEqual(["a", "b"]);
    });

    it("quoted absolute script path with spaces", async () => {
      const r = await runAsRepoRunner(`node "${path.join(dir, "sub dir", "print.cjs")}" abs`);
      expect(args(r.out)).toEqual(["abs"]);
    });

    it("quoted executable path at the very start (e.g. C:\\Program Files\\...)", async () => {
      const r = await runAsRepoRunner(`"${process.execPath}" "sub dir\\print.cjs" x`);
      expect(r.code).toBe(0);
      expect(args(r.out)).toEqual(["x"]);
    });

    it("cd into a quoted folder with spaces, then run (monorepo pattern)", async () => {
      const r = await runAsRepoRunner('cd "sub dir" && node print.cjs inside');
      expect(args(r.out)).toEqual(["inside"]);
    });

    it("trailing backslash inside quotes", async () => {
      const r = await runAsRepoRunner('cd "sub dir\\" && node print.cjs trailing');
      expect(args(r.out)).toEqual(["trailing"]);
    });

    it("quoted arguments are preserved, including spaces and an escaped quote", async () => {
      const r = await runAsRepoRunner('node "sub dir\\print.cjs" "two words" plain "a\\"b"');
      expect(args(r.out)).toEqual(["two words", "plain", 'a"b']);
    });

    it("node -e with a quoted script now gets the right exit code", async () => {
      const r = await runAsRepoRunner('node -e "process.exit(3)"');
      expect(r.code).toBe(3);
    });
  });

  describe("package managers", () => {
    it.each(["npm --version", "npm.cmd --version", "pnpm --version"])("%s", async (command) => {
      const r = await runAsRepoRunner(command);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("quoted metacharacters stay literal; nothing extra runs", () => {
    it("a quoted & is passed as text and does not start a second command", async () => {
      const r = await runAsRepoRunner('node "sub dir\\print.cjs" "x & type nul > injected.mark"');
      expect(args(r.out)).toEqual(["x & type nul > injected.mark"]);
      expect(r.marks).toEqual([]);
    });

    it("quoted ( ) | > < ^ are passed as text", async () => {
      const r = await runAsRepoRunner('node "sub dir\\print.cjs" "(literal)" "a|b" "c>d" "e<f" "g^h"');
      expect(args(r.out)).toEqual(["(literal)", "a|b", "c>d", "e<f", "g^h"]);
      expect(r.marks).toEqual([]);
    });

    it("echo of a quoted & prints it like a cmd prompt would", async () => {
      const r = await runAsRepoRunner('echo "Tom & Jerry"');
      expect(r.out).toBe('"Tom & Jerry"');
    });
  });

  describe("intentional chaining behaves as before", () => {
    it.each([
      ["&&", "type nul > a.mark && type nul > b.mark", ["a.mark", "b.mark"]],
      ["&", "type nul > a.mark & type nul > b.mark", ["a.mark", "b.mark"]],
      ["|| after a failure", 'node -e "process.exit(1)" || type nul > fallback.mark', ["fallback.mark"]],
      ["|| after success (skipped)", "node -e 0 || type nul > fallback.mark", []],
      ["parentheses", "(type nul > p1.mark) & (type nul > p2.mark)", ["p1.mark", "p2.mark"]],
      ["if/else", "if 1==1 (type nul > yes.mark) else (type nul > no.mark)", ["yes.mark"]],
    ])("%s", async (_label, command, marks) => {
      const r = await runAsRepoRunner(command);
      expect(r.marks).toEqual(marks);
    });

    it("pipe", async () => {
      const r = await runAsRepoRunner("echo hello | findstr hello");
      expect(r.out).toBe("hello");
    });

    it("an unquoted & still separates commands", async () => {
      const r = await runAsRepoRunner("echo one & type nul > second.mark");
      expect(r.out).toBe("one");
      expect(r.marks).toEqual(["second.mark"]);
    });

    it("a caret-escaped & is literal (the rest is a redirect, as at a cmd prompt)", async () => {
      const r = await runAsRepoRunner("echo one ^& two > out.mark");
      expect(r.marks).toEqual(["out.mark"]);
      expect(fs.readFileSync(path.join(dir, "out.mark"), "utf8").trim()).toBe("one & two");
    });
  });

  describe("malformed input fails predictably", () => {
    it("an unmatched quote makes the rest literal: no extra command runs", async () => {
      const r = await runAsRepoRunner('echo "unterminated & type nul > unmatched.mark');
      expect(r.code).toBe(0);
      expect(r.out).toBe('"unterminated & type nul > unmatched.mark');
      expect(r.marks).toEqual([]);
    });

    it("a missing executable fails with a non-zero exit and runs nothing else", async () => {
      const r = await runAsRepoRunner("definitely-not-a-real-command-rr && type nul > after.mark");
      expect(r.code).not.toBe(0);
      expect(r.marks).toEqual([]);
    });

    it("a newline ends the command (only the first line runs), as before", async () => {
      const r = await runAsRepoRunner("type nul > a.mark\ntype nul > b.mark");
      expect(r.marks).toEqual(["a.mark"]);
    });
  });

  it("regression evidence: the previous invocation (escaped arguments) broke quoted paths", async () => {
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn("cmd.exe", ["/d", "/s", "/c", 'cd "sub dir" && node print.cjs x'], { cwd: dir, shell: false });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("exit", (code) => resolve({ code, err }));
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/cannot find the path/i);
  });
});
