import { managedQueueBindings } from "./sylph-resources"
import { reviewQueueConsumerTransition } from "./sylph-queue-consumers"
import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { isDeepStrictEqual } from "node:util"
import type { sylphResources } from "./sylph-resources"

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim()

const RecoveryServiceBinding = Schema.Struct({
  type: Schema.Literals([
    "service",
    "r2_bucket",
    "kv_namespace",
    "queue",
    "durable_object_namespace",
  ]),
  name: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,127}$/)),
  target: Schema.NonEmptyString,
})
const RecoveryPlanResource = Schema.Struct({
  kind: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  purpose: Schema.optional(Schema.String),
  worker: Schema.optional(Schema.String),
  className: Schema.optional(Schema.String),
  bindings: Schema.optional(Schema.Array(RecoveryServiceBinding)),
})
type RecoveryPlanResources = Omit<
  ReturnType<typeof sylphResources>,
  "recoveryWorkers"
> & {
  recoveryWorkers: readonly {
    workerName: string
    databaseNames: readonly string[]
    serviceTargets: readonly string[]
    durableObjects?: readonly {
      bindingName: string
      className: string
      objectNames: readonly string[]
    }[]
    bucketNames?: readonly string[]
    managedKv?: readonly {
      bindingName: string
      namespaceName: string
      databaseName: string
    }[]
    managedQueues?: readonly {
      bindingName: string
      queueName: string
      databaseName: string
    }[]
    queueConsumers?: readonly { queueName: string; databaseName: string }[]
  }[]
}

export const reviewRecoveryPlan = (
  serialized: string,
  resources: RecoveryPlanResources
) => {
  const parsed = JSON.parse(serialized)
  const proposed = Schema.decodeUnknownSync(Schema.Array(RecoveryPlanResource))(
    parsed
  )
  const workerNames = new Set(
    resources.recoveryWorkers.map((worker) => worker.workerName)
  )
  if (workerNames.size !== resources.recoveryWorkers.length)
    throw new Error("Guarded Worker names must be unique")
  const guardedBuckets = [
    ...new Set(
      resources.recoveryWorkers.flatMap((worker) => worker.bucketNames ?? [])
    ),
  ].sort()
  if (!isDeepStrictEqual(guardedBuckets, [...resources.bucketNames].sort()))
    throw new Error(
      "Every application bucket requires a declared guarded Worker binding"
    )
  const expected: Array<typeof RecoveryPlanResource.Type> = [
    ...resources.recoveryWorkers.map((worker) => {
      const bindings =
        proposed.find(
          (resource) =>
            resource.kind === "worker" && resource.name === worker.workerName
        )?.bindings ?? []
      const serviceBindings = bindings.filter(
        (binding) => binding.type === "service"
      )
      const bucketBindings = bindings.filter(
        (binding) => binding.type === "r2_bucket"
      )
      const expectedBuckets = Object.entries(resources.bucketBindings)
        .filter(([, target]) => worker.bucketNames?.includes(target))
        .map(([name, target]) => ({ type: "r2_bucket", name, target }))
      const expectedObjects = resources.durableObjects.map((item) => ({
        type: "durable_object_namespace",
        name: item.bindingName,
        target: `${worker.workerName}/${item.className}`,
      }))
      const expectedKv = Object.entries(resources.kvBindings).map(
        ([name, target]) => ({ type: "kv_namespace", name, target })
      )
      const expectedQueues = Object.entries(resources.queueBindings).map(
        ([name, target]) => ({ type: "queue", name, target })
      )
      if (
        !isDeepStrictEqual(
          bindings.filter((item) => item.type === "durable_object_namespace"),
          expectedObjects
        ) ||
        !isDeepStrictEqual(
          worker.durableObjects ?? [],
          resources.durableObjects
        ) ||
        !isDeepStrictEqual(
          bindings.filter((item) => item.type === "kv_namespace"),
          expectedKv
        ) ||
        !isDeepStrictEqual(
          bindings.filter((item) => item.type === "queue"),
          expectedQueues
        ) ||
        !isDeepStrictEqual(
          worker.managedKv ?? [],
          expectedKv.map((item) => ({
            bindingName: item.name,
            namespaceName: item.target,
            databaseName: resources.databaseName,
          }))
        ) ||
        !isDeepStrictEqual(
          worker.managedQueues ?? [],
          expectedQueues.map((item) => ({
            bindingName: item.name,
            queueName: item.target,
            databaseName: resources.databaseName,
          }))
        ) ||
        !isDeepStrictEqual(
          worker.queueConsumers ?? [],
          expectedQueues.map((item) => ({
            queueName: item.target,
            databaseName: resources.databaseName,
          }))
        ) ||
        !isDeepStrictEqual(bucketBindings, expectedBuckets) ||
        !isDeepStrictEqual(
          [...new Set(worker.bucketNames ?? [])].sort(),
          expectedBuckets.map((binding) => binding.target).sort()
        ) ||
        worker.serviceTargets.some((target) => !workerNames.has(target)) ||
        new Set(worker.serviceTargets).size !== worker.serviceTargets.length ||
        new Set(bindings.map((binding) => binding.name)).size !==
          bindings.length ||
        !isDeepStrictEqual(
          serviceBindings.map((binding) => binding.target).sort(),
          [...worker.serviceTargets].sort()
        )
      )
        throw new Error(
          "Service bindings must match the exact declared guarded Worker targets; a tested recovery integration is required for other bindings"
        )
      return {
        kind: "worker",
        name: worker.workerName,
        ...(bindings.length ? { bindings } : {}),
      }
    }),
    ...[
      ...new Set(
        resources.recoveryWorkers.flatMap((worker) => worker.databaseNames)
      ),
    ].map((name) => ({ kind: "d1", name })),
    {
      kind: "d1",
      name: resources.controlDatabaseName,
      purpose: "recovery_control",
    },
    {
      kind: "d1",
      name: resources.drillDatabaseName,
      purpose: "recovery_control",
    },
  ]
  expected.push(...resources.bucketNames.map((name) => ({ kind: "r2", name })))
  if (resources.drillBucketName)
    expected.push({
      kind: "r2",
      name: resources.drillBucketName,
      purpose: "recovery_control",
    })
  expected.push(
    ...Object.values(resources.kvBindings).map((name) => ({ kind: "kv", name }))
  )
  expected.push(
    ...Object.values(resources.queueBindings).map((name) => ({
      kind: "queue",
      name,
    }))
  )
  expected.push(
    ...resources.durableObjects.map((item) => ({
      kind: "durable_object",
      name: `${resources.workerName}/${item.className}`,
      worker: resources.workerName,
      className: item.className,
    }))
  )
  if (resources.hostname)
    expected.push({ kind: "domain", name: resources.hostname })
  if (!isDeepStrictEqual(parsed, expected))
    throw new Error(
      "This recovery adapter requires the declared guarded Worker, application D1, recovery-control and isolated drill plan. Additional resources or bindings require a tested recovery integration."
    )
}

export const reviewMigrationSql = (sql: string, emptyBaseline = false) => {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
  if (
    !statements.length ||
    statements.some(
      (statement) =>
        (!emptyBaseline && /^CREATE\s+UNIQUE\s+INDEX/i.test(statement)) ||
        !/^CREATE\s+(?:TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z_][a-z0-9_]*\s*\(|(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z_][a-z0-9_]*\s+ON\s+[a-z_][a-z0-9_]*\s*\()/i.test(
          statement
        )
    )
  )
    throw new Error(
      "Automatic migration review supports only new tables and nonunique indexes on existing data. Uniqueness changes require data compatibility verification."
    )
}

export const reviewMigrations = (
  baseCommit: string | null,
  commit: string,
  liveCommit = baseCommit,
  verifiedRecoveryTarget?: string
) => {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    (baseCommit && !/^[a-f0-9]{40}$/.test(baseCommit)) ||
    (liveCommit && !/^[a-f0-9]{40}$/.test(liveCommit))
  )
    throw new Error("Release commits must be full immutable Git revisions")
  if (verifiedRecoveryTarget && verifiedRecoveryTarget !== commit)
    throw new Error("Verified recovery target differs from release checkout")
  if (git("rev-parse", "HEAD") !== commit)
    throw new Error("Release checkout does not match SYLPH_CHECKPOINT")
  if (liveCommit) {
    for (const path of [
      "recovery-migrations",
      "alchemy.run.ts",
      "scripts/sylph-deploy.ts",
      "scripts/sylph-resources.ts",
      "scripts/sylph-recovery-config.ts",
      "src/worker.ts",
      "src/managed.ts",
      "src/managed-object.ts",
      "src/managed-object-routing.ts",
      "scripts/sylph-object-config.ts",
      "scripts/sylph-queue-replay.ts",
      "scripts/sylph-queue-consumers.ts",
      "scripts/sylph-object-token.ts",
      "src/recovery",
    ]) {
      if (
        git("ls-tree", liveCommit, "--", path) !==
        git("ls-tree", commit, "--", path)
      )
        throw new Error(
          `Recovery infrastructure changed: ${path}. Verify a compatible recovery integration before release.`
        )
    }
  }
  if (liveCommit)
    reviewQueueConsumerTransition(
      git("ls-tree", liveCommit, "--", "scripts/managed-queue-consumers.json")
        ? git("show", `${liveCommit}:scripts/managed-queue-consumers.json`)
        : "{}",
      git("ls-tree", commit, "--", "scripts/managed-queue-consumers.json")
        ? git("show", `${commit}:scripts/managed-queue-consumers.json`)
        : "{}",
      Object.keys(managedQueueBindings),
      verifiedRecoveryTarget === commit
    )
  const files = git("ls-tree", "-r", "--name-only", commit, "migrations")
    .split("\n")
    .filter(Boolean)
  const previous = baseCommit
    ? git("ls-tree", "-r", "--name-only", baseCommit, "migrations")
        .split("\n")
        .filter(Boolean)
    : []
  for (const file of previous) {
    if (
      !files.includes(file) ||
      git("rev-parse", `${baseCommit}:${file}`) !==
        git("rev-parse", `${commit}:${file}`)
    )
      throw new Error(`Existing migration changed or removed: ${file}`)
  }
  const added = files.filter((file) => !previous.includes(file))
  for (const file of added) {
    if (!file.endsWith(".sql"))
      throw new Error(`Unsupported migration file: ${file}`)
    reviewMigrationSql(git("show", `${commit}:${file}`), !baseCommit)
  }
  return `Immutable migration history verified; ${added.length} additive migration files checked against ${baseCommit ?? "empty baseline"}`
}
