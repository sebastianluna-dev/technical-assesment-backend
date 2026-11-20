import type { RequestHandler } from "express";

/**
 * Rejects any request whose Content-Type is not application/json before the
 * body is read. Parameters such as `charset=utf-8` are allowed.
 */
export const requireJson: RequestHandler = (req, res, next) => {
  const header = req.headers["content-type"] ?? "";
  const mediaType = header.split(";")[0]?.trim().toLowerCase();

  if (mediaType !== "application/json") {
    res.status(415).json({ error: "Content-Type must be application/json" });
    return;
  }
  next();
};
