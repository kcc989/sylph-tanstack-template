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

Sylph verifies every Checkpoint with these package scripts, in this order: `typecheck`, `lint`, `test`, `build`, then `sylph:plan` and `sylph:preview`. Production uses build and planning, followed by migration review, recovery capture, deployment, verification, and writer resume. Keep every required script working. Production also requires `sylph:release:review`, `sylph:release:prepare`, `sylph:release:restore`, `sylph:release:verify`, and `sylph:release:resume`.

- `scripts/sylph-deploy.ts` deploys an Alchemy stage named from `SYLPH_DEPLOYMENT` and `SYLPH_CHECKPOINT` and prints `SYLPH_PREVIEW_URL=` or `SYLPH_PRODUCTION_URL=`.
- `sylph:plan` declares resource names without Cloudflare credentials. `alchemy.run.ts` uses the reserved `SYLPH_RESOURCE_PREFIX` for the stack, Worker, and D1 database. Preview prefixes are unique to each Check attempt; production prefixes are stable per Project. Do not adopt existing resources or create resources outside the declared plan.
- The home page renders `SYLPH_CHECKPOINT=<commit>` and `SYLPH_DEPLOYMENT=<kind>` so the Preview browser check can confirm it is looking at the right deployment. Keep that text on the root route.
- `src/routeTree.gen.ts` is committed because `typecheck` runs before `build`. Regenerate it with `bun run build` after adding or renaming routes, then commit it.

## Conventions

- Do not add comments, including JSDoc, TODOs, or commented-out code. Express intent with names, types, and schemas.
- Add a D1 table by editing `src/db/schema.ts` and writing the matching SQL migration in `migrations/`. Alchemy applies migrations on deploy.
- New Cloudflare resources go in `alchemy.run.ts` and are passed to the Worker through `env`. Declare their types in `src/env.d.ts`.
- Read a binding with `import { env } from "cloudflare:workers"` inside server code only.
- Secrets come from the environment through `Config.redacted` in `alchemy.run.ts`. Never commit `.env`.

## Working in Sylph

Use native file tools and shell commands in the Workspace sandbox. Run `bun install` to generate the lockfile after dependency changes, and run local tests as needed. After a coherent change, call `workspace_run_checks` once for an immutable Checkpoint and recorded Cloudflare CI verification, then end the Turn. Results arrive automatically. Use `workspace_preview` and `workspace_browser` to look at the deployed Preview.

## Release recovery

The Worker wraps every application request with a durable writer gate in a separate recovery-control D1 database. Keep the control database outside application restore. Application state must remain in the declared D1 databases and optional R2 buckets configured once in `applicationBucketBindings` in `scripts/sylph-resources.ts`. All application buckets are bound to the guarded Worker. Scheduled handlers, queue consumers, external storage, and background writers require a separately verified adapter before use.

Release hooks use the vendored provider integration in `src/recovery`. They read exact deployed secret versions from encrypted immutable snapshots, perform D1 Time Travel restoration, and verify data and schema fingerprints. Never replace these operations with printed receipts. `SYLPH_RECOVERY_KEY` stays in CI; it is never a Worker binding. The authenticated read-only probe checks deployment identity and live secret fingerprints while application writes are paused.

A provider restore drill is required for the current schema before capture can succeed. First production prepare verifies provider Worker absence before bootstrap. It provisions three reserved D1 databases and any declared R2 buckets through Alchemy before capture; it does not deploy a Worker. Optional R2 storage adds a retained scratch R2 bucket and its own mandatory restore drill. Publication, production deployment, and destructive restoration require explicit approval.
