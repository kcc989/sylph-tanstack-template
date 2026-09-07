import { Context, Effect, Layer, Schema } from "effect"
import {
  CloudflareRecoveryFailure,
  D1RecoveryManifest,
  D1RestoreEvidence,
  RecoveryBookmarkResponse,
  RecoveryGate,
  RecoveryQueryResponse,
  RecoveryRestoreResponse,
  RecoverySchemaRows,
  RecoverySecretValues,
  RecoverySecretSnapshot,
  RecoverySchedulesResponse,
  RecoverySettingsResponse,
  type RecoverySqlRow,
} from "./domain"

export interface RecoveryConfiguration {
  accountId: string
  apiToken: string
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
    captureForDrill: (input: CaptureInput) => RecoveryResult<D1RecoveryManifest>
    capture: (input: CaptureInput) => RecoveryResult<D1RecoveryManifest>
    readManifest: (id: string) => RecoveryResult<D1RecoveryManifest>
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
  const root = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`
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
      "SELECT evidence FROM sylph_recovery_operation WHERE schema_fingerprint = ? AND phase = 'verified' ORDER BY rowid DESC LIMIT 1",
      [schemaFingerprint]
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
          "SELECT phase FROM sylph_recovery_operation WHERE release_id = ?",
          [releaseId]
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
      wrap("Validate storage inventory", async () => {
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
            [input.databaseId, configuration.controlDatabaseId].sort()
          )
        )
          throw new Error("Database inventory mismatch")
        const declaredSecrets = [...input.secretNames].sort()
        const actualSecrets = response.result.bindings
          .filter((binding) => binding.type === "secret_text")
          .map((binding) => binding.name)
          .sort()
        if (JSON.stringify(declaredSecrets) !== JSON.stringify(actualSecrets))
          throw new Error("Secret inventory mismatch")
        const safeBindings = new Set([
          "d1",
          "secret_text",
          "plain_text",
          "json",
          "assets",
        ])
        if (
          response.result.bindings.some(
            (binding) => !safeBindings.has(binding.type)
          )
        )
          throw new Error("Unsupported stateful or external binding")
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
      }),
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
    restore: (input, releaseId) =>
      wrap("Restore D1 recovery point", async () => {
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
          "SELECT phase, evidence, manifest_id FROM sylph_recovery_operation WHERE release_id = ?",
          [releaseId]
        )
        if (prior.length !== 0)
          throw new Error(
            "Restore already attempted; reconcile before retrying"
          )
        await bookmark(manifest.databaseId)
        await control(
          "INSERT INTO sylph_recovery_operation (release_id, manifest_id, schema_fingerprint, phase) VALUES (?, ?, ?, 'restoring')",
          [releaseId, manifest.id, manifest.schemaFingerprint]
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
            "UPDATE sylph_recovery_operation SET phase = 'verified', evidence = ? WHERE release_id = ? AND phase = 'restoring'",
            [JSON.stringify(evidence), releaseId]
          )
          return evidence
        } catch (error) {
          await control(
            "UPDATE sylph_recovery_operation SET phase = 'uncertain' WHERE release_id = ? AND phase = 'restoring'",
            [releaseId]
          )
          throw error
        }
      }),
  })
}

export const CloudflareD1RecoveryLive = (
  configuration: RecoveryConfiguration
) => Layer.sync(CloudflareD1Recovery, () => createRecovery(configuration))
