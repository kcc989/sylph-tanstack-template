import { Effect, Schema } from "effect"
import { CloudflareRecoveryGroup } from "../src/recovery/group"
import { CloudflareD1Recovery } from "../src/recovery/recovery"
import {
  recoveryConfiguration,
  recoveryGroupId,
  requiredReleaseValue,
  assertRecoveryGroup,
} from "./sylph-recovery-config"
import { sylphResources } from "./sylph-resources"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import {
  alchemyArguments,
  deployedUrl,
  planSylphDeployment,
  resolveBetterAuthSecret,
  resultLine,
  SylphDeployPlanError,
} from "./sylph-deploy-plan"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const alchemyBinary = resolve(projectRoot, "node_modules/.bin/alchemy")

const readAction = (argument: string | undefined) => {
  if (argument === "deploy" || argument === "destroy") return argument
  throw new SylphDeployPlanError("Usage: sylph-deploy.ts <deploy|destroy>")
}

const runAlchemy = (
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv
) =>
  new Promise<{ code: number; output: string }>((resolvePromise, reject) => {
    const child = spawn(alchemyBinary, args, {
      cwd: projectRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const capture = (chunk: Buffer, stream: NodeJS.WriteStream) => {
      const text = chunk.toString()
      output += text
      stream.write(text)
    }
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, process.stdout))
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, process.stderr))
    child.on("error", reject)
    child.on("close", (code) => resolvePromise({ code: code ?? 1, output }))
  })

const main = async () => {
  const action = readAction(process.argv[2])
  const resources = sylphResources(process.env)
  if (process.env.SYLPH_RESOURCE_PLAN !== JSON.stringify(resources.plan))
    throw new Error(
      "Deployment resource plan does not match Sylph's reservation"
    )
  const basePlan = planSylphDeployment({
    SYLPH_DEPLOYMENT: process.env.SYLPH_DEPLOYMENT,
    SYLPH_CHECKPOINT: process.env.SYLPH_CHECKPOINT,
  })
  const plan = {
    ...basePlan,
    stage:
      basePlan.deployment === "preview" ? resources.prefix : basePlan.stage,
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SYLPH_DEPLOYMENT: plan.deployment,
    BETTER_AUTH_SECRET: resolveBetterAuthSecret(
      plan,
      process.env.BETTER_AUTH_SECRET,
      () => `${crypto.randomUUID()}${crypto.randomUUID()}`
    ),
  }

  if (action === "deploy" && plan.deployment === "production") {
    const { layer, groupLayer } = await recoveryConfiguration()
    const secrets = await Effect.runPromise(
      Effect.gen(function* () {
        const recovery = yield* CloudflareD1Recovery
        let selected: Record<string, string>
        if (process.env.SYLPH_RECOVERY_POINT) {
          const { point, id } = recoveryGroupId()
          selected = yield* Effect.gen(function* () {
            const groups = yield* CloudflareRecoveryGroup
            const group = yield* groups.read(id)
            assertRecoveryGroup(point, group)
            const first = group.databases[0]
            if (!first) throw new Error("Recovery group has no database")
            const values = yield* recovery.secrets(first)
            for (const database of group.databases) {
              if (
                JSON.stringify(yield* recovery.secrets(database)) !==
                JSON.stringify(values)
              )
                throw new Error("Recovery group secret snapshots differ")
            }
            return values
          }).pipe(Effect.provide(groupLayer([])))
        } else
          selected = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.String)
          )(JSON.parse(requiredReleaseValue("SYLPH_RECOVERY_SECRETS")))
        yield* recovery.stageSecrets(
          requiredReleaseValue("SYLPH_RELEASE_ID"),
          selected
        )
        return selected
      }).pipe(Effect.provide(layer))
    )
    environment.BETTER_AUTH_SECRET = secrets.BETTER_AUTH_SECRET
    environment.SYLPH_PROJECT_SECRETS = JSON.stringify(
      Object.fromEntries(
        Object.entries(secrets).filter(
          ([name]) =>
            name !== "BETTER_AUTH_SECRET" &&
            name !== "SYLPH_RECOVERY_VERIFY_TOKEN"
        )
      )
    )
  }

  process.stdout.write(`Alchemy stage: ${plan.stage}\n`)
  const result = await runAlchemy(alchemyArguments(action, plan), environment)
  if (result.code !== 0) {
    process.exit(result.code)
  }
  if (action === "destroy") return

  const url = resources.hostname
    ? `https://${resources.hostname}`
    : deployedUrl(result.output)
  if (!url) {
    process.stderr.write(
      "Alchemy finished without printing a workers.dev URL, so the deployment cannot be reported to Sylph\n"
    )
    process.exit(65)
  }
  process.stdout.write(`${resultLine(plan, url)}\n`)
}

main().catch((cause: unknown) => {
  const message =
    cause instanceof Error ? cause.message : "Sylph deployment failed"
  process.stderr.write(`${message}\n`)
  process.exit(cause instanceof SylphDeployPlanError ? 64 : 1)
})
