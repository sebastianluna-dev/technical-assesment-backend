import express, { Router } from "express";
import { requireJson } from "../middleware/requireJson.js";
import type { SecureInquiryService } from "../services/secureInquiry.js";
import { validateSecureInquiryBody } from "../validation/secureInquiry.js";

export const BODY_LIMIT = "64kb";

export function createSecureInquiryRouter(service: SecureInquiryService): Router {
  const router = Router();

  router.post(
    "/",
    requireJson,
    express.json({ limit: BODY_LIMIT, type: "application/json" }),
    async (req, res) => {
      const validation = validateSecureInquiryBody(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: "Invalid request", details: validation.errors });
        return;
      }

      // A rejection here goes to the error handler (Express 5).
      const result = await service.handle(validation.value);

      res
        .status(result.status)
        .set("X-Request-Id", result.requestId)
        .json({ answer: result.answer });
    },
  );

  return router;
}
