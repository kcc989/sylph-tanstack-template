CREATE TABLE sylph_managed_kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  version TEXT NOT NULL,
  value TEXT NOT NULL,
  digest TEXT NOT NULL,
  metadata TEXT NOT NULL,
  expiration INTEGER,
  PRIMARY KEY (namespace, key)
);
