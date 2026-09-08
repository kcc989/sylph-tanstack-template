import { expect, test } from "bun:test"
import { deriveObjectRecoveryToken } from "./sylph-object-token"

test("object mutation token is stable, key-bound and not the Installation key", async () => {
  const key = "a".repeat(44)
  const token = await deriveObjectRecoveryToken(key)
  expect(token).toMatch(/^[a-f0-9]{64}$/)
  expect(token).not.toBe(key)
  expect(await deriveObjectRecoveryToken(key)).toBe(token)
  expect(await deriveObjectRecoveryToken("b".repeat(44))).not.toBe(token)
  await expect(deriveObjectRecoveryToken("")).rejects.toThrow(
    "Installation recovery key"
  )
})
