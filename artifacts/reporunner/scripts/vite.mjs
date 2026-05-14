import { spawn } from "node:child_process";

const command = process.argv[2] ?? "dev";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const viteArgsByCommand = {
  dev: ["exec", "vite", "--config", "vite.config.ts", "--host", "0.0.0.0"],
  build: ["exec", "vite", "build", "--config", "vite.config.ts"],
  preview: [
    "exec",
    "vite",
    "preview",
    "--config",
    "vite.config.ts",
    "--host",
    "0.0.0.0",
  ],
};

const args = viteArgsByCommand[command];

if (!args) {
  console.error(`Unknown Vite command: ${command}`);
  process.exit(1);
}

const child = spawn(pnpm, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    PORT: process.env.PORT || "5173",
    BASE_PATH: process.env.BASE_PATH || "/",
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});



