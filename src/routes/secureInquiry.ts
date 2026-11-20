import express, { Router } from "express";
import { requireJson } from "../middleware/requireJson.js";
import {
  validateSecureInquiry,
  type SecureInquiryInput,
} from "../middleware/validateSecureInquiry.js";
import type { SecureInquiryService } from "../services/secureInquiry.js";

export const BODY_LIMIT = "64kb";

export function createSecureInquiryRouter(service: SecureInquiryService): Router {
  const router = Router();

  router.post(
    "/",
    requireJson,
    express.json({ limit: BODY_LIMIT, type: "application/json" }),
    validateSecureInquiry,
    async (_req, res) => {
      const inquiry = res.locals.inquiry as SecureInquiryInput;
      // A rejection here goes to the error handler (Express 5).
      const result = await service.handle(inquiry);

      res
        .status(result.status)
        .set("X-Request-Id", result.requestId)
        .json({ answer: result.answer });
    },
  );

  return router;
}
