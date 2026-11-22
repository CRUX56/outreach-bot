import test from "node:test";
import assert from "node:assert/strict";
import { leadStatus } from "../src/leadStatus.js";

const base = { weak: true, email: null, verified: false, suppressed: false, phone: null };

test("weak lead with verified email is qualified", () => {
  assert.equal(leadStatus({ ...base, email: "owner@joes.com", verified: true, phone: "(704) 555-1234" }), "qualified");
});

test("weak lead with no email but a phone goes to the call list", () => {
  assert.equal(leadStatus({ ...base, phone: "(704) 374-0205" }), "call_first");
  assert.equal(leadStatus({ ...base, email: "bad@nomx.invalid", verified: false, phone: "704-374-0205" }), "call_first");
});

test("leads are disqualified when strong, suppressed, or unreachable", () => {
  assert.equal(leadStatus({ ...base, weak: false, phone: "7043740205" }), "disqualified");
  assert.equal(leadStatus({ ...base, suppressed: true, email: "a@b.com", verified: true, phone: "7043740205" }), "disqualified");
  assert.equal(leadStatus({ ...base, phone: "555-1234" }), "disqualified");
  assert.equal(leadStatus(base), "disqualified");
});
