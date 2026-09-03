import { describe, expect, test } from "bun:test"

import {
  alchemyArguments,
  deployedUrl,
  planSylphDeployment,
  resolveBetterAuthSecret,
  resultLine,
} from "./sylph-deploy-plan"

describe("planSylphDeployment", () => {
  test("names a preview stage after the checkpoint", () => {
    const plan = planSylphDeployment({
      SYLPH_DEPLOYMENT: "preview",
      SYLPH_CHECKPOINT: "0123456789ABCDEF0123456789abcdef01234567",
    })
    expect(plan.stage).toBe("preview-0123456789ab")
    expect(plan.resultKey).toBe("SYLPH_PREVIEW_URL")
    expect(alchemyArguments("deploy", plan)).toEqual([
      "deploy",
      "--stage",
      "preview-0123456789ab",
      "--yes",
    ])
  })

  test("uses the production stage for production deployments", () => {
    const plan = planSylphDeployment({ SYLPH_DEPLOYMENT: "production" })
    expect(plan.stage).toBe("production")
    expect(plan.resultKey).toBe("SYLPH_PRODUCTION_URL")
  })

  test("rejects a preview without a checkpoint", () => {
    expect(() =>
      planSylphDeployment({ SYLPH_DEPLOYMENT: "preview", SYLPH_CHECKPOINT: "" })
    ).toThrow("SYLPH_CHECKPOINT")
  })

  test("rejects an unknown deployment", () => {
    expect(() => planSylphDeployment({ SYLPH_DEPLOYMENT: "staging" })).toThrow(
      "SYLPH_DEPLOYMENT"
    )
  })
})

describe("resolveBetterAuthSecret", () => {
  const preview = planSylphDeployment({
    SYLPH_DEPLOYMENT: "preview",
    SYLPH_CHECKPOINT: "abcdef0123456",
  })
  const production = planSylphDeployment({ SYLPH_DEPLOYMENT: "production" })
  const strong = "s".repeat(40)

  test("keeps a provided secret", () => {
    expect(resolveBetterAuthSecret(preview, strong, () => "generated")).toBe(
      strong
    )
  })

  test("generates a preview secret when none is provided", () => {
    expect(resolveBetterAuthSecret(preview, undefined, () => "generated")).toBe(
      "generated"
    )
  })

  test("requires a production secret", () => {
    expect(() =>
      resolveBetterAuthSecret(production, "short", () => "generated")
    ).toThrow("BETTER_AUTH_SECRET")
  })
})

describe("deployedUrl", () => {
  test("finds the Worker URL in Alchemy output", () => {
    const output = [
      "[Website] created",
      "Done: 2 succeeded",
      '{ url: "https://sylphtanstacktemplate-preview-0123456789ab-website-9b2c.example.workers.dev" }',
    ].join("\n")
    expect(deployedUrl(output)).toBe(
      "https://sylphtanstacktemplate-preview-0123456789ab-website-9b2c.example.workers.dev"
    )
  })

  test("returns null when no Worker URL is printed", () => {
    expect(deployedUrl("Done: 0 succeeded")).toBeNull()
  })
})

test("resultLine prints the Sylph marker", () => {
  const plan = planSylphDeployment({ SYLPH_DEPLOYMENT: "production" })
  expect(resultLine(plan, "https://app.example.workers.dev")).toBe(
    "SYLPH_PRODUCTION_URL=https://app.example.workers.dev"
  )
})
