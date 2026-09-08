import { Schema } from "effect"

export const RecoveryObjectDrillProof = Schema.Struct({
  schema_fingerprint: Schema.NonEmptyString,
  verified_at: Schema.Number,
})
