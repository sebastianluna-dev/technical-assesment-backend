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

  it.each([
    '"ana garcia"@example.test',
    "o'connor@example.test",
    '"4111 1111 1111 1111"@example.test',
    '"123-45-6789 ana"@example.test',
  ])("redacts %s completely", (email) => {
    expect(redactMessage(email)).toBe(EMAIL);
    expect(redactMessage(`Write to ${email}, please.`)).toBe(`Write to ${EMAIL}, please.`);
    expect(redactMessage(redactMessage(email))).toBe(EMAIL);
  });

  it.each(["josé@example.test", "jose\u0301@example.test", "john@münchen.example"])(
    "redacts %s completely",
    (email) => {
      expect(redactMessage(email)).toBe(EMAIL);
      expect(redactMessage(`Señor: ${email}, gracias.`)).toBe(`Señor: ${EMAIL}, gracias.`);
    },
  );

  it("keeps quote marks that only surround an address", () => {
    expect(redactMessage("'ana@example.test'")).toBe(`'${EMAIL}'`);
    expect(redactMessage('"ana@example.test"')).toBe(`"${EMAIL}"`);
    expect(redactMessage('She said "hello" to ana@example.test')).toBe(
      `She said "hello" to ${EMAIL}`,
    );
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

  it("redacts cards grouped with no-break spaces or written in full-width digits", () => {
    expect(redactMessage("4111\u00A01111\u00A01111\u00A01111")).toBe(CARD);
    expect(redactMessage("Card:\u00A04111\u00A01111 1111-1111.")).toBe(`Card:\u00A0${CARD}.`);
    expect(redactMessage("４１１１ １１１１ １１１１ １１１１")).toBe(CARD);
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

describe("redactMessage: full-width SSNs", () => {
  it("redacts nine full-width digits and the dashed form", () => {
    expect(redactMessage("０００１２３４５６")).toBe(SSN);
    expect(redactMessage("０００-１２-３４５６")).toBe(SSN);
    expect(redactMessage("SSN：０００１２３４５６。")).toBe(`SSN：${SSN}。`);
  });

  it("applies the same digit boundaries to full-width and mixed digits", () => {
    expect(redactMessage("０００１２３４５")).toBe("０００１２３４５");
    expect(redactMessage("０００１２３４５６7")).toBe("０００１２３４５６7");
    expect(redactMessage("1０００１２３４５６")).toBe("1０００１２３４５６");
  });

  it("replaces each value at its own position in a mixed message", () => {
    const message = "a ０００１２３４５６ b josé@example.test c 4111\u00A01111\u00A01111\u00A01111 d 😀 123-45-6789";
    expect(redactMessage(message)).toBe(`a ${SSN} b ${EMAIL} c ${CARD} d 😀 ${SSN}`);
    expect(redactMessage(redactMessage(message))).toBe(redactMessage(message));
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

describe("redactMessage: numeric boundaries", () => {
  const digits = (count: number) => "1234567890".repeat(3).slice(0, count);
  const grouped = (count: number, separator: string) =>
    digits(count).replace(/(\d{4})(?=\d)/g, `$1${separator}`);

  it.each([
    [8, "8 digits"],
    [9, SSN],
    [10, "10 digits"],
    [11, "11 digits"],
    [12, "12 digits"],
    [13, CARD],
    [14, CARD],
    [15, CARD],
    [16, CARD],
    [17, CARD],
    [18, CARD],
    [19, CARD],
    [20, "20 digits"],
    [21, "21 digits"],
  ])("handles a run of %i consecutive digits", (count, expected) => {
    const input = digits(count);
    const output = redactMessage(`id ${input}.`);

    expect(output).toBe(`id ${expected.startsWith("<") ? expected : input}.`);
  });

  it.each([" ", "-"])("applies the 13 to 19 range to digits grouped with %j", (separator) => {
    expect(redactMessage(grouped(12, separator))).toBe(grouped(12, separator));
    expect(redactMessage(grouped(13, separator))).toBe(CARD);
    expect(redactMessage(grouped(19, separator))).toBe(CARD);
  });

  it("does not treat a digit run attached to letters differently", () => {
    expect(redactMessage("ID123456789X")).toBe(`ID${SSN}X`);
    expect(redactMessage("ref4111111111111111ok")).toBe(`ref${CARD}ok`);
  });

  it("requires the exact SSN grouping", () => {
    expect(redactMessage("123-45-6789")).toBe(SSN);
    expect(redactMessage("1234-5-6789")).toBe("1234-5-6789");
    expect(redactMessage("123-456-789")).toBe("123-456-789");
    expect(redactMessage("0123-45-6789")).toBe("0123-45-6789");
    expect(redactMessage("123-45-67890")).toBe("123-45-67890");
  });

  it("separates values joined by punctuation", () => {
    expect(redactMessage("123-45-6789,987-65-4321;123456789/4111111111111111")).toBe(
      `${SSN},${SSN};${SSN}/${CARD}`,
    );
  });

  it("does not treat decimals, dates, times or prices as sensitive", () => {
    const input = "pi 3.14159265, on 2026-11-20 at 10:30:15, $1,234,567.89, v1.2.3, 50%, 192.168.100.200";
    expect(redactMessage(input)).toBe(input);
  });

  it("redacts short numbers that add up to 13 digits when only spaces or hyphens separate them", () => {
    // Known false positive: 8 + 8 + 2 digits read as one 18-digit candidate.
    expect(redactMessage("3.14159265 2026-11-20 10:30")).toBe(`3.${CARD}:30`);
    expect(redactMessage("2024 2025 2026 2027")).toBe(CARD);
  });
});

describe("redactMessage: repeated and mixed matches", () => {
  it("redacts many values of every kind in one message", () => {
    const input = [
      "a@example.com, b+x@example.org; c.d@mail.example.net",
      "4111 1111 1111 1111 | 5500-0000-0000-0004 | 340000000000009",
      "123-45-6789 & 987654321 & 111-22-3333",
      "again a@example.com, 4111 1111 1111 1111, 123-45-6789",
    ].join("\n");

    expect(redactMessage(input)).toBe(
      [
        `${EMAIL}, ${EMAIL}; ${EMAIL}`,
        `${CARD} | ${CARD} | ${CARD}`,
        `${SSN} & ${SSN} & ${SSN}`,
        `again ${EMAIL}, ${CARD}, ${SSN}`,
      ].join("\n"),
    );
  });

  it("merges a card and an SSN separated by one space into a single token", () => {
    // The card candidate absorbs the SSN's first digits, the two overlap and
    // are merged: both values are hidden, under the longer match's label.
    expect(redactMessage("4111 1111 1111 1111 123-45-6789")).toBe(CARD);
    expect(redactMessage("4111 1111 1111 1111, 123-45-6789")).toBe(`${CARD}, ${SSN}`);
  });

  it("redacts a value repeated two hundred times", () => {
    const output = redactMessage("x@example.com 123-45-6789 4111111111111111\n".repeat(200));

    expect(output).toBe(`${EMAIL} ${SSN} ${CARD}\n`.repeat(200));
  });

  it("redacts values with nothing between them and their neighbours", () => {
    expect(redactMessage("[a@example.com][123-45-6789][4111-1111-1111-1111]")).toBe(
      `[${EMAIL}][${SSN}][${CARD}]`,
    );
  });
});

describe("redactMessage: adversarial inputs", () => {
  it("leaves no digit run of nine or more in mixed inputs", () => {
    const inputs = [
      "4111 1111 1111 1111@example.com",
      "123456789 4111111111111111 123456789",
      "123-45-6789-0123-4567 then 123456789@example.com",
      "a@b.co123456789 4111-1111-1111-1111-",
      "-123456789- (4111 1111 1111 1111) <123-45-6789>",
    ];

    for (const input of inputs) {
      expect(redactMessage(input)).not.toMatch(/\d{9}/);
      expect(redactMessage(input)).not.toMatch(/\d{3}-\d{2}-\d{4}/);
    }
  });

  it("does not let user-typed tokens hide real values next to them", () => {
    expect(redactMessage("<REDACTED: SSN>123-45-6789")).toBe(`${SSN}${SSN}`);
    expect(redactMessage("<REDACTED: 123456789>")).toBe(`<REDACTED: ${SSN}>`);
    expect(redactMessage("<REDACTED: EMAIL>@example.com a@example.com")).toBe(
      `${EMAIL}@example.com ${EMAIL}`,
    );
  });

  it("handles emails with unusual but valid shapes", () => {
    expect(redactMessage("a@b.co")).toBe(EMAIL);
    expect(redactMessage("first.last+tag+tag2@sub.sub2.example.travel")).toBe(EMAIL);
    expect(redactMessage("x_y%z-1@xn--80ak6aa92e.com")).toBe(EMAIL);
    expect(redactMessage("mailto:someone@example.com?subject=hi")).toBe(
      `mailto:${EMAIL}?subject=hi`,
    );
  });

  it("handles malformed email-like text without leaking a full address", () => {
    expect(redactMessage("a@b@example.com")).toBe(`a@${EMAIL}`);
    expect(redactMessage("user@@example.com")).toBe("user@@example.com");
    expect(redactMessage("user@example..com")).toBe("user@example..com");
    expect(redactMessage("user@example.com.")).toBe(`${EMAIL}.`);
    expect(redactMessage("user@-example.com")).toBe("user@-example.com");
  });

  it("documents what look-alike characters do not trigger", () => {
    const zeroWidth = "4111​1111​1111​1111";
    const lineBreaks = "4111\n1111\n1111\n1111";

    for (const input of [zeroWidth, lineBreaks, "john＠example.com"]) {
      expect(redactMessage(input)).toBe(input);
    }
  });

  it("is not confused by regex metacharacters or replacement patterns", () => {
    const input = "$& $1 $` $' \\d{9} (?<x>a@example.com) [123-45-6789]+ ^4111111111111111$";

    expect(redactMessage(input)).toBe(
      `$& $1 $\` $' \\d{9} (?<x>${EMAIL}) [${SSN}]+ ^${CARD}$`,
    );
  });

  it("preserves control characters and lone surrogates around matches", () => {
    const input = "\u0000a@example.com\u0007\uD800 123-45-6789\u001F";

    expect(redactMessage(input)).toBe(`\u0000${EMAIL}\u0007\uD800 ${SSN}\u001F`);
  });

  it.each([
    ["letters without @", "a".repeat(100_000)],
    ["dotted labels without @", "a.".repeat(50_000)],
    ["one digit run", "1".repeat(100_000)],
    ["spaced digits", "1 ".repeat(50_000)],
    ["hyphenated digits", "1-".repeat(50_000)],
    ["repeated @", "a@".repeat(50_000)],
    ["unfinished domains", "a@b.".repeat(25_000)],
    ["alternating separators", "1 -".repeat(33_000)],
    ["nine-digit groups", "123456789 ".repeat(10_000)],
  ])("processes 100,000 characters of %s quickly", (_label, input) => {
    const start = performance.now();
    const output = redactMessage(input);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1_000);
    expect(redactMessage(output)).toBe(output);
  });

  it("is idempotent on 5,000 generated inputs", () => {
    const parts = [
      "4111 1111 1111 1111", "123-45-6789", "123456789", "a@b.co", "john+x@example.com",
      "@", "-", " ", ".", "1", "12", "9999", "x", "<REDACTED: SSN>", "<REDACTED: EMAIL>",
      "<REDACTED: CREDIT_CARD>", "com", "4111111111111", "\n", "<", ">", ":",
    ];
    let seed = 20261120;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let i = 0; i < 5_000; i++) {
      let input = "";
      const count = 1 + Math.floor(random() * 8);
      for (let j = 0; j < count; j++) {
        input += parts[Math.floor(random() * parts.length)];
      }
      const once = redactMessage(input);
      if (redactMessage(once) !== once) {
        expect.fail(`not idempotent for ${JSON.stringify(input)}`);
      }
    }
  });
});
