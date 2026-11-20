# Manual demo for a recording

A walkthrough of the running backend with `curl`, for a video of three to five minutes. Every command can be pasted on its own. The expected result is shown under each step; ids, timestamps, ciphertext and timings differ on every run.

For an automatic run of the same ideas, including the circuit closing again, use `npm run demo` (see the README).

## What keeps the demo safe to record

- **Isolated data.** The demo runs as its own Compose project, `secure-inquiry-demo`, on port 3100. Its audit file is in its own volume, `secure-inquiry-demo_audit-data`. The default project's volume and the local `data/` folder are not touched.
- **Synthetic data only.** The email, card number and SSN below are made up.
- **The key never appears.** The container reads `ENCRYPTION_KEY` from `.env`; no command here prints it.

Do not run these while recording, because they print the key: `cat .env`, `docker compose config`, `docker inspect`, `docker compose exec api env`.

## Before recording

You need Docker running, and a `.env` file with a valid `ENCRYPTION_KEY` (see "Quick start" in the README). The demo assumes `.env` does not set `MOCK_AI_FAILURE_RATE` or `MOCK_AI_DELAY_MS`, so the mock answers after its default 2 seconds.

Run this once in the terminal you will record, from the project folder. Every `docker compose` command below depends on these two variables:

```sh
export COMPOSE_PROJECT_NAME=secure-inquiry-demo HOST_PORT=3100
```

Build and start (the build takes about a minute the first time, so do it before recording):

```sh
docker compose up -d --build
```

## 1. Health check (15 s)

```sh
curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' http://localhost:3100/health
```

```
{"status":"ok"}
HTTP 200 in 0.014523s
```

## 2. A successful inquiry with sensitive data (30 s)

The message contains an email, a card number and an SSN.

```sh
curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' \
  -X POST http://localhost:3100/secure-inquiry \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo-user-1","message":"Hi, I am Ana. Email ana.demo@example.test, card 4111 1111 1111 1111, SSN 123-45-6789."}'
```

```
{"answer":"Generated Answer"}
HTTP 200 in 2.035649s
```

The two seconds are the mock AI's delay. The response carries only the answer, never the message.

## 3. An invalid request (20 s)

The body has no `message`.

```sh
curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' \
  -X POST http://localhost:3100/secure-inquiry \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo-user-1"}'
```

```
{"error":"Invalid request","details":["message is required"]}
HTTP 400 in 0.004489s
```

It is rejected at once: the AI is not called and nothing is audited, which the next step confirms.

## 4. The audit record (60 s)

Print the number of records and the last one:

```sh
docker compose exec api node -e "const {records}=JSON.parse(require('node:fs').readFileSync('data/audit-log.json','utf8')); console.log(records.length+' record(s). Last one:'); console.log(JSON.stringify(records.at(-1),null,2))"
```

```
1 record(s). Last one:
{
  "requestId": "6cc5a7a9-0487-4d8a-8977-96ce8649dce0",
  "userId": "demo-user-1",
  "timestamp": "2026-11-20T23:35:20.039Z",
  "outcome": "answered",
  "originalMessage": {
    "ciphertext": "FTkq9NHApEf1nzCZbLkC9kY9TbUaPf4v62hSdVWTIduXNnX5wbf5QJDtFCmw00e1K/r5vxHPhDcpxTEr1jKz04JAnXyfsT2s+EyR71hvRrTFPM57Tw==",
    "iv": "qPueMbAwt/gP2SH9",
    "tag": "b+zkbKtB4MxnSjNs8TrA/Q=="
  },
  "redactedMessage": "Hi, I am Ana. Email <REDACTED: EMAIL>, card <REDACTED: CREDIT_CARD>, SSN <REDACTED: SSN>."
}
```

What to point out:

- One record: the invalid request from step 3 left none.
- `redactedMessage` is readable and holds three tokens in place of the three values.
- `originalMessage` is ciphertext with its IV and authentication tag (AES-256-GCM). Showing it is safe; it cannot be read without the key.

Confirm that none of the sensitive values is anywhere in the file. The command counts the lines that contain any of them:

```sh
docker compose exec api grep -c -e '4111' -e '123-45-6789' -e 'ana.demo' data/audit-log.json
```

```
0
```

Optional: prove that the ciphertext is the original message. This decrypts the last record inside the container, with the key the server already holds. It prints the message, not the key.

```sh
docker compose exec api node --input-type=module -e "import {readFileSync} from 'node:fs'; import {createEncryptionService} from './dist/services/encryption.js'; const {records}=JSON.parse(readFileSync('data/audit-log.json','utf8')); const key=Buffer.from(process.env.ENCRYPTION_KEY,'base64'); console.log(createEncryptionService(key).decrypt(records.at(-1).originalMessage))"
```

```
Hi, I am Ana. Email ana.demo@example.test, card 4111 1111 1111 1111, SSN 123-45-6789.
```

## 5. The circuit breaker (60 s)

The mock's settings are read when the server starts, so making it fail needs a restart. `compose.failing-ai.yaml` adds two settings to the same service: the mock always fails (`MOCK_AI_FAILURE_RATE=1`) and takes 2,000 ms to do it (`MOCK_AI_DELAY_MS=2000`).

Restart the container with the override. The audit volume is kept; the circuit breaker lives in memory, so it starts closed.

```sh
docker compose -f compose.yaml -f compose.failing-ai.yaml up -d
```

Wait two or three seconds for the server to start, then send four requests in a row to that same process. Each line shows the status and the time taken:

```sh
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "request $i: HTTP %{http_code} in %{time_total}s\n" \
    -X POST http://localhost:3100/secure-inquiry \
    -H 'Content-Type: application/json' \
    -d '{"userId":"demo-user-2","message":"My SSN is 123-45-6789"}'
done
```

```
request 1: HTTP 503 in 2.032899s
request 2: HTTP 503 in 2.024325s
request 3: HTTP 503 in 2.020406s
request 4: HTTP 503 in 0.015307s
```

What to point out:

- Requests 1 to 3 wait two seconds for the AI, fail, and get the fallback `{"answer":"Service Busy"}`.
- The third consecutive failure opens the circuit. Request 4 is answered in milliseconds: the AI was not called.
- This is deterministic: the failure rate is 1, so there is no chance involved.

The four requests must be sent within 30 seconds of each other's failures, which the loop does. After 30 seconds with the circuit open, the next request is let through as a single probe and takes two seconds again.

All four requests were audited, with the reason for each fallback:

```sh
docker compose exec api node -e "const {records}=JSON.parse(require('node:fs').readFileSync('data/audit-log.json','utf8')); console.log(records.map(r=>r.userId+' '+r.outcome).join('\n'))"
```

```
demo-user-1 answered
demo-user-2 ai_failure
demo-user-2 ai_failure
demo-user-2 ai_failure
demo-user-2 circuit_open
```

The first line is the record from step 2: the restart preserved it.

## 6. Back to normal (30 s)

Start the service again without the override. Compose recreates the container with the normal settings, and the new process starts with a closed circuit.

```sh
docker compose up -d
```

```sh
curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' \
  -X POST http://localhost:3100/secure-inquiry \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo-user-3","message":"Is the service back?"}'
```

```
{"answer":"Generated Answer"}
HTTP 200 in 2.030595s
```

Be precise about this in the recording: the circuit is closed because the process restarted, not because it recovered. Recovery inside one process (the probe succeeding and the circuit closing) is shown by `npm run demo`, whose mock can be switched while the server keeps running.

## After recording

Stop the demo and keep its audit volume:

```sh
docker compose down
```

Or stop it and delete the demo's audit data. With `COMPOSE_PROJECT_NAME` set as above, `-v` removes only `secure-inquiry-demo_audit-data`:

```sh
docker compose down -v
```

Then close the terminal, or clear the two variables so later Compose commands use the default project again:

```sh
unset COMPOSE_PROJECT_NAME HOST_PORT
```

## If something differs

| What you see | Cause |
| --- | --- |
| `curl` cannot connect right after `up -d` | The server needs a moment to start. Repeat the command. |
| The container exits at once | `ENCRYPTION_KEY` is missing or invalid in `.env`. `docker compose logs api` names the problem without printing the value. |
| Step 2 answers instantly | `.env` sets `MOCK_AI_DELAY_MS=0`. |
| Step 2 or step 6 returns 503 | `.env` sets `MOCK_AI_FAILURE_RATE` above 0, or the container from step 5 is still running: run `docker compose up -d` again. |
| Port 3100 is taken | Choose another in the `export` line and use it in every `curl` command. |
| Step 4 shows more than one record | The demo volume has records from an earlier run. Run `docker compose down -v` and start again. |
