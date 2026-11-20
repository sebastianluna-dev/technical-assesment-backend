import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`Server listening on http://localhost:${env.port} (${env.nodeEnv})`);
});

server.on("error", (error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`${signal} received, closing server`);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
