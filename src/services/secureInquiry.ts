import { randomUUID } from "node:crypto";
import {
  AuditFileCorruptedError,
  type AuditRepository,
} from "../repositories/auditRepository.js";
import type { Logger } from "../utils/logger.js";
import type { SecureInquiryInput } from "../validation/secureInquiry.js";
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
  handle(input: SecureInquiryInput): Promise<SecureInquiryResult>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Response validation: the answer must be a non-empty string. Anything else
 * is an AI failure like any other, so this throws a standard TypeError
 * instead of a dedicated class: nothing needs to tell the two apart.
 */
function requireUsableAnswer(generated: unknown): string {
  if (typeof generated !== "string" || generated === "") {
    throw new TypeError("The AI client returned an unusable answer.");
  }
  return generated;
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

  /**
   * Asks the AI through the circuit breaker and never throws: any failure
   * becomes the fallback answer. Only the call and the check of its result
   * run inside the breaker, so only AI failures and timeouts are counted.
   */
  async function askAi(
    requestId: string,
    redactedMessage: string,
  ): Promise<{ outcome: InquiryOutcome; answer: string }> {
    try {
      const answer = await circuitBreaker.execute(async () =>
        requireUsableAnswer(await aiClient.generateAnswer(redactedMessage)),
      );
      return { outcome: "answered", answer };
    } catch (error) {
      const outcome = error instanceof CircuitOpenError ? "circuit_open" : "ai_failure";
      logger.warn("ai_unavailable", { requestId, outcome, error: errorName(error) });
      return { outcome, answer: FALLBACK_ANSWER };
    }
  }

  /** Stores the record or throws AuditFailureError. Runs outside the breaker. */
  async function writeAuditRecord(record: {
    requestId: string;
    userId: string;
    timestamp: string;
    outcome: InquiryOutcome;
    message: string;
    redactedMessage: string;
  }): Promise<void> {
    const { message, ...fields } = record;
    try {
      await auditRepository.append({
        ...fields,
        originalMessage: encryption.encrypt(message),
      });
    } catch (error) {
      logger.error("audit_failed", {
        requestId: record.requestId,
        outcome: record.outcome,
        error: errorName(error),
        // Safe by construction: describes the file, not its contents.
        reason: error instanceof AuditFileCorruptedError ? error.reason : undefined,
        code: (error as NodeJS.ErrnoException | null)?.code,
      });
      throw new AuditFailureError(record.requestId, error);
    }
  }

  return {
    async handle({ userId, message }) {
      const requestId = generateRequestId();
      const timestamp = now().toISOString();

      // Only the redacted text leaves this function unencrypted.
      const redactedMessage = redactMessage(message);

      const { outcome, answer } = await askAi(requestId, redactedMessage);

      // Answers and fallbacks are both audited before anything is returned.
      await writeAuditRecord({ requestId, userId, timestamp, outcome, message, redactedMessage });

      return { requestId, status: outcome === "answered" ? 200 : 503, answer };
    },
  };
}
