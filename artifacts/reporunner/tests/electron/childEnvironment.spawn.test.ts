// Stage 3B: real child processes. A harmless Node script reports only whether
// each variable is present (never a value): reserved sentinels must be absent,
// a user variable present. Runs the real spawnPreparedCommand, including the
// shell path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESERVED_SECRET_VARIABLES } from "../../electron/childEnvironment.js";
import { prepareCommandForExecution, spawnPreparedCommand } from "../../electron/commandUtils.js";

let dir: string;
const SET: Record<string, string> = { ...Object.fromEntries(RESERVED_SECRET_VARIABLES.map((n) => [n, "sentinel-real-child"])), RR_STAGE3B_KEEP: "keep-me" };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-stage3b-"));
  const names = JSON.stringify([...RESERVED_SECRET_VARIABLES, "reporunner_byok_api_key", "RR_STAGE3B_KEEP"]);
  fs.writeFileSync(
    path.join(dir, "report.cjs"),
    `const names = ${names};\nconsole.log("ENV-REPORT " + JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n] !== undefined]))));\n`,
  );
  Object.assign(process.env, SET);
});
afterAll(() => {
  for (const name of Object.keys(SET)) delete process.env[name];
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(command: string): Promise<Record<string, boolean>> {
  return new Promise((resolve, reject) => {
    const child = spawnPreparedCommand(prepareCommandForExecution(command), dir);
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("exit", () => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith("ENV-REPORT "));
      line ? resolve(JSON.parse(line.slice("ENV-REPORT ".length))) : reject(new Error("no report"));
    });
  });
}

describe("real child processes", () => {
  const commands = process.platform === "win32" ? ["node report.cjs", "cmd /c node report.cjs"] : ["node report.cjs", "sh -c 'node report.cjs'"];

  it.each(commands)("%s: reserved sentinels never arrive; user variables do", async (command) => {
    const report = await run(command);
    for (const name of RESERVED_SECRET_VARIABLES) expect(report[name], name).toBe(false);
    expect(report["reporunner_byok_api_key"]).toBe(false);
    expect(report.RR_STAGE3B_KEEP).toBe(true);
  }, 20_000);
});
