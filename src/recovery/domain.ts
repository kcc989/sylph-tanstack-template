import { Schema } from "effect"

export class CloudflareRecoveryFailure extends Schema.TaggedError<CloudflareRecoveryFailure>()(
  "CloudflareRecoveryFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  }
) {}

export const RecoverySqlValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Null,
  Schema.Array(Schema.Number),
])
export const RecoverySqlRow = Schema.Record(Schema.String, RecoverySqlValue)
export const RecoveryQueryInput = Schema.Struct({
  sql: Schema.String,
  params: Schema.Array(
    Schema.Union([Schema.String, Schema.Number, Schema.Null])
  ),
})
export const RecoveryQueryResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Array(
    Schema.Struct({
      success: Schema.Boolean,
      results: Schema.Array(RecoverySqlRow),
    })
  ),
})
export const RecoveryBookmarkResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Struct({ bookmark: Schema.NonEmptyString }),
})
export const RecoveryRestoreResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Struct({
    bookmark: Schema.NonEmptyString,
    previous_bookmark: Schema.NonEmptyString,
  }),
})
export const RecoveryBinding = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  id: Schema.optional(Schema.String),
})
export const RecoverySettingsResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Struct({ bindings: Schema.Array(RecoveryBinding) }),
})
export const RecoverySchemaRow = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  sql: Schema.NullOr(Schema.String),
})
export const RecoverySchemaRows = Schema.Array(RecoverySchemaRow)
export const RecoveryGate = Schema.Struct({
  owner: Schema.NullOr(Schema.String),
  active: Schema.Number,
})
export const RecoverySecretValues = Schema.Record(Schema.String, Schema.String)
export const RecoverySecretVersion = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  ciphertext: Schema.NonEmptyString,
  iv: Schema.NonEmptyString,
})
export const RecoverySecretSnapshot = Schema.Struct({
  id: Schema.NonEmptyString,
  projectId: Schema.NonEmptyString,
  secrets: Schema.Array(RecoverySecretVersion),
})
export type RecoverySecretSnapshot = typeof RecoverySecretSnapshot.Type
export const RecoverySchedulesResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Struct({
    schedules: Schema.Array(Schema.Struct({ cron: Schema.String })),
  }),
})
export const D1RecoveryManifest = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  projectId: Schema.NonEmptyString,
  releaseId: Schema.NonEmptyString,
  databaseId: Schema.NonEmptyString,
  capturedAt: Schema.Number,
  restoreVerifiedAt: Schema.Number,
  expiresAt: Schema.Number,
  bookmark: Schema.NonEmptyString,
  fingerprint: Schema.NonEmptyString,
  schemaFingerprint: Schema.NonEmptyString,
  secrets: Schema.Array(RecoverySecretVersion),
})
export type D1RecoveryManifest = typeof D1RecoveryManifest.Type
export const D1RestoreEvidence = Schema.Struct({
  manifestId: Schema.NonEmptyString,
  schemaFingerprint: Schema.NonEmptyString,
  databaseId: Schema.NonEmptyString,
  previousBookmark: Schema.NonEmptyString,
  restoredBookmark: Schema.NonEmptyString,
  fingerprint: Schema.NonEmptyString,
  verifiedAt: Schema.Number,
})
export type D1RestoreEvidence = typeof D1RestoreEvidence.Type
