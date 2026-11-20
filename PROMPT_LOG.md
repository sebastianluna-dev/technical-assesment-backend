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
