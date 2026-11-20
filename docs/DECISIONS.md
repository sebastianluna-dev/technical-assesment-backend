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
