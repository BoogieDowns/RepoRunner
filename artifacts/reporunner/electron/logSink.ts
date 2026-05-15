import { BrowserWindow } from "electron";
import type { LogEntry, LogSource } from "../src/types.js";

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

  logBuffer.push(entry);

  const wins = BrowserWindow.getAllWindows();
  wins[0]?.webContents.send("log", entry);
}

export function clearLogs() {
  logBuffer = [];
}

export function formatLogsForClipboard(): string {
  return logBuffer
    .map((log) => `${formatLogTimestamp(log.timestamp)} [${log.source.toUpperCase()}] ${log.text}`)
    .join("\n");
}
