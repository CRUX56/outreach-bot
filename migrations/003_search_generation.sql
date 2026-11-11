CREATE SEQUENCE IF NOT EXISTS lead_search_generation_seq;
ALTER TABLE latest_lead_search ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 0;
