import { execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import { prepareCommandForExecution, spawnPreparedCommand } from "./commandUtils.js";
import { emitLog } from "./logSink.js";
import treeKill from "tree-kill";
import { BrowserWindow } from "electron";
import {
  isPortInUse,
  waitUntilPortIsFree,
  waitUntilPortIsReachable,
  findListeningPids,
} from "./portManager.js";
import {
  LogSource,
  ServiceStatus,
  ServiceStatuses,
} from "../src/types.js";

type ServiceName = "frontend" | "backend";

const execFileAsync = promisify(execFile);

// How long to wait for the tracked root process to exit after each
// termination attempt, and for snapshotted descendants (POSIX) to exit.
const TERMINATE_GRACE_MS = 5000;
const FORCE_TERMINATE_GRACE_MS = 3000;
const DESCENDANT_EXIT_GRACE_MS = 3000;
const PORT_RELEASE_TIMEOUT_MS = 8000;
// tree-kill runs taskkill (Windows) or ps/pgrep (POSIX) without a timeout of
// its own. Bound it so a hung helper can never leave a Stop lock held forever.
const TREE_KILL_TIMEOUT_MS = 10000;
// Overall budget for stopping tracked services when RepoRunner quits.
export const SHUTDOWN_DEADLINE_MS = 15000;

function treeKillAsync(pid: number, signal: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process tree termination did not finish within ${TREE_KILL_TIMEOUT_MS / 1000} seconds`));
    }, TREE_KILL_TIMEOUT_MS);
    treeKill(pid, signal, (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

function serviceLabel(service: ServiceName): string {
  return service.charAt(0).toUpperCase() + service.slice(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LiveChildProcess = ChildProcess & { pid: number };

function isProcessAlive(proc: ChildProcess | null): proc is LiveChildProcess {
  return (
    proc !== null &&
    typeof proc.pid === "number" &&
    proc.exitCode === null &&
    proc.signalCode === null
  );
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isProcessAlive(proc)) return Promise.resolve(true);

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve(!isProcessAlive(proc));
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 only checks for existence; it does not affect the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * POSIX only: records the descendants of a live tracked root so that, after
 * termination, RepoRunner can check whether any of them outlived the root.
 * Returns null when the snapshot is unavailable (including on Windows, where
 * `taskkill /T /F` terminates the tree and reports failures itself).
 */
async function snapshotDescendantPids(rootPid: number): Promise<number[] | null> {
  if (process.platform === "win32") return null;

  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
      timeout: 5000,
    });
    const childrenByParent = new Map<number, number[]>();
    for (const line of stdout.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const siblings = childrenByParent.get(ppid) ?? [];
      siblings.push(pid);
      childrenByParent.set(ppid, siblings);
    }

    const descendants: number[] = [];
    const queue = [rootPid];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const child of childrenByParent.get(parent) ?? []) {
        if (child === rootPid || descendants.includes(child)) continue;
        descendants.push(child);
        queue.push(child);
      }
    }
    return descendants;
  } catch {
    return null;
  }
}

async function waitForPidsToExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isPidAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    alive = alive.filter(isPidAlive);
  }
  return alive;
}

interface TerminationResult {
  rootExited: boolean;
  // True only when RepoRunner has positive evidence that the whole tracked
  // tree is gone, not merely that the root process exited.
  treeVerified: boolean;
  survivingDescendants: number[];
}

/**
 * Terminates ONLY the tracked process and its descendants. tree-kill resolves
 * the tree from the live root PID (`taskkill /T /F` on Windows, ps/pgrep on
 * POSIX), so nothing outside the tracked tree is ever targeted.
 */
async function terminateTrackedProcessTree(
  service: ServiceName,
  proc: LiveChildProcess,
): Promise<TerminationResult> {
  const pid = proc.pid;
  const descendants = await snapshotDescendantPids(pid);

  let lastAttemptFailed = false;
  try {
    await treeKillAsync(pid, "SIGTERM");
  } catch (error) {
    lastAttemptFailed = true;
    emitLog("system", `Stopping ${service} process tree (PID ${pid}) reported an error: ${errorMessage(error)}`);
  }

  let rootExited = await waitForExit(proc, TERMINATE_GRACE_MS);

  if (!rootExited && isProcessAlive(proc)) {
    emitLog("system", `${serviceLabel(service)} (PID ${pid}) has not exited. Retrying termination of its process tree...`);
    try {
      await treeKillAsync(pid, "SIGKILL");
      lastAttemptFailed = false;
    } catch (error) {
      lastAttemptFailed = true;
      emitLog("system", `Retry for ${service} process tree (PID ${pid}) reported an error: ${errorMessage(error)}`);
    }
    rootExited = await waitForExit(proc, FORCE_TERMINATE_GRACE_MS);
  }

  if (!rootExited) {
    return { rootExited, treeVerified: false, survivingDescendants: [] };
  }

  if (descendants === null) {
    // Windows: taskkill /T /F walks the live parent/child chain from the root
    // and exits non-zero when any member it found could not be terminated, so
    // a clean result is evidence the reachable tree is gone. Descendants that
    // were already orphaned (their parent exited earlier) are not reachable;
    // the port check in performStop is the backstop for those.
    // POSIX without a snapshot: root exit alone proves nothing.
    const treeVerified = process.platform === "win32" && !lastAttemptFailed;
    return { rootExited, treeVerified, survivingDescendants: [] };
  }

  const survivingDescendants = await waitForPidsToExit(descendants, DESCENDANT_EXIT_GRACE_MS);
  return {
    rootExited,
    treeVerified: survivingDescendants.length === 0,
    survivingDescendants,
  };
}

// Per-service process handles and run IDs
// A new runId is issued every time startService is called for a service.
// All async callbacks capture the runId at the time they were created and
// bail out if the current runId no longer matches — this prevents stale
// events from a killed process from overwriting the status of a freshly
// started replacement process.
const processes: Record<"frontend" | "backend", ChildProcess | null> = {
  frontend: null,
  backend: null,
};

const runIds: Record<"frontend" | "backend", number> = {
  frontend: 0,
  backend: 0,
};

const statuses: ServiceStatuses = {
  frontend: "stopped",
  backend: "stopped",
};

// Main-process lifecycle locks, set synchronously before any await so that
// Start and Stop for the same service can never interleave, regardless of
// renderer button state.
const startInProgress: Record<ServiceName, boolean> = {
  frontend: false,
  backend: false,
};

const stopInProgress: Record<ServiceName, Promise<void> | null> = {
  frontend: null,
  backend: null,
};

// Set once when RepoRunner starts quitting and never reset: from then on no
// service may start. Stop keeps working.
let shuttingDown = false;
let shutdownCleanup: Promise<ShutdownResult> | null = null;

// Resolvers for waitForServiceSettled — fulfilled when a service leaves "starting"
const settledResolvers: Record<"frontend" | "backend", Array<() => void>> = {
  frontend: [],
  backend: [],
};

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0] : null;
}

function emitStatus() {
  const win = getMainWindow();
  try {
    // The window may be closing or gone while services stop during quit.
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send("status", { ...statuses });
  } catch {
    // Nothing to update.
  }
}

function setStatus(service: "frontend" | "backend", status: ServiceStatus) {
  statuses[service] = status;
  emitStatus();

  // Notify any waitForServiceSettled callers if the service has left "starting"
  if (status !== "starting") {
    const resolvers = settledResolvers[service].splice(0);
    for (const resolve of resolvers) resolve();
  }
}

function streamProcess(proc: ChildProcess, source: LogSource) {
  proc.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) emitLog(source, line);
    }
  });
  proc.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) emitLog(source, line);
    }
  });
}

/**
 * Waits until the service's status is no longer "starting".
 * Resolves immediately if the status is already settled.
 */
export function waitForServiceSettled(
  service: "frontend" | "backend",
  timeoutMs = 60000,
): Promise<void> {
  if (statuses[service] !== "starting") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      // Remove our resolver and force-resolve on timeout
      const idx = settledResolvers[service].indexOf(resolve);
      if (idx !== -1) settledResolvers[service].splice(idx, 1);
      resolve();
    }, timeoutMs);

    settledResolvers[service].push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function startService(
  service: "frontend" | "backend",
  command: string,
  cwd: string,
  port?: number,
): Promise<void> {
  if (shuttingDown) {
    emitLog("system", `RepoRunner is closing, so ${service} was not started.`);
    return;
  }

  if (stopInProgress[service]) {
    emitLog("system", `${service} is stopping. Wait for it to stop before starting it again.`);
    return;
  }

  if (
    startInProgress[service] ||
    statuses[service] === "running" ||
    statuses[service] === "starting"
  ) {
    emitLog("system", `${service} is already running or starting.`);
    return;
  }

  const trackedProc = processes[service];
  if (isProcessAlive(trackedProc)) {
    emitLog(
      "system",
      `RepoRunner is still tracking a running ${service} process (PID ${trackedProc.pid}). Click Stop Engine to stop it before starting again.`,
    );
    return;
  }

  // Issue a new run ID for this invocation. Any callbacks from a previous
  // (now-killed) process will see their captured runId no longer matches
  // and will silently bail out without touching status. A Stop issued while
  // this start is still checking the port also invalidates it.
  startInProgress[service] = true;
  const runId = ++runIds[service];

  try {
    if (port) {
      const inUse = await isPortInUse(port);
      if (runIds[service] !== runId) return;
      if (inUse) {
        emitLog(
          "system",
          `${serviceLabel(service)} port ${port} is already in use. Stop services first or free the port.`,
        );
        setStatus(service, "failed");
        return;
      }
    }
  } finally {
    startInProgress[service] = false;
  }

  // Shutdown may have begun while the port was being checked.
  if (shuttingDown) {
    emitLog("system", `RepoRunner is closing, so ${service} was not started.`);
    return;
  }

  setStatus(service, "starting");
  emitLog(service as LogSource, `Starting ${service}: ${command}`);

  const preparedCommand = prepareCommandForExecution(command);
  const proc = spawnPreparedCommand(preparedCommand, cwd);

  processes[service] = proc;

  streamProcess(proc, service as LogSource);

  proc.on("error", (err) => {
    if (runIds[service] !== runId) return; // stale — a newer process owns this service
    emitLog(service as LogSource, `Error: ${err.message}`);
    setStatus(service, "failed");
  });

  proc.on("exit", (code, signal) => {
    // The root handle is useless once the root has exited, so release it even
    // for stale runs. Only null the slot if it still refers to this process.
    if (processes[service] === proc) processes[service] = null;

    if (runIds[service] !== runId) return; // stale event — stopService owns status

    emitLog(
      service as LogSource,
      `Process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
    );

    const exitedBeforeReady = statuses[service] === "starting";
    const exitStatus: ServiceStatus =
      exitedBeforeReady || code !== 0 ? "failed" : "stopped";

    if (!port) {
      setStatus(service, exitStatus);
      return;
    }

    // Root exit does not prove its descendants exited. If the port is still
    // held, report uncertainty instead of claiming the service stopped.
    void isPortInUse(port).then((inUse) => {
      if (runIds[service] !== runId) return;
      if (inUse) {
        emitLog(
          "system",
          `${serviceLabel(service)} process exited, but port ${port} is still in use. Child processes may still be running. RepoRunner will not stop processes it cannot identify; click Stop Engine to re-check the port.`,
        );
        setStatus(service, "unknown");
      } else {
        setStatus(service, exitStatus);
      }
    });
  });

  // --- Readiness check ---
  if (port) {
    const reachable = await waitUntilPortIsReachable(port, 15000);

    // After the async wait, check if this invocation is still the current one
    if (runIds[service] !== runId) return;

    if (!isProcessAlive(proc)) {
      // The tracked process exited while we were waiting; the exit handler
      // owns the status (including the port-still-held check). A port that
      // became reachable afterwards belongs to something RepoRunner no longer
      // tracks, so it must not be reported as a running service.
      emitLog(
        service as LogSource,
        `${service} process exited before becoming ready on port ${port}.`,
      );
    } else if (reachable) {
      emitLog(service as LogSource, `${service} is ready on port ${port}.`);
      setStatus(service, "running");
    } else {
      // Process still alive but port never opened — mark unknown
      emitLog(
        service as LogSource,
        `${service} process is still alive, but port ${port} did not become reachable within 15 seconds. Status set to Unknown. The app may still be starting; check the preview URL.`,
      );
      setStatus(service, "unknown");
    }
  } else {
    // No port configured — consider running if the process survives 3 seconds
    await new Promise((r) => setTimeout(r, 3000));
    if (runIds[service] !== runId) return;

    if (isProcessAlive(proc)) {
      emitLog(service as LogSource, `${service} appears to be running.`);
      setStatus(service, "running");
    } else if (getStatuses()[service] === "starting") {
      setStatus(service, "failed");
    }
  }
}

/**
 * Stops a service. Only the process RepoRunner spawned and still tracks (and
 * its process tree) is ever terminated. The configured port is inspected for
 * diagnostics only; whatever is listening on it is never killed.
 *
 * Concurrent Stop calls for the same service share one in-flight operation.
 */
export function stopService(
  service: ServiceName,
  port?: number,
): Promise<void> {
  const inFlight = stopInProgress[service];
  if (inFlight) {
    emitLog("system", `${serviceLabel(service)} is already stopping.`);
    return inFlight;
  }

  const operation: Promise<void> = performStop(service, port).finally(() => {
    if (stopInProgress[service] === operation) stopInProgress[service] = null;
  });
  stopInProgress[service] = operation;
  return operation;
}

async function performStop(service: ServiceName, port?: number): Promise<void> {
  const proc = processes[service];

  // Bump run ID so any in-flight startService for this service becomes stale
  const stopRunId = ++runIds[service];

  setStatus(service, "stopping");
  emitLog(service as LogSource, `Stopping ${service}...`);

  const tracked = isProcessAlive(proc);
  let treeVerified = true;

  if (tracked) {
    const result = await terminateTrackedProcessTree(service, proc);

    if (!result.rootExited) {
      // Keep the handle: the process may still be alive, and the handle is
      // the only safe identity for a retry.
      emitLog(
        "system",
        `Could not confirm that ${service} (PID ${proc.pid}) stopped. RepoRunner is still tracking it; click Stop Engine again to retry. No other processes were touched.`,
      );
      if (runIds[service] === stopRunId) setStatus(service, "unknown");
      return;
    }

    if (processes[service] === proc) processes[service] = null;

    treeVerified = result.treeVerified;
    if (!treeVerified) {
      emitLog(
        "system",
        result.survivingDescendants.length > 0
          ? `${serviceLabel(service)} root process exited, but child processes are still running (PID ${result.survivingDescendants.join(", ")}). RepoRunner did not force-stop them.`
          : `${serviceLabel(service)} root process exited, but RepoRunner could not confirm that all of its child processes exited.`,
      );
    }
  } else if (proc && processes[service] === proc) {
    // Stale handle for a root that already exited; it identifies nothing.
    processes[service] = null;
  }

  if (runIds[service] !== stopRunId) return;

  if (port) {
    const portFree = tracked
      ? await waitUntilPortIsFree(port, PORT_RELEASE_TIMEOUT_MS)
      : !(await isPortInUse(port));
    if (runIds[service] !== stopRunId) return;

    if (!portFree) {
      const listeners = await findListeningPids(port);
      if (runIds[service] !== stopRunId) return;
      const holder = listeners.length > 0 ? ` by PID ${listeners.join(", ")}` : "";
      emitLog(
        "system",
        tracked
          ? `Port ${port} is still in use${holder} after stopping ${service}. RepoRunner cannot confirm that process belongs to this repo, so it was left running. If it is a leftover dev server, close it manually.`
          : `Port ${port} is in use${holder}, but RepoRunner is not tracking a ${service} process, so nothing was stopped. Close that process manually or change the ${service} port.`,
      );
      setStatus(service, tracked ? "unknown" : "stopped");
      return;
    }
  }

  if (!treeVerified) {
    setStatus(service, "unknown");
    return;
  }

  setStatus(service, "stopped");
  emitLog(service as LogSource, `${service} stopped.`);
}

export async function stopAllServices(
  frontendPort?: number,
  backendPort?: number,
): Promise<void> {
  await Promise.all([
    stopService("frontend", frontendPort),
    stopService("backend", backendPort),
  ]);
}

export function getStatuses(): ServiceStatuses {
  return { ...statuses };
}

// ---------------------------------------------------------------------------
// Application shutdown
// ---------------------------------------------------------------------------

const SERVICES: readonly ServiceName[] = ["frontend", "backend"];

export type ShutdownOutcome =
  /** Every tracked service tree was stopped (or nothing was tracked). */
  | "stopped"
  /** Stop finished, but RepoRunner could not confirm every tracked root exited. */
  | "processes-remain"
  /** The deadline passed before Stop finished. */
  | "timed-out"
  /** Stop failed unexpectedly. */
  | "error";

export interface ShutdownResult {
  outcome: ShutdownOutcome;
  /** Tracked root PIDs still alive when cleanup ended. */
  remainingPids: number[];
  /** Services whose root exited but whose child processes couldn't be confirmed gone. */
  unverifiedServices: ServiceName[];
  durationMs: number;
}

function trackedLivePids(): number[] {
  return SERVICES.flatMap((service) => {
    const proc = processes[service];
    return isProcessAlive(proc) ? [proc.pid] : [];
  });
}

/** Blocks every future start. Safe to call repeatedly; never undone. */
export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** True when quitting needs to wait for cleanup: a tracked process, a start or a stop is in flight. */
export function hasTrackedServiceWork(): boolean {
  return SERVICES.some(
    (service) => isProcessAlive(processes[service]) || startInProgress[service] || stopInProgress[service] !== null,
  );
}

/**
 * Stops the service trees RepoRunner tracks, for app exit. Uses the normal
 * Stop (tracked handles only, no ports), reuses a Stop already in progress,
 * retries once for roots that survive, and never takes longer than
 * `deadlineMs`. Every call returns the same cleanup.
 */
export function stopTrackedServicesForShutdown(deadlineMs = SHUTDOWN_DEADLINE_MS): Promise<ShutdownResult> {
  beginShutdown();
  if (!shutdownCleanup) shutdownCleanup = runShutdownCleanup(deadlineMs);
  return shutdownCleanup;
}

async function runShutdownCleanup(deadlineMs: number): Promise<ShutdownResult> {
  const startedAt = Date.now();

  const work = (async () => {
    // No ports: at exit only the tracked trees matter, and ports are never
    // used to choose what to stop.
    await Promise.all(SERVICES.map((service) => stopService(service)));
    const survivors = SERVICES.filter((service) => isProcessAlive(processes[service]));
    if (survivors.length > 0) {
      emitLog("system", `Retrying stop for ${survivors.join(" and ")} before RepoRunner closes...`);
      await Promise.all(survivors.map((service) => stopService(service)));
    }
  })();

  // Settles exactly once, whichever comes first; a late rejection from `work`
  // is already handled, so it can't become an unhandled rejection.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    work.then(
      () => ({ kind: "done" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), deadlineMs);
    }),
  ]);
  clearTimeout(timer);

  const remainingPids = trackedLivePids();
  const unverifiedServices = SERVICES.filter((service) => statuses[service] === "unknown");
  const outcome: ShutdownOutcome =
    ended.kind === "timeout"
      ? "timed-out"
      : ended.kind === "error"
        ? "error"
        : remainingPids.length > 0 || unverifiedServices.length > 0
          ? "processes-remain"
          : "stopped";

  if (ended.kind === "error") {
    emitLog("system", `Stopping services before exit failed: ${errorMessage(ended.error)}`);
  }
  if (remainingPids.length > 0) {
    emitLog(
      "system",
      `RepoRunner is closing, but could not confirm that tracked process ${remainingPids.join(", ")} stopped.`,
    );
  }

  return { outcome, remainingPids, unverifiedServices, durationMs: Date.now() - startedAt };
}

