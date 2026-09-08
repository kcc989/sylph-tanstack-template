import { expect, test } from "bun:test"
import { inspectManagedObjects } from "./sylph-object-config"

const configuration = {
  apiBaseUrl: "https://provider.invalid/accounts/account",
  apiToken: "owner-token",
  objectToken: async () => "object-token",
}
const declarations = [
  { bindingName: "STATE", className: "ManagedState", objectNames: ["primary"] },
]
function provider(names = ["primary"]) {
  const calls: { url: string; body: string | undefined }[] = []
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body?.toString() })
    if (url.endsWith("/settings"))
      return Response.json({
        success: true,
        result: {
          bindings: [
            {
              type: "durable_object_namespace",
              name: "STATE",
              namespace_id: "provider-namespace",
            },
          ],
        },
      })
    if (url.endsWith("object-registry"))
      return Response.json([
        {
          bindingName: "STATE",
          className: "ManagedState",
          objectNames: names,
          objectIds: ["registered-id"],
        },
      ])
    return Response.json({
      identity: {
        namespaceId: "provider-namespace",
        objectId: "registered-id",
      },
      snapshot: { version: 1, tables: [], indexes: [], values: [] },
    })
  }
  return {
    request: Object.assign(request, { preconnect: fetch.preconnect }),
    calls,
  }
}

test("object configuration joins provider namespace identity to the exact reviewed registry", async () => {
  const p = provider()
  const result = await inspectManagedObjects(
    configuration,
    "worker",
    declarations,
    "https://worker.invalid",
    "probe-token",
    p.request
  )
  expect(result.identities).toEqual([
    { namespaceId: "provider-namespace", objectId: "registered-id" },
  ])
  const identity = result.identities[0]
  if (!identity) throw new Error("Missing identity")
  await result.transport({
    operation: "capture",
    releaseId: "release",
    identity,
  })
  expect(JSON.parse(p.calls.at(-1)?.body ?? "{}")).toEqual({
    bindingName: "STATE",
    request: {
      operation: "capture",
      releaseId: "release",
      identity: {
        namespaceId: "provider-namespace",
        objectId: "registered-id",
      },
    },
  })
  await expect(
    result.transport({
      operation: "capture",
      releaseId: "release",
      identity: { namespaceId: "other", objectId: "registered-id" },
    })
  ).rejects.toThrow("not registered")
})

test("a renamed live object cannot pass registry review merely by keeping the same count", async () => {
  const p = provider(["other"])
  await expect(
    inspectManagedObjects(
      configuration,
      "worker",
      declarations,
      "https://worker.invalid",
      "probe-token",
      p.request
    )
  ).rejects.toThrow("missing or ambiguous")
})

test("read-only object configuration never needs the mutation capability", async () => {
  const p = provider()
  const result = await inspectManagedObjects(
    { ...configuration, objectToken: undefined },
    "worker",
    declarations,
    "https://worker.invalid",
    "probe-token",
    p.request
  )
  const identity = result.identities[0]
  if (!identity) throw new Error("Missing identity")
  await expect(
    result.transport({ operation: "capture", releaseId: "release", identity })
  ).rejects.toThrow("mutation capability")
  expect(p.calls).toHaveLength(2)
})
