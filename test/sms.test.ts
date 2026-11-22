import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { classifyInboundSms, composeSms, defaultSmsBody, normalizePhone, smsBodyError, smsWindow, twilioSignature, validTwilioSignature } from "../src/smsCore.js";

test("normalizes US phone numbers to E.164", () => {
  assert.equal(normalizePhone("(704) 999-4690"), "+17049994690");
  assert.equal(normalizePhone("1-704-999-4690"), "+17049994690");
  assert.equal(normalizePhone("+1 704 999 4690"), "+17049994690");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("999-4690"), null);
  assert.equal(normalizePhone("704-999-4690 ext 2"), null);
  assert.equal(normalizePhone("123-456-7890"), null); // US area codes never start with 0/1
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
});

test("identifies sender and adds STOP instructions exactly once", () => {
  assert.equal(composeSms("The Crux Creative", "Hi there"), "The Crux Creative: Hi there\nReply STOP to opt out.");
  assert.equal(composeSms("The Crux Creative", "The Crux Creative here. Hi"), "The Crux Creative here. Hi\nReply STOP to opt out.");
  assert.equal(composeSms("Crux", "Hi. Reply STOP to opt out."), "Crux: Hi. Reply STOP to opt out.");
});

test("validates SMS bodies", () => {
  assert.equal(smsBodyError("Hello"), null);
  assert.ok(smsBodyError(""));
  assert.ok(smsBodyError("x".repeat(481)));
  assert.ok(smsBodyError("Hi [Name]"));
});

test("classifies inbound texts, honoring opt-out by any reasonable means", () => {
  for (const s of ["STOP", "stop", "Stop.", "UNSUBSCRIBE", "cancel", "quit", "end", "STOPALL", "please stop texting me", "Wrong number", "remove me from your list", "leave me alone"]) {
    assert.equal(classifyInboundSms(s), "opt_out", s);
  }
  assert.equal(classifyInboundSms("START"), "opt_in");
  assert.equal(classifyInboundSms("unstop"), "opt_in");
  assert.equal(classifyInboundSms("HELP"), "help");
  for (const s of ["Yes", "Sure, send the mockup", "How much is it?", "Can you call me tomorrow?"]) assert.equal(classifyInboundSms(s), "reply", s);
});

test("computes and validates Twilio webhook signatures", () => {
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  const expected = crypto.createHmac("sha1", token)
    .update(url + "CallSidCA1234567890ABCDECaller+12349013030Digits1234From+12349013030To+18005551212").digest("base64");
  assert.equal(twilioSignature(token, url, params), expected);
  assert.ok(validTwilioSignature(token, url, params, expected));
  assert.ok(!validTwilioSignature(token, url, { ...params, Digits: "9999" }, expected));
  assert.ok(!validTwilioSignature("wrong", url, params, expected));
  assert.ok(!validTwilioSignature(token, url, params, undefined));
});

test("clamps send window to TCPA quiet hours", () => {
  assert.deepEqual(smsWindow(9, 17), [9, 17]);
  assert.deepEqual(smsWindow(6, 23), [8, 21]);
});

test("default text body has no placeholders", () => {
  const body = defaultSmsBody({ fromName: "Alex", businessName: "The Crux Creative", leadName: "Joe's Plumbing", ctaUrl: "https://www.thecruxcreative.com/hosting" });
  assert.equal(smsBodyError(body), null);
  assert.match(body, /Joe's Plumbing/);
});
