// Suggestions from a real scan and real Stage 2A detection.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { detectProjects } from "../../../src/lib/insights/detectProjects";
import { suggestCommands } from "../../../src/lib/insights/suggestCommands";
import { FixtureSpace, pkg } from "../../electron/repoScanner/fixtures.js";

let space: FixtureSpace;
beforeAll(() => {
  space = new FixtureSpace();
});
afterAll(() => space.cleanup());

describe("suggestions from real scans", () => {
  it("pnpm monorepo: per-app run commands, root orchestration, one root install, hooks named", async () => {
    const root = space.repo("suggest monorepo", {
      "package.json": pkg({ name: "mono", private: true, workspaces: ["apps/*"], packageManager: "pnpm@9.12.0", scripts: { dev: "turbo run dev", postinstall: "husky" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "apps/web/package.json": pkg({ name: "web", scripts: { dev: "vite", predev: "node gen.js" }, dependencies: { react: "^18" }, devDependencies: { vite: "^5" } }),
      "apps/web/vite.config.ts": "export default {}",
      "apps/api/package.json": pkg({ name: "api", scripts: { "start:dev": "nest start --watch", start: "node dist/main.js" }, dependencies: { "@nestjs/core": "^10" } }),
      ".env": "SECRET=CANARY-SUGGEST-1",
    });
    const result = await scanRepository(root);
    const set = suggestCommands(result, detectProjects(result));

    expect(set.scanComplete).toBe(true);
    // Packages in path order; run scripts in preference order; installs last.
    // The root orchestration is low: it doesn't itself invoke a recognized dev
    // server, and which apps turbo starts isn't known.
    expect(set.suggestions.map((s) => [s.directory, s.command, s.confidence])).toEqual([
      ["apps/api", "pnpm run start", "medium"],
      ["apps/api", "pnpm run start:dev", "high"],
      ["apps/web", "pnpm run dev", "high"],
      [".", "pnpm run dev", "low"],
      [".", "pnpm install", "high"],
    ]);
    const web = set.suggestions.find((s) => s.directory === "apps/web")!;
    expect(web.caveats.find((c) => c.code === "lifecycle-hooks")?.text).toContain("predev");
    const install = set.suggestions.find((s) => s.purpose === "install")!;
    expect(install.caveats.find((c) => c.code === "install-runs-project-scripts")?.text).toContain("postinstall");
    expect(JSON.stringify(set)).not.toContain("CANARY-SUGGEST-1");
    expect(JSON.stringify(set)).not.toContain(root);
  });

  it("no lockfile and no packageManager field: unresolved, never npm", async () => {
    const root = space.repo("suggest no pm", { "package.json": pkg({ name: "x", scripts: { start: "node index.js" } }) });
    const set = suggestCommands(await scanRepository(root));
    expect(set.suggestions.map((s) => [s.command, s.unavailableReason])).toEqual([
      [null, "package-manager-unknown"],
      [null, "package-manager-unknown"],
    ]);
  });
});
