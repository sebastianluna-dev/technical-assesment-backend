import type { ErrorRequestHandler, RequestHandler } from "express";
import { AuditFailureError } from "../services/secureInquiry.js";
import type { Logger } from "../utils/logger.js";

/** JSON 404 that does not repeat the requested path. */
export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not Found" });
};

/** Errors raised by the JSON body parser, by their `type`. */
const BODY_ERRORS: Record<string, { status: number; error: string }> = {
  "entity.too.large": { status: 413, error: "Request body too large" },
  "entity.parse.failed": { status: 400, error: "Malformed JSON" },
  "entity.verify.failed": { status: 400, error: "Malformed JSON" },
  "request.size.invalid": { status: 400, error: "Invalid request body" },
  "request.aborted": { status: 400, error: "Invalid request body" },
  "stream.encoding.set": { status: 400, error: "Invalid request body" },
  "charset.unsupported": { status: 415, error: "Unsupported charset" },
  "encoding.unsupported": { status: 415, error: "Unsupported content encoding" },
};

/**
 * Last middleware. Every response it writes is a fixed text: no error
 * message, no stack trace and nothing taken from the request. Without it
 * Express would answer errors with an HTML page that includes the stack.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const type = (error as { type?: unknown } | null)?.type;
    const bodyError = typeof type === "string" ? BODY_ERRORS[type] : undefined;
    if (bodyError) {
      res.status(bodyError.status).json({ error: bodyError.error });
      return;
    }

    if (error instanceof AuditFailureError) {
      // Already logged where it happened, with its request id.
      res.set("X-Request-Id", error.requestId);
    } else {
      // Class name only: an unknown error's message may quote request data.
      logger.error("unhandled_error", {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
    res.status(500).json({ error: "Internal Server Error" });
  };
}
