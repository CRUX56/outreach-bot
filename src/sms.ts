import { q } from "./db.js";
import { config } from "./config.js";
import { decrypt } from "./crypto.js";
import { withEmailLock } from "./suppression.js";
import type { PoolClient } from "pg";
import { composeSms, normalizePhone } from "./smsCore.js";

export * from "./smsCore.js";

export interface SmsProfile {
  id: number; business_name: string; from_name: string;
  twilio_account_sid: string | null; twilio_auth_token_enc: string | null; sms_from: string | null; sms_daily_cap: number;
}

export function smsProfileError(p: SmsProfile): string | null {
  if (!p.twilio_account_sid?.trim() || !p.twilio_auth_token_enc) return "Twilio Account SID and Auth Token are required";
  if (!p.sms_from || normalizePhone(p.sms_from) !== p.sms_from) return "SMS from number must be in E.164 format, e.g. +17045551234";
  if (!p.business_name?.trim()) return "Business name is required";
  if (!config.publicUrl.startsWith("https://")) return "PUBLIC_URL must be a public HTTPS URL so Twilio can deliver STOP replies";
  return null;
}

/** Serializes all work on one phone number (shares the advisory-lock helper used for email). */
export const withPhoneLock = <T>(phone: string, fn: (c: PoolClient) => Promise<T>) => withEmailLock(`sms:${phone}`, fn);

export async function twilioSend(p: SmsProfile, to: string, body: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const sid = p.twilio_account_sid!.trim();
  const token = decrypt(p.twilio_auth_token_enc!);
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: p.sms_from!, Body: body }),
    signal: AbortSignal.timeout(30000),
  });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok || !json.sid) throw new Error(`Twilio ${res.status}${json.code ? ` (${json.code})` : ""}: ${json.message ?? "send failed"}`);
  return json.sid;
}

/** Commercial text: identifies the business and includes STOP instructions. */
export const composeCommercialSms = (p: SmsProfile, body: string) => composeSms(p.business_name, body);

export async function suppressPhone(raw: string, reason: string): Promise<void> {
  const phone = normalizePhone(raw);
  if (!phone) throw new Error("A valid phone number is required");
  await withPhoneLock(phone, async (c) => {
    await c.query("INSERT INTO sms_suppression(phone,reason) VALUES($1,$2) ON CONFLICT (phone) DO NOTHING", [phone, reason]);
    await c.query("UPDATE leads SET sms_consent_at=NULL WHERE sms_phone=$1", [phone]);
    await c.query(`UPDATE drafts SET status='rejected', error='phone opted out of texts'
      WHERE channel='sms' AND status IN ('pending','approved') AND lead_id IN (SELECT id FROM leads WHERE sms_phone=$1)`, [phone]);
  });
}

export async function isPhoneSuppressed(phone: string): Promise<boolean> {
  return (await q("SELECT 1 FROM sms_suppression WHERE phone=$1", [phone])).length > 0;
}
