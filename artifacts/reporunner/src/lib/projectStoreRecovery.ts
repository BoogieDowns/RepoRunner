/**
 * Renderer-side decisions for the saved-setups recovery notice and for
 * revision-aware edits. Kept free of React so it can be unit-tested.
 *
 * Nothing here performs a recovery action by itself: callers run an action
 * only after an explicit click and, where required, an explicit confirmation.
 */
import {
  PROJECT_STORE_ERROR_MESSAGES,
  type ProjectProfilesState,
  type ProjectStoreErrorCode,
  type ProjectStoreRecoveryAction,
  type ProjectStoreStatus,
  type RepoRunnerAPI,
} from "../types";

export type ProjectStoreNoticeKind =
  | "damaged"
  | "unreadable"
  | "unsupported"
  | "unavailable-entries";

export type ProjectStoreNoticeAction = ProjectStoreRecoveryAction | "reveal";

export interface ProjectStoreNoticeContent {
  kind: ProjectStoreNoticeKind;
  title: string;
  message: string[];
  /** Value-free details (field names and states only). */
  details: string[];
  actions: { action: ProjectStoreNoticeAction; label: string }[];
}

export interface RecoveryConfirmation {
  title: string;
  description: string[];
  confirmLabel: string;
}

export function getNoticeKind(status: ProjectStoreStatus | null): ProjectStoreNoticeKind | null {
  if (!status) return null;
  switch (status.state) {
    case "needs-recovery":
      return "damaged";
    case "unreadable":
      return "unreadable";
    case "unsupported-version":
      return "unsupported";
    case "ok":
      return status.unavailableEntries.length > 0 ? "unavailable-entries" : null;
    default:
      return null;
  }
}

/** True when saving, switching and deleting must be blocked. */
export function isStoreBlocked(status: ProjectStoreStatus | null): boolean {
  return Boolean(status && (status.recoveryRequired || status.readOnly));
}

const DAMAGED_REASONS: Record<string, string> = {
  empty: "The saved setups file is empty.",
  "malformed-json": "The saved setups file is incomplete or not valid JSON.",
  "invalid-encoding": "The saved setups file contains invalid text encoding.",
  "invalid-structure": "The saved setups file isn't in the format RepoRunner expects.",
  "invalid-legacy-profile": "The saved setup in the file is incomplete or invalid.",
  "missing-with-recovery-data": "The saved setups file is missing, but backup or recovery copies were found.",
};

const UNREADABLE_REASONS: Record<string, string> = {
  EACCES: "Windows denied access to the file.",
  EPERM: "Windows denied access to the file.",
  EBUSY: "Another program is using the file.",
};

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function unavailableEntryDetail(entry: { index: number; reason: string }): string {
  const reason = entry.reason
    .replace(/^Invalid project profile:\s*/, "")
    .replace(/^Duplicate profile ID$/, "Uses the same ID as an earlier saved setup")
    .replace(/^Invalid project profile$/, "Incomplete or invalid details");
  return `Saved setup ${entry.index + 1}: ${reason}`;
}

const ACTION_LABELS: Record<ProjectStoreRecoveryAction, string> = {
  retry: "Retry",
  "restore-backup": "Restore Backup",
  "start-fresh": "Start Fresh",
  "discard-invalid-entries": "Discard Unavailable Entries",
};

export function getNoticeContent(status: ProjectStoreStatus | null): ProjectStoreNoticeContent | null {
  const kind = getNoticeKind(status);
  if (!status || !kind) return null;

  // Only actions the backend reports as available are ever offered.
  const actions: ProjectStoreNoticeContent["actions"] = status.availableActions.map((action) => ({
    action,
    label:
      action === "discard-invalid-entries"
        ? `Discard ${status.unavailableEntries.length} Unavailable ${plural(status.unavailableEntries.length, "Entry", "Entries")}`
        : ACTION_LABELS[action],
  }));
  actions.push({ action: "reveal", label: "Show File Location" });

  switch (kind) {
    case "damaged":
      return {
        kind,
        title: "Saved repos couldn't be loaded",
        message: [
          "RepoRunner couldn't read your saved repo setups, so it has paused saving to avoid overwriting them. The original file has been left exactly as it was.",
          status.backupAvailable
            ? "A usable backup is available. You can restore it, or start with no saved setups. Either way, the current file is kept as a recovery copy."
            : "No usable backup was found. You can start with no saved setups; the current file is kept as a recovery copy.",
        ],
        details: status.reason && DAMAGED_REASONS[status.reason] ? [DAMAGED_REASONS[status.reason]] : [],
        actions,
      };
    case "unreadable":
      return {
        kind,
        title: "Saved repos file can't be opened",
        message: [
          "RepoRunner couldn't access your saved repo setups file. This can happen when permissions changed or another program (such as antivirus or a sync tool) is using it.",
          "Nothing has been changed. Close the other program or fix the file permissions, then select Retry.",
        ],
        details: status.reason && UNREADABLE_REASONS[status.reason] ? [UNREADABLE_REASONS[status.reason]] : [],
        actions,
      };
    case "unsupported":
      return {
        kind,
        title: "Saved repos are from a newer RepoRunner",
        message: [
          "Your saved repo setups appear to have been created by a newer version of RepoRunner. This version won't change or run them, so they stay intact.",
          "Update RepoRunner to use these setups.",
        ],
        details: [],
        actions,
      };
    case "unavailable-entries": {
      const count = status.unavailableEntries.length;
      return {
        kind,
        title: `${count} saved ${plural(count, "setup is", "setups are")} unavailable`,
        message: [
          `${count} saved repo ${plural(count, "setup has", "setups have")} incomplete or invalid details and can't be used. ${plural(count, "It has", "They have")} not been deleted.`,
          "Your other saved setups work normally.",
        ],
        details: status.unavailableEntries.map(unavailableEntryDetail),
        actions,
      };
    }
  }
}

export function requiresConfirmation(action: ProjectStoreNoticeAction): boolean {
  return action !== "retry" && action !== "reveal";
}

export function getRecoveryConfirmation(
  action: ProjectStoreNoticeAction,
  status: ProjectStoreStatus,
): RecoveryConfirmation | null {
  switch (action) {
    case "restore-backup":
      return {
        title: "Restore the backup?",
        description: [
          "RepoRunner will replace the damaged saved setups file with its most recent backup.",
          "The damaged file is kept as a recovery copy in the same folder. Nothing is deleted.",
          "Changes made after that backup was taken won't be in the restored setups.",
        ],
        confirmLabel: "Restore Backup",
      };
    case "start-fresh":
      return {
        title: "Start with no saved setups?",
        description: [
          "RepoRunner will create a new, empty saved setups file.",
          status.reason === "missing-with-recovery-data"
            ? "The existing backup is kept as a recovery copy in the same folder. Nothing is permanently deleted."
            : "The current file and any backup are kept as recovery copies in the same folder. Nothing is permanently deleted.",
          "No repo will be started.",
        ],
        confirmLabel: "Start Fresh",
      };
    case "discard-invalid-entries": {
      const count = status.unavailableEntries.length;
      return {
        title: `Discard ${count} unavailable saved ${plural(count, "setup", "setups")}?`,
        description: [
          `RepoRunner will remove ${count} saved ${plural(count, "setup that can't", "setups that can't")} be used.`,
          "Your other saved setups are kept unchanged. A full copy of the current file is kept as a recovery copy first.",
          "If the selected repo was one of them, no repo will be selected. RepoRunner won't pick another one for you.",
        ],
        confirmLabel: `Discard ${count}`,
      };
    }
    default:
      return null;
  }
}

/** Revision to send with a recovery action: none for Retry, otherwise the one the user saw. */
export function recoveryRevision(
  action: ProjectStoreRecoveryAction,
  status: ProjectStoreStatus,
): string | null | undefined {
  return action === "retry" ? undefined : status.revision;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/** Identifies a saved-setups error that crossed IPC by its fixed message text. */
export function classifyStoreError(error: unknown): ProjectStoreErrorCode | null {
  const text = errorText(error);
  if (!text) return null;
  for (const [code, message] of Object.entries(PROJECT_STORE_ERROR_MESSAGES)) {
    if (text.includes(message)) return code as ProjectStoreErrorCode;
  }
  return null;
}

/** Message suitable for display: strips Electron's IPC prefixes. */
export function displayErrorMessage(error: unknown, fallback: string): string {
  const text = errorText(error)
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  return text || fallback;
}

/**
 * Runs one saved-setups mutation exactly once. On any saved-setups error
 * (conflict, unverified write, damaged/unreadable/unsupported file) the
 * persisted state is re-read before the error is passed on. Never retries:
 * after a conflict or an unverified write the user decides what to do next.
 */
export async function runStoreMutation<T>(
  mutate: () => Promise<T>,
  refresh: () => Promise<unknown>,
): Promise<T> {
  try {
    return await mutate();
  } catch (error) {
    if (classifyStoreError(error) !== null) {
      await refresh().catch(() => undefined);
    }
    throw error;
  }
}

/** Ignores calls while a previous call is still running (double clicks, repeated keypresses). */
export function createSingleFlight() {
  let running = false;
  return async function run<T>(task: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (running) return { ran: false };
    running = true;
    try {
      return { ran: true, value: await task() };
    } finally {
      running = false;
    }
  };
}

/**
 * Reads what the UI should show. A blocked store is never presented as an
 * empty list of saved setups: `state` is null and the caller keeps showing
 * whatever it had (nothing, at startup) together with the notice.
 * Only reads; never calls a recovery action.
 */
export async function readStoreForDisplay(
  api: Pick<RepoRunnerAPI, "getProjectStoreStatus" | "loadProjectState">,
): Promise<{ status: ProjectStoreStatus | null; state: ProjectProfilesState | null }> {
  let status: ProjectStoreStatus | null = null;
  try {
    status = await api.getProjectStoreStatus();
  } catch {
    status = null;
  }
  if (isStoreBlocked(status)) return { status, state: null };

  try {
    return { status, state: await api.loadProjectState() };
  } catch {
    // The file changed between the two reads: report its current status.
    try {
      status = await api.getProjectStoreStatus();
    } catch {
      // keep the earlier status
    }
    return { status, state: null };
  }
}
