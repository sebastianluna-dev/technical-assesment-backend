import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditRecord, AuditRepository } from "../src/repositories/auditRepository.js";
import { createCircuitBreaker, type CircuitBreaker } from "../src/services/circuitBreaker.js";
import { createEncryptionService } from "../src/services/encryption.js";
import {
  AuditFailureError,
  createSecureInquiryService,
  type SecureInquiryService,
} from "../src/services/secureInquiry.js";
import type { Logger } from "../src/utils/logger.js";

const ORIGINAL = "Synthetic: card 4111-1111-1111-1111, SSN 123456789, mail test.user+tag@example.com";
const REDACTED =
  "Synthetic: card <REDACTED: CREDIT_CARD>, SSN <REDACTED: SSN>, mail <REDACTED: EMAIL>";
const NOW = "2026-11-20T12:00:00.000Z";

const encryption = createEncryptionService(randomBytes(32));

let events: string[];
let stored: AuditRecord[];
let generateAnswer: ReturnType<typeof vi.fn<(prompt: string) => Promise<string>>>;
let append: ReturnType<typeof vi.fn<AuditRepository["append"]>>;
let logger: {
  warn: ReturnType<typeof vi.fn<Logger["warn"]>>;
  error: ReturnType<typeof vi.fn<Logger["error"]>>;
};
let breaker: CircuitBreaker;
let service: SecureInquiryService;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));

  events = [];
  stored = [];
  generateAnswer = vi.fn(async () => {
    events.push("ai");
    return "Generated Answer";
  });
  append = vi.fn(async (record: AuditRecord) => {
    events.push("audit");
    stored.push(record);
  });
  logger = { warn: vi.fn<Logger["warn"]>(), error: vi.fn<Logger["error"]>() };
  breaker = createCircuitBreaker();

  let id = 0;
  service = createSecureInquiryService({
    aiClient: { generateAnswer },
    circuitBreaker: breaker,
    encryption,
    auditRepository: { append, findAll: async () => stored },
    logger,
    generateRequestId: () => `request-${++id}`,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const handle = (message = ORIGINAL) => service.handle({ userId: "user-1", message });

describe("secure inquiry service: success", () => {
  it("returns the AI answer with status 200", async () => {
    expect(await handle()).toEqual({
      requestId: "request-1",
      status: 200,
      answer: "Generated Answer",
    });
  });

  it("passes only the redacted text to the AI", async () => {
    await handle();

    expect(generateAnswer.mock.calls).toEqual([[REDACTED]]);
  });

  it("calls the AI before auditing", async () => {
    await handle();

    expect(events).toEqual(["ai", "audit"]);
  });

  it("builds the record from the request, the clock and both message forms", async () => {
    await handle();

    expect(stored).toHaveLength(1);
    const record = stored[0]!;
    expect(record).toMatchObject({
      requestId: "request-1",
      userId: "user-1",
      timestamp: NOW,
      outcome: "answered",
      redactedMessage: REDACTED,
    });
    expect(encryption.decrypt(record.originalMessage)).toBe(ORIGINAL);
    expect(JSON.stringify(record)).not.toContain("4111");
    expect(JSON.stringify(record)).not.toContain("test.user+tag@example.com");
  });

  it("uses the time the request arrived, not the time the AI answered", async () => {
    generateAnswer.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("Generated Answer"), 3_000)),
    );
    const pending = handle();
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;

    expect(stored[0]!.timestamp).toBe(NOW);
  });

  it("does not resolve until the audit record is stored", async () => {
    let finishAppend!: () => void;
    append.mockImplementation(
      () => new Promise<void>((resolve) => (finishAppend = resolve)),
    );
    const settled = vi.fn();
    const pending = handle().then(settled);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(append).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();

    finishAppend();
    await pending;
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe("secure inquiry service: AI failures", () => {
  it("returns the fallback and audits an AI error", async () => {
    generateAnswer.mockRejectedValue(new Error(`upstream rejected: ${ORIGINAL}`));

    expect(await handle()).toEqual({
      requestId: "request-1",
      status: 503,
      answer: "Service Busy",
    });
    expect(stored[0]!.outcome).toBe("ai_failure");
    expect(encryption.decrypt(stored[0]!.originalMessage)).toBe(ORIGINAL);
  });

  it("logs the error class but not the error message", async () => {
    generateAnswer.mockRejectedValue(new TypeError(`upstream rejected: ${ORIGINAL}`));
    await handle();

    expect(logger.warn.mock.calls).toEqual([
      ["ai_unavailable", { requestId: "request-1", outcome: "ai_failure", error: "TypeError" }],
    ]);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["an object", { answer: "Generated Answer" }],
    ["a number", 42],
  ])("treats an answer that is %s as an AI failure", async (_label, answer) => {
    generateAnswer.mockResolvedValue(answer as unknown as string);

    expect(await handle()).toMatchObject({ status: 503, answer: "Service Busy" });
    expect(stored[0]!.outcome).toBe("ai_failure");
    expect(logger.warn.mock.calls[0]![1]).toMatchObject({ error: "TypeError" });
  });

  it("counts unusable answers in the breaker", async () => {
    generateAnswer.mockResolvedValue(undefined as unknown as string);
    for (let i = 0; i < 3; i++) {
      await handle();
    }

    expect(breaker.getState()).toBe("open");
  });

  it("returns the fallback after the 5 second timeout", async () => {
    generateAnswer.mockImplementation(() => new Promise(() => undefined));
    const pending = handle();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toMatchObject({ status: 503, answer: "Service Busy" });
    expect(stored[0]!.outcome).toBe("ai_failure");
    expect(logger.warn.mock.calls[0]![1]).toMatchObject({ error: "CircuitTimeoutError" });
  });

  it("opens on the third failure and skips the AI on the fourth request", async () => {
    generateAnswer.mockRejectedValue(new Error("down"));
    for (let i = 0; i < 4; i++) {
      await handle();
    }

    expect(generateAnswer).toHaveBeenCalledTimes(3);
    expect(stored.map((r) => r.outcome)).toEqual([
      "ai_failure",
      "ai_failure",
      "ai_failure",
      "circuit_open",
    ]);
  });

  it("recovers through a single probe after 30 seconds", async () => {
    generateAnswer.mockRejectedValue(new Error("down"));
    for (let i = 0; i < 3; i++) {
      await handle();
    }
    generateAnswer.mockReset();
    generateAnswer.mockResolvedValue("Generated Answer");

    await vi.advanceTimersByTimeAsync(29_999);
    expect((await handle()).status).toBe(503);
    expect(generateAnswer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect((await handle()).status).toBe(200);
    expect(generateAnswer).toHaveBeenCalledTimes(1);
    expect(stored.at(-1)!.timestamp).toBe("2026-11-20T12:00:30.000Z");
  });
});

describe("secure inquiry service: audit failures", () => {
  it("throws AuditFailureError with a fixed message and the cause", async () => {
    const cause = Object.assign(new Error(`disk full while writing ${ORIGINAL}`), {
      code: "ENOSPC",
    });
    append.mockRejectedValue(cause);

    const error = await handle().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuditFailureError);
    expect((error as AuditFailureError).message).toBe("The audit record could not be stored.");
    expect((error as AuditFailureError).requestId).toBe("request-1");
    expect((error as AuditFailureError).cause).toBe(cause);
  });

  it("logs identifiers and the error code, never the cause's message", async () => {
    append.mockRejectedValue(
      Object.assign(new Error(`disk full while writing ${ORIGINAL}`), { code: "ENOSPC" }),
    );
    await handle().catch(() => undefined);

    expect(logger.error.mock.calls).toEqual([
      [
        "audit_failed",
        {
          requestId: "request-1",
          outcome: "answered",
          error: "Error",
          reason: undefined,
          code: "ENOSPC",
        },
      ],
    ]);
  });

  it("fails when encryption fails, without storing anything", async () => {
    const failing = createSecureInquiryService({
      aiClient: { generateAnswer },
      circuitBreaker: breaker,
      encryption: {
        encrypt: () => {
          throw new Error("cipher unavailable");
        },
        decrypt: () => "",
      },
      auditRepository: { append, findAll: async () => [] },
      logger,
    });

    await expect(failing.handle({ userId: "u", message: ORIGINAL })).rejects.toBeInstanceOf(
      AuditFailureError,
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("does not count audit failures in the breaker", async () => {
    append.mockRejectedValue(new Error("disk full"));
    for (let i = 0; i < 10; i++) {
      await handle().catch(() => undefined);
    }

    expect(breaker.getState()).toBe("closed");
    expect(generateAnswer).toHaveBeenCalledTimes(10);
  });

  it("still fails with AuditFailureError when the AI also failed", async () => {
    generateAnswer.mockRejectedValue(new Error("down"));
    append.mockRejectedValue(new Error("disk full"));

    await expect(handle()).rejects.toBeInstanceOf(AuditFailureError);
    expect(logger.error.mock.calls[0]![1]).toMatchObject({ outcome: "ai_failure" });
  });
});
