import { expect, test } from "bun:test"
import { sylphResources, sylphSecrets } from "./sylph-resources"

test("resource plan pins isolated Worker and D1 names", () => {
  const resources = sylphResources({
    SYLPH_RESOURCE_PREFIX: `sylph-${"a".repeat(24)}`,
    SYLPH_DEPLOYMENT: "preview",
  })
  expect(resources.plan).toEqual([
    { kind: "worker", name: `${resources.prefix}-web` },
    { kind: "d1", name: `${resources.prefix}-db` },
    {
      kind: "d1",
      name: `${resources.prefix}-recovery`,
      purpose: "recovery_control",
    },
  ])
  expect(() => sylphResources({})).toThrow("ownership checks")
})

test("custom domains require production and application secrets cannot override bindings", () => {
  const env = {
    SYLPH_RESOURCE_PREFIX: `sylph-${"b".repeat(24)}`,
    SYLPH_DEPLOYMENT: "production",
    SYLPH_CUSTOM_DOMAIN: "app.example.com",
    SYLPH_CUSTOM_DOMAIN_ZONE: "zone",
  }
  expect(sylphResources(env).plan).toContainEqual({
    kind: "domain",
    name: "app.example.com",
  })
  expect(() => sylphResources({ ...env, SYLPH_DEPLOYMENT: "preview" })).toThrow(
    "production"
  )
  expect(() => sylphSecrets('{"DB":"bad"}')).toThrow("reserved binding")
  expect(sylphSecrets('{"PAYMENTS_KEY":"value"}')).toEqual({
    PAYMENTS_KEY: "value",
  })
})
