-- SMS via Twilio. Texts are only sent to leads with recorded prior express written consent.
ALTER TABLE sender_profiles ADD COLUMN IF NOT EXISTS twilio_account_sid TEXT;
ALTER TABLE sender_profiles ADD COLUMN IF NOT EXISTS twilio_auth_token_enc TEXT;
ALTER TABLE sender_profiles ADD COLUMN IF NOT EXISTS sms_from TEXT;
ALTER TABLE sender_profiles ADD COLUMN IF NOT EXISTS sms_daily_cap INT NOT NULL DEFAULT 20;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_phone TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_consent_source TEXT;
CREATE INDEX IF NOT EXISTS leads_sms_phone_idx ON leads(sms_phone);

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';

CREATE TABLE IF NOT EXISTS sms_suppression (
  phone TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
