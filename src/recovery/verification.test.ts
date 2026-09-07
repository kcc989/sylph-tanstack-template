import { expect, test } from "bun:test"
import { secretFingerprints } from "./verification"

test("secret verification binds value, name, and the private probe token", async () => {
  const original = await secretFingerprints(
    { SESSION_SECRET: "first" },
    "private-token"
  )
  expect(original.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/)
  expect(
    await secretFingerprints({ SESSION_SECRET: "first" }, "private-token")
  ).toEqual(original)
  expect(
    await secretFingerprints({ SESSION_SECRET: "changed" }, "private-token")
  ).not.toEqual(original)
  expect(
    await secretFingerprints({ SESSION_SECRET: "first" }, "other-token")
  ).not.toEqual(original)
  expect(
    (await secretFingerprints({ OTHER_SECRET: "first" }, "private-token"))
      .OTHER_SECRET
  ).not.toBe(original.SESSION_SECRET)
})

test("secret fingerprint order is stable across environment serialization", async () => {
  expect(await secretFingerprints({ Z: "one", A: "two" }, "token")).toEqual(
    await secretFingerprints({ A: "two", Z: "one" }, "token")
  )
})
