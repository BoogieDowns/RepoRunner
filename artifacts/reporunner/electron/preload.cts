import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  CredentialSlotId,
  ProjectProfile,
  ProjectStoreRecoveryAction,
  LogEntry,
  ServiceStatuses,
} from "../src/types.js";

/*
 * Credential methods (Stage 4C) are added only when the main process passed
 * this switch, which it does only in internal development launches (see
 * electron/internalFeatures.ts; packaged builds never pass it). Each forwards
 * exactly its fixed arguments to its one channel. None returns a stored key,
 * and there is no generic invoke.
 *
 * aiConfigStatus (Stage 4I) rides on the same switch: read-only AI
 * configuration metadata, no arguments, no write method.
 */
const INTERNAL_CREDENTIAL_SETTINGS_SWITCH = "--reporunner-internal-credential-settings";
const credentialMethods = process.argv.includes(INTERNAL_CREDENTIAL_SETTINGS_SWITCH)
  ? {
      credentialStatus: (slot: CredentialSlotId) => ipcRenderer.invoke("credential-status", slot),
      setCredential: (slot: CredentialSlotId, secret: string, options: { remember: boolean }) =>
        ipcRenderer.invoke("credential-set", slot, secret, options),
      removeCredential: (slot: CredentialSlotId) => ipcRenderer.invoke("credential-remove", slot),
      aiConfigStatus: () => ipcRenderer.invoke("ai-config-status"),
    }
  : {};

// Revisions are only forwarded when given, so existing calls are unchanged.
const withRevision = (args: unknown[], expectedRevision?: string | null) =>
  expectedRevision === undefined ? args : [...args, expectedRevision];

contextBridge.exposeInMainWorld("repoRunner", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),

  saveProject: (profile: ProjectProfile, expectedRevision?: string | null) =>
    ipcRenderer.invoke("save-project", ...withRevision([profile], expectedRevision)),

  loadProjectState: () => ipcRenderer.invoke("load-project-state"),

  loadProject: () => ipcRenderer.invoke("load-project"),

  setActiveProject: (profileId: string, expectedRevision?: string | null) =>
    ipcRenderer.invoke("set-active-project", ...withRevision([profileId], expectedRevision)),

  deleteProject: (profileId: string, expectedRevision?: string | null) =>
    ipcRenderer.invoke("delete-project", ...withRevision([profileId], expectedRevision)),

  getProjectStoreStatus: () => ipcRenderer.invoke("get-project-store-status"),

  resolveProjectStoreIssue: (
    action: ProjectStoreRecoveryAction,
    expectedRevision?: string | null
  ) =>
    ipcRenderer.invoke("resolve-project-store-issue", ...withRevision([action], expectedRevision)),

  revealProjectStoreFile: () => ipcRenderer.invoke("reveal-project-store-file"),

  pullLatest: () => ipcRenderer.invoke("pull-latest"),

  runInstall: () => ipcRenderer.invoke("run-install"),

  startFrontend: () => ipcRenderer.invoke("start-frontend"),

  startBackend: () => ipcRenderer.invoke("start-backend"),

  stopServices: () => ipcRenderer.invoke("stop-services"),

  restartAll: () => ipcRenderer.invoke("restart-all"),

  openPreview: () => ipcRenderer.invoke("open-preview"),

  copyLogs: () => ipcRenderer.invoke("copy-logs"),

  clearLogs: () => ipcRenderer.invoke("clear-logs"),

  getStatuses: () => ipcRenderer.invoke("get-statuses"),

  // Read-only repository analysis. Only the path is forwarded.
  analyzeRepo: (repoPath: string) => ipcRenderer.invoke("analyze-repo", repoPath),

  cancelRepoAnalysis: () => ipcRenderer.invoke("cancel-repo-analysis"),

  onLog: (callback: (entry: LogEntry) => void) => {
    const listener = (_event: IpcRendererEvent, entry: LogEntry) =>
      callback(entry);
    ipcRenderer.on("log", listener);
    return () => ipcRenderer.removeListener("log", listener);
  },

  onStatus: (callback: (statuses: ServiceStatuses) => void) => {
    const listener = (
      _event: IpcRendererEvent,
      statuses: ServiceStatuses
    ) => callback(statuses);
    ipcRenderer.on("status", listener);
    return () => ipcRenderer.removeListener("status", listener);
  },

  ...credentialMethods,
});

