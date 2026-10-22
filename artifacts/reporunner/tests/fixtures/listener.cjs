// Test fixture: listens on 127.0.0.1:<port> until terminated.
require("net").createServer((socket) => socket.on("error", () => {})).listen(Number(process.argv[2]), "127.0.0.1");

// Safety net: never outlive a test run, even if cleanup is skipped.
setTimeout(() => process.exit(0), 60000).unref();
