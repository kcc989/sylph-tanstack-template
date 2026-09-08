import { queueConsumerEnabled } from "../scripts/sylph-queue-consumers"
import { Effect, Schema } from "effect"
import {
  managedKvBindings,
  managedQueueBindings,
} from "../scripts/sylph-resources"
import { ManagedKvLive } from "./recovery/managed-kv"
import {
  CloudflareRecoveryQueue,
  CloudflareRecoveryQueueLive,
} from "./recovery/queue"
import {
  RecoveryQueueNotification,
  type RecoveryQueueMessage,
} from "./recovery/queue-domain"

export { ManagedKv } from "./recovery/managed-kv"
export { CloudflareRecoveryQueue } from "./recovery/queue"

export const managedKv = (
  environment: Cloudflare.Env,
  binding: string,
  cache: KVNamespace
) => {
  if (
    !Object.hasOwn(managedKvBindings, binding) ||
    Reflect.get(environment, binding) !== cache
  )
    throw new Error("Managed KV requires its declared application binding")
  return ManagedKvLive({ database: environment.DB, cache, namespace: binding })
}

export const managedQueue = (
  environment: Cloudflare.Env,
  binding: string,
  transport: Queue<RecoveryQueueNotification>
) => {
  const names = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.String)
  )(JSON.parse(environment.SYLPH_MANAGED_QUEUE_NAMES))
  const queue = names[binding]
  if (
    !queueConsumerEnabled(binding) ||
    !Object.hasOwn(managedQueueBindings, binding) ||
    !queue ||
    Reflect.get(environment, binding) !== transport
  )
    throw new Error("Managed Queue requires its declared application binding")
  return CloudflareRecoveryQueueLive({
    database: environment.DB,
    transport,
    queue,
  })
}

export type ManagedQueueHandler = (
  message: RecoveryQueueMessage,
  environment: Cloudflare.Env
) => Promise<void>

export const consumeManagedQueue = async (
  batch: MessageBatch<RecoveryQueueNotification>,
  environment: Cloudflare.Env,
  handlers: Readonly<Record<string, ManagedQueueHandler>>
) => {
  const names = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.String)
  )(JSON.parse(environment.SYLPH_MANAGED_QUEUE_NAMES))
  const binding = Object.keys(managedQueueBindings).find(
    (name) => names[name] === batch.queue
  )
  const handle = binding ? handlers[binding] : undefined
  if (!binding || !handle)
    throw new Error("Managed Queue has no declared application handler")
  const layer = CloudflareRecoveryQueueLive({
    database: environment.DB,
    queue: batch.queue,
    transport: {
      send: async () => {
        throw new Error("Consumer cannot publish notifications")
      },
    },
  })
  for (const message of batch.messages) {
    try {
      const notification = Schema.decodeUnknownSync(RecoveryQueueNotification)(
        message.body
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* CloudflareRecoveryQueue).consume(
            notification,
            (value) => handle(value, environment)
          )
        }).pipe(Effect.provide(layer))
      )
      message.ack()
    } catch {
      message.retry()
    }
  }
}
