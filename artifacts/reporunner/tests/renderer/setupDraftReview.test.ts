// Stage 3B: the optional "Use in Setup…" action on Suggested Setup and the
// review shown before a draft is applied. Rendered server-side like the other
// component tests; clicks are exercised by calling the hook-free components
// directly and invoking their buttons' onClick.
import fs from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RepoSuggestedSetup, UseInSetupButton, type SuggestedSetupActions } from "../../src/components/RepoSuggestedSetup";
import { CURRENT_KIND_TEXT, SetupDraftReview, reviewSafetyText } from "../../src/components/SetupDraftReview";
import { suggestCommands } from "../../src/lib/insights/suggestCommands";
import type { CommandSuggestion } from "../../src/lib/insights/types";
import { planSetupDraft, type SetupDraftContext, type SetupDraftForm, type SetupDraftPlan } from "../../src/lib/setupDraft";
import type { RepoScanResult } from "../../src/types";
import { deepFreeze, pkg, scan, type ScanOptions } from "./insights/builders";

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
const contextFor = (result: RepoScanResult, over: Partial<SetupDraftContext> = {}): SetupDraftContext => ({
  form: FORM,
  fieldOrigins: {},
  setupId: "setup-1",
  analysis: { id: "analysis-1", repoPath: REPO, result },
  ...over,
});
/** What Stage 3C will pass: the Stage 3A planner decides, with the live context. */
const plannerActions = (result: RepoScanResult, onUse = vi.fn(), choosePerRow = false): SuggestedSetupActions & { onUse: ReturnType<typeof vi.fn> } => ({
  canUse: (s) => planSetupDraft(s, contextFor(result), choosePerRow && s.packageManager ? { chosenPackageManager: s.packageManager } : {}).status === "eligible",
  onUse,
});
const render = (result: RepoScanResult, actions?: SuggestedSetupActions) => renderToStaticMarkup(createElement(RepoSuggestedSetup, { result, actions }));
const useButtons = (html: string) => [...html.matchAll(/data-testid="suggestion-use" data-suggestion-id="([^"]+)"/g)].map((m) => m[1]);
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const viteApp = (scripts: Record<string, string> = { dev: "vite" }, files = ["package-lock.json", "vite.config.ts"]): ScanOptions => ({
  packages: [pkg("package.json", { deps: ["react"], dev: ["vite"], scripts })],
  files,
});
const planFor = (result: RepoScanResult, match: (s: CommandSuggestion) => boolean, over: Partial<SetupDraftContext> = {}, choose = false): SetupDraftPlan => {
  const s = suggestCommands(result).suggestions.find(match)!;
  const plan = planSetupDraft(s, contextFor(result, over), choose ? { chosenPackageManager: s.packageManager! } : {});
  if (plan.status !== "eligible") throw new Error(`refused: ${plan.reason}`);
  return plan;
};
const renderReview = (plan: SetupDraftPlan, onApply = vi.fn(), onCancel = vi.fn()) => renderToStaticMarkup(createElement(SetupDraftReview, { plan, onApply, onCancel }));

/** Expands hook-free function components and collects host elements, so their onClick can be invoked. */
function hostElements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function") return visit((el.type as (p: unknown) => ReactNode)(el.props));
    out.push(el);
    visit(el.props.children as ReactNode);
  };
  visit(node);
  return out;
}
const byTestId = (node: ReactNode, id: string) => hostElements(node).filter((el) => el.props["data-testid"] === id);

describe("Suggested Setup: Use in Setup… only where the planner allows it", () => {
  it("root install, develop and start each get their own action; nothing is chosen for the user", () => {
    const result = scan(viteApp({ dev: "vite", start: "vite preview" }));
    const actions = plannerActions(result);
    const html = render(result, actions);
    expect(useButtons(html).sort()).toEqual([".|develop|dev|npm", ".|install|install|npm", ".|start|start|npm"]);
    expect(actions.onUse).not.toHaveBeenCalled();
  });

  it("nested packages, their installs and orchestration scripts stay informational", () => {
    const result = scan({
      packages: [
        pkg("package.json", { workspaces: ["apps/*"], scripts: { dev: "turbo run dev" } }),
        pkg("apps/web/package.json", { deps: ["react"], dev: ["vite"], scripts: { dev: "vite" } }),
        pkg("tools/cli/package.json", { deps: ["express"], scripts: { start: "node cli.js" } }),
      ],
      files: ["package-lock.json", "tools/cli/package-lock.json", "apps/web/vite.config.ts"],
    });
    const all = suggestCommands(result).suggestions;
    expect(all.some((s) => s.directory !== ".")).toBe(true);
    expect(all.some((s) => s.orchestration !== null)).toBe(true);
    const html = render(result, plannerActions(result));
    expect(useButtons(html)).toEqual([".|install|install|npm"]);
    // Even if a caller accepted everything, orchestration rows get no action.
    const everything = render(result, { canUse: () => true, onUse: vi.fn() });
    const orchestrated = all.filter((s) => s.orchestration !== null).map((s) => s.id);
    for (const id of orchestrated) expect(useButtons(everything)).not.toContain(id);
  });

  it("suggestions without a command (unknown package manager) get no action", () => {
    const result = scan(viteApp({ dev: "vite" }, ["vite.config.ts"]));
    expect(suggestCommands(result).suggestions.every((s) => s.command === null)).toBe(true);
    expect(useButtons(render(result, plannerActions(result)))).toEqual([]);
  });

  it("conflicting package managers: no alternative is picked; each can only be chosen explicitly", () => {
    const result = scan(viteApp({ dev: "vite" }, ["package-lock.json", "pnpm-lock.yaml", "vite.config.ts"]));
    // Without a per-row choice the planner refuses every alternative.
    expect(useButtons(render(result, plannerActions(result)))).toEqual([]);
    // With the row itself as the explicit choice, every alternative is offered and none is selected.
    const actions = plannerActions(result, vi.fn(), true);
    expect(useButtons(render(result, actions)).sort()).toEqual([".|develop|dev|npm", ".|develop|dev|pnpm", ".|install|install|npm", ".|install|install|pnpm"]);
    expect(actions.onUse).not.toHaveBeenCalled();
    const review = text(renderReview(planFor(result, (s) => s.scriptName === "dev" && s.packageManager === "pnpm", {}, true)));
    expect(review).toContain("The package-manager evidence conflicts. This uses pnpm, the alternative you chose.");
  });

  it("without actions (or when none are allowed) the section is exactly the read-only Stage 2C view", () => {
    const result = scan(viteApp({ dev: "vite", start: "vite preview" }));
    const plain = render(result);
    expect(plain).not.toMatch(/<(button|a|input|textarea|select|form)\b/i);
    expect(render(result, { canUse: () => false, onUse: vi.fn() })).toBe(plain);
  });

  it("the button only reports the choice: one onUse call with that suggestion, nothing else", () => {
    const result = scan(viteApp());
    const s = suggestCommands(result).suggestions.find((x) => x.scriptName === "dev")!;
    const onUse = vi.fn();
    const [button] = byTestId(UseInSetupButton({ suggestion: s, onUse }), "suggestion-use");
    expect(button.props.type).toBe("button");
    expect(button.props["aria-label"]).toBe("Use in Setup: review npm run dev before it fills a Setup field");
    expect(onUse).not.toHaveBeenCalled();
    (button.props.onClick as () => void)();
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse.mock.calls[0]).toHaveLength(1);
    expect(onUse.mock.calls[0][0]).toBe(s); // the very suggestion shown, not a copy
  });
});

describe("SetupDraftReview", () => {
  it("shows the field, exact current and proposed values, purpose, confidence and evidence", () => {
    const result = scan(viteApp({ dev: "vite" }, ["pnpm-lock.yaml", "vite.config.ts"]));
    const html = renderReview(planFor(result, (s) => s.scriptName === "dev"));
    const t = text(html);
    expect(t).toContain("Review change to Frontend Command");
    expect(html).toMatch(/data-testid="setup-draft-current">npm run dev</);
    expect(html).toMatch(/data-testid="setup-draft-proposed">pnpm run dev</);
    expect(t).toContain("Start a development server (a package.json script)");
    expect(t).toContain("High confidence");
    expect(t).toContain(`Script "dev" starts React + Vite's development server`);
    expect(t).toContain("pnpm · script \"dev\"");
  });

  it("start and install reviews name their own purpose and field", () => {
    const result = scan(viteApp({ dev: "vite", start: "vite preview" }));
    expect(text(renderReview(planFor(result, (s) => s.scriptName === "start")))).toContain("Start the app (a package.json script)");
    const install = text(renderReview(planFor(result, (s) => s.source === "install")));
    expect(install).toContain("Review change to Install Command");
    expect(install).toContain("Install dependencies (a standard install command)");
  });

  it("current-value origin: blank, untouched default, and a user value that will be replaced", () => {
    const result = scan(viteApp({ dev: "vite" }, ["pnpm-lock.yaml", "vite.config.ts"]));
    const dev = (s: CommandSuggestion) => s.scriptName === "dev";
    const blank = renderReview(planFor(result, dev, { form: { ...FORM, frontendCommand: "" } }));
    expect(blank).toMatch(/data-testid="setup-draft-current">\(blank\)</);
    expect(text(blank)).toContain(CURRENT_KIND_TEXT.blank);
    const def = text(renderReview(planFor(result, dev, { fieldOrigins: { frontendCommand: "initial-default" } })));
    expect(def).toContain("RepoRunner's starting value, not edited yet");
    expect(def).not.toContain("It will be replaced");
    const user = text(renderReview(planFor(result, dev)));
    expect(user).toContain("A value you entered or saved. It will be replaced.");
  });

  it("an unchanged value is called out, and isn't said to be replaced", () => {
    const result = scan(viteApp());
    const t = text(renderReview(planFor(result, (s) => s.scriptName === "dev")));
    expect(t).toContain("The field already has this value, so applying changes nothing.");
    expect(t).not.toContain("It will be replaced");
  });

  it("Low confidence: visible in words, with every caveat, but still reviewable", () => {
    const result = scan(viteApp({ dev: "custom-dev-server" }));
    const plan = planFor(result, (s) => s.scriptName === "dev");
    const html = renderReview(plan);
    const t = text(html);
    expect(t).toContain("Low confidence: weak evidence");
    expect(t).toContain("Weak evidence: check that this command is right for this repository before you use it.");
    for (const c of plan.caveats) expect(t).toContain(c.text);
    expect(html).toContain('data-testid="setup-draft-apply"');
  });

  it("an incomplete analysis is flagged", () => {
    const result = scan({ ...viteApp(), status: "truncated" });
    const t = text(renderReview(planFor(result, (s) => s.scriptName === "dev")));
    expect(t).toContain("This analysis didn't finish, so some suggestions may be missing and none are rated High.");
    expect(t).not.toContain("High confidence");
  });

  it("safety: what Apply does and doesn't do; never 'verified' or 'safe'", () => {
    const result = scan(viteApp());
    const t = text(renderReview(planFor(result, (s) => s.source === "install")));
    for (const line of reviewSafetyText("installCommand")) expect(t).toContain(line);
    expect(t).toContain("Ports, Preview URL, Backend Command and the repository folder aren't changed.");
    expect(t).toContain("It doesn't save the setup");
    expect(t).toContain("It doesn't install dependencies or run any command.");
    // Stage 2's caveat says "Not run or verified"; no text may claim the opposite.
    expect(t).toContain("Not run or verified.");
    expect(t).not.toMatch(/\b(is verified|been verified|verified to|is safe|safe to run|guaranteed|will work)\b/i);
  });

  it("names the Setup screen's real save buttons, and Apply stays separate from saving", () => {
    const result = scan(viteApp({ dev: "vite" }, ["pnpm-lock.yaml", "vite.config.ts"]));
    const plan = planFor(result, (s) => s.scriptName === "dev");
    const t = text(renderReview(plan));
    expect(t).toContain("It doesn't save the setup: use Save Repo Setup or Update Repo Setup when you're ready.");
    expect(t).not.toContain("Save Configuration");
    // Both labels are the Setup screen's save button (new setup / saved setup).
    const screen = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/components/SetupScreen.tsx"), "utf-8");
    expect(screen).toContain('"Save Repo Setup"');
    expect(screen).toContain('"Update Repo Setup"');
    // The review's own controls are only Cancel and Apply to Setup; neither saves.
    const tree = SetupDraftReview({ plan, onApply: vi.fn(), onCancel: vi.fn() });
    const labels = hostElements(tree).filter((el) => el.type === "button").map((b) => text(renderToStaticMarkup(b)).trim());
    expect(labels).toEqual(["Cancel", "Apply to Setup"]);
  });

  it("long values wrap and are shown in full", () => {
    const result = scan(viteApp());
    const long = `npm run dev -- ${"--flag-with-a-long-name ".repeat(20)}`.trim();
    const html = renderReview(planFor(result, (s) => s.scriptName === "dev", { form: { ...FORM, frontendCommand: long } }));
    expect(text(html)).toContain(long);
    expect(html).toMatch(/class="[^"]*whitespace-pre-wrap[^"]*break-all[^"]*"[^>]*data-testid="setup-draft-current"/);
  });

  it("Apply and Cancel only call their callbacks; nothing on render", () => {
    const result = scan(viteApp({ dev: "vite" }, ["pnpm-lock.yaml", "vite.config.ts"]));
    const plan = planFor(result, (s) => s.scriptName === "dev");
    const onApply = vi.fn();
    const onCancel = vi.fn();
    renderReview(plan, onApply, onCancel);
    const tree = SetupDraftReview({ plan, onApply, onCancel });
    expect([onApply.mock.calls.length, onCancel.mock.calls.length]).toEqual([0, 0]);

    const [apply] = byTestId(tree, "setup-draft-apply");
    const [cancel] = byTestId(tree, "setup-draft-cancel");
    (cancel.props.onClick as () => void)();
    expect([onApply.mock.calls.length, onCancel.mock.calls.length]).toEqual([0, 1]);
    (apply.props.onClick as () => void)();
    expect([onApply.mock.calls.length, onCancel.mock.calls.length]).toEqual([1, 1]);
    expect(onApply.mock.calls[0]).toEqual([]);
  });

  it("controls are real buttons with descriptive labels; confidence is stated in words", () => {
    const result = scan(viteApp({ dev: "vite" }, ["pnpm-lock.yaml", "vite.config.ts"]));
    const plan = planFor(result, (s) => s.scriptName === "dev");
    const tree = SetupDraftReview({ plan, onApply: vi.fn(), onCancel: vi.fn() });
    const buttons = hostElements(tree).filter((el) => el.type === "button");
    expect(buttons.map((b) => [b.props.type, b.props["aria-label"]])).toEqual([
      ["button", "Cancel: keep the current Frontend Command"],
      ["button", "Apply to Setup: put pnpm run dev in Frontend Command"],
    ]);
    const html = renderReview(plan);
    expect(html).toMatch(/<section[^>]*aria-labelledby="setup-draft-review-[^"]+"/);
    expect(html).toMatch(/data-testid="setup-draft-confidence">High confidence</);
  });

  it("inputs are never mutated", () => {
    const result = deepFreeze(scan(viteApp({ dev: "vite", start: "vite preview" })));
    const plan = deepFreeze(planFor(result, (s) => s.scriptName === "start"));
    const before = JSON.stringify([result, plan]);
    renderReview(plan);
    render(result, plannerActions(result));
    SetupDraftReview({ plan, onApply: vi.fn(), onCancel: vi.fn() });
    expect(JSON.stringify([result, plan])).toBe(before);
  });
});

describe("boundaries", () => {
  it.each(["SetupDraftReview.tsx", "RepoSuggestedSetup.tsx"])("%s has no IPC, saving, storage, network or execution", (file) => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/components", file), "utf-8");
    expect(source).not.toMatch(/window\.|repoRunner|ipcRenderer|saveProject|runInstall|startFrontend|startBackend|\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|child_process|\beval\(|new Function|dangerouslySetInnerHTML|["']node:/);
  });

  it("the review imports only the planner's types and Suggested Setup's labels", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/components/SetupDraftReview.tsx"), "utf-8");
    expect([...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["../lib/setupDraft", "./RepoSuggestedSetup", "react"]);
    expect(source).toMatch(/import type \{[^}]*\} from "\.\.\/lib\/setupDraft"/);
  });
});
