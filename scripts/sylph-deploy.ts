import { Effect, Schema } from "effect"
import { CloudflareD1Recovery } from "../src/recovery/recovery"
import {
  recoveryConfiguration,
  recoveryManifestId,
  requiredReleaseValue,
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
    const { layer } = await recoveryConfiguration()
    const secrets = await Effect.runPromise(
      Effect.gen(function* () {
        const recovery = yield* CloudflareD1Recovery
        const selected = process.env.SYLPH_RECOVERY_POINT
          ? yield* recovery.secrets(
              yield* recovery.readManifest(
                recoveryManifestId().database.backupRef
              )
            )
          : Schema.decodeUnknownSync(
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
