import { scanRepository, type ScanOptions } from "./scanRepository.js";
import { RepoScanError, type RepoScanResult } from "./types.js";

/**
 * Owns at most one active scan. A second request while one is running is
 * rejected ("scan-in-progress"). cancel() aborts the active scan; ownership is
 * released only when that scan has actually finished, so a cancelled scan can
 * never overlap with, or write into, the next one (each scan builds its own
 * result object).
 */
export class RepoScanSession {
  private active: { id: number; controller: AbortController } | null = null;
  private nextId = 1;

  get isScanning(): boolean {
    return this.active !== null;
  }

  async scan(root: unknown, options: Omit<ScanOptions, "signal"> = {}): Promise<RepoScanResult> {
    if (this.active) throw new RepoScanError("scan-in-progress");

    const id = this.nextId++;
    const controller = new AbortController();
    this.active = { id, controller };
    try {
      return await scanRepository(root, { ...options, signal: controller.signal });
    } finally {
      if (this.active?.id === id) this.active = null;
    }
  }

  /** Stops the active scan, if any. Returns whether a scan was running. */
  cancel(): boolean {
    if (!this.active) return false;
    this.active.controller.abort();
    return true;
  }
}
