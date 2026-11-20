import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { EncryptedPayload } from "../services/encryption.js";

/**
 * One audited request. The original message is stored only in encrypted
 * form; the redacted message is stored as readable text.
 */
export interface AuditRecord {
  requestId: string;
  userId: string;
  /** ISO 8601 date-time. */
  timestamp: string;
  outcome: string;
  originalMessage: EncryptedPayload;
  redactedMessage: string;
}

export interface AuditRepository {
  /** Adds one record, keeping every record already in the file. */
  append(record: AuditRecord): Promise<void>;
  /** Returns all records in the order they were appended. */
  findAll(): Promise<AuditRecord[]>;
}

/**
 * Thrown when the audit file exists but cannot be trusted. The file is left
 * exactly as it was found. The message names the file and the kind of
 * problem, never the file's contents.
 */
export class AuditFileCorruptedError extends Error {
  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {
    super(`Audit file "${filePath}" is corrupted: ${reason}.`);
    this.name = "AuditFileCorruptedError";
  }
}

const FILE_VERSION = 1;

interface AuditFile {
  version: typeof FILE_VERSION;
  records: AuditRecord[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Returns the name of the first invalid field, or `undefined` if valid. */
function findInvalidField(record: unknown): string | undefined {
  if (!isObject(record)) return "record";
  if (!isNonEmptyString(record.requestId)) return "requestId";
  if (!isNonEmptyString(record.userId)) return "userId";
  if (
    !isNonEmptyString(record.timestamp) ||
    Number.isNaN(Date.parse(record.timestamp))
  ) {
    return "timestamp";
  }
  if (!isNonEmptyString(record.outcome)) return "outcome";
  if (typeof record.redactedMessage !== "string") return "redactedMessage";

  const original = record.originalMessage;
  if (!isObject(original)) return "originalMessage";
  if (typeof original.ciphertext !== "string") return "originalMessage.ciphertext";
  if (!isNonEmptyString(original.iv)) return "originalMessage.iv";
  if (!isNonEmptyString(original.tag)) return "originalMessage.tag";

  return undefined;
}

/** Copies only the known fields, so nothing else can reach the file. */
function toStoredRecord(record: AuditRecord): AuditRecord {
  return {
    requestId: record.requestId,
    userId: record.userId,
    timestamp: record.timestamp,
    outcome: record.outcome,
    originalMessage: {
      ciphertext: record.originalMessage.ciphertext,
      iv: record.originalMessage.iv,
      tag: record.originalMessage.tag,
    },
    redactedMessage: record.redactedMessage,
  };
}

async function readRecords(filePath: string): Promise<AuditRecord[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []; // No file yet: nothing has been recorded.
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // The parser's own message can quote file contents, so it is dropped.
    throw new AuditFileCorruptedError(filePath, "the content is not valid JSON");
  }

  if (
    !isObject(parsed) ||
    parsed.version !== FILE_VERSION ||
    !Array.isArray(parsed.records)
  ) {
    throw new AuditFileCorruptedError(
      filePath,
      `expected an object with "version": ${FILE_VERSION} and a "records" array`,
    );
  }

  parsed.records.forEach((record, index) => {
    const field = findInvalidField(record);
    if (field !== undefined) {
      throw new AuditFileCorruptedError(
        filePath,
        `record at index ${index} has a missing or invalid ${field}`,
      );
    }
  });

  return parsed.records as AuditRecord[];
}

/**
 * Writes to a temporary file in the same directory, flushes it to disk and
 * renames it over the target. A reader sees the old file or the new one,
 * never a partial write, and a crash leaves the old file in place.
 */
async function writeAtomically(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * One queue per file, shared by every repository in this process that
 * points at the same path, so read-modify-write cycles never interleave.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueue(filePath: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const result = previous.then(task);

  // The stored tail never rejects: one failed write must not block the next.
  const tail = result.catch(() => undefined);
  writeQueues.set(filePath, tail);
  void tail.then(() => {
    if (writeQueues.get(filePath) === tail) {
      writeQueues.delete(filePath);
    }
  });

  return result;
}

export function createAuditRepository(filePath: string): AuditRepository {
  const resolvedPath = path.resolve(filePath);

  return {
    append(record) {
      const field = findInvalidField(record);
      if (field !== undefined) {
        return Promise.reject(
          new TypeError(`Invalid audit record: missing or invalid ${field}.`),
        );
      }
      const stored = toStoredRecord(record);

      return enqueue(resolvedPath, async () => {
        const records = await readRecords(resolvedPath);
        const file: AuditFile = {
          version: FILE_VERSION,
          records: [...records, stored],
        };
        await writeAtomically(resolvedPath, `${JSON.stringify(file, null, 2)}\n`);
      });
    },

    findAll() {
      return readRecords(resolvedPath);
    },
  };
}
