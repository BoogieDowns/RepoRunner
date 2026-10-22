// Test fixture: an unrelated "browser-like" client that holds a connection to
// 127.0.0.1:<port> (so the port appears in its netstat foreign address) and
// stays alive even if the server goes away.
const socket = require("net").connect(Number(process.argv[2]), "127.0.0.1", () => {
  process.stdout.write("connected\n");
});
socket.on("error", () => {});
setInterval(() => {}, 1000);

// Safety net: never outlive a test run, even if cleanup is skipped.
setTimeout(() => process.exit(0), 60000).unref();
