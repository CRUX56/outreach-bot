CREATE TABLE IF NOT EXISTS latest_lead_search (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  category TEXT NOT NULL,
  city TEXT NOT NULL,
  source TEXT NOT NULL,
  place_ids TEXT[] NOT NULL
);
