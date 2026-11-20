# technical-assessment-backend

Backend for the technical assessment: Node.js 24 (LTS), Express 5 and TypeScript, tested with Vitest and Supertest.

## Requirements

- Node.js 24 or later (`.nvmrc` pins the major version)
- npm

## Setup

```sh
npm install
cp .env.example .env   # then set ENCRYPTION_KEY (required)
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ENCRYPTION_KEY` | Yes | none | Base64-encoded 32-byte key for AES-256-GCM. The server exits at startup if it is missing or invalid. |
| `AUDIT_LOG_PATH` | No | `data/audit-log.json` | JSON file that stores audit records. |
| `CIRCUIT_FAILURE_THRESHOLD` | No | `3` | Consecutive AI failures that open the circuit. |
| `CIRCUIT_RESET_MS` | No | `30000` | Time the circuit stays open before a trial call. |
| `MOCK_AI_FAILURE_RATE` | No | `0` | Probability (0 to 1) that the mock AI fails. |
| `PORT` | No | `3000` | HTTP port. |
| `NODE_ENV` | No | `development` | `development`, `test` or `production`. |

Generate a key:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

`.env` and `data/` are ignored by Git. Losing the key makes every stored original message unreadable.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the server with `tsx watch` and restarts on changes |
| `npm run build` | Compiles `src` to `dist` with `tsc` |
| `npm start` | Runs the compiled server from `dist` |
| `npm run typecheck` | Type-checks `src` and `tests` without emitting |
| `npm test` | Runs the test suite once |
| `npm run test:watch` | Runs the tests in watch mode |

## Endpoints

| Method | Path | Response |
| --- | --- | --- |
| GET | `/health` | `200` `{"status":"ok"}` |
| POST | `/secure-inquiry` | `200` `{"answer":"Generated Answer"}`, or `503` `{"answer":"Service Busy"}` when the AI fails or the circuit is open |

### POST /secure-inquiry

```sh
curl -X POST http://localhost:3000/secure-inquiry \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user-1","message":"My card is 4111 1111 1111 1111"}'
```

- The body must be JSON (`Content-Type: application/json`, at most 64 KB) with exactly two strings: `userId` (up to 100 characters) and `message` (up to 10,000). Blank values and text that is not valid Unicode are rejected; values are never trimmed.
- The message is redacted, the redacted text goes to the mock AI through a circuit breaker, and an audit record is stored before the response is sent. The record keeps the original message encrypted and the redacted one as text.
- Errors: `400` invalid body or malformed JSON, `413` body too large, `415` wrong content type, `500` if the audit record cannot be stored. Error bodies never include request contents or stack traces.
- The circuit opens after 3 consecutive AI failures and allows a trial call after 30 seconds. Set `MOCK_AI_FAILURE_RATE=1` to see the `503` path.

## Redaction

`redactMessage(message)` in `src/services/redaction.ts` is a pure function that replaces emails, credit card candidates and SSNs with `<REDACTED: EMAIL>`, `<REDACTED: CREDIT_CARD>` and `<REDACTED: SSN>`. `POST /secure-inquiry` applies it before the AI call. Detection limits and false positives: [docs/REDACTION.md](docs/REDACTION.md).

## Encryption and audit log

- `createEncryptionService(key)` in `src/services/encryption.ts` encrypts with AES-256-GCM: a fresh random 12-byte IV per call and a 16-byte tag, returned with the ciphertext as base64. Decryption fails on any modified field.
- `createAuditRepository(filePath)` in `src/repositories/auditRepository.ts` appends records to a JSON file. The original message is stored encrypted and the redacted message as text. Writes are serialized and replace the file atomically; a corrupted file raises an error and is left untouched.
- Both are used by `POST /secure-inquiry`. Writes from several processes to the same file are not coordinated.

## Tests

`npm test` runs 367 tests in about two seconds. Unit tests that depend on time use fake timers; HTTP tests run `createApp()` through Supertest with injected dependencies and a temporary audit file. All data is synthetic, and no test reads `.env` or writes to `data/`. See decision 45 in [docs/DECISIONS.md](docs/DECISIONS.md).

## Layout

```
src/
  app.ts           createApp(): builds the Express app, does not listen
  server.ts        loads the environment and starts the HTTP server
  config/          environment loading and validation
  routes/          health.ts, secureInquiry.ts
  middleware/      content type check, validation, 404 and error handler
  services/        redaction, encryption, circuit breaker, mock AI, secure inquiry flow
  repositories/    auditRepository.ts: JSON file audit log
  utils/           strict base64 decoding, logger
tests/             Vitest + Supertest tests
docs/DECISIONS.md  implementation decisions
docs/REDACTION.md  redaction rules, limits and false positives
PROMPT_LOG.md      prompts given to the AI assistant and their outcomes
```
