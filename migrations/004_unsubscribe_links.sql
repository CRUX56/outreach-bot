CREATE TABLE IF NOT EXISTS unsubscribe_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  lead_id INT REFERENCES leads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
