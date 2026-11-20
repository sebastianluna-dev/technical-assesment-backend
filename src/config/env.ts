import { decodeBase64 } from "../utils/base64.js";

export type NodeEnv = "development" | "test" | "production";

export interface Env {
  nodeEnv: NodeEnv;
  port: number;
  /** Raw 32-byte AES-256 key. Never log this value. */
  encryptionKey: Buffer;
  /** Path of the JSON file that stores audit records. */
  auditLogPath: string;
}

const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];
const DEFAULT_PORT = 3000;
const DEFAULT_AUDIT_LOG_PATH = "data/audit-log.json";
export const ENCRYPTION_KEY_BYTES = 32;

/**
 * Error messages here describe the problem without echoing the value, so a
 * mistyped key never ends up in a log.
 */
function parseEncryptionKey(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      `Missing ENCRYPTION_KEY. Expected a base64-encoded ${ENCRYPTION_KEY_BYTES}-byte key.`,
    );
  }

  const key = decodeBase64(value);
  if (key === undefined) {
    throw new Error("Invalid ENCRYPTION_KEY: the value is not valid base64.");
  }
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error(
      `Invalid ENCRYPTION_KEY: it decodes to ${key.length} bytes, expected ${ENCRYPTION_KEY_BYTES}.`,
    );
  }
  return key;
}

/**
 * Reads and validates the environment. Throws on invalid values so a bad
 * configuration stops the process at startup instead of failing later.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? "development";
  if (!NODE_ENVS.includes(nodeEnv as NodeEnv)) {
    throw new Error(
      `Invalid NODE_ENV "${nodeEnv}". Expected one of: ${NODE_ENVS.join(", ")}.`,
    );
  }

  const rawPort = source.PORT;
  const port =
    rawPort === undefined || rawPort === "" ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid PORT "${rawPort}". Expected an integer between 0 and 65535.`,
    );
  }

  const encryptionKey = parseEncryptionKey(source.ENCRYPTION_KEY);

  const auditLogPath = source.AUDIT_LOG_PATH?.trim() || DEFAULT_AUDIT_LOG_PATH;

  return { nodeEnv: nodeEnv as NodeEnv, port, encryptionKey, auditLogPath };
}
