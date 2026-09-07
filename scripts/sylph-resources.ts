import { Schema } from "effect"

const SecretValues = Schema.Record(Schema.String, Schema.String)

export const sylphResources = (environment: NodeJS.ProcessEnv) => {
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
  const plan: Array<{ kind: string; name: string }> = [
    { kind: "worker", name: `${prefix}-web` },
    { kind: "d1", name: `${prefix}-db` },
    { kind: "d1", name: `${prefix}-recovery` },
  ]
  if (hostname) plan.push({ kind: "domain", name: hostname })
  return {
    prefix,
    workerName: `${prefix}-web`,
    databaseName: `${prefix}-db`,
    controlDatabaseName: `${prefix}-recovery`,
    hostname,
    zoneId,
    plan,
  }
}

export const sylphSecrets = (value: string | undefined) => {
  const secrets = Schema.decodeUnknownSync(SecretValues)(
    JSON.parse(value ?? "{}")
  )
  for (const name of Object.keys(secrets)) {
    if (
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
