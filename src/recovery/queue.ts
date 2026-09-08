import { Context, Effect, Layer, Schema } from "effect"
import { CloudflareRecoveryFailure } from "./domain"
import {
  RecoveryQueueEnqueue,
  RecoveryQueueMessage,
  RecoveryQueueName,
  RecoveryQueueNotification,
  RecoveryQueueReplayInput,
  RecoveryQueueRow,
} from "./queue-domain"

type Result<A> = Effect.Effect<A, CloudflareRecoveryFailure>

export class CloudflareRecoveryQueue extends Context.Service<
  CloudflareRecoveryQueue,
  {
    enqueue: (input: RecoveryQueueEnqueue) => Result<void>
    replayPending: (
      input: RecoveryQueueReplayInput
    ) => Result<{ sent: number; nextCursor: string | null }>
    consume: (
      notification: RecoveryQueueNotification,
      handle: (message: RecoveryQueueMessage) => Promise<void>
    ) => Result<"completed" | "ignored">
  }
>()("@sylph/CloudflareRecoveryQueue") {}

export const CloudflareRecoveryQueueLive = (configuration: {
  database: D1Database
  transport: {
    send: (
      notification: RecoveryQueueNotification
    ) => Promise<QueueSendResponse>
  }
  queue: string
  now?: () => number
}) =>
  Layer.sync(CloudflareRecoveryQueue, () => {
    const queue = Schema.decodeUnknownSync(RecoveryQueueName)(
      configuration.queue
    )
    const now = configuration.now ?? Date.now
    const database = configuration.database.withSession("first-primary")
    const attempt = <A>(operation: string, run: () => Promise<A>): Result<A> =>
      Effect.tryPromise({
        try: run,
        catch: () =>
          new CloudflareRecoveryFailure({
            operation,
            message: `${operation} failed; the durable journal remains authoritative. Retry with the same message ID and inspect delivery before changing message state.`,
          }),
      })
    const read = async (id: string) => {
      const row = await database
        .prepare(
          "SELECT id, body, created_at, completed_at FROM sylph_recovery_queue WHERE queue = ? AND id = ?"
        )
        .bind(queue, id)
        .first()
      return row === null
        ? null
        : Schema.decodeUnknownSync(RecoveryQueueRow)(row)
    }
    const send = (id: string) =>
      configuration.transport.send({ version: 1, queue, id })
    const enqueue = Effect.fn("RecoveryQueue.enqueue")(function* (
      input: RecoveryQueueEnqueue
    ) {
      yield* attempt("Enqueue recoverable message", async () => {
        const value = Schema.decodeUnknownSync(RecoveryQueueEnqueue)(input)
        const body = JSON.stringify(value.body)
        if (new TextEncoder().encode(body).byteLength > 65536)
          throw new Error("Journal message exceeds 64 KiB")
        await database
          .prepare(
            "INSERT INTO sylph_recovery_queue (queue, id, body, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM sylph_recovery_queue) < 10000 ON CONFLICT(queue, id) DO NOTHING"
          )
          .bind(queue, value.id, body, now())
          .run()
        const saved = await read(value.id)
        if (!saved || saved.body !== body)
          throw new Error(
            "Message identity conflict or journal capacity reached"
          )
        if (saved.completed_at === null) await send(value.id)
      })
    })
    const replayPending = Effect.fn("RecoveryQueue.replayPending")(function* (
      input: RecoveryQueueReplayInput
    ) {
      return yield* attempt("Replay recoverable messages", async () => {
        const value = Schema.decodeUnknownSync(RecoveryQueueReplayInput)(input)
        const response = await database
          .prepare(
            "SELECT id, body, created_at, completed_at FROM sylph_recovery_queue WHERE queue = ? AND completed_at IS NULL AND id > ? ORDER BY id LIMIT ?"
          )
          .bind(queue, value.afterId ?? "", value.limit)
          .all()
        if (!response.success) throw new Error("Journal listing failed")
        const rows = Schema.decodeUnknownSync(Schema.Array(RecoveryQueueRow))(
          response.results
        )
        for (const row of rows) await send(row.id)
        return {
          sent: rows.length,
          nextCursor:
            rows.length === value.limit ? (rows.at(-1)?.id ?? null) : null,
        }
      })
    })
    const consume = Effect.fn("RecoveryQueue.consume")(function* (
      notification: RecoveryQueueNotification,
      handle: (message: RecoveryQueueMessage) => Promise<void>
    ) {
      return yield* attempt("Consume recoverable message", async () => {
        const value = Schema.decodeUnknownSync(RecoveryQueueNotification)(
          notification
        )
        if (value.queue !== queue) throw new Error("Queue identity differs")
        const row = await read(value.id)
        if (!row || row.completed_at !== null) return "ignored"
        const message = Schema.decodeUnknownSync(RecoveryQueueMessage)({
          id: row.id,
          queue,
          body: JSON.parse(row.body),
          createdAt: row.created_at,
        })
        await handle(message)
        const result = await database
          .prepare(
            "UPDATE sylph_recovery_queue SET completed_at = ? WHERE queue = ? AND id = ? AND body = ? AND completed_at IS NULL"
          )
          .bind(now(), queue, row.id, row.body)
          .run()
        if (!result.success) throw new Error("Journal completion failed")
        return "completed"
      })
    })
    return CloudflareRecoveryQueue.of({ enqueue, replayPending, consume })
  })
