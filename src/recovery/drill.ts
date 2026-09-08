import { Effect, Schema } from "effect"
import {
  CloudflareRecoveryFailure,
  RecoveryQueryResponse,
  RecoveryDatabaseResponse,
} from "./domain"
import { CloudflareD1Recovery, type RecoveryConfiguration } from "./recovery"

export const verifyRecoveryDrill = Effect.fn("CloudflareRecovery.verifyDrill")(
  function* (
    configuration: RecoveryConfiguration,
    input: {
      databaseId: string
      applicationDatabaseId: string
      expectedName: string
      releaseId: string
    }
  ) {
    const fail = () =>
      new CloudflareRecoveryFailure({
        operation: "Verify isolated restore drill",
        message:
          "Restore drill failed; retain its resources and writer pause for inspection.",
      })
    const attempt = <A>(action: () => Promise<A>) =>
      Effect.tryPromise({ try: action, catch: fail })
    if (
      !/^sylph-[a-f0-9]{24}-recovery-drill$/.test(input.expectedName) ||
      input.databaseId === input.applicationDatabaseId ||
      input.databaseId === configuration.controlDatabaseId
    )
      return yield* fail()
    const root =
      configuration.apiBaseUrl ??
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`
    const request = async (
      suffix: string,
      sql?: string,
      params: string[] = []
    ) => {
      const response = await (configuration.fetch ?? fetch)(
        `${root}/d1/database/${encodeURIComponent(input.databaseId)}${suffix}`,
        {
          method: sql ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${configuration.apiToken}`,
            "Content-Type": "application/json",
          },
          body: sql ? JSON.stringify({ sql, params }) : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        }
      )
      if (!response.ok) throw new Error("Drill provider request failed")
      return response.json()
    }
    const metadata = yield* attempt(async () =>
      Schema.decodeUnknownSync(RecoveryDatabaseResponse)(await request(""))
    )
    if (
      metadata.result.name !== input.expectedName ||
      metadata.result.uuid !== input.databaseId
    )
      return yield* fail()
    const recovery = yield* CloudflareD1Recovery
    yield* recovery.pause(input.releaseId)
    const application = yield* recovery.fingerprint(input.applicationDatabaseId)
    const scratch = yield* recovery.fingerprint(input.databaseId)
    if (application.schemaFingerprint !== scratch.schemaFingerprint)
      return yield* fail()
    const point = yield* recovery.captureForDrill({
      databaseId: input.databaseId,
      releaseId: input.releaseId,
    })
    const query = (sql: string, params?: string[]) =>
      attempt(async () => {
        const result = Schema.decodeUnknownSync(RecoveryQueryResponse)(
          await request("/query", sql, params)
        )
        if (
          !result.success ||
          result.result.length !== 1 ||
          !result.result[0]?.success
        )
          throw new Error("Drill query failed")
      })
    yield* query(
      "CREATE TABLE sylph_recovery_drill_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    yield* query("INSERT INTO sylph_recovery_drill_probe VALUES (?, ?)", [
      input.releaseId,
      crypto.randomUUID(),
    ])
    const changed = yield* recovery.fingerprint(input.databaseId)
    if (changed.fingerprint === point.fingerprint) return yield* fail()
    yield* recovery.captureForDrill({
      databaseId: input.databaseId,
      releaseId: input.releaseId,
    })
    const evidence = yield* recovery.restore(point, input.releaseId)
    const after = yield* recovery.fingerprint(input.databaseId)
    const applicationAfter = yield* recovery.fingerprint(
      input.applicationDatabaseId
    )
    if (
      after.fingerprint !== point.fingerprint ||
      applicationAfter.fingerprint !== application.fingerprint
    )
      return yield* fail()
    yield* recovery.resume(input.releaseId)
    return evidence
  }
)
