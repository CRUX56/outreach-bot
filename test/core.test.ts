import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHtml, auditWebsite, isWeak } from "../src/audit.js";
import { generateDraft, validateDraft, templateDraft, type DraftContext } from "../src/drafts.js";

const weakHtml = `<html><head></head><body><table></table><p>© 2015 Joe's Plumbing</p>Welcome to our site, we do plumbing and have done so for many years in town.</body></html>`;

test("flags weak site issues", () => {
  const f = analyzeHtml(weakHtml, "http://joes.com", 6000);
  const types = f.map((x) => x.type);
  for (const t of ["no_https", "not_mobile", "slow", "outdated", "no_cta", "no_seo"]) assert.ok(types.includes(t as any), t);
  assert.ok(isWeak(f));
});

test("good site has no major findings", () => {
  const html = `<html><head><title>Joe</title><meta name="viewport" content="width=device-width"><meta name="description" content="x"></head>
  <body><h1>Joe</h1><a href="tel:555">Call</a><p>${"words ".repeat(40)}</p></body></html>`;
  assert.deepEqual(analyzeHtml(html, "https://joes.com", 800), []);
});

test("no website is a top finding", async () => {
  const f = await auditWebsite(null);
  assert.equal(f[0].type, "no_website");
});

const ctx = (findings: DraftContext["findings"]): DraftContext => ({
  businessName: "Joe's Plumbing", findings,
  sender: { from_name: "Sam", business_name: "Acme Hosting", offer: "We build landing pages.", signature: "Sam" },
});

test("template draft references only findings", () => {
  const d = templateDraft(ctx([{ type: "no_https", severity: 8, evidence: "x" }]));
  assert.match(d.body, /Not Secure/);
  assert.doesNotMatch(d.body, /mobile/i);
});

test("validator rejects unsupported claims and placeholders", () => {
  const c = ctx([{ type: "no_https", severity: 8, evidence: "x" }]);
  assert.ok(validateDraft({ subject: "Hi", body: "Your site is slow and bad on mobile" }, c));
  assert.ok(validateDraft({ subject: "Hi", body: "Hello [Name]" }, c));
  assert.equal(validateDraft({ subject: "Security warning", body: "Your site shows Not Secure." }, c), null);
});

test("generateDraft falls back to template on bad LLM output", async () => {
  const d = await generateDraft(ctx([{ type: "no_website", severity: 10, evidence: "x" }]), async () => "garbage");
  assert.equal(d.usedFallback, true);
  assert.match(d.subject, /website/i);
});

test("generateDraft accepts valid LLM output", async () => {
  const llm = async () => JSON.stringify({ subject: "A website for Joe's?", body: "Hi, I noticed you have no website." });
  const d = await generateDraft(ctx([{ type: "no_website", severity: 10, evidence: "x" }]), llm);
  assert.equal(d.usedFallback, false);
  assert.match(d.body, /Sam$/);
});

import { parseCsv } from "../src/osm.js";
test("parses quoted CSV", () => {
  assert.deepEqual(parseCsv('name,website\n"Joe, Inc",joes.com\n'), [['name','website'],['Joe, Inc','joes.com']]);
});
