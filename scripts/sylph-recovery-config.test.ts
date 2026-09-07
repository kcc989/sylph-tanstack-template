import { expect, test } from "bun:test"
import { assertRecoveryManifest } from "./sylph-recovery-config"
import type { D1RecoveryManifest } from "../src/recovery/domain"

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
