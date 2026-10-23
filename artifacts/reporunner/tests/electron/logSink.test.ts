// Logging must keep working (into the buffer) when the window is closing or
// gone, e.g. while services are stopped during quit.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ windows: [] as unknown[] }));

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => h.windows } }));

import { clearLogs, emitLog, formatLogsForClipboard } from "../../electron/logSink.js";
import { MAX_RETAINED_LOG_ENTRIES, appendRetainedLog } from "../../src/types.js";

/** Texts of the retained entries, in order, as Copy Logs would produce them. */
const copiedTexts = () =>
  formatLogsForClipboard()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^\d\d:\d\d:\d\d \[[A-Z]+\] /, ""));

function fakeWindow({ destroyed = false, contentsDestroyed = false, sendThrows = false } = {}) {
  const send = vi.fn(() => {
    if (sendThrows) throw new Error("Object has been destroyed");
  });
  return { send, window: { isDestroyed: () => destroyed, webContents: { isDestroyed: () => contentsDestroyed, send } } };
}

beforeEach(() => {
  clearLogs();
  h.windows = [];
});

describe("emitLog", () => {
  it("sends to a live window and buffers the entry", () => {
    const { send, window } = fakeWindow();
    h.windows = [window];

    emitLog("system", "hello");

    expect(send).toHaveBeenCalledWith("log", expect.objectContaining({ source: "system", text: "hello" }));
    expect(formatLogsForClipboard()).toContain("[SYSTEM] hello");
  });

  it.each([
    ["no window", null],
    ["a destroyed window", { destroyed: true }],
    ["destroyed web contents", { contentsDestroyed: true }],
    ["a send that throws while closing", { sendThrows: true }],
  ])("with %s: doesn't throw and still buffers", (_label, options) => {
    const fake = options ? fakeWindow(options) : null;
    h.windows = fake ? [fake.window] : [];

    expect(() => emitLog("system", "stopping before exit")).not.toThrow();

    if (fake && (options!.destroyed || options!.contentsDestroyed)) expect(fake.send).not.toHaveBeenCalled();
    expect(formatLogsForClipboard()).toContain("stopping before exit");
  });
});

describe("log retention", () => {
  const emitMany = (count: number, from = 1) => {
    for (let i = from; i < from + count; i++) emitLog("frontend", `line ${i}`);
  };

  it("keeps a 5,000-entry limit", () => {
    expect(MAX_RETAINED_LOG_ENTRIES).toBe(5000);
  });

  it("fewer than 5,000 entries are kept unchanged", () => {
    emitMany(10);
    expect(copiedTexts()).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`));
  });

  it("exactly 5,000 entries are kept unchanged", () => {
    emitMany(5000);
    const texts = copiedTexts();
    expect(texts).toHaveLength(5000);
    expect(texts[0]).toBe("line 1");
    expect(texts[4999]).toBe("line 5000");
  });

  it("beyond the limit the oldest are dropped, order and newest kept", () => {
    emitMany(5003);
    const texts = copiedTexts();
    expect(texts).toHaveLength(5000);
    expect(texts[0]).toBe("line 4");
    expect(texts[4999]).toBe("line 5003");
    expect(texts.every((text, i) => text === `line ${i + 4}`)).toBe(true);
  });

  it("Copy Logs contains only retained entries, with their timestamps and sources", () => {
    emitMany(6000);
    const lines = formatLogsForClipboard().split("\n");
    expect(lines).toHaveLength(5000);
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d \[FRONTEND\] line 1001$/);
    expect(formatLogsForClipboard()).not.toContain("line 1000\n");
  });

  it("Clear Logs empties the buffer, and logging resumes normally", () => {
    emitMany(5500);
    clearLogs();
    expect(formatLogsForClipboard()).toBe("");
    emitMany(2, 9000);
    expect(copiedTexts()).toEqual(["line 9000", "line 9001"]);
  });

  it("main process and window keep exactly the same entries", () => {
    let windowLogs: string[] = [];
    for (let i = 1; i <= 12_345; i++) {
      emitLog("backend", `entry ${i}`);
      windowLogs = appendRetainedLog(windowLogs, `entry ${i}`);
    }
    expect(windowLogs).toHaveLength(5000);
    expect(copiedTexts()).toEqual(windowLogs);
  });
});
