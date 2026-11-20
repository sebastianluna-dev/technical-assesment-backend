import { createApp } from "./app.js";
import { loadEnv, type Env } from "./config/env.js";

function loadEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (error) {
    // Message only: no stack trace and never the environment itself.
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Configuration error: ${message}`);
    process.exit(1);
  }
}

const env = loadEnvOrExit();
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
