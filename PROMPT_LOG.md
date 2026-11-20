# Prompt log

Each entry records a prompt exactly as it was given to the AI assistant (Claude Code), what was actually done, and which checks were actually run. Anything not verified is listed as not verified.

Entries are added after each task. Dates are local machine dates.

---

## 1. Project setup and GET /health

**Date:** 2026-11-19

**Prompt (verbatim):**

> Set up a backend-only project called technical-assessment-backend using Node.js LTS, Express, TypeScript and npm. Organize it into src/config, src/routes, src/middleware, src/services, src/repositories, tests and docs. Separate app creation from server startup. Configure development, build, typecheck and testing scripts using Vitest and Supertest. For now, implement only GET /health. Create PROMPT_LOG.md to record the actual prompts I send and their outcomes, and docs/DECISIONS.md for implementation decisions. After each completed step, run the relevant checks, update these documents and create a meaningful commit. Keep secrets and runtime data out of Git, and don’t push until I ask.

**Outcome:**

### Step 1: scaffold and tooling

- Created the folder `technical-assessment-backend` and a new Git repository on branch `main`. No remote was added.
- Wrote `package.json` by hand (ES modules, `engines.node >= 24`) with the scripts `dev`, `build`, `start`, `typecheck`, `test` and `test:watch`.
- Installed versions: Express 5.3.0, TypeScript 7.0.2, tsx 4.23.15, Vitest 5.1.1, Supertest 7.3.2, `@types/node` 24.19.2, `@types/express` 5.0.6, `@types/supertest` 7.2.1. `npm install` reported 0 vulnerabilities. Local Node.js is v24.13.0 and npm is 11.6.2.
- Added `tsconfig.json` (strict, type-check only), `tsconfig.build.json` (emits `src` to `dist`), `vitest.config.ts`, `.nvmrc` (24), `.env.example` and `.gitignore`.
- Created `src/config`, `src/routes`, `src/middleware`, `src/services`, `src/repositories`, `tests` and `docs`. Folders with no code yet hold a `.gitkeep` file.
- No application code exists at the end of this step.

**Checks performed (step 1):**

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed, no errors (only `vitest.config.ts` to check at this point) |
| `npx vitest run --passWithNoTests` | Exit code 0, "No test files found" |
| `git status` before the commit | `node_modules/` not listed; no `.env` file exists |

### Step 2: application, server and GET /health

- `src/app.ts` exports `createApp()`, which builds the Express app and does not listen on a port.
- `src/server.ts` is the only file that starts the server: it loads the environment, calls `createApp()`, listens, and closes the server on `SIGTERM` or `SIGINT`.
- `src/config/env.ts` exports `loadEnv()`, which reads `NODE_ENV` (default `development`) and `PORT` (default `3000`) and throws on invalid values.
- `src/routes/health.ts` implements `GET /health`, which responds `200` with `{"status":"ok"}`. No other route exists; any other path gets Express's default 404.
- Added `tests/health.test.ts` (Supertest against `createApp()`) and `tests/env.test.ts`.
- Added a short `README.md` with the scripts and the folder layout.
- `src/middleware`, `src/services` and `src/repositories` are still empty.

**Checks performed (step 2):**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, no errors |
| `npm test` | 2 test files, 6 tests, all passed |
| `npm run build` | Passed; `dist/` contains `app.js`, `server.js`, `config/`, `routes/` |
| `PORT=3457 node dist/server.js`, then `curl /health` | HTTP 200, body `{"status":"ok"}` |
| `curl /nope` against the built server | HTTP 404 |
| `SIGTERM` to the built server | Logged "closing server" and exited with code 0 |
| `PORT=3458 npm run dev`, then `curl /health` | Body `{"status":"ok"}` |
| `git status` before the commit | `dist/` and `node_modules/` not listed |

**Not checked:**

- No linter or formatter is configured, so none was run.
- `npm start` itself was not run; the built server was started with `node dist/server.js` directly, without the `--env-file-if-exists` flag the script adds.
- Restart-on-change in `npm run dev` was not exercised; the server was only started once and queried.
- No `.env` file was created, so loading values from one was not tested. `tsx` printed ".env not found. Continuing without it."
- Nothing was pushed. The repository has no remote.

---

## 2. Pure `redactMessage` function

**Date:** 2026-11-20

**Prompt (verbatim):**

> Implement a pure redactMessage function that replaces emails with <REDACTED: EMAIL>, credit card candidates with <REDACTED: CREDIT_CARD>, and SSNs with <REDACTED: SSN>. Support email aliases, card numbers containing 13–19 digits with spaces or hyphens, and SSNs written as XXX-XX-XXXX or nine consecutive digits. Redact card-like numbers even when they fail Luhn validation. Resolve overlapping matches before replacing them so an SSN match cannot partially redact a card or email. Preserve surrounding text and punctuation, replace every occurrence and keep repeated sanitization idempotent. Add focused tests and document detection limits and possible false positives

**Outcome:**

### Step 1: function and tests

- Added `src/services/redaction.ts`, which exports `redactMessage(message: string): string`. It has no I/O and no state. It is not connected to any route.
- Detection uses one regular expression per kind. No Luhn check and no SSN range check.
- Candidates of all kinds are found on the original text, overlapping candidates are merged into one span labelled with the kind of the longest candidate, and the text is replaced once.
- Added `tests/redaction.test.ts` with 57 tests: emails (aliases, punctuation, non-matches), cards (13/16/19 digits, spaces, hyphens, mixed, failing Luhn, non-matches), SSNs (both formats, non-matches), overlaps, whole messages and idempotency.
- Removed `src/services/.gitkeep`, since the folder now has a file.
- Added decisions 15 to 20 to `docs/DECISIONS.md`.

### Step 2: limits and false positives

- Added `docs/REDACTION.md` with the rules, the data that is not detected and the harmless data that is redacted. Every example in it was run against the function.
- Added a "Redaction" section to `README.md`.

**Checks performed:**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, no errors |
| `npm test` | 3 test files, 63 tests, all passed (57 new) |
| One-off fuzz script (not committed): 200,000 strings built from cards, SSNs, emails, tokens and separators, checking that redacting twice equals redacting once | 0 failures |
| One-off run of the examples used in `docs/REDACTION.md` | Outputs match the document |
| One-off timing on six 200,000-character worst-case strings | Each under 50 ms on the local machine |
| `npm run build` | Passed |

**Not checked:**

- The fuzz, example and timing scripts are not part of the repository or of `npm test`.
- No linter or formatter is configured, so none was run.
- The function was not tested through HTTP, because no endpoint uses it.
- Nothing was pushed. The repository has no remote.

---

## 3. AES-256-GCM encryption and JSON audit repository

**Date:** 2026-11-20

**Prompt (verbatim):**

> Implement encryption using node:crypto and AES-256-GCM. Load a base64-encoded 32-byte key from runtime configuration and reject missing or invalid keys at startup. Generate a fresh cryptographically random 12-byte IV for every encryption and retain the 16-byte authentication tag. Store ciphertext, IV and tag as base64. Add an audit repository backed by a local JSON file containing requestId, userId, timestamp, outcome, the encrypted original message and the redacted message in plaintext. Serialize concurrent writes and use atomic file replacement. Preserve existing records and report corrupted files instead of silently resetting them. Never log original messages or keys. Test decryption, tampering and concurrent writes.

**Outcome:**

### Step 1: key in runtime configuration

- `loadEnv()` now requires `ENCRYPTION_KEY` (standard padded base64 that decodes to exactly 32 bytes) and returns it as a `Buffer`. It also reads `AUDIT_LOG_PATH` (default `data/audit-log.json`).
- Missing, malformed or wrong-length keys throw. `server.ts` prints `Configuration error: <message>` and exits with code 1 before listening. Messages never contain the key.
- Added `src/utils/base64.ts` with a strict base64 decoder.
- Updated `.env.example` with the two new variables and the command that generates a key.
- Created a local `.env` with a freshly generated key so `npm run dev` and `npm start` work. It is ignored by Git and was not committed.
- Rewrote `tests/env.test.ts` (21 tests): every existing case now passes a key, plus missing, empty, non-base64, base64url, unpadded and wrong-length keys, and a check that error messages do not contain the value.

**Checks performed (step 1):**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, no errors |
| `npm test` | 3 test files, 78 tests, all passed |
| `npm run build` | Passed |
| `ENCRYPTION_KEY= node dist/server.js` | Printed "Configuration error: Missing ENCRYPTION_KEY…", exit code 1 |
| Built server with a 16-byte key | Printed "…decodes to 16 bytes, expected 32", exit code 1 |
| `PORT=3461 npm start` with the local `.env`, then `curl /health` | `{"status":"ok"}` |
| `git check-ignore .env` | `.env` is ignored |

### Step 2: AES-256-GCM service

- Added `src/services/encryption.ts`: `createEncryptionService(key)` returns `encrypt(plaintext)` and `decrypt(payload)`, using `node:crypto` only.
- `encrypt` generates a new 12-byte IV with `randomBytes` on every call and returns `{ ciphertext, iv, tag }` as base64, with the 16-byte GCM tag.
- `decrypt` requires strict base64, a 12-byte IV and a 16-byte tag, and throws `DecryptionError` on any failure. The error carries no plaintext or key.
- The service has no logging calls.
- Added `tests/encryption.test.ts` (25 tests): output format, 500 encryptions with 500 distinct IVs, round trips (non-ASCII, empty, 100,000 characters, through JSON), and tampering with the ciphertext, IV and tag, truncated ciphertext and tag, fields swapped between messages, non-base64 fields, a different key, and invalid key sizes.
- Added decisions 24 to 27.

**Checks performed (step 2):**

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, no errors |
| `npm test` | 4 test files, 103 tests, all passed |
