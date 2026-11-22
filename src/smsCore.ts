import crypto from "node:crypto";

// Pure SMS helpers (no database or network) so they can be unit tested in isolation.

/** Normalizes a phone number to E.164. Bare 10-digit numbers are treated as US/Canada (+1). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && /^[2-9]/.test(digits[1])) return `+${digits}`;
  return null;
}

export const SMS_MAX_BODY = 480;
export const OPT_OUT_FOOTER = "Reply STOP to opt out.";

/** Identifies the sender and appends opt-out instructions (CTIA guidance). */
export function composeSms(businessName: string, body: string): string {
  const text = body.trim();
  const identified = text.toLowerCase().startsWith(businessName.trim().toLowerCase()) ? text : `${businessName.trim()}: ${text}`;
  return /reply stop/i.test(identified) ? identified : `${identified}\n${OPT_OUT_FOOTER}`;
}

export function smsBodyError(body: string): string | null {
  if (!body.trim()) return "Message is required";
  if (body.length > SMS_MAX_BODY) return `Message must be ${SMS_MAX_BODY} characters or fewer`;
  if (/\[[^\]]+\]|{{/.test(body)) return "Message contains a placeholder";
  return null;
}

const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT", "OPT OUT", "STOP ALL"]);
const OPT_IN_KEYWORDS = new Set(["START", "UNSTOP"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);
// FCC rules let people revoke consent by any reasonable means, not only exact keywords.
const OPT_OUT_PHRASES = /\b(stop (texting|messaging|contacting)|don'?t (text|message|contact)|do not (text|message|contact)|remove me|unsubscribe|leave me alone|wrong number|take me off|lose my number)\b/i;

export type InboundKind = "opt_out" | "opt_in" | "help" | "reply";

export function classifyInboundSms(body: string): InboundKind {
  const word = body.trim().replace(/[.!\s]+$/, "").toUpperCase();
  if (OPT_OUT_KEYWORDS.has(word)) return "opt_out";
  if (OPT_IN_KEYWORDS.has(word)) return "opt_in";
  if (HELP_KEYWORDS.has(word)) return "help";
  if (OPT_OUT_PHRASES.test(body)) return "opt_out";
  return "reply";
}

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** TCPA quiet hours: never text before 8am or after 9pm local time, whatever the profile window says. */
export function smsWindow(startHour: number, endHour: number): [number, number] {
  return [Math.max(8, startHour), Math.min(21, endHour)];
}

/** Default first text for a lead who has opted in. */
export function defaultSmsBody(o: { fromName: string; businessName: string; leadName: string; ctaUrl?: string | null }): string {
  const cta = o.ctaUrl ? `Here's more info: ${o.ctaUrl}` : "Want me to send over a free mockup?";
  return `Hi, it's ${o.fromName} with ${o.businessName}. Thanks for your interest in a website for ${o.leadName}. ${cta}`;
}
