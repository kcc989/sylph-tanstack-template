import { queueConsumerFlags } from "./sylph-queue-consumers"
import { Schema } from "effect"

const SecretValues = Schema.Record(Schema.String, Schema.String)

type RecoveryWorker = {
  workerName: string
  databaseNames: string[]
  serviceTargets: string[]
  durableObjects?: {
    bindingName: string
    className: string
    objectNames: readonly string[]
  }[]
  bucketNames?: string[]
  managedKv?: {
    bindingName: string
    namespaceName: string
    databaseName: string
  }[]
  managedQueues?: {
    bindingName: string
    queueName: string
    databaseName: string
  }[]
  queueConsumers?: { queueName: string; databaseName: string }[]
}

export const applicationBucketBindings: Readonly<Record<string, string>> = {}
export const managedKvBindings: Readonly<Record<string, string>> = {}
export const managedQueueBindings: Readonly<Record<string, string>> = {}
export const managedDurableObjectBindings: Readonly<
  Record<string, { className: string; objectNames: readonly string[] }>
> = {}

export const sylphResources = (
  environment: NodeJS.ProcessEnv,
  declaredBuckets = applicationBucketBindings,
  declaredKv = managedKvBindings,
  declaredQueues = managedQueueBindings,
  declaredObjects = managedDurableObjectBindings
) => {
  const prefix = environment.SYLPH_RESOURCE_PREFIX ?? ""
  if (!/^sylph-[a-f0-9]{24}$/.test(prefix))
    throw new Error(
      "SYLPH_RESOURCE_PREFIX must be provided by Sylph resource ownership checks"
    )
  const hostname = environment.SYLPH_CUSTOM_DOMAIN ?? ""
  const zoneId = environment.SYLPH_CUSTOM_DOMAIN_ZONE ?? ""
  if (hostname && (environment.SYLPH_DEPLOYMENT !== "production" || !zoneId))
    throw new Error(
      "Custom domains require a production deployment and a Cloudflare zone ID"
    )
  const entries = Object.entries({
    ...declaredBuckets,
    ...declaredKv,
    ...declaredQueues,
  })
  if (
    entries.length > 20 ||
    entries.length !==
      Object.keys(declaredBuckets).length +
        Object.keys(declaredKv).length +
        Object.keys(declaredQueues).length ||
    new Set(entries.map(([, suffix]) => suffix)).size !== entries.length ||
    entries.some(
      ([binding, suffix]) =>
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(binding) ||
        /^(SYLPH_|CLOUDFLARE_|CF_|ALCHEMY_|BETTER_AUTH_SECRET$|DB$|ASSETS$)/.test(
          binding
        ) ||
        !/^[a-z][a-z0-9-]{0,27}[a-z0-9]$/.test(suffix) ||
        ["web", "db", "recovery", "recovery-drill"].includes(suffix)
    )
  )
    throw new Error(
      "Application storage declarations require unique reserved names and binding names"
    )
  const bucketBindings = Object.fromEntries(
    Object.entries(declaredBuckets).map(([binding, suffix]) => [
      binding,
      `${prefix}-${suffix}`,
    ])
  )
  const kvBindings = Object.fromEntries(
    Object.entries(declaredKv).map(([binding, suffix]) => [
      binding,
      `${prefix}-${suffix}`,
    ])
  )
  if (
    Object.keys(queueConsumerFlags).some(
      (binding) => !Object.hasOwn(declaredQueues, binding)
    )
  )
    throw new Error(
      "Queue consumer flags reference an undeclared Queue binding"
    )
  const queueBindings = Object.fromEntries(
    Object.entries(declaredQueues).map(([binding, suffix]) => [
      binding,
      `${prefix}-${suffix}`,
    ])
  )
  const durableObjects = Object.entries(declaredObjects).map(
    ([bindingName, value]) => ({ bindingName, ...value })
  )
  if (
    durableObjects.length > 20 ||
    new Set(durableObjects.map((item) => item.className)).size !==
      durableObjects.length ||
    durableObjects.flatMap((item) => item.objectNames).length > 100 ||
    durableObjects.some(
      (item) =>
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(item.bindingName) ||
        /^(SYLPH_|CLOUDFLARE_|CF_|ALCHEMY_|BETTER_AUTH_SECRET$|DB$|ASSETS$)/.test(
          item.bindingName
        ) ||
        Object.hasOwn(
          { ...declaredBuckets, ...declaredKv, ...declaredQueues },
          item.bindingName
        ) ||
        !/^[A-Z][A-Za-z0-9]{0,63}$/.test(item.className) ||
        item.objectNames.length < 1 ||
        new Set(item.objectNames).size !== item.objectNames.length ||
        item.objectNames.some((name) => !name || name.length > 128)
    )
  )
    throw new Error(
      "Managed Durable Objects require unique classes, bindings and a bounded explicit object registry"
    )
  const bucketNames = Object.values(bucketBindings)
  const drillBucketName = bucketNames.length
    ? `${prefix}-recovery-drill`
    : undefined
  const workerBindings = [
    ...Object.entries(bucketBindings).map(([name, target]) => ({
      type: "r2_bucket",
      name,
      target,
    })),
    ...Object.entries(kvBindings).map(([name, target]) => ({
      type: "kv_namespace",
      name,
      target,
    })),
    ...durableObjects.map((item) => ({
      type: "durable_object_namespace",
      name: item.bindingName,
      target: `${prefix}-web/${item.className}`,
    })),
    ...Object.entries(queueBindings).map(([name, target]) => ({
      type: "queue",
      name,
      target,
    })),
  ]
  const plan: Array<{
    kind: string
    name: string
    purpose?: string
    bindings?: typeof workerBindings
    worker?: string
    className?: string
  }> = [
    {
      kind: "worker",
      name: `${prefix}-web`,
      ...(workerBindings.length ? { bindings: workerBindings } : {}),
    },
    { kind: "d1", name: `${prefix}-db` },
    { kind: "d1", name: `${prefix}-recovery`, purpose: "recovery_control" },
    {
      kind: "d1",
      name: `${prefix}-recovery-drill`,
      purpose: "recovery_control",
    },
  ]
  plan.push(...bucketNames.map((name) => ({ kind: "r2", name })))
  if (drillBucketName)
    plan.push({
      kind: "r2",
      name: drillBucketName,
      purpose: "recovery_control",
    })
  plan.push(...Object.values(kvBindings).map((name) => ({ kind: "kv", name })))
  plan.push(
    ...Object.values(queueBindings).map((name) => ({ kind: "queue", name }))
  )
  plan.push(
    ...durableObjects.map((item) => ({
      kind: "durable_object",
      name: `${prefix}-web/${item.className}`,
      worker: `${prefix}-web`,
      className: item.className,
    }))
  )
  if (hostname) plan.push({ kind: "domain", name: hostname })
  const recoveryWorkers: RecoveryWorker[] = [
    {
      workerName: `${prefix}-web`,
      ...(durableObjects.length ? { durableObjects } : {}),
      databaseNames: [`${prefix}-db`],
      serviceTargets: [],
      ...(bucketNames.length ? { bucketNames } : {}),
      ...(Object.keys(kvBindings).length
        ? {
            managedKv: Object.entries(kvBindings).map(
              ([bindingName, namespaceName]) => ({
                bindingName,
                namespaceName,
                databaseName: `${prefix}-db`,
              })
            ),
          }
        : {}),
      ...(Object.keys(queueBindings).length
        ? {
            managedQueues: Object.entries(queueBindings).map(
              ([bindingName, queueName]) => ({
                bindingName,
                queueName,
                databaseName: `${prefix}-db`,
              })
            ),
            queueConsumers: Object.values(queueBindings).map((queueName) => ({
              queueName,
              databaseName: `${prefix}-db`,
            })),
          }
        : {}),
    },
  ]
  return {
    prefix,
    workerName: `${prefix}-web`,
    databaseName: `${prefix}-db`,
    controlDatabaseName: `${prefix}-recovery`,
    drillDatabaseName: `${prefix}-recovery-drill`,
    recoveryWorkers,
    durableObjects,
    bucketBindings,
    kvBindings,
    queueBindings,
    bucketNames,
    drillBucketName,
    hostname,
    zoneId,
    plan,
  }
}

export const sylphSecrets = (
  value: string | undefined,
  declaredBuckets = applicationBucketBindings,
  declaredKv = managedKvBindings,
  declaredQueues = managedQueueBindings,
  declaredObjects = managedDurableObjectBindings
) => {
  const secrets = Schema.decodeUnknownSync(SecretValues)(
    JSON.parse(value ?? "{}")
  )
  for (const name of Object.keys(secrets)) {
    if (
      Object.hasOwn(declaredBuckets, name) ||
      Object.hasOwn(declaredKv, name) ||
      Object.hasOwn(declaredQueues, name) ||
      Object.hasOwn(declaredObjects, name) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
      /^(SYLPH_|CLOUDFLARE_|CF_|ALCHEMY_|BETTER_AUTH_SECRET$|DB$|ASSETS$|PATH$|HOME$|NODE_OPTIONS$|BUN_OPTIONS$)/.test(
        name
      )
    )
      throw new Error(
        "Application secret name conflicts with a reserved binding"
      )
  }
  return secrets
}

if (import.meta.main)
  process.stdout.write(
    `SYLPH_RESOURCE_PLAN=${JSON.stringify(sylphResources(process.env).plan)}\n`
  )
