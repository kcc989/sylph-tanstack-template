import { Schema } from "effect"
import { R2RecoveryManifest } from "./r2-domain"

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
  service: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  entrypoint: Schema.optional(Schema.String),
  bucket_name: Schema.optional(Schema.String),
  jurisdiction: Schema.optional(Schema.String),
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

export const RecoveryWorkerInventory = Schema.Struct({
  workerName: Schema.NonEmptyString,
  databaseIds: Schema.Array(Schema.NonEmptyString).check(
    Schema.isMaxLength(20)
  ),
  bucketNames: Schema.optional(
    Schema.Array(Schema.NonEmptyString).check(
      Schema.isMaxLength(20),
      Schema.isUnique()
    )
  ),
  secretNames: Schema.Array(Schema.NonEmptyString).check(
    Schema.isMaxLength(100),
    Schema.isUnique()
  ),
  serviceTargets: Schema.Array(Schema.NonEmptyString).check(
    Schema.isMaxLength(4),
    Schema.isUnique()
  ),
})
export type RecoveryWorkerInventory = typeof RecoveryWorkerInventory.Type
export const RecoveryTopology = Schema.Struct({
  workers: Schema.Array(RecoveryWorkerInventory).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4)
  ),
}).check(
  Schema.makeFilter((value) => {
    const names = new Set(value.workers.map((worker) => worker.workerName))
    const databases = new Set(
      value.workers.flatMap((worker) => worker.databaseIds)
    )
    return (
      names.size === value.workers.length &&
      databases.size > 0 &&
      databases.size <= 20 &&
      new Set(value.workers.flatMap((worker) => worker.bucketNames ?? []))
        .size <= 20 &&
      value.workers.every((worker) =>
        worker.serviceTargets.every((target) => names.has(target))
      )
    )
  })
)
export type RecoveryTopology = typeof RecoveryTopology.Type
export const D1RecoveryGroup = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  projectId: Schema.NonEmptyString,
  releaseId: Schema.NonEmptyString,
  capturedAt: Schema.Number,
  expiresAt: Schema.Number,
  topology: RecoveryTopology,
  buckets: Schema.optional(
    Schema.Array(R2RecoveryManifest).check(
      Schema.isMaxLength(20),
      Schema.makeFilter(
        (values) =>
          new Set(values.map((value) => value.bucketName)).size ===
          values.length
      )
    )
  ),
  databases: Schema.Array(D1RecoveryManifest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20)
  ),
})
export type D1RecoveryGroup = typeof D1RecoveryGroup.Type

export const RecoveryDatabaseResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    uuid: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
  }),
})
