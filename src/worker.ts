import { ImapFlow } from "imapflow";
import { q } from "./db.js";
import { decrypt } from "./crypto.js";
import { generateDraft, templateDraft, type DraftContext } from "./drafts.js";
import { commercialProfileError, composeMessage, createUnsubscribeUrl, transportFor, type Profile } from "./mailer.js";
import { processNewLeads } from "./leads.js";
import { normalizeEmail, suppressEmail, withEmailLock } from "./suppression.js";

const activeProfile = async (): Promise<Profile | undefined> =>
  (await q<Profile>("SELECT * FROM sender_profiles WHERE active LIMIT 1"))[0];

const ctxFor = (lead: any, p: Profile): DraftContext => ({
  businessName: lead.name, category: lead.category, city: lead.city,
  findings: lead.site_findings ?? [],
  sender: { from_name: p.from_name, business_name: p.business_name, offer: p.offer, cta_url: p.cta_url, signature: p.signature },
});

// Creates pending first-touch drafts for qualified leads (human approval required before sending)
export async function draftQualified(limit = 10, placeIds?: string[]) {
  const p = await activeProfile();
  if (!p) return 0;
  const leads = await q(
    `SELECT * FROM leads WHERE status='qualified'${placeIds ? " AND place_id = ANY($2::text[])" : ""} LIMIT $1`,
    placeIds ? [limit, placeIds] : [limit],
  );
  for (const l of leads) {
    const d = await generateDraft(ctxFor(l, p));
    await q(
      "INSERT INTO drafts(lead_id,profile_id,step,subject,body,findings_used) VALUES($1,$2,0,$3,$4,$5)",
      [l.id, p.id, d.subject, d.body, JSON.stringify(d.findings)],
    );
    await q("UPDATE leads SET status='drafted' WHERE id=$1", [l.id]);
  }
  return leads.length;
}

const FOLLOWUP_DELAYS_DAYS = [4, 8]; // days after previous send for steps 1 and 2

// After a first touch is sent, queue follow-up drafts for approval once their delay has passed
export async function queueFollowups() {
  const p = await activeProfile();
  if (!p) return;
  const rows = await q(
    `SELECT l.*, d.step, d.sent_at FROM leads l
     JOIN LATERAL (SELECT step, sent_at FROM drafts WHERE lead_id=l.id AND status='sent' ORDER BY step DESC LIMIT 1) d ON TRUE
     WHERE l.status='contacted' AND d.step < 2
       AND NOT EXISTS (SELECT 1 FROM drafts x WHERE x.lead_id=l.id AND x.step=d.step+1)`,
  );
  for (const l of rows) {
    const due = new Date(l.sent_at).getTime() + FOLLOWUP_DELAYS_DAYS[l.step] * 86400000;
    if (Date.now() < due) continue;
    const base = templateDraft(ctxFor(l, p));
    const body = `Hi again - just following up on my note about ${l.name}'s website.\n\n${base.body.split("\n").slice(2).join("\n")}`;
    await q(
      "INSERT INTO drafts(lead_id,profile_id,step,subject,body,findings_used) VALUES($1,$2,$3,$4,$5,$6)",
      [l.id, p.id, l.step + 1, `Re: ${base.subject}`, body, JSON.stringify(base.findings)],
    );
  }
}

const hourIn = (tz: string) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date())) % 24;

// Sends one approved draft if within the send window and under today's cap
export async function sendNext(): Promise<boolean> {
  const p = await activeProfile();
  if (!p) return false;
  const h = hourIn(p.timezone);
  if (h < p.send_start_hour || h >= p.send_end_hour) return false;
  const [{ n }] = await q("SELECT count(*)::int AS n FROM drafts WHERE status='sent' AND profile_id=$1 AND sent_at > now() - interval '24 hours'", [p.id]);
  if (n >= p.daily_cap) return false;

  const [d] = await q(
    `SELECT d.*, l.email, l.status AS lead_status FROM drafts d JOIN leads l ON l.id=d.lead_id
     WHERE d.status='approved' AND d.profile_id=$1 AND (d.send_after IS NULL OR d.send_after<=now())
     ORDER BY d.step, d.id LIMIT 1`, [p.id]);
  if (!d) return false;

  const profileError = commercialProfileError(p);
  if (profileError) {
    console.error(`[send] Commercial sending blocked: ${profileError}`);
    return false;
  }
  if (!d.subject?.trim() || !d.body?.trim()) {
    await q("UPDATE drafts SET status='failed', error='Subject and body are required' WHERE id=$1 AND status='approved'", [d.id]);
    return true;
  }
  if (!d.email) {
    await q("UPDATE drafts SET status='rejected', error='no recipient email' WHERE id=$1 AND status='approved'", [d.id]);
    return true;
  }
  const email = normalizeEmail(d.email);
  const url = await createUnsubscribeUrl(d.lead_id, email);
  await withEmailLock(email, async (client) => {
    const [current] = (await client.query(
      `SELECT d.*, l.email, l.status AS lead_status FROM drafts d JOIN leads l ON l.id=d.lead_id
       WHERE d.id=$1 AND d.status='approved' FOR UPDATE OF d, l`, [d.id])).rows;
    if (!current || normalizeEmail(current.email ?? "") !== email) return;
    const suppressed = (await client.query("SELECT 1 FROM suppression WHERE lower(trim(email))=$1 LIMIT 1", [email])).rowCount;
    if (suppressed || ["unsubscribed", "replied"].includes(current.lead_status)) {
      await client.query("UPDATE drafts SET status='rejected', error='suppressed or no longer eligible' WHERE id=$1", [d.id]);
      return;
    }
    if (!current.subject?.trim() || !current.body?.trim()) {
      await client.query("UPDATE drafts SET status='failed', error='Subject and body are required' WHERE id=$1", [d.id]);
      return;
    }
    try {
      const info = await transportFor(p).sendMail(composeMessage(p, email, current.subject, current.body, url));
      await client.query("UPDATE drafts SET status='sent', sent_at=now(), message_id=$2 WHERE id=$1", [d.id, info.messageId]);
      await client.query("UPDATE leads SET status='contacted' WHERE id=$1 AND status IN ('drafted','contacted')", [d.lead_id]);
      await client.query("INSERT INTO events(lead_id,type) VALUES($1,'sent')", [d.lead_id]);
    } catch (e: any) {
      await client.query("UPDATE drafts SET status='failed', error=$2 WHERE id=$1", [d.id, String(e.message).slice(0, 500)]);
    }
  });
  return true;
}

const classify = (subject: string, text: string, from: string): "bounce" | "unsubscribe" | "reply" => {
  if (/mailer-daemon|postmaster/i.test(from) || /undeliverable|delivery status|returned mail/i.test(subject)) return "bounce";
  if (/\b(unsubscribe|remove me|stop (emailing|contacting)|do not contact|not interested)\b/i.test(text.slice(0, 600))) return "unsubscribe";
  return "reply";
};

export async function pollReplies() {
  const p = await activeProfile();
  if (!p?.imap_host || !p.imap_user || !p.imap_pass_enc) return;
  const c = new ImapFlow({ host: p.imap_host, port: p.imap_port ?? 993, secure: true, auth: { user: p.imap_user, pass: decrypt(p.imap_pass_enc) }, logger: false });
  await c.connect();
  const lock = await c.getMailboxLock("INBOX");
  try {
    for await (const m of c.fetch({ seen: false }, { envelope: true, source: true })) {
      const from = m.envelope?.from?.[0]?.address?.toLowerCase() ?? "";
      const text = m.source?.toString("utf8").split(/\r?\n\r?\n/).slice(1).join("\n") ?? "";
      const leads = await q("SELECT id FROM leads WHERE lower(email)=$1", [from]);
      // Bounces come from the mailer daemon, so match the original recipient in the body
      const lead = leads[0] ?? (await q("SELECT id, email FROM leads WHERE status='contacted' AND position(lower(email) in $1)>0 LIMIT 1", [text.toLowerCase()]))[0];
      if (!lead) continue;
      const kind = classify(m.envelope?.subject ?? "", text, from);
      const [row] = await q("SELECT email FROM leads WHERE id=$1", [lead.id]);
      if (kind === "bounce" || kind === "unsubscribe") {
        await suppressEmail(row.email, kind);
      } else await q("UPDATE leads SET status='replied' WHERE id=$1", [lead.id]);
      await q("UPDATE drafts SET status='rejected', error='lead responded' WHERE lead_id=$1 AND status IN ('pending','approved')", [lead.id]);
      await q("INSERT INTO events(lead_id,type,detail) VALUES($1,$2,$3)", [lead.id, kind, JSON.stringify({ subject: m.envelope?.subject })]);
      await c.messageFlagsAdd(m.uid, ["\\Seen"], { uid: true });
    }
  } finally { lock.release(); await c.logout(); }
}

const safe = (name: string, fn: () => Promise<unknown>) => fn().catch((e) => console.error(`[${name}]`, e.message));

export function startWorkers() {
  // Send spacing: one email per tick, randomized 2-6 minutes apart
  const sendLoop = async () => { await safe("send", sendNext); setTimeout(sendLoop, 120000 + Math.random() * 240000); };
  setTimeout(sendLoop, 30000);
  setInterval(() => safe("leads", async () => { await processNewLeads(); await draftQualified(); await queueFollowups(); }), 5 * 60000);
  setInterval(() => safe("replies", pollReplies), 10 * 60000);
}
