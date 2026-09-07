import { execFileSync } from "node:child_process"
import { isDeepStrictEqual } from "node:util"

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim()

export const reviewRecoveryPlan = (serialized: string, expected: unknown) => {
  if (!isDeepStrictEqual(JSON.parse(serialized), expected))
    throw new Error(
      "This recovery adapter requires the unchanged single Worker, application D1 and recovery-control D1 plan. Additional resources or bindings require a tested recovery integration."
    )
}

export const reviewMigrationSql = (sql: string, emptyBaseline = false) => {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
  if (
    !statements.length ||
    statements.some(
      (statement) =>
        (!emptyBaseline && /^CREATE\s+UNIQUE\s+INDEX/i.test(statement)) ||
        !/^CREATE\s+(?:TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z_][a-z0-9_]*\s*\(|(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z_][a-z0-9_]*\s+ON\s+[a-z_][a-z0-9_]*\s*\()/i.test(
          statement
        )
    )
  )
    throw new Error(
      "Automatic migration review supports only new tables and nonunique indexes on existing data. Uniqueness changes require data compatibility verification."
    )
}

export const reviewMigrations = (
  baseCommit: string | null,
  commit: string,
  liveCommit = baseCommit
) => {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    (baseCommit && !/^[a-f0-9]{40}$/.test(baseCommit)) ||
    (liveCommit && !/^[a-f0-9]{40}$/.test(liveCommit))
  )
    throw new Error("Release commits must be full immutable Git revisions")
  if (git("rev-parse", "HEAD") !== commit)
    throw new Error("Release checkout does not match SYLPH_CHECKPOINT")
  if (liveCommit) {
    for (const path of [
      "recovery-migrations",
      "alchemy.run.ts",
      "scripts/sylph-deploy.ts",
      "scripts/sylph-recovery-config.ts",
      "src/worker.ts",
      "src/recovery",
    ]) {
      if (
        git("ls-tree", liveCommit, "--", path) !==
        git("ls-tree", commit, "--", path)
      )
        throw new Error(
          `Recovery infrastructure changed: ${path}. Verify a compatible recovery integration before release.`
        )
    }
  }
  const files = git("ls-tree", "-r", "--name-only", commit, "migrations")
    .split("\n")
    .filter(Boolean)
  const previous = baseCommit
    ? git("ls-tree", "-r", "--name-only", baseCommit, "migrations")
        .split("\n")
        .filter(Boolean)
    : []
  for (const file of previous) {
    if (
      !files.includes(file) ||
      git("rev-parse", `${baseCommit}:${file}`) !==
        git("rev-parse", `${commit}:${file}`)
    )
      throw new Error(`Existing migration changed or removed: ${file}`)
  }
  const added = files.filter((file) => !previous.includes(file))
  for (const file of added) {
    if (!file.endsWith(".sql"))
      throw new Error(`Unsupported migration file: ${file}`)
    reviewMigrationSql(git("show", `${commit}:${file}`), !baseCommit)
  }
  return `Immutable migration history verified; ${added.length} additive migration files checked against ${baseCommit ?? "empty baseline"}`
}
