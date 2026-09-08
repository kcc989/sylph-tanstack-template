import { Context, Effect, Layer, Schema } from "effect"
import {
  CloudflareRecoveryFailure,
  RecoveryGate,
  RecoveryQueryResponse,
} from "./domain"
import { R2RecoveryChunk } from "./r2-domain"
import {
  RecoveryObjectManifest,
  RecoveryObjectResponse,
  RecoveryObjectSnapshot,
  type RecoveryObjectIdentity,
  type RecoveryObjectRequest,
} from "./object-domain"
import { RecoveryObjectDrillProof } from "./object-drill-domain"
import type { RecoveryConfiguration } from "./recovery"

type Result<A> = Effect.Effect<A, CloudflareRecoveryFailure>

export class CloudflareObjectRecovery extends Context.Service<
  CloudflareObjectRecovery,
  {
    capture: (
      identity: RecoveryObjectIdentity,
      releaseId: string
    ) => Result<RecoveryObjectManifest>
    captureForDrill: (
      identity: RecoveryObjectIdentity,
      releaseId: string
    ) => Result<RecoveryObjectManifest>
    read: (id: string) => Result<RecoveryObjectManifest>
    fingerprint: (
      identity: RecoveryObjectIdentity,
      releaseId: string
    ) => Result<string>
    preflightRestore: (
      manifest: RecoveryObjectManifest,
      releaseId: string
    ) => Result<void>
    restore: (
      manifest: RecoveryObjectManifest,
      releaseId: string
    ) => Result<void>
  }
>()("@sylph/CloudflareObjectRecovery") {}

const digest = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value))
const unbase64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const identityKey = (identity: RecoveryObjectIdentity) =>
  JSON.stringify(identity)

export interface ObjectRecoveryConfiguration extends RecoveryConfiguration {
  identities: readonly RecoveryObjectIdentity[]
  transport: (request: RecoveryObjectRequest) => Promise<RecoveryObjectResponse>
}

export const objectSnapshotFingerprint = (snapshot: RecoveryObjectSnapshot) =>
  digest(JSON.stringify(snapshot))

export const objectSchemaFingerprint = (snapshot: RecoveryObjectSnapshot) =>
  digest(
    JSON.stringify({
      version: snapshot.version,
      tables: snapshot.tables.map(({ name, sql, columns }) => ({
        name,
        sql,
        columns,
      })),
      indexes: snapshot.indexes,
    })
  )

export const CloudflareObjectRecoveryLive = (
  configuration: ObjectRecoveryConfiguration
) =>
  Layer.sync(CloudflareObjectRecovery, () => {
    const now = configuration.now ?? Date.now
    const identities = new Set(configuration.identities.map(identityKey))
    const attempt = <A>(operation: string, run: () => Promise<A>): Result<A> =>
      Effect.tryPromise({
        try: run,
        catch: () =>
          new CloudflareRecoveryFailure({
            operation,
            message: `${operation} failed; retain the application pause and inspect the immutable object operation before any retry.`,
          }),
      })
    const query = async (
      sql: string,
      params: readonly (string | number | null)[] = []
    ) => {
      const root =
        configuration.apiBaseUrl ??
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`
      const response = await (configuration.fetch ?? fetch)(
        `${root}/d1/database/${encodeURIComponent(configuration.controlDatabaseId)}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configuration.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sql, params }),
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        }
      )
      if (!response.ok) throw new Error("Control database request failed")
      const result = Schema.decodeUnknownSync(RecoveryQueryResponse)(
        await response.json()
      )
      if (
        !result.success ||
        result.result.length !== 1 ||
        !result.result[0]?.success
      )
        throw new Error("Control database query failed")
      return result.result[0].results
    }
    const paused = async (releaseId: string) => {
      const gate = Schema.decodeUnknownSync(RecoveryGate)(
        (
          await query(
            "SELECT owner, active FROM sylph_recovery_gate WHERE id = 1"
          )
        )[0]
      )
      if (gate.owner !== releaseId || gate.active !== 0)
        throw new Error("Object recovery requires its drained gate")
    }
    const snapshot = async (
      identity: RecoveryObjectIdentity,
      releaseId: string
    ) => {
      if (!identities.has(identityKey(identity)))
        throw new Error("Object is not registered")
      await paused(releaseId)
      const result = Schema.decodeUnknownSync(RecoveryObjectResponse)(
        await configuration.transport({
          operation: "capture",
          identity,
          releaseId,
        })
      )
      if (identityKey(result.identity) !== identityKey(identity))
        throw new Error("Object transport identity differs")
      const json = JSON.stringify(result.snapshot)
      if (new TextEncoder().encode(json).byteLength > 4194304)
        throw new Error("Object exceeds snapshot bound")
      await paused(releaseId)
      return json
    }
    const readSaved = async (id: string) => {
      const row = (
        await query(
          "SELECT json, sha256 FROM sylph_recovery_object_manifest WHERE id = ? AND project_id = ?",
          [id, configuration.projectId]
        )
      )[0]
      const json = Schema.decodeUnknownSync(Schema.String)(row?.json)
      if ((await digest(json)) !== row?.sha256)
        throw new Error("Object manifest integrity differs")
      const manifest = Schema.decodeUnknownSync(RecoveryObjectManifest)(
        JSON.parse(json)
      )
      if (
        manifest.id !== id ||
        manifest.projectId !== configuration.projectId ||
        !identities.has(identityKey(manifest.identity)) ||
        manifest.chunkCount > 128
      )
        throw new Error("Object manifest identity differs")
      return manifest
    }
    const key = () =>
      crypto.subtle.importKey(
        "raw",
        unbase64(configuration.encryptionKey),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"]
      )
    const aad = (id: string, ordinal: number) =>
      new TextEncoder().encode(
        `${configuration.projectId}:object:${id}:${ordinal}`
      )
    const savedSnapshot = async (manifest: RecoveryObjectManifest) => {
      const bytes: number[] = []
      const encryptionKey = await key()
      for (let ordinal = 0; ordinal < manifest.chunkCount; ordinal++) {
        const chunk = Schema.decodeUnknownSync(R2RecoveryChunk)(
          (
            await query(
              "SELECT ordinal, iv, ciphertext FROM sylph_recovery_object_chunk WHERE manifest_id = ? AND ordinal = ?",
              [manifest.id, ordinal]
            )
          )[0]
        )
        if (chunk.ordinal !== ordinal || chunk.ciphertext.length > 43712)
          throw new Error("Object snapshot chunk exceeds bounds")
        const plain = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: unbase64(chunk.iv),
              additionalData: aad(manifest.id, ordinal),
            },
            encryptionKey,
            unbase64(chunk.ciphertext)
          )
        )
        if (
          plain.length > 32768 ||
          (ordinal < manifest.chunkCount - 1 && plain.length !== 32768)
        )
          throw new Error("Object snapshot chunk is incomplete")
        bytes.push(...plain)
      }
      const json = new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(bytes)
      )
      if ((await digest(json)) !== manifest.fingerprint)
        throw new Error("Object snapshot integrity differs")
      return Schema.decodeUnknownSync(RecoveryObjectSnapshot)(JSON.parse(json))
    }
    const capture = Effect.fn("ObjectRecovery.capture")(function* (
      identity: RecoveryObjectIdentity,
      releaseId: string,
      forDrill = false
    ) {
      return yield* attempt("Capture registered object", async () => {
        const json = await snapshot(identity, releaseId)
        let restoreVerifiedAt = 0
        if (!forDrill) {
          const proof = Schema.decodeUnknownSync(RecoveryObjectDrillProof)(
            (
              await query(
                "SELECT d.schema_fingerprint, d.verified_at FROM sylph_recovery_object_drill d JOIN sylph_recovery_object_drill_operation o ON o.namespace_id = d.namespace_id WHERE d.namespace_id = ? AND d.object_id = ? AND o.phase = 'verified'",
                [identity.namespaceId, identity.objectId]
              )
            )[0]
          )
          if (
            proof.verified_at <= 0 ||
            proof.verified_at > now() ||
            proof.schema_fingerprint !==
              (await objectSchemaFingerprint(
                Schema.decodeUnknownSync(RecoveryObjectSnapshot)(
                  JSON.parse(json)
                )
              ))
          )
            throw new Error(
              "Object requires a verified restore drill for its storage schema"
            )
          restoreVerifiedAt = proof.verified_at
        }
        const bytes = new TextEncoder().encode(json)
        const id = crypto.randomUUID()
        const manifest = Schema.decodeUnknownSync(RecoveryObjectManifest)({
          version: 1,
          id,
          projectId: configuration.projectId,
          releaseId,
          identity,
          capturedAt: now(),
          restoreVerifiedAt,
          expiresAt: now() + 6 * 86400000,
          fingerprint: await digest(json),
          chunkCount: Math.ceil(bytes.length / 32768),
        })
        const encryptionKey = await key()
        for (let ordinal = 0; ordinal < manifest.chunkCount; ordinal++) {
          const iv = crypto.getRandomValues(new Uint8Array(12))
          const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-GCM", iv, additionalData: aad(id, ordinal) },
              encryptionKey,
              bytes.slice(ordinal * 32768, (ordinal + 1) * 32768)
            )
          )
          await query(
            "INSERT INTO sylph_recovery_object_chunk (manifest_id, ordinal, iv, ciphertext) VALUES (?, ?, ?, ?)",
            [id, ordinal, base64(iv), base64(ciphertext)]
          )
        }
        if (
          (await digest(await snapshot(identity, releaseId))) !==
          manifest.fingerprint
        )
          throw new Error("Object changed during capture")
        const saved = JSON.stringify(manifest)
        await query(
          "INSERT INTO sylph_recovery_object_manifest (id, project_id, release_id, namespace_id, object_id, json, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            id,
            configuration.projectId,
            releaseId,
            identity.namespaceId,
            identity.objectId,
            saved,
            await digest(saved),
          ]
        )
        return readSaved(id)
      })
    })
    const preflight = async (
      manifest: RecoveryObjectManifest,
      releaseId: string
    ) => {
      await paused(releaseId)
      if (
        JSON.stringify(await readSaved(manifest.id)) !==
          JSON.stringify(manifest) ||
        manifest.expiresAt <= now()
      )
        throw new Error("Object manifest expired or differs")
      await savedSnapshot(manifest)
      if (
        (
          await query(
            "SELECT phase FROM sylph_recovery_object_operation WHERE release_id = ? AND namespace_id = ? AND object_id = ?",
            [
              releaseId,
              manifest.identity.namespaceId,
              manifest.identity.objectId,
            ]
          )
        ).length > 0
      )
        throw new Error("Object restore was already attempted")
      const undoRows = await query(
        "SELECT id FROM sylph_recovery_object_manifest WHERE project_id = ? AND release_id = ? AND namespace_id = ? AND object_id = ? ORDER BY rowid DESC LIMIT 1",
        [
          configuration.projectId,
          releaseId,
          manifest.identity.namespaceId,
          manifest.identity.objectId,
        ]
      )
      const undo = await readSaved(
        Schema.decodeUnknownSync(Schema.String)(undoRows[0]?.id)
      )
      if (
        undo.id === manifest.id ||
        undo.expiresAt <= now() ||
        now() - undo.capturedAt > 900000 ||
        (await digest(await snapshot(manifest.identity, releaseId))) !==
          undo.fingerprint
      )
        throw new Error("Object restore requires a fresh matching undo point")
      await savedSnapshot(undo)
    }
    const restore = Effect.fn("ObjectRecovery.restore")(function* (
      manifest: RecoveryObjectManifest,
      releaseId: string
    ) {
      yield* attempt("Restore registered object", async () => {
        await preflight(manifest, releaseId)
        const saved = await savedSnapshot(manifest)
        await query(
          "INSERT INTO sylph_recovery_object_operation (release_id, namespace_id, object_id, manifest_id, phase) VALUES (?, ?, ?, ?, 'restoring')",
          [
            releaseId,
            manifest.identity.namespaceId,
            manifest.identity.objectId,
            manifest.id,
          ]
        )
        try {
          const response = Schema.decodeUnknownSync(RecoveryObjectResponse)(
            await configuration.transport({
              operation: "restore",
              identity: manifest.identity,
              releaseId,
              snapshot: saved,
            })
          )
          if (
            identityKey(response.identity) !== identityKey(manifest.identity) ||
            (await digest(JSON.stringify(response.snapshot))) !==
              manifest.fingerprint ||
            (await digest(await snapshot(manifest.identity, releaseId))) !==
              manifest.fingerprint
          )
            throw new Error("Restored object differs")
          await query(
            "UPDATE sylph_recovery_object_operation SET phase = 'verified' WHERE release_id = ? AND namespace_id = ? AND object_id = ?",
            [
              releaseId,
              manifest.identity.namespaceId,
              manifest.identity.objectId,
            ]
          )
        } catch (error) {
          await query(
            "UPDATE sylph_recovery_object_operation SET phase = 'uncertain' WHERE release_id = ? AND namespace_id = ? AND object_id = ?",
            [
              releaseId,
              manifest.identity.namespaceId,
              manifest.identity.objectId,
            ]
          )
          throw error
        }
      })
    })
    return CloudflareObjectRecovery.of({
      capture: (identity, releaseId) => capture(identity, releaseId),
      captureForDrill: (identity, releaseId) =>
        capture(identity, releaseId, true),
      read: (id) => attempt("Read object manifest", () => readSaved(id)),
      fingerprint: (identity, releaseId) =>
        attempt("Fingerprint registered object", async () =>
          digest(await snapshot(identity, releaseId))
        ),
      preflightRestore: (manifest, releaseId) =>
        attempt("Preflight object restore", () =>
          preflight(manifest, releaseId)
        ),
      restore,
    })
  })
