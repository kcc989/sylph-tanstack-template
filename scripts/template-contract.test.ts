import { expect, test } from "bun:test"

test("the deployment runtime loads its platform peers", async () => {
  const [node, bun, cloudflare] = await Promise.all([
    import("@effect/platform-node/NodeServices"),
    import("@effect/platform-bun/BunServices"),
    import("alchemy/Cloudflare"),
  ])
  expect(node.layer).toBeDefined()
  expect(bun.layer).toBeDefined()
  expect(cloudflare.Worker).toBeDefined()
})
