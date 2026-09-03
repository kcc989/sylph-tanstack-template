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
  const plan = planSylphDeployment({
    SYLPH_DEPLOYMENT: process.env.SYLPH_DEPLOYMENT,
    SYLPH_CHECKPOINT: process.env.SYLPH_CHECKPOINT,
  })
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SYLPH_DEPLOYMENT: plan.deployment,
    BETTER_AUTH_SECRET: resolveBetterAuthSecret(
      plan,
      process.env.BETTER_AUTH_SECRET,
      () => `${crypto.randomUUID()}${crypto.randomUUID()}`
    ),
  }

  process.stdout.write(`Alchemy stage: ${plan.stage}\n`)
  const result = await runAlchemy(alchemyArguments(action, plan), environment)
  if (result.code !== 0) {
    process.exit(result.code)
  }
  if (action === "destroy") return

  const url = deployedUrl(result.output)
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
