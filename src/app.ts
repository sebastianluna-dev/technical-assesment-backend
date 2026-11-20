import express, { type Express } from "express";
import { createErrorHandler, notFound } from "./middleware/errorHandler.js";
import type { AuditRepository } from "./repositories/auditRepository.js";
import { healthRouter } from "./routes/health.js";
import { createSecureInquiryRouter } from "./routes/secureInquiry.js";
import type { CircuitBreaker } from "./services/circuitBreaker.js";
import type { EncryptionService } from "./services/encryption.js";
import type { AiClient } from "./services/mockAiClient.js";
import { createSecureInquiryService } from "./services/secureInquiry.js";
import { consoleLogger, type Logger } from "./utils/logger.js";

export interface AppDependencies {
  aiClient: AiClient;
  circuitBreaker: CircuitBreaker;
  encryption: EncryptionService;
  auditRepository: AuditRepository;
  logger?: Logger;
}

/**
 * Builds the Express application without binding to a port, so tests can
 * exercise it in memory and `server.ts` stays the only place that listens.
 * Everything with state or I/O is passed in.
 */
export function createApp(dependencies: AppDependencies): Express {
  const { logger = consoleLogger, ...services } = dependencies;
  const app = express();

  app.disable("x-powered-by");

  app.use("/health", healthRouter);
  app.use(
    "/secure-inquiry",
    createSecureInquiryRouter(createSecureInquiryService({ ...services, logger })),
  );

  app.use(notFound);
  app.use(createErrorHandler(logger));

  return app;
}
