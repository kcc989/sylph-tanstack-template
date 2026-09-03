import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { currentDeployment, Deployment } from "./deployment"

const read = (bindings: {
  SYLPH_CHECKPOINT: string
  SYLPH_DEPLOYMENT: string
}) =>
  Effect.runPromise(
    currentDeployment().pipe(Effect.provide(Deployment.layer(bindings)))
  )

describe("Deployment", () => {
  test("reports a Preview checkpoint", async () => {
    const info = await read({
      SYLPH_CHECKPOINT: "0123456789abcdef",
      SYLPH_DEPLOYMENT: "preview",
    })
    expect(info.kind).toBe("preview")
    expect(info.checkpoint).toBe("0123456789abcdef")
  })

  test("falls back to local when no deployment kind is set", async () => {
    const info = await read({ SYLPH_CHECKPOINT: "", SYLPH_DEPLOYMENT: "" })
    expect(info.kind).toBe("local")
    expect(info.checkpoint).toBe("")
  })

  test("rejects an unknown deployment kind", async () => {
    await expect(
      read({ SYLPH_CHECKPOINT: "abc", SYLPH_DEPLOYMENT: "staging" })
    ).rejects.toThrow()
  })
})
