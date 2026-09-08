import { Layer, Schema } from "effect"
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

export const recoveryConfiguration = async (needsSecretKey = true) => {
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
      secretNames: [...Object.keys(secrets), "SYLPH_RECOVERY_VERIFY_TOKEN"],
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
    databaseId,
    drillDatabaseId,
    resources,
    configuration,
    topology,
    layer: Layer.merge(d1Layer, CloudflareR2RecoveryLive(r2Configuration)),
    groupLayer: (secretNames: string[]) =>
      CloudflareRecoveryGroupLive({
        ...configuration,
        topology: {
          workers: topology.workers.map((worker) => ({
            ...worker,
            secretNames,
          })),
        },
      }),
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
