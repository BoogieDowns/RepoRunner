// Logging must keep working (into the buffer) when the window is closing or
// gone, e.g. while services are stopped during quit.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ windows: [] as unknown[] }));

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => h.windows } }));

import { clearLogs, emitLog, formatLogsForClipboard } from "../../electron/logSink.js";

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
