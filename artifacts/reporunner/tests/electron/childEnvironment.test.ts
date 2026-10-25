// Stage 3B: the environment for repository-facing child processes. Synthetic
// values only; no test prints or compares the real environment's values.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("child_process", () => ({ spawn: h.spawn, execFile: vi.fn() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn) },
  dialog: {},
  clipboard: { writeText: () => {} },
  shell: {},
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
}));
vi.mock("../../electron/projectStore.js", () => ({
  loadProject: () => ({ id: "a", name: "R", repoPath: "C:\\fixture\\repo", installCommand: "npm install", frontendCommand: "npm run dev", backendCommand: "", previewUrl: "http://localhost:5173" }),
  loadProjectState: vi.fn(), saveProject: vi.fn(), setActiveProject: vi.fn(), deleteProject: vi.fn(),
  inspectProjectStore: vi.fn(), resolveProjectStoreIssue: vi.fn(), getProjectStoreRevealTarget: vi.fn(),
}));

import { RESERVED_SECRET_VARIABLES, buildChildEnvironment, isReservedSecretVariable } from "../../electron/childEnvironment.js";
import { prepareCommandForExecution, spawnPreparedCommand } from "../../electron/commandUtils.js";
import { setupIpc } from "../../electron/ipc.js";
import { trustedRenderer } from "./fakeSender.js";

/** A realistic developer environment, with synthetic values. */
const DEV_ENV: NodeJS.ProcessEnv = Object.freeze({
  Path: "C:\\Users\\dev\\AppData\\Roaming\\nvm;C:\\nvm4w\\nodejs;C:\\Users\\dev\\AppData\\Local\\Volta\\bin;C:\\Program Files\\Git\\cmd;C:\\Windows\\system32",
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  SystemRoot: "C:\\Windows",
  TEMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
  USERPROFILE: "C:\\Users\\dev",
  APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
  NVM_HOME: "C:\\Users\\dev\\AppData\\Roaming\\nvm",
  NVM_SYMLINK: "C:\\nvm4w\\nodejs",
  VOLTA_HOME: "C:\\Users\\dev\\AppData\\Local\\Volta",
  FNM_DIR: "C:\\Users\\dev\\AppData\\Roaming\\fnm",
  COREPACK_HOME: "C:\\Users\\dev\\AppData\\Local\\node\\corepack",
  npm_config_registry: "https://registry.example.invalid/",
  npm_config_cache: "C:\\npm-cache",
  NPM_TOKEN: "synthetic-npm-token",
  NODE_OPTIONS: "--max-old-space-size=4096",
  GIT_SSH_COMMAND: "ssh -i C:\\Users\\dev\\.ssh\\id_synthetic",
  GIT_ASKPASS: "C:\\tools\\askpass.exe",
  SSH_AUTH_SOCK: "\\\\.\\pipe\\synthetic-agent",
  HTTP_PROXY: "http://proxy.example.invalid:3128",
  HTTPS_PROXY: "http://proxy.example.invalid:3128",
  NO_PROXY: "localhost,127.0.0.1",
  http_proxy: "http://proxy.example.invalid:3128",
  OPENAI_API_KEY: "synthetic-user-owned-key",
  GITHUB_TOKEN: "synthetic-user-owned-token",
  RR_TEST_PIDFILE: "C:\\tmp\\pid.txt",
  REPORUNNER_THEME: "user-owned-not-reserved",
  "=C:": "C:\\Users\\dev",
  "Name With Spaces": "value with spaces and ünïcödé",
  LONG_VALUE: "x".repeat(32_000),
  EMPTY_VALUE: "",
});
const RESERVED_SENTINELS = Object.fromEntries(RESERVED_SECRET_VARIABLES.map((n) => [n, `sentinel-${n.toLowerCase()}`]));

describe("buildChildEnvironment", () => {
  it("keeps every non-reserved variable with its exact value, and removes the reserved ones", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const env = buildChildEnvironment({ ...DEV_ENV, ...RESERVED_SENTINELS }, platform);
      expect(env, platform).toEqual(DEV_ENV);
      for (const name of RESERVED_SECRET_VARIABLES) expect(Object.hasOwn(env, name), `${platform} ${name}`).toBe(false);
    }
  });

  it("returns a fresh object and never changes its input", () => {
    const input = Object.freeze({ ...DEV_ENV, ...RESERVED_SENTINELS });
    const before = JSON.stringify(input);
    const a = buildChildEnvironment(input, "win32");
    const b = buildChildEnvironment(input, "win32");
    expect(a).not.toBe(input);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(before);
    a.Path = "changed";
    expect(input.Path).toBe(DEV_ENV.Path);
  });

  it("on Windows reserved names match in any case; elsewhere only exactly", () => {
    const mixed = { reporunner_byok_api_key: "s1", Reporunner_License_Key: "s2", REPORUNNER_CLOUD_access_TOKEN: "s3", KEEP: "k" };
    expect(buildChildEnvironment(mixed, "win32")).toEqual({ KEEP: "k" });
    expect(buildChildEnvironment(mixed, "linux")).toEqual(mixed);
    expect(isReservedSecretVariable("reporunner_refresh", "win32")).toBe(false);
    expect(isReservedSecretVariable("REPORUNNER_CLOUD_REFRESH_TOKEN", "linux")).toBe(true);
  });

  it("removes only the exact reserved names: similar names, prefixes and user-owned keys stay", () => {
    const similar = {
      REPORUNNER_BYOK_API_KEY_HINT: "a", XREPORUNNER_LICENSE_KEY: "b", REPORUNNER_: "c", REPORUNNER_THEME: "d",
      OPENAI_API_KEY: "e", ANTHROPIC_API_KEY: "f", AWS_SECRET_ACCESS_KEY: "g", NPM_TOKEN: "h",
    };
    expect(buildChildEnvironment(similar, "win32")).toEqual(similar);
  });

  it("handles empty, undefined and unusual entries", () => {
    expect(buildChildEnvironment({}, "win32")).toEqual({});
    expect(buildChildEnvironment({ A: undefined, B: "b" }, "linux")).toEqual({ B: "b" });
    const proto: NodeJS.ProcessEnv = {};
    Object.defineProperty(proto, "__proto__", { value: "kept-as-data", enumerable: true });
    const env = buildChildEnvironment(proto, "win32");
    expect(Object.getOwnPropertyDescriptor(env, "__proto__")?.value).toBe("kept-as-data");
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
  });

  it("the reserved names are the documented four, frozen", () => {
    expect([...RESERVED_SECRET_VARIABLES]).toEqual(["REPORUNNER_BYOK_API_KEY", "REPORUNNER_CLOUD_ACCESS_TOKEN", "REPORUNNER_CLOUD_REFRESH_TOKEN", "REPORUNNER_LICENSE_KEY"]);
    expect(Object.isFrozen(RESERVED_SECRET_VARIABLES)).toBe(true);
  });
});

describe("repository-facing spawns use it", () => {
  const SET = { ...RESERVED_SENTINELS, RR_STAGE3B_KEEP: "keep-me" };
  beforeEach(() => {
    h.spawn.mockReset();
    h.handlers.clear();
    Object.assign(process.env, SET);
    // A mixed-case reserved name, which Windows treats as the same variable.
    if (process.platform === "win32") process.env.Reporunner_Byok_Api_Key = "sentinel-mixed-case";
  });
  afterEach(() => {
    for (const name of Object.keys(SET)) delete process.env[name];
    delete process.env.Reporunner_Byok_Api_Key;
  });
  const checkEnv = (env: NodeJS.ProcessEnv | undefined) => {
    expect(env).toBeDefined();
    expect(env).not.toBe(process.env);
    for (const name of Object.keys(env!)) expect(isReservedSecretVariable(name), name).toBe(false);
    expect(Object.values(env!).some((v) => typeof v === "string" && v.startsWith("sentinel-"))).toBe(false);
    expect(env!.RR_STAGE3B_KEEP).toBe("keep-me");
    // PATH (whatever its case) is passed through unchanged.
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH");
    if (pathKey) expect(env![pathKey]).toBe(process.env[pathKey]);
  };

  it("Install, Start and Restart (spawnPreparedCommand), direct and through a shell", () => {
    for (const command of ["npm run dev", "cmd /c npm run dev", "powershell -NoProfile -Command npm run dev"]) {
      h.spawn.mockClear();
      spawnPreparedCommand(prepareCommandForExecution(command), "C:\\fixture\\repo");
      const options = h.spawn.mock.calls[0].at(-1) as { env?: NodeJS.ProcessEnv };
      checkEnv(options.env);
    }
  });

  it("Git Pull", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    h.spawn.mockImplementation(() => {
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    });
    const app = trustedRenderer();
    setupIpc(app.trust);
    await h.handlers.get("pull-latest")!(app.event());
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = h.spawn.mock.calls[0] as [string, string[], { cwd: string; shell: boolean; env?: NodeJS.ProcessEnv }];
    expect([file, args, options.cwd, options.shell]).toEqual(["git", ["pull"], "C:\\fixture\\repo", false]);
    checkEnv(options.env);
  });

  it("no repository-facing spawn copies process.env directly", () => {
    const dir = path.resolve(import.meta.dirname, "../../electron");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(/\.\.\.process\.env|Object\.assign\([^)]*process\.env|env:\s*process\.env/);
    }
    expect(fs.readFileSync(path.join(dir, "commandUtils.ts"), "utf8")).toMatch(/const env = buildChildEnvironment\(process\.env\);/);
    expect(fs.readFileSync(path.join(dir, "ipc.ts"), "utf8")).toMatch(/spawn\("git", \["pull"\], \{[^}]*env: buildChildEnvironment\(process\.env\),/);
  });
});
