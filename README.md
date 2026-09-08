# Sylph TanStack template

A starting point for Cloudflare Workers applications built with:

- [TanStack Start](https://tanstack.com/start) for routing, server functions, and SSR
- [shadcn/ui](https://ui.shadcn.com) components on Tailwind CSS v4
- [Effect](https://effect.website) v4 for typed services and schemas
- [Better Auth](https://better-auth.com) with email and password sign-in on D1
- [Alchemy](https://alchemy.run) v2 for infrastructure as TypeScript

Version 0.3.0 implements the Sylph Check and release recovery contracts. Production release requires a successful isolated provider restore drill; local tests do not establish deployed recovery proof.

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

Sylph runs the Check stages in a Cloudflare CI sandbox with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SYLPH_PROJECT`, `SYLPH_CHECKPOINT`, and `SYLPH_DEPLOYMENT` set. Sylph provides a reserved `SYLPH_RESOURCE_PREFIX` for the Alchemy stack and all resources. Production names are stable per Project; Preview names are isolated per Check attempt. Outside Sylph, the local stack name derives from `SYLPH_PROJECT` or defaults to `sylph-tanstack-template`. `scripts/sylph-deploy.ts` maps the deployment variables onto an Alchemy stage:

| `SYLPH_DEPLOYMENT` | Stage | Printed |
|---|---|---|
| `preview` | `preview-<first 12 characters of the checkpoint>` | `SYLPH_PREVIEW_URL=https://...` |
| `production` | `production` | `SYLPH_PRODUCTION_URL=https://...` |

Preview deployments generate a throwaway `BETTER_AUTH_SECRET` when none is provided. Production deployments require one in the environment and fail with a clear message otherwise.

Each Preview stage creates isolated application state. Recovery-control and drill resources have retention policies. Destruction does not automatically remove retained recovery copies; cleanup needs a separate approved operation.

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

## Release recovery

The default plan contains one Worker, one application D1 database, one recovery-control D1 database, and one retained D1 drill database. Every application request passes through the shared durable writer gate in `src/worker.ts`. All writers must use that gate and finish their storage operations before their request completes. Scheduled tasks, background writes, public bucket writers, and writers outside the declared group are not supported.

Before a first production release, prepare checks that every declared Worker is absent before Alchemy can apply migrations. Bootstrap provisions the declared storage without publishing the Worker. Prepare runs the isolated D1 restore drill against the application schema. Later releases check the live baseline identity, pause and drain writers, and capture an immutable recovery group with exact deployed secret versions. Capture and restore verify provider data independently of the emitted receipt. Recovery validates a complete fresh undo group before changing application state. Failed or uncertain restore operations retain the pause and cannot be replayed automatically.

The private probe verifies the paused deployment before resume. Public homepage identity and application journeys run after resume. `SYLPH_RECOVERY_KEY` stays in CI, and decrypted application secrets remain in the deploy process memory. Recovery-control storage is never part of application restore.

### Optional R2 application storage

Declare bucket binding names and suffixes in `applicationBucketBindings` in `scripts/sylph-resources.ts`, for example:

```ts
export const applicationBucketBindings: Readonly<Record<string, string>> = {
  UPLOADS: "uploads",
}
```

The same declaration supplies the plan, Alchemy resources, Worker bindings, and recovery topology. Alchemy names the example bucket `<reserved-prefix>-uploads` and binds it as `UPLOADS` to the guarded Worker. It also creates a retained `<reserved-prefix>-recovery-drill` R2 bucket, separate from application storage and never bound to the Worker. No additional environment setting is needed. Changing this infrastructure on an existing live Project requires a reviewed compatible migration; ordinary release review rejects such changes.

First prepare automatically drills R2 restore in the retained scratch bucket. The drill checks bytes, HTTP metadata and custom metadata, and verifies that all declared application buckets remain unchanged. Production capture requires recorded restore proof. Group receipts include every application bucket as `object-storage`; omission, extra resources, or a foreign manifest fails restore before mutation.

R2 recovery is bounded to 20 application buckets, 10,000 objects per bucket, 16 MiB per object, 64 MiB of object bytes per bucket, and 96 MiB of encoded snapshot data per bucket. Encrypted immutable chunks are stored in recovery-control D1. Restore verifies complete pagination, bytes, HTTP and custom metadata, and storage class. Object keys with `.` or `..` path segments, customer-provided encryption keys, lifecycle rules that delete objects or change their storage class, locks, Sippy, event notifications, and uncontrolled writers are unsupported. Validated multipart-upload abort rules are allowed because they do not alter completed objects. KV recovery is not provided.

Local tests exercise actual hook processes with SQLite and local object-provider fixtures, including combined D1/R2 restore. These tests are not Cloudflare deployment evidence. Publication, production deployment, destructive restore, and retained-resource cleanup require explicit approval.
