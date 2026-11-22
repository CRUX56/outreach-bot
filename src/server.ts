import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { config } from "./config.js";
import { q } from "./db.js";
import { encrypt, unsubToken } from "./crypto.js";
import { searchPlaces, processNewLeads } from "./leads.js";
import { draftQualified } from "./worker.js";
import { hasMx } from "./leads.js";
import { searchOsm, importCsv } from "./osm.js";
import { checkDns, commercialProfileError, sendTest, verifyProfile, type Profile } from "./mailer.js";
import { normalizeEmail, suppressEmail, withEmailLock } from "./suppression.js";
import { decrypt } from "./crypto.js";
import { classifyInboundSms, composeCommercialSms, defaultSmsBody, normalizePhone, smsBodyError, smsProfileError, suppressPhone, twilioSend, validTwilioSignature, withPhoneLock, type SmsProfile } from "./sms.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (title: string, body: string, publicPage = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | Outreach Bot</title><link rel="stylesheet" href="/styles.css"></head>
<body class="min-h-screen bg-slate-50 text-slate-800">
${publicPage ? "" : `<header class="border-b border-slate-200 bg-white"><div class="mx-auto flex max-w-7xl flex-wrap items-center gap-6 px-4 py-4 sm:px-6"><a class="text-lg font-bold text-indigo-700" href="/">Outreach Bot</a><nav aria-label="Main navigation" class="flex flex-wrap gap-4 text-sm font-medium text-slate-600"><a href="/">Dashboard</a><a href="/leads">Leads</a><a href="/calls">Call list</a><a href="/drafts">Approval queue</a><a href="/settings">Sender settings</a><a href="/suppression">Do not email</a><a href="/sms-suppression">Do not text</a></nav></div></header>`}
<main class="mx-auto max-w-7xl px-4 py-8 sm:px-6"><h1 class="mb-6 text-3xl font-bold tracking-tight text-slate-900">${esc(title)}</h1>${body}</main></body></html>`;

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
  app.use(express.urlencoded({ extended: false, limit: "5mb" }));
  app.use(express.static("public", { index: false }));

  const unsubscribe = async (req: Request, res: Response, email: string | undefined) => {
    if (!email) return res.status(404).send(page("Invalid unsubscribe link", "<p>This link could not be found. Please contact the sender to opt out.</p>", true));
    if (req.method === "GET") return res.send(page("Unsubscribe", `<div class="card"><p>Stop future outreach to ${esc(email)}?</p><form method="post"><button class="mt-4">Unsubscribe</button></form></div>`, true));
    await suppressEmail(email, "unsubscribe");
    return res.send(page("Unsubscribed", "<div class=\"card\"><p>Your address has been removed from future outreach.</p></div>", true));
  };
  const legacyUnsub = async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || !safeEqual(String(req.params.token), unsubToken(id))) return res.status(400).send("Invalid link");
    const [l] = await q("SELECT email FROM leads WHERE id=$1", [id]);
    return unsubscribe(req, res, l?.email);
  };
  app.get("/unsubscribe/:id/:token", legacyUnsub);
  app.post("/unsubscribe/:id/:token", legacyUnsub);
  const recipientUnsub = async (req: Request, res: Response) => {
    const token = req.params.token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(400).send("Invalid link");
    const [link] = await q<{ email: string }>("SELECT email FROM unsubscribe_links WHERE token=$1", [token]);
    return unsubscribe(req, res, link?.email);
  };
  app.get("/unsubscribe-link/:token", recipientUnsub);
  app.post("/unsubscribe-link/:token", recipientUnsub);

  // Twilio inbound webhook: STOP/START handling and reply tracking. Authenticated by Twilio's request signature.
  app.post("/sms/inbound", async (req, res) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) if (typeof v === "string") params[k] = v;
    const to = normalizePhone(params.To), from = normalizePhone(params.From);
    const [p] = to ? await q<SmsProfile>("SELECT * FROM sender_profiles WHERE sms_from=$1 LIMIT 1", [to]) : [];
    if (!p?.twilio_auth_token_enc) return res.status(404).send("Unknown number");
    const url = `${config.publicUrl}${req.originalUrl}`;
    if (!validTwilioSignature(decrypt(p.twilio_auth_token_enc), url, params, req.get("X-Twilio-Signature"))) return res.status(403).send("Invalid signature");
    if (from) {
      const kind = classifyInboundSms(params.Body ?? "");
      const leads = await q<{ id: number }>("SELECT id FROM leads WHERE sms_phone=$1", [from]);
      if (kind === "opt_out") await suppressPhone(from, "replied STOP");
      else if (kind === "opt_in") {
        await withPhoneLock(from, async (c) => {
          const removed = await c.query("DELETE FROM sms_suppression WHERE phone=$1", [from]);
          if (removed.rowCount) await c.query("UPDATE leads SET sms_consent_at=now(), sms_consent_source='Re-subscribed by texting START' WHERE sms_phone=$1", [from]);
        });
      } else if (kind === "reply") {
        await q("UPDATE leads SET status='replied' WHERE sms_phone=$1 AND status NOT IN ('unsubscribed')", [from]);
        await q("UPDATE drafts SET status='rejected', error='lead replied by text' WHERE channel='sms' AND status IN ('pending','approved') AND lead_id IN (SELECT id FROM leads WHERE sms_phone=$1)", [from]);
      }
      for (const l of leads) await q("INSERT INTO events(lead_id,type,detail) VALUES($1,$2,$3)", [l.id, `sms_${kind}`, JSON.stringify({ body: String(params.Body ?? "").slice(0, 1000) })]);
    }
    // Twilio's built-in Advanced Opt-Out sends the STOP/START/HELP confirmations, so reply with empty TwiML.
    res.type("text/xml").send("<Response></Response>");
  });

  app.use(auth);

  app.get("/", async (_req, res) => {
    const stats = await q("SELECT status, count(*)::int n FROM leads GROUP BY status ORDER BY status");
    const dr = await q("SELECT status, count(*)::int n FROM drafts GROUP BY status ORDER BY status");
    const [active] = await q<Profile>("SELECT * FROM sender_profiles WHERE active LIMIT 1");
    const count = (rows: { n: number }[]) => rows.reduce((total, row) => total + row.n, 0);
    const row = (r: any) => `<tr><td>${esc(r.status)}</td><td>${r.n}</td></tr>`;
    res.send(page("Dashboard", `
      <p class="mb-6 text-slate-600">Find prospects, review messages, and manage your outreach from one place.</p>
      <div class="grid gap-4 sm:grid-cols-3">
        <div class="card"><p class="text-sm text-slate-500">Saved leads</p><p class="mt-2 text-3xl font-bold">${count(stats)}</p><a href="/leads" class="text-sm">View leads</a></div>
        <div class="card"><p class="text-sm text-slate-500">Drafts awaiting review</p><p class="mt-2 text-3xl font-bold">${dr.find((r: any) => r.status === "pending")?.n ?? 0}</p><a href="/drafts" class="text-sm">Review drafts</a></div>
        <div class="card"><p class="text-sm text-slate-500">Active sender</p><p class="mt-2 font-semibold">${esc(active?.business_name ?? "Not configured")}</p>${active && commercialProfileError(active) ? `<p class="mt-1 text-sm text-amber-700">Sending blocked: ${esc(commercialProfileError(active))}</p>` : ""}<a href="/settings" class="text-sm">Configure sender</a></div>
      </div>
      <div class="grid items-start gap-4 lg:grid-cols-2"><div class=card><h3>Find leads</h3><p class="mt-1 text-sm text-slate-500">Search for local businesses by category and city.</p><form method=post action=/search>
      <label for="category">Category (e.g. plumber)</label><input id="category" name=category required>
      <label for="city">City (e.g. Raleigh, NC)</label><input id="city" name=city required>
      <label for="source">Source</label><select id="source" name=source><option value=osm>OpenStreetMap (free)</option><option value=google>Google Places (needs API key)</option></select>
      <p><button>Search &amp; audit</button></p></form></div>
      <div class=card><h3>Import CSV</h3><form method=post action=/import>
      <label for="csv">Paste CSV with header row: name, website, email, phone, category, city</label><textarea id="csv" name=csv rows=5 required></textarea>
      <p><button>Import &amp; audit</button></p></form></div></div>
      <div class="grid gap-4 lg:grid-cols-2"><div class="card"><h3>Lead status</h3><table>${stats.map(row).join("")}</table></div><div class="card"><h3>Draft status</h3><table>${dr.map(row).join("")}</table></div></div>`));
  });

  app.post("/search", async (req, res) => {
    try {
      const source = req.body.source === "google" ? "google" : "osm";
      const search = source === "google" ? searchPlaces : searchOsm;
      const category = String(req.body.category), city = String(req.body.city);
      if (!category.trim() || !city.trim() || category === "undefined" || city === "undefined") throw new Error("Category and city are required");
      const [{ generation }] = await q<{ generation: string }>("SELECT nextval('lead_search_generation_seq') AS generation");
      const { placeIds } = await search(category, city);
      await processNewLeads(40, placeIds);
      await draftQualified(40, placeIds);
      await q(
        `INSERT INTO latest_lead_search(singleton, category, city, source, place_ids, generation) VALUES(TRUE,$1,$2,$3,$4,$5)
         ON CONFLICT (singleton) DO UPDATE SET category=EXCLUDED.category, city=EXCLUDED.city,
         source=EXCLUDED.source, place_ids=EXCLUDED.place_ids, generation=EXCLUDED.generation
         WHERE latest_lead_search.generation < EXCLUDED.generation`,
        [category, city, source, placeIds, generation],
      );
      res.redirect("/leads");
    } catch (e: any) { res.status(500).send(page("Search failed", `<div class="card"><p>${esc(e.message)}</p><p class="mt-4">For an existing installation, run <code>npm run migrate</code> and restart the app. Your previous results have not been replaced.</p><a href="/">Back to dashboard</a></div>`)); }
  });

  app.post("/import", async (req, res) => {
    try {
      await importCsv(String(req.body.csv));
      await processNewLeads(100);
      await draftQualified(100);
      res.redirect("/drafts");
    } catch (e: any) { res.status(500).send(page("Error", `<pre>${esc(e.message)}</pre>`)); }
  });

  app.get("/leads", async (req, res) => {
    let latest: { category: string; city: string; source: string; place_ids: string[] } | undefined;
    try {
      [latest] = await q<{ category: string; city: string; source: string; place_ids: string[] }>(
        "SELECT category, city, source, place_ids FROM latest_lead_search WHERE singleton=TRUE",
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "42P01") {
        return res.status(503).send(page("Database migration required", "<p>Run <code>npm run migrate</code> and restart the app to view search results.</p>"));
      }
      throw error;
    }
    const showAll = req.query.view === "all" || !latest;
    const rows = showAll
      ? await q("SELECT l.*, EXISTS (SELECT 1 FROM drafts d WHERE d.lead_id=l.id AND d.status='pending' AND d.channel='email') AND l.email IS NOT NULL AND trim(l.email) <> '' AND l.status NOT IN ('unsubscribed','replied') AND NOT EXISTS (SELECT 1 FROM suppression s WHERE lower(trim(s.email))=lower(trim(l.email))) AS has_pending FROM leads l ORDER BY l.id DESC LIMIT 200")
      : await q("SELECT l.*, EXISTS (SELECT 1 FROM drafts d WHERE d.lead_id=l.id AND d.status='pending' AND d.channel='email') AND l.email IS NOT NULL AND trim(l.email) <> '' AND l.status NOT IN ('unsubscribed','replied') AND NOT EXISTS (SELECT 1 FROM suppression s WHERE lower(trim(s.email))=lower(trim(l.email))) AS has_pending FROM leads l WHERE l.place_id = ANY($1::text[]) ORDER BY array_position($1::text[], l.place_id) LIMIT 200", [latest.place_ids]);
    const heading = showAll
      ? `<p>Showing all saved leads (up to 200 most recent).${latest ? " <a href=/leads>Latest search</a>" : ""}</p>`
      : `<p>Latest search: ${esc(latest.category)} in ${esc(latest.city)} (${latest.source === "google" ? "Google Places" : "OpenStreetMap"}). <a href="/leads?view=all">All saved leads</a> · <a href="/calls">Call list</a></p>`;
    res.send(page("Leads", `<div class="card">${heading}<p class="my-4 text-sm text-slate-600">Select leads with pending drafts, then review their messages individually. Selection does not send emails or pause previously approved drafts.</p>${rows.length ? `<form method="get" action="/drafts" id="lead-selection">
      <input type="hidden" name="selected" value="1"><div class="mb-4 flex flex-wrap items-center gap-4"><button class="button" type="submit">Review selected drafts</button><span id="selection-count" aria-live="polite">0 selected</span><a href="/drafts">View all drafts</a></div>
      <div class="overflow-x-auto"><table><thead><tr><th><label class="sr-only" for="select-all">Select all eligible visible leads</label><input id="select-all" type="checkbox"></th><th>Name</th><th>Website</th><th>Phone</th><th>Email</th><th>Status</th><th>Findings</th><th>Text</th></tr></thead><tbody>${rows.map((l) =>
      `<tr><td><input type="checkbox" name="lead" value="${l.id}" aria-label="Select ${esc(l.name)}"${l.has_pending ? "" : " disabled"}></td><td>${esc(l.name)}</td><td>${esc(l.website ?? "none")}</td><td>${esc(l.phone ?? "")}</td><td>${esc(l.email)}</td><td>${esc(l.status)}${l.has_pending ? "" : " · not eligible for review"}</td>
       <td>${(l.site_findings ?? []).map((f: any) => `<span class=tag title="${esc(f.evidence)}">${esc(f.type)}</span>`).join("")}</td>
       <td><a href="/leads/${l.id}/sms">${l.sms_consent_at ? "Consented · text" : "Record consent"}</a></td></tr>`).join("")}</tbody></table></div></form>
      <script src="/selection.js" defer></script>` : "<p>No leads found.</p>"}</div>`));
  });

  app.get("/drafts", async (req, res) => {
    const raw = req.query.lead;
    const values = raw === undefined ? undefined : Array.isArray(raw) ? raw : [raw];
    if (req.query.selected && !values) return res.status(400).send(page("No leads selected", '<p>Select at least one lead with a pending draft. <a href="/leads">Return to leads</a></p>'));
    if (values && (!values.length || values.length > 200 || values.some((v) => typeof v !== "string" || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > 2147483647))) {
      return res.status(400).send(page("Invalid selection", "<p>Select valid leads from the Leads screen.</p>"));
    }
    const ids = values?.map(Number);
    const rows = await q(`SELECT d.*, l.name, l.email, l.website FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.status='pending' AND d.channel='email'${ids ? " AND l.id = ANY($1::int[])" : ""} ORDER BY d.id LIMIT 50`, ids ? [ids] : []);
    const smsRows = ids ? [] : await q("SELECT d.*, l.name, l.sms_phone, l.sms_consent_source FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.status='pending' AND d.channel='sms' ORDER BY d.id LIMIT 50");
    const [smsSender] = await q<SmsProfile>("SELECT * FROM sender_profiles WHERE active LIMIT 1");
    const failed = ids ? [] : await q<{ id: number; name: string; error: string | null; channel: string }>("SELECT d.id, d.error, d.channel, l.name FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.status='failed' ORDER BY d.id DESC LIMIT 50");
    const selection = ids?.map((id) => `lead=${id}`).join("&") ?? "";
    res.send(page("Approval queue", `${ids ? `<p class="mb-4">Showing drafts for selected leads. <a href="/drafts">View all drafts</a></p>` : ""}<p class="mb-4 text-sm text-slate-600">Review sender identity, subject, and content for accuracy before approving. Approved drafts may be sent automatically.</p>${rows.length ? rows.map((d) => `<div class=card>
      <b>${esc(d.name)}</b> &lt;${esc(d.email)}&gt; &middot; ${esc(d.website ?? "no website")} &middot; step ${d.step}
      <ul>${(d.findings_used ?? []).map((f: any) => `<li><span class=tag>${esc(f.type)}</span>${esc(f.evidence)}</li>`).join("")}</ul>
      <form method=post action=/drafts/${d.id}><input type="hidden" name="selection" value="${esc(selection)}"><label for="subject-${d.id}">Subject</label><input id="subject-${d.id}" name=subject required value="${esc(d.subject)}">
      <label for="body-${d.id}">Body</label><textarea id="body-${d.id}" name=body rows=10 required>${esc(d.body)}</textarea>
      <p><button name=action value=approve>Approve</button><button name=action value=reject formnovalidate>Reject</button></p></form></div>`).join("") : "<p>Nothing pending for this selection.</p>"}
      ${smsRows.length ? `<section class="mt-8"><h2 class="text-xl font-semibold">Text messages</h2><p class="text-sm text-slate-600">Only leads with recorded consent appear here. The business name and "Reply STOP to opt out." are added automatically if missing.</p>${smsRows.map((d) => `<div class=card>
      <b>${esc(d.name)}</b> &middot; ${esc(d.sms_phone)} &middot; consent: ${esc(d.sms_consent_source)}
      <form method=post action=/sms-drafts/${d.id}><label for="sms-body-${d.id}">Message</label><textarea id="sms-body-${d.id}" name=body rows=4 maxlength=480 required>${esc(d.body)}</textarea>
      ${smsSender ? `<p class="text-sm text-slate-500">Will send as: ${esc(composeCommercialSms(smsSender, d.body))}</p>` : ""}
      <p><button name=action value=approve>Approve</button><button name=action value=reject formnovalidate>Reject</button></p></form></div>`).join("")}</section>` : ""}
      ${failed.length ? `<section class="mt-8"><h2 class="text-xl font-semibold">Failed sends</h2><p class="text-sm text-slate-600">These drafts were not marked sent. Delivery may be uncertain after an SMTP error; check with your provider before retrying.</p>${failed.map((d) => `<div class="card"><strong>${esc(d.name)}</strong> <span class=tag>${esc(d.channel)}</span><p role="alert" class="my-2 text-sm text-red-700">${esc(d.error ?? "Unknown sending error")}</p><form method="post" action="/drafts/${d.id}/retry"><button>Return to review</button></form></div>`).join("")}</section>` : ""}`));
  });

  app.post("/drafts/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647 || !["approve", "reject"].includes(req.body.action)) return res.status(400).send(page("Invalid action", "<p>Choose an available draft action.</p>"));
    if (req.body.action === "approve") {
      const subject = typeof req.body.subject === "string" ? req.body.subject.trim() : "";
      const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
      if (!subject || !body) return res.status(400).send(page("Cannot approve draft", "<p>Subject and body are required.</p>"));
      const [draft] = await q<{ email: string | null }>("SELECT l.email FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.id=$1 AND d.status='pending' AND d.channel='email'", [id]);
      if (!draft?.email) return res.status(400).send(page("Cannot approve draft", "<p>This draft has no eligible recipient.</p>"));
      const email = normalizeEmail(draft.email);
      const approved = await withEmailLock(email, async (client) => {
        const result = await client.query(
          `UPDATE drafts d SET status='approved', subject=$2, body=$3 FROM leads l
           WHERE d.id=$1 AND d.status='pending' AND d.channel='email' AND l.id=d.lead_id AND lower(trim(l.email))=$4
           AND l.status NOT IN ('unsubscribed','replied')
           AND NOT EXISTS (SELECT 1 FROM suppression s WHERE lower(trim(s.email))=$4) RETURNING d.id`,
          [id, subject, body, email]);
        return !!result.rowCount;
      });
      if (!approved) return res.status(400).send(page("Cannot approve draft", "<p>The draft is no longer pending or its recipient is suppressed or ineligible.</p>"));
    } else await q("UPDATE drafts SET status='rejected' WHERE id=$1 AND status='pending' AND channel='email'", [id]);
    const selection = typeof req.body.selection === "string" && /^(lead=[1-9]\d*)(?:&lead=[1-9]\d*)*$/.test(req.body.selection) ? `?${req.body.selection}` : "";
    res.redirect(`/drafts${selection}`);
  });
  app.post("/drafts/:id/retry", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) return res.status(400).send(page("Invalid draft", "<p>Choose an available draft.</p>"));
    const rows = await q("UPDATE drafts SET status='pending', error=NULL WHERE id=$1 AND status='failed' RETURNING id", [id]);
    if (!rows.length) return res.status(400).send(page("Cannot retry draft", "<p>This draft is not awaiting retry.</p>"));
    res.redirect("/drafts");
  });

  const leadId = (raw: unknown) => {
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
  };

  app.get("/leads/:id/sms", async (req, res) => {
    const id = leadId(req.params.id);
    const [l] = id ? await q("SELECT * FROM leads WHERE id=$1", [id]) : [];
    if (!l) return res.status(404).send(page("Lead not found", '<p><a href="/leads">Back to leads</a></p>'));
    const [p] = await q<SmsProfile & { cta_url: string | null }>("SELECT * FROM sender_profiles WHERE active LIMIT 1");
    const phone = l.sms_phone ?? normalizePhone(l.phone) ?? "";
    const suppressed = phone ? (await q("SELECT reason FROM sms_suppression WHERE phone=$1", [phone]))[0] : undefined;
    const msg = req.query.msg ? `<p role="status" class="mb-4">${esc(req.query.msg)}</p>` : "";
    const consentForm = `<form method=post action=/leads/${l.id}/sms/consent>
      <label for="sms-phone">Mobile number they gave you</label><input id="sms-phone" name=phone required value="${esc(phone)}">
      <label for="sms-source">How and when they agreed to texts (kept as your consent record)</label><textarea id="sms-source" name=source rows=3 required placeholder="e.g. Replied to our email on 11/20: 'text me at 704-555-1234'"></textarea>
      <label class="mt-4 flex gap-2"><input type=checkbox name=confirm value=yes required> <span>This person gave written agreement to receive marketing texts from ${esc(p?.business_name ?? "my business")} at this number. A phone number found in a directory or on a website is not consent.</span></label>
      <p class="mt-4"><button>Record consent</button></p></form>`;
    const draftForm = p ? `<form method=post action=/leads/${l.id}/sms/draft><label for="sms-draft">Text message</label>
      <textarea id="sms-draft" name=body rows=4 maxlength=480 required>${esc(defaultSmsBody({ fromName: p.from_name, businessName: p.business_name, leadName: l.name, ctaUrl: p.cta_url }))}</textarea>
      <p class="mt-4"><button>Add to approval queue</button></p></form>` : "<p>Set up an active sender profile first.</p>";
    res.send(page(`Text ${l.name}`, `${msg}<div class=card>
      <p><b>${esc(l.name)}</b> · listed phone: ${esc(l.phone ?? "none")}</p>
      ${p && smsProfileError(p) ? `<p role="alert" class="my-2 text-sm text-amber-700">Texting blocked: ${esc(smsProfileError(p))}</p>` : ""}
      ${suppressed ? `<p role="alert" class="my-2 text-red-700">${esc(phone)} is on the do-not-text list (${esc(suppressed.reason)}). It can only be re-enabled by the person texting START.</p>`
        : l.sms_consent_at ? `<p class="my-2">Consent recorded ${esc(new Date(l.sms_consent_at).toLocaleString("en-US"))} for ${esc(l.sms_phone)}: ${esc(l.sms_consent_source)}</p>
          ${draftForm}<form method=post action=/leads/${l.id}/sms/revoke class="mt-4"><button>Revoke consent and add to do-not-text list</button></form>`
        : consentForm}
      </div><p><a href="/leads">Back to leads</a></p>`));
  });

  app.post("/leads/:id/sms/consent", async (req, res) => {
    const id = leadId(req.params.id);
    const phone = normalizePhone(typeof req.body.phone === "string" ? req.body.phone : "");
    const source = typeof req.body.source === "string" ? req.body.source.trim() : "";
    if (!id || !phone || !source || req.body.confirm !== "yes") return res.status(400).send(page("Cannot record consent", "<p>A valid mobile number, a description of the consent, and the confirmation box are all required.</p>"));
    const ok = await withPhoneLock(phone, async (c) => {
      if ((await c.query("SELECT 1 FROM sms_suppression WHERE phone=$1", [phone])).rowCount) return false;
      return !!(await c.query("UPDATE leads SET sms_phone=$2, sms_consent_at=now(), sms_consent_source=$3 WHERE id=$1 AND status <> 'unsubscribed'", [id, phone, source.slice(0, 1000)])).rowCount;
    });
    if (!ok) return res.status(400).send(page("Cannot record consent", "<p>This number is on the do-not-text list or the lead has unsubscribed.</p>"));
    await q("INSERT INTO events(lead_id,type,detail) VALUES($1,'sms_consent',$2)", [id, JSON.stringify({ phone, source })]);
    res.redirect(`/leads/${id}/sms?msg=${encodeURIComponent("Consent recorded.")}`);
  });

  app.post("/leads/:id/sms/revoke", async (req, res) => {
    const id = leadId(req.params.id);
    const [l] = id ? await q("SELECT sms_phone FROM leads WHERE id=$1", [id]) : [];
    if (l?.sms_phone) await suppressPhone(l.sms_phone, "consent revoked by admin");
    res.redirect(`/leads/${id}/sms?msg=${encodeURIComponent("Consent revoked.")}`);
  });

  app.post("/leads/:id/sms/draft", async (req, res) => {
    const id = leadId(req.params.id);
    const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
    const error = smsBodyError(body);
    const [p] = await q<{ id: number }>("SELECT id FROM sender_profiles WHERE active LIMIT 1");
    if (!id || error || !p) return res.status(400).send(page("Cannot create text", `<p>${esc(error ?? "An active sender profile is required.")}</p>`));
    const rows = await q(`INSERT INTO drafts(lead_id,profile_id,channel,subject,body)
      SELECT l.id,$2,'sms','',$3 FROM leads l WHERE l.id=$1 AND l.sms_consent_at IS NOT NULL AND l.status <> 'unsubscribed'
      AND NOT EXISTS (SELECT 1 FROM sms_suppression s WHERE s.phone=l.sms_phone) RETURNING id`, [id, p.id, body]);
    if (!rows.length) return res.status(400).send(page("Cannot create text", "<p>This lead has no recorded SMS consent or has opted out.</p>"));
    res.redirect("/drafts");
  });

  app.post("/sms-drafts/:id", async (req, res) => {
    const id = leadId(req.params.id);
    if (!id || !["approve", "reject"].includes(req.body.action)) return res.status(400).send(page("Invalid action", "<p>Choose an available draft action.</p>"));
    if (req.body.action === "reject") {
      await q("UPDATE drafts SET status='rejected' WHERE id=$1 AND status='pending' AND channel='sms'", [id]);
      return res.redirect("/drafts");
    }
    const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
    const error = smsBodyError(body);
    if (error) return res.status(400).send(page("Cannot approve text", `<p>${esc(error)}</p>`));
    const [d] = await q<{ sms_phone: string | null }>("SELECT l.sms_phone FROM drafts d JOIN leads l ON l.id=d.lead_id WHERE d.id=$1 AND d.status='pending' AND d.channel='sms'", [id]);
    const phone = normalizePhone(d?.sms_phone);
    const approved = phone && await withPhoneLock(phone, async (c) => !!(await c.query(
      `UPDATE drafts d SET status='approved', body=$2 FROM leads l
       WHERE d.id=$1 AND d.status='pending' AND d.channel='sms' AND l.id=d.lead_id AND l.sms_phone=$3
       AND l.sms_consent_at IS NOT NULL AND l.status <> 'unsubscribed'
       AND NOT EXISTS (SELECT 1 FROM sms_suppression s WHERE s.phone=$3) RETURNING d.id`, [id, body, phone])).rowCount);
    if (!approved) return res.status(400).send(page("Cannot approve text", "<p>The draft is no longer pending, or the lead has no consent or has opted out.</p>"));
    res.redirect("/drafts");
  });

  app.get("/sms-suppression", async (req, res) => {
    const rows = await q<{ phone: string; reason: string }>("SELECT phone, reason FROM sms_suppression ORDER BY created_at DESC LIMIT 200");
    const message = req.query.msg ? `<p role="status">${esc(req.query.msg)}</p>` : "";
    res.send(page("Do not text", `<div class="card">${message}<p>Add a number when someone asks you to stop texting by phone, email, or any other way. You must honor these requests promptly.</p>
      <form method="post" action="/sms-suppression"><label for="sms-suppression-phone">Phone number</label><input id="sms-suppression-phone" name="phone" required><p class="mt-4"><button>Add to do-not-text list</button></p></form></div>
      <div class="card"><h3>Opted-out numbers</h3>${rows.length ? `<table><thead><tr><th>Phone</th><th>Reason</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.phone)}</td><td>${esc(r.reason)}</td></tr>`).join("")}</tbody></table>` : "<p>No opted-out numbers.</p>"}</div>`));
  });
  app.post("/sms-suppression", async (req, res) => {
    const phone = normalizePhone(typeof req.body.phone === "string" ? req.body.phone : "");
    if (!phone) return res.status(400).send(page("Invalid phone", "<p>Enter a valid phone number.</p>"));
    await suppressPhone(phone, "manual opt-out");
    res.redirect(`/sms-suppression?msg=${encodeURIComponent("Number added to the do-not-text list.")}`);
  });

  // Call list: weak-website leads with a phone number but no email found (usually no website at all).
  app.get("/calls", async (req, res) => {
    const rows = await q("SELECT * FROM leads WHERE status='call_first' ORDER BY id DESC LIMIT 200");
    const msg = req.query.msg ? `<p role="status" class="mb-4">${esc(req.query.msg)}</p>` : "";
    const tel = (p: string | null) => { const n = normalizePhone(p); return n ? `<a href="tel:${n}">${esc(p)}</a>` : esc(p); };
    res.send(page("Call list", `${msg}<p class="mb-4 text-slate-600">These businesses have a weak or missing website and no email address the bot could find, so a phone call or visit is the first touch. If they give you an email address, add it here to draft an email for your approval. If they agree to texts, record consent on the Text page.</p>
      ${rows.length ? rows.map((l) => `<div class=card>
        <p><b>${esc(l.name)}</b> · ${tel(l.phone)} · ${esc(l.category ?? "")}${l.city ? ` · ${esc(l.city)}` : ""} · ${esc(l.website ?? "no website")}</p>
        <p class="my-2">${(l.site_findings ?? []).map((f: any) => `<span class=tag title="${esc(f.evidence)}">${esc(f.type)}</span>`).join("")}</p>
        <form method=post action=/calls/${l.id}/email class="flex flex-wrap items-end gap-2"><div><label for="call-email-${l.id}">Email they gave you</label><input id="call-email-${l.id}" name=email type=email required></div><button>Save &amp; draft email</button></form>
        <p class="mt-2"><a href="/leads/${l.id}/sms">Record text consent</a></p>
        <form method=post action=/calls/${l.id}/decline class="mt-2"><button>Not interested: remove from list</button></form>
      </div>`).join("") : "<p>No leads waiting for a call.</p>"}`));
  });

  app.post("/calls/:id/email", async (req, res) => {
    const id = leadId(req.params.id);
    const email = typeof req.body.email === "string" ? normalizeEmail(req.body.email) : "";
    if (!id || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).send(page("Invalid email", '<p>Enter a valid email address. <a href="/calls">Back to call list</a></p>'));
    if ((await q("SELECT 1 FROM suppression WHERE lower(trim(email))=$1", [email])).length) {
      return res.status(400).send(page("Address opted out", '<p>This address is on the do-not-email list. <a href="/calls">Back to call list</a></p>'));
    }
    if (!(await hasMx(email))) return res.status(400).send(page("Email domain can't receive mail", '<p>That address\'s domain has no mail server. Double-check it with the business. <a href="/calls">Back to call list</a></p>'));
    const [lead] = await q<{ place_id: string }>(
      "UPDATE leads SET email=$2, email_verified=TRUE, status='qualified' WHERE id=$1 AND status='call_first' RETURNING place_id", [id, email]);
    if (!lead) return res.status(400).send(page("Lead not on call list", '<p><a href="/calls">Back to call list</a></p>'));
    await q("INSERT INTO events(lead_id,type,detail) VALUES($1,'email_collected',$2)", [id, JSON.stringify({ email })]);
    const drafted = await draftQualified(1, [lead.place_id]);
    res.redirect(drafted ? "/drafts" : `/calls?msg=${encodeURIComponent("Email saved. Set up an active sender profile to draft the email.")}`);
  });

  app.post("/calls/:id/decline", async (req, res) => {
    const id = leadId(req.params.id);
    if (id) {
      await q("UPDATE leads SET status='declined' WHERE id=$1 AND status='call_first'", [id]);
      await q("INSERT INTO events(lead_id,type) VALUES($1,'declined_by_phone')", [id]);
    }
    res.redirect(`/calls?msg=${encodeURIComponent("Removed from the call list.")}`);
  });

  app.get("/suppression", async (req, res) => {
    const rows = await q<{ email: string; reason: string }>("SELECT email, reason FROM suppression ORDER BY created_at DESC LIMIT 200");
    const message = req.query.msg ? `<p role="status">${esc(req.query.msg)}</p>` : "";
    res.send(page("Do not email", `<div class="card">${message}<p>Add an address when someone opts out by phone, email, or another channel. This blocks future outreach to that address.</p>
      <form method="post" action="/suppression"><label for="suppression-email">Email address</label><input id="suppression-email" name="email" type="email" required><p class="mt-4"><button>Add to do-not-email list</button></p></form></div>
      <div class="card"><h3>Recently suppressed addresses</h3>${rows.length ? `<div class="overflow-x-auto"><table><thead><tr><th>Email</th><th>Reason</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.email)}</td><td>${esc(r.reason)}</td></tr>`).join("")}</tbody></table></div>` : "<p>No suppressed addresses.</p>"}</div>`));
  });
  app.post("/suppression", async (req, res) => {
    const email = typeof req.body.email === "string" ? normalizeEmail(req.body.email) : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).send(page("Invalid email", "<p>Enter a valid email address.</p>"));
    await suppressEmail(email, "manual opt-out");
    res.redirect(`/suppression?msg=${encodeURIComponent("Address added to the do-not-email list.")}`);
  });

  app.get("/settings", async (req, res) => {
    const profiles = await q("SELECT * FROM sender_profiles ORDER BY id");
    const msg = req.query.msg ? `<div class=card><pre>${esc(req.query.msg)}</pre></div>` : "";
    const form = (p: any = {}) => {
      const prefix = p.id ? `profile-${p.id}` : "profile-new";
      const field = (n: string, label: string, v = "", type = "text") => `<label for="${prefix}-${n}">${label}</label><input id="${prefix}-${n}" name=${n} type=${type} value="${esc(v)}">`;
      return `<form method=post action=/settings${p.id ? `/${p.id}` : ""}><div class="grid gap-6 lg:grid-cols-2"><fieldset><legend class="mt-4 font-semibold text-slate-900">Sender identity</legend>
      ${field("name", "Profile name", p.name)}${field("from_name", "From name", p.from_name)}${field("from_email", "From email", p.from_email, "email")}${field("reply_to", "Reply-to (optional)", p.reply_to)}
      ${field("business_name", "Business name", p.business_name)}${field("mailing_address", "Physical mailing address (required by CAN-SPAM)", p.mailing_address)}
      <label for="${prefix}-offer">Your offer (used in emails)</label><textarea id="${prefix}-offer" name=offer rows=3>${esc(p.offer)}</textarea>${field("cta_url", "Call-to-action URL", p.cta_url)}
      <label for="${prefix}-signature">Signature</label><textarea id="${prefix}-signature" name=signature rows=3>${esc(p.signature)}</textarea></fieldset>
      <fieldset><legend class="mt-4 font-semibold text-slate-900">Delivery and schedule</legend>
      ${field("smtp_host", "SMTP host", p.smtp_host)}${field("smtp_port", "SMTP port", p.smtp_port ?? 587, "number")}${field("smtp_user", "SMTP user", p.smtp_user)}
      <label for="${prefix}-smtp_pass">SMTP password ${p.id ? "(leave blank to keep)" : ""}</label><input id="${prefix}-smtp_pass" name=smtp_pass type=password autocomplete=new-password>
      ${field("imap_host", "IMAP host (for reply detection)", p.imap_host)}${field("imap_port", "IMAP port", p.imap_port ?? 993, "number")}${field("imap_user", "IMAP user", p.imap_user)}
      <label for="${prefix}-imap_pass">IMAP password ${p.id ? "(leave blank to keep)" : ""}</label><input id="${prefix}-imap_pass" name=imap_pass type=password autocomplete=new-password>
      ${field("daily_cap", "Daily send cap", p.daily_cap ?? 20, "number")}${field("send_start_hour", "Send window start hour (0-23)", p.send_start_hour ?? 9, "number")}
      ${field("send_end_hour", "Send window end hour (0-23)", p.send_end_hour ?? 17, "number")}${field("timezone", "Timezone (IANA)", p.timezone ?? "America/New_York")}
      </fieldset><fieldset><legend class="mt-4 font-semibold text-slate-900">Text messages (Twilio, optional)</legend>
      <p class="text-sm text-slate-500">Texts go only to leads with recorded consent. Set the number's incoming-message webhook in Twilio to ${esc(config.publicUrl)}/sms/inbound (HTTP POST).</p>
      ${field("twilio_account_sid", "Twilio Account SID", p.twilio_account_sid)}
      <label for="${prefix}-twilio_auth_token">Twilio Auth Token ${p.id ? "(leave blank to keep)" : ""}</label><input id="${prefix}-twilio_auth_token" name=twilio_auth_token type=password autocomplete=new-password>
      ${field("sms_from", "Twilio phone number (E.164, e.g. +17045551234)", p.sms_from)}${field("sms_daily_cap", "Daily text cap", p.sms_daily_cap ?? 20, "number")}
      </fieldset></div><p class="mt-4"><button>Save</button></p></form>`;
    };
    const list = profiles.map((p) => `<div class=card><b>${esc(p.name)}</b> ${p.active ? "(ACTIVE)" : ""}${commercialProfileError(p) ? `<p role="alert" class="my-2 text-sm text-amber-700">Commercial sending blocked: ${esc(commercialProfileError(p))}. Configuration checks do not verify public reachability.</p>` : ""}
      <form method=post action=/settings/${p.id}/activate style=display:inline><button>Make active</button></form>
      <form method=post action=/settings/${p.id}/verify style=display:inline><button>Verify SMTP/IMAP/DNS</button></form>
      <form method=post action=/settings/${p.id}/test style=display:inline><input name=to placeholder="send test to..." style="width:200px"><button>Send test</button></form>
      <form method=post action=/settings/${p.id}/test-sms style=display:inline><input name=to placeholder="your own mobile" style="width:200px"><button>Send test text</button></form>
      ${p.twilio_account_sid && smsProfileError(p) ? `<p role="alert" class="my-2 text-sm text-amber-700">Texting blocked: ${esc(smsProfileError(p))}</p>` : ""}
      <details><summary>Edit</summary>${form(p)}</details></div>`).join("");
    res.send(page("Sender settings", `${msg}${list}<div class=card><h3>New profile</h3>${form()}</div>`));
  });

  const redirectMsg = (res: Response, m: string) => res.redirect(`/settings?msg=${encodeURIComponent(m)}`);

  async function saveProfile(req: Request, res: Response) {
    const b = req.body, id = req.params.id ? Number(req.params.id) : null;
    const prev = id ? (await q("SELECT smtp_pass_enc, imap_pass_enc, twilio_auth_token_enc FROM sender_profiles WHERE id=$1", [id]))[0] : null;
    const twilioToken = b.twilio_auth_token ? encrypt(String(b.twilio_auth_token).trim()) : prev?.twilio_auth_token_enc ?? null;
    const smsFrom = b.sms_from?.trim() ? normalizePhone(b.sms_from) : null;
    if (b.sms_from?.trim() && !smsFrom) return redirectMsg(res, "Twilio phone number is not a valid phone number");
    const smtpPass = b.smtp_pass ? encrypt(b.smtp_pass) : prev?.smtp_pass_enc;
    const imapPass = b.imap_pass ? encrypt(b.imap_pass) : prev?.imap_pass_enc ?? null;
    if (!smtpPass) return redirectMsg(res, "SMTP password required");
    if (!b.mailing_address?.trim()) return redirectMsg(res, "Mailing address required (CAN-SPAM)");
    const vals = [b.name, b.from_name, b.from_email, b.reply_to || null, b.smtp_host, +b.smtp_port, b.smtp_user, smtpPass,
      b.imap_host || null, +b.imap_port || 993, b.imap_user || null, imapPass, b.signature ?? "", b.business_name, b.mailing_address, b.offer ?? "", b.cta_url || null,
      +b.daily_cap || 20, +b.send_start_hour, +b.send_end_hour, b.timezone,
      b.twilio_account_sid?.trim() || null, twilioToken, smsFrom, +b.sms_daily_cap || 20];
    const cols = ["name", "from_name", "from_email", "reply_to", "smtp_host", "smtp_port", "smtp_user", "smtp_pass_enc", "imap_host", "imap_port", "imap_user", "imap_pass_enc", "signature", "business_name", "mailing_address", "offer", "cta_url", "daily_cap", "send_start_hour", "send_end_hour", "timezone", "twilio_account_sid", "twilio_auth_token_enc", "sms_from", "sms_daily_cap"];
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

  app.post("/settings/:id/test-sms", async (req, res) => {
    const p = (await q<SmsProfile>("SELECT * FROM sender_profiles WHERE id=$1", [Number(req.params.id)]))[0];
    const to = normalizePhone(typeof req.body.to === "string" ? req.body.to : "");
    if (!p || !to) return redirectMsg(res, "Profile and a valid phone number required");
    const err = smsProfileError(p);
    if (err) return redirectMsg(res, `Texting blocked: ${err}`);
    try { redirectMsg(res, `Sent test text ${await twilioSend(p, to, "Test from outreach bot. This is a configuration test, not a marketing message.")}`); }
    catch (e: any) { redirectMsg(res, `Failed: ${e.message}`); }
  });

  return app;
}

export { checkDns };
