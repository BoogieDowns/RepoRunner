import { exec } from "child_process";
import { promisify } from "util";
import tcpPortUsed from "tcp-port-used";

const execAsync = promisify(exec);

export async function isPortInUse(port: number): Promise<boolean> {
  // Check both addresses — dev servers may bind to either
  const [on127, onLocalhost] = await Promise.all([
    tcpPortUsed.check(port, "127.0.0.1").catch(() => false),
    tcpPortUsed.check(port, "localhost").catch(() => false),
  ]);
  return on127 || onLocalhost;
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

/**
 * Polls until the given port accepts a connection on either 127.0.0.1 or localhost.
 * Returns true as soon as the port is reachable, false on timeout.
 */
export async function waitUntilPortIsReachable(
  port: number,
  timeoutMs: number = 15000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [on127, onLocalhost] = await Promise.all([
        tcpPortUsed.check(port, "127.0.0.1").catch(() => false),
        tcpPortUsed.check(port, "localhost").catch(() => false),
      ]);
      if (on127 || onLocalhost) return true;
    } catch {
      // ignore transient errors
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function getExactLocalPort(localAddress: string): number | null {
  const bracketedIpv6Match = localAddress.match(/^\[.*\]:(\d+)$/);
  if (bracketedIpv6Match) {
    return Number(bracketedIpv6Match[1]);
  }

  const lastColonIndex = localAddress.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return null;
  }

  const portText = localAddress.slice(lastColonIndex + 1);
  if (!/^\d+$/.test(portText)) {
    return null;
  }

  return Number(portText);
}

function netstatRowOwnsPort(line: string, targetPort: number): string | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) {
    return null;
  }

  const protocol = parts[0]?.toUpperCase();
  const localAddress = parts[1];
  const pid = parts[parts.length - 1];

  if (!pid || !/^\d+$/.test(pid) || pid === "0") {
    return null;
  }

  const localPort = getExactLocalPort(localAddress);
  if (localPort !== targetPort) {
    return null;
  }

  if (protocol === "TCP") {
    if (parts.length < 5) {
      return null;
    }

    const state = parts[parts.length - 2]?.toUpperCase();
    return state === "LISTENING" ? pid : null;
  }

  if (protocol === "UDP") {
    return pid;
  }

  return null;
}
export async function killProcessUsingPort(port: number): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
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

