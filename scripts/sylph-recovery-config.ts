import { Schema } from "effect"
import { CloudflareD1RecoveryLive } from "../src/recovery/recovery"
import { sylphResources } from "./sylph-resources"
import type { D1RecoveryManifest } from "../src/recovery/domain"

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
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database?per_page=1000`,
    {
      headers: { Authorization: `Bearer ${apiToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }
  )
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
  return {
    databaseId,
    resources,
    layer: CloudflareD1RecoveryLive({
      accountId,
      apiToken,
      controlDatabaseId,
      projectId,
      encryptionKey,
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
