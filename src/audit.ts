import * as cheerio from "cheerio";

export type FindingType =
  | "no_website" | "unreachable" | "no_https" | "not_mobile" | "slow" | "outdated"
  | "no_cta" | "no_seo" | "builder_default" | "social_only";

export interface Finding {
  type: FindingType;
  severity: number; // 1-10
  evidence: string;
}

const SOCIAL = /(facebook|instagram|linktr\.ee|yelp|yellowpages|twitter|x)\.com|linktr\.ee/i;

export function analyzeHtml(html: string, url: string, loadMs: number): Finding[] {
  const out: Finding[] = [];
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ").trim();

  if (!url.startsWith("https://"))
    out.push({ type: "no_https", severity: 8, evidence: "Site is served over HTTP, so browsers label it 'Not Secure'" });
  if (!$('meta[name="viewport"]').length)
    out.push({ type: "not_mobile", severity: 9, evidence: "No mobile viewport setting, so it likely doesn't display well on phones" });
  if (loadMs > 4000)
    out.push({ type: "slow", severity: 6, evidence: `Homepage took about ${(loadMs / 1000).toFixed(1)}s to load` });

  const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => +m[1]);
  const latest = years.length ? Math.max(...years) : 0;
  const nowYear = new Date().getFullYear();
  const legacy = $("table").length > 5 && $("div").length < 5;
  const oldTags = $("font, marquee, center, blink").length > 0;
  if ((latest && nowYear - latest >= 3) || legacy || oldTags)
    out.push({
      type: "outdated",
      severity: 6,
      evidence: latest && nowYear - latest >= 3 ? `Footer copyright still says ${latest}` : "Uses old-style page layout/markup",
    });

  const hasForm = $("form").length > 0;
  const hasTel = $('a[href^="tel:"]').length > 0;
  if (!hasForm && !hasTel)
    out.push({ type: "no_cta", severity: 5, evidence: "No contact form or tap-to-call link on the homepage" });

  const title = $("title").text().trim();
  const desc = $('meta[name="description"]').attr("content")?.trim();
  if (!title || !desc || !$("h1").length)
    out.push({ type: "no_seo", severity: 4, evidence: `Missing ${[!title && "page title", !desc && "meta description", !$("h1").length && "H1 heading"].filter(Boolean).join(", ")}` });

  if (/coming soon|under construction|this domain is for sale|buy this domain|parked/i.test(text.slice(0, 2000)) || text.length < 80)
    out.push({ type: "builder_default", severity: 9, evidence: "Page looks like a placeholder, parked or nearly empty" });

  return out.sort((a, b) => b.severity - a.severity);
}

export async function auditWebsite(website: string | null): Promise<Finding[]> {
  if (!website) return [{ type: "no_website", severity: 10, evidence: "No website listed on the Google business profile" }];
  if (SOCIAL.test(website))
    return [{ type: "social_only", severity: 9, evidence: "Only a social media/directory page is listed instead of its own website" }];
  const url = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (compatible; SiteCheck/1.0)" } });
    const loadMs = Date.now() - start;
    if (!res.ok) return [{ type: "unreachable", severity: 10, evidence: `Website returned HTTP ${res.status}` }];
    return analyzeHtml(await res.text(), res.url, loadMs);
  } catch (e: any) {
    // Retry over http to distinguish a bad certificate from a dead site
    if (url.startsWith("https://")) {
      try {
        await fetch(url.replace("https://", "http://"), { signal: AbortSignal.timeout(10000) });
        return [{ type: "no_https", severity: 9, evidence: "HTTPS connection fails (invalid or missing SSL certificate)" }];
      } catch {}
    }
    return [{ type: "unreachable", severity: 10, evidence: "Website could not be reached" }];
  }
}

export const isWeak = (f: Finding[]) => f.some((x) => x.severity >= 6) || f.length >= 3;
