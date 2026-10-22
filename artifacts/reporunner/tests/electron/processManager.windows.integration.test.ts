// Windows-only integration tests using REAL processes, restricted to isolated
// fixtures that this test file creates itself (tests/fixtures/*.cjs) and a
// server owned by the test worker. Ports are ephemeral. RepoRunner's stop path
// only ever targets the fixture tree it launched; cleanup only targets PIDs
// the fixtures recorded or that this file spawned.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const APP_DIR = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(APP_DIR, "tests", "fixtures");

type ProcessManager = typeof import("../../electron/processManager.js");

let pm: ProcessManager;
let tmpDir: string;
let pidFile: string;
const ownedPids = new Set<number>();
const ownedChildren: ChildProcess[] = [];
const ownedServers: net.Server[] = [];

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cleanup guard against PID reuse: a recorded fixture PID is only killed if
 * that PID is still running one of this repo's fixture scripts.
 */
function isStillOurFixture(pid: number): boolean {
  try {
    const commandLine = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf-8", timeout: 10000, windowsHide: true },
    );
    return commandLine.includes(FIXTURES) || /tests[\\/]fixtures[\\/](listener|listener-tree|client)\.cjs/.test(commandLine);
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function listenOwned(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.on("error", () => {}));
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      ownedServers.push(server);
      resolve(server);
    });
  });
}

function readFixturePids(): { middle: number; grandchild: number } {
  const pids = JSON.parse(fs.readFileSync(pidFile, "utf-8")) as { middle: number; grandchild: number };
  ownedPids.add(pids.middle);
  ownedPids.add(pids.grandchild);
  return pids;
}

function fixtureCommand(script: string, port: number): string {
  // Relative path from the cwd (APP_DIR) keeps the command free of spaces.
  return `node ${path.relative(APP_DIR, path.join(FIXTURES, script))} ${port}`;
}

describe.runIf(process.platform === "win32")("Windows process termination (real fixtures)", () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-p0a-"));
    pidFile = path.join(tmpDir, "pids.json");
    process.env.RR_TEST_PIDFILE = pidFile;
    vi.resetModules();
    pm = await import("../../electron/processManager.js");
  });

  afterEach(async () => {
    // Best-effort cleanup of processes this file created, and nothing else.
    // Direct children are killed through their own handles; fixture PIDs
    // recorded by the fixtures are only killed after an identity check.
    // Fixtures also exit on their own after 60 s.
    for (const child of ownedChildren.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    for (const pid of ownedPids) {
      if (isPidAlive(pid) && isStillOurFixture(pid)) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
    }
    ownedPids.clear();
    await Promise.all(
      ownedServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    delete process.env.RR_TEST_PIDFILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Stop terminates the full tracked tree (cmd.exe → node → listening grandchild)", async () => {
    const port = await getFreePort();

    await pm.startService("frontend", fixtureCommand("listener-tree.cjs", port), APP_DIR, port);
    expect(pm.getStatuses().frontend).toBe("running");
    const { middle, grandchild } = readFixturePids();
    expect(isPidAlive(middle)).toBe(true);
    expect(isPidAlive(grandchild)).toBe(true);

    await pm.stopService("frontend", port);

    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(await waitFor(() => !isPidAlive(middle) && !isPidAlive(grandchild))).toBe(true);
    expect(await canConnect(port)).toBe(false);
  }, 60000);

  it("Stop leaves an unrelated listener on the configured port running", async () => {
    const port = await getFreePort();
    await listenOwned(port); // stands in for an unrelated app (owned by this test worker)

    await pm.stopService("frontend", port);

    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(await canConnect(port)).toBe(true);
    // Under the old implementation this worker process would have been
    // taskkill'ed here because it owns the port.
  }, 60000);

  it("Start refused on a foreign port, then Stop: the foreign listener survives", async () => {
    const port = await getFreePort();
    await listenOwned(port);

    await pm.startService("frontend", fixtureCommand("listener-tree.cjs", port), APP_DIR, port);
    expect(pm.getStatuses().frontend).toBe("failed");
    expect(fs.existsSync(pidFile)).toBe(false); // nothing was spawned

    await pm.stopService("frontend", port);

    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(await canConnect(port)).toBe(true);
  }, 60000);

  it("a separate client connected to the dev server survives Stop", async () => {
    const port = await getFreePort();
    await pm.startService("frontend", fixtureCommand("listener-tree.cjs", port), APP_DIR, port);
    expect(pm.getStatuses().frontend).toBe("running");
    const { middle, grandchild } = readFixturePids();

    const client = spawn(process.execPath, [path.join(FIXTURES, "client.cjs"), String(port)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    ownedChildren.push(client);
    await new Promise<void>((resolve) => client.stdout!.once("data", () => resolve()));

    await pm.stopService("frontend", port);

    expect(pm.getStatuses().frontend).toBe("stopped");
    expect(await waitFor(() => !isPidAlive(middle) && !isPidAlive(grandchild))).toBe(true);
    expect(client.pid && isPidAlive(client.pid)).toBe(true);
  }, 60000);

  it("Restart-style stop then start brings the tracked tree back on the same port", async () => {
    const port = await getFreePort();
    await pm.startService("frontend", fixtureCommand("listener-tree.cjs", port), APP_DIR, port);
    const first = readFixturePids();

    await pm.stopAllServices(port, undefined);
    expect(await waitFor(() => !isPidAlive(first.grandchild))).toBe(true);

    fs.rmSync(pidFile, { force: true });
    await pm.startService("frontend", fixtureCommand("listener-tree.cjs", port), APP_DIR, port);
    expect(pm.getStatuses().frontend).toBe("running");
    const second = readFixturePids();
    expect(second.grandchild).not.toBe(first.grandchild);

    await pm.stopService("frontend", port);
    expect(pm.getStatuses().frontend).toBe("stopped");
  }, 90000);
});
