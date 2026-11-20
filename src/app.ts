import express, { type Express } from "express";
import { healthRouter } from "./routes/health.js";

/**
 * Builds the Express application without binding to a port, so tests can
 * exercise it in memory and `server.ts` stays the only place that listens.
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  app.use("/health", healthRouter);

  return app;
}
