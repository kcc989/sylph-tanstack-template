import { Schema } from "effect"

const SecretValues = Schema.Record(Schema.String, Schema.String)

type RecoveryWorker = {
  workerName: string
  databaseNames: string[]
  serviceTargets: string[]
  bucketNames?: string[]
}

export const applicationBucketBindings: Readonly<Record<string, string>> = {}

export const sylphResources = (
  environment: NodeJS.ProcessEnv,
  declaredBuckets = applicationBucketBindings
) => {
  const prefix = environment.SYLPH_RESOURCE_PREFIX ?? ""
  if (!/^sylph-[a-f0-9]{24}$/.test(prefix))
    throw new Error(
      "SYLPH_RESOURCE_PREFIX must be provided by Sylph resource ownership checks"
    )
  const hostname = environment.SYLPH_CUSTOM_DOMAIN ?? ""
  const zoneId = environment.SYLPH_CUSTOM_DOMAIN_ZONE ?? ""
  if (hostname && (environment.SYLPH_DEPLOYMENT !== "production" || !zoneId))
    throw new Error(
      "Custom domains require a production deployment and a Cloudflare zone ID"
    )
  const entries = Object.entries(declaredBuckets)
  if (
    entries.length > 20 ||
    new Set(entries.map(([, suffix]) => suffix)).size !== entries.length ||
    entries.some(
      ([binding, suffix]) =>
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(binding) ||
        /^(SYLPH_|CLOUDFLARE_|CF_|ALCHEMY_|BETTER_AUTH_SECRET$|DB$|ASSETS$)/.test(
          binding
        ) ||
        !/^[a-z][a-z0-9-]{0,27}[a-z0-9]$/.test(suffix) ||
        ["web", "db", "recovery", "recovery-drill"].includes(suffix)
    )
  )
    throw new Error(
      "Application bucket declarations require unique reserved names and binding names"
    )
  const bucketBindings = Object.fromEntries(
    entries.map(([binding, suffix]) => [binding, `${prefix}-${suffix}`])
  )
  const bucketNames = Object.values(bucketBindings)
  const drillBucketName = bucketNames.length
    ? `${prefix}-recovery-drill`
    : undefined
  const workerBindings = Object.entries(bucketBindings).map(
    ([name, target]) => ({ type: "r2_bucket", name, target })
  )
  const plan: Array<{
    kind: string
    name: string
    purpose?: string
    bindings?: typeof workerBindings
  }> = [
    {
      kind: "worker",
      name: `${prefix}-web`,
      ...(workerBindings.length ? { bindings: workerBindings } : {}),
    },
    { kind: "d1", name: `${prefix}-db` },
    { kind: "d1", name: `${prefix}-recovery`, purpose: "recovery_control" },
    {
      kind: "d1",
      name: `${prefix}-recovery-drill`,
      purpose: "recovery_control",
    },
  ]
  plan.push(...bucketNames.map((name) => ({ kind: "r2", name })))
  if (drillBucketName)
    plan.push({
      kind: "r2",
      name: drillBucketName,
      purpose: "recovery_control",
    })
  if (hostname) plan.push({ kind: "domain", name: hostname })
  const recoveryWorkers: RecoveryWorker[] = [
    {
      workerName: `${prefix}-web`,
      databaseNames: [`${prefix}-db`],
      serviceTargets: [],
      ...(bucketNames.length ? { bucketNames } : {}),
    },
  ]
  return {
    prefix,
    workerName: `${prefix}-web`,
    databaseName: `${prefix}-db`,
    controlDatabaseName: `${prefix}-recovery`,
    drillDatabaseName: `${prefix}-recovery-drill`,
    recoveryWorkers,
    bucketBindings,
    bucketNames,
    drillBucketName,
    hostname,
    zoneId,
    plan,
  }
}

export const sylphSecrets = (
  value: string | undefined,
  declaredBuckets = applicationBucketBindings
) => {
  const secrets = Schema.decodeUnknownSync(SecretValues)(
    JSON.parse(value ?? "{}")
  )
  for (const name of Object.keys(secrets)) {
    if (
      Object.hasOwn(declaredBuckets, name) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
      /^(SYLPH_|CLOUDFLARE_|CF_|ALCHEMY_|BETTER_AUTH_SECRET$|DB$|ASSETS$|PATH$|HOME$|NODE_OPTIONS$|BUN_OPTIONS$)/.test(
        name
      )
    )
      throw new Error(
        "Application secret name conflicts with a reserved binding"
      )
  }
  return secrets
}

if (import.meta.main)
  process.stdout.write(
    `SYLPH_RESOURCE_PLAN=${JSON.stringify(sylphResources(process.env).plan)}\n`
  )
