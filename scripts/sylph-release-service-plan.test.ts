import { expect, test } from "bun:test"
import { reviewRecoveryPlan } from "./sylph-release-review"
import { sylphResources } from "./sylph-resources"

const original = sylphResources({
  SYLPH_RESOURCE_PREFIX: `sylph-${"b".repeat(24)}`,
})
const helper = `${original.prefix}-helper`
const resources = {
  ...original,
  recoveryWorkers: [
    {
      workerName: original.workerName,
      databaseNames: [original.databaseName],
      serviceTargets: [helper],
    },
    {
      workerName: helper,
      databaseNames: [original.databaseName],
      serviceTargets: [],
    },
  ],
}
const worker = {
  kind: "worker",
  name: original.workerName,
  bindings: [{ type: "service", name: "INTERNAL_API", target: helper }],
}
const plan = [
  worker,
  { kind: "worker", name: helper },
  ...original.plan.filter((resource) => resource.kind !== "worker"),
]

test("migration review admits a declared guarded service topology sharing one database", () => {
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(plan), resources)
  ).not.toThrow()
})

test("migration review rejects missing, external, duplicate and unguarded service bindings", () => {
  for (const bindings of [
    [],
    [{ type: "service", name: "INTERNAL_API", target: "outside-worker" }],
    [worker.bindings[0], worker.bindings[0]],
    [
      {
        type: "service",
        name: "INTERNAL_API",
        target: helper,
        environment: "production",
      },
    ],
    [
      {
        type: "service",
        name: "INTERNAL_API",
        target: helper,
        entrypoint: "Writer",
      },
    ],
    [{ type: "queue", name: "INTERNAL_API", target: helper }],
    [
      { type: "service", name: "INTERNAL_API", target: helper },
      { type: "kv_namespace", name: "STATE", target: "other" },
    ],
  ])
    expect(() =>
      reviewRecoveryPlan(
        JSON.stringify([{ ...worker, bindings }, ...plan.slice(1)]),
        resources
      )
    ).toThrow()
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(plan), {
      ...resources,
      recoveryWorkers: resources.recoveryWorkers.slice(0, 1),
    })
  ).toThrow("guarded Worker targets")
})
