# technical-assessment-backend

Backend for the technical assessment: Node.js 24 (LTS), Express 5 and TypeScript, tested with Vitest and Supertest.

## Requirements

- Node.js 24 or later (`.nvmrc` pins the major version)
- npm

## Setup

```sh
npm install
cp .env.example .env   # optional; defaults are NODE_ENV=development and PORT=3000
```

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

## Layout

```
src/
  app.ts           createApp(): builds the Express app, does not listen
  server.ts        loads the environment and starts the HTTP server
  config/          environment loading and validation
  routes/          route definitions
  middleware/      (empty for now)
  services/        redaction.ts: redactMessage()
  repositories/    (empty for now)
tests/             Vitest + Supertest tests
docs/DECISIONS.md  implementation decisions
docs/REDACTION.md  redaction rules, limits and false positives
PROMPT_LOG.md      prompts given to the AI assistant and their outcomes
```
