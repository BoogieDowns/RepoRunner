import { startScan, type ScanOptions } from "./scanRepository.js";
import { RepoScanError, type RepoScanResult } from "./types.js";

/**
 * Owns at most one active scan. A second request while one is active is
 * rejected ("scan-in-progress"). cancel() aborts the active scan: its caller
 * gets the "cancelled" result at once, but ownership is released only when
 * the scan's filesystem work has actually finished, so scans never overlap.
 * Each scan builds its own result, so a late finish can't change another's.
 */
export class RepoScanSession {
  private active: { id: number; controller: AbortController; answered: boolean; settled: Promise<void> } | null = null;
  private nextId = 1;

  get isScanning(): boolean {
    return this.active !== null;
  }

  /** The active scan has answered (e.g. cancelled or timed out) but its last filesystem call hasn't returned yet. */
  get isFinishing(): boolean {
    return this.active?.answered === true;
  }

  /**
   * Resolves true once no scan is active, or false after `timeoutMs` or when
   * `signal` aborts (the timer is cleared either way).
   */
  waitUntilIdle(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const active = this.active;
    if (!active) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (idle: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(idle);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(this.active === null), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      void active.settled.then(() => finish(this.active === null));
    });
  }

  async scan(root: unknown, options: Omit<ScanOptions, "signal"> = {}): Promise<RepoScanResult> {
    if (this.active) throw new RepoScanError("scan-in-progress");

    const id = this.nextId++;
    const controller = new AbortController();
    const entry = { id, controller, answered: false, settled: Promise.resolve() };
    this.active = entry;
    const run = startScan(root, {
      ...options,
      signal: controller.signal,
      // Released when the work is done (before the result on a normal finish).
      onSettled: () => {
        if (this.active?.id === id) this.active = null;
      },
    });
    entry.settled = run.settled;
    try {
      return await run.result;
    } finally {
      entry.answered = true;
    }
  }

  /** Stops the active scan, if any. Returns whether a scan was running. */
  cancel(): boolean {
    if (!this.active) return false;
    this.active.controller.abort();
    return true;
  }
}
