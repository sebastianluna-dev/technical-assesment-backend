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
