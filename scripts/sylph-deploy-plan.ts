export type SylphDeployment = "preview" | "production"

export type SylphDeployPlan = {
  readonly deployment: SylphDeployment
  readonly stage: string
  readonly resultKey: "SYLPH_PREVIEW_URL" | "SYLPH_PRODUCTION_URL"
}

export class SylphDeployPlanError extends Error {
  override readonly name = "SylphDeployPlanError"
}

const previewStagePrefix = "preview-"

export const planSylphDeployment = (environment: {
  readonly SYLPH_DEPLOYMENT?: string
  readonly SYLPH_CHECKPOINT?: string
}): SylphDeployPlan => {
  const deployment = environment.SYLPH_DEPLOYMENT
  const checkpoint = environment.SYLPH_CHECKPOINT?.trim() ?? ""

  if (deployment === "production") {
    return {
      deployment,
      stage: "production",
      resultKey: "SYLPH_PRODUCTION_URL",
    }
  }

  if (deployment === "preview") {
    if (!/^[0-9a-f]{7,40}$/i.test(checkpoint)) {
      throw new SylphDeployPlanError(
        "SYLPH_CHECKPOINT must be a commit hash for a preview deployment"
      )
    }
    return {
      deployment,
      stage: `${previewStagePrefix}${checkpoint.slice(0, 12).toLowerCase()}`,
      resultKey: "SYLPH_PREVIEW_URL",
    }
  }

  throw new SylphDeployPlanError(
    'SYLPH_DEPLOYMENT must be "preview" or "production"'
  )
}

export const resolveBetterAuthSecret = (
  plan: SylphDeployPlan,
  existing: string | undefined,
  generate: () => string
) => {
  const trimmed = existing?.trim() ?? ""
  if (trimmed.length >= 32) return trimmed
  if (plan.deployment === "production") {
    throw new SylphDeployPlanError(
      "BETTER_AUTH_SECRET with at least 32 characters is required for a production deployment"
    )
  }
  return generate()
}

export const deployedUrl = (output: string) => {
  const matches = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/gi)
  if (!matches) return null
  return matches[matches.length - 1]?.replace(/[),.;]+$/, "") ?? null
}

export const resultLine = (plan: SylphDeployPlan, url: string) =>
  `${plan.resultKey}=${url}`

export const alchemyArguments = (
  action: "deploy" | "destroy",
  plan: SylphDeployPlan
) => [action, "--stage", plan.stage, "--yes"]
