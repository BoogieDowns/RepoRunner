// Test fixture: a two-level process tree that RepoRunner launches.
// This process spawns a grandchild that listens on the given port, then
// records both PIDs so the test can verify the whole tree was terminated.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const port = process.argv[2];
const pidFile = process.env.RR_TEST_PIDFILE;

const grandchild = spawn(process.execPath, [path.join(__dirname, "listener.cjs"), port], {
  stdio: "ignore",
});

fs.writeFileSync(pidFile, JSON.stringify({ middle: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);

// Safety net: never outlive a test run, even if cleanup is skipped.
setTimeout(() => process.exit(0), 60000).unref();
