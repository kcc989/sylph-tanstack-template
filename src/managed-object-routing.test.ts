import { Schema } from "effect"
import { RecoveryObjectRegistry } from "./recovery/object-domain"
import { expect, test } from "bun:test"
import {
  objectRecoveryRoute,
  requireRegisteredObject,
} from "./managed-object-routing"

function fixture() {
  let calls = 0
  const identity = { namespaceId: "namespace", objectId: "id-primary" }
  const environment = {
    BETTER_AUTH_SECRET: "secret",
    SYLPH_RECOVERY_VERIFY_TOKEN: "token",
    SYLPH_RECOVERY_OBJECT_TOKEN: "object-token",
    SYLPH_RELEASE_ID: "release",
    SYLPH_CHECKPOINT: "checkpoint",
    SYLPH_DEPLOYMENT: "production",
    SYLPH_MANAGED_QUEUE_NAMES: "{}",
    DB: Object.create(null),
    SYLPH_RECOVERY_CONTROL: Object.create(null),
    STATE: {
      idFromName: (name: string) => ({ toString: () => `id-${name}` }),
      idFromString: (id: string) => ({ toString: () => id }),
      get: () => ({
        recovery: async () => {
          calls++
          return {
            identity,
            snapshot: { version: 1, tables: [], indexes: [], values: [] },
          }
        },
      }),
    },
  }
  const declarations = {
    STATE: { className: "ManagedState", objectNames: ["primary"] },
  }
  const request = (
    path: string,
    body?: object,
    token = body ? "object-token" : "token"
  ) =>
    new Request(`https://worker.invalid/__sylph/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    })
  return { environment, declarations, request, identity, calls: () => calls }
}

test("object registry requires authentication and derives IDs without opening objects", async () => {
  const p = fixture()
  expect(
    (
      await objectRecoveryRoute(
        p.request("object-registry", undefined, "wrong"),
        p.environment,
        p.declarations
      )
    )?.status
  ).toBe(401)
  const response = await objectRecoveryRoute(
    p.request("object-registry"),
    p.environment,
    p.declarations
  )
  expect(response?.status).toBe(200)
  if (!response) throw new Error("Expected registry response")
  expect(
    Schema.decodeUnknownSync(RecoveryObjectRegistry)(await response.json())
  ).toEqual([
    {
      bindingName: "STATE",
      className: "ManagedState",
      objectNames: ["primary"],
      objectIds: ["id-primary"],
    },
  ])
  expect(p.calls()).toBe(0)
})

test("object recovery rejects unregistered IDs and dispatches only the declared object", async () => {
  const p = fixture()
  const denied = await objectRecoveryRoute(
    p.request("object-recovery", {
      bindingName: "STATE",
      request: {
        operation: "capture",
        releaseId: "release",
        identity: { ...p.identity, objectId: "id-stranger" },
      },
    }),
    p.environment,
    p.declarations
  )
  expect(denied?.status).toBe(400)
  expect(p.calls()).toBe(0)
  const response = await objectRecoveryRoute(
    p.request("object-recovery", {
      bindingName: "STATE",
      request: {
        operation: "capture",
        releaseId: "release",
        identity: p.identity,
      },
    }),
    p.environment,
    p.declarations
  )
  expect(response?.status).toBe(200)
  expect(p.calls()).toBe(1)
})

test("the read-only verification token cannot invoke object mutation", async () => {
  const p = fixture()
  const response = await objectRecoveryRoute(
    p.request(
      "object-recovery",
      {
        bindingName: "STATE",
        request: {
          operation: "capture",
          releaseId: "release",
          identity: p.identity,
        },
      },
      "token"
    ),
    p.environment,
    p.declarations
  )
  expect(response?.status).toBe(401)
  expect(p.calls()).toBe(0)
})

test("ordinary object operations reject unregistered IDs before opening storage", () => {
  const p = fixture()
  expect(() =>
    requireRegisteredObject(
      p.environment,
      "ManagedState",
      "id-stranger",
      p.declarations
    )
  ).toThrow("not registered")
  expect(() =>
    requireRegisteredObject(
      p.environment,
      "OtherClass",
      "id-primary",
      p.declarations
    )
  ).toThrow("not registered")
  expect(() =>
    requireRegisteredObject(
      p.environment,
      "ManagedState",
      "id-primary",
      p.declarations
    )
  ).not.toThrow()
  expect(p.calls()).toBe(0)
})
