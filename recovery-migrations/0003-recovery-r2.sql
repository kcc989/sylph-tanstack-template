CREATE TABLE IF NOT EXISTS sylph_recovery_r2_manifest (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  bucket_name TEXT NOT NULL,
  json TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sylph_recovery_r2_chunk (
  manifest_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (manifest_id, ordinal)
);
