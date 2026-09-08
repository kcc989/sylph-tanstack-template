import { Context, Effect, Layer, Schema } from "effect"
import {
  CloudflareRecoveryFailure,
  RecoveryGate,
  RecoveryQueryResponse,
} from "./domain"
import {
  R2RecoveryChunk,
  R2RecoveryLifecycleResponse,
  R2RecoveryLocksResponse,
  R2RecoverySippyResponse,
  R2RecoveryNotificationsResponse,
  R2RecoveryListResponse,
  R2RecoveryManifest,
  R2RecoveryMutationResponse,
  R2RecoverySnapshot,
  R2RestoreEvidence,
  type R2RecoveryObject,
} from "./r2-domain"
import { type RecoveryConfiguration } from "./recovery"

type Result<A> = Effect.Effect<A, CloudflareRecoveryFailure>
type Capture = { bucketName: string; releaseId: string }
type Fingerprint = {
  fingerprint: string
  objectCount: number
  totalBytes: number
}

export interface R2RecoveryConfiguration extends RecoveryConfiguration {
  bucketNames: readonly string[]
}

export class CloudflareR2Recovery extends Context.Service<
  CloudflareR2Recovery,
  {
    verifyConfiguration: (bucketName: string) => Result<void>
    capture: (input: Capture) => Result<R2RecoveryManifest>
    captureForDrill: (input: Capture) => Result<R2RecoveryManifest>
    readManifest: (id: string) => Result<R2RecoveryManifest>
    verifySnapshot: (manifest: R2RecoveryManifest) => Result<void>
    preflightRestore: (
      manifest: R2RecoveryManifest,
      releaseId: string
    ) => Result<void>
    fingerprint: (bucketName: string) => Result<Fingerprint>
    restoreProof: () => Result<R2RestoreEvidence>
    restore: (
      manifest: R2RecoveryManifest,
      releaseId: string
    ) => Result<R2RestoreEvidence>
  }
>()("@sylph/CloudflareR2Recovery") {}

const limits = {
  objects: 10000,
  objectBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  snapshotBytes: 96 * 1024 * 1024,
  chunkBytes: 32768,
}
const utf8 = new TextEncoder()
const digest = async (value: Uint8Array<ArrayBuffer>) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", value)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")
const base64 = (value: Uint8Array) => {
  const chunks: string[] = []
  for (let start = 0; start < value.length; start += 8192)
    chunks.push(String.fromCharCode(...value.subarray(start, start + 8192)))
  return btoa(chunks.join(""))
}
const unbase64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const sorted = <A>(value: Readonly<Record<string, A>>) =>
  Object.fromEntries(
    Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )
  )
const objectPath = (key: string) => {
  if (
    utf8.encode(key).length > 1024 ||
    key.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Unsupported R2 object key")
  return key.split("/").map(encodeURIComponent).join("/")
}
const fingerprint = async (
  snapshot: R2RecoverySnapshot
): Promise<Fingerprint> => ({
  fingerprint: await digest(utf8.encode(JSON.stringify(snapshot))),
  objectCount: snapshot.objects.length,
  totalBytes: snapshot.objects.reduce((sum, object) => sum + object.size, 0),
})

const headerJson = (value: Readonly<Record<string, string | undefined>>) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
const objectHeaders = (object: R2RecoveryObject) => {
  const headers = new Headers({
    "cf-r2-custom-metadata": headerJson(object.customMetadata),
    "cf-r2-http-metadata": headerJson(object.httpMetadata),
    "cf-r2-storage-class": object.storageClass,
  })
  const metadata = object.httpMetadata
  const fields = {
    "Content-Type": metadata.contentType,
    "Content-Language": metadata.contentLanguage,
    "Content-Disposition": metadata.contentDisposition,
    "Content-Encoding": metadata.contentEncoding,
    "Cache-Control": metadata.cacheControl,
    Expires:
      metadata.cacheExpiry === undefined
        ? undefined
        : new Date(metadata.cacheExpiry).toUTCString(),
  }
  for (const [name, value] of Object.entries(fields))
    if (value !== undefined) headers.set(name, value)
  return headers
}

const createRecovery = (
  configuration: R2RecoveryConfiguration
): CloudflareR2Recovery["Service"] => {
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
  const buckets = new Set(configuration.bucketNames)
  if (
    buckets.size !== configuration.bucketNames.length ||
    buckets.size > 21 ||
    [...buckets].some((name) => !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name))
  )
    throw new Error("Recovery bucket inventory is invalid")
  const attempt = <A>(operation: string, run: () => Promise<A>): Result<A> =>
    Effect.tryPromise({
      try: run,
      catch: () =>
        new CloudflareRecoveryFailure({
          operation,
          message: `${operation} failed; retain the writer pause and inspect the saved resource operation. Provider bodies and object contents are withheld.`,
        }),
    })
  const request = async (
    path: string,
    method = "GET",
    body?: BodyInit,
    headers?: HeadersInit
  ) => {
    const values = new Headers(headers)
    values.set("Authorization", `Bearer ${configuration.apiToken}`)
    const response = await fetcher(`${root}${path}`, {
      method,
      headers: values,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error("Cloudflare rejected recovery request")
    return response
  }
  const control = async (
    sql: string,
    params: readonly (string | number | null)[] = []
  ) => {
    const response = await request(
      `/d1/database/${encodeURIComponent(configuration.controlDatabaseId)}/query`,
      "POST",
      JSON.stringify({ sql, params }),
      { "Content-Type": "application/json" }
    )
    const value = Schema.decodeUnknownSync(RecoveryQueryResponse)(
      await response.json()
    )
    if (
      !value.success ||
      value.result.length !== 1 ||
      !value.result[0]?.success
    )
      throw new Error("Control query failed")
    return value.result[0].results
  }
  const paused = async (releaseId: string) => {
    const rows = await control(
      "SELECT owner, active FROM sylph_recovery_gate WHERE id = 1"
    )
    const gate = Schema.decodeUnknownSync(RecoveryGate)(rows[0])
    if (gate.owner !== releaseId || gate.active !== 0)
      throw new Error("Writers must be drained under the exact release")
  }
  const bucketPath = (bucketName: string) => {
    if (!buckets.has(bucketName))
      throw new Error("Bucket is outside the owned inventory")
    return `/r2/buckets/${encodeURIComponent(bucketName)}/objects`
  }
  const verifyConfiguration = async (bucketName: string) => {
    bucketPath(bucketName)
    const bucket = `/r2/buckets/${encodeURIComponent(bucketName)}`
    const [lifecycle, locks, sippy, notifications] = await Promise.all([
      request(`${bucket}/lifecycle`).then(async (response) =>
        Schema.decodeUnknownSync(R2RecoveryLifecycleResponse)(
          await response.json()
        )
      ),
      request(`${bucket}/lock`).then(async (response) =>
        Schema.decodeUnknownSync(R2RecoveryLocksResponse)(await response.json())
      ),
      request(`${bucket}/sippy`).then(async (response) =>
        Schema.decodeUnknownSync(R2RecoverySippyResponse)(await response.json())
      ),
      request(
        `/event_notifications/r2/${encodeURIComponent(bucketName)}/configuration`
      ).then(async (response) =>
        Schema.decodeUnknownSync(R2RecoveryNotificationsResponse)(
          await response.json()
        )
      ),
    ])
    if (
      lifecycle.result.rules.some(
        (rule) =>
          rule.enabled &&
          (rule.abortMultipartUploadsTransition?.condition === undefined ||
            rule.deleteObjectsTransition !== undefined ||
            (rule.storageClassTransitions?.length ?? 0) !== 0)
      ) ||
      locks.result.rules.some((rule) => rule.enabled) ||
      sippy.result.enabled ||
      notifications.result.bucketName !== bucketName ||
      notifications.result.queues.some((queue) => queue.rules.length !== 0)
    )
      throw new Error(
        "Bucket has uncontrolled lifecycle, lock, Sippy or notification behavior"
      )
  }
  const list = async (bucketName: string) => {
    const objects: Array<(typeof R2RecoveryListResponse.Type.result)[number]> =
      []
    const cursors = new Set<string>()
    const keys = new Set<string>()
    let cursor: string | undefined
    let totalBytes = 0
    while (true) {
      const query = new URLSearchParams({ per_page: "1000" })
      if (cursor) query.set("cursor", cursor)
      const response = await request(`${bucketPath(bucketName)}?${query}`)
      const page = Schema.decodeUnknownSync(R2RecoveryListResponse)(
        await response.json()
      )
      for (const object of page.result) {
        objectPath(object.key)
        totalBytes += object.size
        if (
          object.ssec ||
          keys.has(object.key) ||
          object.size > limits.objectBytes ||
          totalBytes > limits.totalBytes ||
          objects.length >= limits.objects
        )
          throw new Error("Bucket exceeds the complete snapshot contract")
        keys.add(object.key)
        objects.push(object)
      }
      if (!page.result_info.is_truncated) break
      cursor = page.result_info.cursor
      if (!cursor || cursors.has(cursor) || page.result.length === 0)
        throw new Error("Listing does not prove pagination progress")
      cursors.add(cursor)
    }
    return objects.sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0
    )
  }
  const body = async (response: Response, expected: number) => {
    if (!response.body) {
      if (expected !== 0) throw new Error("Object body is absent")
      return new Uint8Array(0)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const value = await reader.read()
        if (value.done) break
        length += value.value.length
        if (length > expected || length > limits.objectBytes)
          throw new Error("Object body exceeds declared size")
        chunks.push(value.value)
      }
    } finally {
      await reader.cancel()
    }
    if (length !== expected) throw new Error("Object bytes differ from listing")
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  }
  const snapshot = async (bucketName: string): Promise<R2RecoverySnapshot> => {
    await verifyConfiguration(bucketName)
    const before = await list(bucketName)
    const objects: R2RecoveryObject[] = []
    for (const item of before) {
      const response = await request(
        `${bucketPath(bucketName)}/${objectPath(item.key)}`,
        "GET",
        undefined,
        { "Accept-Encoding": "identity" }
      )
      const etag = response.headers.get("etag")?.replace(/^"|"$/g, "")
      if (etag !== item.etag.replace(/^"|"$/g, ""))
        throw new Error("Object version changed during snapshot")
      const bytes = await body(response, item.size)
      if (!item.http_metadata || !item.custom_metadata)
        throw new Error("Complete object metadata is required")
      const metadata = { ...item.http_metadata }
      if (metadata.cacheExpiry !== undefined)
        metadata.cacheExpiry = new Date(metadata.cacheExpiry).toISOString()
      objects.push({
        key: item.key,
        size: bytes.length,
        bytes: base64(bytes),
        httpMetadata: sorted(metadata),
        customMetadata: sorted(item.custom_metadata),
        storageClass: item.storage_class ?? "Standard",
      })
    }
    if (JSON.stringify(before) !== JSON.stringify(await list(bucketName)))
      throw new Error("Bucket changed during capture")
    const value = Schema.decodeUnknownSync(R2RecoverySnapshot)({
      version: 1,
      objects,
    })
    for (const object of value.objects) objectHeaders(object)
    if (utf8.encode(JSON.stringify(value)).length > limits.snapshotBytes)
      throw new Error("Encoded snapshot exceeds the recovery bound")
    return value
  }
  const cryptoKey = async () => {
    const bytes = unbase64(configuration.encryptionKey)
    if (bytes.length !== 32)
      throw new Error("Recovery key must contain 32 bytes")
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ])
  }
  const aad = (id: string, ordinal: number) =>
    utf8.encode(
      JSON.stringify(["r2-snapshot-v1", configuration.projectId, id, ordinal])
    )
  const readManifest = async (id: string) => {
    const rows = await control(
      "SELECT json, sha256 FROM sylph_recovery_r2_manifest WHERE id = ? AND project_id = ?",
      [id, configuration.projectId]
    )
    const json = Schema.decodeUnknownSync(Schema.String)(rows[0]?.json)
    if ((await digest(utf8.encode(json))) !== rows[0]?.sha256)
      throw new Error("Manifest integrity mismatch")
    const manifest = Schema.decodeUnknownSync(R2RecoveryManifest)(
      JSON.parse(json)
    )
    bucketPath(manifest.bucketName)
    if (
      manifest.id !== id ||
      manifest.projectId !== configuration.projectId ||
      manifest.expiresAt <= now() ||
      manifest.capturedAt > now() ||
      manifest.chunkCount >
        Math.ceil(limits.snapshotBytes / limits.chunkBytes) ||
      manifest.totalBytes > limits.totalBytes
    )
      throw new Error("Manifest identity, time or size is invalid")
    return manifest
  }
  const loadSnapshot = async (manifest: R2RecoveryManifest) => {
    const key = await cryptoKey()
    const parts: Uint8Array<ArrayBuffer>[] = []
    let length = 0
    for (let ordinal = 0; ordinal < manifest.chunkCount; ordinal++) {
      const rows = await control(
        "SELECT ordinal, iv, ciphertext FROM sylph_recovery_r2_chunk WHERE manifest_id = ? AND ordinal = ?",
        [manifest.id, ordinal]
      )
      if (rows.length !== 1) throw new Error("Snapshot chunk is absent")
      const chunk = Schema.decodeUnknownSync(R2RecoveryChunk)(rows[0])
      if (
        chunk.ordinal !== ordinal ||
        chunk.ciphertext.length > Math.ceil((limits.chunkBytes + 16) / 3) * 4
      )
        throw new Error("Snapshot chunk is invalid")
      const bytes = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: unbase64(chunk.iv),
            additionalData: aad(manifest.id, ordinal),
          },
          key,
          unbase64(chunk.ciphertext)
        )
      )
      length += bytes.length
      if (
        bytes.length > limits.chunkBytes ||
        length > limits.snapshotBytes ||
        (ordinal < manifest.chunkCount - 1 &&
          bytes.length !== limits.chunkBytes)
      )
        throw new Error("Snapshot chunk size is invalid")
      parts.push(bytes)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    const value = Schema.decodeUnknownSync(R2RecoverySnapshot)(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    )
    const actual = await fingerprint(value)
    if (
      actual.fingerprint !== manifest.fingerprint ||
      actual.objectCount !== manifest.objectCount ||
      actual.totalBytes !== manifest.totalBytes
    )
      throw new Error("Snapshot fingerprint differs")
    for (const object of value.objects) {
      objectHeaders(object)
      objectPath(object.key)
      if (
        object.size > limits.objectBytes ||
        unbase64(object.bytes).length !== object.size
      )
        throw new Error("Snapshot object size differs")
    }
    return value
  }
  const restoreProof = async () => {
    const rows = await control(
      "SELECT evidence FROM sylph_recovery_resource_operation WHERE resource_kind = 'r2' AND schema_fingerprint = 'r2-snapshot-v1' AND phase = 'verified' ORDER BY json_extract(evidence, '$.verifiedAt') DESC LIMIT 1"
    )
    const evidence = rows
      .map((row) =>
        Schema.decodeUnknownSync(R2RestoreEvidence)(
          JSON.parse(Schema.decodeUnknownSync(Schema.String)(row.evidence))
        )
      )
      .filter(
        (value) =>
          value.verifiedAt <= now() && value.verifiedAt > now() - 30 * 86400000
      )
      .sort((left, right) => right.verifiedAt - left.verifiedAt)[0]
    if (!evidence)
      throw new Error("A recent verified R2 restore drill is required")
    const manifest = await readManifest(evidence.manifestId)
    await loadSnapshot(manifest)
    if (
      manifest.objectCount === 0 ||
      manifest.bucketName !== evidence.bucketName ||
      manifest.fingerprint !== evidence.fingerprint
    )
      throw new Error("Restore proof does not identify a saved snapshot")
    return evidence
  }
  const capture = async (input: Capture, requireProof: boolean) => {
    await paused(input.releaseId)
    const proof = requireProof ? await restoreProof() : undefined
    const value = await snapshot(input.bucketName)
    const bytes = utf8.encode(JSON.stringify(value))
    const id = crypto.randomUUID()
    const key = await cryptoKey()
    const count = Math.ceil(bytes.length / limits.chunkBytes)
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(id, ordinal) },
        key,
        bytes.slice(
          ordinal * limits.chunkBytes,
          (ordinal + 1) * limits.chunkBytes
        )
      )
      await control(
        "INSERT INTO sylph_recovery_r2_chunk (manifest_id, ordinal, iv, ciphertext) VALUES (?, ?, ?, ?)",
        [id, ordinal, base64(iv), base64(new Uint8Array(encrypted))]
      )
    }
    const identity = await fingerprint(value)
    if (
      (await fingerprint(await snapshot(input.bucketName))).fingerprint !==
      identity.fingerprint
    )
      throw new Error("Bucket changed before snapshot publication")
    await paused(input.releaseId)
    const manifest = Schema.decodeUnknownSync(R2RecoveryManifest)({
      version: 1,
      id,
      projectId: configuration.projectId,
      releaseId: input.releaseId,
      bucketName: input.bucketName,
      capturedAt: now(),
      expiresAt: now() + 30 * 86400000,
      restoreVerifiedAt: proof?.verifiedAt ?? 0,
      ...identity,
      chunkCount: count,
    })
    const json = JSON.stringify(manifest)
    await control(
      "INSERT INTO sylph_recovery_r2_manifest (id, project_id, release_id, bucket_name, json, sha256) VALUES (?, ?, ?, ?, ?, ?)",
      [
        id,
        configuration.projectId,
        input.releaseId,
        input.bucketName,
        json,
        await digest(utf8.encode(json)),
      ]
    )
    await loadSnapshot(await readManifest(id))
    return manifest
  }
  const put = async (bucketName: string, object: R2RecoveryObject) => {
    await verifyConfiguration(bucketName)
    const headers = objectHeaders(object)
    const response = await request(
      `${bucketPath(bucketName)}/${objectPath(object.key)}`,
      "PUT",
      unbase64(object.bytes),
      headers
    )
    Schema.decodeUnknownSync(R2RecoveryMutationResponse)(await response.json())
  }
  const preflightRestore = async (
    input: R2RecoveryManifest,
    releaseId: string
  ) => {
    await paused(releaseId)
    await verifyConfiguration(input.bucketName)
    const manifest = await readManifest(input.id)
    if (JSON.stringify(manifest) !== JSON.stringify(input))
      throw new Error("Immutable manifest differs")
    const target = await loadSnapshot(manifest)
    const rows = await control(
      "SELECT id FROM sylph_recovery_r2_manifest WHERE project_id = ? AND release_id = ? AND bucket_name = ? ORDER BY rowid DESC LIMIT 1",
      [configuration.projectId, releaseId, manifest.bucketName]
    )
    const undo = await readManifest(
      Schema.decodeUnknownSync(Schema.String)(rows[0]?.id)
    )
    await loadSnapshot(undo)
    if (
      undo.capturedAt < now() - 15 * 60000 ||
      undo.releaseId !== releaseId ||
      undo.bucketName !== manifest.bucketName
    )
      throw new Error("A fresh complete undo snapshot is required")
    const current = await snapshot(manifest.bucketName)
    if ((await fingerprint(current)).fingerprint !== undo.fingerprint)
      throw new Error("Current bucket differs from undo snapshot")
    await paused(releaseId)
    const prior = await control(
      "SELECT phase FROM sylph_recovery_resource_operation WHERE release_id = ? AND resource_kind = 'r2' AND resource_id = ?",
      [releaseId, manifest.bucketName]
    )
    if (prior.length !== 0)
      throw new Error("R2 restore requires a new recovery operation")
    return { manifest, target, current }
  }
  const restore = async (input: R2RecoveryManifest, releaseId: string) => {
    const { manifest, target, current } = await preflightRestore(
      input,
      releaseId
    )
    await control(
      "INSERT INTO sylph_recovery_resource_operation (release_id, resource_kind, resource_id, manifest_id, schema_fingerprint, phase, evidence) VALUES (?, 'r2', ?, ?, 'r2-snapshot-v1', 'restoring', NULL)",
      [releaseId, manifest.bucketName, manifest.id]
    )
    try {
      for (const object of target.objects) {
        await paused(releaseId)
        await put(manifest.bucketName, object)
      }
      const keys = new Set(target.objects.map((object) => object.key))
      for (const object of current.objects) {
        if (keys.has(object.key)) continue
        await paused(releaseId)
        await verifyConfiguration(manifest.bucketName)
        const response = await request(
          `${bucketPath(manifest.bucketName)}/${objectPath(object.key)}`,
          "DELETE"
        )
        Schema.decodeUnknownSync(R2RecoveryMutationResponse)(
          await response.json()
        )
      }
      const actual = await fingerprint(await snapshot(manifest.bucketName))
      if (
        actual.fingerprint !== manifest.fingerprint ||
        actual.objectCount !== manifest.objectCount ||
        actual.totalBytes !== manifest.totalBytes
      )
        throw new Error("Restored bytes or metadata differ")
      await paused(releaseId)
      const evidence = Schema.decodeUnknownSync(R2RestoreEvidence)({
        manifestId: manifest.id,
        bucketName: manifest.bucketName,
        schemaFingerprint: "r2-snapshot-v1",
        ...actual,
        verifiedAt: now(),
      })
      await control(
        "UPDATE sylph_recovery_resource_operation SET phase = 'verified', evidence = ? WHERE release_id = ? AND resource_kind = 'r2' AND resource_id = ? AND phase = 'restoring'",
        [JSON.stringify(evidence), releaseId, manifest.bucketName]
      )
      const saved = await control(
        "SELECT phase, evidence FROM sylph_recovery_resource_operation WHERE release_id = ? AND resource_kind = 'r2' AND resource_id = ?",
        [releaseId, manifest.bucketName]
      )
      if (
        saved[0]?.phase !== "verified" ||
        saved[0]?.evidence !== JSON.stringify(evidence)
      )
        throw new Error("Restore evidence was not persisted")
      return evidence
    } catch (error) {
      await control(
        "UPDATE sylph_recovery_resource_operation SET phase = 'uncertain' WHERE release_id = ? AND resource_kind = 'r2' AND resource_id = ?",
        [releaseId, manifest.bucketName]
      )
      throw error
    }
  }
  return CloudflareR2Recovery.of({
    verifyConfiguration: (bucketName) =>
      attempt("Inspect R2 mutation configuration", () =>
        verifyConfiguration(bucketName)
      ),
    capture: (input) =>
      attempt("Capture complete R2 recovery point", () => capture(input, true)),
    captureForDrill: (input) =>
      attempt("Capture R2 restore drill point", () => capture(input, false)),
    readManifest: (id) =>
      attempt("Read immutable R2 manifest", () => readManifest(id)),
    verifySnapshot: (input) =>
      attempt("Authenticate complete R2 snapshot", async () => {
        const manifest = await readManifest(input.id)
        if (JSON.stringify(manifest) !== JSON.stringify(input))
          throw new Error("Immutable manifest differs")
        await loadSnapshot(manifest)
      }),
    preflightRestore: (manifest, releaseId) =>
      attempt("Preflight R2 restore and undo", async () => {
        await preflightRestore(manifest, releaseId)
      }),
    fingerprint: (bucketName) =>
      attempt("Fingerprint complete R2 bucket", async () =>
        fingerprint(await snapshot(bucketName))
      ),
    restoreProof: () =>
      attempt("Require verified R2 restore drill", restoreProof),
    restore: (manifest, releaseId) =>
      attempt("Restore complete R2 snapshot", () =>
        restore(manifest, releaseId)
      ),
  })
}

export const CloudflareR2RecoveryLive = (
  configuration: R2RecoveryConfiguration
) => Layer.sync(CloudflareR2Recovery, () => createRecovery(configuration))
