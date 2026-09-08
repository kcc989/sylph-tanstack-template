import { deriveObjectRecoveryToken } from "./sylph-object-token"
import { deployedUrl } from "./sylph-deploy-plan"
import { spawnSync } from "node:child_process"
import { Effect, Schema } from "effect"
import { CloudflareRecoveryGroup } from "../src/recovery/group"
import { verifyObjectRecoveryDrill } from "../src/recovery/object-drill"
import { verifyR2RecoveryDrill } from "../src/recovery/r2-drill"
import { verifyRecoveryDrill } from "../src/recovery/drill"
import { CloudflareD1Recovery } from "../src/recovery/recovery"
import { reviewMigrations, reviewRecoveryPlan } from "./sylph-release-review"
import { queueConsumerEnabled } from "./sylph-queue-consumers"
import {
  replayManagedQueues,
  requireEmptyQueueJournals,
} from "./sylph-queue-replay"
import { sylphResources } from "./sylph-resources"
import {
  recoveryConfiguration,
  requiredReleaseValue as required,
  recoveryGroupId,
  assertRecoveryGroup,
  managedRecoveryReceipts,
} from "./sylph-recovery-config"

import { RecoveryProbe, secretFingerprints } from "../src/recovery/verification"

const awaitProbe = async (url: string, names: string[] = []) => {
  const response = await fetch(new URL("/__sylph/release-verify", url), {
    headers: {
      Authorization: `Bearer ${required("SYLPH_RECOVERY_VERIFY_TOKEN")}`,
      "X-Sylph-Secret-Names": JSON.stringify(names),
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok)
    throw new Error("Authenticated production verification failed")
  return Schema.decodeUnknownSync(RecoveryProbe)(await response.json())
}

const action = process.argv[2]
const deploymentId = required("SYLPH_RELEASE_ID")
const projectId = required("SYLPH_PROJECT_ID")
const commit = required("SYLPH_CHECKPOINT")
const baseCommit = process.env.SYLPH_BASE_COMMIT || null
const identity = { deploymentId, projectId, commit, baseCommit }
const emit = (marker: string, value: unknown) =>
  process.stdout.write(`${marker}=${JSON.stringify(value)}\n`)

const main = async () => {
  let objectBootstrapURL: string | undefined
  if (action === "review") {
    reviewRecoveryPlan(
      required("SYLPH_RESOURCE_PLAN"),
      sylphResources(process.env)
    )
    let recoveryTargetCommit: string | undefined
    if (process.env.SYLPH_RECOVERY_POINT) {
      const target = Schema.decodeUnknownSync(
        Schema.Struct({
          commit: Schema.String,
          baseCommit: Schema.NullOr(Schema.String),
        })
      )(JSON.parse(process.env.SYLPH_RECOVERY_POINT))
      recoveryTargetCommit = target.baseCommit ?? target.commit
      if (recoveryTargetCommit !== commit)
        throw new Error(
          "Recovery target does not match selected immutable baseline"
        )
      const { point, id } = recoveryGroupId()
      const { layer, groupLayer } = await recoveryConfiguration(false)
      await Effect.runPromise(
        Effect.gen(function* () {
          const groups = yield* CloudflareRecoveryGroup
          assertRecoveryGroup(point, yield* groups.read(id))
        }).pipe(Effect.provide(groupLayer([])), Effect.provide(layer))
      )
    }
    let evidence = reviewMigrations(
      recoveryTargetCommit ? null : baseCommit,
      commit,
      baseCommit,
      recoveryTargetCommit
    )
    if (recoveryTargetCommit)
      evidence = `Selected recovery restores the matching data schema and secret versions before deployment. ${evidence}`
    emit("SYLPH_MIGRATION_REVIEW", { ...identity, compatible: true, evidence })
    return
  }
  if (action === "verify") {
    const url = required("SYLPH_PRODUCTION_URL")
    const result = await awaitProbe(url)
    if (result.checkpoint !== commit || result.releaseId !== deploymentId)
      throw new Error(
        "Production probe returned a different Checkpoint or release"
      )
    if (result.pausedBy && result.pausedBy !== deploymentId)
      throw new Error("A different release owns the writer pause")
    if (!result.pausedBy) {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
      const text = (await response.text()).replace(/<[^>]*>/g, "")
      if (
        !response.ok ||
        !text.includes(`SYLPH_CHECKPOINT=${commit}`) ||
        !text.includes("SYLPH_DEPLOYMENT=production")
      )
        throw new Error(
          "Resumed application route failed deployment identity verification"
        )
    }
    emit("SYLPH_PRODUCTION_JOURNEY", {
      deploymentId,
      commit,
      url,
      passed: true,
      journeys: [
        "Authenticated deployment identity and application database read",
      ],
    })
    return
  }
  required("CLOUDFLARE_ACCOUNT_ID")
  required("CLOUDFLARE_API_TOKEN")
  if (action === "prepare" || action === "restore")
    required("SYLPH_RECOVERY_KEY")
  if (action === "prepare" && !baseCommit) {
    const provider = new URL(
      process.env.SYLPH_CLOUDFLARE_API_BASE_URL ??
        "https://api.cloudflare.com/client/v4"
    )
    if (
      provider.protocol !== "https:" ||
      provider.username ||
      provider.password ||
      provider.search ||
      provider.hash
    )
      throw new Error(
        "Initial release requires a clean HTTPS provider endpoint"
      )
    const root = `${provider.href.replace(/\/$/, "")}/accounts/${encodeURIComponent(required("CLOUDFLARE_ACCOUNT_ID"))}`
    for (const worker of sylphResources(process.env).recoveryWorkers) {
      const response = await fetch(
        `${root}/workers/scripts/${encodeURIComponent(worker.workerName)}/settings`,
        {
          headers: {
            Authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }
      )
      if (response.status !== 404)
        throw new Error(
          "Initial recovery bootstrap requires every declared Worker to be absent"
        )
    }
    const bootstrap = spawnSync(
      "bun",
      ["x", "alchemy", "deploy", "--stage", "production"],
      {
        env: { ...process.env, SYLPH_BOOTSTRAP_RECOVERY: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      }
    )
    if (bootstrap.status !== 0)
      throw new Error("Initial recovery infrastructure provisioning failed")
    const managed = sylphResources(process.env)
    if (
      managed.durableObjects.length ||
      Object.keys(managed.kvBindings).length ||
      Object.keys(managed.queueBindings).length
    ) {
      const initial = await recoveryConfiguration(true, { skipObjects: true })
      const initialSecrets = {
        ...Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.String)
        )(JSON.parse(required("SYLPH_RECOVERY_SECRETS"))),
      }
      if (managed.durableObjects.length)
        initialSecrets.SYLPH_RECOVERY_OBJECT_TOKEN =
          await deriveObjectRecoveryToken(required("SYLPH_RECOVERY_KEY"))
      if (
        !initialSecrets.BETTER_AUTH_SECRET ||
        initialSecrets.BETTER_AUTH_SECRET.length < 32
      )
        throw new Error(
          "Initial managed publication requires the exact application auth secret"
        )
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* verifyRecoveryDrill(initial.configuration, {
            databaseId: initial.drillDatabaseId,
            applicationDatabaseId: initial.databaseId,
            expectedName: initial.resources.drillDatabaseName,
            releaseId: `drill-${deploymentId}`,
          })
          if (initial.resources.drillBucketName)
            yield* verifyR2RecoveryDrill(initial.r2Configuration, {
              bucketName: initial.resources.drillBucketName,
              applicationBucketNames: initial.resources.bucketNames,
              releaseId: `r2-drill-${deploymentId}`,
            })
          const recovery = yield* CloudflareD1Recovery
          yield* recovery.stageSecrets(deploymentId, initialSecrets)
          yield* recovery.pause(deploymentId)
        }).pipe(Effect.provide(initial.layer))
      )
      const publish = spawnSync(
        "bun",
        ["x", "alchemy", "deploy", "--stage", "production"],
        {
          env: {
            ...process.env,
            SYLPH_BOOTSTRAP_RECOVERY: "",
            BETTER_AUTH_SECRET: initialSecrets.BETTER_AUTH_SECRET,
            SYLPH_PROJECT_SECRETS: JSON.stringify(
              Object.fromEntries(
                Object.entries(initialSecrets).filter(
                  ([name]) =>
                    ![
                      "BETTER_AUTH_SECRET",
                      "SYLPH_RECOVERY_VERIFY_TOKEN",
                      "SYLPH_RECOVERY_OBJECT_TOKEN",
                    ].includes(name)
                )
              )
            ),
            SYLPH_RECOVERY_VERIFY_TOKEN: required(
              "SYLPH_RECOVERY_VERIFY_TOKEN"
            ),
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 300_000,
        }
      )
      if (publish.status !== 0)
        throw new Error(
          "Initial object Worker publication failed; keep the writer pause"
        )
      objectBootstrapURL = deployedUrl(publish.stdout.toString()) ?? undefined
      if (!objectBootstrapURL)
        throw new Error("Initial object Worker URL was not observed")
    }
  }
  const {
    databaseId,
    drillDatabaseId,
    resources,
    configuration,
    r2Configuration,
    managedQueues,
    objectConfiguration,
    groupLayer,
    layer,
  } = await recoveryConfiguration(
    action === "prepare" || action === "restore",
    { objectURL: objectBootstrapURL }
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const recovery = yield* CloudflareD1Recovery
      if (action === "prepare") {
        let liveReleaseId: string | undefined = objectBootstrapURL
          ? deploymentId
          : undefined
        if (baseCommit) {
          const baseline = awaitProbe(required("SYLPH_BASE_URL"))
          const live = yield* Effect.tryPromise(() => baseline)
          if (live.checkpoint !== baseCommit)
            throw new Error("Baseline deployment identity mismatch")
          liveReleaseId = live.releaseId
        }
        if (!baseCommit && !objectBootstrapURL) {
          yield* verifyRecoveryDrill(configuration, {
            databaseId: drillDatabaseId,
            applicationDatabaseId: databaseId,
            expectedName: resources.drillDatabaseName,
            releaseId: `drill-${deploymentId}`,
          })
          if (resources.drillBucketName)
            yield* verifyR2RecoveryDrill(r2Configuration, {
              bucketName: resources.drillBucketName,
              applicationBucketNames: resources.bucketNames,
              releaseId: `r2-drill-${deploymentId}`,
            })
          const initialFingerprint = yield* recovery.fingerprint(databaseId)
          yield* recovery.restoreProof(initialFingerprint.schemaFingerprint)
          const initialSecrets = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.String)
          )(JSON.parse(required("SYLPH_RECOVERY_SECRETS")))
          yield* recovery.stageSecrets(deploymentId, initialSecrets)
          liveReleaseId = deploymentId
        }
        const gate = yield* recovery.gate()
        if (
          process.env.SYLPH_RECOVERY_POINT &&
          gate.owner &&
          gate.owner !== deploymentId
        )
          yield* recovery.adoptPause(gate.owner, deploymentId)
        yield* recovery.pause(deploymentId)
        yield* Effect.promise(() =>
          requireEmptyQueueJournals(
            configuration,
            managedQueues.filter(
              (queue) => !queueConsumerEnabled(queue.bindingName)
            ),
            deploymentId
          )
        )
        if (objectBootstrapURL)
          for (const namespaceId of new Set(
            objectConfiguration.identities.map((item) => item.namespaceId)
          ))
            yield* verifyObjectRecoveryDrill(
              objectConfiguration,
              namespaceId,
              deploymentId
            )
        const manifest = yield* recovery.capture({
          databaseId,
          releaseId: deploymentId,
          liveReleaseId,
        })
        const secrets = yield* recovery.secrets(manifest)
        if (baseCommit) {
          const live = yield* Effect.tryPromise(() =>
            awaitProbe(required("SYLPH_BASE_URL"), Object.keys(secrets))
          )
          const expected = yield* Effect.tryPromise(() =>
            secretFingerprints(secrets, required("SYLPH_RECOVERY_VERIFY_TOKEN"))
          )
          if (
            JSON.stringify(live.secretFingerprints) !== JSON.stringify(expected)
          )
            throw new Error(
              "Live secrets differ from the immutable deployed snapshot"
            )
        }
        const group = yield* Effect.gen(function* () {
          const groups = yield* CloudflareRecoveryGroup
          return yield* (
            baseCommit || objectBootstrapURL
              ? groups.capture
              : groups.captureInitial
          )({
            releaseId: deploymentId,
            liveReleaseId,
          })
        }).pipe(
          Effect.provide(
            groupLayer([...Object.keys(secrets), "SYLPH_RECOVERY_VERIFY_TOKEN"])
          )
        )
        emit("SYLPH_RECOVERY_POINT", {
          ...identity,
          capturedAt: group.capturedAt,
          expiresAt: group.expiresAt,
          writesPaused: true,
          inventoryComplete: true,
          resources: [
            ...managedRecoveryReceipts(group),
            ...group.databases.map((database) => ({
              kind: "database",
              id: database.databaseId,
              backupRef: `group:${group.id}`,
              restoreVerifiedAt: database.restoreVerifiedAt,
            })),
            ...(group.buckets ?? []).map((bucket) => ({
              kind: "object-storage",
              id: bucket.bucketName,
              backupRef: `group:${group.id}`,
              restoreVerifiedAt: bucket.restoreVerifiedAt,
            })),
            ...manifest.secrets.map((secret) => ({
              kind: "secret",
              id: secret.name,
              backupRef: `group:${group.id}`,
              restoreVerifiedAt: manifest.restoreVerifiedAt,
            })),
          ],
        })
        return
      }
      if (action === "resume") {
        yield* Effect.promise(() =>
          requireEmptyQueueJournals(
            configuration,
            managedQueues.filter(
              (queue) => !queueConsumerEnabled(queue.bindingName)
            ),
            deploymentId
          )
        )
        yield* Effect.promise(() =>
          replayManagedQueues(
            configuration,
            managedQueues.filter((queue) =>
              queueConsumerEnabled(queue.bindingName)
            ),
            deploymentId
          )
        )
        yield* recovery.resume(deploymentId)
        return
      }
      if (action === "restore") {
        const { point, id } = recoveryGroupId()
        yield* Effect.gen(function* () {
          const groups = yield* CloudflareRecoveryGroup
          const group = yield* groups.read(id)
          assertRecoveryGroup(point, group)
          yield* groups.restore(id, deploymentId)
        }).pipe(Effect.provide(groupLayer([])))
        emit("SYLPH_DATA_RESTORED", {
          deploymentId,
          recoveryDeploymentId: point.deploymentId,
          commit,
          restored: true,
          resources: point.resources.map(
            (resource) => `${resource.kind}:${resource.id}`
          ),
        })
        return
      }
      throw new Error("Unknown release hook")
    }).pipe(Effect.provide(layer))
  )
}

main().catch(() => {
  process.stderr.write(
    "Release hook failed. Retain the writer pause and inspect the required release inputs and provider operation.\n"
  )
  process.exitCode = 1
})
