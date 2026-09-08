CREATE TABLE IF NOT EXISTS sylph_recovery_queue (
  queue TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (queue, id)
);
CREATE INDEX IF NOT EXISTS sylph_recovery_queue_pending ON sylph_recovery_queue (queue, completed_at, id);
