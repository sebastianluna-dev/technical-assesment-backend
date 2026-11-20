import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { decodeBase64 } from "../utils/base64.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Output of one encryption. Every field is base64. */
export interface EncryptedPayload {
  ciphertext: string;
  /** 12 random bytes, unique per encryption. */
  iv: string;
  /** 16-byte GCM authentication tag. */
  tag: string;
}

/**
 * Thrown when a payload cannot be decrypted: malformed fields, modified
 * data or the wrong key. The message never contains payload or key material.
 */
export class DecryptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DecryptionError";
  }
}

export interface EncryptionService {
  encrypt(plaintext: string): EncryptedPayload;
  decrypt(payload: EncryptedPayload): string;
}

function decodeField(name: string, value: unknown, expectedBytes?: number): Buffer {
  const decoded = typeof value === "string" ? decodeBase64(value) : undefined;
  if (decoded === undefined) {
    throw new DecryptionError(`Invalid encrypted payload: ${name} is not base64.`);
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new DecryptionError(
      `Invalid encrypted payload: ${name} must be ${expectedBytes} bytes.`,
    );
  }
  return decoded;
}

/**
 * AES-256-GCM encryption bound to one key. The service neither logs nor
 * exposes the key or any plaintext.
 */
export function createEncryptionService(key: Buffer): EncryptionService {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be a ${KEY_BYTES}-byte Buffer.`);
  }
  // Private copy: later changes to the caller's buffer do not affect it.
  const secret = Buffer.from(key);

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, secret, iv, {
        authTagLength: TAG_BYTES,
      });
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);

      return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    },

    decrypt(payload) {
      const iv = decodeField("iv", payload?.iv, IV_BYTES);
      // Fixed tag length: a truncated tag is rejected, not accepted as weaker.
      const tag = decodeField("tag", payload?.tag, TAG_BYTES);
      const ciphertext = decodeField("ciphertext", payload?.ciphertext);

      try {
        const decipher = createDecipheriv(ALGORITHM, secret, iv, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch (cause) {
        throw new DecryptionError(
          "Decryption failed: the data was modified or the key is wrong.",
          { cause },
        );
      }
    },
  };
}
