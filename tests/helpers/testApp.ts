import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { createApp } from "../../src/app.js";
import {
  createAuditRepository,
  type AuditRecord,
} from "../../src/repositories/auditRepository.js";
import { createCircuitBreaker } from "../../src/services/circuitBreaker.js";
import { createEncryptionService } from "../../src/services/encryption.js";
import type { EncryptionService } from "../../src/services/encryption.js";
import type { AiClient } from "../../src/services/mockAiClient.js";
import type { AuditRepository } from "../../src/repositories/auditRepository.js";

export const FAILURE_THRESHOLD = 3;
export const RESET_MS = 1000;

/**
 * A real app on a temporary audit file, with a real breaker on a fake
 * clock, a stubbed AI client and a logger that records instead of printing.
 */
export interface TestAppOverrides {
  /** Replaces the file-backed repository, for example with one that fails. */
  auditRepository?: AuditRepository;
  /** Replaces the real encryption service. */
  encryption?: EncryptionService;
  /** Breaker call timeout in real milliseconds. */
  timeoutMs?: number;
}

export async function createTestApp(overrides: TestAppOverrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "secure-inquiry-"));
  const auditFile = path.join(directory, "audit-log.json");

  const key = randomBytes(32);
  const encryption = createEncryptionService(key);
  const auditRepository = createAuditRepository(auditFile);

  let time = 0;
  const circuitBreaker = createCircuitBreaker({
    failureThreshold: FAILURE_THRESHOLD,
    resetTimeoutMs: RESET_MS,
    timeoutMs: overrides.timeoutMs,
    now: () => time,
  });

  const generateAnswer = vi.fn<AiClient["generateAnswer"]>(async () => "Generated Answer");
  const logger = { warn: vi.fn(), error: vi.fn() };

  const app = createApp({
    aiClient: { generateAnswer },
    circuitBreaker,
    encryption: overrides.encryption ?? encryption,
    auditRepository: overrides.auditRepository ?? auditRepository,
    logger,
  });

  return {
    app,
    key,
    auditFile,
    encryption,
    circuitBreaker,
    generateAnswer,
    logger,
    advanceClock: (ms: number) => (time += ms),
    readAudit: (): Promise<AuditRecord[]> => auditRepository.findAll(),
    readAuditFile: (): Promise<string> => readFile(auditFile, "utf8").catch(() => ""),
    loggedText: (): string =>
      JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
