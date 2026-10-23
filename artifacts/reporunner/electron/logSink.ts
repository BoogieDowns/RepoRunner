import { BrowserWindow } from "electron";
import { MAX_RETAINED_LOG_ENTRIES, type LogEntry, type LogSource } from "../src/types.js";

let logCounter = 0;
let logBuffer: LogEntry[] = [];

function formatLogTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
}

export function emitLog(source: LogSource, text: string) {
  const entry: LogEntry = {
    id: `${Date.now()}-${logCounter++}`,
    timestamp: Date.now(),
    source,
    text,
  };

  // Same retention as the window (appendRetainedLog), trimmed in place so a
  // chatty process doesn't copy the whole buffer for every line.
  logBuffer.push(entry);
  if (logBuffer.length > MAX_RETAINED_LOG_ENTRIES) {
    logBuffer.splice(0, logBuffer.length - MAX_RETAINED_LOG_ENTRIES);
  }

  const win = BrowserWindow.getAllWindows()[0];
  try {
    // Logs still go to the buffer when the window is closing or gone (for
    // example while services stop during quit).
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send("log", entry);
  } catch {
    // Nothing to deliver to.
  }
}

export function clearLogs() {
  logBuffer = [];
}

export function formatLogsForClipboard(): string {
  return logBuffer
    .map((log) => `${formatLogTimestamp(log.timestamp)} [${log.source.toUpperCase()}] ${log.text}`)
    .join("\n");
}
