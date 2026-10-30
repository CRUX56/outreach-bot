import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import { config } from "./config.js";
import { q } from "./db.js";
import { auditWebsite, isWeak } from "./audit.js";

export async function searchPlaces(category: string, city: string, max = 40) {
  if (!config.placesKey) throw new Error("GOOGLE_PLACES_API_KEY not set");
  const places: any[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": config.placesKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.websiteUri,places.nationalPhoneNumber,places.rating,nextPageToken",
      },
      body: JSON.stringify({ textQuery: `${category} in ${city}`, pageSize: 20, ...(pageToken && { pageToken }) }),
    });
    if (!res.ok) throw new Error(`Places API ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    places.push(...(j.places ?? []));
    pageToken = j.nextPageToken;
  } while (pageToken && places.length < max);

  let added = 0;
  for (const p of places.slice(0, max)) {
    const r = await q(
      `INSERT INTO leads(place_id,name,category,city,phone,website,rating) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (place_id) DO NOTHING RETURNING id`,
      [p.id, p.displayName?.text ?? "Unknown", category, city, p.nationalPhoneNumber ?? null, p.websiteUri ?? null, p.rating ?? null],
    );
    added += r.length;
  }
  return { found: places.length, added };
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK = /\.(png|jpe?g|gif|svg|webp|css|js)$|sentry|wixpress|example\.|domain\.com|your(email|name)/i;

export async function findEmail(website: string | null): Promise<string | null> {
  if (!website) return null;
  const base = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  const host = new URL(base).hostname.replace(/^www\./, "");
  const pages = [base, new URL("/contact", base).href, new URL("/contact-us", base).href];
  const found = new Set<string>();
  for (const p of pages) {
    try {
      const res = await fetch(p, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "Mozilla/5.0 (compatible; SiteCheck/1.0)" } });
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);
      $('a[href^="mailto:"]').each((_, a) => { found.add(($(a).attr("href") ?? "").replace(/^mailto:/i, "").split("?")[0].toLowerCase()); });
      for (const m of $("body").text().match(EMAIL_RE) ?? []) found.add(m.toLowerCase());
    } catch {}
  }
  const list = [...found].filter((e) => EMAIL_RE.test(e) && !JUNK.test(e));
  EMAIL_RE.lastIndex = 0;
  // Prefer an address on the business's own domain
  return list.find((e) => e.endsWith(`@${host}`)) ?? list[0] ?? null;
}

export async function hasMx(email: string): Promise<boolean> {
  try { return (await dns.resolveMx(email.split("@")[1])).length > 0; } catch { return false; }
}

// Audits new leads, then finds and MX-checks emails for the weak ones
export async function processNewLeads(limit = 25) {
  const leads = await q("SELECT id, website FROM leads WHERE status='new' LIMIT $1", [limit]);
  for (const l of leads) {
    const findings = await auditWebsite(l.website);
    const weak = isWeak(findings);
    let email: string | null = null;
    let verified = false;
    if (weak) {
      email = await findEmail(l.website);
      verified = email ? await hasMx(email) : false;
    }
    const sup = email ? await q("SELECT 1 FROM suppression WHERE email=$1", [email]) : [];
    const status = !weak ? "disqualified" : email && verified && !sup.length ? "qualified" : "disqualified";
    await q(
      "UPDATE leads SET site_findings=$1, email=$2, email_verified=$3, status=$4, audited_at=now() WHERE id=$5",
      [JSON.stringify(findings), email, verified, status, l.id],
    );
  }
  return leads.length;
}
