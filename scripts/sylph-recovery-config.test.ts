import { expect, test } from "bun:test"
import {
  assertRecoveryManifest,
  assertRecoveryGroup,
  managedRecoveryReceipts,
} from "./sylph-recovery-config"
import type {
  D1RecoveryManifest,
  D1RecoveryGroup,
} from "../src/recovery/domain"

test("restore receipts describe exactly the authenticated manifest contents", () => {
  const manifest: D1RecoveryManifest = {
    version: 1,
    id: "manifest",
    projectId: "project",
    releaseId: "release",
    databaseId: "db",
    capturedAt: 1,
    restoreVerifiedAt: 1,
    expiresAt: 100,
    bookmark: "bookmark",
    fingerprint: "data",
    schemaFingerprint: "schema",
    secrets: [
      {
        name: "BETTER_AUTH_SECRET",
        version: "secret-version",
        ciphertext: "encrypted-fixture",
        iv: "iv-fixture",
      },
    ],
  }
  const point = {
    deploymentId: "release",
    resources: [
      { kind: "database", id: "db", backupRef: "manifest" },
      { kind: "secret", id: "BETTER_AUTH_SECRET", backupRef: "manifest" },
    ],
  }
  expect(() => assertRecoveryManifest(point, manifest)).not.toThrow()
  for (const resources of [
    [
      ...point.resources,
      { kind: "database", id: "another", backupRef: "manifest" },
    ],
    [
      ...point.resources,
      { kind: "secret", id: "invented", backupRef: "manifest" },
    ],
    point.resources.slice(0, 1),
    [point.resources[0], point.resources[0]],
  ])
    expect(() =>
      assertRecoveryManifest({ ...point, resources }, manifest)
    ).toThrow("exact secret versions")
  expect(() =>
    assertRecoveryManifest({ ...point, deploymentId: "other" }, manifest)
  ).toThrow("exact secret versions")
})

test("managed receipts use authoritative restore proofs and aggregate every registered object", () => {
  const group: D1RecoveryGroup = {
    version: 1,
    id: "group",
    projectId: "project",
    releaseId: "release",
    capturedAt: 99,
    expiresAt: 1000,
    topology: {
      workers: [
        {
          workerName: "worker",
          databaseIds: ["db"],
          serviceTargets: [],
          secretNames: [],
          managedKv: [
            { bindingName: "CACHE", namespaceId: "cache", databaseId: "db" },
          ],
          managedQueues: [
            {
              bindingName: "JOBS",
              queueId: "jobs",
              queueName: "jobs",
              databaseId: "db",
            },
          ],
          queueConsumers: [
            { queueId: "jobs", queueName: "jobs", databaseId: "db" },
          ],
          durableObjects: [
            {
              bindingName: "STATE",
              namespaceId: "objects",
              objectIds: ["first", "second"],
            },
          ],
        },
      ],
    },
    databases: [
      {
        version: 1,
        id: "database-manifest",
        projectId: "project",
        releaseId: "release",
        databaseId: "db",
        capturedAt: 99,
        restoreVerifiedAt: 3,
        expiresAt: 1000,
        bookmark: "bookmark",
        fingerprint: "data",
        schemaFingerprint: "schema",
        secrets: [],
      },
    ],
    objects: ["first", "second"].map((objectId, index) => ({
      version: 1,
      id: objectId,
      projectId: "project",
      releaseId: "release",
      identity: { namespaceId: "objects", objectId },
      capturedAt: 99,
      expiresAt: 1000,
      fingerprint: "object",
      chunkCount: 1,
      restoreVerifiedAt: 4 + index,
    })),
  }
  const receipts = managedRecoveryReceipts(group)
  expect(receipts).toEqual([
    { kind: "kv", id: "cache", backupRef: "group:group", restoreVerifiedAt: 3 },
    {
      kind: "other",
      id: "jobs",
      backupRef: "group:group",
      restoreVerifiedAt: 3,
    },
    {
      kind: "durable-object",
      id: "objects",
      backupRef: "group:group",
      restoreVerifiedAt: 4,
    },
  ])
  expect(() =>
    assertRecoveryGroup(
      {
        deploymentId: "release",
        resources: [
          { kind: "database", id: "db", backupRef: "group:group" },
          ...receipts,
        ],
      },
      group
    )
  ).not.toThrow()
  expect(() =>
    managedRecoveryReceipts({ ...group, objects: group.objects?.slice(1) })
  ).toThrow("missing registered")
})
