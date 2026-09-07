import { execFileSync } from "node:child_process"

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim()

export const reviewMigrationSql = (sql: string) => {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
  if (
    !statements.length ||
    statements.some(
      (statement) =>
        !/^CREATE\s+(?:TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z_][a-z0-9_]*\s*\(|(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z_][a-z0-9_]*\s+ON\s+[a-z_][a-z0-9_]*\s*\()/i.test(
          statement
        )
    )
  )
    throw new Error(
      "Automatic migration review supports only new tables and indexes. Review other migrations explicitly before release."
    )
}

export const reviewMigrations = (baseCommit: string | null, commit: string) => {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    (baseCommit && !/^[a-f0-9]{40}$/.test(baseCommit))
  )
    throw new Error("Release commits must be full immutable Git revisions")
  if (git("rev-parse", "HEAD") !== commit)
    throw new Error("Release checkout does not match SYLPH_CHECKPOINT")
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
    reviewMigrationSql(git("show", `${commit}:${file}`))
  }
  return `Immutable migration history verified; ${added.length} additive migration files checked against ${baseCommit ?? "empty baseline"}`
}
