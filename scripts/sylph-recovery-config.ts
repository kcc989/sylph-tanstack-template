import { deriveObjectRecoveryToken } from "./sylph-object-token"
import { Layer, Schema } from "effect"
import { CloudflareObjectRecoveryLive } from "../src/recovery/object"
import { inspectManagedObjects } from "./sylph-object-config"
import { CloudflareRecoveryGroupLive } from "../src/recovery/group"
import { CloudflareD1RecoveryLive } from "../src/recovery/recovery"
import { CloudflareR2RecoveryLive } from "../src/recovery/r2"
import { sylphResources } from "./sylph-resources"
import type {
  D1RecoveryManifest,
  D1RecoveryGroup,
} from "../src/recovery/domain"

export const requiredReleaseValue = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

export const recoveryConfiguration = async (
  needsSecretKey = true,
  options: { skipObjects?: boolean; objectURL?: string } = {}
) => {
  const accountId = requiredReleaseValue("CLOUDFLARE_ACCOUNT_ID")
  const apiToken = requiredReleaseValue("CLOUDFLARE_API_TOKEN")
  const encryptionKey = needsSecretKey
    ? requiredReleaseValue("SYLPH_RECOVERY_KEY")
    : ""
  const projectId = requiredReleaseValue("SYLPH_PROJECT_ID")
  const resources = sylphResources(process.env)
  const apiBaseUrl = `${process.env.SYLPH_CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(accountId)}`
  const response = await fetch(`${apiBaseUrl}/d1/database?per_page=1000`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error("Cannot inspect reserved databases")
  const inventory = Schema.decodeUnknownSync(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Array(
        Schema.Struct({ uuid: Schema.String, name: Schema.String })
      ),
    })
  )(await response.json())
  const databaseId = inventory.result.find(
    (database) => database.name === resources.databaseName
  )?.uuid
  const controlDatabaseId = inventory.result.find(
    (database) => database.name === resources.controlDatabaseName
  )?.uuid
  if (!databaseId || !controlDatabaseId)
    throw new Error("Reserved application and recovery databases must exist")
  const drillDatabaseId = inventory.result.find(
    (database) => database.name === resources.drillDatabaseName
  )?.uuid
  if (!drillDatabaseId)
    throw new Error("Reserved restore drill database must exist")
  const configuration = {
    accountId,
    apiToken,
    apiBaseUrl,
    controlDatabaseId,
    projectId,
    encryptionKey,
  }
  const secrets = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.String)
  )(JSON.parse(process.env.SYLPH_RECOVERY_SECRETS ?? "{}"))
  const managedInventory = async (path: string) => {
    const response = await fetch(`${apiBaseUrl}/${path}?per_page=1000`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok)
      throw new Error("Cannot inspect declared managed resources")
    return Schema.decodeUnknownSync(
      Schema.Struct({
        success: Schema.Literal(true),
        result: Schema.Array(
          Schema.Struct({
            id: Schema.optional(Schema.String),
            title: Schema.optional(Schema.String),
            queue_id: Schema.optional(Schema.String),
            queue_name: Schema.optional(Schema.String),
          })
        ),
      })
    )(await response.json()).result
  }
  const kvInventory = Object.keys(resources.kvBindings).length
    ? await managedInventory("storage/kv/namespaces")
    : []
  const queueInventory = Object.keys(resources.queueBindings).length
    ? await managedInventory("queues")
    : []
  const managedKv = Object.entries(resources.kvBindings).map(
    ([bindingName, name]) => {
      const selected = kvInventory.filter((item) => item.title === name)
      const namespaceId = selected[0]?.id
      if (selected.length !== 1 || !namespaceId)
        throw new Error("Declared managed KV namespace is missing or ambiguous")
      return { bindingName, namespaceId, databaseId }
    }
  )
  const managedQueues = Object.entries(resources.queueBindings).map(
    ([bindingName, queueName]) => {
      const selected = queueInventory.filter(
        (item) => item.queue_name === queueName
      )
      const queueId = selected[0]?.queue_id
      if (selected.length !== 1 || !queueId)
        throw new Error("Declared managed Queue is missing or ambiguous")
      return { bindingName, queueId, queueName, databaseId }
    }
  )
  let objectURL =
    options.objectURL ??
    process.env.SYLPH_PRODUCTION_URL ??
    process.env.SYLPH_BASE_URL
  if (!objectURL && !options.skipObjects && resources.durableObjects.length) {
    if (resources.hostname) objectURL = `https://${resources.hostname}`
    else {
      const response = await fetch(`${apiBaseUrl}/workers/subdomain`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok)
        throw new Error("Cannot resolve the owned object Worker URL")
      const subdomain = Schema.decodeUnknownSync(
        Schema.Struct({
          success: Schema.Literal(true),
          result: Schema.Struct({
            subdomain: Schema.String.check(
              Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
            ),
          }),
        })
      )(await response.json()).result.subdomain
      objectURL = `https://${resources.workerName}.${subdomain}.workers.dev`
    }
  }
  const objects = await inspectManagedObjects(
    {
      ...configuration,
      objectToken: () => deriveObjectRecoveryToken(encryptionKey),
      expectedCheckpoints: [
        process.env.SYLPH_BASE_COMMIT,
        process.env.SYLPH_CHECKPOINT,
      ].filter((value): value is string => Boolean(value)),
    },
    resources.workerName,
    options.skipObjects ? [] : resources.durableObjects,
    objectURL,
    process.env.SYLPH_RECOVERY_VERIFY_TOKEN ?? ""
  )
  const objectConfiguration = {
    ...configuration,
    identities: objects.identities,
    transport: objects.transport,
  }
  const objectLayer = CloudflareObjectRecoveryLive(objectConfiguration)
  const topology = {
    workers: resources.recoveryWorkers.map((worker) => ({
      workerName: worker.workerName,
      databaseIds: worker.databaseNames.map((name) => {
        const id = inventory.result.find(
          (database) => database.name === name
        )?.uuid
        if (!id) throw new Error("Declared recovery database is missing")
        return id
      }),
      serviceTargets: worker.serviceTargets,
      ...(worker.bucketNames?.length
        ? { bucketNames: worker.bucketNames }
        : {}),
      ...(objects.registrations.length
        ? { durableObjects: objects.registrations }
        : {}),
      ...(managedKv.length ? { managedKv } : {}),
      ...(managedQueues.length
        ? {
            managedQueues,
            queueConsumers: managedQueues.map(
              ({ queueId, queueName, databaseId }) => ({
                queueId,
                queueName,
                databaseId,
              })
            ),
          }
        : {}),
      secretNames: [
        ...new Set([
          ...Object.keys(secrets),
          "SYLPH_RECOVERY_VERIFY_TOKEN",
          ...(resources.durableObjects.length
            ? ["SYLPH_RECOVERY_OBJECT_TOKEN"]
            : []),
        ]),
      ],
    })),
  }
  const r2Configuration = {
    ...configuration,
    bucketNames: [
      ...resources.bucketNames,
      ...(resources.drillBucketName ? [resources.drillBucketName] : []),
    ],
  }
  const d1Layer = CloudflareD1RecoveryLive(configuration)
  return {
    r2Configuration,
    managedQueues,
    objectConfiguration,
    databaseId,
    drillDatabaseId,
    resources,
    configuration,
    topology,
    layer: Layer.mergeAll(
      d1Layer,
      CloudflareR2RecoveryLive(r2Configuration),
      objectLayer
    ),
    groupLayer: (secretNames: string[]) =>
      CloudflareRecoveryGroupLive({
        ...configuration,
        topology: {
          workers: topology.workers.map((worker) => ({
            ...worker,
            secretNames,
          })),
        },
      }).pipe(Layer.provide(objectLayer)),
  }
}

export const recoveryManifestId = () => {
  const point = Schema.decodeUnknownSync(
    Schema.Struct({
      deploymentId: Schema.String,
      resources: Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          id: Schema.String,
          backupRef: Schema.String,
        })
      ),
    })
  )(JSON.parse(requiredReleaseValue("SYLPH_RECOVERY_POINT")))
  const database = point.resources.find(
    (resource) => resource.kind === "database"
  )
  if (
    !database ||
    point.resources.filter((resource) => resource.kind === "database")
      .length !== 1 ||
    point.resources.some(
      (resource) =>
        !["database", "secret"].includes(resource.kind) ||
        resource.backupRef !== database.backupRef
    )
  )
    throw new Error(
      "Recovery point contains an unsupported resource or manifest"
    )
  return { point, database }
}

export const assertRecoveryManifest = (
  point: ReturnType<typeof recoveryManifestId>["point"],
  manifest: D1RecoveryManifest
) => {
  const expected = [
    `database:${manifest.databaseId}`,
    ...manifest.secrets.map((secret) => `secret:${secret.name}`),
  ].sort()
  const actual = point.resources
    .map((resource) => `${resource.kind}:${resource.id}`)
    .sort()
  if (
    point.deploymentId !== manifest.releaseId ||
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    point.resources.some((resource) => resource.backupRef !== manifest.id)
  )
    throw new Error(
      "Recovery receipt does not match the captured database and exact secret versions"
    )
}

export const recoveryGroupId = () => {
  const point = Schema.decodeUnknownSync(
    Schema.Struct({
      deploymentId: Schema.NonEmptyString,
      resources: Schema.Array(
        Schema.Struct({
          kind: Schema.NonEmptyString,
          id: Schema.NonEmptyString,
          backupRef: Schema.NonEmptyString,
        })
      ),
    })
  )(JSON.parse(requiredReleaseValue("SYLPH_RECOVERY_POINT")))
  const reference = point.resources[0]?.backupRef
  if (
    !reference?.startsWith("group:") ||
    point.resources.some((resource) => resource.backupRef !== reference)
  )
    throw new Error("Recovery point must name one immutable complete group")
  return { point, id: reference.slice(6) }
}

export const assertRecoveryGroup = (
  point: ReturnType<typeof recoveryGroupId>["point"],
  group: D1RecoveryGroup
) => {
  const first = group.databases[0]
  if (!first) throw new Error("Recovery group has no database")
  const expected = [
    ...group.databases.map((database) => `database:${database.databaseId}`),
    ...(group.buckets ?? []).map(
      (bucket) => `object-storage:${bucket.bucketName}`
    ),
    ...new Set(
      group.topology.workers.flatMap((worker) =>
        (worker.managedKv ?? []).map((item) => `kv:${item.namespaceId}`)
      )
    ),
    ...new Set(
      group.topology.workers.flatMap((worker) =>
        (worker.managedQueues ?? []).map((item) => `other:${item.queueId}`)
      )
    ),
    ...new Set(
      group.topology.workers.flatMap((worker) =>
        (worker.durableObjects ?? []).map(
          (item) => `durable-object:${item.namespaceId}`
        )
      )
    ),
    ...first.secrets.map((secret) => `secret:${secret.name}`),
  ].sort()
  const actual = point.resources
    .map((resource) => `${resource.kind}:${resource.id}`)
    .sort()
  if (
    point.deploymentId !== group.releaseId ||
    JSON.stringify(expected) !== JSON.stringify(actual) ||
    point.resources.some(
      (resource) => resource.backupRef !== `group:${group.id}`
    )
  )
    throw new Error(
      "Recovery receipt must cover every group database and exact secret version"
    )
}

export const managedRecoveryReceipts = (group: D1RecoveryGroup) => {
  const receipts = new Map<
    string,
    { kind: string; id: string; backupRef: string; restoreVerifiedAt: number }
  >()
  for (const worker of group.topology.workers) {
    for (const item of [
      ...(worker.managedKv ?? []).map((resource) => ({
        kind: "kv",
        id: resource.namespaceId,
        databaseId: resource.databaseId,
      })),
      ...(worker.managedQueues ?? []).map((resource) => ({
        kind: "other",
        id: resource.queueId,
        databaseId: resource.databaseId,
      })),
    ]) {
      const database = group.databases.find(
        (database) => database.databaseId === item.databaseId
      )
      if (!database)
        throw new Error(
          "Managed resource has no authoritative database recovery point"
        )
      receipts.set(`${item.kind}:${item.id}`, {
        kind: item.kind,
        id: item.id,
        backupRef: `group:${group.id}`,
        restoreVerifiedAt: database.restoreVerifiedAt,
      })
    }
  }
  for (const worker of group.topology.workers) {
    for (const registration of worker.durableObjects ?? []) {
      const points = (group.objects ?? []).filter(
        (point) =>
          point.identity.namespaceId === registration.namespaceId &&
          registration.objectIds.includes(point.identity.objectId)
      )
      if (points.length !== registration.objectIds.length)
        throw new Error(
          "Object namespace is missing registered recovery proofs"
        )
      receipts.set(`durable-object:${registration.namespaceId}`, {
        kind: "durable-object",
        id: registration.namespaceId,
        backupRef: `group:${group.id}`,
        restoreVerifiedAt: Math.min(
          ...points.map((point) => point.restoreVerifiedAt)
        ),
      })
    }
  }
  return [...receipts.values()]
}
