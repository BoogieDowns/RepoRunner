// Whether a script's displayed name can be put into a command. The scanner
// cleans script names for display (removing invisible and control characters,
// trimming whitespace, shortening), so a displayed name may not be the real
// one, and different scripts can be displayed alike. Only a name that's known
// to be exact and is unique in its package identifies a script.
import type { PackageScript, PackageSummary } from "../../types";

export type ScriptNameProblem = "altered" | "ambiguous";

/** Why `script`'s name can't be used in a command, or null when it can. Missing metadata counts as altered. */
export function scriptNameProblem(pkg: PackageSummary, script: PackageScript): ScriptNameProblem | null {
  if (pkg.scripts.filter((s) => s.name === script.name).length > 1) return "ambiguous";
  return script.nameExact === true ? null : "altered";
}

/** Scripts whose names identify them exactly. */
export function invocableScripts(pkg: PackageSummary): PackageScript[] {
  return pkg.scripts.filter((s) => scriptNameProblem(pkg, s) === null);
}

/** Displayed names accepted by `include` that only unusable scripts carry, with the reason (once per name). */
export function unusableScriptNames(pkg: PackageSummary, include: (name: string) => boolean): { name: string; problem: ScriptNameProblem }[] {
  const out: { name: string; problem: ScriptNameProblem }[] = [];
  for (const script of pkg.scripts) {
    if (!include(script.name) || out.some((u) => u.name === script.name)) continue;
    const problem = scriptNameProblem(pkg, script);
    if (problem) out.push({ name: script.name, problem });
  }
  return out;
}

export function scriptNameProblemText(name: string, problem: ScriptNameProblem): string {
  return problem === "ambiguous"
    ? `more than one script is shown as "${name}" after unsafe characters were removed, so it can't be told which one a command would run`
    : `its name in package.json has characters that were removed or shortened for display, so "${name}" may not be its real name`;
}
