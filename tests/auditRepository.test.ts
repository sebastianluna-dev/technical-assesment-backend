import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuditFileCorruptedError,
  createAuditRepository,
  type AuditRecord,
} from "../src/repositories/auditRepository.js";
import { createEncryptionService } from "../src/services/encryption.js";
import { redactMessage } from "../src/services/redaction.js";

const key = randomBytes(32);
const encryption = createEncryptionService(key);
const ORIGINAL = "My card is 4111 1111 1111 1111 and my email is ana@example.mx";

let directory: string;
let filePath: string;

function buildRecord(index: number, original = ORIGINAL): AuditRecord {
  return {
    requestId: `req-${index}`,
    userId: `user-${index % 3}`,
    timestamp: new Date(Date.UTC(2026, 10, 20, 12, 0, index)).toISOString(),
    outcome: "redacted",
    originalMessage: encryption.encrypt(original),
    redactedMessage: redactMessage(original),
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "audit-repository-"));
  filePath = path.join(directory, "audit-log.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("audit repository: reading and appending", () => {
  it("returns no records when the file does not exist, without creating it", async () => {
    const repository = createAuditRepository(filePath);

    expect(await repository.findAll()).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("stores a record with every field", async () => {
    const repository = createAuditRepository(filePath);
    const record = buildRecord(1);

    await repository.append(record);

    expect(await repository.findAll()).toEqual([record]);
    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    expect(onDisk).toEqual({ version: 1, records: [record] });
    expect(Object.keys(onDisk.records[0]).sort()).toEqual([
      "originalMessage",
      "outcome",
      "redactedMessage",
      "requestId",
      "timestamp",
      "userId",
    ]);
  });

  it("stores the original encrypted and the redacted message readable", async () => {
    const repository = createAuditRepository(filePath);
    await repository.append(buildRecord(1));

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("4111");
    expect(raw).not.toContain("ana@example.mx");
    expect(raw).toContain(
      "My card is <REDACTED: CREDIT_CARD> and my email is <REDACTED: EMAIL>",
    );

    const [stored] = await repository.findAll();
    expect(encryption.decrypt(stored!.originalMessage)).toBe(ORIGINAL);
  });

  it("detects tampering with a stored encrypted message", async () => {
    const repository = createAuditRepository(filePath);
    await repository.append(buildRecord(1));

    const file = JSON.parse(await readFile(filePath, "utf8"));
    const bytes = Buffer.from(file.records[0].originalMessage.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 0x01;
    file.records[0].originalMessage.ciphertext = bytes.toString("base64");
    await writeFile(filePath, JSON.stringify(file));

    const [stored] = await repository.findAll();
    expect(() => encryption.decrypt(stored!.originalMessage)).toThrow(
      /Decryption failed/,
    );
  });

  it("preserves existing records across repository instances", async () => {
    await createAuditRepository(filePath).append(buildRecord(1));
    await createAuditRepository(filePath).append(buildRecord(2));
    await createAuditRepository(filePath).append(buildRecord(3));

    const records = await createAuditRepository(filePath).findAll();
    expect(records.map((r) => r.requestId)).toEqual(["req-1", "req-2", "req-3"]);
  });

  it("creates missing parent directories", async () => {
    const nested = path.join(directory, "data", "audit", "log.json");
    await createAuditRepository(nested).append(buildRecord(1));

    expect(await createAuditRepository(nested).findAll()).toHaveLength(1);
  });

  it("writes a file only its owner can read", async () => {
    await createAuditRepository(filePath).append(buildRecord(1));

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("does not write fields that are not part of a record", async () => {
    const record = { ...buildRecord(1), rawMessage: ORIGINAL } as AuditRecord;
    await createAuditRepository(filePath).append(record);

    expect(await readFile(filePath, "utf8")).not.toContain("4111");
  });

  it.each([
    ["requestId", { requestId: "" }],
    ["userId", { userId: undefined }],
    ["timestamp", { timestamp: "yesterday" }],
    ["outcome", { outcome: "" }],
    ["redactedMessage", { redactedMessage: 42 }],
    ["originalMessage", { originalMessage: ORIGINAL }],
  ])("rejects a record with an invalid %s and writes nothing", async (field, patch) => {
    const repository = createAuditRepository(filePath);
    const record = { ...buildRecord(1), ...patch } as unknown as AuditRecord;

    const error = await repository.append(record).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain(field);
    expect((error as Error).message).not.toContain("4111");
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("audit repository: concurrent writes", () => {
  it("keeps every record when many appends run at once", async () => {
    const repository = createAuditRepository(filePath);
    const records = Array.from({ length: 100 }, (_, i) => buildRecord(i));

    await Promise.all(records.map((record) => repository.append(record)));

    const stored = await repository.findAll();
    expect(stored).toHaveLength(100);
    expect(stored).toEqual(records); // Same order as the calls.
    for (const record of stored) {
      expect(encryption.decrypt(record.originalMessage)).toBe(ORIGINAL);
    }
  });

  it("keeps every record when separate instances write the same file", async () => {
    const relative = path.relative(process.cwd(), filePath);
    const repositories = [
      createAuditRepository(filePath),
      createAuditRepository(filePath),
      createAuditRepository(relative), // Same file through a different path.
    ];

    await Promise.all(
      Array.from({ length: 90 }, (_, i) => repositories[i % 3]!.append(buildRecord(i))),
    );

    const stored = await repositories[0]!.findAll();
    expect(new Set(stored.map((r) => r.requestId)).size).toBe(90);
  });

  it("keeps earlier records when appends follow existing data", async () => {
    const repository = createAuditRepository(filePath);
    await repository.append(buildRecord(0));

    await Promise.all(
      Array.from({ length: 30 }, (_, i) => repository.append(buildRecord(i + 1))),
    );

    const stored = await repository.findAll();
    expect(stored.map((r) => r.requestId)).toEqual(
      Array.from({ length: 31 }, (_, i) => `req-${i}`),
    );
  });

  it("always leaves complete JSON on disk while writes are in progress", async () => {
    const repository = createAuditRepository(filePath);
    await repository.append(buildRecord(0));

    const writes = Promise.all(
      Array.from({ length: 40 }, (_, i) => repository.append(buildRecord(i + 1))),
    );
    let reads = 0;
    let done = false;
    void writes.then(() => (done = true));
    while (!done) {
      const records = await repository.findAll(); // Throws on a partial file.
      expect(records.length).toBeGreaterThanOrEqual(1);
      reads += 1;
    }
    await writes;

    expect(reads).toBeGreaterThan(0);
    expect(await repository.findAll()).toHaveLength(41);
  });

  it("leaves no temporary files behind", async () => {
    const repository = createAuditRepository(filePath);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => repository.append(buildRecord(i))),
    );

    expect(await readdir(directory)).toEqual(["audit-log.json"]);
  });

  it("continues with later writes after one of them fails", async () => {
    const repository = createAuditRepository(filePath);
    await repository.append(buildRecord(1));
    await writeFile(filePath, "{ broken");

    const failed = repository.append(buildRecord(2));
    await expect(failed).rejects.toBeInstanceOf(AuditFileCorruptedError);

    await rm(filePath);
    await repository.append(buildRecord(3));
    expect((await repository.findAll()).map((r) => r.requestId)).toEqual(["req-3"]);
  });
});

describe("audit repository: corrupted files", () => {
  const validRecord = () => JSON.stringify(buildRecord(1));

  it.each([
    ["truncated JSON", () => '{"version":1,"records":[{"requestId":"req-1"', /not valid JSON/],
    ["an empty file", () => "", /not valid JSON/],
    ["text that is not JSON", () => "not json at all", /not valid JSON/],
    ["a bare array", () => `[${validRecord()}]`, /expected an object/],
    ["an unknown version", () => `{"version":2,"records":[]}`, /expected an object/],
    ["records that is not an array", () => `{"version":1,"records":{}}`, /expected an object/],
    [
      "a record without requestId",
      () => `{"version":1,"records":[${validRecord()},{"userId":"u"}]}`,
      /record at index 1 has a missing or invalid requestId/,
    ],
    [
      "a record whose original message is plain text",
      () =>
        `{"version":1,"records":[${JSON.stringify({ ...buildRecord(1), originalMessage: ORIGINAL })}]}`,
      /record at index 0 has a missing or invalid originalMessage/,
    ],
  ])("reports %s and leaves the file untouched", async (_label, contents, reason) => {
    const before = contents();
    await writeFile(filePath, before);
    const repository = createAuditRepository(filePath);

    const readError = await repository.findAll().catch((e: unknown) => e);
    const writeError = await repository.append(buildRecord(2)).catch((e: unknown) => e);

    for (const error of [readError, writeError]) {
      expect(error).toBeInstanceOf(AuditFileCorruptedError);
      expect((error as AuditFileCorruptedError).filePath).toBe(filePath);
      expect((error as Error).message).toMatch(reason);
      expect((error as Error).message).not.toContain("4111");
    }
    expect(await readFile(filePath, "utf8")).toBe(before);
    expect(await readdir(directory)).toEqual(["audit-log.json"]);
  });
});

describe("audit repository: logging", () => {
  it("writes nothing to the console on success or failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const repository = createAuditRepository(filePath);

    await repository.append(buildRecord(1));
    await repository.findAll();
    await writeFile(filePath, "{ broken");
    await repository.append(buildRecord(2)).catch(() => undefined);
    await repository.findAll().catch(() => undefined);

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
