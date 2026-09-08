import { Context, Effect, Layer, Schema } from "effect"
import { RecoveryObjectsResponse } from "./object-domain"
import {
  CloudflareRecoveryFailure,
  D1RecoveryManifest,
  D1RestoreEvidence,
  RecoveryBookmarkResponse,
  RecoveryGate,
  RecoveryQueryResponse,
  RecoveryQueuesResponse,
  RecoveryRestoreResponse,
  RecoverySchemaRows,
  RecoverySecretValues,
  RecoverySecretSnapshot,
  RecoverySchedulesResponse,
  RecoverySettingsResponse,
  RecoveryTopology,
  type RecoveryWorkerInventory,
  type RecoverySqlRow,
} from "./domain"

export interface RecoveryConfiguration {
  accountId: string
  apiToken: string
  apiBaseUrl?: string
  controlDatabaseId: string
  projectId: string
  encryptionKey: string
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
  drainTimeoutMs?: number
}

export interface CaptureInput {
  databaseId: string
  releaseId: string
  liveReleaseId?: string
}

interface RecoveryFingerprint {
  fingerprint: string
  schemaFingerprint: string
}

interface RecoveryInventory {
  workerName: string
  databaseId: string
  secretNames: readonly string[]
}

type RecoveryResult<A> = Effect.Effect<A, CloudflareRecoveryFailure>

export class CloudflareD1Recovery extends Context.Service<
  CloudflareD1Recovery,
  {
    gate: () => RecoveryResult<typeof RecoveryGate.Type>
    adoptPause: (
      previousReleaseId: string,
      releaseId: string
    ) => RecoveryResult<void>
    stageSecrets: (
      releaseId: string,
      secrets: typeof RecoverySecretValues.Type
    ) => RecoveryResult<void>
    restoreProof: (
      schemaFingerprint: string
    ) => RecoveryResult<D1RestoreEvidence>
    pause: (releaseId: string) => RecoveryResult<void>
    resume: (releaseId: string) => RecoveryResult<void>
    inventory: (input: RecoveryInventory) => RecoveryResult<void>
    inventoryTopology: (input: RecoveryTopology) => RecoveryResult<void>
    captureForDrill: (input: CaptureInput) => RecoveryResult<D1RecoveryManifest>
    capture: (input: CaptureInput) => RecoveryResult<D1RecoveryManifest>
    readManifest: (id: string) => RecoveryResult<D1RecoveryManifest>
    preflightRestore: (
      manifest: D1RecoveryManifest,
      releaseId: string
    ) => RecoveryResult<void>
    restore: (
      manifest: D1RecoveryManifest,
      releaseId: string
    ) => RecoveryResult<D1RestoreEvidence>
    secrets: (
      manifest: D1RecoveryManifest
    ) => RecoveryResult<typeof RecoverySecretValues.Type>
    fingerprint: (databaseId: string) => RecoveryResult<RecoveryFingerprint>
  }
>()("@sylph/CloudflareD1Recovery") {}

const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value))
const unbase64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`
const canonicalRow = (row: typeof RecoverySqlRow.Type) =>
  JSON.stringify(
    Object.entries(row).sort(([left], [right]) => left.localeCompare(right))
  )

const createRecovery = (
  configuration: RecoveryConfiguration
): CloudflareD1Recovery["Service"] => {
  const fetcher = configuration.fetch ?? globalThis.fetch
  const now = configuration.now ?? Date.now
  const root =
    configuration.apiBaseUrl ??
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`
  const endpoint = new URL(root)
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    root.endsWith("/")
  )
    throw new Error("Recovery API base must be a clean HTTPS account endpoint")
  const wrap = <A>(
    operation: string,
    run: () => Promise<A>
  ): RecoveryResult<A> =>
    Effect.tryPromise({
      try: run,
      catch: () =>
        new CloudflareRecoveryFailure({
          operation,
          message: `${operation} failed; retain the writer pause and inspect the recovery operation. Provider response bodies are withheld because they can contain application data.`,
        }),
    })
  const request = async (path: string, method = "GET", body?: string) => {
    const response = await fetcher(`${root}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${configuration.apiToken}`,
        "Content-Type": "application/json",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(`Cloudflare ${response.status}`)
    return response.json()
  }
  const query = async (
    databaseId: string,
    sql: string,
    params: readonly (string | number | null)[] = []
  ) => {
    const response = Schema.decodeUnknownSync(RecoveryQueryResponse)(
      await request(
        `/d1/database/${encodeURIComponent(databaseId)}/query`,
        "POST",
        JSON.stringify({ sql, params })
      )
    )
    if (
      !response.success ||
      response.result.length !== 1 ||
      !response.result[0]?.success
    )
      throw new Error("D1 query failed")
    return response.result[0].results
  }
  const control = (
    sql: string,
    params: readonly (string | number | null)[] = []
  ) => query(configuration.controlDatabaseId, sql, params)
  const paused = async (releaseId: string) => {
    const rows = await control(
      "SELECT owner, active FROM sylph_recovery_gate WHERE id = 1"
    )
    const state = Schema.decodeUnknownSync(RecoveryGate)(rows[0])
    if (state.owner !== releaseId || state.active !== 0)
      throw new Error("Writers are not drained under this release")
  }
  const bookmark = async (databaseId: string) => {
    const response = Schema.decodeUnknownSync(RecoveryBookmarkResponse)(
      await request(
        `/d1/database/${encodeURIComponent(databaseId)}/time_travel/bookmark`
      )
    )
    if (!response.success) throw new Error("Bookmark unavailable")
    return response.result.bookmark
  }
  const fingerprint = async (
    databaseId: string
  ): Promise<RecoveryFingerprint> => {
    const schema = Schema.decodeUnknownSync(RecoverySchemaRows)(
      await query(
        databaseId,
        "SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type, name"
      )
    )
    const tables = schema.filter((row) => row.type === "table")
    const contents: string[] = []
    for (const table of tables) {
      const rows = await query(
        databaseId,
        `SELECT * FROM ${quoted(table.name)} LIMIT 10001`
      )
      if (rows.length > 10000)
        throw new Error(
          "Database exceeds the verified adapter bound of 10000 rows per table"
        )
      const counts = await query(
        databaseId,
        `SELECT COUNT(*) AS total FROM ${quoted(table.name)}`
      )
      if (counts[0]?.total !== rows.length)
        throw new Error("D1 returned incomplete rows")
      contents.push(JSON.stringify([table.name, rows.map(canonicalRow).sort()]))
    }
    const schemaFingerprint = await sha256(JSON.stringify(schema))
    return {
      schemaFingerprint,
      fingerprint: await sha256(JSON.stringify([schemaFingerprint, contents])),
    }
  }
  const encryptionKey = async () => {
    const bytes = unbase64(configuration.encryptionKey)
    if (bytes.length !== 32)
      throw new Error("Recovery encryption key must be 32 bytes")
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ])
  }
  const associatedData = (manifestId: string, name: string) =>
    new TextEncoder().encode(
      JSON.stringify([configuration.projectId, manifestId, name])
    )
  const secrets = async (manifest: RecoverySecretSnapshot) => {
    if (manifest.projectId !== configuration.projectId)
      throw new Error("Foreign secret snapshot")
    const key = await encryptionKey()
    const result: Record<string, string> = {}
    for (const secret of manifest.secrets) {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unbase64(secret.iv),
          additionalData: associatedData(manifest.id, secret.name),
        },
        key,
        unbase64(secret.ciphertext)
      )
      result[secret.name] = new TextDecoder().decode(plaintext)
    }
    return Schema.decodeUnknownSync(RecoverySecretValues)(result)
  }
  const encryptSecrets = async (
    id: string,
    values: typeof RecoverySecretValues.Type
  ) => {
    const key = await encryptionKey()
    const encrypted: Array<(typeof D1RecoveryManifest.Type.secrets)[number]> =
      []
    for (const [name, value] of Object.entries(values).sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: associatedData(id, name) },
        key,
        new TextEncoder().encode(value)
      )
      encrypted.push({
        name,
        version: crypto.randomUUID(),
        iv: base64(iv),
        ciphertext: base64(new Uint8Array(ciphertext)),
      })
    }
    return encrypted
  }
  const deploymentSecrets = async (releaseId: string) => {
    const rows = await control(
      "SELECT json, sha256 FROM sylph_recovery_secret_deployment WHERE release_id = ? AND project_id = ?",
      [releaseId, configuration.projectId]
    )
    const json = Schema.decodeUnknownSync(Schema.String)(rows[0]?.json)
    if ((await sha256(json)) !== rows[0]?.sha256)
      throw new Error("Secret snapshot integrity failure")
    const snapshot = Schema.decodeUnknownSync(RecoverySecretSnapshot)(
      JSON.parse(json)
    )
    if (
      snapshot.id !== releaseId ||
      snapshot.projectId !== configuration.projectId
    )
      throw new Error("Secret snapshot identity mismatch")
    return secrets(snapshot)
  }
  const readManifest = async (id: string) => {
    const rows = await control(
      "SELECT json, sha256 FROM sylph_recovery_manifest WHERE id = ? AND project_id = ?",
      [id, configuration.projectId]
    )
    const stored = rows[0]
    const json = Schema.decodeUnknownSync(Schema.String)(stored?.json)
    if ((await sha256(json)) !== stored?.sha256)
      throw new Error("Manifest integrity failure")
    const manifest = Schema.decodeUnknownSync(D1RecoveryManifest)(
      JSON.parse(json)
    )
    if (
      manifest.id !== id ||
      manifest.projectId !== configuration.projectId ||
      manifest.databaseId === configuration.controlDatabaseId
    )
      throw new Error("Manifest identity mismatch")
    return manifest
  }
  const restoreProof = async (
    schemaFingerprint: string
  ): Promise<D1RestoreEvidence> => {
    const rows = await control(
      "SELECT evidence FROM (SELECT evidence, json_extract(evidence, '$.verifiedAt') AS sequence FROM sylph_recovery_resource_operation WHERE resource_kind = 'd1' AND schema_fingerprint = ? AND phase = 'verified' UNION ALL SELECT evidence, json_extract(evidence, '$.verifiedAt') AS sequence FROM sylph_recovery_operation WHERE schema_fingerprint = ? AND phase = 'verified') ORDER BY sequence DESC LIMIT 1",
      [schemaFingerprint, schemaFingerprint]
    )
    const evidence = Schema.decodeUnknownSync(D1RestoreEvidence)(
      JSON.parse(Schema.decodeUnknownSync(Schema.String)(rows[0]?.evidence))
    )
    if (
      evidence.schemaFingerprint !== schemaFingerprint ||
      evidence.verifiedAt > now() ||
      evidence.verifiedAt < now() - 30 * 86400000
    )
      throw new Error("Restore drill evidence is stale")
    return evidence
  }
  const capture = async (
    input: CaptureInput,
    requireProof: boolean
  ): Promise<D1RecoveryManifest> => {
    if (input.databaseId === configuration.controlDatabaseId)
      throw new Error("Cannot capture control state as application data")
    await paused(input.releaseId)
    const id = crypto.randomUUID()
    const capturedAt = now()
    const before = await bookmark(input.databaseId)
    const snapshot = await fingerprint(input.databaseId)
    const after = await bookmark(input.databaseId)
    await paused(input.releaseId)
    if (before !== after)
      throw new Error("Application data changed during capture")
    const baselineSecrets = input.liveReleaseId
      ? await deploymentSecrets(input.liveReleaseId)
      : {}
    const encryptedSecrets = await encryptSecrets(id, baselineSecrets)
    const restoreVerifiedAt = requireProof
      ? (await restoreProof(snapshot.schemaFingerprint)).verifiedAt
      : 0
    const manifest = Schema.decodeUnknownSync(D1RecoveryManifest)({
      version: 1,
      id,
      projectId: configuration.projectId,
      releaseId: input.releaseId,
      databaseId: input.databaseId,
      capturedAt,
      restoreVerifiedAt,
      expiresAt: capturedAt + 6 * 86400000,
      bookmark: after,
      ...snapshot,
      secrets: encryptedSecrets,
    })
    const json = JSON.stringify(manifest)
    await control(
      "INSERT INTO sylph_recovery_manifest (id, project_id, release_id, database_id, json, sha256) VALUES (?, ?, ?, ?, ?, ?)",
      [
        id,
        configuration.projectId,
        input.releaseId,
        input.databaseId,
        json,
        await sha256(json),
      ]
    )
    return readManifest(id)
  }
  const inventoryWorker = async (input: RecoveryWorkerInventory) => {
    const response = Schema.decodeUnknownSync(RecoverySettingsResponse)(
      await request(
        `/workers/scripts/${encodeURIComponent(input.workerName)}/settings`
      )
    )
    if (!response.success) throw new Error("Worker bindings unavailable")
    const databases = response.result.bindings
      .filter((binding) => binding.type === "d1")
      .map((binding) => binding.id)
      .sort()
    if (
      JSON.stringify(databases) !==
      JSON.stringify(
        [...input.databaseIds, configuration.controlDatabaseId].sort()
      )
    )
      throw new Error("Database inventory mismatch")
    const bucketBindings = response.result.bindings.filter(
      (binding) => binding.type === "r2_bucket"
    )
    if (
      bucketBindings.some(
        (binding) => !binding.bucket_name || binding.jurisdiction
      ) ||
      JSON.stringify(
        bucketBindings.map((binding) => binding.bucket_name).sort()
      ) !== JSON.stringify([...(input.bucketNames ?? [])].sort())
    )
      throw new Error(
        "R2 bucket inventory mismatch or unsupported jurisdiction"
      )
    const declaredSecrets = [...input.secretNames].sort()
    const actualSecrets = response.result.bindings
      .filter((binding) => binding.type === "secret_text")
      .map((binding) => binding.name)
      .sort()
    if (JSON.stringify(declaredSecrets) !== JSON.stringify(actualSecrets))
      throw new Error("Secret inventory mismatch")
    const managedKv = input.managedKv ?? []
    const managedQueues = input.managedQueues ?? []
    const managed = [...managedKv, ...managedQueues]
    if (
      new Set(managed.map((binding) => binding.bindingName)).size !==
        managed.length ||
      managed.some(
        (binding) => !input.databaseIds.includes(binding.databaseId)
      ) ||
      (input.queueConsumers ?? []).some(
        (queue) => !input.databaseIds.includes(queue.databaseId)
      )
    )
      throw new Error(
        "Managed bindings require unique names and a captured application journal"
      )
    const kvBindings = response.result.bindings.filter(
      (binding) => binding.type === "kv_namespace"
    )
    if (
      kvBindings.length !== managedKv.length ||
      kvBindings.some(
        (binding) =>
          !managedKv.some(
            (managed) =>
              managed.bindingName === binding.name &&
              managed.namespaceId === binding.namespace_id
          )
      )
    )
      throw new Error("KV bindings require exact managed journal declarations")
    const queueBindings = response.result.bindings.filter(
      (binding) => binding.type === "queue"
    )
    if (
      queueBindings.length !== managedQueues.length ||
      queueBindings.some(
        (binding) =>
          !managedQueues.some(
            (managed) =>
              managed.bindingName === binding.name &&
              managed.queueName === binding.queue_name
          )
      )
    )
      throw new Error(
        "Queue bindings require exact managed journal declarations"
      )
    const registered = input.durableObjects ?? []
    const objectBindings = response.result.bindings.filter(
      (binding) => binding.type === "durable_object_namespace"
    )
    if (
      new Set(registered.map((entry) => entry.bindingName)).size !==
        registered.length ||
      objectBindings.length !== registered.length ||
      objectBindings.some(
        (binding) =>
          !registered.some(
            (entry) =>
              entry.bindingName === binding.name &&
              entry.namespaceId === binding.namespace_id
          )
      )
    )
      throw new Error(
        "Durable Object bindings require exact registered namespace declarations"
      )
    for (const entry of registered) {
      const seen = new Set<string>()
      const cursors = new Set<string>()
      let cursor = ""
      for (let page = 0; page < 100; page++) {
        const response = Schema.decodeUnknownSync(RecoveryObjectsResponse)(
          await request(
            `/workers/durable_objects/namespaces/${encodeURIComponent(entry.namespaceId)}/objects?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
          )
        )
        for (const object of response.result) {
          if (seen.has(object.id) || !entry.objectIds.includes(object.id))
            throw new Error("Namespace contains an unregistered object")
          seen.add(object.id)
        }
        cursor = response.result_info?.cursor ?? ""
        if (!cursor) {
          if (response.result.length >= 100)
            throw new Error("Object inventory pagination is incomplete")
          break
        }
        if (cursors.has(cursor) || page === 99)
          throw new Error("Object inventory cursor repeats or exceeds bound")
        cursors.add(cursor)
      }
    }
    const safeBindings = new Set([
      "d1",
      "r2_bucket",
      "durable_object_namespace",
      "kv_namespace",
      "queue",
      "secret_text",
      "plain_text",
      "json",
      "assets",
      "service",
      "ai",
    ])
    if (
      response.result.bindings.some(
        (binding) => !safeBindings.has(binding.type)
      )
    )
      throw new Error("Unsupported stateful or external binding")
    const serviceBindings = response.result.bindings.filter(
      (binding) => binding.type === "service"
    )
    if (
      serviceBindings.some(
        (binding) =>
          !binding.service || binding.environment || binding.entrypoint
      )
    )
      throw new Error("Service binding must target the default owned Worker")
    if (
      JSON.stringify(
        serviceBindings.map((binding) => binding.service).sort()
      ) !== JSON.stringify([...input.serviceTargets].sort())
    )
      throw new Error("Service inventory mismatch")
    const controlBindings = response.result.bindings.filter(
      (binding) => binding.name === "SYLPH_RECOVERY_CONTROL"
    )
    if (
      controlBindings.length !== 1 ||
      controlBindings[0]?.type !== "d1" ||
      controlBindings[0]?.id !== configuration.controlDatabaseId
    )
      throw new Error("Every Worker must share the exact recovery gate")
    const schedules = await request(
      `/workers/scripts/${encodeURIComponent(input.workerName)}/schedules`
    )
    const scheduleResponse = Schema.decodeUnknownSync(
      RecoverySchedulesResponse
    )(schedules)
    if (
      !scheduleResponse.success ||
      scheduleResponse.result.schedules.length !== 0
    )
      throw new Error("Scheduled writers are unsupported")
  }
  const inventoryQueues = async (topology: RecoveryTopology) => {
    const queues: Array<(typeof RecoveryQueuesResponse.Type.result)[number]> =
      []
    let total = 0
    for (let page = 1; page <= 100; page++) {
      const response = Schema.decodeUnknownSync(RecoveryQueuesResponse)(
        await request(`/queues?page=${page}&per_page=100`)
      )
      if (
        response.result_info.page !== page ||
        response.result_info.total_pages > 100
      )
        throw new Error("Queue inventory pagination is invalid")
      if (page > 1 && total !== response.result_info.total_count)
        throw new Error("Queue inventory changed during inspection")
      total = response.result_info.total_count
      if (
        response.result.some((queue) =>
          queue.consumers.some(
            (consumer) =>
              consumer.script &&
              consumer.script_name &&
              consumer.script !== consumer.script_name
          )
        )
      )
        throw new Error("Queue consumer identity aliases disagree")
      queues.push(...response.result)
      if (page >= response.result_info.total_pages) break
    }
    if (
      queues.length !== total ||
      new Set(queues.map((queue) => queue.queue_id)).size !== queues.length
    )
      throw new Error("Queue inventory is incomplete")
    for (const worker of topology.workers) {
      const declared = worker.queueConsumers ?? []
      const actual = queues.filter((queue) =>
        queue.consumers.some(
          (consumer) =>
            (consumer.script_name ?? consumer.script) === worker.workerName
        )
      )
      if (
        actual.some(
          (queue) =>
            !declared.some(
              (consumer) =>
                consumer.queueId === queue.queue_id &&
                consumer.queueName === queue.queue_name
            )
        )
      )
        throw new Error(
          "Queue consumer inventory differs from reviewed managed consumers"
        )
    }
    const declarations = topology.workers.flatMap((worker) => [
      ...(worker.managedQueues ?? []).map((queue) => ({
        ...queue,
        workerName: worker.workerName,
        role: "producer",
      })),
      ...(worker.queueConsumers ?? []).map((queue) => ({
        ...queue,
        workerName: worker.workerName,
        role: "consumer",
      })),
    ])
    for (const declaration of declarations) {
      const queue = queues.find(
        (queue) =>
          queue.queue_id === declaration.queueId &&
          queue.queue_name === declaration.queueName
      )
      if (
        !queue ||
        queue.consumers.length !== queue.consumers_total_count ||
        queue.producers.length !== queue.producers_total_count
      )
        throw new Error("Managed queue inventory is unavailable or truncated")
      const related = declarations.filter(
        (value) => value.queueId === declaration.queueId
      )
      if (
        related.some(
          (value) =>
            value.databaseId !== declaration.databaseId ||
            value.queueName !== declaration.queueName
        )
      )
        throw new Error(
          "Managed queue declarations disagree on journal identity"
        )
      if (
        queue.consumers.length > 1 ||
        queue.consumers.some(
          (consumer) =>
            consumer.type !== "worker" ||
            !related.some(
              (value) =>
                value.role === "consumer" &&
                value.workerName === (consumer.script_name ?? consumer.script)
            )
        )
      )
        throw new Error("Managed queues allow at most one owned gated consumer")
      if (
        new Set(queue.producers.map((producer) => producer.script)).size !==
          queue.producers.length ||
        queue.producers.some(
          (producer) =>
            producer.type !== "worker" ||
            !related.some(
              (value) =>
                value.role === "producer" &&
                value.workerName === producer.script
            )
        )
      )
        throw new Error("Managed queues cannot have unreviewed producers")
    }
  }
  const inventoryTopology = async (value: RecoveryTopology) => {
    const topology = Schema.decodeUnknownSync(RecoveryTopology)(value)
    await inventoryQueues(topology)
    const names = new Set(topology.workers.map((worker) => worker.workerName))
    if (names.size !== topology.workers.length)
      throw new Error("Worker inventory contains duplicates")
    for (const worker of topology.workers) {
      if (
        new Set(worker.databaseIds).size !== worker.databaseIds.length ||
        new Set(worker.secretNames).size !== worker.secretNames.length ||
        new Set(worker.serviceTargets).size !== worker.serviceTargets.length ||
        worker.databaseIds.includes(configuration.controlDatabaseId)
      )
        throw new Error("Application database inventory is invalid")
      if (worker.serviceTargets.some((target) => !names.has(target)))
        throw new Error("Service target is outside the guarded topology")
      await inventoryWorker(worker)
    }
    const databases = new Set(
      topology.workers.flatMap((worker) => worker.databaseIds)
    )
    if (databases.size < 1 || databases.size > 20)
      throw new Error("Recovery requires one to twenty application databases")
  }
  const preflightRestore = async (
    input: D1RecoveryManifest,
    releaseId: string
  ) => {
    const manifest = await readManifest(input.id)
    if (JSON.stringify(manifest) !== JSON.stringify(input))
      throw new Error("Saved manifest differs from request")
    await paused(releaseId)
    if (manifest.expiresAt <= now() || manifest.capturedAt > now())
      throw new Error("Recovery point expired")
    await secrets(manifest)
    const undo = await control(
      "SELECT id FROM sylph_recovery_manifest WHERE project_id = ? AND release_id = ? AND database_id = ? ORDER BY rowid DESC LIMIT 1",
      [configuration.projectId, releaseId, manifest.databaseId]
    )
    const undoPoint = await readManifest(
      Schema.decodeUnknownSync(Schema.String)(undo[0]?.id)
    )
    if (
      undoPoint.expiresAt <= now() ||
      undoPoint.capturedAt < now() - 15 * 60000
    )
      throw new Error("Fresh undo point required before restore")
    const prior = await control(
      "SELECT phase, evidence, manifest_id FROM sylph_recovery_operation WHERE release_id = ? UNION ALL SELECT phase, evidence, manifest_id FROM sylph_recovery_resource_operation WHERE release_id = ? AND resource_kind = 'd1' AND resource_id = ?",
      [releaseId, releaseId, manifest.databaseId]
    )
    if (prior.length !== 0)
      throw new Error("Restore already attempted; reconcile before retrying")
    await secrets(undoPoint)
    const current = await fingerprint(manifest.databaseId)
    if (
      current.fingerprint !== undoPoint.fingerprint ||
      current.schemaFingerprint !== undoPoint.schemaFingerprint
    )
      throw new Error("Fresh undo point must match current data")
    await bookmark(manifest.databaseId)
    return manifest
  }
  return CloudflareD1Recovery.of({
    gate: () =>
      wrap("Inspect writer gate", async () =>
        Schema.decodeUnknownSync(RecoveryGate)(
          (
            await control(
              "SELECT owner, active FROM sylph_recovery_gate WHERE id = 1"
            )
          )[0]
        )
      ),
    adoptPause: (previousReleaseId, releaseId) =>
      wrap("Adopt reconciled writer pause", async () => {
        await paused(previousReleaseId)
        await control(
          "UPDATE sylph_recovery_gate SET owner = ? WHERE id = 1 AND owner = ? AND active = 0",
          [releaseId, previousReleaseId]
        )
        await paused(releaseId)
      }),
    stageSecrets: (releaseId, values) =>
      wrap("Stage immutable deployed secret versions", async () => {
        const existing = await control(
          "SELECT release_id FROM sylph_recovery_secret_deployment WHERE release_id = ?",
          [releaseId]
        )
        if (existing.length !== 0) {
          const prior = await deploymentSecrets(releaseId)
          if (canonicalRow(prior) !== canonicalRow(values))
            throw new Error(
              "Cannot change an immutable deployed secret snapshot"
            )
          return
        }
        const snapshot = {
          id: releaseId,
          projectId: configuration.projectId,
          secrets: await encryptSecrets(releaseId, values),
        }
        const json = JSON.stringify(snapshot)
        await control(
          "INSERT INTO sylph_recovery_secret_deployment (release_id, project_id, json, sha256) VALUES (?, ?, ?, ?)",
          [releaseId, configuration.projectId, json, await sha256(json)]
        )
        if (
          canonicalRow(await deploymentSecrets(releaseId)) !==
          canonicalRow(values)
        )
          throw new Error("Secret snapshot readback mismatch")
      }),
    restoreProof: (schemaFingerprint) =>
      wrap("Require independently verified restore drill", () =>
        restoreProof(schemaFingerprint)
      ),
    pause: (releaseId) =>
      wrap("Pause writers", async () => {
        await control(
          "UPDATE sylph_recovery_gate SET owner = ? WHERE id = 1 AND (owner IS NULL OR owner = ?)",
          [releaseId, releaseId]
        )
        const deadline =
          Date.now() +
          Math.min(30000, Math.max(0, configuration.drainTimeoutMs ?? 30000))
        while (true) {
          const state = Schema.decodeUnknownSync(RecoveryGate)(
            (
              await control(
                "SELECT owner, active FROM sylph_recovery_gate WHERE id = 1"
              )
            )[0]
          )
          if (state.owner !== releaseId)
            throw new Error("Another release owns the pause")
          if (state.active === 0) return
          if (Date.now() >= deadline)
            throw new Error("Writers did not drain before the deadline")
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }),
    resume: (releaseId) =>
      wrap("Resume writers", async () => {
        const rows = await control(
          "SELECT owner, active FROM sylph_recovery_gate WHERE id = 1"
        )
        const state = Schema.decodeUnknownSync(RecoveryGate)(rows[0])
        if (state.owner === null) return
        const operations = await control(
          "SELECT phase FROM sylph_recovery_operation WHERE release_id = ? UNION ALL SELECT phase FROM sylph_recovery_resource_operation WHERE release_id = ? UNION ALL SELECT phase FROM sylph_recovery_group_operation WHERE release_id = ?",
          [releaseId, releaseId, releaseId]
        )
        if (operations.some((operation) => operation.phase !== "verified"))
          throw new Error(
            "Uncertain restore requires reconciliation before resume"
          )
        await paused(releaseId)
        await control(
          "UPDATE sylph_recovery_gate SET owner = NULL WHERE id = 1 AND owner = ? AND active = 0",
          [releaseId]
        )
        const after = Schema.decodeUnknownSync(RecoveryGate)(
          (
            await control(
              "SELECT owner, active FROM sylph_recovery_gate WHERE id = 1"
            )
          )[0]
        )
        if (after.owner !== null) throw new Error("Resume did not complete")
      }),
    inventory: (input) =>
      wrap("Validate storage inventory", () =>
        inventoryTopology({
          workers: [
            {
              workerName: input.workerName,
              databaseIds: [input.databaseId],
              secretNames: [...input.secretNames],
              serviceTargets: [],
            },
          ],
        })
      ),
    inventoryTopology: (input) =>
      wrap("Validate coordinated storage inventory", () =>
        inventoryTopology(input)
      ),
    capture: (input) =>
      wrap("Capture D1 recovery point", () => capture(input, true)),
    captureForDrill: (input) =>
      wrap("Capture isolated restore drill point", () => capture(input, false)),
    readManifest: (id) =>
      wrap("Read recovery manifest", () => readManifest(id)),
    secrets: (manifest) =>
      wrap("Read secret versions", async () =>
        secrets(await readManifest(manifest.id))
      ),
    fingerprint: (databaseId) =>
      wrap("Fingerprint D1", () => fingerprint(databaseId)),
    preflightRestore: (input, releaseId) =>
      wrap("Preflight D1 recovery point", async () => {
        await preflightRestore(input, releaseId)
      }),
    restore: (input, releaseId) =>
      wrap("Restore D1 recovery point", async () => {
        const manifest = await preflightRestore(input, releaseId)
        await control(
          "INSERT INTO sylph_recovery_resource_operation (release_id, resource_kind, resource_id, manifest_id, schema_fingerprint, phase) VALUES (?, 'd1', ?, ?, ?, 'restoring')",
          [
            releaseId,
            manifest.databaseId,
            manifest.id,
            manifest.schemaFingerprint,
          ]
        )
        try {
          const restored = Schema.decodeUnknownSync(RecoveryRestoreResponse)(
            await request(
              `/d1/database/${encodeURIComponent(manifest.databaseId)}/time_travel/restore?bookmark=${encodeURIComponent(manifest.bookmark)}`,
              "POST"
            )
          )
          if (!restored.success) throw new Error("Restore rejected")
          const actual = await fingerprint(manifest.databaseId)
          await paused(releaseId)
          if (
            actual.fingerprint !== manifest.fingerprint ||
            actual.schemaFingerprint !== manifest.schemaFingerprint
          )
            throw new Error("Restored schema or data differs from capture")
          const evidence = Schema.decodeUnknownSync(D1RestoreEvidence)({
            manifestId: manifest.id,
            schemaFingerprint: manifest.schemaFingerprint,
            databaseId: manifest.databaseId,
            previousBookmark: restored.result.previous_bookmark,
            restoredBookmark: restored.result.bookmark,
            fingerprint: actual.fingerprint,
            verifiedAt: now(),
          })
          await control(
            "UPDATE sylph_recovery_resource_operation SET phase = 'verified', evidence = ? WHERE release_id = ? AND resource_kind = 'd1' AND resource_id = ? AND phase = 'restoring'",
            [JSON.stringify(evidence), releaseId, manifest.databaseId]
          )
          return evidence
        } catch (error) {
          await control(
            "UPDATE sylph_recovery_resource_operation SET phase = 'uncertain' WHERE release_id = ? AND resource_kind = 'd1' AND resource_id = ? AND phase = 'restoring'",
            [releaseId, manifest.databaseId]
          )
          throw error
        }
      }),
  })
}

export const CloudflareD1RecoveryLive = (
  configuration: RecoveryConfiguration
) => Layer.sync(CloudflareD1Recovery, () => createRecovery(configuration))
