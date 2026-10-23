// The browser-preview mock follows the desktop analysis contract: passive
// data only, one analysis at a time, cancellable, nothing saved or run.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REPO_ANALYSIS_ERROR_MESSAGES, type RepoScanResult } from "../../src/types";

const storage = new Map<string, string>();
const setItem = vi.fn((key: string, value: string) => void storage.set(key, value));
const removeItem = vi.fn((key: string) => void storage.delete(key));

beforeEach(() => {
  storage.clear();
  setItem.mockClear();
  removeItem.mockClear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem, removeItem });
  vi.resetModules();
});

const load = async () => (await import("../../src/mock/repoRunnerMock")).mockRepoRunnerAPI;

describe("mock analyzeRepo", () => {
  it("returns a complete, passive, serializable result", async () => {
    const api = await load();
    const result = await api.analyzeRepo("/Users/you/projects/my-app");
    expect(result.status).toBe("complete");
    expect(result.partial).toBe(false);
    expect(result.rootName).toBe("my-app");
    expect(result.packages[0].scripts.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("/Users/you");
  });

  it("allows one analysis at a time and supports cancellation", async () => {
    const api = await load();
    const first = api.analyzeRepo("C:\\repo");
    await expect(api.analyzeRepo("C:\\repo")).rejects.toThrow(REPO_ANALYSIS_ERROR_MESSAGES["scan-in-progress"]);
    await api.cancelRepoAnalysis();
    const cancelled: RepoScanResult = await first;
    expect(cancelled).toMatchObject({ status: "cancelled", partial: true });
    await expect(api.analyzeRepo("C:\\repo")).resolves.toMatchObject({ status: "complete" });
    await expect(api.cancelRepoAnalysis()).resolves.toBeUndefined();
  });

  it("rejects invalid paths with the shared fixed message", async () => {
    const api = await load();
    for (const value of ["", 42, null, "x".repeat(5000)]) {
      await expect(api.analyzeRepo(value as never)).rejects.toThrow(REPO_ANALYSIS_ERROR_MESSAGES["invalid-path"]);
    }
  });

  it("saves nothing and starts nothing", async () => {
    const api = await load();
    const statuses = await api.getStatuses();
    await api.analyzeRepo("C:\\repo");
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(await api.getStatuses()).toEqual(statuses);
  });
});
