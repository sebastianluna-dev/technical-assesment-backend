import { describe, expect, it } from "vitest";
import {
  MESSAGE_MAX_LENGTH,
  USER_ID_MAX_LENGTH,
  validateSecureInquiryBody,
} from "../src/middleware/validateSecureInquiry.js";

const valid = { userId: "user-1", message: "hello" };

function errorsOf(body: unknown): string[] {
  const result = validateSecureInquiryBody(body);
  return result.ok ? [] : result.errors;
}

describe("validateSecureInquiryBody", () => {
  it("accepts exactly userId and message", () => {
    expect(validateSecureInquiryBody(valid)).toEqual({ ok: true, value: valid });
  });

  it("returns the values untouched", () => {
    const body = { userId: "  id  ", message: "\n  padded \t message  \r\n" };
    const result = validateSecureInquiryBody(body);

    expect(result).toEqual({ ok: true, value: body });
    expect(body).toEqual({ userId: "  id  ", message: "\n  padded \t message  \r\n" });
  });

  it("returns only the two known fields", () => {
    const result = validateSecureInquiryBody(valid);

    expect(result.ok && Object.keys(result.value)).toEqual(["userId", "message"]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "userId"],
    ["a number", 42],
    ["a boolean", true],
    ["an array", [valid]],
  ])("rejects a body that is %s", (_label, body) => {
    expect(errorsOf(body)).toEqual(["The body must be a JSON object"]);
  });

  it.each([
    ["null", null, "must be a string"],
    ["a number", 123456789, "must be a string"],
    ["a boolean", false, "must be a string"],
    ["an object", { toString: "x" }, "must be a string"],
    ["an array of strings", ["a"], "must be a string"],
    ["an empty string", "", "must not be blank"],
    ["spaces", "    ", "must not be blank"],
    ["tabs and line breaks", "\t\r\n", "must not be blank"],
    ["a non-breaking space", " ", "must not be blank"],
    ["an ideographic space", "　", "must not be blank"],
    ["zero-width characters", "​‌‍⁠﻿", "must not be blank"],
    ["spaces mixed with zero-width characters", " ​ ​ ", "must not be blank"],
    ["a lone high surrogate", "abc\uD800", "must be valid Unicode text"],
    ["a lone low surrogate", "\uDC00abc", "must be valid Unicode text"],
  ])("rejects %s in either field", (_label, value, rule) => {
    expect(errorsOf({ ...valid, userId: value })).toEqual([`userId ${rule}`]);
    expect(errorsOf({ ...valid, message: value })).toEqual([`message ${rule}`]);
  });

  it("accepts visible text that contains zero-width characters", () => {
    expect(validateSecureInquiryBody({ ...valid, message: "a​b" }).ok).toBe(true);
  });

  it("applies the userId limit at the boundary", () => {
    expect(USER_ID_MAX_LENGTH).toBe(100);
    expect(errorsOf({ ...valid, userId: "u".repeat(100) })).toEqual([]);
    expect(errorsOf({ ...valid, userId: "u".repeat(101) })).toEqual([
      "userId must be at most 100 characters",
    ]);
  });

  it("applies the message limit at the boundary", () => {
    expect(MESSAGE_MAX_LENGTH).toBe(10_000);
    expect(errorsOf({ ...valid, message: "m".repeat(10_000) })).toEqual([]);
    expect(errorsOf({ ...valid, message: "m".repeat(10_001) })).toEqual([
      "message must be at most 10000 characters",
    ]);
  });

  it("counts an astral character as one character", () => {
    expect(errorsOf({ userId: "😀".repeat(100), message: "😀".repeat(10_000) })).toEqual([]);
    expect(errorsOf({ ...valid, userId: "😀".repeat(101) })).toHaveLength(1);
  });

  it("rejects unexpected properties without naming them", () => {
    const errors = errorsOf({ ...valid, cardNumber4111: "x", admin: true });

    expect(errors).toEqual(["Only userId and message are allowed"]);
    expect(errors.join()).not.toContain("cardNumber4111");
  });

  it("does not accept inherited fields", () => {
    const body = Object.create({ userId: "inherited", message: "inherited" });

    expect(errorsOf(body)).toEqual(["userId is required", "message is required"]);
  });

  it("reports every problem at once", () => {
    expect(errorsOf({ userId: 1, extra: 1 })).toEqual([
      "userId must be a string",
      "message is required",
      "Only userId and message are allowed",
    ]);
  });

  it("never repeats a submitted value in its errors", () => {
    const secret = "synthetic-secret-4111";
    const bodies = [
      { userId: secret.repeat(10), message: secret.repeat(1000) },
      { userId: [secret], message: { secret } },
      { [secret]: secret },
    ];

    for (const body of bodies) {
      expect(errorsOf(body).join(" ")).not.toContain("4111");
    }
  });
});
