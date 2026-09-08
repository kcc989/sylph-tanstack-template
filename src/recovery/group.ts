import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  CloudflareRecoveryFailure,
  D1RecoveryGroup,
  RecoveryQueryResponse,
  RecoveryTopology,
} from "./domain"
import { CloudflareD1Recovery, type RecoveryConfiguration } from "./recovery"
import { CloudflareR2Recovery } from "./r2"
import { CloudflareObjectRecovery } from "./object"

type Result<A> = Effect.Effect<A, CloudflareRecoveryFailure>
type Capture = { releaseId: string; liveReleaseId?: string }

export class CloudflareRecoveryGroup extends Context.Service<
  CloudflareRecoveryGroup,
  {
    capture: (input: Capture) => Result<D1RecoveryGroup>
    captureInitial: (input: Capture) => Result<D1RecoveryGroup>
    captureForDrill: (input: Capture) => Result<D1RecoveryGroup>
    restore: (id: string, releaseId: string) => Result<D1RecoveryGroup>
    read: (id: string) => Result<D1RecoveryGroup>
  }
>()("@sylph/CloudflareRecoveryGroup") {}

const digest = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")

export const CloudflareRecoveryGroupLive = (
  configuration: RecoveryConfiguration & { topology: RecoveryTopology }
) =>
  Layer.effect(
    CloudflareRecoveryGroup,
    Effect.gen(function* () {
      const recovery = yield* CloudflareD1Recovery
      const topology = Schema.decodeUnknownSync(RecoveryTopology)(
        configuration.topology
      )
      const ids = [
        ...new Set(topology.workers.flatMap((worker) => worker.databaseIds)),
      ].sort()
      if (ids.includes(configuration.controlDatabaseId))
        throw new Error(
          "Recovery control cannot be restored as application data"
        )
      const bucketNames = [
        ...new Set(
          topology.workers.flatMap((worker) => worker.bucketNames ?? [])
        ),
      ].sort()
      const optionalBuckets = yield* Effect.serviceOption(CloudflareR2Recovery)
      if (bucketNames.length > 0 && Option.isNone(optionalBuckets))
        throw new Error("R2 recovery requires its configured adapter")
      const buckets = Option.getOrUndefined(optionalBuckets)
      const objectIdentities = [
        ...new Map(
          topology.workers
            .flatMap((worker) =>
              (worker.durableObjects ?? []).flatMap((entry) =>
                entry.objectIds.map((objectId) => ({
                  namespaceId: entry.namespaceId,
                  objectId,
                }))
              )
            )
            .map((identity) => [JSON.stringify(identity), identity])
        ).values(),
      ].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
      if (objectIdentities.length > 100)
        throw new Error("Registered object inventory exceeds group bound")
      const optionalObjects = yield* Effect.serviceOption(
        CloudflareObjectRecovery
      )
      if (objectIdentities.length > 0 && Option.isNone(optionalObjects))
        throw new Error(
          "Registered objects require their configured recovery adapter"
        )
      const objects = Option.getOrUndefined(optionalObjects)
      const now = configuration.now ?? Date.now
      const topologyIdentity = (value: RecoveryTopology) =>
        JSON.stringify(
          value.workers.map(
            ({
              workerName,
              databaseIds,
              serviceTargets,
              bucketNames,
              managedKv,
              managedQueues,
              queueConsumers,
              durableObjects,
            }) => ({
              workerName,
              databaseIds,
              serviceTargets,
              bucketNames: bucketNames ?? [],
              managedKv: managedKv ?? [],
              managedQueues: managedQueues ?? [],
              queueConsumers: queueConsumers ?? [],
              durableObjects: durableObjects ?? [],
            })
          )
        )
      const topologyJson = topologyIdentity(topology)
      const fail = (operation: string) =>
        new CloudflareRecoveryFailure({
          operation,
          message: `${operation} failed; keep writers paused and inspect the saved group operation.`,
        })
      const attempt = <A>(
        operation: string,
        run: () => Promise<A>
      ): Result<A> =>
        Effect.tryPromise({ try: run, catch: () => fail(operation) })
      const query = (
        sql: string,
        params: readonly (string | number | null)[] = []
      ) =>
        attempt("Access recovery group", async () => {
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
          if (!response.ok) throw new Error("Control database rejected query")
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
        })
      const paused = Effect.fn("RecoveryGroup.paused")(function* (
        releaseId: string
      ) {
        const gate = yield* recovery.gate()
        if (gate.owner !== releaseId || gate.active !== 0)
          return yield* fail("Require drained group")
      })
      const read = Effect.fn("RecoveryGroup.read")(function* (id: string) {
        const rows = yield* query(
          "SELECT json, sha256 FROM sylph_recovery_group WHERE id = ? AND project_id = ?",
          [id, configuration.projectId]
        )
        return yield* attempt("Read immutable recovery group", async () => {
          const json = Schema.decodeUnknownSync(Schema.String)(rows[0]?.json)
          if ((await digest(json)) !== rows[0]?.sha256)
            throw new Error("Group integrity mismatch")
          const group = Schema.decodeUnknownSync(D1RecoveryGroup)(
            JSON.parse(json)
          )
          if (
            group.id !== id ||
            group.projectId !== configuration.projectId ||
            topologyIdentity(group.topology) !== topologyJson
          )
            throw new Error("Group identity or topology differs")
          if (
            JSON.stringify(
              group.databases.map((point) => point.databaseId).sort()
            ) !== JSON.stringify(ids)
          )
            throw new Error("Group must cover each application database once")
          if (
            group.databases.some(
              (point) =>
                point.releaseId !== group.releaseId ||
                point.projectId !== group.projectId ||
                point.expiresAt < group.expiresAt
            )
          )
            throw new Error("Group contains mismatched recovery points")
          if (
            JSON.stringify(
              (group.buckets ?? []).map((point) => point.bucketName).sort()
            ) !== JSON.stringify(bucketNames)
          )
            throw new Error("Group must cover each application bucket once")
          if (
            (group.buckets ?? []).some(
              (point) =>
                point.releaseId !== group.releaseId ||
                point.projectId !== group.projectId ||
                point.expiresAt < group.expiresAt
            )
          )
            throw new Error("Group contains mismatched bucket recovery points")
          if (
            JSON.stringify(
              (group.objects ?? [])
                .map((point) => point.identity)
                .sort((left, right) =>
                  JSON.stringify(left).localeCompare(JSON.stringify(right))
                )
            ) !== JSON.stringify(objectIdentities)
          )
            throw new Error(
              "Group must cover every registered object exactly once"
            )
          if (
            (group.objects ?? []).some(
              (point) =>
                point.projectId !== group.projectId ||
                point.releaseId !== group.releaseId ||
                point.expiresAt < group.expiresAt
            )
          )
            throw new Error("Group contains mismatched object recovery points")
          return group
        })
      })
      const capture = Effect.fn("RecoveryGroup.capture")(function* (
        input: Capture,
        drill: boolean,
        initial = false
      ) {
        yield* paused(input.releaseId)
        if (initial) {
          for (const worker of topology.workers)
            yield* attempt("Require absent initial Worker", async () => {
              const root =
                configuration.apiBaseUrl ??
                `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`
              const response = await (configuration.fetch ?? fetch)(
                `${root}/workers/scripts/${encodeURIComponent(worker.workerName)}/settings`,
                {
                  headers: {
                    Authorization: `Bearer ${configuration.apiToken}`,
                  },
                  redirect: "error",
                  signal: AbortSignal.timeout(60000),
                }
              )
              if (response.status !== 404)
                throw new Error("Initial capture requires an absent Worker")
            })
        } else yield* recovery.inventoryTopology(topology)
        const databases: Array<D1RecoveryGroup["databases"][number]> = []
        for (const databaseId of ids)
          databases.push(
            yield* (drill ? recovery.captureForDrill : recovery.capture)({
              ...input,
              databaseId,
            })
          )
        const bucketPoints: NonNullable<D1RecoveryGroup["buckets"]>[number][] =
          []
        if (buckets)
          for (const bucketName of bucketNames)
            bucketPoints.push(
              yield* (drill ? buckets.captureForDrill : buckets.capture)({
                bucketName,
                releaseId: input.releaseId,
              })
            )
        const objectPoints: NonNullable<D1RecoveryGroup["objects"]>[number][] =
          []
        if (objects)
          for (const identity of objectIdentities)
            objectPoints.push(yield* objects.capture(identity, input.releaseId))
        for (const point of databases) {
          const actual = yield* recovery.fingerprint(point.databaseId)
          if (actual.fingerprint !== point.fingerprint)
            return yield* fail("Database changed during group capture")
        }
        if (buckets)
          for (const point of bucketPoints) {
            const actual = yield* buckets.fingerprint(point.bucketName)
            if (actual.fingerprint !== point.fingerprint)
              return yield* fail("Bucket changed during group capture")
          }
        if (objects)
          for (const point of objectPoints)
            if (
              (yield* objects.fingerprint(point.identity, input.releaseId)) !==
              point.fingerprint
            )
              return yield* fail("Object changed during group capture")
        yield* paused(input.releaseId)
        const group = Schema.decodeUnknownSync(D1RecoveryGroup)({
          version: 1,
          id: crypto.randomUUID(),
          projectId: configuration.projectId,
          releaseId: input.releaseId,
          capturedAt: now(),
          expiresAt: Math.min(
            ...[...databases, ...bucketPoints, ...objectPoints].map(
              (point) => point.expiresAt
            )
          ),
          topology,
          databases,
          buckets: bucketNames.length ? bucketPoints : undefined,
          objects: objectIdentities.length ? objectPoints : undefined,
        })
        const json = JSON.stringify(group)
        const hash = yield* attempt("Hash recovery group", () => digest(json))
        yield* query(
          "INSERT INTO sylph_recovery_group (id, release_id, project_id, json, sha256) VALUES (?, ?, ?, ?, ?)",
          [group.id, group.releaseId, group.projectId, json, hash]
        )
        return yield* read(group.id)
      })
      const restore = Effect.fn("RecoveryGroup.restore")(function* (
        id: string,
        releaseId: string
      ) {
        yield* paused(releaseId)
        const target = yield* read(id)
        if (target.expiresAt <= now() || target.capturedAt > now())
          return yield* fail("Require unexpired recovery group")
        const rows = yield* query(
          "SELECT id FROM sylph_recovery_group WHERE project_id = ? AND release_id = ? ORDER BY rowid DESC LIMIT 1",
          [configuration.projectId, releaseId]
        )
        const undoId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
          rows[0]?.id
        ).pipe(Effect.mapError(() => fail("Require complete undo group")))
        const undo = yield* read(undoId)
        yield* recovery.inventoryTopology(undo.topology)
        if (
          undo.expiresAt <= now() ||
          undo.capturedAt < now() - 15 * 60000 ||
          undo.capturedAt > now()
        )
          return yield* fail("Require fresh undo group")
        for (const point of [...target.databases, ...undo.databases]) {
          const saved = yield* recovery.readManifest(point.id)
          if (
            JSON.stringify(saved) !== JSON.stringify(point) ||
            point.expiresAt <= now()
          )
            return yield* fail("Require matching immutable group members")
          yield* recovery.secrets(saved)
        }
        if (buckets) {
          for (const point of [
            ...(target.buckets ?? []),
            ...(undo.buckets ?? []),
          ]) {
            const saved = yield* buckets.readManifest(point.id)
            if (
              JSON.stringify(saved) !== JSON.stringify(point) ||
              point.expiresAt <= now()
            )
              return yield* fail(
                "Require matching immutable bucket group members"
              )
            yield* buckets.verifySnapshot(saved)
          }
          for (const point of undo.buckets ?? []) {
            const actual = yield* buckets.fingerprint(point.bucketName)
            if (actual.fingerprint !== point.fingerprint)
              return yield* fail("Undo group no longer matches current bucket")
          }
        }
        if (objects) {
          for (const point of [
            ...(target.objects ?? []),
            ...(undo.objects ?? []),
          ]) {
            if (
              JSON.stringify(yield* objects.read(point.id)) !==
              JSON.stringify(point)
            )
              return yield* fail("Require immutable object group members")
          }
          for (const point of target.objects ?? [])
            yield* objects.preflightRestore(point, releaseId)
          for (const point of undo.objects ?? [])
            if (
              (yield* objects.fingerprint(point.identity, releaseId)) !==
              point.fingerprint
            )
              return yield* fail("Undo group no longer matches object state")
        }
        for (const point of undo.databases) {
          const actual = yield* recovery.fingerprint(point.databaseId)
          if (actual.fingerprint !== point.fingerprint)
            return yield* fail("Undo group no longer matches current data")
        }
        for (const point of target.databases)
          yield* recovery.preflightRestore(point, releaseId)
        if (buckets)
          for (const point of target.buckets ?? [])
            yield* buckets.preflightRestore(point, releaseId)
        yield* paused(releaseId)
        yield* query(
          "INSERT INTO sylph_recovery_group_operation (release_id, group_id, phase) VALUES (?, ?, 'restoring')",
          [releaseId, id]
        )
        const program = Effect.gen(function* () {
          for (const point of target.databases)
            yield* recovery.restore(point, releaseId)
          if (objects)
            for (const point of target.objects ?? [])
              yield* objects.restore(point, releaseId)
          if (buckets)
            for (const point of target.buckets ?? [])
              yield* buckets.restore(point, releaseId)
          for (const point of target.databases) {
            const actual = yield* recovery.fingerprint(point.databaseId)
            if (actual.fingerprint !== point.fingerprint)
              return yield* fail("Verify coordinated restored data")
          }
          if (buckets)
            for (const point of target.buckets ?? []) {
              const actual = yield* buckets.fingerprint(point.bucketName)
              if (actual.fingerprint !== point.fingerprint)
                return yield* fail("Verify coordinated restored bucket")
            }
          if (objects)
            for (const point of target.objects ?? [])
              if (
                (yield* objects.fingerprint(point.identity, releaseId)) !==
                point.fingerprint
              )
                return yield* fail("Verify coordinated restored object")
          yield* paused(releaseId)
          yield* query(
            "UPDATE sylph_recovery_group_operation SET phase = 'verified' WHERE release_id = ? AND group_id = ? AND phase = 'restoring'",
            [releaseId, id]
          )
          return target
        })
        return yield* program.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* query(
                "UPDATE sylph_recovery_group_operation SET phase = 'uncertain' WHERE release_id = ? AND group_id = ? AND phase = 'restoring'",
                [releaseId, id]
              )
              return yield* error
            })
          )
        )
      })
      return CloudflareRecoveryGroup.of({
        capture: (input) => capture(input, false),
        captureInitial: (input) => capture(input, false, true),
        captureForDrill: (input) => capture(input, true),
        restore,
        read,
      })
    })
  )
