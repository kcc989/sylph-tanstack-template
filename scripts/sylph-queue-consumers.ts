import { Schema } from "effect"
import flags from "./managed-queue-consumers.json"

const ConsumerFlags = Schema.Record(Schema.String, Schema.Boolean)

export const queueConsumerFlags = Schema.decodeUnknownSync(ConsumerFlags)(flags)
export const queueConsumerEnabled = (binding: string) =>
  queueConsumerFlags[binding] !== false

export const reviewQueueConsumerTransition = (
  before: string,
  after: string,
  bindings: readonly string[],
  restoringVerifiedTarget = false
) => {
  const previous = Schema.decodeUnknownSync(ConsumerFlags)(JSON.parse(before))
  const next = Schema.decodeUnknownSync(ConsumerFlags)(JSON.parse(after))
  if (
    [...Object.keys(previous), ...Object.keys(next)].some(
      (binding) => !bindings.includes(binding)
    )
  )
    throw new Error(
      "Queue consumer flags must reference existing managed Queue bindings"
    )
  for (const binding of bindings)
    if (
      !restoringVerifiedTarget &&
      previous[binding] === false &&
      next[binding] !== false
    )
      throw new Error(
        "Automatic source transition only detaches Queue consumers"
      )
}
