// The window's log list (Dashboard) uses appendRetainedLog for every line.
import { describe, expect, it } from "vitest";
import { MAX_RETAINED_LOG_ENTRIES, appendRetainedLog } from "../../src/types";

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("appendRetainedLog", () => {
  it("appends without modifying the previous list (safe for React state)", () => {
    const before = [1, 2];
    const after = appendRetainedLog(before, 3);
    expect(after).toEqual([1, 2, 3]);
    expect(before).toEqual([1, 2]);
    expect(after).not.toBe(before);
  });

  it("below and at the limit nothing is dropped", () => {
    let list: number[] = [];
    for (const n of range(1, MAX_RETAINED_LOG_ENTRIES)) list = appendRetainedLog(list, n);
    expect(list).toEqual(range(1, 5000));
  });

  it("past the limit the oldest are dropped and order is kept", () => {
    let list: number[] = [];
    for (const n of range(1, 5003)) list = appendRetainedLog(list, n);
    expect(list).toHaveLength(5000);
    expect(list[0]).toBe(4);
    expect(list[4999]).toBe(5003);
  });

  it("a list already over the limit is trimmed back to it", () => {
    const oversized = range(1, 7000);
    const list = appendRetainedLog(oversized, 7001);
    expect(list).toEqual(range(2002, 7001));
  });

  it("keeps entries intact (same objects, same fields)", () => {
    const entry = { id: "x", timestamp: 1_700_000_000_000, source: "frontend", text: "ready" };
    const list = appendRetainedLog([], entry);
    expect(list[0]).toBe(entry);
  });

  it("honours a custom limit", () => {
    expect(appendRetainedLog([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });
});
