import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createEncryptionService,
  DecryptionError,
  type EncryptedPayload,
} from "../src/services/encryption.js";

const key = randomBytes(32);
const service = createEncryptionService(key);
const MESSAGE = "Card 4111 1111 1111 1111, SSN 123-45-6789, ana@example.mx — ¡señal! 🔐";

/** Flips one bit of a base64 field and returns it as base64 again. */
function flipBit(base64: string, byteIndex = 0): string {
  const bytes = Buffer.from(base64, "base64");
  bytes[byteIndex] = bytes[byteIndex]! ^ 0x01;
  return bytes.toString("base64");
}

describe("encrypt", () => {
  it("returns base64 ciphertext, a 12-byte IV and a 16-byte tag", () => {
    const payload = service.encrypt(MESSAGE);

    expect(Object.keys(payload).sort()).toEqual(["ciphertext", "iv", "tag"]);
    for (const field of Object.values(payload)) {
      expect(field).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
    expect(Buffer.from(payload.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(payload.tag, "base64")).toHaveLength(16);
    expect(Buffer.from(payload.ciphertext, "base64")).toHaveLength(
      Buffer.byteLength(MESSAGE, "utf8"),
    );
  });

  it("does not contain the plaintext", () => {
    const payload = service.encrypt(MESSAGE);
    const raw = Buffer.from(payload.ciphertext, "base64");

    expect(JSON.stringify(payload)).not.toContain("4111");
    expect(raw.includes(Buffer.from("4111 1111"))).toBe(false);
  });

  it("uses a fresh IV for every encryption", () => {
    const payloads = Array.from({ length: 500 }, () => service.encrypt(MESSAGE));

    expect(new Set(payloads.map((p) => p.iv)).size).toBe(500);
    expect(new Set(payloads.map((p) => p.ciphertext)).size).toBe(500);
  });
});

describe("decrypt", () => {
  it.each([
    ["a message with non-ASCII text", MESSAGE],
    ["an empty string", ""],
    ["a long message", "x".repeat(100_000)],
    ["line breaks", "line 1\r\nline 2\n\ttabbed"],
  ])("recovers %s", (_label, plaintext) => {
    expect(service.decrypt(service.encrypt(plaintext))).toBe(plaintext);
  });

  it("works from a second service created with the same key", () => {
    const other = createEncryptionService(Buffer.from(key));
    expect(other.decrypt(service.encrypt(MESSAGE))).toBe(MESSAGE);
  });

  it("survives a JSON round trip", () => {
    const stored = JSON.stringify(service.encrypt(MESSAGE));
    expect(service.decrypt(JSON.parse(stored) as EncryptedPayload)).toBe(MESSAGE);
  });

  it("is not affected by later changes to the caller's key buffer", () => {
    const mutable = randomBytes(32);
    const own = createEncryptionService(mutable);
    const payload = own.encrypt(MESSAGE);
    mutable.fill(0);

    expect(own.decrypt(payload)).toBe(MESSAGE);
  });
});

describe("tampering", () => {
  it("rejects a modified ciphertext", () => {
    const payload = service.encrypt(MESSAGE);
    const tampered = { ...payload, ciphertext: flipBit(payload.ciphertext, 5) };

    expect(() => service.decrypt(tampered)).toThrow(DecryptionError);
  });

  it("rejects a modified IV", () => {
    const payload = service.encrypt(MESSAGE);

    expect(() => service.decrypt({ ...payload, iv: flipBit(payload.iv) })).toThrow(
      DecryptionError,
    );
  });

  it("rejects a modified tag", () => {
    const payload = service.encrypt(MESSAGE);

    expect(() => service.decrypt({ ...payload, tag: flipBit(payload.tag) })).toThrow(
      DecryptionError,
    );
  });

  it("rejects a truncated ciphertext", () => {
    const payload = service.encrypt(MESSAGE);
    const shorter = Buffer.from(payload.ciphertext, "base64").subarray(0, -1);

    expect(() =>
      service.decrypt({ ...payload, ciphertext: shorter.toString("base64") }),
    ).toThrow(DecryptionError);
  });

  it("rejects a truncated tag instead of accepting a weaker one", () => {
    const payload = service.encrypt(MESSAGE);
    const shortTag = Buffer.from(payload.tag, "base64").subarray(0, 4);

    expect(() =>
      service.decrypt({ ...payload, tag: shortTag.toString("base64") }),
    ).toThrow(/tag must be 16 bytes/);
  });

  it("rejects an IV of the wrong length", () => {
    const payload = service.encrypt(MESSAGE);

    expect(() =>
      service.decrypt({ ...payload, iv: randomBytes(16).toString("base64") }),
    ).toThrow(/iv must be 12 bytes/);
  });

  it("rejects a tag and IV taken from another message", () => {
    const first = service.encrypt(MESSAGE);
    const second = service.encrypt("another message");

    expect(() => service.decrypt({ ...first, tag: second.tag })).toThrow(DecryptionError);
    expect(() => service.decrypt({ ...first, iv: second.iv })).toThrow(DecryptionError);
  });

  it("rejects fields that are not base64", () => {
    const payload = service.encrypt(MESSAGE);

    expect(() => service.decrypt({ ...payload, ciphertext: "not base64!" })).toThrow(
      /ciphertext is not base64/,
    );
    expect(() =>
      service.decrypt({ ...payload, iv: undefined } as unknown as EncryptedPayload),
    ).toThrow(/iv is not base64/);
  });

  it("rejects a different key", () => {
    const other = createEncryptionService(randomBytes(32));

    expect(() => other.decrypt(service.encrypt(MESSAGE))).toThrow(DecryptionError);
  });

  it("keeps plaintext and key out of the error", () => {
    const payload = service.encrypt(MESSAGE);

    try {
      service.decrypt({ ...payload, tag: flipBit(payload.tag) });
      expect.unreachable("decrypt should have thrown");
    } catch (error) {
      const text = `${(error as Error).message} ${(error as Error).stack}`;
      expect(text).not.toContain("4111");
      expect(text).not.toContain(key.toString("base64"));
      expect(text).not.toContain(key.toString("hex"));
    }
  });
});

describe("createEncryptionService", () => {
  it.each([0, 16, 31, 33])("rejects a %i-byte key", (bytes) => {
    expect(() => createEncryptionService(randomBytes(bytes))).toThrow(
      /must be a 32-byte Buffer/,
    );
  });

  it("rejects a key that is not a Buffer", () => {
    expect(() =>
      createEncryptionService(key.toString("base64") as unknown as Buffer),
    ).toThrow(/must be a 32-byte Buffer/);
  });
});
