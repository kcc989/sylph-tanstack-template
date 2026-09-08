import { Context, Effect, Layer, Schema } from "effect"
import {
  ManagedKvFailure,
  ManagedKvKey,
  ManagedKvMetadata,
  ManagedKvRecord,
} from "./managed-kv-domain"

type Metadata = typeof ManagedKvMetadata.Type

type KvValue = {
  value: Uint8Array
  metadata: Metadata
  expiration: number | null
}

type Put = {
  key: string
  value: Uint8Array
  metadata?: Metadata
  expiration?: number
}

export class ManagedKv extends Context.Service<
  ManagedKv,
  {
    get: (key: string) => Effect.Effect<KvValue | null, ManagedKvFailure>
    put: (input: Put) => Effect.Effect<void, ManagedKvFailure>
    delete: (key: string) => Effect.Effect<void, ManagedKvFailure>
    list: (after?: string) => Effect.Effect<readonly string[], ManagedKvFailure>
  }
>()("ManagedKv") {}

export const ManagedKvLive = (configuration: {
  database: D1Database
  cache: {
    get: (key: string) => Promise<string | null>
    put: (
      key: string,
      value: string,
      options: { expirationTtl: number }
    ) => Promise<void>
  }
  namespace: string
  now?: () => number
}) =>
  Layer.sync(ManagedKv, () => {
    const now = () => Math.floor((configuration.now?.() ?? Date.now()) / 1000)
    const key = (value: string) => Schema.decodeUnknownSync(ManagedKvKey)(value)
    const query = (sql: string) =>
      configuration.database.withSession("first-primary").prepare(sql)
    const attempt = <A>(action: () => Promise<A>) =>
      Effect.tryPromise({
        try: action,
        catch: () =>
          new ManagedKvFailure({ message: "Managed KV operation failed" }),
      })
    if (!configuration.namespace || configuration.namespace.length > 128)
      throw new Error("Managed KV namespace must contain 1 to 128 characters")
    const digest = async (value: string) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
        ),
        (byte) => byte.toString(16).padStart(2, "0")
      ).join("")
    const cacheKey = (version: string) => `sylph-managed-kv/${version}`
    const cacheWrite = async (version: string, value: string) => {
      try {
        await configuration.cache.put(cacheKey(version), value, {
          expirationTtl: 86400,
        })
      } catch {}
    }
    return {
      put: Effect.fn("ManagedKv.put")((input: Put) =>
        attempt(async () => {
          key(input.key)
          if (
            input.value.byteLength > 1024 * 1024 ||
            (input.expiration !== undefined &&
              (!Number.isSafeInteger(input.expiration) ||
                input.expiration <= now()))
          )
            throw new Error("Invalid value size or expiration")
          const metadata = JSON.stringify(
            Schema.decodeUnknownSync(ManagedKvMetadata)(input.metadata ?? null)
          )
          if (new TextEncoder().encode(metadata).byteLength > 1024)
            throw new Error("Metadata exceeds 1024 bytes")
          const value = btoa(
            Array.from(input.value, (byte) => String.fromCharCode(byte)).join(
              ""
            )
          )
          const version = crypto.randomUUID()
          await query(
            "INSERT INTO sylph_managed_kv (namespace, key, version, value, digest, metadata, expiration) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET version = excluded.version, value = excluded.value, digest = excluded.digest, metadata = excluded.metadata, expiration = excluded.expiration"
          )
            .bind(
              configuration.namespace,
              input.key,
              version,
              value,
              await digest(value),
              metadata,
              input.expiration ?? null
            )
            .run()
          await cacheWrite(version, value)
        })
      ),
      get: Effect.fn("ManagedKv.get")((input: string) =>
        attempt(async () => {
          for (let retry = 0; retry < 3; retry++) {
            const row = await query(
              "SELECT version, digest, metadata, expiration FROM sylph_managed_kv WHERE namespace = ? AND key = ? AND (expiration IS NULL OR expiration > ?)"
            )
              .bind(configuration.namespace, key(input), now())
              .first()
            if (!row) return null
            const record = Schema.decodeUnknownSync(ManagedKvRecord)(row)
            let value: string | null = null
            try {
              value = await configuration.cache.get(cacheKey(record.version))
            } catch {}
            if (value === null || (await digest(value)) !== record.digest) {
              value = await query(
                "SELECT value FROM sylph_managed_kv WHERE namespace = ? AND key = ? AND version = ?"
              )
                .bind(configuration.namespace, input, record.version)
                .first<string>("value")
              if (value === null) continue
              if ((await digest(value)) !== record.digest)
                throw new Error("Managed KV journal digest mismatch")
              await cacheWrite(record.version, value)
            }
            return {
              value: Uint8Array.from(atob(value), (character) =>
                character.charCodeAt(0)
              ),
              metadata: Schema.decodeUnknownSync(ManagedKvMetadata)(
                JSON.parse(record.metadata)
              ),
              expiration: record.expiration,
            }
          }
          throw new Error("Managed KV changed repeatedly during read")
        })
      ),
      delete: Effect.fn("ManagedKv.delete")((input: string) =>
        attempt(async () => {
          await query(
            "DELETE FROM sylph_managed_kv WHERE namespace = ? AND key = ?"
          )
            .bind(configuration.namespace, key(input))
            .run()
        })
      ),
      list: Effect.fn("ManagedKv.list")((after = "") =>
        attempt(async () => {
          const result = await query(
            "SELECT key FROM sylph_managed_kv WHERE namespace = ? AND key > ? AND (expiration IS NULL OR expiration > ?) ORDER BY key LIMIT 1000"
          )
            .bind(configuration.namespace, after, now())
            .all<{ key: string }>()
          return result.results.map((row) => row.key)
        })
      ),
    }
  })
