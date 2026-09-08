import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sylphResources } from "./sylph-resources"
import { secretFingerprints } from "../src/recovery/verification"

const prefix = `sylph-${"a".repeat(24)}`
const commit = "a".repeat(40)
const secret = "fixture-immutable-auth-secret"
const token = "fixture-probe-token"

async function releaseFixture(withBuckets = false) {
  const directory = await mkdtemp(join(tmpdir(), "sylph-release-group-"))
  const bootstrap = join(directory, "bootstrap")
  await writeFile(
    join(directory, "bun"),
    `#!/bin/sh\nprintf bootstrap >> '${bootstrap}'\n`,
    { mode: 0o700 }
  )
  const databases = new Map<string, Database>([
    ["app", new Database(":memory:")],
    ["control", new Database(":memory:")],
    ["drill", new Database(":memory:")],
  ])
  const database = (id: string) => {
    const value = databases.get(id)
    if (!value) throw new Error("Unknown fixture database")
    return value
  }
  for (const id of ["app", "drill"])
    database(id).run(
      "CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
  database("app").run(
    "INSERT INTO records VALUES ('user-record', 'before-release')"
  )
  for (const name of [
    "0001-recovery.sql",
    "0002-recovery-group.sql",
    "0003-recovery-r2.sql",
  ])
    database("control").run(
      await readFile(
        new URL(`../recovery-migrations/${name}`, import.meta.url),
        "utf8"
      )
    )
  type StoredObject = {
    bytes: Uint8Array<ArrayBuffer>
    http: Record<string, string>
    custom: Record<string, string>
    storage: string
  }
  const buckets = new Map<string, Map<string, StoredObject>>([
    [
      `${prefix}-uploads`,
      new Map([
        [
          "user/upload.txt",
          {
            bytes: new TextEncoder().encode("before-upload"),
            http: { contentType: "text/plain", cacheControl: "private" },
            custom: { owner: "fixture-user" },
            storage: "Standard",
          },
        ],
      ]),
    ],
    [`${prefix}-recovery-drill`, new Map()],
  ])
  const objectWrites: string[] = []
  const bookmarks = new Map<string, Uint8Array>()
  const restores: string[] = []
  const requests: string[] = []
  const failures: string[] = []
  let workerExists = false
  let lookupFailure: number | undefined
  let uncertainRestore = false
  let activeLifecycle = false
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/__sylph/release-verify") {
        if (request.headers.get("Authorization") !== `Bearer ${token}`)
          return new Response("Unauthorized", { status: 401 })
        const names: string[] = JSON.parse(
          request.headers.get("X-Sylph-Secret-Names") ?? "[]"
        )
        return Response.json({
          checkpoint: commit,
          deployment: "production",
          releaseId: "release-a",
          databaseReadable: true,
          pausedBy:
            database("control")
              .query<{ owner: string | null }, []>(
                "SELECT owner FROM sylph_recovery_gate WHERE id=1"
              )
              .get()?.owner ?? null,
          secretFingerprints: await secretFingerprints(
            Object.fromEntries(names.map((name) => [name, secret])),
            token
          ),
        })
      }
      if (
        request.headers.get("Authorization") !== "Bearer fixture-provider-token"
      )
        return new Response("Unauthorized", { status: 401 })
      if (url.pathname.endsWith("/queues"))
        return Response.json({
          success: true,
          result: [],
          result_info: { page: 1, total_pages: 1, total_count: 0 },
        })
      if (lookupFailure && url.pathname.endsWith("/settings"))
        return new Response("Provider lookup unavailable", {
          status: lookupFailure,
        })
      if (url.pathname.endsWith("/workers/scripts/" + prefix + "-web/settings"))
        return workerExists
          ? Response.json({
              success: true,
              result: {
                bindings: [
                  { type: "d1", name: "DB", id: "app" },
                  ...(withBuckets
                    ? [
                        {
                          type: "r2_bucket",
                          name: "UPLOADS",
                          bucket_name: `${prefix}-uploads`,
                        },
                      ]
                    : []),
                  { type: "d1", name: "SYLPH_RECOVERY_CONTROL", id: "control" },
                  { type: "secret_text", name: "BETTER_AUTH_SECRET" },
                  { type: "secret_text", name: "SYLPH_RECOVERY_VERIFY_TOKEN" },
                ],
              },
            })
          : Response.json({ success: false }, { status: 404 })
      if (url.pathname.endsWith("/schedules"))
        return Response.json({ success: true, result: { schedules: [] } })
      if (url.pathname === "/accounts/account/d1/database")
        return Response.json({
          success: true,
          result: [
            { uuid: "app", name: `${prefix}-db` },
            { uuid: "control", name: `${prefix}-recovery` },
            { uuid: "drill", name: `${prefix}-recovery-drill` },
          ],
        })
      const policy = url.pathname.match(
        /^\/accounts\/account\/r2\/buckets\/([^/]+)\/(lifecycle|lock|sippy)$/
      )
      if (policy) {
        const name = decodeURIComponent(policy[1])
        if (!withBuckets || !buckets.has(name))
          return new Response("Unknown bucket", { status: 404 })
        return Response.json({
          success: true,
          result:
            policy[2] === "sippy"
              ? { enabled: false }
              : {
                  rules:
                    activeLifecycle && policy[2] === "lifecycle"
                      ? [
                          {
                            id: "delete-objects",
                            enabled: true,
                            conditions: { prefix: "" },
                            deleteObjectsTransition: {
                              condition: { type: "Age", maxAge: 1 },
                            },
                          },
                        ]
                      : [],
                },
        })
      }
      const notifications = url.pathname.match(
        /^\/accounts\/account\/event_notifications\/r2\/([^/]+)\/configuration$/
      )
      if (notifications) {
        const bucketName = decodeURIComponent(notifications[1])
        if (!withBuckets || !buckets.has(bucketName))
          return new Response("Unknown bucket", { status: 404 })
        return Response.json({
          success: true,
          result: { bucketName, queues: [] },
        })
      }
      const bucketMatch = url.pathname.match(
        /^\/accounts\/account\/r2\/buckets\/([^/]+)\/objects(?:\/(.+))?$/
      )
      if (bucketMatch) {
        const bucketName = decodeURIComponent(bucketMatch[1])
        const bucket = buckets.get(bucketName)
        if (!withBuckets || !bucket)
          return new Response("Unknown bucket", { status: 404 })
        const key = bucketMatch[2]?.split("/").map(decodeURIComponent).join("/")
        if (!key)
          return Response.json({
            success: true,
            result: [...bucket]
              .filter(([name]) =>
                name.startsWith(url.searchParams.get("prefix") ?? "")
              )
              .map(([name, value]) => ({
                key: name,
                size: value.bytes.length,
                etag: createHash("sha256").update(value.bytes).digest("hex"),
                http_metadata: value.http,
                custom_metadata: value.custom,
                storage_class: value.storage,
              })),
            result_info: { is_truncated: false },
          })
        if (request.method === "PUT") {
          objectWrites.push(bucketName)
          bucket.set(key, {
            bytes: new Uint8Array(await request.arrayBuffer()),
            http: JSON.parse(
              request.headers.get("cf-r2-http-metadata") ?? "{}"
            ),
            custom: JSON.parse(
              request.headers.get("cf-r2-custom-metadata") ?? "{}"
            ),
            storage: request.headers.get("cf-r2-storage-class") ?? "Standard",
          })
          return Response.json({ success: true })
        }
        if (request.method === "DELETE") {
          objectWrites.push(bucketName)
          bucket.delete(key)
          return Response.json({ success: true })
        }
        const value = bucket.get(key)
        if (!value) return new Response("Unknown object", { status: 404 })
        return new Response(value.bytes, {
          headers: {
            etag: createHash("sha256").update(value.bytes).digest("hex"),
          },
        })
      }
      const match = url.pathname.match(
        /^\/accounts\/account\/d1\/database\/(app|control|drill)(.*)$/
      )
      if (!match) return new Response("Unknown fixture path", { status: 404 })
      const [, id, suffix] = match
      if (!suffix)
        return Response.json({
          success: true,
          result: {
            uuid: id,
            name: id === "drill" ? `${prefix}-recovery-drill` : `${prefix}-db`,
          },
        })
      if (suffix === "/query") {
        const body: { sql: string; params?: (string | number | null)[] } =
          await request.json()
        try {
          return Response.json({
            success: true,
            result: [
              {
                success: true,
                results: database(id)
                  .query(body.sql)
                  .all(...(body.params ?? [])),
              },
            ],
          })
        } catch (error) {
          failures.push(`${body.sql}: ${String(error)}`)
          return Response.json({ success: false, result: [] }, { status: 400 })
        }
      }
      const bytes = database(id).serialize()
      const bookmark = createHash("sha256").update(bytes).digest("hex")
      bookmarks.set(`${id}:${bookmark}`, bytes)
      if (suffix === "/time_travel/bookmark")
        return Response.json({ success: true, result: { bookmark } })
      if (suffix === "/time_travel/restore") {
        const saved = bookmarks.get(`${id}:${url.searchParams.get("bookmark")}`)
        if (!saved) return new Response("Unknown bookmark", { status: 400 })
        restores.push(id)
        database(id).close()
        databases.set(id, Database.deserialize(saved))
        if (uncertainRestore && id === "app")
          return new Response("Lost acknowledgement", { status: 503 })
        return Response.json({
          success: true,
          result: {
            bookmark: url.searchParams.get("bookmark"),
            previous_bookmark: bookmark,
          },
        })
      }
      return new Response("Unknown operation", { status: 404 })
    },
  })
  const preload = join(directory, "transport.ts")
  await writeFile(
    preload,
    `${
      withBuckets
        ? `import { mock } from "bun:test"
const original = await import(${JSON.stringify(new URL("./sylph-resources.ts", import.meta.url).pathname)})
const resources = original.sylphResources
mock.module(${JSON.stringify(new URL("./sylph-resources.ts", import.meta.url).pathname)}, () => ({...original, sylphResources: environment => resources(environment, {UPLOADS: "uploads"})}))
`
        : ""
    }const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
 const url = new URL(input instanceof Request ? input.url : input)
 if (url.origin === "https://provider.fixture.test") return realFetch(new URL(url.pathname + url.search, ${JSON.stringify(server.url.origin)}), init)
 if (url.origin !== ${JSON.stringify(server.url.origin)}) throw new Error("Unexpected external fixture request")
 return realFetch(input, init)
}
`
  )
  return {
    database,
    buckets,
    objectWrites,
    requests,
    restores,
    failures,
    failWorkerLookup: (status: number) => {
      lookupFailure = status
    },
    setWorkerExists: () => {
      workerExists = true
    },
    activateLifecycle: () => {
      activeLifecycle = true
    },
    loseRestoreAcknowledgement: () => {
      uncertainRestore = true
    },
    bootstrapCount: async () => {
      try {
        return (await readFile(bootstrap, "utf8")).length / "bootstrap".length
      } catch {
        return 0
      }
    },
    async hook(action: string, overrides: Record<string, string> = {}) {
      const child = Bun.spawn(
        [
          Bun.which("bun") ?? "bun",
          "--preload",
          preload,
          "scripts/sylph-release.ts",
          action,
        ],
        {
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            SYLPH_RELEASE_ID: "release-a",
            SYLPH_PROJECT_ID: "project",
            SYLPH_CHECKPOINT: commit,
            SYLPH_DEPLOYMENT: "production",
            SYLPH_RESOURCE_PREFIX: prefix,
            CLOUDFLARE_ACCOUNT_ID: "account",
            CLOUDFLARE_API_TOKEN: "fixture-provider-token",
            SYLPH_CLOUDFLARE_API_BASE_URL: "https://provider.fixture.test",
            SYLPH_RECOVERY_KEY: Buffer.alloc(32, 7).toString("base64"),
            SYLPH_RECOVERY_SECRETS: JSON.stringify({
              BETTER_AUTH_SECRET: secret,
            }),
            SYLPH_RECOVERY_VERIFY_TOKEN: token,
            SYLPH_BASE_URL: server.url.origin,
            ...overrides,
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    },
    async close() {
      server.stop(true)
      for (const value of databases.values()) value.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const recoveryPoint = (stdout: string) => {
  const line = stdout
    .split("\n")
    .find((line) => line.startsWith("SYLPH_RECOVERY_POINT="))
  if (!line) throw new Error("Hook did not produce a recovery point")
  return JSON.parse(line.slice("SYLPH_RECOVERY_POINT=".length))
}

test("first prepare performs a real scratch restore and captures encrypted application state", async () => {
  const fixture = await releaseFixture()
  try {
    const prepared = await fixture.hook("prepare")
    expect({
      stderr: prepared.stderr,
      failures: fixture.failures,
      lastRequests: prepared.code ? fixture.requests.slice(-10) : [],
    }).toEqual({ stderr: "", failures: [], lastRequests: [] })
    expect(prepared.code).toBe(0)
    expect(await fixture.bootstrapCount()).toBe(1)
    expect(fixture.restores).toEqual(["drill"])
    expect(
      fixture
        .database("drill")
        .query(
          "SELECT name FROM sqlite_schema WHERE name='sylph_recovery_drill_probe'"
        )
        .all()
    ).toEqual([])
    expect(
      fixture.database("app").query("SELECT value FROM records").all()
    ).toEqual([{ value: "before-release" }])
    expect(
      fixture
        .database("control")
        .query("SELECT owner,active FROM sylph_recovery_gate")
        .get()
    ).toEqual({ owner: "release-a", active: 0 })
    const point = recoveryPoint(prepared.stdout)
    expect(
      point.resources
        .map(
          (resource: { kind: string; id: string }) =>
            `${resource.kind}:${resource.id}`
        )
        .sort()
    ).toEqual(["database:app", "secret:BETTER_AUTH_SECRET"])
    expect(
      point.resources.every((resource: { backupRef: string }) =>
        resource.backupRef.startsWith("group:")
      )
    ).toBe(true)
    expect(
      fixture
        .database("control")
        .query("SELECT json FROM sylph_recovery_group")
        .all()
    ).toHaveLength(1)
    expect(
      JSON.stringify(
        fixture
          .database("control")
          .query("SELECT json FROM sylph_recovery_secret_deployment")
          .all()
      )
    ).not.toContain(secret)
    expect(prepared.stdout).not.toContain(secret)
  } finally {
    await fixture.close()
  }
}, 60000)

test.each(["existing", "denied", "unavailable"])(
  "initial prepare stops before bootstrap when Worker absence is unproven: %s",
  async (mode) => {
    const fixture = await releaseFixture()
    if (mode === "existing") fixture.setWorkerExists()
    else fixture.failWorkerLookup(mode === "denied" ? 403 : 503)
    try {
      const prepared = await fixture.hook("prepare")
      expect(prepared.code).toBe(1)
      expect(prepared.stdout).not.toContain("SYLPH_RECOVERY_POINT=")
      expect(await fixture.bootstrapCount()).toBe(0)
      expect(fixture.restores).toEqual([])
    } finally {
      await fixture.close()
    }
  },
  60000
)

test.each(["verified", "uncertain"])(
  "restore uses the complete group and retains the pause after %s provider results",
  async (mode) => {
    const fixture = await releaseFixture()
    try {
      const initial = await fixture.hook("prepare")
      expect(initial.code).toBe(0)
      const point = recoveryPoint(initial.stdout)
      fixture.setWorkerExists()
      fixture.database("app").run("UPDATE records SET value='candidate-data'")
      const recoveryInputs = {
        SYLPH_RELEASE_ID: "recovery-r",
        SYLPH_BASE_COMMIT: commit,
        SYLPH_RECOVERY_POINT: JSON.stringify(point),
      }
      const undo = await fixture.hook("prepare", recoveryInputs)
      expect(undo.stderr).toBe("")
      expect(undo.code).toBe(0)
      expect(fixture.restores).toEqual(["drill"])
      const incomplete = { ...point, resources: point.resources.slice(0, 1) }
      expect(
        (
          await fixture.hook("restore", {
            ...recoveryInputs,
            SYLPH_RECOVERY_POINT: JSON.stringify(incomplete),
          })
        ).code
      ).toBe(1)
      expect(fixture.restores).toEqual(["drill"])
      if (mode === "uncertain") fixture.loseRestoreAcknowledgement()
      const restored = await fixture.hook("restore", recoveryInputs)
      expect(restored.code).toBe(mode === "verified" ? 0 : 1)
      expect(restored.stdout.includes("SYLPH_DATA_RESTORED=")).toBe(
        mode === "verified"
      )
      expect(fixture.restores).toEqual(["drill", "app"])
      expect(
        fixture.database("app").query("SELECT value FROM records").all()
      ).toEqual([{ value: "before-release" }])
      expect(
        fixture
          .database("control")
          .query("SELECT owner FROM sylph_recovery_gate")
          .get()
      ).toEqual({ owner: "recovery-r" })
      expect((await fixture.hook("restore", recoveryInputs)).code).toBe(1)
      expect(fixture.restores).toEqual(["drill", "app"])
      if (mode === "uncertain")
        expect((await fixture.hook("resume", recoveryInputs)).code).toBe(1)
    } finally {
      await fixture.close()
    }
  },
  60000
)

test("bucket-enabled hooks drill only scratch and recover complete bytes and metadata with D1", async () => {
  const fixture = await releaseFixture(true)
  try {
    const prepared = await fixture.hook("prepare")
    expect({
      code: prepared.code,
      stderr: prepared.stderr,
      failures: fixture.failures,
      lastRequests: prepared.code ? fixture.requests.slice(-8) : [],
    }).toEqual({ code: 0, stderr: "", failures: [], lastRequests: [] })
    const point = recoveryPoint(prepared.stdout)
    expect(
      point.resources
        .map(
          (resource: { kind: string; id: string }) =>
            `${resource.kind}:${resource.id}`
        )
        .sort()
    ).toEqual([
      "database:app",
      `object-storage:${prefix}-uploads`,
      "secret:BETTER_AUTH_SECRET",
    ])
    expect(fixture.objectWrites.length).toBeGreaterThan(0)
    expect(new Set(fixture.objectWrites)).toEqual(
      new Set([`${prefix}-recovery-drill`])
    )
    const app = fixture.buckets.get(`${prefix}-uploads`)
    if (!app) throw new Error("Missing application bucket")
    const original = app.get("user/upload.txt")
    if (!original) throw new Error("Missing upload")
    expect(new TextDecoder().decode(original.bytes)).toBe("before-upload")
    app.set("user/upload.txt", {
      ...original,
      bytes: new TextEncoder().encode("candidate-upload"),
      custom: { owner: "candidate" },
    })
    app.set("new/file", { ...original, bytes: new TextEncoder().encode("new") })
    fixture.database("app").run("UPDATE records SET value='candidate'")
    fixture.setWorkerExists()
    const overrides = {
      SYLPH_RELEASE_ID: "release-r",
      SYLPH_BASE_COMMIT: commit,
      SYLPH_RECOVERY_POINT: JSON.stringify(point),
    }
    const undo = await fixture.hook("prepare", overrides)
    expect({
      code: undo.code,
      stderr: undo.stderr,
      failures: fixture.failures,
    }).toEqual({ code: 0, stderr: "", failures: [] })
    const beforeRestore = fixture.objectWrites.length
    const incomplete = {
      ...point,
      resources: point.resources.filter(
        (resource: { kind: string }) => resource.kind !== "object-storage"
      ),
    }
    expect(
      (
        await fixture.hook("restore", {
          ...overrides,
          SYLPH_RECOVERY_POINT: JSON.stringify(incomplete),
        })
      ).code
    ).not.toBe(0)
    expect(fixture.objectWrites).toHaveLength(beforeRestore)
    const restored = await fixture.hook("restore", overrides)
    expect({
      code: restored.code,
      stderr: restored.stderr,
      failures: fixture.failures,
    }).toEqual({ code: 0, stderr: "", failures: [] })
    expect(
      fixture.database("app").query("SELECT value FROM records").get()
    ).toEqual({ value: "before-release" })
    expect([...app.keys()]).toEqual(["user/upload.txt"])
    expect(app.get("user/upload.txt")).toEqual(original)
    expect(
      fixture
        .database("control")
        .query("SELECT owner,active FROM sylph_recovery_gate")
        .get()
    ).toEqual({ owner: "release-r", active: 0 })
    expect(restored.stdout).toContain(`object-storage:${prefix}-uploads`)
    const count = fixture.objectWrites.length
    expect((await fixture.hook("restore", overrides)).code).not.toBe(0)
    expect(fixture.objectWrites).toHaveLength(count)
  } finally {
    await fixture.close()
  }
}, 60000)

test("bucket prepare rejects active lifecycle writers before any object mutation", async () => {
  const fixture = await releaseFixture(true)
  try {
    fixture.activateLifecycle()
    const prepared = await fixture.hook("prepare")
    expect(prepared.code).not.toBe(0)
    expect(prepared.stdout).not.toContain("SYLPH_RECOVERY_POINT=")
    expect(fixture.objectWrites).toEqual([])
    expect(
      fixture.database("app").query("SELECT value FROM records").get()
    ).toEqual({ value: "before-release" })
    expect(
      fixture
        .database("control")
        .query("SELECT owner,active FROM sylph_recovery_gate")
        .get()
    ).toEqual({ owner: "r2-drill-release-a", active: 0 })
  } finally {
    await fixture.close()
  }
}, 60000)

test("recovery review refuses a forged receipt or changed immutable target before source exceptions", async () => {
  const fixture = await releaseFixture()
  try {
    const prepared = await fixture.hook("prepare")
    expect(prepared.code).toBe(0)
    fixture.setWorkerExists()
    const point = {
      ...recoveryPoint(prepared.stdout),
      commit,
      baseCommit: null,
    }
    const inputs = {
      SYLPH_RESOURCE_PLAN: JSON.stringify(
        sylphResources({ SYLPH_RESOURCE_PREFIX: prefix }).plan
      ),
      SYLPH_BASE_COMMIT: commit,
    }
    const forged = await fixture.hook("review", {
      ...inputs,
      SYLPH_RECOVERY_POINT: JSON.stringify({
        ...point,
        deploymentId: "forged",
      }),
    })
    expect(forged.code).toBe(1)
    expect(forged.stdout).not.toContain("SYLPH_MIGRATION_REVIEW=")
    const changed = await fixture.hook("review", {
      ...inputs,
      SYLPH_RECOVERY_POINT: JSON.stringify({
        ...point,
        baseCommit: "b".repeat(40),
      }),
    })
    expect(changed.code).toBe(1)
    expect(changed.stdout).not.toContain("SYLPH_MIGRATION_REVIEW=")
    expect(fixture.restores).toEqual(["drill"])
  } finally {
    await fixture.close()
  }
})
