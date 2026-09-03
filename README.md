# Sylph TanStack template

A starting point for Cloudflare Workers applications built with:

- [TanStack Start](https://tanstack.com/start) for routing, server functions, and SSR
- [shadcn/ui](https://ui.shadcn.com) components on Tailwind CSS v4
- [Effect](https://effect.website) v4 for typed services and schemas
- [Better Auth](https://better-auth.com) with email and password sign-in on D1
- [Alchemy](https://alchemy.run) v2 for infrastructure as TypeScript

It satisfies the Sylph Check contract out of the box, so a Project created from it can be checked, previewed, and deployed by Sylph immediately.

## Scripts

| Script | Purpose |
|---|---|
| `bun run dev` | Run the app locally through `alchemy dev` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Oxlint with warnings denied |
| `bun run test` | Bun tests |
| `bun run build` | Vite build; also regenerates `src/routeTree.gen.ts` |
| `bun run sylph:preview` | Deploy a Preview stage and print `SYLPH_PREVIEW_URL=` |
| `bun run sylph:preview:destroy` | Destroy the Preview stage for the current checkpoint |
| `bun run sylph:deploy` | Deploy the production stage and print `SYLPH_PRODUCTION_URL=` |

## Local development

Copy `.env.example` to `.env` and provide `BETTER_AUTH_SECRET`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`. Then:

```sh
bun install
bun run dev
```

Alchemy reads `.env` before the process environment.

## How Sylph deploys it

Sylph runs the Check stages in a Cloudflare CI sandbox with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SYLPH_PROJECT`, `SYLPH_CHECKPOINT`, and `SYLPH_DEPLOYMENT` set. The Alchemy stack is named `sylph-<SYLPH_PROJECT>` so every Project forked from this template gets its own Workers, database, and state. Without `SYLPH_PROJECT` the stack is `sylph-tanstack-template`. `scripts/sylph-deploy.ts` maps the deployment variables onto an Alchemy stage:

| `SYLPH_DEPLOYMENT` | Stage | Printed |
|---|---|---|
| `preview` | `preview-<first 12 characters of the checkpoint>` | `SYLPH_PREVIEW_URL=https://...` |
| `production` | `production` | `SYLPH_PRODUCTION_URL=https://...` |

Preview deployments generate a throwaway `BETTER_AUTH_SECRET` when none is provided. Production deployments require one in the environment and fail with a clear message otherwise.

Each Preview stage creates its own D1 database. Sylph deletes the Preview Worker after the retention period; run `bun run sylph:preview:destroy` with the same `SYLPH_CHECKPOINT` to remove the whole stage, including the database.

## Layout

```text
alchemy.run.ts          Cloudflare resources: the Website Worker and its D1 database
migrations/             D1 migrations applied by Alchemy on deploy
scripts/sylph-deploy.ts Stage selection and URL reporting for Sylph
src/routes/             File-based routes, including /api/auth/$
src/functions/          TanStack Start server functions
src/server/             Better Auth, session middleware, and Effect services
src/db/schema.ts        Drizzle schema for Better Auth
src/components/ui/      shadcn/ui components
```
