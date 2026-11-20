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

## 13. No error or 404 middleware yet

The request asked for `GET /health` only, so unknown paths get Express's default 404. JSON error and not-found handlers belong in `src/middleware` once real endpoints define the error format.

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
