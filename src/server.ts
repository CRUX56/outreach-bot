import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { config } from "./config.js";
import { q } from "./db.js";
import { encrypt, unsubToken } from "./crypto.js";
import { searchPlaces, processNewLeads } from "./leads.js";
import { draftQualified } from "./worker.js";
import { checkDns, sendTest, verifyProfile, type Profile } from "./mailer.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (title: string, body: string) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:15px system-ui;max-width:960px;margin:20px auto;padding:0 12px}nav a{margin-right:14px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}
input,textarea,select{width:100%;padding:5px;box-sizing:border-box}label{display:block;margin-top:8px;font-weight:600}
.card{border:1px solid #ccc;border-radius:6px;padding:12px;margin:12px 0}.tag{background:#eef;border-radius:4px;padding:1px 6px;margin-right:4px;font-size:12px}
button{padding:6px 12px;margin-right:6px}pre{white-space:pre-wrap;font:inherit}</style>
<nav><a href=/>Dashboard</a><a href=/leads>Leads</a><a href=/drafts>Approval queue</a><a href=/settings>Sender settings</a></nav><h1>${esc(title)}</h1>${body}`;

const safeEqual = (a: string, b: string) => {
  const x = crypto.createHash("sha256").update(a).digest(), y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

function auth(req: Request, res: Response, next: NextFunction) {
  const [u, ...rest] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":");
  if (config.adminPassword && safeEqual(u, config.adminUser) && safeEqual(rest.join(":"), config.adminPassword)) return next();
  res.set("WWW-Authenticate", 'Basic realm="outreach"').status(401).send("Auth required");
}

export function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // Public: one-click unsubscribe (no auth)
  const unsub = async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || !safeEqual(String(req.params.token), unsubToken(id))) return res.status(400).send("Invalid link");
    const [l] = await q("SELECT email FROM leads WHERE id=$1", [id]);
    if (l?.email) await q("INSERT INTO suppression(email,reason) VALUES($1,'unsubscribe') ON CONFLICT DO NOTHING", [l.email]);
    await q("UPDATE leads SET status='unsubscribed' WHERE id=$1", [id]);
    await q("UPDATE drafts SET status='rejected', error='unsubscribed' WHERE lead_id=$1 AND status IN ('pending','approved')", [id]);
    res.send(page("Unsubscribed", "<p>You've been removed and won't receive further emails.</p>").replace(/<nav>.*?<\/nav>/, ""));
  };
  app.get("/unsubscribe/:id/:token", unsub);
  app.post("/unsubscribe/:id/:token", unsub);

  app.use(auth);

  app.get("/", async (_req, res) => {
    const stats = await q("SELECT status, count(*)::int n FROM leads GROUP BY status ORDER BY status");
    const dr = await q("SELECT status, count(*)::int n FROM drafts GROUP BY status ORDER BY status");
    const row = (r: any) => `<tr><td>${esc(r.status)}</td><td>${r.n}</td></tr>`;
    res.send(page("Dashboard", `
      <div class=card><h3>Find leads</h3><form method=post action=/search>
      <label>Category (e.g. plumber)</label><input name=category required>
      <label>City (e.g. Austin, TX)</label><input name=city required><p><button>Search &amp; audit</button></p></form></div>
      <h3>Leads</h3><table>${stats.map(row).join("")}</table><h3>Drafts</h3><table>${dr.map(row).join("")}</table>`));
  });

  app.post("/search", async (req, res) => {
    try {
      await searchPlaces(String(req.body.category), String(req.body.city));
      await processNewLeads(40);
      await draftQualified(40);
      res.redirect("/drafts");
    } catch (e: any) { res.status(500).send(page("Error", `<pre>${esc(e.message)}</pre>`)); }
  });

  app.get("/leads", async (_req, res) => {
    const rows = await q("SELECT * FROM leads ORDER BY id DESC LIMIT 200");
    res.send(page("Leads", `<table><tr><th>Name</th><th>Website</th><th>Email</th><th>Status</th><th>Findings</th></tr>${rows.map((l) =>
      `<tr><td>${esc(l.name)}</td><td>${esc(l.website ?? "none")}</td><td>${esc(l.email)}</td><td>${esc(l.status)}</td>
       <td>${(l.site_findings ?? []).map((f: any) => `<span class=tag title="${esc(f.evidence)}">${esc(f.type)}</span>`).join("")}</td></tr>`).join("")}</table>`));
  });

  app.get("/drafts", async (_req, res) => {
    const rows = await q(`SELECT d.*, l.name, l.email, l.website FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.status='pending' ORDER BY d.id LIMIT 50`);
    res.send(page("Approval queue", rows.length ? rows.map((d) => `<div class=card>
      <b>${esc(d.name)}</b> &lt;${esc(d.email)}&gt; &middot; ${esc(d.website ?? "no website")} &middot; step ${d.step}
      <ul>${(d.findings_used ?? []).map((f: any) => `<li><span class=tag>${esc(f.type)}</span>${esc(f.evidence)}</li>`).join("")}</ul>
      <form method=post action=/drafts/${d.id}><label>Subject</label><input name=subject value="${esc(d.subject)}">
      <label>Body</label><textarea name=body rows=10>${esc(d.body)}</textarea>
      <p><button name=action value=approve>Approve</button><button name=action value=reject>Reject</button></p></form></div>`).join("") : "<p>Nothing pending.</p>"));
  });

  app.post("/drafts/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (req.body.action === "approve")
      await q("UPDATE drafts SET status='approved', subject=$2, body=$3 WHERE id=$1 AND status='pending'", [id, String(req.body.subject), String(req.body.body)]);
    else await q("UPDATE drafts SET status='rejected' WHERE id=$1 AND status='pending'", [id]);
    res.redirect("/drafts");
  });

  app.get("/settings", async (req, res) => {
    const profiles = await q("SELECT * FROM sender_profiles ORDER BY id");
    const msg = req.query.msg ? `<div class=card><pre>${esc(req.query.msg)}</pre></div>` : "";
    const field = (n: string, label: string, v = "", type = "text") => `<label>${label}</label><input name=${n} type=${type} value="${esc(v)}">`;
    const form = (p: any = {}) => `<form method=post action=/settings${p.id ? `/${p.id}` : ""}>
      ${field("name", "Profile name", p.name)}${field("from_name", "From name", p.from_name)}${field("from_email", "From email", p.from_email, "email")}${field("reply_to", "Reply-to (optional)", p.reply_to)}
      ${field("smtp_host", "SMTP host", p.smtp_host)}${field("smtp_port", "SMTP port", p.smtp_port ?? 587, "number")}${field("smtp_user", "SMTP user", p.smtp_user)}
      <label>SMTP password ${p.id ? "(leave blank to keep)" : ""}</label><input name=smtp_pass type=password autocomplete=new-password>
      ${field("imap_host", "IMAP host (for reply detection)", p.imap_host)}${field("imap_port", "IMAP port", p.imap_port ?? 993, "number")}${field("imap_user", "IMAP user", p.imap_user)}
      <label>IMAP password ${p.id ? "(leave blank to keep)" : ""}</label><input name=imap_pass type=password autocomplete=new-password>
      ${field("business_name", "Business name", p.business_name)}${field("mailing_address", "Physical mailing address (required by CAN-SPAM)", p.mailing_address)}
      <label>Your offer (used in emails)</label><textarea name=offer rows=3>${esc(p.offer)}</textarea>${field("cta_url", "Call-to-action URL", p.cta_url)}
      <label>Signature</label><textarea name=signature rows=3>${esc(p.signature)}</textarea>
      ${field("daily_cap", "Daily send cap", p.daily_cap ?? 20, "number")}${field("send_start_hour", "Send window start hour (0-23)", p.send_start_hour ?? 9, "number")}
      ${field("send_end_hour", "Send window end hour (0-23)", p.send_end_hour ?? 17, "number")}${field("timezone", "Timezone (IANA)", p.timezone ?? "America/New_York")}
      <p><button>Save</button></p></form>`;
    const list = profiles.map((p) => `<div class=card><b>${esc(p.name)}</b> ${p.active ? "(ACTIVE)" : ""}
      <form method=post action=/settings/${p.id}/activate style=display:inline><button>Make active</button></form>
      <form method=post action=/settings/${p.id}/verify style=display:inline><button>Verify SMTP/IMAP/DNS</button></form>
      <form method=post action=/settings/${p.id}/test style=display:inline><input name=to placeholder="send test to..." style="width:200px"><button>Send test</button></form>
      <details><summary>Edit</summary>${form(p)}</details></div>`).join("");
    res.send(page("Sender settings", `${msg}${list}<div class=card><h3>New profile</h3>${form()}</div>`));
  });

  const redirectMsg = (res: Response, m: string) => res.redirect(`/settings?msg=${encodeURIComponent(m)}`);

  async function saveProfile(req: Request, res: Response) {
    const b = req.body, id = req.params.id ? Number(req.params.id) : null;
    const prev = id ? (await q("SELECT smtp_pass_enc, imap_pass_enc FROM sender_profiles WHERE id=$1", [id]))[0] : null;
    const smtpPass = b.smtp_pass ? encrypt(b.smtp_pass) : prev?.smtp_pass_enc;
    const imapPass = b.imap_pass ? encrypt(b.imap_pass) : prev?.imap_pass_enc ?? null;
    if (!smtpPass) return redirectMsg(res, "SMTP password required");
    if (!b.mailing_address?.trim()) return redirectMsg(res, "Mailing address required (CAN-SPAM)");
    const vals = [b.name, b.from_name, b.from_email, b.reply_to || null, b.smtp_host, +b.smtp_port, b.smtp_user, smtpPass,
      b.imap_host || null, +b.imap_port || 993, b.imap_user || null, imapPass, b.signature ?? "", b.business_name, b.mailing_address, b.offer ?? "", b.cta_url || null,
      +b.daily_cap || 20, +b.send_start_hour, +b.send_end_hour, b.timezone];
    const cols = ["name", "from_name", "from_email", "reply_to", "smtp_host", "smtp_port", "smtp_user", "smtp_pass_enc", "imap_host", "imap_port", "imap_user", "imap_pass_enc", "signature", "business_name", "mailing_address", "offer", "cta_url", "daily_cap", "send_start_hour", "send_end_hour", "timezone"];
    if (id) await q(`UPDATE sender_profiles SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(",")} WHERE id=$${cols.length + 1}`, [...vals, id]);
    else await q(`INSERT INTO sender_profiles(${cols.join(",")}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
    redirectMsg(res, "Saved");
  }
  app.post("/settings", saveProfile);
  app.post("/settings/:id", saveProfile);

  const profile = async (id: string) => (await q<Profile>("SELECT * FROM sender_profiles WHERE id=$1", [Number(id)]))[0];
  app.post("/settings/:id/activate", async (req, res) => {
    await q("UPDATE sender_profiles SET active = (id=$1)", [Number(req.params.id)]);
    redirectMsg(res, "Activated");
  });
  app.post("/settings/:id/verify", async (req, res) => {
    const p = await profile(req.params.id);
    redirectMsg(res, p ? JSON.stringify(await verifyProfile(p), null, 2) : "Not found");
  });
  app.post("/settings/:id/test", async (req, res) => {
    const p = await profile(req.params.id);
    if (!p || !req.body.to) return redirectMsg(res, "Profile and recipient required");
    try { redirectMsg(res, `Sent ${await sendTest(p, String(req.body.to))}`); } catch (e: any) { redirectMsg(res, `Failed: ${e.message}`); }
  });

  return app;
}

export { checkDns };
