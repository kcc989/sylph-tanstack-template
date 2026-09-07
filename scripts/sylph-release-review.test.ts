import { expect, test } from "bun:test"
import { reviewMigrationSql } from "./sylph-release-review"

test("review admits additive tables and indexes", () => {
  expect(() =>
    reviewMigrationSql(
      "CREATE TABLE users (id TEXT PRIMARY KEY); CREATE UNIQUE INDEX users_id ON users (id);"
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
    "",
  ])
    expect(() => reviewMigrationSql(sql)).toThrow("only new tables")
})
