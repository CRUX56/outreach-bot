import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import dns from "node:dns/promises";
import { q } from "./db.js";
import { decrypt, unsubToken } from "./crypto.js";
import { config } from "./config.js";

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

export const unsubUrl = (leadId: number) => `${config.publicUrl}/unsubscribe/${leadId}/${unsubToken(leadId)}`;

export function composeMessage(p: Profile, to: string, subject: string, body: string, leadId: number) {
  const url = unsubUrl(leadId);
  const footer = `\n\n--\n${p.business_name}, ${p.mailing_address}\nNot interested? Unsubscribe: ${url}`;
  return {
    from: `"${p.from_name}" <${p.from_email}>`,
    replyTo: p.reply_to ?? undefined,
    to, subject,
    text: body + footer,
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
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
  const info = await transportFor(p).sendMail(composeMessage(p, to, "Test from outreach bot", "This is a test message.", 0));
  return info.messageId;
}
