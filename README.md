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

## Redaction

`redactMessage(message)` in `src/services/redaction.ts` is a pure function that replaces emails, credit card candidates and SSNs with `<REDACTED: EMAIL>`, `<REDACTED: CREDIT_CARD>` and `<REDACTED: SSN>`. It is not exposed through any endpoint yet. Detection limits and false positives: [docs/REDACTION.md](docs/REDACTION.md).

## Encryption and audit log

- `createEncryptionService(key)` in `src/services/encryption.ts` encrypts with AES-256-GCM: a fresh random 12-byte IV per call and a 16-byte tag, returned with the ciphertext as base64. Decryption fails on any modified field.
- `createAuditRepository(filePath)` in `src/repositories/auditRepository.ts` appends records to a JSON file. The original message is stored encrypted and the redacted message as text. Writes are serialized and replace the file atomically; a corrupted file raises an error and is left untouched.
- Neither is used by an endpoint yet. Writes from several processes to the same file are not coordinated.

## Layout

```
src/
  app.ts           createApp(): builds the Express app, does not listen
  server.ts        loads the environment and starts the HTTP server
  config/          environment loading and validation
  routes/          route definitions
  middleware/      (empty for now)
  services/        redaction.ts, encryption.ts
  repositories/    auditRepository.ts: JSON file audit log
  utils/           strict base64 decoding
tests/             Vitest + Supertest tests
docs/DECISIONS.md  implementation decisions
docs/REDACTION.md  redaction rules, limits and false positives
PROMPT_LOG.md      prompts given to the AI assistant and their outcomes
```
