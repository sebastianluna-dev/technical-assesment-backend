# technical-assessment-backend

A small HTTP service that receives a user's message, removes personal data from it, asks an AI for an answer and keeps an audit record of the exchange.

One endpoint does the work, `POST /secure-inquiry`:

1. It validates the request.
2. It redacts emails, credit card numbers and US Social Security numbers from the message.
3. It sends only the redacted text to the AI (a mock in this project), through a circuit breaker.
4. It stores an audit record: the original message encrypted with AES-256-GCM, the redacted message as text.
5. It responds, with the answer or with a fallback if the AI is unavailable.

Built with Node.js 24 (LTS), Express 5 and TypeScript. Tested with Vitest and Supertest.

## Contents

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API](#api)
- [Demo](#demo)
- [Tests](#tests)
- [Docker](#docker)
- [Limits you should know about](#limits-you-should-know-about)
- [Project layout](#project-layout)

## Quick start

Requirements: Node.js 24 or later (`.nvmrc` pins the major version) and npm.

```sh
npm install
cp .env.example .env
```

Generate an encryption key and put it in `.env` as `ENCRYPTION_KEY`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Then start the server:

```sh
npm run dev      # development, restarts on changes
```

or

```sh
npm run build
npm start        # runs the compiled server from dist/
```

The server listens on `http://localhost:3000`. If the key is missing or invalid it prints one line and exits with code 1:

```
Configuration error: Missing ENCRYPTION_KEY. Expected a base64-encoded 32-byte key.
```

To see everything working without any setup beyond `npm install`, run the [demo](#demo).

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the server with `tsx watch` and restarts on changes |
| `npm run build` | Compiles `src` to `dist` with `tsc` |
| `npm start` | Runs the compiled server from `dist` |
| `npm run typecheck` | Type-checks `src`, `tests` and `scripts` without emitting |
| `npm test` | Runs the test suite once |
| `npm run test:watch` | Runs the tests in watch mode |
| `npm run demo` | Runs the scripted demo |

## Configuration

Settings are read from environment variables. `npm run dev` and `npm start` also load a `.env` file if one exists.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ENCRYPTION_KEY` | Yes | none | Base64-encoded 32-byte key for AES-256-GCM |
| `AUDIT_LOG_PATH` | No | `data/audit-log.json` | JSON file that stores the audit records |
| `PORT` | No | `3000` | HTTP port |
| `NODE_ENV` | No | `development` | `development`, `test` or `production` |
| `CIRCUIT_FAILURE_THRESHOLD` | No | `3` | Consecutive AI failures that open the circuit |
| `CIRCUIT_RESET_MS` | No | `30000` | Time the circuit stays open before one probe request |
| `MOCK_AI_FAILURE_RATE` | No | `0` | Probability, from 0 to 1, that the mock AI fails |
| `MOCK_AI_DELAY_MS` | No | `0` | Simulated latency of the mock AI |

Invalid values stop the server at startup with a message that names the variable.

### Handling the key safely

- **Generate it with a cryptographic random source.** Either command gives a valid key:

  ```sh
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
  openssl rand -base64 32
  ```

  The result is 44 characters ending in `=`. Do not type a key by hand or derive it from a password.
- **Keep it out of Git.** `.env` is ignored; `.env.example` has the variable with no value. Do not paste the key into commits, issues, chat or logs.
- **Use a different key per environment.** In production, supply it through the platform's secret store, not a file in the image.
- **Back it up separately from the audit file.** Without the key, the encrypted original messages cannot be recovered. With the key and the file together, anyone can read them.
- **There is no key rotation.** Records do not say which key encrypted them. Changing the key makes older records undecryptable unless you keep the old key.

The server never logs the key, and its error messages never include it.

## API

### GET /health

```sh
curl http://localhost:3000/health
```

```
200 {"status":"ok"}
```

### POST /secure-inquiry

Request rules:

- `Content-Type: application/json`, body of at most 64 KB.
- A JSON object with exactly two properties, both strings:
  - `userId`: 1 to 100 characters.
  - `message`: 1 to 10,000 characters.
- Blank values (empty, only whitespace, or only zero-width characters) are rejected.
- Values are never trimmed or changed: the message is processed and stored exactly as sent.

#### Success

```sh
curl -i -X POST http://localhost:3000/secure-inquiry \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo-user-1","message":"My card is 4111 1111 1111 1111 and my email is ana@example.com"}'
```

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Request-Id: 8d4b072a-678d-430f-8c05-29ac9a365cf7

{"answer":"Generated Answer"}
```

The AI received `My card is <REDACTED: CREDIT_CARD> and my email is <REDACTED: EMAIL>`, and this record was added to the audit file before the response was sent:

```json
{
  "requestId": "8d4b072a-678d-430f-8c05-29ac9a365cf7",
  "userId": "demo-user-1",
  "timestamp": "2026-11-20T17:58:08.230Z",
  "outcome": "answered",
  "originalMessage": {
    "ciphertext": "/808KVJU+jV5t36K3Fat9OsowYyrRw6xZBePig7Lqzrp3UA/...",
    "iv": "Qh82f0OmBlHzTG8L",
    "tag": "gER+5E0B4nQIpVl2sFlJ+Q=="
  },
  "redactedMessage": "My card is <REDACTED: CREDIT_CARD> and my email is <REDACTED: EMAIL>"
}
```

`X-Request-Id` matches the record's `requestId`.

#### AI unavailable

When the AI call fails, takes more than 5 seconds, or the circuit is open:

```
HTTP/1.1 503 Service Unavailable

{"answer":"Service Busy"}
```

The request is still audited, with outcome `ai_failure` or `circuit_open`.

#### Errors

| Status | Body | When |
| --- | --- | --- |
| 400 | `{"error":"Invalid request","details":[...]}` | The body breaks a rule above |
| 400 | `{"error":"Malformed JSON"}` | The body is not valid JSON |
| 400 | `{"error":"Invalid request body"}` | The body could not be read, for example corrupt gzip |
| 413 | `{"error":"Request body too large"}` | The body is over 64 KB |
| 415 | `{"error":"Content-Type must be application/json"}` | Another content type, or none |
| 404 | `{"error":"Not Found"}` | Unknown path or method |
| 500 | `{"error":"Internal Server Error"}` | The audit record could not be stored |

Example of a validation error:

```sh
curl -X POST http://localhost:3000/secure-inquiry \
  -H 'Content-Type: application/json' \
  -d '{"userId":"","message":42,"role":"admin"}'
```

```json
{
  "error": "Invalid request",
  "details": [
    "userId must not be blank",
    "message must be a string",
    "Only userId and message are allowed"
  ]
}
```

Error bodies are fixed texts. They never contain values from the request, names of unexpected properties, file paths or stack traces. Requests that fail validation are not audited and do not reach the AI.

If the audit record cannot be stored, the response is `500` even when the AI answered: an answer is never returned without its record.

## Demo

```sh
npm run demo
```

The script ([scripts/demo.ts](scripts/demo.ts)) starts the real application on a free local port, sends real HTTP requests and checks each result. It needs no `.env`: it generates a key for the run, writes to a temporary audit file and deletes it at the end. All data in it is synthetic (the test card `4111 1111 1111 1111`, the SSN `123-45-6789`, an `example.com` address).

It shows, in order:

1. **Successful redaction.** The message sent, the text the mock AI received, and the response.
2. **The encrypted audit record.** The record as stored, then the original recovered by decrypting it.
3. **Three consecutive failures.** The mock is switched to failing; each request waits for the AI and returns `503`; the third opens the circuit.
4. **The fourth request.** It returns `503` at once and the mock is not called.
5. **Recovery.** The mock is healthy again; a request during the open period is still rejected; after the period, one probe request goes through and the circuit closes.

Every request prints its duration, and a summary closes the run. Output from one run, with the mock AI set to 600 ms per call:

```
  Request                                              Status   Time    AI called
  Request 1 (AI healthy)                               200      672 ms  yes
  Request 2 (AI failing, failure 1 of 3)               503      622 ms  yes
  Request 3 (AI failing, failure 2 of 3)               503      622 ms  yes
  Request 4 (AI failing, failure 3 of 3)               503      613 ms  yes
  Request 5 (fourth since failures began)              503      7 ms    no
  Request 6 (AI healthy, circuit still open)           503      9 ms    no
  Request 7 (probe)                                    200      607 ms  yes
  Request 8 (normal again)                             200      608 ms  yes

  Audit outcomes, one per request: answered, ai_failure, ai_failure, ai_failure, circuit_open, circuit_open, answered, answered
```

The exact times vary by machine. The script exits with code 1 if any check fails.

The demo uses a 3-second open period so recovery is quick to watch. Both timings can be changed:

```sh
DEMO_AI_DELAY_MS=1000 DEMO_RESET_MS=5000 npm run demo
```

The only difference from `npm start` is the mock AI: in the demo it has a switch, so the script can make it fail and recover on demand.

### Showing the circuit breaker by hand

With the real server, the mock can be made to fail every time and to take a visible amount of time:

```sh
npm run build
MOCK_AI_FAILURE_RATE=1 MOCK_AI_DELAY_MS=600 CIRCUIT_RESET_MS=5000 npm start
```

In another terminal, send the same request four times:

```sh
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "request $i: HTTP %{http_code} in %{time_total}s\n" \
    -X POST http://localhost:3000/secure-inquiry \
    -H 'Content-Type: application/json' \
    -d '{"userId":"demo-user-1","message":"My SSN is 123-45-6789"}'
done
```

```
request 1: HTTP 503 in 0.628555s
request 2: HTTP 503 in 0.609014s
request 3: HTTP 503 in 0.609421s
request 4: HTTP 503 in 0.005000s
```

The first three wait for the AI. The fourth does not: the circuit is open.

### Showing recovery

Recovery has two halves, and the manual setup can only show the first:

- **The probe.** Wait `CIRCUIT_RESET_MS` (5 seconds above) and send one more request. It takes 0.6 seconds again, which shows the circuit let one request through to the AI. Because the mock is still set to fail, the probe fails, the circuit opens for another full period, and the next request is instant again.
- **Closing the circuit.** This needs the AI to become healthy while the server keeps running. The mock's failure rate is read at startup, and restarting the server to change it also resets the breaker, which lives in memory. So a restart proves nothing about recovery. Use `npm run demo` for this half: step 5 flips the mock back to healthy inside the same process and shows the probe succeed and the circuit close.

A third option is a rate between 0 and 1, for example `MOCK_AI_FAILURE_RATE=0.7`. The circuit then opens and closes on its own as you keep sending requests, but which request does what is random.

## Tests

```sh
npm test
npm run typecheck
```

375 tests in 10 files, about two seconds.

| File | Covers |
| --- | --- |
| `tests/redaction.test.ts` | Each data type, aliases, numeric boundaries, repeated and overlapping matches, adversarial inputs, idempotency |
| `tests/validation.test.ts` | Every rule on the request body |
| `tests/encryption.test.ts` | Round trips, fresh IVs, tampering with each field, wrong and missing keys |
| `tests/auditRepository.test.ts` | Stored format, 100 concurrent writes, corrupted files, filesystem failures |
| `tests/circuitBreaker.test.ts` | Opening after three failures, counter reset, single probe, timeouts |
| `tests/secureInquiryService.test.ts` | Order of redaction, AI call and audit; failures of each step |
| `tests/secureInquiry.test.ts` | The endpoint through HTTP: every status code, what reaches the AI, what is stored |
| `tests/env.test.ts`, `tests/mockAiClient.test.ts`, `tests/health.test.ts` | Configuration, the mock, the health route and the JSON 404 |

Time-dependent unit tests use fake timers. HTTP tests run the app through Supertest with injected dependencies and a temporary audit file. All data is synthetic; no test reads `.env` or writes to `data/`.

Coverage is not measured and no linter is configured.

## Docker

The image is built in two stages and runs the compiled server as the unprivileged `node` user. The key is not in the image: it is supplied when the container starts.

Build:

```sh
docker build -t technical-assessment-backend:local .
```

Run, with the key from your `.env` and the audit file in a named volume:

```sh
docker run --rm --name secure-inquiry \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  -e AUDIT_LOG_PATH=/app/data/audit-log.json \
  -v secure-inquiry-data:/app/data \
  technical-assessment-backend:local
```

The `-e AUDIT_LOG_PATH` line keeps the file inside the volume even if `.env` sets another path. To pass the key directly instead of a file, replace `--env-file .env` with `-e ENCRYPTION_KEY="..."`. Values in an env file must not be wrapped in quotes.

Look at the audit file and stop the container:

```sh
docker exec secure-inquiry cat /app/data/audit-log.json
docker stop secure-inquiry
```

With Docker Compose, which reads `.env` and creates the volume:

```sh
docker compose up --build        # http://localhost:3000
docker compose down              # stop; add -v to delete the audit volume too
```

If port 3000 is taken on your machine, choose another: `HOST_PORT=3001 docker compose up --build`, or `-p 127.0.0.1:3001:3000` with `docker run`.

Things to know:

- Both commands publish the port on `127.0.0.1` only, so the service is not reachable from other machines.
- The audit file lives in the volume. Without a volume it is lost when the container is removed.
- Run a single container. Two containers sharing the volume would corrupt each other's writes (see below).
- The container exits with code 1 if `ENCRYPTION_KEY` is missing or invalid.

## Limits you should know about

### The sanitizer is pattern matching, not understanding

Redaction uses three regular expressions. It finds data that looks like an email, a card number or an SSN in the formats below, and nothing else.

| Type | Detected |
| --- | --- |
| Email | `local@domain.tld`, including `+` and `.` aliases, apostrophes (`o'connor@…`) and quoted local parts (`"ana garcia"@…`) |
| Credit card | 13 to 19 digits, together or separated by single spaces or hyphens. No Luhn check. |
| SSN | `XXX-XX-XXXX`, or exactly nine consecutive digits |

**It misses:**

- Any other kind of personal data: names, addresses, phone numbers, dates of birth, passport or bank account numbers.
- Obfuscated values: `john at example dot com`, card digits separated by dots, slashes, line breaks or more than one space, numbers written as words.
- SSNs in other formats, such as `123 45 6789`.
- Emails with non-ASCII characters (`josé@example.com`), and digits that are not ASCII (full-width `４１１１…`).
- Data split across several messages.

**It over-redacts:**

- Any 13 to 19 digits count as a card: millisecond timestamps, ISBN-13 codes, tracking numbers, long order IDs.
- Any standalone nine digits count as an SSN: order numbers, routing numbers.
- Short numbers separated only by spaces or hyphens can add up to a card: `2024 2025 2026 2027` is redacted.

This direction is deliberate: hiding a harmless number costs less than leaking a real one. But the result is that **a redacted message is not guaranteed to be free of personal data**, and the redacted text is stored readable in the audit file and sent to the AI. Treat it as reduced-risk text, not as anonymous text.

Full list with examples: [docs/REDACTION.md](docs/REDACTION.md).

### The circuit breaker is local to one process

The breaker's state (failure count, open or closed, when it opened) is held in memory.

- **Restarting the server closes the circuit** and clears the count.
- **Several instances do not share it.** Each one counts its own failures and opens on its own, so with N instances the AI can receive up to N times the failures before all of them stop calling it, and after the open period each instance sends its own probe.
- It counts consecutive failures only. A service that fails two calls out of three never opens it.
- A call that exceeds 5 seconds is counted as failed and abandoned, not cancelled.

Sharing the state would need an external store such as Redis.

### Audit storage is one JSON file for one process

The audit log is a single JSON file that is rewritten in full on every request.

- **One process only.** Writes are queued inside the process, so concurrent requests to one server are safe. Two processes writing the same file (two instances, two containers on one volume) are not coordinated and will lose records.
- **Cost grows with size.** Each request reads, parses and rewrites the whole file. It suits a demonstration, not sustained traffic.
- **A corrupted file stops the endpoint.** If the file cannot be parsed, every request returns `500` until someone repairs or moves it. The service does not reset it, because that would destroy the records.
- **The last record can be lost on power failure.** Writes replace the file atomically, so the file stays valid, but the directory is not flushed.
- **Records are not tamper-evident as a set.** A modified encrypted message is detected on decryption. Deleting a record, reordering records or moving an encrypted message to another record is not.
- **`userId` and the redacted message are stored as readable text.** Only the original message is encrypted.

A database would remove the first four limits.

### `userId` identifies, it does not authenticate

`userId` is a label supplied by the caller. The service checks that it is a non-blank string of up to 100 characters and records it. It does not check that the user exists, or that the caller is that user.

- There is no authentication or authorization on any endpoint. Anyone who can reach the service can send requests under any `userId`.
- The audit record therefore says "a request claimed this `userId`", not "this user sent it".
- There is no rate limiting per user or per client.

In a real deployment the service would sit behind something that authenticates the caller (an API gateway, a session, a signed token), and `userId` would be taken from that verified identity, not from the request body.

### Other points

- The AI is a mock that always returns `Generated Answer`. The mock and the circuit breaker's numbers (3 failures, 30 seconds, 5-second timeout) are this project's assumptions.
- The service speaks plain HTTP. TLS is expected to be handled in front of it.
- The AI is called before the audit record is written. If the write fails, the client gets `500`, but an AI call was already made for a request that has no record.

## Project layout

```
src/
  app.ts            createApp(): builds the Express app from its dependencies
  server.ts         reads the environment and starts the HTTP server
  config/           environment loading and validation
  routes/           /health and /secure-inquiry
  middleware/       content type check, validation, 404 and error handler
  services/         redaction, encryption, circuit breaker, mock AI, inquiry flow
  repositories/     JSON file audit log
  utils/            strict base64 decoding, logger
tests/              Vitest and Supertest tests
scripts/demo.ts     scripted demo
docs/
  DECISIONS.md      implementation decisions and their reasons
  REDACTION.md      redaction rules, limits and false positives
PROMPT_LOG.md       prompts given to the AI assistant and their outcomes
Dockerfile, compose.yaml
```
