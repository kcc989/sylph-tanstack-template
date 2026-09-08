CREATE TABLE IF NOT EXISTS sylph_recovery_object_manifest (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  json TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sylph_recovery_object_chunk (
  manifest_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (manifest_id, ordinal)
);
CREATE TABLE IF NOT EXISTS sylph_recovery_object_operation (
  release_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('restoring', 'verified', 'uncertain')),
  PRIMARY KEY (release_id, namespace_id, object_id)
);
CREATE TABLE IF NOT EXISTS sylph_recovery_object_drill (
  namespace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  schema_fingerprint TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  manifest_id TEXT NOT NULL,
  PRIMARY KEY (namespace_id, object_id)
);
CREATE TABLE IF NOT EXISTS sylph_recovery_object_drill_operation (
  namespace_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('probing', 'verified', 'uncertain'))
);
