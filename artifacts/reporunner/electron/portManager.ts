import { exec } from "child_process";
import { promisify } from "util";
import tcpPortUsed from "tcp-port-used";

const execAsync = promisify(exec);

export async function isPortInUse(port: number): Promise<boolean> {
  return tcpPortUsed.check(port, "127.0.0.1");
}

export async function waitUntilPortIsFree(
  port: number,
  timeoutMs: number = 10000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inUse = await isPortInUse(port);
    if (!inUse) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export async function waitUntilPortIsReachable(
  port: number,
  timeoutMs: number = 30000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const inUse = await tcpPortUsed.check(port, "127.0.0.1");
      if (inUse) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function killProcessUsingPort(port: number): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      const { stdout } = await execAsync(
        `netstat -ano | findstr :${port}`
      );
      const lines = stdout.trim().split("\n");
      const pids = new Set<string>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== "0") {
          pids.add(pid);
        }
      }
      for (const pid of pids) {
        await execAsync(`taskkill /PID ${pid} /T /F`).catch(() => {});
      }
    } else {
      const { stdout } = await execAsync(`lsof -ti tcp:${port}`);
      const pids = stdout.trim().split("\n").filter(Boolean);
      for (const pid of pids) {
        await execAsync(`kill -TERM ${pid}`).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        await execAsync(`kill -KILL ${pid}`).catch(() => {});
      }
    }
  } catch {
    // No process found or already gone
  }
}

export function parsePortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port;
    if (port) return parseInt(port, 10);
    if (parsed.protocol === "https:") return 443;
    if (parsed.protocol === "http:") return 80;
    return null;
  } catch {
    return null;
  }
}
