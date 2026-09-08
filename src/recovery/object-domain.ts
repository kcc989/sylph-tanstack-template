import { Schema } from "effect"

export const RecoveryObjectIdentity = Schema.Struct({
  namespaceId: Schema.NonEmptyString,
  objectId: Schema.NonEmptyString,
})
export type RecoveryObjectIdentity = typeof RecoveryObjectIdentity.Type
export const RecoveryObjectBytes = Schema.Struct({
  bytes: Schema.Array(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
  ),
})
export const RecoveryObjectInteger = Schema.Struct({
  integer: Schema.Int.check(
    Schema.isBetween({ minimum: -9007199254740991, maximum: 9007199254740991 })
  ),
})
export const RecoveryObjectReal = Schema.Struct({ real: Schema.Finite })
export const RecoveryObjectSqlValue = Schema.Union([
  Schema.String,
  RecoveryObjectInteger,
  RecoveryObjectReal,
  Schema.Null,
  RecoveryObjectBytes,
])
export const RecoveryObjectTable = Schema.Struct({
  name: Schema.NonEmptyString,
  sql: Schema.NonEmptyString,
  columns: Schema.Array(Schema.NonEmptyString),
  rows: Schema.Array(Schema.Array(RecoveryObjectSqlValue)).check(
    Schema.isMaxLength(1000)
  ),
})
export const RecoveryObjectSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  tables: Schema.Array(RecoveryObjectTable).check(Schema.isMaxLength(32)),
  indexes: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(100)),
  values: Schema.Array(
    Schema.Struct({ key: Schema.NonEmptyString, value: Schema.Json })
  ).check(Schema.isMaxLength(1000)),
})
export type RecoveryObjectSnapshot = typeof RecoveryObjectSnapshot.Type
export const RecoveryObjectRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("capture"),
    releaseId: Schema.NonEmptyString,
    identity: RecoveryObjectIdentity,
  }),
  Schema.Struct({
    operation: Schema.Literal("restore"),
    releaseId: Schema.NonEmptyString,
    identity: RecoveryObjectIdentity,
    snapshot: RecoveryObjectSnapshot,
  }),
])
export type RecoveryObjectRequest = typeof RecoveryObjectRequest.Type
export const RecoveryObjectResponse = Schema.Struct({
  identity: RecoveryObjectIdentity,
  snapshot: RecoveryObjectSnapshot,
})
export type RecoveryObjectResponse = typeof RecoveryObjectResponse.Type
export const RecoveryObjectManifest = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  projectId: Schema.NonEmptyString,
  releaseId: Schema.NonEmptyString,
  identity: RecoveryObjectIdentity,
  capturedAt: Schema.Number,
  restoreVerifiedAt: Schema.Number,
  expiresAt: Schema.Number,
  fingerprint: Schema.NonEmptyString,
  chunkCount: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type RecoveryObjectManifest = typeof RecoveryObjectManifest.Type
export const RecoveryObjectRegistration = Schema.Struct({
  bindingName: Schema.NonEmptyString,
  namespaceId: Schema.NonEmptyString,
  objectIds: Schema.Array(Schema.NonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isUnique()
  ),
})
export const RecoveryObjectsResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(
    Schema.Struct({ id: Schema.NonEmptyString, hasStoredData: Schema.Boolean })
  ),
  result_info: Schema.optional(
    Schema.Struct({ cursor: Schema.optional(Schema.String) })
  ),
})

export const RecoveryObjectSqlSchema = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    type: Schema.String,
    sql: Schema.NullOr(Schema.String),
  })
)
export const RecoveryObjectSqlColumns = Schema.Array(
  Schema.Struct({ name: Schema.String, hidden: Schema.Number })
)

export const RecoveryObjectDispatch = Schema.Struct({
  bindingName: Schema.NonEmptyString,
  request: RecoveryObjectRequest,
})
export type RecoveryObjectDispatch = typeof RecoveryObjectDispatch.Type
export const RecoveryObjectRegistry = Schema.Array(
  Schema.Struct({
    bindingName: Schema.NonEmptyString,
    className: Schema.NonEmptyString,
    objectNames: Schema.Array(Schema.NonEmptyString).check(
      Schema.isMaxLength(100),
      Schema.isUnique()
    ),
    objectIds: Schema.Array(Schema.NonEmptyString).check(
      Schema.isMaxLength(100),
      Schema.isUnique()
    ),
  }).check(
    Schema.makeFilter(
      (entry) => entry.objectNames.length === entry.objectIds.length
    )
  )
).check(Schema.isMaxLength(20))
export type RecoveryObjectRegistry = typeof RecoveryObjectRegistry.Type

export const RecoveryObjectTableList = Schema.Array(
  Schema.Struct({ name: Schema.String, wr: Schema.Int })
)
