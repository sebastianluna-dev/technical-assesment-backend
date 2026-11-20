import { writeFile } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, FAILURE_THRESHOLD, RESET_MS, type TestApp } from "./helpers/testApp.js";

const MESSAGE = "My card is 4111 1111 1111 1111, SSN 123-45-6789, write to ana+bank@example.mx";
const REDACTED =
  "My card is <REDACTED: CREDIT_CARD>, SSN <REDACTED: SSN>, write to <REDACTED: EMAIL>";
const SENSITIVE = ["4111", "123-45-6789", "ana+bank@example.mx"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(() => t.cleanup());

function post(body: unknown = { userId: "user-1", message: MESSAGE }) {
  return request(t.app).post("/secure-inquiry").send(body as object);
}

function postRaw(body: string, contentType = "application/json") {
  return request(t.app).post("/secure-inquiry").set("Content-Type", contentType).send(body);
}

function failAi(): void {
  t.generateAnswer.mockRejectedValue(new Error(`provider exploded on ${MESSAGE}`));
}

/** No AI call, no audit file, nothing counted by the breaker. */
async function expectNoSideEffects(): Promise<void> {
  expect(t.generateAnswer).not.toHaveBeenCalled();
  expect(await t.readAuditFile()).toBe("");
  expect(t.circuitBreaker.getState()).toBe("closed");
}

function expectNoLeak(text: string): void {
  for (const value of SENSITIVE) {
    expect(text).not.toContain(value);
  }
  expect(text).not.toMatch(/\bat .+:\d+:\d+/); // Stack frame.
  expect(text).not.toContain("node_modules");
  expect(text).not.toContain(t.key.toString("base64"));
}

describe("POST /secure-inquiry: success", () => {
  it("responds 200 with the generated answer", async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ answer: "Generated Answer" });
    expect(response.text).toBe('{"answer":"Generated Answer"}');
  });

  it("sends only the redacted message to the AI", async () => {
    await post();

    expect(t.generateAnswer).toHaveBeenCalledTimes(1);
    expect(t.generateAnswer).toHaveBeenCalledWith(REDACTED);
  });

  it("stores the audit record before responding", async () => {
    const response = await post();
    const records = await t.readAudit();

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.requestId).toMatch(UUID);
    expect(record.requestId).toBe(response.headers["x-request-id"]);
    expect(record.userId).toBe("user-1");
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
    expect(record.outcome).toBe("answered");
    expect(record.redactedMessage).toBe(REDACTED);
    expect(t.encryption.decrypt(record.originalMessage)).toBe(MESSAGE);
  });

  it("keeps sensitive values out of the audit file and the logs", async () => {
    await post();

    expectNoLeak(await t.readAuditFile());
    expectNoLeak(t.loggedText());
  });

  it("stores the original message exactly as sent", async () => {
    const message = "  \tline 1\r\nline 2 ✔ ñ 🔐  \n";
    const response = await post({ userId: " padded id ", message });

    expect(response.status).toBe(200);
    const [record] = await t.readAudit();
    expect(t.encryption.decrypt(record!.originalMessage)).toBe(message);
    expect(record!.redactedMessage).toBe(message);
    expect(record!.userId).toBe(" padded id ");
  });

  it("accepts a charset parameter and any key order", async () => {
    const response = await postRaw(
      JSON.stringify({ message: "hello", userId: "u" }),
      "application/json; charset=utf-8",
    );

    expect(response.status).toBe(200);
  });

  it("gives each request its own id and record", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => post({ userId: `u${i}`, message: "hi" })));

    const records = await t.readAudit();
    expect(new Set(records.map((r) => r.requestId)).size).toBe(20);
    expect(new Set(records.map((r) => r.userId)).size).toBe(20);
  });
});

describe("POST /secure-inquiry: content type and body", () => {
  it.each([
    ["text/plain", "text/plain"],
    ["form encoding", "application/x-www-form-urlencoded"],
    ["a JSON-like type", "application/vnd.api+json"],
    ["text/json", "text/json"],
  ])("rejects %s with 415", async (_label, contentType) => {
    const response = await postRaw(JSON.stringify({ userId: "u", message: MESSAGE }), contentType);

    expect(response.status).toBe(415);
    expect(response.body).toEqual({ error: "Content-Type must be application/json" });
    expectNoLeak(response.text);
    await expectNoSideEffects();
  });

  it("rejects a request with no content type with 415", async () => {
    const response = await request(t.app).post("/secure-inquiry");

    expect(response.status).toBe(415);
    await expectNoSideEffects();
  });

  it.each([
    ["truncated JSON", `{"userId":"u","message":"${MESSAGE}`],
    ["text that is not JSON", `card ${MESSAGE}`],
    ["a JSON string", JSON.stringify(MESSAGE)],
    ["a JSON number", "4111111111111111"],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await postRaw(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Malformed JSON" });
    expectNoLeak(response.text);
    await expectNoSideEffects();
  });

  it("rejects an empty body with 400", async () => {
    const response = await request(t.app)
      .post("/secure-inquiry")
      .set("Content-Type", "application/json");

    expect(response.status).toBe(400);
    await expectNoSideEffects();
  });

  it("rejects a body over 64 KB with 413", async () => {
    const response = await post({ userId: "u", message: MESSAGE, padding: "x".repeat(70_000) });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "Request body too large" });
    expectNoLeak(response.text);
    await expectNoSideEffects();
  });

  it("applies the 64 KB limit to bytes, at the boundary", async () => {
    const wrapper = JSON.stringify({ userId: "u", message: "ok", x: "" });
    const fits = JSON.stringify({ userId: "u", message: "ok", x: "a".repeat(65_536 - wrapper.length) });
    expect(Buffer.byteLength(fits)).toBe(65_536);

    // Under the size limit, so it reaches validation (extra property).
    expect((await postRaw(fits)).status).toBe(400);
    expect((await postRaw(fits.replace('"x":"', '"x":"a'))).status).toBe(413);
  });
});

describe("POST /secure-inquiry: validation", () => {
  it.each([
    ["an array", [{ userId: "u", message: MESSAGE }], ["The body must be a JSON object"]],
    ["an empty object", {}, ["userId is required", "message is required"]],
    ["a missing userId", { message: MESSAGE }, ["userId is required"]],
    ["a missing message", { userId: "u" }, ["message is required"]],
    ["a null message", { userId: "u", message: null }, ["message must be a string"]],
    ["a numeric userId", { userId: 42, message: MESSAGE }, ["userId must be a string"]],
    ["an object message", { userId: "u", message: { text: MESSAGE } }, ["message must be a string"]],
    ["an array message", { userId: "u", message: [MESSAGE] }, ["message must be a string"]],
    ["an empty message", { userId: "u", message: "" }, ["message must not be blank"]],
    ["a whitespace message", { userId: "u", message: " \t\r\n " }, ["message must not be blank"]],
    ["a blank userId", { userId: "   ", message: MESSAGE }, ["userId must not be blank"]],
    [
      "an extra property",
      { userId: "u", message: MESSAGE, "card-4111": true },
      ["Only userId and message are allowed"],
    ],
    [
      "several problems at once",
      { userId: "", message: 7, role: "admin" },
      ["userId must not be blank", "message must be a string", "Only userId and message are allowed"],
    ],
  ])("rejects %s with 400", async (_label, body, details) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid request", details });
    expectNoLeak(response.text);
    await expectNoSideEffects();
  });

  it("rejects a __proto__ property as an extra property", async () => {
    const response = await postRaw(`{"userId":"u","message":"hi","__proto__":{"admin":true}}`);

    expect(response.status).toBe(400);
    expect(response.body.details).toEqual(["Only userId and message are allowed"]);
  });

  it("accepts a userId of 100 characters and rejects 101", async () => {
    expect((await post({ userId: "u".repeat(100), message: "hi" })).status).toBe(200);

    const response = await post({ userId: "u".repeat(101), message: "hi" });
    expect(response.status).toBe(400);
    expect(response.body.details).toEqual(["userId must be at most 100 characters"]);
  });

  it("accepts a message of 10,000 characters and rejects 10,001", async () => {
    expect((await post({ userId: "u", message: "m".repeat(10_000) })).status).toBe(200);

    const response = await post({ userId: "u", message: "m".repeat(10_001) });
    expect(response.status).toBe(400);
    expect(response.body.details).toEqual(["message must be at most 10000 characters"]);
    expect(t.generateAnswer).toHaveBeenCalledTimes(1);
  });

  it("counts characters, not bytes or UTF-16 units", async () => {
    expect((await post({ userId: "ñ".repeat(100), message: "🔐".repeat(10_000) })).status).toBe(200);
    expect((await post({ userId: "u", message: "🔐".repeat(10_001) })).status).toBe(400);
  });
});

describe("POST /secure-inquiry: AI failures and the circuit breaker", () => {
  it("responds 503 Service Busy when the AI fails, and audits it", async () => {
    failAi();
    const response = await post();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ answer: "Service Busy" });
    expect(response.text).toBe('{"answer":"Service Busy"}');
    expectNoLeak(response.text);

    const [record] = await t.readAudit();
    expect(record!.outcome).toBe("ai_failure");
    expect(record!.requestId).toBe(response.headers["x-request-id"]);
    expect(record!.redactedMessage).toBe(REDACTED);
    expect(t.encryption.decrypt(record!.originalMessage)).toBe(MESSAGE);
  });

  it("does not log the AI error's message", async () => {
    failAi();
    await post();

    expect(t.logger.warn).toHaveBeenCalledTimes(1);
    expectNoLeak(t.loggedText());
  });

  it("opens the circuit after the threshold and stops calling the AI", async () => {
    failAi();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await post();
    }
    expect(t.circuitBreaker.getState()).toBe("open");

    const response = await post();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ answer: "Service Busy" });
    expect(t.generateAnswer).toHaveBeenCalledTimes(FAILURE_THRESHOLD);
  });

  it("audits requests answered while the circuit is open", async () => {
    failAi();
    for (let i = 0; i < FAILURE_THRESHOLD + 2; i++) {
      await post();
    }

    const records = await t.readAudit();
    expect(records.map((r) => r.outcome)).toEqual([
      "ai_failure",
      "ai_failure",
      "ai_failure",
      "circuit_open",
      "circuit_open",
    ]);
    expect(t.encryption.decrypt(records[4]!.originalMessage)).toBe(MESSAGE);
  });

  it("recovers after the reset time when the AI works again", async () => {
    failAi();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await post();
    }
    t.generateAnswer.mockResolvedValue("Generated Answer");

    expect((await post()).status).toBe(503); // Still open.
    t.advanceClock(RESET_MS);
    const response = await post();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ answer: "Generated Answer" });
    expect(t.circuitBreaker.getState()).toBe("closed");
  });

  it("does not count invalid requests as failures", async () => {
    failAi();
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await post();
    }

    for (let i = 0; i < 10; i++) {
      expect((await post({ userId: "", message: "" })).status).toBe(400);
      expect((await postRaw("{ broken")).status).toBe(400);
      expect((await postRaw("x", "text/plain")).status).toBe(415);
    }

    expect(t.circuitBreaker.getState()).toBe("closed");
    expect(t.generateAnswer).toHaveBeenCalledTimes(FAILURE_THRESHOLD - 1);
  });
});

describe("POST /secure-inquiry: audit failures", () => {
  async function corruptAuditFile(): Promise<void> {
    await writeFile(t.auditFile, `{ broken ${MESSAGE}`);
  }

  it("responds with a generic 500 when the record cannot be stored", async () => {
    await corruptAuditFile();
    const response = await post();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expectNoLeak(response.text);
    expect(response.text).not.toContain("audit");
  });

  it("does not return the answer when auditing fails", async () => {
    await corruptAuditFile();
    const response = await post();

    expect(t.generateAnswer).toHaveBeenCalledTimes(1);
    expect(response.text).not.toContain("Generated Answer");
  });

  it("responds 500 instead of the fallback when both the AI and the audit fail", async () => {
    await corruptAuditFile();
    failAi();
    const response = await post();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  it("does not count storage failures in the breaker", async () => {
    await corruptAuditFile();

    for (let i = 0; i < FAILURE_THRESHOLD * 3; i++) {
      expect((await post()).status).toBe(500);
    }

    expect(t.circuitBreaker.getState()).toBe("closed");
    expect(t.generateAnswer).toHaveBeenCalledTimes(FAILURE_THRESHOLD * 3);
  });

  it("leaves the corrupted file untouched", async () => {
    await corruptAuditFile();
    const before = await t.readAuditFile();
    await post();

    expect(await t.readAuditFile()).toBe(before);
  });

  it("logs the failure with the request id and no request contents", async () => {
    await corruptAuditFile();
    const response = await post();

    expect(t.logger.error).toHaveBeenCalledTimes(1);
    const [event, fields] = t.logger.error.mock.calls[0]!;
    expect(event).toBe("audit_failed");
    expect(fields).toMatchObject({
      requestId: response.headers["x-request-id"],
      outcome: "answered",
      error: "AuditFileCorruptedError",
      reason: "the content is not valid JSON",
    });
    expectNoLeak(t.loggedText());
  });
});
