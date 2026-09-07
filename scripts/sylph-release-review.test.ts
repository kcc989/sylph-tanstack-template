import { expect, test } from "bun:test"
import { reviewMigrationSql, reviewRecoveryPlan } from "./sylph-release-review"
import { sylphResources } from "./sylph-resources"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("review admits additive tables and indexes", () => {
  expect(() =>
    reviewMigrationSql(
      "CREATE TABLE users (id TEXT PRIMARY KEY); CREATE INDEX users_id ON users (id);"
    )
  ).not.toThrow()
})

test("review rejects data mutation and unsupported migration programs", () => {
  for (const sql of [
    "DROP TABLE users;",
    "ALTER TABLE users DROP COLUMN email;",
    "CREATE TABLE users (id TEXT); DELETE FROM users;",
    "CREATE TRIGGER writes AFTER INSERT ON users BEGIN DELETE FROM users; END;",
    "PRAGMA foreign_keys = OFF;",
    "CREATE UNIQUE INDEX users_email ON users (email);",
    "",
  ])
    expect(() => reviewMigrationSql(sql)).toThrow("only new tables")
})

test("unique indexes require an empty initial baseline", () => {
  expect(() =>
    reviewMigrationSql(
      "CREATE UNIQUE INDEX users_email ON users (email);",
      true
    )
  ).not.toThrow()
})

test("review rejects proposed state or writers outside the recovery boundary", () => {
  const resources = sylphResources({
    SYLPH_RESOURCE_PREFIX: `sylph-${"a".repeat(24)}`,
  })
  const plan = resources.plan
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(plan), resources)
  ).not.toThrow()
  const extended = {
    ...resources,
    plan: [...plan, { kind: "worker", name: "another" }],
  }
  expect(() =>
    reviewRecoveryPlan(JSON.stringify(extended.plan), extended)
  ).toThrow("tested recovery integration")
  for (const kind of [
    "worker",
    "r2",
    "kv",
    "queue",
    "durable_object",
    "workflow",
  ])
    expect(() =>
      reviewRecoveryPlan(
        JSON.stringify([...plan, { kind, name: "additional" }]),
        resources
      )
    ).toThrow("tested recovery integration")
  expect(() =>
    reviewRecoveryPlan(
      JSON.stringify(
        plan.map((item, index) =>
          index === 0
            ? {
                ...item,
                bindings: [
                  { type: "service", name: "OTHER", target: "outside" },
                ],
              }
            : item
        )
      ),
      resources
    )
  ).toThrow("tested recovery integration")
})

test("an actual release review rejects control-data migrations even during recovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "sylph-release-review-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  try {
    git("init")
    mkdirSync(join(directory, "migrations"))
    mkdirSync(join(directory, "recovery-migrations"))
    writeFileSync(
      join(directory, "migrations/0001.sql"),
      "CREATE TABLE user (id TEXT PRIMARY KEY);"
    )
    writeFileSync(
      join(directory, "recovery-migrations/0001.sql"),
      "CREATE TABLE gate (id INTEGER PRIMARY KEY);"
    )
    const commit = () => {
      git("add", ".")
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "-m",
        "Fixture"
      )
      return git("rev-parse", "HEAD")
    }
    const baseline = commit()
    const module = new URL("./sylph-release-review.ts", import.meta.url)
      .pathname
    const run = (base: string | null, head: string) =>
      spawnSync(
        Bun.which("bun") ?? "bun",
        [
          "-e",
          `import { reviewMigrations } from ${JSON.stringify(module)}; reviewMigrations(${JSON.stringify(base)}, ${JSON.stringify(head)}, ${JSON.stringify(baseline)})`,
        ],
        { cwd: directory, encoding: "utf8", timeout: 15000 }
      )
    expect(run(baseline, baseline).status).toBe(0)
    writeFileSync(
      join(directory, "recovery-migrations/0002.sql"),
      "DELETE FROM gate;"
    )
    const changed = commit()
    for (const base of [baseline, null]) {
      const result = run(base, changed)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("Recovery infrastructure changed")
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)
