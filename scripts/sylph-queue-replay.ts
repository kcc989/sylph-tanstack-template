import { Schema } from "effect"
import { RecoveryQueryResponse } from "../src/recovery/domain"
import { RecoveryQueueNotification } from "../src/recovery/queue-domain"

const queueJournal = async (
  configuration: {
    apiBaseUrl: string
    apiToken: string
    controlDatabaseId: string
  },
  queues: readonly { queueId: string; queueName: string; databaseId: string }[],
  releaseId: string,
  request: typeof fetch,
  action: "replay" | "require-empty"
) => {
  const call = async (path: string, body: Schema.Json) => {
    const response = await request(`${configuration.apiBaseUrl}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok)
      throw new Error(
        "Managed Queue replay failed; application writers remain paused"
      )
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        success: Schema.Literal(true),
        result: Schema.optional(Schema.Json),
      })
    )(await response.json())
    return value
  }
  const query = async (
    databaseId: string,
    sql: string,
    params: readonly string[]
  ) => {
    const response = Schema.decodeUnknownSync(RecoveryQueryResponse)(
      await call(`d1/database/${encodeURIComponent(databaseId)}/query`, {
        sql,
        params: [...params],
      })
    )
    if (response.result.length !== 1 || !response.result[0]?.success)
      throw new Error("Queue journal query failed")
    return response.result[0].results
  }
  const requirePaused = async () => {
    const rows = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          owner: Schema.NullOr(Schema.String),
          active: Schema.Number,
        })
      )
    )(
      await query(
        configuration.controlDatabaseId,
        "SELECT owner, active FROM sylph_recovery_gate WHERE id = 1",
        []
      )
    )
    if (
      rows.length !== 1 ||
      rows[0]?.owner !== releaseId ||
      rows[0]?.active !== 0
    )
      throw new Error(
        "Queue replay requires this release's fully paused writer gate"
      )
  }
  let sent = 0
  for (const queue of queues) {
    let cursor = ""
    for (let page = 0; page <= 100; page++) {
      await requirePaused()
      const rows = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))
      )(
        await query(
          queue.databaseId,
          "SELECT id FROM sylph_recovery_queue WHERE queue = ? AND completed_at IS NULL AND id > ? ORDER BY id LIMIT 100",
          [queue.queueName, cursor]
        )
      )
      if (!rows.length) break
      if (action === "require-empty")
        throw new Error("Detached Queue still has pending journal messages")
      if (page === 100)
        throw new Error("Managed Queue journal exceeds its 10000-row limit")
      for (const row of rows) {
        if (row.id <= cursor)
          throw new Error("Queue replay cursor did not advance")
        const notification = Schema.decodeUnknownSync(
          RecoveryQueueNotification
        )({ version: 1, queue: queue.queueName, id: row.id })
        await call(`queues/${encodeURIComponent(queue.queueId)}/messages`, {
          body: notification,
          content_type: "json",
        })
        cursor = row.id
        sent++
      }
    }
  }
  return { sent }
}

export const replayManagedQueues = (
  configuration: Parameters<typeof queueJournal>[0],
  queues: Parameters<typeof queueJournal>[1],
  releaseId: string,
  request: typeof fetch = fetch
) => queueJournal(configuration, queues, releaseId, request, "replay")
export const requireEmptyQueueJournals = (
  configuration: Parameters<typeof queueJournal>[0],
  queues: Parameters<typeof queueJournal>[1],
  releaseId: string,
  request: typeof fetch = fetch
) => queueJournal(configuration, queues, releaseId, request, "require-empty")
