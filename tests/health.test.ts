import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("GET /health", () => {
  it("responds 200 with a JSON status", async () => {
    const response = await request(createApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("does not expose the framework header", async () => {
    const response = await request(createApp()).get("/health");

    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});
