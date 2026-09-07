import { expect, test } from "bun:test"

test.each(["paused", "resumed", "wrong-commit", "wrong-release"])(
  "verification uses only the probe token and observed app identity: %s",
  async (mode) => {
    const commit = "a".repeat(40)
    let authenticated = false
    let appRequests = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/__sylph/release-verify") {
          authenticated =
            request.headers.get("Authorization") === "Bearer fixture-verifier"
          return Response.json({
            checkpoint: mode === "wrong-commit" ? "b".repeat(40) : commit,
            releaseId: mode === "wrong-release" ? "other" : "release",
            deployment: "production",
            databaseReadable: true,
            pausedBy: mode === "paused" ? "release" : null,
            secretFingerprints: {},
          })
        }
        appRequests += 1
        return new Response(
          `<main>SYLPH_CHECKPOINT=${commit} SYLPH_DEPLOYMENT=production</main>`
        )
      },
    })
    try {
      const child = Bun.spawn(
        [Bun.which("bun") ?? "bun", "scripts/sylph-release.ts", "verify"],
        {
          env: {
            SYLPH_RELEASE_ID: "release",
            SYLPH_PROJECT_ID: "project",
            SYLPH_CHECKPOINT: commit,
            SYLPH_PRODUCTION_URL: server.url.toString(),
            SYLPH_RECOVERY_VERIFY_TOKEN: "fixture-verifier",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      )
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ])
      expect(authenticated).toBe(true)
      if (mode.startsWith("wrong")) {
        expect(code).toBe(1)
        expect(stdout).not.toContain("SYLPH_PRODUCTION_JOURNEY=")
      } else {
        expect(code).toBe(0)
        expect(
          JSON.parse(stdout.trim().split("=").slice(1).join("="))
        ).toMatchObject({ commit, deploymentId: "release", passed: true })
      }
      expect(appRequests).toBe(mode === "resumed" ? 1 : 0)
    } finally {
      server.stop(true)
    }
  }
)
