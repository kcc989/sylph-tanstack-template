import { Effect, Schema } from "effect"
import {
  CloudflareRecoveryFailure,
  RecoveryGate,
  RecoveryQueryResponse,
} from "./domain"
import {
  RecoveryObjectsResponse,
  RecoveryObjectResponse,
  type RecoveryObjectSnapshot,
} from "./object-domain"
import {
  CloudflareObjectRecovery,
  objectSchemaFingerprint,
  objectSnapshotFingerprint,
  type ObjectRecoveryConfiguration,
} from "./object"

export const verifyObjectRecoveryDrill = Effect.fn(
  "ObjectRecovery.drillInitialNamespace"
)(function* (
  configuration: ObjectRecoveryConfiguration,
  namespaceId: string,
  releaseId: string
) {
  const objects = yield* CloudflareObjectRecovery
  yield* Effect.tryPromise({
    try: async () => {
      const root =
        configuration.apiBaseUrl ??
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`
      const request = async (
        path: string,
        body?: { sql: string; params: readonly (string | number)[] }
      ) => {
        const response = await (configuration.fetch ?? fetch)(
          `${root}${path}`,
          {
            method: body ? "POST" : "GET",
            headers: {
              Authorization: `Bearer ${configuration.apiToken}`,
              "Content-Type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
            redirect: "error",
            signal: AbortSignal.timeout(60000),
          }
        )
        if (!response.ok)
          throw new Error("Object drill provider request failed")
        return response.json()
      }
      const query = async (
        sql: string,
        params: readonly (string | number)[] = []
      ) => {
        const response = Schema.decodeUnknownSync(RecoveryQueryResponse)(
          await request(
            `/d1/database/${encodeURIComponent(configuration.controlDatabaseId)}/query`,
            { sql, params }
          )
        )
        if (
          !response.success ||
          response.result.length !== 1 ||
          !response.result[0]?.success
        )
          throw new Error("Object drill control query failed")
        return response.result[0].results
      }
      const paused = async () => {
        const gate = Schema.decodeUnknownSync(RecoveryGate)(
          (
            await query(
              "SELECT owner, active FROM sylph_recovery_gate WHERE id = 1"
            )
          )[0]
        )
        if (gate.owner !== releaseId || gate.active !== 0)
          throw new Error("Object drill requires its drained release gate")
      }
      const identities = configuration.identities.filter(
        (identity) => identity.namespaceId === namespaceId
      )
      if (
        !identities.length ||
        identities.length > 100 ||
        new Set(identities.map((identity) => identity.objectId)).size !==
          identities.length
      )
        throw new Error("Invalid namespace drill registry")
      await paused()
      const listed = Schema.decodeUnknownSync(RecoveryObjectsResponse)(
        await request(
          `/workers/durable_objects/namespaces/${encodeURIComponent(namespaceId)}/objects?limit=1000`
        )
      )
      if (
        listed.result_info?.cursor ||
        listed.result.some(
          (object) =>
            object.hasStoredData ||
            !identities.some((identity) => identity.objectId === object.id)
        )
      )
        throw new Error(
          "Initial object drill requires a provider-confirmed empty namespace"
        )
      if (
        (
          await query(
            "SELECT id FROM sylph_recovery_object_manifest WHERE namespace_id = ? LIMIT 1",
            [namespaceId]
          )
        ).length
      )
        throw new Error("Namespace already has snapshots; inspect prior work")
      if (
        (
          await query(
            "SELECT phase FROM sylph_recovery_object_drill_operation WHERE namespace_id = ?",
            [namespaceId]
          )
        ).length
      )
        throw new Error("Namespace drill was already attempted")
      const originals = []
      for (const identity of identities) {
        const response = Schema.decodeUnknownSync(RecoveryObjectResponse)(
          await configuration.transport({
            operation: "capture",
            identity,
            releaseId,
          })
        )
        if (
          response.identity.namespaceId !== namespaceId ||
          response.identity.objectId !== identity.objectId ||
          response.snapshot.values.length ||
          response.snapshot.tables.some((table) => table.rows.length) ||
          response.snapshot.tables.length >= 32
        )
          throw new Error(
            "Initial object drill requires an empty bounded object"
          )
        const manifest = await Effect.runPromise(
          objects.captureForDrill(identity, releaseId)
        )
        if (
          manifest.fingerprint !==
          (await objectSnapshotFingerprint(response.snapshot))
        )
          throw new Error("Initial object changed during preservation")
        originals.push({ identity, snapshot: response.snapshot, manifest })
      }
      await paused()
      await query(
        "INSERT INTO sylph_recovery_object_drill_operation (namespace_id, release_id, phase) VALUES (?, ?, 'probing')",
        [namespaceId, releaseId]
      )
      try {
        for (const original of originals) {
          await paused()
          const marker = crypto.randomUUID().replaceAll("-", "")
          const name = `sylph_drill_${marker}`
          const snapshot: RecoveryObjectSnapshot = {
            ...original.snapshot,
            tables: [
              ...original.snapshot.tables,
              {
                name,
                sql: `CREATE TABLE "${name}" (value TEXT NOT NULL, bytes BLOB NOT NULL, fraction REAL NOT NULL)`,
                columns: ["rowid", "value", "bytes", "fraction"],
                rows: [["37", marker, { bytes: [0, 255, 42] }, { real: 0.5 }]],
              },
            ].sort((left, right) =>
              left.name < right.name ? -1 : left.name > right.name ? 1 : 0
            ),
            values: [{ key: name, value: { marker } }],
          }
          await configuration.transport({
            operation: "restore",
            identity: original.identity,
            releaseId,
            snapshot,
          })
          const changed = Schema.decodeUnknownSync(RecoveryObjectResponse)(
            await configuration.transport({
              operation: "capture",
              identity: original.identity,
              releaseId,
            })
          )
          if (
            changed.identity.namespaceId !== namespaceId ||
            changed.identity.objectId !== original.identity.objectId ||
            JSON.stringify(changed.snapshot) !== JSON.stringify(snapshot)
          )
            throw new Error("Object drill probe was not independently observed")
          await Effect.runPromise(
            objects.captureForDrill(original.identity, releaseId)
          )
          await Effect.runPromise(objects.restore(original.manifest, releaseId))
          if (
            (await Effect.runPromise(
              objects.fingerprint(original.identity, releaseId)
            )) !== original.manifest.fingerprint
          )
            throw new Error("Object drill did not restore the original state")
        }
        await paused()
        const verifiedAt = configuration.now?.() ?? Date.now()
        for (const original of originals) {
          await query(
            "INSERT INTO sylph_recovery_object_drill (namespace_id, object_id, schema_fingerprint, verified_at, manifest_id) VALUES (?, ?, ?, ?, ?)",
            [
              namespaceId,
              original.identity.objectId,
              await objectSchemaFingerprint(original.snapshot),
              verifiedAt,
              original.manifest.id,
            ]
          )
        }
        await query(
          "UPDATE sylph_recovery_object_drill_operation SET phase = 'verified' WHERE namespace_id = ? AND release_id = ? AND phase = 'probing'",
          [namespaceId, releaseId]
        )
      } catch (error) {
        await query(
          "UPDATE sylph_recovery_object_drill_operation SET phase = 'uncertain' WHERE namespace_id = ? AND release_id = ? AND phase = 'probing'",
          [namespaceId, releaseId]
        )
        throw error
      }
    },
    catch: () =>
      new CloudflareRecoveryFailure({
        operation: "Verify initial object restore",
        message:
          "Initial object restore drill failed; keep the namespace paused and inspect its saved originals and operation. No automatic retry is permitted.",
      }),
  })
})
