# Implementation decisions

Each decision states what was chosen and why. New decisions are appended; a changed decision is edited in place with a note.

## 1. Node.js 24 as the LTS target

Node.js 24 is the current Active LTS line. `.nvmrc` pins the major version and `package.json` declares `engines.node >= 24`.

## 2. ES modules with `NodeNext` resolution

`"type": "module"` with TypeScript `module: NodeNext`. Relative imports carry the `.js` extension, so the compiled output runs on Node.js without a bundler or path rewriting.

## 3. Express 5

Express 5 is the current major version. It forwards rejected promises from async handlers to the error middleware, which removes the need for a wrapper library later.

## 4. Two TypeScript configs

`tsconfig.json` covers `src`, `tests` and the Vitest config and never emits; `npm run typecheck` uses it. `tsconfig.build.json` extends it, includes only `src` and emits to `dist`, so tests never reach the build output.

## 5. `tsx` for development, `tsc` for the build

`npm run dev` runs `tsx watch`, which restarts on file changes without a compile step. `npm run build` uses plain `tsc`, so the production artifact is ordinary JavaScript and `npm start` needs no dev dependency.

## 6. Environment variables without `dotenv`

The `dev` and `start` scripts pass `--env-file-if-exists=.env`, a built-in Node.js flag, so no extra dependency loads the file. `.env.example` documents the variables and is the only env file tracked by Git.

## 7. What Git ignores

`.gitignore` excludes `node_modules/`, build output (`dist/`), coverage, every `.env*` file except `.env.example`, key files (`*.pem`, `*.key`) and runtime data (`data/`, `logs/`, `uploads/`, `tmp/`, `*.log`, SQLite and `*.db` files). The runtime-data entries are there ahead of need: nothing writes such files yet.

## 8. Empty layers are kept as folders only

`src/middleware`, `src/services` and `src/repositories` contain only a `.gitkeep`. No placeholder code was written for layers that `GET /health` does not need.

## 9. `createApp()` is separate from server startup

`src/app.ts` builds and returns the Express app; `src/server.ts` reads the environment and calls `listen`. Tests import `createApp()` and pass it to Supertest, so they open no fixed port and never import `server.ts`.

## 10. Configuration is read in one place and validated

`loadEnv()` in `src/config/env.ts` is the only code that reads `process.env`. It takes the source object as a parameter so tests can call it with plain objects, and it throws on an unknown `NODE_ENV` or an invalid `PORT`, which stops the process at startup. Validation is hand-written because two variables do not justify a schema library.

## 11. `GET /health` returns only `{"status":"ok"}`

The endpoint is a liveness check: it reports that the process answers HTTP. It has no uptime, version or dependency checks because there are no dependencies yet. The route lives in its own router mounted at `/health`.

## 12. Graceful shutdown

`server.ts` closes the HTTP server on `SIGTERM` and `SIGINT` and then exits with code 0, so in-flight requests finish when the process is stopped by a container runtime or by Ctrl+C.

## 13. No error or 404 middleware yet (changed by decision 42)

At first unknown paths got Express's default 404, because only `GET /health` existed. JSON not-found and error handlers were added with `POST /secure-inquiry`.

## 14. `x-powered-by` is disabled

The header only advertises the framework. A test asserts it is absent.

## 15. `redactMessage` lives in `src/services` and is pure

`src/services/redaction.ts` exports `redactMessage(message: string): string`. It does no I/O, keeps no state and returns the same output for the same input, so it is tested directly, without Express. It is not wired to any route yet.

## 16. Detection uses three regular expressions and no validation

Emails, card candidates and SSNs are each found by one pattern. Cards are not checked with Luhn and SSNs are not checked against issued ranges, as requested: for redaction, hiding a number that only looks sensitive costs less than leaking a real one that fails a check (a typo in a real card number fails Luhn too). The accepted cost is more false positives, listed in `docs/REDACTION.md`.

## 17. All candidates are collected first, then overlaps are merged

The three patterns run over the original message independently and produce candidate spans. Overlapping candidates are merged into one span that covers all of them and takes the kind of the longest candidate (ties: email, then card, then SSN). Replacement happens once, at the end, over non-overlapping spans.

Running the patterns one after another on partly redacted text was rejected: the result would depend on the order, and nine digits inside a card could be replaced as an SSN, leaving the rest of the card visible.

Merging was chosen over "longest match wins, discard the other" because discarding can leave part of the losing match in the clear. In `4111 1111 1111 1111@example.com` the card and the email `1111@example.com` overlap; the merged span hides both.

## 18. Digit boundaries look only at the adjacent character

A card or SSN candidate cannot start right after a digit or end right before one. Separators are not part of the boundary, so two cards separated by one space are redacted as two cards. The side effect is that a longer grouped number has its first 13 to 19 digits redacted and the rest left visible.

## 19. Bounded repetition in the email pattern

The local part is limited to 64 characters and each domain label to 63, the limits in the email standards. The bounds keep matching time linear on long inputs with no `@`. Measured: 200,000-character worst-case strings take under 50 ms.

## 20. Idempotency comes from the token format

The tokens `<REDACTED: EMAIL>`, `<REDACTED: CREDIT_CARD>` and `<REDACTED: SSN>` contain no digit and no `@`, so no pattern can match inside one, and a token placed between two fragments keeps them from joining into a new match. Tests cover this with adversarial inputs.

## 21. The encryption key is required configuration, validated at startup

`loadEnv()` reads `ENCRYPTION_KEY`, requires standard padded base64 and requires it to decode to exactly 32 bytes. A missing, malformed or wrong-length key throws, and `server.ts` prints the message and exits with code 1 before listening. There is no default or generated fallback key: a server that silently invents a key writes data nobody can decrypt after a restart.

Error messages state the problem and the decoded length, never the value. `server.ts` prints only the message of a configuration error, not the stack or the environment.

## 22. Strict base64 decoding in `src/utils/base64.ts`

`Buffer.from(value, "base64")` ignores invalid characters instead of failing, so a malformed key could decode to 32 bytes by accident. `decodeBase64()` checks the format first and returns `undefined` otherwise. It sits in a new `src/utils` folder because both `config` and `services` need it and neither should import from the other. Base64url and unpadded values are rejected to keep one accepted format.

## 23. The audit file path is configuration

`AUDIT_LOG_PATH` defaults to `data/audit-log.json`. `data/` is ignored by Git.

## 24. AES-256-GCM through a factory bound to the key

`createEncryptionService(key)` in `src/services/encryption.ts` returns `encrypt(plaintext)` and `decrypt(payload)`. The key is passed in once, copied, and kept in a closure: callers of `encrypt` never handle it, and tests build a service with their own random key instead of touching the environment.

## 25. Random 12-byte IV per encryption, 16-byte tag, three base64 fields

Each `encrypt` call takes 12 bytes from `crypto.randomBytes`. Twelve bytes is the IV size GCM is designed for; reusing an IV with the same key breaks GCM, so the IV is never derived from the content or a counter kept in memory. The result is `{ ciphertext, iv, tag }`, each base64, kept as separate fields rather than one concatenated string so the stored format needs no parsing rules.

With random IVs the usual guidance is to stay well under 2^32 encryptions per key. That is far beyond this project, and there is no key rotation or key identifier in the payload.

## 26. Decryption rejects anything that is not exactly what `encrypt` produces

The IV must be 12 bytes and the tag 16 bytes, and all fields must be strict base64. `createDecipheriv` is called with `authTagLength: 16`, so a truncated tag is refused instead of being accepted with weaker authentication. Every failure is a `DecryptionError` whose message has no payload, plaintext or key material. Modified data and a wrong key give the same message on purpose: GCM cannot tell them apart.

## 27. No additional authenticated data

The ciphertext is not bound to its audit record (for example by using `requestId` as AAD). Someone who can edit the audit file could move a whole valid encrypted payload from one record to another and it would still decrypt. Modifying a payload is detected; swapping payloads is not.

## 28. Audit records live in one JSON file behind a repository

`createAuditRepository(filePath)` in `src/repositories/auditRepository.ts` exposes `append(record)` and `findAll()`. The file is `{ "version": 1, "records": [...] }`. Each record has `requestId`, `userId`, `timestamp` (ISO 8601), `outcome`, `originalMessage` (the `{ ciphertext, iv, tag }` payload) and `redactedMessage` as readable text. The `version` field makes a file from another format detectable instead of misread.

The repository receives the original message already encrypted. It has no access to the key and never sees the original text, so it cannot write or log it. It copies only the six known fields to disk, so an extra property on the object passed in is dropped.

The repository accepts any non-empty string as `outcome`. The values in use are defined by the service that writes them (decision 40).

## 29. Writes are serialized with one queue per file

Appending is read, add, write. Two appends running together would both read the same records and the second write would erase the first. Each append is chained onto a promise queue keyed by the resolved file path, shared by every repository instance in the process, so cycles run one at a time and records keep the order of the calls. A failed write rejects its own caller and does not block the queue.

Removing the queue makes four of the concurrency tests fail, which was checked once by hand.

**Limit:** the queue is in memory. Two processes writing the same file (for example two server instances) are not coordinated and can lose records. That needs a lock file or a database.

## 30. Atomic replacement: temporary file, `fsync`, `rename`

New contents go to a uniquely named temporary file in the same directory (same filesystem, so `rename` is atomic), are flushed with `fsync`, and the file is renamed over the target. A reader gets the complete old file or the complete new one, and a crash mid-write leaves the old file intact. The temporary file is removed if anything fails. Files are created with mode `0600`.

**Limits:** the directory itself is not flushed after the rename, so after a power loss the last append can be missing (the file is still valid). Every append rewrites the whole file, so cost grows with the number of records; this is acceptable for an assessment-sized log and wrong for a large one.

## 31. Corrupted files are reported, never reset

A missing file means "no records yet". A file that exists but is not valid JSON, has the wrong structure or contains an invalid record throws `AuditFileCorruptedError` from both `findAll` and `append`, and the file is left byte for byte as found. An empty file counts as corrupted, because a truncated write looks the same. Recovery is a manual decision: starting a new file automatically would destroy the evidence an audit log exists to keep.

The error names the file path and the kind of problem (including the index and field of a bad record). It never includes file contents, and the JSON parser's own message is discarded because it can quote them.

## 32. No logging in the encryption service or the repository

Neither module calls `console` or any logger; they report through return values and typed errors whose messages carry no message text and no key material. The only `console` calls in `src` are in `server.ts` (startup, shutdown, configuration error message). Tests assert that the repository writes nothing to the console and that error messages do not contain the original text or the key.

## 33. The mock AI and the circuit breaker were built here, with assumed behaviour

The request for `POST /secure-inquiry` refers to "the mock" and "the circuit breaker", but neither existed and no written spec for them was available. Both were written with the defaults below. They are assumptions to confirm against the assessment text.

## 34. Mock AI client behind an `AiClient` interface

`createMockAiClient()` in `src/services/mockAiClient.ts` implements `generateAnswer(prompt)` and returns the fixed text `Generated Answer`. It ignores the prompt and does not store or log it. `MOCK_AI_FAILURE_RATE` (0 to 1, default 0) makes it fail at random so the 503 path can be seen by hand; the default never fails. A real provider would implement the same interface.

## 35. Circuit breaker: consecutive failures, fixed open time, one trial call

`createCircuitBreaker()` in `src/services/circuitBreaker.ts` is a small hand-written state machine rather than a library, so its rules are visible and testable with a fake clock:

- **Closed:** calls pass. `CIRCUIT_FAILURE_THRESHOLD` consecutive failures (default 3) open the circuit; any success resets the count.
- **Open:** calls are rejected with `CircuitOpenError` without running, for `CIRCUIT_RESET_MS` (default 30,000).
- **Half-open:** one trial call runs. Success closes the circuit, failure opens it for another full period. Other calls are rejected while the trial is in flight.

A call that takes more than 5 seconds is a failure (`CircuitTimeoutError`); the slow operation itself is not cancelled, only abandoned. The breaker counts only what happens inside the function it is given, which is how validation and storage errors stay out of the count: they never run inside it.

State is in memory and per process. It resets on restart and is not shared between instances.

## 36. `createApp()` receives its dependencies

`createApp({ aiClient, circuitBreaker, encryption, auditRepository, logger })` builds the routes from what it is given. `server.ts` creates the real ones from the environment. Tests pass a temporary audit file, a breaker on a fake clock, a stubbed AI client and a recording logger, so every path of the endpoint is exercised through HTTP without touching `process.env` or `data/`.

## 37. Request pipeline for `POST /secure-inquiry`

The route runs four steps in order: `requireJson` (415), the JSON parser with a 64 KB limit, `validateSecureInquiry` (400), then the service. The content type is checked before the body is read, and the parser is mounted on this route only.

The service (`src/services/secureInquiry.ts`) then does: redact, call the AI through the breaker, encrypt and append the audit record, and only then return the result. The response is written after the append has finished, so a client never receives an answer that was not audited.

## 38. Validation rules

- The body must be a JSON object with exactly `userId` and `message`; any other property is rejected rather than ignored.
- Both must be strings. A value that is empty or only whitespace is rejected. Zero-width characters (U+200B to U+200D, U+2060) count as whitespace for this check, so a value that shows nothing on screen is blank.
- Both must be well-formed Unicode. A lone surrogate (for example the JSON escape `\ud83d` on its own) is rejected with "must be valid Unicode text": it cannot be encoded as UTF-8, so encryption would replace it and the decrypted original would differ from what was sent.
- Values are never trimmed or normalized. Blank detection uses a trimmed copy; the stored and processed value is the string as sent, including leading and trailing whitespace.
- Limits are 100 and 10,000 characters counted as Unicode code points, so an emoji or an accented letter is one character. The 64 KB limit is on bytes of the raw body and is enforced by the parser (413).
- All problems are reported together in `details`.

`userId` is not checked against any user store and there is no authentication: the endpoint trusts the value it receives.

Not detectable: duplicate keys in the JSON text. The parser keeps the last one.

## 39. Error responses contain fixed texts only

| Status | Body | When |
| --- | --- | --- |
| 400 | `{"error":"Invalid request","details":[...]}` | Validation failed |
| 400 | `{"error":"Malformed JSON"}` | Body is not a JSON object or array |
| 400 | `{"error":"Invalid request body"}` | The body could not be read, for example a corrupt gzip stream |
| 413 | `{"error":"Request body too large"}` | Body over 64 KB, measured after decompression |
| 415 | `{"error":"Content-Type must be application/json"}` | Other or missing content type |
| 404 | `{"error":"Not Found"}` | Unknown route or method |
| 500 | `{"error":"Internal Server Error"}` | Audit failure or any unexpected error |

`details` entries are built from field names and rules. They never contain a value, and an unexpected property is reported as "Only userId and message are allowed" without its name, since the name is also request content. The 404 does not repeat the path. The error handler never sends an error's message or stack; Express's default handler would send the stack outside production, which is why a custom one is required.

## 40. Outcomes and status codes

| Outcome in the audit record | Response |
| --- | --- |
| `answered` | 200 `{"answer":"Generated Answer"}` (the text returned by the AI client) |
| `ai_failure` (the call failed, timed out or returned something other than a non-empty string) | 503 `{"answer":"Service Busy"}` |
| `circuit_open` (the call was not attempted) | 503 `{"answer":"Service Busy"}` |

The two fallback cases look the same to the client and are told apart in the audit record. Requests rejected by validation are not audited: they are not valid requests, and auditing them would store unvalidated input.

## 41. Audit failure wins over any answer

If encrypting or appending the record fails, the response is the generic 500, whether the AI answered or not. The answer is discarded. The failure is logged with the request id, the outcome, the error class and, for a corrupted file, the reason; the original error stays in `cause` and is not sent.

The AI call happens before the audit write, so a failed audit means an AI call was made for a request that has no record. Auditing first would avoid that but could not record the outcome without a second write.

## 42. What the breaker counts

Only the function passed to `circuitBreaker.execute` is counted, and that function contains only `aiClient.generateAnswer(redactedMessage)` and the check that it returned a non-empty string. Content-type, parsing and validation errors return before the service runs. Redaction runs before the breaker and encryption and storage after it. Tests send invalid requests and force storage failures and assert the circuit stays closed.

## 43. Logging is structured and limited to identifiers

`src/utils/logger.ts` writes one JSON line per event with a fixed event name and a few fields: request id, outcome, error class name, error code. Error messages from unknown errors are not logged, because a provider or parser error can quote its input. Two events exist: `ai_unavailable` (warn) and `audit_failed` (error), plus `unhandled_error` from the error handler. Successful requests are not logged; the audit file is their record.

## 44. `X-Request-Id` response header

Responses that reached the service (200, 503 and audit-failure 500) carry the generated request id, which is the `requestId` of the audit record and of the log line. It was not requested; it lets a client report a problem without anyone needing the message contents. Incoming `X-Request-Id` headers are ignored.

## 45. Test strategy

| Level | Files | How |
| --- | --- | --- |
| Pure units | `redaction`, `validation`, `encryption`, `env` | Direct calls, no I/O |
| Time-dependent units | `circuitBreaker`, `mockAiClient`, `secureInquiryService` | Vitest fake timers: the 30 s open period, the 5 s call timeout and record timestamps are driven by `vi.advanceTimersByTime`, never by waiting |
| File-backed unit | `auditRepository` | A new temporary directory per test, removed afterwards |
| HTTP | `secureInquiry`, `health` | Supertest against `createApp()` with injected dependencies: a temporary audit file, a real breaker on an injected clock, a `vi.fn` AI client and a recording logger |

HTTP tests do not use fake timers, because Supertest needs real sockets; they move the breaker's injected clock instead. Two HTTP tests use real time on purpose: the slow-mock test (25 ms timeout) and the performance bounds on redaction (under 1 second for 100,000 characters; they take a few milliseconds).

All data is synthetic: test card numbers such as `4111 1111 1111 1111`, the SSN `123-45-6789`, `example.com` addresses and keys from `randomBytes`. No test reads `.env`, `process.env` or `data/`.

The service unit tests replace the repository and the encryption with fakes; the HTTP tests use the real ones, so the same flow is checked once in isolation and once end to end.

## 46. Problems found by the completed test suite and fixed

Writing the adversarial tests exposed four defects in the code, each fixed with the test kept:

1. **Lone surrogates broke the round trip.** A message containing an unpaired surrogate was accepted, and decryption returned U+FFFD in its place. Validation now rejects it (decision 38).
2. **Zero-width-only values passed as non-blank.** `trim()` does not remove U+200B. Validation now treats them as blank.
3. **An unusable AI answer produced a 200 with no answer.** If the client resolved with `undefined`, the response was `{}`. A result that is not a non-empty string is now an AI failure: 503, audited, counted by the breaker.
4. **A corrupt gzip body returned 500.** The parser's error had a 400 status but no known type, so it fell through to the generic handler and was logged as unexpected. Client errors with a 4xx status now return that status with a fixed text.

Three new tests failed because their expectations were wrong, not the code: two redaction cases that hit documented behaviour (digits after a card are absorbed; short numbers in a row add up to a card candidate) and one that sent gzip bytes through Supertest's JSON serializer. The redaction cases were kept as tests of the documented behaviour and added to `docs/REDACTION.md`.
