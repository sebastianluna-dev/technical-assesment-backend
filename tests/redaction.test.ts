import { describe, expect, it } from "vitest";
import { redactMessage } from "../src/services/redaction.js";

const EMAIL = "<REDACTED: EMAIL>";
const CARD = "<REDACTED: CREDIT_CARD>";
const SSN = "<REDACTED: SSN>";

describe("redactMessage: emails", () => {
  it.each([
    "john@example.com",
    "john.doe@example.com",
    "john+billing@example.com",
    "john.doe+tag-1@mail.example.co.uk",
    "JOHN_DOE%sales@EXAMPLE.ORG",
    "j@sub-domain.example.io",
  ])("redacts %s", (email) => {
    expect(redactMessage(email)).toBe(EMAIL);
  });

  it("keeps surrounding text and punctuation", () => {
    expect(redactMessage("Write to john+news@example.com, please.")).toBe(
      `Write to ${EMAIL}, please.`,
    );
    expect(redactMessage("(john@example.com).")).toBe(`(${EMAIL}).`);
    expect(redactMessage("<john@example.com>")).toBe(`<${EMAIL}>`);
  });

  it.each(["john@", "@example.com", "john@localhost", "a @ b.com", "3 @ 5.00"])(
    "leaves %s alone",
    (text) => {
      expect(redactMessage(text)).toBe(text);
    },
  );
});

describe("redactMessage: credit cards", () => {
  it.each([
    ["13 digits", "4222222222222"],
    ["16 digits", "4111111111111111"],
    ["19 digits", "6304000000000000000"],
    ["spaces", "4111 1111 1111 1111"],
    ["hyphens", "4111-1111-1111-1111"],
    ["Amex grouping", "3782 822463 10005"],
    ["mixed separators", "4111 1111-1111 1111"],
    ["fails Luhn", "1234 5678 9012 3456"],
    ["all zeros", "0000000000000000"],
  ])("redacts a candidate with %s", (_label, card) => {
    expect(redactMessage(card)).toBe(CARD);
  });

  it("keeps surrounding text and punctuation", () => {
    expect(redactMessage("Card: 4111-1111-1111-1111.")).toBe(`Card: ${CARD}.`);
    expect(redactMessage("(4111 1111 1111 1111)")).toBe(`(${CARD})`);
  });

  it.each([
    ["12 digits", "123456789012"],
    ["12 digits with separators", "1234 5678 9012"],
    ["20 consecutive digits", "12345678901234567890"],
    ["digits split by double spaces", "4111  1111  1111  1111"],
    ["digits split by dots", "4111.1111.1111.1111"],
  ])("leaves %s alone", (_label, text) => {
    expect(redactMessage(text)).toBe(text);
  });

  it("redacts two cards separated by one space as two cards", () => {
    expect(redactMessage("4111111111111111 5500000000000004")).toBe(
      `${CARD} ${CARD}`,
    );
  });
});

describe("redactMessage: SSNs", () => {
  it("redacts XXX-XX-XXXX", () => {
    expect(redactMessage("SSN 123-45-6789.")).toBe(`SSN ${SSN}.`);
  });

  it("redacts nine consecutive digits", () => {
    expect(redactMessage("SSN: 123456789, thanks")).toBe(`SSN: ${SSN}, thanks`);
  });

  it.each([
    ["eight digits", "12345678"],
    ["ten digits", "1234567890"],
    ["spaces as separators", "123 45 6789"],
    ["wrong grouping", "12-345-6789"],
    ["a formatted SSN attached to more digits", "123-45-67890"],
    ["a US phone number", "555-123-4567"],
  ])("leaves %s alone", (_label, text) => {
    expect(redactMessage(text)).toBe(text);
  });
});

describe("redactMessage: overlapping matches", () => {
  it("treats nine digits inside a card as part of the card", () => {
    expect(redactMessage("123456789 0123 4567")).toBe(CARD);
    expect(redactMessage("4111 123456789 1111")).toBe(CARD);
  });

  it("treats an SSN-shaped prefix of a card as part of the card", () => {
    expect(redactMessage("123-45-6789-0123-4567")).toBe(CARD);
  });

  it("treats an SSN-shaped email local part as part of the email", () => {
    expect(redactMessage("123-45-6789@example.com")).toBe(EMAIL);
    expect(redactMessage("123456789@example.com")).toBe(EMAIL);
  });

  it("treats a card-shaped email local part as part of the email", () => {
    expect(redactMessage("4111111111111111@example.com")).toBe(EMAIL);
    expect(redactMessage("john+4111-1111-1111-1111@example.com")).toBe(EMAIL);
  });

  it("redacts the whole run when a card runs into an email", () => {
    expect(redactMessage("4111 1111 1111 1111@example.com")).toBe(CARD);
  });

  it("never leaves a token nested inside another token", () => {
    const output = redactMessage(
      "123-45-6789-0123-4567 123456789@example.com 4111 1111 1111 1111@x.io",
    );
    expect(output).toBe(`${CARD} ${EMAIL} ${CARD}`);
  });
});

describe("redactMessage: whole messages", () => {
  it("replaces every occurrence of every kind", () => {
    const input =
      "Hi, I'm john@example.com (alt: john+work@example.com). " +
      "Cards: 4111 1111 1111 1111 and 5500-0000-0000-0004; " +
      "SSNs: 123-45-6789 / 987654321.";

    expect(redactMessage(input)).toBe(
      `Hi, I'm ${EMAIL} (alt: ${EMAIL}). ` +
        `Cards: ${CARD} and ${CARD}; ` +
        `SSNs: ${SSN} / ${SSN}.`,
    );
  });

  it("replaces repeated identical values", () => {
    expect(redactMessage("a@b.co a@b.co a@b.co")).toBe(
      `${EMAIL} ${EMAIL} ${EMAIL}`,
    );
  });

  it("preserves line breaks, tabs and non-ASCII text", () => {
    const input = "Señor Núñez:\n\tcorreo → ana@example.mx ✔\r\nSSN\t123-45-6789\n";
    expect(redactMessage(input)).toBe(
      `Señor Núñez:\n\tcorreo → ${EMAIL} ✔\r\nSSN\t${SSN}\n`,
    );
  });

  it("returns text without sensitive data unchanged", () => {
    const input = "Order #12345 ships on 2026-11-20 at 10:30, total $1,234.56.";
    expect(redactMessage(input)).toBe(input);
    expect(redactMessage("")).toBe("");
  });

  it("does not mutate state between calls", () => {
    const input = "john@example.com 123-45-6789";
    expect(redactMessage(input)).toBe(redactMessage(input));
  });
});

describe("redactMessage: idempotency", () => {
  it.each([
    "john@example.com 4111 1111 1111 1111 123-45-6789",
    "4111 1111 1111 1111@example.com",
    "123-45-6789-0123-4567",
    "1234 5678 9012 3456 7890 1234 5678",
    "4111111111111111 5500000000000004 123456789",
    "1234567890123 456789012 x@y.com123456789",
    "9123456789-4111 1111 1111 1111-123456789@a.bc",
    "<REDACTED: EMAIL> <REDACTED: CREDIT_CARD> <REDACTED: SSN>",
    "<REDACTED: SSN>123456789<REDACTED: EMAIL>@example.com",
  ])("redacting twice equals redacting once: %s", (input) => {
    const once = redactMessage(input);
    expect(redactMessage(once)).toBe(once);
  });

  it("leaves existing tokens untouched", () => {
    const tokens = "<REDACTED: EMAIL> <REDACTED: CREDIT_CARD> <REDACTED: SSN>";
    expect(redactMessage(tokens)).toBe(tokens);
  });
});
