import { expect, test } from "bun:test"
import { sylphResources, sylphSecrets } from "./sylph-resources"
import { reviewRecoveryPlan } from "./sylph-release-review"

const environment = { SYLPH_RESOURCE_PREFIX: `sylph-${"c".repeat(24)}` }
const declarations = { UPLOADS: "uploads", EXPORTS: "exports" }

test("declared buckets produce one exact guarded binding and retained scratch plan", () => {
  const resources = sylphResources(environment, declarations)
  if (!resources.drillBucketName)
    throw new Error("Expected retained scratch bucket")
  expect(resources.bucketBindings).toEqual({
    UPLOADS: `${environment.SYLPH_RESOURCE_PREFIX}-uploads`,
    EXPORTS: `${environment.SYLPH_RESOURCE_PREFIX}-exports`,
  })
  expect(resources.recoveryWorkers[0]?.bucketNames).toEqual(
    resources.bucketNames
  )
  expect(resources.plan.filter((resource) => resource.kind === "r2")).toEqual([
    ...resources.bucketNames.map((name) => ({ kind: "r2", name })),
    {
      kind: "r2",
      name: resources.drillBucketName,
      purpose: "recovery_control",
    },
  ])
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(resources.plan), resources)
  ).not.toThrow()
  expect(sylphResources(environment).plan).toHaveLength(4)
  expect(() => sylphSecrets('{"UPLOADS":"conflict"}', declarations)).toThrow(
    "reserved binding"
  )
})

test("bucket review rejects unbound, foreign, renamed and omitted state before release", () => {
  const resources = sylphResources(environment, declarations)
  const original = resources.plan[0]
  if (!original?.bindings) throw new Error("Expected declared Worker bindings")
  for (const bindings of [
    [],
    [
      { type: "r2_bucket", name: "UPLOADS", target: "foreign" },
      ...original.bindings.slice(1),
    ],
    [
      { ...original.bindings[0], name: "CHANGED" },
      ...original.bindings.slice(1),
    ],
    [
      ...original.bindings,
      { type: "r2_bucket", name: "SCRATCH", target: resources.drillBucketName },
    ],
    [
      ...original.bindings,
      { type: "kv_namespace", name: "STATE", target: "foreign" },
    ],
  ])
    expect(() =>
      reviewRecoveryPlan(
        JSON.stringify([{ ...original, bindings }, ...resources.plan.slice(1)]),
        resources
      )
    ).toThrow()
  for (const name of [...resources.bucketNames, resources.drillBucketName])
    expect(() =>
      reviewRecoveryPlan(
        JSON.stringify(
          resources.plan.filter((resource) => resource.name !== name)
        ),
        resources
      )
    ).toThrow()
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(resources.plan), {
      ...resources,
      recoveryWorkers: resources.recoveryWorkers.map((worker) => ({
        ...worker,
        bucketNames: [],
      })),
    })
  ).toThrow()
})

test("source declarations reject duplicate suffixes, reserved bindings and invalid resource names", () => {
  for (const invalid of [
    { UPLOADS: "uploads", EXPORTS: "uploads" },
    { DB: "uploads" },
    { SYLPH_OBJECTS: "uploads" },
    { "not-a-binding": "uploads" },
    { UPLOADS: "recovery-drill" },
    { UPLOADS: "../foreign" },
    { UPLOADS: "a".repeat(40) },
    Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [
        `BUCKET_${index}`,
        `objects-${index}`,
      ])
    ),
  ])
    expect(() => sylphResources(environment, invalid)).toThrow(
      "bucket declarations"
    )
})
