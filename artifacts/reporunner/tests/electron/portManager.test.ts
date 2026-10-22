import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFile: h.execFile, exec: h.exec };
});

import * as portManager from "../../electron/portManager.js";
import {
  findListeningPids,
  netstatRowOwnsPort,
  parseListeningPids,
} from "../../electron/portManager.js";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  h.execFile.mockReset();
  h.exec.mockReset();
});

// Representative `netstat -ano` output from Windows.
const NETSTAT_OUTPUT = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100",
  "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       8080",
  "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       3333",
  "  TCP    127.0.0.1:52344        127.0.0.1:3000         ESTABLISHED     7777",
  "  TCP    127.0.0.1:3000         127.0.0.1:52344        ESTABLISHED     3333",
  "  TCP    127.0.0.1:3000         127.0.0.1:52000        TIME_WAIT       0",
  "  TCP    127.0.0.1:30001        0.0.0.0:0              LISTENING       9999",
  "  TCP    [::]:3000              [::]:0                 LISTENING       3333",
  "  TCP    [::1]:5173             [::]:0                 LISTENING       5173",
  "  UDP    0.0.0.0:3000           *:*                                    6666",
].join("\r\n");

describe("netstatRowOwnsPort", () => {
  it("rejects a port that only matches as a substring (80 vs 8080)", () => {
    expect(
      netstatRowOwnsPort("  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       111", 80),
    ).toBeNull();
    expect(
      netstatRowOwnsPort("  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       111", 808),
    ).toBeNull();
  });

  it("rejects a row where the port is only the foreign endpoint (e.g. a browser tab)", () => {
    expect(
      netstatRowOwnsPort("  TCP    127.0.0.1:52344        127.0.0.1:3000         ESTABLISHED     222", 3000),
    ).toBeNull();
  });

  it("accepts an exact IPv4 listener", () => {
    expect(
      netstatRowOwnsPort("  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       333", 3000),
    ).toBe("333");
  });

  it("accepts an exact IPv6 listener", () => {
    expect(
      netstatRowOwnsPort("  TCP    [::]:3000              [::]:0                 LISTENING       444", 3000),
    ).toBe("444");
  });

  it("recognises listeners on non-English Windows by the wildcard foreign address", () => {
    expect(
      netstatRowOwnsPort("  TCP    0.0.0.0:3000           0.0.0.0:0              ABHÖREN         555", 3000),
    ).toBe("555");
  });

  it("rejects established server-side connections, TIME_WAIT rows and PID 0", () => {
    expect(
      netstatRowOwnsPort("  TCP    127.0.0.1:3000         127.0.0.1:52344        ESTABLISHED     333", 3000),
    ).toBeNull();
    expect(
      netstatRowOwnsPort("  TCP    127.0.0.1:3000         127.0.0.1:52000        TIME_WAIT       0", 3000),
    ).toBeNull();
  });

  it("rejects UDP rows", () => {
    expect(
      netstatRowOwnsPort("  UDP    0.0.0.0:3000           *:*                                    666", 3000),
    ).toBeNull();
  });

  it("rejects headers and blank lines", () => {
    expect(netstatRowOwnsPort("", 3000)).toBeNull();
    expect(
      netstatRowOwnsPort("  Proto  Local Address          Foreign Address        State           PID", 3000),
    ).toBeNull();
  });
});

describe("parseListeningPids", () => {
  it("returns only exact-port TCP listeners, de-duplicated", () => {
    expect(parseListeningPids(NETSTAT_OUTPUT, 3000)).toEqual([3333]);
  });

  it("does not match port 80 against 8080 or other ports", () => {
    expect(parseListeningPids(NETSTAT_OUTPUT, 80)).toEqual([]);
    expect(parseListeningPids(NETSTAT_OUTPUT, 300)).toEqual([]);
  });

  it("finds a loopback IPv6 listener", () => {
    expect(parseListeningPids(NETSTAT_OUTPUT, 5173)).toEqual([5173]);
  });
});

describe("findListeningPids (diagnostic only)", () => {
  it("runs netstat via execFile without a shell or findstr on Windows", async () => {
    setPlatform("win32");
    h.execFile.mockImplementation((_file, _args, _opts, cb) => cb(null, { stdout: NETSTAT_OUTPUT, stderr: "" }));

    await expect(findListeningPids(3000)).resolves.toEqual([3333]);

    expect(h.execFile).toHaveBeenCalledTimes(1);
    const [file, args] = h.execFile.mock.calls[0];
    expect(file).toBe("netstat");
    expect(args).toEqual(["-ano"]);
    expect(h.exec).not.toHaveBeenCalled();
  });

  it("asks lsof only for TCP listeners on POSIX", async () => {
    setPlatform("linux");
    h.execFile.mockImplementation((_file, _args, _opts, cb) => cb(null, { stdout: "4321\n4321\n", stderr: "" }));

    await expect(findListeningPids(3000)).resolves.toEqual([4321]);

    const [file, args] = h.execFile.mock.calls[0];
    expect(file).toBe("lsof");
    expect(args).toEqual(["-nP", "-iTCP:3000", "-sTCP:LISTEN", "-t"]);
  });

  it("returns an empty list when the lookup fails", async () => {
    setPlatform("win32");
    h.execFile.mockImplementation((_file, _args, _opts, cb) => cb(new Error("netstat missing")));

    await expect(findListeningPids(3000)).resolves.toEqual([]);
  });
});

describe("module surface", () => {
  it("no longer exposes a port-based process killer", () => {
    expect(portManager).not.toHaveProperty("killProcessUsingPort");
  });
});
