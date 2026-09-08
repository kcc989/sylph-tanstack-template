import { expect, test } from "bun:test"
import { sylphResources, sylphSecrets } from "./sylph-resources"
import { reviewRecoveryPlan } from "./sylph-release-review"

const environment = { SYLPH_RESOURCE_PREFIX: `sylph-${"b".repeat(24)}` }

test("managed KV and queues declare exact storage, bindings and journal ownership", () => {
  const resources = sylphResources(
    environment,
    {},
    { SETTINGS: "settings" },
    { JOBS: "jobs" }
  )
  expect(resources.plan.map((item) => item.kind)).toEqual([
    "worker",
    "d1",
    "d1",
    "d1",
    "kv",
    "queue",
  ])
  expect(resources.recoveryWorkers[0]?.managedKv).toEqual([
    {
      bindingName: "SETTINGS",
      namespaceName: resources.kvBindings.SETTINGS,
      databaseName: resources.databaseName,
    },
  ])
  expect(resources.recoveryWorkers[0]?.queueConsumers).toEqual([
    {
      queueName: resources.queueBindings.JOBS,
      databaseName: resources.databaseName,
    },
  ])
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(resources.plan), resources)
  ).not.toThrow()
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(resources.plan), {
      ...resources,
      recoveryWorkers: resources.recoveryWorkers.map((worker) => ({
        ...worker,
        managedQueues: [],
      })),
    })
  ).toThrow()
  expect(() =>
    reviewRecoveryPlan(
      JSON.stringify(resources.plan.filter((item) => item.kind !== "kv")),
      resources
    )
  ).toThrow()
})

test("managed storage rejects binding and physical-name collisions across resource kinds", () => {
  expect(() =>
    sylphResources(environment, { FILES: "files" }, { FILES: "cache" })
  ).toThrow()
  expect(() =>
    sylphResources(environment, { FILES: "files" }, {}, { JOBS: "files" })
  ).toThrow()
  expect(() => sylphResources(environment, {}, { DB: "settings" })).toThrow()
  expect(() =>
    sylphSecrets('{"JOBS":"secret"}', {}, {}, { JOBS: "jobs" })
  ).toThrow()
})

test("registered Durable Objects require exact host bindings and declared classes", () => {
  const objects = {
    STATE: { className: "ManagedState", objectNames: ["primary"] },
  }
  const resources = sylphResources(environment, {}, {}, {}, objects)
  expect(resources.plan.at(-1)).toEqual({
    kind: "durable_object",
    name: `${resources.workerName}/ManagedState`,
    worker: resources.workerName,
    className: "ManagedState",
  })
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(resources.plan), resources)
  ).not.toThrow()
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(resources.plan.slice(0, -1)), resources)
  ).toThrow()
  expect(() =>
    sylphResources(
      environment,
      {},
      {},
      {},
      { STATE: { className: "ManagedState", objectNames: [] } }
    )
  ).toThrow()
  expect(() =>
    sylphResources(
      environment,
      {},
      {},
      {},
      { ...objects, OTHER: objects.STATE }
    )
  ).toThrow()
  expect(() =>
    sylphSecrets('{"STATE":"secret"}', {}, {}, {}, objects)
  ).toThrow()
})
