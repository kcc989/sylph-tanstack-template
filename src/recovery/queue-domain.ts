import { Schema } from "effect"

export const RecoveryQueueName = Schema.NonEmptyString.check(
  Schema.isMaxLength(128)
)
export const RecoveryQueueMessageId = Schema.NonEmptyString.check(
  Schema.isMaxLength(128)
)
export const RecoveryQueueNotification = Schema.Struct({
  version: Schema.Literal(1),
  queue: RecoveryQueueName,
  id: RecoveryQueueMessageId,
})
export type RecoveryQueueNotification = typeof RecoveryQueueNotification.Type

export const RecoveryQueueEnqueue = Schema.Struct({
  id: RecoveryQueueMessageId,
  body: Schema.Json,
})
export type RecoveryQueueEnqueue = typeof RecoveryQueueEnqueue.Type

export const RecoveryQueueMessage = Schema.Struct({
  id: RecoveryQueueMessageId,
  queue: RecoveryQueueName,
  body: Schema.Json,
  createdAt: Schema.Number,
})
export type RecoveryQueueMessage = typeof RecoveryQueueMessage.Type

export const RecoveryQueueRow = Schema.Struct({
  id: RecoveryQueueMessageId,
  body: Schema.String,
  created_at: Schema.Number,
  completed_at: Schema.NullOr(Schema.Number),
})
export const RecoveryQueueReplayInput = Schema.Struct({
  afterId: Schema.optional(RecoveryQueueMessageId),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
})
export type RecoveryQueueReplayInput = typeof RecoveryQueueReplayInput.Type
