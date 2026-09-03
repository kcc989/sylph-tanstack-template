# Agent guide

This is a Cloudflare Workers application built with TanStack Start, shadcn/ui, Effect, Better Auth, and Alchemy. It was created from the Sylph TanStack template.

## Stack

- TanStack Start serves the UI and server functions from `src/routes` and `src/functions`. The Worker entry is `src/worker.ts`.
- Alchemy v2 defines every Cloudflare resource in `alchemy.run.ts`. Do not add Wrangler configuration or `@cloudflare/vite-plugin`.
- Better Auth handles sign-up and sign-in with email and password. Its tables live in `src/db/schema.ts` and `migrations/`, and the handler is mounted at `/api/auth/$`.
- Effect models server-side capabilities: Schema for boundaries, `Context.Service` for capabilities, Layers for implementations, and `Effect.gen` for programs.
- shadcn/ui components live in `src/components/ui`. Add more with `bunx shadcn add <component>`.
- Oxlint lints and Oxfmt formats. Do not add ESLint or Prettier.

## Check contract

Sylph verifies every Checkpoint with these package scripts, in this order: `typecheck`, `lint`, `test`, `build`, then `sylph:preview`. Production uses `build` then `sylph:deploy`. Keep all six scripts working.

- `scripts/sylph-deploy.ts` deploys an Alchemy stage named from `SYLPH_DEPLOYMENT` and `SYLPH_CHECKPOINT` and prints `SYLPH_PREVIEW_URL=` or `SYLPH_PRODUCTION_URL=`.
- The home page renders `SYLPH_CHECKPOINT=<commit>` and `SYLPH_DEPLOYMENT=<kind>` so the Preview browser check can confirm it is looking at the right deployment. Keep that text on the root route.
- `src/routeTree.gen.ts` is committed because `typecheck` runs before `build`. Regenerate it with `bun run build` after adding or renaming routes, then commit it.

## Conventions

- Do not add comments, including JSDoc, TODOs, or commented-out code. Express intent with names, types, and schemas.
- Add a D1 table by editing `src/db/schema.ts` and writing the matching SQL migration in `migrations/`. Alchemy applies migrations on deploy.
- New Cloudflare resources go in `alchemy.run.ts` and are passed to the Worker through `env`. Declare their types in `src/env.d.ts`.
- Read a binding with `import { env } from "cloudflare:workers"` inside server code only.
- Secrets come from the environment through `Config.redacted` in `alchemy.run.ts`. Never commit `.env`.

## Working in Sylph

Sylph runs installs, tests, builds, and deploys in Cloudflare CI, not in the workspace. After a coherent change, call `workspace_run_checks` and wait for the result. Use `workspace_preview` and `workspace_browser` to look at the deployed Preview.
