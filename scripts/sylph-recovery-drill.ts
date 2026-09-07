import { Effect, Schema } from "effect"
import { RecoveryQueryResponse } from "../src/recovery/domain"
import {
  CloudflareD1Recovery,
  CloudflareD1RecoveryLive,
} from "../src/recovery/recovery"

const required = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const accountId = required("CLOUDFLARE_ACCOUNT_ID")
const apiToken = required("CLOUDFLARE_API_TOKEN")
const databaseId = required("SYLPH_RECOVERY_DRILL_DATABASE_ID")
const controlDatabaseId = required("SYLPH_RECOVERY_CONTROL_DATABASE_ID")
const projectId = required("SYLPH_PROJECT_ID")
const encryptionKey = required("SYLPH_RECOVERY_KEY")
if (databaseId === controlDatabaseId)
  throw new Error("Drill database must differ from control database")
if (required("SYLPH_RECOVERY_DRILL_CONFIRM") !== `restore:${databaseId}`)
  throw new Error(
    "Explicit disposable database restore confirmation is required"
  )

const api = async (suffix: string, sql?: string) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}${suffix}`,
    {
      method: sql ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: sql ? JSON.stringify({ sql, params: [] }) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    }
  )
  if (!response.ok)
    throw new Error(
      `Provider drill API failed (${response.status}); response withheld`
    )
  return response.json()
}
const metadata = Schema.decodeUnknownSync(
  Schema.Struct({
    success: Schema.Boolean,
    result: Schema.Struct({ name: Schema.String }),
  })
)(await api(""))
if (
  !metadata.success ||
  !/^sylph-recovery-drill-[a-z0-9-]+$/.test(metadata.result.name)
)
  throw new Error(
    "Only an Alchemy-created sylph-recovery-drill-* database is allowed"
  )

const mutate = async (sql: string) => {
  const result = Schema.decodeUnknownSync(RecoveryQueryResponse)(
    await api("/query", sql)
  )
  if (!result.success || result.result.some((query) => !query.success))
    throw new Error("Provider drill mutation failed")
}
const releaseId = `drill-${crypto.randomUUID()}`
const evidence = await Effect.runPromise(
  Effect.gen(function* () {
    const recovery = yield* CloudflareD1Recovery
    yield* recovery.pause(releaseId)
    const manifest = yield* recovery.captureForDrill({ databaseId, releaseId })
    yield* Effect.promise(() =>
      mutate(
        "CREATE TABLE sylph_recovery_drill_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)"
      )
    )
    yield* Effect.promise(() =>
      mutate(
        "INSERT INTO sylph_recovery_drill_probe VALUES ('probe', 'must disappear after restore')"
      )
    )
    const changed = yield* recovery.fingerprint(databaseId)
    if (changed.fingerprint === manifest.fingerprint)
      return yield* Effect.die(
        new Error("Drill mutation was not independently observed")
      )
    const restored = yield* recovery.restore(manifest, releaseId)
    const independentlyRead = yield* recovery.fingerprint(databaseId)
    if (independentlyRead.fingerprint !== manifest.fingerprint)
      return yield* Effect.die(
        new Error("Post-restore independent read failed")
      )
    yield* recovery.resume(releaseId)
    return {
      ...restored,
      releaseId,
      projectId,
      provider: "Cloudflare D1",
      realProvider: true,
    }
  }).pipe(
    Effect.provide(
      CloudflareD1RecoveryLive({
        accountId,
        apiToken,
        controlDatabaseId,
        projectId,
        encryptionKey,
      })
    )
  )
)
process.stdout.write(`${JSON.stringify(evidence)}\n`)
