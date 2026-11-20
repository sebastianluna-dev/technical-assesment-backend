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

## 47. Docker image: two stages, no key, unprivileged user

The `Dockerfile` compiles in a build stage and copies only `dist`, production dependencies and `package.json` into the runtime stage (`node:24-alpine`). It runs as the `node` user, declares `/app/data` as a volume for the audit file, and has a health check that calls `/health`.

`ENCRYPTION_KEY` is not set in the image and `.dockerignore` keeps `.env` and `data/` out of the build context, so neither the key nor audit data can end up in a layer. The key is given at `docker run` time. The container starts `node dist/server.js` directly, without npm, so `SIGTERM` reaches the process and `docker stop` shuts it down cleanly.

`compose.yaml` publishes the port on `127.0.0.1` only and takes the host port from `HOST_PORT` (default 3000), because 3000 is a common port and was already in use on the development machine.

## 48. The lockfile was regenerated for clean installs

`npm ci` failed inside the image: the lockfile written by the local npm 11.6.2 lacked two optional packages (`@emnapi/core`, `@emnapi/runtime`) that npm 11.19.1 in `node:24-alpine` requires to be listed. Deleting `node_modules` and `package-lock.json` and running `npm install` again produced a lockfile that both versions accept. The direct dependency versions did not change.

## 49. `MOCK_AI_DELAY_MS`

The mock already supported a delay; the setting exposes it (default 0) so the difference between a request that waits for the AI and one rejected by an open circuit can be seen with `curl` on the real server.

## 50. The demo runs the real app in its own process with a controllable mock

`scripts/demo.ts` calls `createApp()` with the real encryption service, audit repository and circuit breaker, listens on a free port and sends requests with `fetch`. Only the AI client differs: it is the real mock wrapped with a switch, so the script can make it fail, then recover.

A demo driving `npm start` from outside was rejected because the server has no way to change the mock's behaviour while running, and adding one (a magic word in the message, a control endpoint) would put a test hook in production code. Restarting the server to change the failure rate also resets the breaker, so it could not show recovery.

The script generates its own key, writes to a temporary directory it deletes, uses only synthetic data, checks every step and exits with code 1 if a check fails. Its open period is 3 seconds instead of 30 so the recovery step is short.

## 51. Emails with an apostrophe or a quoted local part are redacted whole

Two addresses got past the email pattern: `"ana garcia"@example.test` was not detected at all (the character before the `@` is a quote), and `o'connor@example.test` left `o'` in the text.

- The unquoted local part now accepts an apostrophe anywhere except the first character. Keeping it out of the first position means `'ana@example.test'` still keeps both of its quote marks.
- A second form was added: any text between two double quotes on one line, directly followed by `@domain`. The quotes belong to the address and are redacted with it.
- The quoted form has no length bound. The scan stops at the next quote, so matching stays linear (10,000 quotes take under 1 ms). A bound would also break idempotency: redacting a card inside a long quoted part could shorten it under the bound and create a new email match on the second pass.
- The pattern is now assembled from named parts (`QUOTED_LOCAL_PART`, `UNQUOTED_LOCAL_PART`, `DOMAIN_LABEL`, `TOP_LEVEL_LABEL`) instead of one long literal. Overlap resolution is unchanged; a card or SSN inside a quoted local part is merged into the single email token.
- The other symbols an address may legally carry (`! # $ & * / = ? ^ { | } ~` and the backtick) were not added. They would make the match swallow text in front of an address, such as `email=` or a URL path. Escaped quotes inside a quoted part are not supported either. Both limits are listed in `docs/REDACTION.md`.

## 52. Three more formats are matched directly in the patterns, with no normalization step

Three values got past the sanitizer: `josé@example.test`, a card grouped with no-break spaces (U+00A0), and nine full-width digits (`０００１２３４５６`).

- **Emails.** The letter and digit classes of the local part and the domain are now `\p{L}` and `\p{N}` (plus combining marks after the first character), and the pattern uses the `u` flag. This covers accented local parts, decomposed accents and internationalized domains.
- **Cards.** The separator between digits is one space, one no-break space or one hyphen.
- **Digits.** A named class, `DIGIT`, accepts ASCII digits and full-width digits U+FF10 to U+FF19. Cards and SSNs both use it, including their "not attached to another digit" boundaries, so a full-width card is redacted too and nine full-width digits followed by a tenth digit are still not an SSN.

A normalized copy of the message (NFKC, or a table of look-alike characters) was rejected. Normalization can change the length of the text, so match positions would have to be mapped back to the original, and it would turn the sanitizer into a general system with its own failure modes. Matching the original string keeps every position exact: each of the added characters is one UTF-16 unit, and the email pattern's `u` flag does not change how `match.index` is counted. The function still returns a new string and the original message is still the one encrypted.

Deliberately left out, and listed in `docs/REDACTION.md`: other Unicode spaces (U+202F, zero-width), digits of other scripts, the full-width at sign, and no-break spaces inside an SSN. Each would be one more character in a class; they were not added without a reported case because every addition also widens the false positives.

Cost: letters of any alphabet can now belong to a local part, so text written without spaces directly before an address (as in Chinese or Japanese) is redacted with it, up to 64 characters.

## 53. Separator policy for cards and SSNs

Cards and SSNs used to accept one space, one no-break space or one hyphen between digits. They now accept a bounded run of separators, defined once (`SEPARATOR`, `MAX_SEPARATORS`, `SEPARATOR_RUN` in `src/services/redaction.ts`) and documented in `docs/REDACTION.md`.

- **What a separator is.** Unicode punctuation, symbols, spaces of any width, the tab and invisible format characters (`\p{P}`, `\p{S}`, `\p{Zs}`, `\p{Cf}`, tab). Letters and line breaks are outside these classes, so numbers are not joined across words or lines.
- **Comma and semicolon are excluded.** They are list punctuation. Without the exclusion `123-45-6789, 4111 1111 1111 1111` and every price list would be read as one number. The cost is that `4111,1111,1111,1111` is not detected.
- **At most three in a row.** Enough for ` - ` and ` / `; a wider gap ends the number.
- **Cards are found as numeric runs, then counted.** The pattern matches the longest run of 13 or more digits with optional separator runs between them, and `isCardCandidate` applies the count: 13 to 19 digits is a candidate; 20 or more written together is not, as before.
- **A run of more than 19 digits with separators is redacted whole.** This replaces the previous behaviour, which redacted the first 19 digits and left the rest (`1234 5678 9012 3456 7890 1234` became `<REDACTED: CREDIT_CARD> 7890 1234`). With more separators accepted, such runs are more frequent (a card after an SSN, a card and its expiry date), and leaving a tail of real digits is worse than one token for two values.
- **SSNs keep their shape.** Nine digits together, or 3-2-4 with a separator run between the groups. Separators between arbitrary digits are not accepted, which keeps other nine-digit groupings out.
- **No normalization.** The patterns run on the original string, so positions are exact and the original message is unchanged. The detector list gained one optional field, `accepts`, used only by the card detector.

Known costs, all documented: two values with only separators between them share one token and may be labelled as a card (two SSNs joined by ` / `); a date followed by a time and an IP address with a port are now redacted. The Unicode emails and full-width digits asked for in the same prompt were already in place (decision 52).

A stricter alternative, requiring the same separator throughout a number, would avoid most merges. It was rejected because it stops detecting cards with mixed separators (`4111 1111-1111 1111`), which were detected before: a missed card is worse than a merged token.

## 54. The mock AI waits 2,000 ms by default

`createMockAiClient` and `MOCK_AI_DELAY_MS` both defaulted to 0. Both now default to 2,000 ms, from one exported constant (`DEFAULT_MOCK_AI_DELAY_MS` in `src/services/mockAiClient.ts`) that `src/config/env.ts` imports, so the two cannot drift apart. This replaces the default stated in decision 49.

- The delay comes before the failure draw, so a failing call also takes two seconds. A request rejected by an open circuit never reaches the mock and does not wait.
- Two seconds is under the circuit breaker's 5-second timeout, so the default delay does not count as a failure.
- `0` remains a valid value in both places and skips the timer entirely. Unit tests of the mock pass `delayMs: 0` unless they are measuring the delay; HTTP tests inject their own AI client and never used the mock's delay.
- `failureRate` and the injectable `random` are unchanged, so failures stay deterministic in tests.
- The demo script keeps its own explicit 600 ms (`DEMO_AI_DELAY_MS`); with 2,000 ms its five calls that reach the mock would take ten seconds.

## 55. Circuit breaker calls are tied to the cycle they started in

**Defect.** A call that started while the circuit was closed could settle after the circuit had opened and recovered. The breaker only checked that the state was "closed" at that moment, so it applied the old outcome to the new closed period: a late failure counted as the first failure of the new period, and a late success erased failures already counted in it. With the 5-second call timeout and the default 30-second open period this cannot happen, but it can whenever `CIRCUIT_RESET_MS` is shorter than the call timeout.

**Fix.** The breaker keeps a `cycle` counter that increases on every state change (to open, to half-open, to closed). A call stores the counter when it starts and reports its outcome only if the counter is unchanged when it settles. A stale call still returns its own result or error to its caller; it just changes nothing in the breaker.

- All state changes go through one function, `enter`, which also resets the failure count and the trial flag. This removed the separate bookkeeping of "is this call the trial".
- The single trial is preserved: half-open admits one call, and only a call started in that half-open cycle can close or reopen the circuit.
- A counter was preferred to comparing timestamps (two changes can share a millisecond, and tests replace the clock) and to cancelling pending calls (the operation is an opaque promise that cannot be cancelled).
- The open check is unchanged: an open circuit rejects before invoking the operation.

## 56. Validation is a pure function called by the route handler

The `/secure-inquiry` body was validated by a middleware that stored the result in `res.locals.inquiry`, and the handler read it back with a type cast. The pure function now lives in `src/validation/secureInquiry.ts` and the handler calls it directly: if `result.ok` is false it answers 400, otherwise it passes `result.value` to the service.

- The cast is gone. The value reaches the service with the type the validator returned, checked by the compiler.
- `SecureInquiryInput` is defined once, in the validation module. The service's `handle` used an equivalent inline type and now imports this one.
- The route's order is unchanged: `requireJson` (415), the JSON parser with its 64 KB limit, validation (400), service. This updates the description in decision 37 of the route's four steps: the third is no longer a middleware.
- `requireJson` and the error handler stay in `src/middleware` because they are real Express middleware. No controller layer was added; the handler is still the function in `src/routes/secureInquiry.ts`.
- Rules, error texts and the 400 response body are the same; the validation and HTTP tests pass without changes other than one import path.
