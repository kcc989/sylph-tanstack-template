CREATE TABLE IF NOT EXISTS sylph_recovery_resource_operation (
  release_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  schema_fingerprint TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('restoring', 'verified', 'uncertain')),
  evidence TEXT,
  PRIMARY KEY (release_id, resource_kind, resource_id)
);
CREATE TABLE IF NOT EXISTS sylph_recovery_group (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  json TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sylph_recovery_group_operation (
  release_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('restoring', 'verified', 'uncertain'))
);
