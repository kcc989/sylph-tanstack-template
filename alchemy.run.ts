import { deriveObjectRecoveryToken } from "./scripts/sylph-object-token"
import { queueConsumerEnabled } from "./scripts/sylph-queue-consumers"
import { sylphState } from "./scripts/sylph-broker"
import * as Redacted from "effect/Redacted"
import {
  applicationBucketBindings,
  managedKvBindings,
  managedQueueBindings,
  managedDurableObjectBindings,
  sylphResources,
  sylphSecrets,
} from "./scripts/sylph-resources"
import * as Alchemy from "alchemy"
import { adopt } from "alchemy/AdoptPolicy"
import { retain } from "alchemy/RemovalPolicy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

const resources = process.env.SYLPH_RESOURCE_PREFIX
  ? sylphResources(process.env)
  : null
const applicationSecrets = sylphSecrets(process.env.SYLPH_PROJECT_SECRETS)

const Database = Cloudflare.D1.Database("Database", {
  migrations: "migrations",
  name: resources?.databaseName,
}).pipe(adopt(false), retain(process.env.SYLPH_DEPLOYMENT === "production"))

const RecoveryControl = Cloudflare.D1.Database("RecoveryControl", {
  migrations: "recovery-migrations",
  name: resources?.controlDatabaseName,
}).pipe(adopt(false), retain())

const RecoveryDrill = Cloudflare.D1.Database("RecoveryDrill", {
  migrations: "migrations",
  name: resources?.drillDatabaseName,
}).pipe(adopt(false), retain())

const ApplicationBuckets = Object.fromEntries(
  Object.keys(applicationBucketBindings).map((binding) => [
    binding,
    Cloudflare.R2.Bucket(`ApplicationBucket-${binding}`, {
      name: resources?.bucketBindings[binding],
    }).pipe(
      adopt(false),
      retain(process.env.SYLPH_DEPLOYMENT === "production")
    ),
  ])
)

const ManagedKvCaches = Object.fromEntries(
  Object.keys(managedKvBindings).map((binding) => [
    binding,
    Cloudflare.KV.Namespace(`ManagedKv-${binding}`, {
      title: resources?.kvBindings[binding],
    }).pipe(
      adopt(false),
      retain(process.env.SYLPH_DEPLOYMENT === "production")
    ),
  ])
)
const ManagedQueues = Object.fromEntries(
  Object.keys(managedQueueBindings).map((binding) => [
    binding,
    Cloudflare.Queues.Queue(`ManagedQueue-${binding}`, {
      name: resources?.queueBindings[binding],
    }).pipe(
      adopt(false),
      retain(process.env.SYLPH_DEPLOYMENT === "production")
    ),
  ])
)

const RecoveryBucketDrill = Object.keys(applicationBucketBindings).length
  ? Cloudflare.R2.Bucket("RecoveryBucketDrill", {
      name: resources?.drillBucketName,
    }).pipe(adopt(false), retain())
  : undefined

export class Website extends Cloudflare.Website.Vite<Website>()(
  "Website",
  Effect.gen(function* () {
    const objectToken =
      process.env.SYLPH_DEPLOYMENT === "production" &&
      Object.keys(managedDurableObjectBindings).length
        ? yield* Effect.promise(() =>
            deriveObjectRecoveryToken(process.env.SYLPH_RECOVERY_KEY ?? "")
          )
        : ""
    const database = yield* Database
    const recoveryControl = yield* RecoveryControl
    const buckets = yield* Effect.all(ApplicationBuckets)
    const kv = yield* Effect.all(ManagedKvCaches)
    const queues = yield* Effect.all(ManagedQueues)

    return {
      name: resources?.workerName,
      domain: resources?.hostname
        ? { name: resources.hostname, zoneId: resources.zoneId }
        : undefined,
      main: "src/worker.ts",
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
      },
      compatibility: {
        flags: ["nodejs_compat"],
      },
      env: {
        ...Object.fromEntries(
          Object.entries(applicationSecrets).map(([name, value]) => [
            name,
            Redacted.make(value),
          ])
        ),
        ...Object.fromEntries(
          Object.entries(managedDurableObjectBindings).map(
            ([binding, value]) => [
              binding,
              Cloudflare.DurableObject(binding, { className: value.className }),
            ]
          )
        ),
        ...buckets,
        ...kv,
        ...queues,
        SYLPH_MANAGED_QUEUE_NAMES: JSON.stringify(
          Object.fromEntries(
            Object.entries(queues).map(([binding, queue]) => [
              binding,
              queue.queueName,
            ])
          )
        ),
        ...(Object.keys(managedDurableObjectBindings).length
          ? { SYLPH_RECOVERY_OBJECT_TOKEN: Redacted.make(objectToken) }
          : {}),
        BETTER_AUTH_SECRET: Config.redacted("BETTER_AUTH_SECRET"),
        DB: database,
        SYLPH_RECOVERY_CONTROL: recoveryControl,
        SYLPH_RECOVERY_VERIFY_TOKEN:
          process.env.SYLPH_DEPLOYMENT === "production"
            ? Config.redacted("SYLPH_RECOVERY_VERIFY_TOKEN")
            : Config.redacted("SYLPH_RECOVERY_VERIFY_TOKEN").pipe(
                Config.withDefault(Redacted.make(""))
              ),
        SYLPH_RELEASE_ID: Config.string("SYLPH_RELEASE_ID").pipe(
          Config.withDefault("local")
        ),
        SYLPH_CHECKPOINT: Config.string("SYLPH_CHECKPOINT").pipe(
          Config.withDefault("")
        ),
        SYLPH_DEPLOYMENT: Config.string("SYLPH_DEPLOYMENT").pipe(
          Config.withDefault("local")
        ),
      },
    }
  })
) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>

const stackName = (project: string | undefined) => {
  const slug = (project ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return slug ? `sylph-${slug}` : "sylph-tanstack-template"
}

export default Alchemy.Stack(
  resources?.prefix ?? stackName(process.env.SYLPH_PROJECT),
  {
    providers: Cloudflare.providers(),
    state: sylphState(),
  },
  Effect.gen(function* () {
    yield* RecoveryDrill
    if (RecoveryBucketDrill) yield* RecoveryBucketDrill
    if (process.env.SYLPH_BOOTSTRAP_RECOVERY === "1") {
      yield* Database
      yield* RecoveryControl
      yield* Effect.all(ApplicationBuckets)
      yield* Effect.all(ManagedKvCaches)
      yield* Effect.all(ManagedQueues)
      return { url: "" }
    }
    const website = yield* Website.pipe(adopt(false))
    for (const [binding, resource] of Object.entries(ManagedQueues)) {
      if (!queueConsumerEnabled(binding)) continue
      const queue = yield* resource
      yield* Cloudflare.Queues.Consumer(`ManagedQueueConsumer-${binding}`, {
        queueId: queue.queueId,
        scriptName: website.workerName,
        settings: { batchSize: 10, maxConcurrency: 1 },
      }).pipe(adopt(false))
    }

    return {
      url: website.url.as<string>(),
    }
  })
)
