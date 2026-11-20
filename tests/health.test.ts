import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers/testApp.js";

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(() => t.cleanup());

describe("GET /health", () => {
  it("responds 200 with a JSON status", async () => {
    const response = await request(t.app).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("does not expose the framework header", async () => {
    const response = await request(t.app).get("/health");

    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("unknown routes", () => {
  it("responds with a JSON 404 that does not repeat the path", async () => {
    const response = await request(t.app).get("/secret-path-4111");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not Found" });
    expect(response.text).not.toContain("4111");
  });

  it("does not accept GET on /secure-inquiry", async () => {
    const response = await request(t.app).get("/secure-inquiry");

    expect(response.status).toBe(404);
    expect(t.generateAnswer).not.toHaveBeenCalled();
  });
});
