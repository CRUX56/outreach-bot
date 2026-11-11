import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import dns from "node:dns/promises";
import crypto from "node:crypto";
import { isIP } from "node:net";
import { q } from "./db.js";
import { decrypt } from "./crypto.js";
import { config } from "./config.js";
import { normalizeEmail } from "./suppression.js";

export interface Profile {
  id: number; from_name: string; from_email: string; reply_to: string | null;
  smtp_host: string; smtp_port: number; smtp_user: string; smtp_pass_enc: string;
  imap_host: string | null; imap_port: number | null; imap_user: string | null; imap_pass_enc: string | null;
  signature: string; business_name: string; mailing_address: string; offer: string; cta_url: string | null;
  daily_cap: number; send_start_hour: number; send_end_hour: number; timezone: string;
}

export const transportFor = (p: Profile) =>
  nodemailer.createTransport({
    host: p.smtp_host, port: p.smtp_port, secure: p.smtp_port === 465,
    auth: { user: p.smtp_user, pass: decrypt(p.smtp_pass_enc) },
  });

export function commercialProfileError(p: Profile): string | null {
  if (!p.business_name?.trim() || !p.mailing_address?.trim() || !p.from_name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.from_email?.trim() ?? "")) {
    return "Sender name, email, business name and mailing address are required";
  }
  let url: URL;
  try { url = new URL(config.publicUrl); } catch { return "PUBLIC_URL must be a publicly reachable HTTPS URL"; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "PUBLIC_URL must be a publicly reachable HTTPS URL";
  }
  return null;
}

export async function createUnsubscribeUrl(leadId: number, email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await q("INSERT INTO unsubscribe_links(token,email,lead_id) VALUES($1,$2,$3)", [token, normalizeEmail(email), leadId]);
  return `${config.publicUrl}/unsubscribe-link/${token}`;
}

export function composeMessage(p: Profile, to: string, subject: string, body: string, url: string) {
  const footer = `\n\n--\nAdvertisement from ${p.business_name}\n${p.mailing_address}\nTo opt out of future emails, visit: ${url}`;
  return {
    from: `"${p.from_name}" <${p.from_email}>`,
    replyTo: p.reply_to ?? undefined,
    to, subject,
    text: body + footer,
    headers: { "List-Unsubscribe": `<${url}>` },
  };
}

export async function verifyProfile(p: Profile) {
  const result: Record<string, string> = {};
  try { await transportFor(p).verify(); result.smtp = "ok"; } catch (e: any) { result.smtp = `fail: ${e.message}`; }
  if (p.imap_host && p.imap_user && p.imap_pass_enc) {
    const c = new ImapFlow({ host: p.imap_host, port: p.imap_port ?? 993, secure: true, auth: { user: p.imap_user, pass: decrypt(p.imap_pass_enc) }, logger: false });
    try { await c.connect(); await c.logout(); result.imap = "ok"; } catch (e: any) { result.imap = `fail: ${e.message}`; }
  } else result.imap = "not configured";
  Object.assign(result, await checkDns(p.from_email.split("@")[1]));
  return result;
}

export async function checkDns(domain: string) {
  const txt = async (name: string) => { try { return (await dns.resolveTxt(name)).map((r) => r.join("")); } catch { return []; } };
  const spf = (await txt(domain)).find((t) => t.startsWith("v=spf1"));
  const dmarc = (await txt(`_dmarc.${domain}`)).find((t) => t.startsWith("v=DMARC1"));
  return { spf: spf ? "ok" : "missing", dmarc: dmarc ? "ok" : "missing", dkim: "check selector with your provider (cannot be auto-detected)" };
}

export async function sendTest(p: Profile, to: string) {
  const info = await transportFor(p).sendMail({
    from: `"${p.from_name}" <${p.from_email}>`, replyTo: p.reply_to ?? undefined, to,
    subject: "Test from outreach bot", text: "This is a sender configuration test, not a commercial email.",
  });
  return info.messageId;
}
