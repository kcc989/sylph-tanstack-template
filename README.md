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

## Managed KV and Queues

Declare optional resources once in `scripts/sylph-resources.ts`: `managedKvBindings` maps binding names to unique resource suffixes, and `managedQueueBindings` does the same for queues. Alchemy provisions the declared bindings and attaches each Queue consumer to the guarded application Worker. Add each binding's native type to `src/env.d.ts`.

Use `managedKv(env, "SETTINGS", env.SETTINGS)` from `src/managed.ts` as the Layer for `ManagedKv`. Application D1 stores authoritative bytes, metadata, expiration, and versions. KV is a disposable cache. The managed API accepts values up to 1 MiB, UTF-8 keys up to 512 bytes, and serialized metadata up to 1024 bytes. Do not write application state directly to the native cache binding.

Use `managedQueue(env, "JOBS", env.JOBS)` as the Layer for `CloudflareRecoveryQueue`. Enqueue with a stable message ID and JSON body. Add a handler under the same binding name in `src/managed-queue-handlers.ts`. Handlers must be idempotent using the message ID; delivery can repeat after failure or recovery. Keep effects inside the declared recoverable application state. The D1 journal supports 10000 rows and 64 KiB per message. Do not send raw application payloads through the native Queue binding.

The Worker gates each consumer batch during recovery and acknowledges messages only after the handler and journal completion succeed. Before writer resume, release hooks replay pending journal IDs into the exact declared Queues. A failed replay leaves writers paused. `replayPending` is also available for explicit repair from a guarded application action.

## Registered Durable Objects

`managedDurableObjectBindings` maps each binding to an exported `className` and an explicit `objectNames` registry. The built-in `ManagedState` class in `src/managed-object.ts` stores JSON with gated `get`, `put`, and `delete` methods. Add the native namespace type to `src/env.d.ts`, use `idFromName` only with registered names, and keep the class exported from `src/worker.ts`.

Recovery joins provider namespace IDs to the authenticated Worker registry and refuses unregistered stored objects. The read-only registry accepts the verification token. Capture and restore require a separate token derived from the recovery key with a domain-separated HMAC; the raw recovery key never enters the Worker. Both routes can address only reviewed IDs. Ordinary object work must use `withRecoveryObjectGate`; do not create untracked background writes. Every ordinary method must reject IDs outside its class registry before accessing storage. A subclass of `ManagedState` must override `recoveryClassName` with its declared export name. A custom class must delegate its recovery RPC to `recoverDurableObject` and reload its in-memory caches in the required `afterRestore` callback.

The snapshot adapter covers SQLite tables, indexes, binary cells, and JSON KV storage. Its current bounds are 32 tables, 1000 rows per table, 1000 KV entries, and 4 MiB per object snapshot. Alarms, WebSockets, virtual tables, foreign keys, generated columns, and unsupported SQLite features stop capture. Register at most 100 objects across the application. New schema support requires its own verified restore drill.

Initial managed-storage releases provision infrastructure, run the D1 and optional R2 drills, pause writers, and then publish the guarded Worker. Recovery captures provider-observed state while the application remains paused. The initial object drill must restore and independently verify the registered empty state before any object recovery receipt can report a verification timestamp.

Set a declared binding to `false` in `scripts/managed-queue-consumers.json` to detach its consumer. The release requires its journal to be empty and keeps the Queue, binding, journal, and recovery topology. Managed producers reject new work while disabled. Normal releases permit detachment only; verified recovery to the selected immutable target can reattach the consumer. Detachment alone does not retire the Queue.
