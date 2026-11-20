import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const key = randomBytes(32);
const ENCRYPTION_KEY = key.toString("base64");

describe("loadEnv", () => {
  it("falls back to defaults for optional values", () => {
    expect(loadEnv({ ENCRYPTION_KEY })).toEqual({
      nodeEnv: "development",
      port: 3000,
      encryptionKey: key,
      auditLogPath: "data/audit-log.json",
    });
  });

  it("reads NODE_ENV, PORT and AUDIT_LOG_PATH", () => {
    const env = loadEnv({
      ENCRYPTION_KEY,
      NODE_ENV: "production",
      PORT: "8080",
      AUDIT_LOG_PATH: "/var/lib/app/audit.json",
    });

    expect(env.nodeEnv).toBe("production");
    expect(env.port).toBe(8080);
    expect(env.auditLogPath).toBe("/var/lib/app/audit.json");
  });

  it("rejects a PORT that is not a valid port number", () => {
    expect(() => loadEnv({ ENCRYPTION_KEY, PORT: "abc" })).toThrow(/Invalid PORT/);
    expect(() => loadEnv({ ENCRYPTION_KEY, PORT: "70000" })).toThrow(/Invalid PORT/);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadEnv({ ENCRYPTION_KEY, NODE_ENV: "staging" })).toThrow(
      /Invalid NODE_ENV/,
    );
  });
});

describe("loadEnv: ENCRYPTION_KEY", () => {
  it("decodes a base64 32-byte key", () => {
    expect(loadEnv({ ENCRYPTION_KEY }).encryptionKey.equals(key)).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(
      loadEnv({ ENCRYPTION_KEY: ` ${ENCRYPTION_KEY}\n` }).encryptionKey.equals(key),
    ).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("rejects a %s key", (_label, value) => {
    expect(() => loadEnv({ ENCRYPTION_KEY: value })).toThrow(/Missing ENCRYPTION_KEY/);
  });

  it.each([
    ["not base64", "this is not base64!!"],
    ["base64url alphabet", randomBytes(32).fill(0xfb).toString("base64url")],
    ["missing padding", ENCRYPTION_KEY.replace(/=+$/, "")],
    ["hex", randomBytes(32).toString("hex") + "zz"],
  ])("rejects a key that is %s", (_label, value) => {
    expect(() => loadEnv({ ENCRYPTION_KEY: value })).toThrow(/not valid base64/);
  });

  it.each([16, 24, 31, 33, 64])("rejects a %i-byte key", (bytes) => {
    const value = randomBytes(bytes).toString("base64");
    expect(() => loadEnv({ ENCRYPTION_KEY: value })).toThrow(
      new RegExp(`decodes to ${bytes} bytes, expected 32`),
    );
  });

  it("never includes the key in the error message", () => {
    const wrongLength = randomBytes(31).toString("base64");
    const notBase64 = "s3cret-value-that-is-not-base64!";

    for (const value of [wrongLength, notBase64]) {
      try {
        loadEnv({ ENCRYPTION_KEY: value });
        expect.unreachable("loadEnv should have thrown");
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(value);
      }
    }
  });
});
