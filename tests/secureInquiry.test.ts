import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditRecord } from "../src/repositories/auditRepository.js";
import { redactMessage } from "../src/services/redaction.js";
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

describe("POST /secure-inquiry: redaction end to end", () => {
  const cases: Array<[string, string, string[]]> = [
    [
      "all three kinds, repeated",
      "Mail a@example.com and b+x@example.org. Cards 4111 1111 1111 1111, 5500-0000-0000-0004. " +
        "SSNs 123-45-6789, 987654321. Again: a@example.com / 4111 1111 1111 1111 / 123-45-6789",
      ["a@example.com", "b+x@example.org", "4111", "5500", "123-45-6789", "987654321"],
    ],
    [
      "overlapping matches",
      "4111 1111 1111 1111@example.com then 123456789 0123 4567 and 123-45-6789@example.com",
      ["4111", "example.com", "123456789", "123-45-6789"],
    ],
    [
      "values at numeric boundaries",
      "13: 4222222222222 19: 6304000000000000000 9: 000000000",
      ["4222222222222", "6304000000000000000", "000000000"],
    ],
    [
      "values wrapped in markup and punctuation",
      '<b>"a@example.com"</b> (123-45-6789); [4111-1111-1111-1111]!',
      ["a@example.com", "123-45-6789", "4111"],
    ],
    [
      "emails with a quoted local part or an apostrophe",
      `Write to "ana garcia"@example.test or o'connor@example.test`,
      ["ana garcia", "garcia", "o'connor", "connor", "example.test"],
    ],
    [
      "multi-line text with non-ASCII characters",
      "Señora Núñez:\n\tcorreo → ana@example.mx ✔\r\nSSN\t123-45-6789 🔐",
      ["ana@example.mx", "123-45-6789"],
    ],
  ];

  it.each(cases)("redacts %s before the AI and the audit text", async (_label, message, secrets) => {
    const response = await post({ userId: "user-1", message });
    const expected = redactMessage(message);

    expect(response.status).toBe(200);
    expect(t.generateAnswer).toHaveBeenCalledTimes(1);
    const prompt = t.generateAnswer.mock.calls[0]![0];
    expect(prompt).toBe(expected);

    const [record] = await t.readAudit();
    expect(record!.redactedMessage).toBe(expected);
    expect(t.encryption.decrypt(record!.originalMessage)).toBe(message);

    const exposed = prompt + response.text + (await t.readAuditFile()) + t.loggedText();
    for (const secret of secrets) {
      expect(exposed).not.toContain(secret);
    }
  });

  it("passes the exact redaction of the full message for the first case", async () => {
    await post({ userId: "user-1", message: cases[0]![1] });

    expect(t.generateAnswer).toHaveBeenCalledWith(
      "Mail <REDACTED: EMAIL> and <REDACTED: EMAIL>. " +
        "Cards <REDACTED: CREDIT_CARD>, <REDACTED: CREDIT_CARD>. " +
        "SSNs <REDACTED: SSN>, <REDACTED: SSN>. " +
        "Again: <REDACTED: EMAIL> / <REDACTED: CREDIT_CARD> / <REDACTED: SSN>",
    );
  });

  it("never passes the userId to the AI", async () => {
    await post({ userId: "synthetic-user-77", message: "hello" });

    expect(JSON.stringify(t.generateAnswer.mock.calls)).not.toContain("synthetic-user-77");
  });

  it("sends a message without sensitive data unchanged", async () => {
    await post({ userId: "u", message: "What are your opening hours?" });

    expect(t.generateAnswer).toHaveBeenCalledWith("What are your opening hours?");
  });

  it("treats tokens typed by the user as plain text", async () => {
    const message = "I saw <REDACTED: SSN> in my statement";
    await post({ userId: "u", message });

    const [record] = await t.readAudit();
    expect(record!.redactedMessage).toBe(message);
    expect(t.encryption.decrypt(record!.originalMessage)).toBe(message);
  });

  it.each([
    ["a maximum-length message", "é".repeat(9_990) + " a@b.co  "],
    ["control characters", "nul\u0000 bell\u0007 esc\u001B 123-45-6789"],
    ["JSON and HTML metacharacters", `{"k":"\\\\"} </script> ' " \\n \\u0041`],
    ["combining marks and emoji sequences", "é 👩‍👩‍👧‍👦 🇲🇽 a@example.com"],
    ["right-to-left text", "مرحبا 123-45-6789 שלום"],
  ])("returns %s unchanged from decryption", async (_label, message) => {
    const response = await post({ userId: "u", message });

    expect(response.status).toBe(200);
    const [record] = await t.readAudit();
    expect(t.encryption.decrypt(record!.originalMessage)).toBe(message);
    expect(record!.redactedMessage).toBe(redactMessage(message));
  });

  it("stores different ciphertexts for the same message", async () => {
    await post();
    await post();

    const [first, second] = await t.readAudit();
    expect(first!.originalMessage.iv).not.toBe(second!.originalMessage.iv);
    expect(first!.originalMessage.ciphertext).not.toBe(second!.originalMessage.ciphertext);
  });

  it("makes tampering with a stored record detectable", async () => {
    await post();
    const [record] = await t.readAudit();

    for (const field of ["ciphertext", "iv", "tag"] as const) {
      const bytes = Buffer.from(record!.originalMessage[field], "base64");
      bytes[0] = bytes[0]! ^ 0xff;
      const tampered = { ...record!.originalMessage, [field]: bytes.toString("base64") };

      expect(() => t.encryption.decrypt(tampered)).toThrow(/Decryption failed/);
    }
  });
});

describe("POST /secure-inquiry: adversarial requests", () => {
  it.each([
    ["a lone surrogate in the message", { userId: "u", message: "abc\uD83D" }, ["message must be valid Unicode text"]],
    ["a lone surrogate in the userId", { userId: "\uDE00", message: "hi" }, ["userId must be valid Unicode text"]],
    ["a message of zero-width characters", { userId: "u", message: "​‍﻿" }, ["message must not be blank"]],
  ])("rejects %s", async (_label, body, details) => {
    // Sent as \uXXXX escapes so the request itself is valid UTF-8.
    const json = JSON.stringify(body).replace(/[\u007f-￿]/g, (c) =>
      `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const response = await postRaw(json);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid request", details });
    await expectNoSideEffects();
  });

  it("rejects deeply nested JSON without a stack trace", async () => {
    const response = await postRaw("[".repeat(30_000) + "]".repeat(30_000));

    expect(response.status).toBe(400);
    expectNoLeak(response.text);
    await expectNoSideEffects();
  });

  it("rejects an object with thousands of properties", async () => {
    const body = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, i]));
    const response = await post({ ...body, userId: "u", message: "hi" });

    expect(response.status).toBe(400);
    expect(response.body.details).toEqual(["Only userId and message are allowed"]);
    await expectNoSideEffects();
  });

  it("does not pollute object prototypes", async () => {
    await postRaw(`{"userId":"u","message":"hi","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  /** Sends bytes as they are; Supertest would otherwise serialize the buffer as JSON. */
  function postGzip(bytes: Buffer) {
    return request(t.app)
      .post("/secure-inquiry")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .serialize((data) => data as string)
      .send(bytes as unknown as string);
  }

  it("rejects a compressed body that inflates past 64 KB", async () => {
    const bomb = gzipSync(JSON.stringify({ userId: "u", message: MESSAGE, pad: "0".repeat(5_000_000) }));
    expect(bomb.length).toBeLessThan(65_536);

    const response = await postGzip(bomb);

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "Request body too large" });
    expectNoLeak(response.text);
    await expectNoSideEffects();
  });

  it("accepts a small compressed body", async () => {
    const response = await postGzip(gzipSync(JSON.stringify({ userId: "u", message: MESSAGE })));

    expect(response.status).toBe(200);
    expect(t.generateAnswer).toHaveBeenCalledWith(REDACTED);
  });

  it("rejects a corrupt compressed body with 400, not 500", async () => {
    const response = await postGzip(Buffer.from(`not gzip ${MESSAGE}`));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid request body" });
    expectNoLeak(response.text);
    expect(t.logger.error).not.toHaveBeenCalled();
    await expectNoSideEffects();
  });

  it("rejects an unsupported charset", async () => {
    const response = await postRaw(JSON.stringify({ userId: "u", message: "hi" }), "application/json; charset=latin1");

    expect(response.status).toBe(415);
    await expectNoSideEffects();
  });

  it("ignores a request id supplied by the client", async () => {
    const response = await post().set("X-Request-Id", "client-chosen-id");

    expect(response.headers["x-request-id"]).toMatch(UUID);
    expect((await t.readAudit())[0]!.requestId).toBe(response.headers["x-request-id"]);
  });

  it("ignores query parameters and never echoes them", async () => {
    const response = await request(t.app)
      .post("/secure-inquiry?userId=evil-4111&message=evil")
      .send({ userId: "u", message: "hi" });

    expect(response.status).toBe(200);
    expect((await t.readAudit())[0]!.userId).toBe("u");
  });

  it.each(["put", "patch", "delete"] as const)("does not accept %s", async (method) => {
    const response = await request(t.app)[method]("/secure-inquiry").send({ userId: "u", message: "hi" });

    expect(response.status).toBe(404);
    await expectNoSideEffects();
  });
});

describe("POST /secure-inquiry: circuit breaker sequence", () => {
  it("opens on the third consecutive failure, not before", async () => {
    failAi();

    await post();
    await post();
    expect(t.circuitBreaker.getState()).toBe("closed");
    await post();
    expect(t.circuitBreaker.getState()).toBe("open");
  });

  it("never invokes the mock on the fourth call", async () => {
    failAi();
    for (let i = 0; i < 3; i++) {
      await post();
    }
    t.generateAnswer.mockClear();

    const fourth = await post();

    expect(fourth.status).toBe(503);
    expect(fourth.body).toEqual({ answer: "Service Busy" });
    expect(t.generateAnswer).not.toHaveBeenCalled();
    expect((await t.readAudit()).at(-1)!.outcome).toBe("circuit_open");
  });

  it("resets the counter after a success", async () => {
    failAi();
    await post();
    await post();
    t.generateAnswer.mockResolvedValueOnce("Generated Answer");
    expect((await post()).status).toBe(200);

    await post();
    await post();
    expect(t.circuitBreaker.getState()).toBe("closed");
    await post();
    expect(t.circuitBreaker.getState()).toBe("open");
    expect(t.generateAnswer).toHaveBeenCalledTimes(6);
  });

  it("permits only one probe when half-open", async () => {
    failAi();
    for (let i = 0; i < 3; i++) {
      await post();
    }
    t.advanceClock(RESET_MS);
    expect(t.circuitBreaker.getState()).toBe("half-open");

    let finishProbe!: (answer: string) => void;
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => (probeStarted = resolve));
    t.generateAnswer.mockReset();
    t.generateAnswer.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishProbe = resolve;
          probeStarted();
        }),
    );

    const probe = post().then((response) => response);
    await started;
    const rejected = await Promise.all([post(), post(), post()]);

    for (const response of rejected) {
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ answer: "Service Busy" });
    }
    expect(t.generateAnswer).toHaveBeenCalledTimes(1);

    finishProbe("Generated Answer");
    const recovered = await probe;
    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual({ answer: "Generated Answer" });
    expect(t.circuitBreaker.getState()).toBe("closed");

    const outcomes = (await t.readAudit()).slice(3).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["answered", "circuit_open", "circuit_open", "circuit_open"]);
  });

  it("opens again when the probe fails", async () => {
    failAi();
    for (let i = 0; i < 3; i++) {
      await post();
    }
    t.advanceClock(RESET_MS);

    expect((await post()).status).toBe(503);
    expect(t.generateAnswer).toHaveBeenCalledTimes(4);
    expect(t.circuitBreaker.getState()).toBe("open");

    t.advanceClock(RESET_MS - 1);
    await post();
    expect(t.generateAnswer).toHaveBeenCalledTimes(4);
  });

  it("returns the fallback when the mock is too slow", async () => {
    await t.cleanup();
    t = await createTestApp({ timeoutMs: 25 });
    t.generateAnswer.mockImplementation(() => new Promise(() => undefined));

    const response = await post();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ answer: "Service Busy" });
    expect((await t.readAudit())[0]!.outcome).toBe("ai_failure");
  });

  it("returns the fallback when the mock answers with something unusable", async () => {
    t.generateAnswer.mockResolvedValue(undefined as unknown as string);

    const response = await post();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ answer: "Service Busy" });
  });
});

describe("POST /secure-inquiry: concurrency", () => {
  it("stores one decryptable record per request for 60 parallel requests", async () => {
    const messages = Array.from(
      { length: 60 },
      (_, i) => `request ${i}: card 4111 1111 1111 ${String(1000 + i)} from user${i}@example.com`,
    );

    const responses = await Promise.all(
      messages.map((message, i) => post({ userId: `user-${i}`, message })),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(60).fill(200));
    const records = await t.readAudit();
    expect(records).toHaveLength(60);
    expect(new Set(records.map((r) => r.requestId)).size).toBe(60);

    const byUser = new Map(records.map((r) => [r.userId, r]));
    messages.forEach((message, i) => {
      const record = byUser.get(`user-${i}`)!;
      expect(t.encryption.decrypt(record.originalMessage)).toBe(message);
      expect(record.redactedMessage).toBe(
        `request ${i}: card <REDACTED: CREDIT_CARD> from <REDACTED: EMAIL>`,
      );
    });
    expectNoLeak(await t.readAuditFile());
  });

  it("audits every request when successes and failures are mixed", async () => {
    t.generateAnswer.mockImplementation(async (prompt) => {
      if (prompt.includes("fail")) {
        throw new Error("down");
      }
      return "Generated Answer";
    });

    // Sequential, so the consecutive-failure count is deterministic.
    const statuses: number[] = [];
    for (const message of ["ok", "fail", "ok", "fail", "fail", "ok"]) {
      statuses.push((await post({ userId: "u", message })).status);
    }

    expect(statuses).toEqual([200, 503, 200, 503, 503, 200]);
    expect((await t.readAudit()).map((r) => r.outcome)).toEqual([
      "answered",
      "ai_failure",
      "answered",
      "ai_failure",
      "ai_failure",
      "answered",
    ]);
  });
});

describe("POST /secure-inquiry: injected storage failures", () => {
  const SECRET_ERROR = `EACCES: permission denied, open '/data/audit.json' while writing ${MESSAGE}`;

  function failingRepository(error: Error) {
    return {
      append: async (_record: AuditRecord): Promise<void> => {
        throw error;
      },
      findAll: async (): Promise<AuditRecord[]> => [],
    };
  }

  async function withRepositoryError(error: Error): Promise<void> {
    await t.cleanup();
    t = await createTestApp({ auditRepository: failingRepository(error) });
  }

  it("responds with the generic 500 whatever the storage error says", async () => {
    await withRepositoryError(Object.assign(new Error(SECRET_ERROR), { code: "EACCES" }));
    const response = await post();

    expect(response.status).toBe(500);
    expect(response.text).toBe('{"error":"Internal Server Error"}');
    expectNoLeak(response.text);
    expect(response.text).not.toContain("EACCES");
    expect(response.text).not.toContain("/data/audit.json");
  });

  it("logs the error code and class, not its message", async () => {
    await withRepositoryError(Object.assign(new Error(SECRET_ERROR), { code: "EACCES" }));
    await post();

    expect(t.logger.error).toHaveBeenCalledTimes(1);
    expect(t.logger.error.mock.calls[0]![1]).toMatchObject({ error: "Error", code: "EACCES" });
    expectNoLeak(t.loggedText());
  });

  it("keeps the breaker closed through repeated storage failures", async () => {
    await withRepositoryError(new Error(SECRET_ERROR));

    for (let i = 0; i < 10; i++) {
      expect((await post()).status).toBe(500);
    }

    expect(t.circuitBreaker.getState()).toBe("closed");
    expect(t.generateAnswer).toHaveBeenCalledTimes(10);
  });

  it("responds 500 when encryption fails", async () => {
    await t.cleanup();
    t = await createTestApp({
      encryption: {
        encrypt: () => {
          throw new Error(`cipher failure for ${MESSAGE}`);
        },
        decrypt: () => "",
      },
    });

    const response = await post();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
    expectNoLeak(response.text);
    expectNoLeak(t.loggedText());
    expect(await t.readAuditFile()).toBe("");
  });

  it("responds 500 when the handler throws something that is not an Error", async () => {
    await t.cleanup();
    t = await createTestApp({
      auditRepository: {
        append: () => Promise.reject(MESSAGE),
        findAll: async () => [],
      },
    });

    const response = await post();

    expect(response.status).toBe(500);
    expectNoLeak(response.text);
    expectNoLeak(t.loggedText());
  });

  it("keeps serving valid requests after a storage failure is repaired", async () => {
    await writeFile(t.auditFile, "{ broken");
    expect((await post()).status).toBe(500);

    await writeFile(t.auditFile, '{"version":1,"records":[]}');
    expect((await post()).status).toBe(200);
    expect(await t.readAudit()).toHaveLength(1);
  });
});
