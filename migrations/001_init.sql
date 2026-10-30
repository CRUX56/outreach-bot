CREATE TABLE IF NOT EXISTS sender_profiles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  smtp_host TEXT NOT NULL,
  smtp_port INT NOT NULL DEFAULT 587,
  smtp_user TEXT NOT NULL,
  smtp_pass_enc TEXT NOT NULL,
  imap_host TEXT,
  imap_port INT DEFAULT 993,
  imap_user TEXT,
  imap_pass_enc TEXT,
  signature TEXT NOT NULL DEFAULT '',
  business_name TEXT NOT NULL,
  mailing_address TEXT NOT NULL,
  offer TEXT NOT NULL DEFAULT '',
  cta_url TEXT,
  daily_cap INT NOT NULL DEFAULT 20,
  send_start_hour INT NOT NULL DEFAULT 9,
  send_end_hour INT NOT NULL DEFAULT 17,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  place_id TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  city TEXT,
  phone TEXT,
  website TEXT,
  rating NUMERIC,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'new',
  site_findings JSONB,
  audited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drafts (
  id SERIAL PRIMARY KEY,
  lead_id INT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  profile_id INT NOT NULL REFERENCES sender_profiles(id),
  step INT NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  findings_used JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  send_after TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  message_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  lead_id INT REFERENCES leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppression (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
