import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts, which requires PORT and BASE_PATH and
// configures the renderer build. These tests exercise Electron main-process
// modules in plain Node.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
});
