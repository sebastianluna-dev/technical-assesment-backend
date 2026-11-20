/**
 * Demo of POST /secure-inquiry. Run with `npm run demo`.
 *
 * It starts the real application on a free local port and sends real HTTP
 * requests to it. Everything it uses is synthetic and temporary:
 *   - a random encryption key generated for this run (never read from .env),
 *   - an audit file in a temporary directory, deleted at the end,
 *   - the test card 4111 1111 1111 1111, the SSN 123-45-6789 and
 *     example.com addresses.
 *
 * The only part that differs from `npm start` is the mock AI: here it has a
 * fixed delay and a switch, so the script can make it fail on demand.
 *
 * Options (environment variables):
 *   DEMO_AI_DELAY_MS   simulated AI latency         (default 600)
 *   DEMO_RESET_MS      time the circuit stays open  (default 3000)
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createAuditRepository } from "../src/repositories/auditRepository.js";
import { createCircuitBreaker } from "../src/services/circuitBreaker.js";
import { createEncryptionService } from "../src/services/encryption.js";
import { createMockAiClient } from "../src/services/mockAiClient.js";

const AI_DELAY_MS = Number(process.env.DEMO_AI_DELAY_MS ?? 600);
const RESET_MS = Number(process.env.DEMO_RESET_MS ?? 3000);
const FAILURE_THRESHOLD = 3;

const MESSAGE =
  "Hi, I'm Ana (ana.lopez+billing@example.com). My card 4111 1111 1111 1111 " +
  "was charged twice and my SSN is 123-45-6789.";

// --- Output helpers ---------------------------------------------------------

const problems: string[] = [];

function title(text: string): void {
  console.log(`\n${"=".repeat(72)}\n${text}\n${"=".repeat(72)}`);
}

function check(description: string, passed: boolean): void {
  console.log(`  [${passed ? "ok" : "FAILED"}] ${description}`);
  if (!passed) {
    problems.push(description);
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

// --- The application under demonstration -----------------------------------

const directory = await mkdtemp(path.join(tmpdir(), "secure-inquiry-demo-"));
const auditFile = path.join(directory, "audit-log.json");
const key = randomBytes(32);
const encryption = createEncryptionService(key);

let aiHealthy = true;
let aiCalls = 0;
let lastPrompt = "";
const mock = createMockAiClient({
  delayMs: AI_DELAY_MS,
  failureRate: 0.5,
  random: () => (aiHealthy ? 1 : 0), // Deterministic: 1 succeeds, 0 fails.
});

const circuitBreaker = createCircuitBreaker({
  failureThreshold: FAILURE_THRESHOLD,
  resetTimeoutMs: RESET_MS,
});

const app = createApp({
  aiClient: {
    generateAnswer(prompt) {
      aiCalls += 1;
      lastPrompt = prompt;
      return mock.generateAnswer(prompt);
    },
  },
  circuitBreaker,
  encryption,
  auditRepository: createAuditRepository(auditFile),
  logger: {
    warn: (event, fields) => console.log(`    server log (warn):  ${event} ${JSON.stringify(fields)}`),
    error: (event, fields) => console.log(`    server log (error): ${event} ${JSON.stringify(fields)}`),
  },
});

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

interface Timed {
  label: string;
  status: number;
  body: string;
  ms: number;
  aiCalled: boolean;
}
const timings: Timed[] = [];

async function send(label: string, message = MESSAGE): Promise<Timed> {
  const callsBefore = aiCalls;
  const start = performance.now();
  const response = await fetch(`${baseUrl}/secure-inquiry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "demo-user-1", message }),
  });
  const body = await response.text();
  const result: Timed = {
    label,
    status: response.status,
    body,
    ms: Math.round(performance.now() - start),
    aiCalled: aiCalls > callsBefore,
  };
  timings.push(result);

  console.log(
    `  ${label}\n    -> HTTP ${result.status} ${result.body}   ` +
      `${result.ms} ms   AI called: ${result.aiCalled ? "yes" : "no"}   ` +
      `circuit: ${circuitBreaker.getState()}`,
  );
  return result;
}

async function readAudit(): Promise<Array<Record<string, unknown>>> {
  return (JSON.parse(await readFile(auditFile, "utf8")) as { records: [] }).records;
}

// --- The demo ---------------------------------------------------------------

try {
  console.log(`Server:      ${baseUrl} (in this process, temporary)`);
  console.log(`Audit file:  ${auditFile} (deleted at the end)`);
  console.log(`Mock AI:     ${AI_DELAY_MS} ms per call`);
  console.log(`Breaker:     opens after ${FAILURE_THRESHOLD} consecutive failures, stays open ${RESET_MS} ms`);

  title("1. A successful request: the message is redacted before the AI sees it");
  console.log("  Message sent by the client (synthetic data):");
  console.log(indent(MESSAGE));
  console.log();
  const first = await send("Request 1 (AI healthy)");
  console.log("\n  Text the mock AI received:");
  console.log(indent(lastPrompt));
  console.log();
  check("status is 200 with the generated answer", first.status === 200 && first.body === '{"answer":"Generated Answer"}');
  check("the AI did not receive the email, the card or the SSN", !/example\.com|4111|123-45-6789/.test(lastPrompt));
  check(`the request took about the AI delay (${first.ms} ms >= ${AI_DELAY_MS} ms)`, first.ms >= AI_DELAY_MS);

  title("2. The audit record: original encrypted, redacted text readable");
  const [record] = await readAudit();
  console.log("  Record as stored in the JSON file:");
  console.log(indent(JSON.stringify(record, null, 2)));
  const rawFile = await readFile(auditFile, "utf8");
  const decrypted = encryption.decrypt(record!.originalMessage as never);
  console.log("\n  Decrypted with this run's key:");
  console.log(indent(decrypted));
  console.log();
  check("the file does not contain the email, the card or the SSN", !/example\.com|4111|123-45-6789/.test(rawFile));
  check("the IV is 12 bytes and the tag 16 bytes", (() => {
    const original = record!.originalMessage as { iv: string; tag: string };
    return Buffer.from(original.iv, "base64").length === 12 && Buffer.from(original.tag, "base64").length === 16;
  })());
  check("decrypting returns exactly the message that was sent", decrypted === MESSAGE);

  title(`3. The AI starts failing: ${FAILURE_THRESHOLD} consecutive failures open the circuit`);
  aiHealthy = false;
  const failures: Timed[] = [];
  for (let i = 1; i <= FAILURE_THRESHOLD; i++) {
    failures.push(await send(`Request ${i + 1} (AI failing, failure ${i} of ${FAILURE_THRESHOLD})`));
  }
  console.log();
  check("each one returned 503 Service Busy", failures.every((f) => f.status === 503 && f.body === '{"answer":"Service Busy"}'));
  check("each one called the AI and waited for it", failures.every((f) => f.aiCalled && f.ms >= AI_DELAY_MS));
  check("the circuit is now open", circuitBreaker.getState() === "open");

  title("4. The fourth request since the failures began: answered at once, AI not called");
  const callsBeforeFourth = aiCalls;
  const fourth = await send("Request 5 (fourth since failures began)");
  console.log();
  check("it returned 503 Service Busy", fourth.status === 503 && fourth.body === '{"answer":"Service Busy"}');
  check("the AI was not called", aiCalls === callsBeforeFourth);
  check(`it did not wait for the AI delay (${fourth.ms} ms < ${AI_DELAY_MS} ms)`, fourth.ms < AI_DELAY_MS);

  title("5. Recovery: after the open period one probe request is let through");
  aiHealthy = true;
  console.log(`  The AI is healthy again, but the circuit stays open for ${RESET_MS} ms.`);
  const early = await send("Request 6 (AI healthy, circuit still open)");
  console.log(`\n  Waiting ${RESET_MS} ms for the open period to end...`);
  await new Promise((resolve) => setTimeout(resolve, RESET_MS));
  console.log(`  circuit: ${circuitBreaker.getState()}\n`);
  const probe = await send("Request 7 (probe)");
  const after = await send("Request 8 (normal again)");
  console.log();
  check("before the period ended the request was still rejected without calling the AI", early.status === 503 && !early.aiCalled);
  check("the probe called the AI and returned 200", probe.status === 200 && probe.aiCalled);
  check("the circuit is closed again", circuitBreaker.getState() === "closed" && after.status === 200);

  title("Summary");
  console.log("  Request                                              Status   Time    AI called");
  for (const t of timings) {
    console.log(
      `  ${t.label.padEnd(52)} ${String(t.status).padEnd(8)} ${`${t.ms} ms`.padEnd(7)} ${t.aiCalled ? "yes" : "no"}`,
    );
  }
  const outcomes = (await readAudit()).map((r) => r.outcome).join(", ");
  console.log(`\n  Audit outcomes, one per request: ${outcomes}`);
  check("every request was audited, including the fallbacks", (await readAudit()).length === timings.length);

  console.log(
    problems.length === 0
      ? "\nAll checks passed."
      : `\n${problems.length} check(s) FAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
  );
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}

process.exitCode = problems.length === 0 ? 0 : 1;
