import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { ProjectProfile, LogEntry, ServiceStatuses } from "../src/types.js";

contextBridge.exposeInMainWorld("repoRunner", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),

  saveProject: (profile: ProjectProfile) =>
    ipcRenderer.invoke("save-project", profile),

  loadProject: () => ipcRenderer.invoke("load-project"),

  pullLatest: () => ipcRenderer.invoke("pull-latest"),

  runInstall: () => ipcRenderer.invoke("run-install"),

  startFrontend: () => ipcRenderer.invoke("start-frontend"),

  startBackend: () => ipcRenderer.invoke("start-backend"),

  stopServices: () => ipcRenderer.invoke("stop-services"),

  restartAll: () => ipcRenderer.invoke("restart-all"),

  openPreview: () => ipcRenderer.invoke("open-preview"),

  copyLogs: (logs: string) => ipcRenderer.invoke("copy-logs", logs),

  clearLogs: () => ipcRenderer.invoke("clear-logs"),

  getStatuses: () => ipcRenderer.invoke("get-statuses"),

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
});
