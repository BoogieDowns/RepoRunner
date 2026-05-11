import { spawn } from "node:child_process";
import net from "node:net";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const port = Number(process.env.PORT || "5173");
const baseEnv = {
  ...process.env,
  NODE_ENV: "development",
  PORT: String(port),
  BASE_PATH: process.env.BASE_PATH || "/",
};

function run(command, args, options = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: baseEnv,
    ...options,
  });
}

function runOnce(command, args) {
  return new Promise((resolve, reject) => {
    const child = run(command, args);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}`),
        );
    });
    child.on("error", reject);
  });
}

function waitForPort(host, timeoutMs = 30000) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host, port });

      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });

      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          reject(
            new Error(`Timed out waiting for Vite on http://${host}:${port}`),
          );
          return;
        }
        setTimeout(tryConnect, 300);
      });
    };

    tryConnect();
  });
}

let viteProcess;
let electronProcess;

function stopChildren() {
  if (electronProcess && !electronProcess.killed) electronProcess.kill();
  if (viteProcess && !viteProcess.killed) viteProcess.kill();
}

process.on("SIGINT", () => {
  stopChildren();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopChildren();
  process.exit(143);
});

try {
  await runOnce(pnpm, ["run", "electron:build-main"]);

  viteProcess = run(pnpm, [
    "exec",
    "vite",
    "--config",
    "vite.config.ts",
    "--host",
    "0.0.0.0",
  ]);
  await waitForPort("127.0.0.1");

  electronProcess = run(pnpm, ["exec", "electron", "."]);
  electronProcess.on("exit", (code) => {
    stopChildren();
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stopChildren();
  process.exit(1);
}
