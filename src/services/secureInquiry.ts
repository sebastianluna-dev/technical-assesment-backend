import { randomUUID } from "node:crypto";
import {
  AuditFileCorruptedError,
  type AuditRepository,
} from "../repositories/auditRepository.js";
import type { Logger } from "../utils/logger.js";
import { CircuitOpenError, type CircuitBreaker } from "./circuitBreaker.js";
import type { EncryptionService } from "./encryption.js";
import type { AiClient } from "./mockAiClient.js";
import { redactMessage } from "./redaction.js";

export const FALLBACK_ANSWER = "Service Busy";

/** Stored in the audit record's `outcome` field. */
export type InquiryOutcome = "answered" | "ai_failure" | "circuit_open";

export interface SecureInquiryResult {
  requestId: string;
  status: 200 | 503;
  answer: string;
}

/**
 * The audit record could not be encrypted or stored. The message is fixed;
 * the underlying error is kept in `cause` and is never sent to the client.
 */
export class AuditFailureError extends Error {
  constructor(
    readonly requestId: string,
    cause: unknown,
  ) {
    super("The audit record could not be stored.", { cause });
    this.name = "AuditFailureError";
  }
}

export interface SecureInquiryDependencies {
  aiClient: AiClient;
  circuitBreaker: CircuitBreaker;
  encryption: EncryptionService;
  auditRepository: AuditRepository;
  logger: Logger;
  /** Replaceable in tests. */
  now?: () => Date;
  generateRequestId?: () => string;
}

export interface SecureInquiryService {
  /** Expects input that already passed validation. */
  handle(input: { userId: string; message: string }): Promise<SecureInquiryResult>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createSecureInquiryService(
  dependencies: SecureInquiryDependencies,
): SecureInquiryService {
  const {
    aiClient,
    circuitBreaker,
    encryption,
    auditRepository,
    logger,
    now = () => new Date(),
    generateRequestId = randomUUID,
  } = dependencies;

  return {
    async handle({ userId, message }) {
      const requestId = generateRequestId();
      const timestamp = now().toISOString();

      // 1. Redact. Only the redacted text leaves this function unencrypted.
      const redactedMessage = redactMessage(message);

      // 2. AI call. Nothing else runs inside the breaker, so only AI
      //    failures and timeouts reach its failure count.
      let outcome: InquiryOutcome;
      let answer: string;
      try {
        answer = await circuitBreaker.execute(() =>
          aiClient.generateAnswer(redactedMessage),
        );
        outcome = "answered";
      } catch (error) {
        outcome = error instanceof CircuitOpenError ? "circuit_open" : "ai_failure";
        answer = FALLBACK_ANSWER;
        logger.warn("ai_unavailable", { requestId, outcome, error: errorName(error) });
      }

      // 3. Audit, for answers and fallbacks alike, before anything is returned.
      try {
        await auditRepository.append({
          requestId,
          userId,
          timestamp,
          outcome,
          originalMessage: encryption.encrypt(message),
          redactedMessage,
        });
      } catch (error) {
        logger.error("audit_failed", {
          requestId,
          outcome,
          error: errorName(error),
          // Safe by construction: describes the file, not its contents.
          reason: error instanceof AuditFileCorruptedError ? error.reason : undefined,
          code: (error as NodeJS.ErrnoException | null)?.code,
        });
        throw new AuditFailureError(requestId, error);
      }

      return { requestId, status: outcome === "answered" ? 200 : 503, answer };
    },
  };
}
