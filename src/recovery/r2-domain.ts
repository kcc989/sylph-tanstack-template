import { Schema } from "effect"

export const R2RecoveryHttpMetadata = Schema.Struct({
  contentType: Schema.optional(Schema.String),
  contentLanguage: Schema.optional(Schema.String),
  contentDisposition: Schema.optional(Schema.String),
  contentEncoding: Schema.optional(Schema.String),
  cacheControl: Schema.optional(Schema.String),
  cacheExpiry: Schema.optional(Schema.String),
})
export const R2RecoveryCustomMetadata = Schema.Record(
  Schema.String,
  Schema.String
)
export const R2RecoveryStorageClass = Schema.Literals([
  "Standard",
  "InfrequentAccess",
])
export const R2RecoveryListedObject = Schema.Struct({
  key: Schema.NonEmptyString,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  etag: Schema.NonEmptyString,
  last_modified: Schema.optional(Schema.String),
  ssec: Schema.optional(Schema.Boolean),
  storage_class: Schema.optional(R2RecoveryStorageClass),
  http_metadata: Schema.optional(R2RecoveryHttpMetadata),
  custom_metadata: Schema.optional(R2RecoveryCustomMetadata),
})
export const R2RecoveryListResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(R2RecoveryListedObject),
  result_info: Schema.Struct({
    is_truncated: Schema.Boolean,
    cursor: Schema.optional(Schema.String),
    delimited: Schema.optional(
      Schema.Array(Schema.String).check(Schema.isMaxLength(0))
    ),
  }),
})
export const R2RecoveryObject = Schema.Struct({
  key: Schema.NonEmptyString,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  bytes: Schema.String,
  httpMetadata: R2RecoveryHttpMetadata,
  customMetadata: R2RecoveryCustomMetadata,
  storageClass: R2RecoveryStorageClass,
})
export type R2RecoveryObject = typeof R2RecoveryObject.Type
export const R2RecoverySnapshot = Schema.Struct({
  version: Schema.Literal(1),
  objects: Schema.Array(R2RecoveryObject).check(Schema.isMaxLength(10000)),
}).check(
  Schema.makeFilter(
    (value) =>
      new Set(value.objects.map((object) => object.key)).size ===
      value.objects.length
  )
)
export type R2RecoverySnapshot = typeof R2RecoverySnapshot.Type
export const R2RecoveryManifest = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  projectId: Schema.NonEmptyString,
  releaseId: Schema.NonEmptyString,
  bucketName: Schema.NonEmptyString,
  capturedAt: Schema.Number,
  expiresAt: Schema.Number,
  restoreVerifiedAt: Schema.Number,
  fingerprint: Schema.NonEmptyString,
  objectCount: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(10000)
  ),
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  chunkCount: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type R2RecoveryManifest = typeof R2RecoveryManifest.Type
export const R2RecoveryChunk = Schema.Struct({
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  iv: Schema.NonEmptyString,
  ciphertext: Schema.NonEmptyString,
})
export const R2RestoreEvidence = Schema.Struct({
  manifestId: Schema.NonEmptyString,
  bucketName: Schema.NonEmptyString,
  schemaFingerprint: Schema.Literal("r2-snapshot-v1"),
  fingerprint: Schema.NonEmptyString,
  objectCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  verifiedAt: Schema.Number,
})
export type R2RestoreEvidence = typeof R2RestoreEvidence.Type
export const R2RecoveryMutationResponse = Schema.Struct({
  success: Schema.Literal(true),
})

const R2RecoveryLifecycleAge = Schema.Struct({
  type: Schema.Literal("Age"),
  maxAge: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
})
const R2RecoveryLifecycleCondition = Schema.Union([
  R2RecoveryLifecycleAge,
  Schema.Struct({ type: Schema.Literal("Date"), date: Schema.NonEmptyString }),
])
export const R2RecoveryLifecycleResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    rules: Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString,
        conditions: Schema.Struct({ prefix: Schema.String }),
        enabled: Schema.Boolean,
        abortMultipartUploadsTransition: Schema.optional(
          Schema.Struct({ condition: Schema.optional(R2RecoveryLifecycleAge) })
        ),
        deleteObjectsTransition: Schema.optional(
          Schema.Struct({
            condition: Schema.optional(R2RecoveryLifecycleCondition),
          })
        ),
        storageClassTransitions: Schema.optional(
          Schema.Array(
            Schema.Struct({
              condition: R2RecoveryLifecycleCondition,
              storageClass: Schema.Literal("InfrequentAccess"),
            })
          )
        ),
      }).annotate({ parseOptions: { onExcessProperty: "error" } })
    ),
  }),
})
export const R2RecoveryLocksResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    rules: Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString,
        enabled: Schema.Boolean,
        prefix: Schema.optional(Schema.String),
        condition: Schema.Union([
          Schema.Struct({
            type: Schema.Literal("Age"),
            maxAgeSeconds: Schema.Number.check(
              Schema.isGreaterThanOrEqualTo(0)
            ),
          }),
          Schema.Struct({
            type: Schema.Literal("Date"),
            date: Schema.NonEmptyString,
          }),
          Schema.Struct({ type: Schema.Literal("Indefinite") }),
        ]),
      })
    ),
  }),
})
export const R2RecoverySippyResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    enabled: Schema.Boolean,
    source: Schema.optional(
      Schema.Struct({
        bucket: Schema.optional(Schema.String),
        bucketUrl: Schema.optional(Schema.String),
        container: Schema.optional(Schema.String),
        provider: Schema.optional(
          Schema.Literals(["aws", "gcs", "s3", "azure"])
        ),
        region: Schema.optional(Schema.String),
      })
    ),
    destination: Schema.optional(
      Schema.Struct({
        accessKeyId: Schema.optional(Schema.String),
        account: Schema.optional(Schema.String),
        bucket: Schema.optional(Schema.String),
        provider: Schema.optional(Schema.Literal("r2")),
      })
    ),
  }),
})
export const R2RecoveryNotificationsResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    bucketName: Schema.NonEmptyString,
    queues: Schema.Array(
      Schema.Struct({
        queueId: Schema.NonEmptyString,
        queueName: Schema.NonEmptyString,
        rules: Schema.Array(
          Schema.Struct({
            actions: Schema.Array(
              Schema.Literals([
                "PutObject",
                "CopyObject",
                "DeleteObject",
                "CompleteMultipartUpload",
                "LifecycleDeletion",
              ])
            ),
            createdAt: Schema.optional(Schema.String),
            description: Schema.optional(Schema.String),
            prefix: Schema.optional(Schema.String),
            ruleId: Schema.optional(Schema.String),
            suffix: Schema.optional(Schema.String),
          })
        ),
      })
    ),
  }),
})
