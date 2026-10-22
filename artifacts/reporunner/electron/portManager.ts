import { execFile } from "child_process";
import { promisify } from "util";
import tcpPortUsed from "tcp-port-used";

const execFileAsync = promisify(execFile);
const PORT_OWNER_LOOKUP_TIMEOUT_MS = 5000;

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

// A listening socket's foreign address is a wildcard on every Windows locale,
// whereas the State column ("LISTENING") is translated on non-English systems.
const LISTENING_FOREIGN_ADDRESSES = new Set(["0.0.0.0:0", "[::]:0"]);

/**
 * Returns the PID from a `netstat -ano` row only when that row is a TCP
 * listener bound to exactly `targetPort` on its local address. Rows where the
 * port only appears in the foreign address (client connections such as a
 * browser tab), partial port matches (80 vs 8080), UDP rows, and PID 0 are
 * rejected.
 */
export function netstatRowOwnsPort(line: string, targetPort: number): string | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) {
    return null;
  }

  const protocol = parts[0]?.toUpperCase();
  if (protocol !== "TCP") {
    return null;
  }

  const localAddress = parts[1];
  const foreignAddress = parts[2];
  const state = parts[parts.length - 2]?.toUpperCase();
  const pid = parts[parts.length - 1];

  if (!pid || !/^\d+$/.test(pid) || pid === "0") {
    return null;
  }

  if (getExactLocalPort(localAddress) !== targetPort) {
    return null;
  }

  const isListening =
    state === "LISTENING" || LISTENING_FOREIGN_ADDRESSES.has(foreignAddress);

  return isListening ? pid : null;
}

export function parseListeningPids(netstatOutput: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of netstatOutput.split(/\r?\n/)) {
    const pid = netstatRowOwnsPort(line, port);
    if (pid) pids.add(Number(pid));
  }
  return [...pids];
}

/**
 * DIAGNOSTIC ONLY. Looks up which PIDs are listening on `port` so RepoRunner
 * can tell the user what is holding it. Callers must never terminate a PID
 * returned from here: a port listener is not proof that RepoRunner started it.
 * Returns an empty list when the lookup fails for any reason.
 */
export async function findListeningPids(port: number): Promise<number[]> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano"], {
        timeout: PORT_OWNER_LOOKUP_TIMEOUT_MS,
        windowsHide: true,
      });
      return parseListeningPids(stdout, port);
    }

    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: PORT_OWNER_LOOKUP_TIMEOUT_MS }
    );
    return [
      ...new Set(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^\d+$/.test(line) && line !== "0")
          .map(Number)
      ),
    ];
  } catch {
    return [];
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

