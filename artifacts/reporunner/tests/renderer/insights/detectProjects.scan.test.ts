// Detection on real scanner output (not hand-built fixtures), so the builders
// can't drift from what the scanner actually produces.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "../../../electron/repoScanner/scanRepository.js";
import { detectProjects } from "../../../src/lib/insights/detectProjects";
import { FixtureSpace, pkg } from "../../electron/repoScanner/fixtures.js";

let space: FixtureSpace;
beforeAll(() => {
  space = new FixtureSpace();
});
afterAll(() => space.cleanup());

describe("detection on real scans", () => {
  it("a pnpm monorepo with a Vite frontend, an Express API and a component library", async () => {
    const root = space.repo("insights monorepo", {
      "package.json": pkg({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"], packageManager: "pnpm@9.12.0", scripts: { dev: "turbo run dev" }, devDependencies: { turbo: "^2" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "turbo.json": "{}",
      "apps/web/package.json": pkg({ name: "web", scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "^18" }, devDependencies: { vite: "^5" } }),
      "apps/web/vite.config.ts": "export default {}",
      "apps/api/package.json": pkg({ name: "api", scripts: { dev: "tsx watch src/index.ts", start: "node dist/index.js" }, dependencies: { express: "^4" } }),
      "packages/ui/package.json": pkg({ name: "ui", scripts: { build: "tsc" }, dependencies: { react: "^18" } }),
      ".env": "SECRET=CANARY-INSIGHTS-1",
    });
    const result = await scanRepository(root);
    expect(result.status).toBe("complete");

    const insights = detectProjects(result);
    expect(insights.kind).toBe("monorepo");
    expect(insights.orchestration.map((o) => o.tool)).toEqual(["turbo"]);
    const dir = (d: string) => insights.packages.find((p) => p.directory === d)!;
    expect(dir(".").role).toBe("workspace-root");
    expect(dir("apps/web")).toMatchObject({ role: "frontend", frameworks: [{ id: "react-vite", confidence: "high" }], runnability: { runScripts: ["dev"] } });
    expect(dir("apps/api")).toMatchObject({ role: "backend", frameworks: [{ id: "express", confidence: "high" }], runnability: { runScripts: ["dev", "start"] } });
    expect(dir("packages/ui").runnability.status).toBe("no-run-script");
    for (const p of insights.packages) expect(p.packageManager).toMatchObject({ status: "single", candidates: [{ manager: "pnpm" }] });
    expect(JSON.stringify(insights)).not.toContain("CANARY-INSIGHTS-1");
  });

  it("a cancelled real scan keeps its incomplete context", async () => {
    const root = space.repo("insights cancelled", { "package.json": pkg({ name: "x", dependencies: { next: "14" }, scripts: { dev: "next dev" } }) });
    const controller = new AbortController();
    controller.abort();
    const insights = detectProjects(await scanRepository(root, { signal: controller.signal }));
    expect(insights).toMatchObject({ scanStatus: "cancelled", scanComplete: false, packages: [] });
    expect(insights.uncertainties).toEqual(expect.arrayContaining(["scan-cancelled", "packages-incomplete"]));
  });
});
