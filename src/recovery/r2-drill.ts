import { Effect, Schema } from "effect"
import { CloudflareRecoveryFailure } from "./domain"
import { R2RecoveryMutationResponse, R2RecoveryListResponse } from "./r2-domain"
import { CloudflareD1Recovery } from "./recovery"
import { CloudflareR2Recovery, type R2RecoveryConfiguration } from "./r2"

export const verifyR2RecoveryDrill = Effect.fn(
  "CloudflareRecovery.verifyR2Drill"
)(function* (
  configuration: R2RecoveryConfiguration,
  input: {
    bucketName: string
    applicationBucketNames: readonly string[]
    releaseId: string
  }
) {
  const failure = () =>
    new CloudflareRecoveryFailure({
      operation: "Verify isolated R2 restore drill",
      message:
        "R2 restore drill failed; retain its resources and writer pause for inspection.",
    })
  if (
    !/^sylph-[a-f0-9]{24}-recovery-drill$/.test(input.bucketName) ||
    input.applicationBucketNames.includes(input.bucketName) ||
    !configuration.bucketNames.includes(input.bucketName) ||
    new Set(input.applicationBucketNames).size !==
      input.applicationBucketNames.length ||
    JSON.stringify(
      [...input.applicationBucketNames, input.bucketName].sort()
    ) !== JSON.stringify([...configuration.bucketNames].sort())
  )
    return yield* failure()
  const gate = yield* CloudflareD1Recovery
  const recovery = yield* CloudflareR2Recovery
  yield* gate.pause(input.releaseId)
  const application = []
  for (const bucketName of input.applicationBucketNames)
    application.push({
      bucketName,
      fingerprint: (yield* recovery.fingerprint(bucketName)).fingerprint,
    })
  yield* recovery.fingerprint(input.bucketName)
  const key = `sylph-recovery-drill-${crypto.randomUUID()}`
  const root =
    configuration.apiBaseUrl ??
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(configuration.accountId)}`
  const write = Effect.fn("R2RecoveryDrill.write")(function* (
    name: string,
    value: string
  ) {
    const state = yield* gate.gate()
    if (state.owner !== input.releaseId || state.active !== 0)
      return yield* failure()
    yield* recovery.verifyConfiguration(input.bucketName)
    yield* Effect.tryPromise({
      try: async () => {
        const response = await (configuration.fetch ?? fetch)(
          `${root}/r2/buckets/${encodeURIComponent(input.bucketName)}/objects/${encodeURIComponent(name)}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${configuration.apiToken}`,
              "Content-Type": "text/plain",
              "Cache-Control": "no-store",
              "cf-r2-custom-metadata": JSON.stringify({ sylphDrill: value }),
              "cf-r2-http-metadata": JSON.stringify({
                contentType: "text/plain",
                cacheControl: "no-store",
              }),
              "cf-r2-storage-class": "Standard",
            },
            body: value,
            redirect: "error",
            signal: AbortSignal.timeout(60000),
          }
        )
        if (!response.ok) throw new Error("Drill object write failed")
        Schema.decodeUnknownSync(R2RecoveryMutationResponse)(
          await response.json()
        )
      },
      catch: failure,
    })
  })
  yield* write(key, "before")
  yield* Effect.tryPromise({
    try: async () => {
      const response = await (configuration.fetch ?? fetch)(
        `${root}/r2/buckets/${encodeURIComponent(input.bucketName)}/objects?prefix=${encodeURIComponent(key)}&per_page=1000`,
        {
          headers: { Authorization: `Bearer ${configuration.apiToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        }
      )
      if (!response.ok) throw new Error("Drill metadata read failed")
      const listed = Schema.decodeUnknownSync(R2RecoveryListResponse)(
        await response.json()
      )
      const object = listed.result.find((item) => item.key === key)
      if (
        listed.result_info.is_truncated ||
        !object ||
        object.custom_metadata?.sylphDrill !== "before" ||
        object.http_metadata?.contentType !== "text/plain" ||
        object.http_metadata?.cacheControl !== "no-store" ||
        object.storage_class !== "Standard" ||
        object.size !== 6
      )
        throw new Error("Provider did not preserve required drill metadata")
      const body = await (configuration.fetch ?? fetch)(
        `${root}/r2/buckets/${encodeURIComponent(input.bucketName)}/objects/${encodeURIComponent(key)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${configuration.apiToken}`,
            "Accept-Encoding": "identity",
          },
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        }
      )
      if (
        !body.ok ||
        body.headers.get("etag")?.replace(/^"|"$/g, "") !==
          object.etag.replace(/^"|"$/g, "") ||
        (await body.text()) !== "before"
      )
        throw new Error("Provider did not preserve required drill bytes")
    },
    catch: failure,
  })
  const target = yield* recovery.captureForDrill({
    bucketName: input.bucketName,
    releaseId: input.releaseId,
  })
  yield* write(key, "after")
  yield* write(`${key}-extra`, "extra")
  const undo = yield* recovery.captureForDrill({
    bucketName: input.bucketName,
    releaseId: input.releaseId,
  })
  if (
    undo.fingerprint === target.fingerprint ||
    undo.objectCount !== target.objectCount + 1
  )
    return yield* failure()
  const evidence = yield* recovery.restore(target, input.releaseId)
  const restored = yield* recovery.fingerprint(input.bucketName)
  if (restored.fingerprint !== target.fingerprint) return yield* failure()
  for (const point of application)
    if (
      (yield* recovery.fingerprint(point.bucketName)).fingerprint !==
      point.fingerprint
    )
      return yield* failure()
  yield* gate.resume(input.releaseId)
  return evidence
})
