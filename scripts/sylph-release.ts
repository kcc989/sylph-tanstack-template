import { spawnSync } from "node:child_process"
import { Effect, Schema } from "effect"
import { CloudflareD1Recovery } from "../src/recovery/recovery"
import { reviewMigrations } from "./sylph-release-review"
import {
  recoveryConfiguration,
  recoveryManifestId,
  requiredReleaseValue as required,
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
  if (action === "review") {
    let evidence = reviewMigrations(
      process.env.SYLPH_RECOVERY_POINT ? null : baseCommit,
      commit
    )
    if (process.env.SYLPH_RECOVERY_POINT) {
      const target = Schema.decodeUnknownSync(
        Schema.Struct({
          commit: Schema.String,
          baseCommit: Schema.NullOr(Schema.String),
        })
      )(JSON.parse(process.env.SYLPH_RECOVERY_POINT))
      if ((target.baseCommit ?? target.commit) !== commit)
        throw new Error(
          "Recovery target does not match selected immutable baseline"
        )
      evidence = `Selected recovery restores the matching data schema and secret versions before deployment. ${evidence}`
    }
    emit("SYLPH_MIGRATION_REVIEW", { ...identity, compatible: true, evidence })
    return
  }
  required("CLOUDFLARE_ACCOUNT_ID")
  required("CLOUDFLARE_API_TOKEN")
  if (action === "prepare" || action === "restore")
    required("SYLPH_RECOVERY_KEY")
  if (action === "prepare" && !baseCommit) {
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
  }
  const { databaseId, resources, layer } = await recoveryConfiguration(
    action === "prepare" || action === "restore"
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const recovery = yield* CloudflareD1Recovery
      if (action === "prepare") {
        let liveReleaseId: string | undefined
        if (baseCommit) {
          const baseline = awaitProbe(required("SYLPH_BASE_URL"))
          const live = yield* Effect.tryPromise(() => baseline)
          if (live.checkpoint !== baseCommit)
            throw new Error("Baseline deployment identity mismatch")
          liveReleaseId = live.releaseId
        }
        if (!baseCommit) {
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
        const manifest = yield* recovery.capture({
          databaseId,
          releaseId: deploymentId,
          liveReleaseId,
        })
        const secrets = yield* recovery.secrets(manifest)
        if (baseCommit) {
          yield* recovery.inventory({
            workerName: resources.workerName,
            databaseId,
            secretNames: [
              ...Object.keys(secrets),
              "SYLPH_RECOVERY_VERIFY_TOKEN",
            ],
          })
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
        emit("SYLPH_RECOVERY_POINT", {
          ...identity,
          capturedAt: manifest.capturedAt,
          expiresAt: manifest.expiresAt,
          writesPaused: true,
          inventoryComplete: true,
          resources: [
            {
              kind: "database",
              id: databaseId,
              backupRef: manifest.id,
              restoreVerifiedAt: manifest.restoreVerifiedAt,
            },
            ...manifest.secrets.map((secret) => ({
              kind: "secret",
              id: secret.name,
              backupRef: manifest.id,
              restoreVerifiedAt: manifest.restoreVerifiedAt,
            })),
          ],
        })
        return
      }
      if (action === "resume") {
        yield* recovery.resume(deploymentId)
        return
      }
      if (action === "restore") {
        const { point, database } = recoveryManifestId()
        if (database.id !== databaseId)
          throw new Error("Recovery database identity mismatch")
        const manifest = yield* recovery.readManifest(database.backupRef)
        yield* recovery.restore(manifest, deploymentId)
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
      if (action === "verify") {
        const url = required("SYLPH_PRODUCTION_URL")
        const result = yield* Effect.tryPromise(() => awaitProbe(url))
        if (result.checkpoint !== commit || result.releaseId !== deploymentId)
          throw new Error(
            "Production probe returned a different Checkpoint or release"
          )
        if (result.pausedBy && result.pausedBy !== deploymentId)
          throw new Error("A different release owns the writer pause")
        if (!result.pausedBy) {
          const response = yield* Effect.tryPromise(() =>
            fetch(url, {
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
            })
          )
          const html = yield* Effect.tryPromise(() => response.text())
          const text = html.replace(/<[^>]*>/g, "")
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
