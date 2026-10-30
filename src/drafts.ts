import type { Finding } from "./audit.js";
import { config } from "./config.js";

export interface DraftContext {
  businessName: string;
  category?: string | null;
  city?: string | null;
  findings: Finding[];
  sender: { from_name: string; business_name: string; offer: string; cta_url?: string | null; signature: string };
}

export interface Draft { subject: string; body: string; findings: Finding[] }

export const pickFindings = (f: Finding[]) => [...f].sort((a, b) => b.severity - a.severity).slice(0, 3);

// Plain-language pitch fragment per finding type, used by fallback template and prompt hints
const HOOKS: Record<Finding["type"], string> = {
  no_website: "I noticed {biz} doesn't have a website listed, so customers searching online can't find you easily.",
  social_only: "I noticed {biz} only has a social/directory page listed rather than its own website.",
  unreachable: "I tried visiting {biz}'s website and it isn't loading right now.",
  builder_default: "I visited {biz}'s website and it looks like a placeholder or unfinished page.",
  no_https: "{biz}'s website shows a 'Not Secure' warning in browsers, which can scare visitors off.",
  not_mobile: "{biz}'s website doesn't appear to be set up for phones, where most local searches happen.",
  slow: "{biz}'s homepage is slow to load, and visitors tend to leave when that happens.",
  outdated: "{biz}'s website looks a bit dated compared to what customers expect today.",
  no_cta: "{biz}'s homepage has no easy contact form or tap-to-call button.",
  no_seo: "{biz}'s website is missing basic search basics (titles/descriptions), which hurts Google visibility.",
};

export function templateDraft(ctx: DraftContext): Draft {
  const findings = pickFindings(ctx.findings);
  const hooks = findings.map((f) => HOOKS[f.type].replaceAll("{biz}", ctx.businessName));
  const lead = hooks.length ? hooks.join(" ") : `I came across ${ctx.businessName} and wanted to reach out.`;
  const subject = findings[0]?.type === "no_website" || findings[0]?.type === "social_only"
    ? `A website for ${ctx.businessName}?`
    : `Quick note about ${ctx.businessName}'s website`;
  const body = [
    "Hi there,",
    "",
    lead,
    "",
    `${ctx.sender.offer || `At ${ctx.sender.business_name} we build fast, mobile-friendly landing pages and host them for you.`}`,
    ctx.sender.cta_url ? `Take a look: ${ctx.sender.cta_url}` : "Happy to send a free mockup if that's useful - just reply.",
    "",
    ctx.sender.signature || ctx.sender.from_name,
  ].join("\n");
  return { subject, body, findings };
}

export function buildPrompt(ctx: DraftContext): string {
  const findings = pickFindings(ctx.findings);
  return `You write short, friendly, honest cold emails for ${ctx.sender.business_name}, which sells website hosting and landing pages.
Write to the owner of "${ctx.businessName}"${ctx.category ? ` (${ctx.category})` : ""}${ctx.city ? ` in ${ctx.city}` : ""}.

VERIFIED observations about their current web presence (mention ONLY these, no other claims about their site):
${findings.map((f, i) => `${i + 1}. ${f.evidence}`).join("\n")}

Our offer: ${ctx.sender.offer || "Fast mobile-friendly landing pages with hosting included."}
${ctx.sender.cta_url ? `Call to action link: ${ctx.sender.cta_url}` : "Call to action: invite them to reply for a free mockup."}

Rules: under 120 words, no hype, no fake compliments, no made-up statistics or prices, no placeholders like [Name]. Do not include a signature, footer or unsubscribe text.
Respond with JSON only: {"subject": "...", "body": "..."}`;
}

const BANNED = /\[[^\]]+\]|{{|lorem|guarantee(d)?|100%|act now|free money|#1|best in/i;

// Rejects drafts that invent facts about the site beyond the provided findings
export function validateDraft(d: { subject: string; body: string }, ctx: DraftContext): string | null {
  const text = `${d.subject}\n${d.body}`;
  if (!d.subject?.trim() || !d.body?.trim()) return "empty";
  if (d.subject.length > 90) return "subject too long";
  if (d.body.split(/\s+/).length > 200) return "body too long";
  if (BANNED.test(text)) return "banned phrase or placeholder";
  const types = new Set(ctx.findings.map((f) => f.type));
  const claims: [RegExp, FindingTypeSet][] = [
    [/\bnot secure|ssl|https|insecure\b/i, "no_https"],
    [/\bmobile|phone|responsive\b/i, "not_mobile"],
    [/\bslow|load(s|ing)? time|speed\b/i, "slow"],
    [/\bdated|outdated|old[- ]fashioned\b/i, "outdated"],
    [/\bseo|google ranking|search engine\b/i, "no_seo"],
    [/\b(isn'?t|not) loading|down|broken|unreachable\b/i, "unreachable"],
  ];
  for (const [re, t] of claims) if (re.test(text) && !types.has(t)) {
    // Mobile/phone words are also allowed in generic offer text if the offer itself says so
    if (re.test(ctx.sender.offer) || re.test(ctx.sender.cta_url ?? "")) continue;
    return `claims about "${t}" not supported by findings`;
  }
  return null;
}
type FindingTypeSet = Finding["type"];

export async function generateDraft(ctx: DraftContext, llm: (prompt: string) => Promise<string> = ollama): Promise<Draft & { usedFallback: boolean }> {
  const findings = pickFindings(ctx.findings);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await llm(buildPrompt(ctx));
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      const d = { subject: String(parsed.subject ?? ""), body: String(parsed.body ?? "").trim() };
      if (!validateDraft(d, ctx)) {
        const sig = ctx.sender.signature || ctx.sender.from_name;
        return { subject: d.subject.trim(), body: `${d.body}\n\n${sig}`, findings, usedFallback: false };
      }
    } catch {}
  }
  return { ...templateDraft(ctx), usedFallback: true };
}

export async function ollama(prompt: string): Promise<string> {
  const res = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.ollamaModel, prompt, stream: false, format: "json", options: { temperature: 0.4 } }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return ((await res.json()) as { response: string }).response;
}
