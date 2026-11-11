import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import pg from "pg";

test("selection, sending and opt-outs work against PostgreSQL", { skip: process.env.TEST_INTEGRATION !== "1" }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "Set DATABASE_URL explicitly for the integration test");
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await admin.connect();
  const schema = `outreach_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  let applicationPool: pg.Pool | undefined;
  t.after(async () => {
    try {
      await applicationPool?.end();
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      client.release();
      await admin.end();
    }
  });
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  process.env.APP_SECRET = "integration-test-secret-long-enough";
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASSWORD = "integration-password";
  process.env.PUBLIC_URL = "https://outreach.example.org";
  const { pool } = await import("../src/db.js");
  applicationPool = pool;
  const { buildApp } = await import("../src/server.js");
  const { encrypt, unsubToken } = await import("../src/crypto.js");
  const { config } = await import("../src/config.js");
  const { sendNext } = await import("../src/worker.js");
  const { suppressEmail } = await import("../src/suppression.js");
  const { composeMessage, commercialProfileError } = await import("../src/mailer.js");
  for (const migration of ["001_init.sql", "002_latest_lead_search.sql", "003_search_generation.sql", "004_unsubscribe_links.sql"]) {
    await pool.query(await fs.readFile(path.join("migrations", migration), "utf8"));
  }

  let releaseDelivery: (() => void) | undefined;
  let deliveryStarted: (() => void) | undefined;
  let holdDelivery = false;
  const messages: string[] = [];
  const smtp = net.createServer((socket) => {
    socket.write("220 localhost ESMTP\r\n");
    let buffer = "";
    let data = false;
    let message = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            messages.push(message);
            if (holdDelivery) {
              deliveryStarted?.();
              releaseDelivery = () => socket.write("250 queued\r\n");
            } else socket.write("250 queued\r\n");
          } else message += `${line}\n`;
        } else if (/^EHLO/i.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (/^AUTH PLAIN/i.test(line)) socket.write("235 authenticated\r\n");
        else if (/^MAIL FROM|^RCPT TO/i.test(line)) socket.write("250 OK\r\n");
        else if (/^DATA/i.test(line)) { data = true; message = ""; socket.write("354 go ahead\r\n"); }
        else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  smtp.listen(0, "127.0.0.1");
  await once(smtp, "listening");
  t.after(() => smtp.close());
  const smtpAddress = smtp.address();
  assert.ok(smtpAddress && typeof smtpAddress !== "string");
  const [profile] = (await pool.query(
    `INSERT INTO sender_profiles(name,from_name,from_email,smtp_host,smtp_port,smtp_user,smtp_pass_enc,business_name,mailing_address,timezone,send_start_hour,send_end_hour,active)
     VALUES('test','Sender','sender@example.org','127.0.0.1',$1,'user',$2,'Example Inc','123 Main St, Raleigh NC','UTC',0,24,true) RETURNING *`,
    [smtpAddress.port, encrypt("password")])).rows;
  assert.equal(commercialProfileError(profile), null);
  assert.match(commercialProfileError({ ...profile, mailing_address: "  " }) ?? "", /mailing address/);
  const composed = composeMessage(profile, "owner@example.net", "Hello", "Message", "https://outreach.example.org/unsubscribe-link/test");
  assert.match(composed.text, /Advertisement from Example Inc/);
  assert.match(composed.text, /123 Main St, Raleigh NC/);
  assert.equal("List-Unsubscribe-Post" in composed.headers, false);

  const [first, duplicate] = (await pool.query(
    `INSERT INTO leads(name,email,status) VALUES('First','OWNER@example.net','drafted'),('Duplicate','owner@example.net','drafted') RETURNING id`)).rows;
  await pool.query(`INSERT INTO drafts(lead_id,profile_id,subject,body,status) VALUES($1,$3,'First subject','First body','approved'),($2,$3,'Pending','Body','pending')`, [first.id, duplicate.id, profile.id]);
  const server = buildApp().listen(0);
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const auth = `Basic ${Buffer.from("admin:integration-password").toString("base64")}`;
  const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: auth } });
  assert.equal((await get("/drafts?selected=1")).status, 400);
  assert.equal((await get("/drafts?lead=invalid")).status, 400);
  assert.equal((await get("/drafts?lead=999999999999")).status, 400);
  const stylesheet = await get("/styles.css");
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type") ?? "", /text\/css/);
  const leadPage = await (await get("/leads")).text();
  assert.match(leadPage, /Select all eligible visible leads/);
  assert.match(leadPage, /Review selected drafts/);
  const selected = await (await get(`/drafts?lead=${duplicate.id}`)).text();
  assert.match(selected, /Duplicate/);
  assert.doesNotMatch(selected, /First subject/);
  assert.equal(await sendNext(), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Advertisement from Example Inc/);
  const [link] = (await pool.query("SELECT token,email FROM unsubscribe_links")).rows;
  assert.equal(link.email, "owner@example.net");
  await pool.query("UPDATE leads SET email='changed@example.net' WHERE id=$1", [first.id]);
  const url = `${base}/unsubscribe-link/${link.token}`;
  assert.match(await (await fetch(url)).text(), /Stop future outreach/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM suppression")).rows[0].n, 0);
  assert.equal((await fetch(url, { method: "POST" })).status, 200);
  assert.equal((await fetch(url, { method: "POST" })).status, 200);
  assert.equal((await pool.query("SELECT status FROM leads WHERE id=$1", [duplicate.id])).rows[0].status, "unsubscribed");
  assert.equal((await pool.query("SELECT status FROM drafts WHERE lead_id=$1", [duplicate.id])).rows[0].status, "rejected");
  assert.equal((await pool.query("SELECT status FROM leads WHERE id=$1", [first.id])).rows[0].status, "contacted");

  const [third] = (await pool.query("INSERT INTO leads(name,email,status) VALUES('Third','third@example.net','drafted') RETURNING id")).rows;
  await pool.query("INSERT INTO drafts(lead_id,profile_id,subject,body,status) VALUES($1,$2,'Subject','Body','approved')", [third.id, profile.id]);
  config.publicUrl = "http://localhost:3000";
  assert.equal(await sendNext(), false);
  assert.equal((await pool.query("SELECT status FROM drafts WHERE lead_id=$1", [third.id])).rows[0].status, "approved");
  config.publicUrl = "https://outreach.example.org";
  holdDelivery = true;
  const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
  const sending = sendNext();
  await started;
  const suppressing = suppressEmail("THIRD@example.net", "manual opt-out");
  assert.equal(await Promise.race([suppressing.then(() => "finished"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100))]), "waiting");
  assert.ok(releaseDelivery);
  releaseDelivery();
  assert.equal(await sending, true);
  await suppressing;
  assert.equal((await pool.query("SELECT status FROM leads WHERE id=$1", [third.id])).rows[0].status, "unsubscribed");
  assert.equal(await sendNext(), false);

  const [fourth] = (await pool.query("INSERT INTO leads(name,email,status) VALUES('Fourth','fourth@example.net','drafted') RETURNING id")).rows;
  const [pending] = (await pool.query("INSERT INTO drafts(lead_id,profile_id,subject,body,status) VALUES($1,$2,'Subject','Body','pending') RETURNING id", [fourth.id, profile.id])).rows;
  const post = (urlPath: string, values: Record<string, string>) => fetch(`${base}${urlPath}`, {
    method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values), redirect: "manual",
  });
  assert.equal((await post(`/drafts/${pending.id}`, { action: "approve", subject: "", body: "Body" })).status, 400);
  assert.equal((await post("/suppression", { email: "FOURTH@example.net" })).status, 302);
  assert.equal((await post(`/drafts/${pending.id}`, { action: "approve", subject: "Subject", body: "Body" })).status, 400);
  assert.equal((await pool.query("SELECT status FROM drafts WHERE id=$1", [pending.id])).rows[0].status, "rejected");
  assert.equal((await fetch(`${base}/unsubscribe/${fourth.id}/${unsubToken(fourth.id)}`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${base}/unsubscribe/999999/${unsubToken(999999)}`, { method: "POST" })).status, 404);

  const [fifth] = (await pool.query("INSERT INTO leads(name,email,status) VALUES('Fifth','fifth@example.net','drafted') RETURNING id")).rows;
  const [invalidDraft] = (await pool.query("INSERT INTO drafts(lead_id,profile_id,subject,body,status) VALUES($1,$2,'','Body','approved') RETURNING id", [fifth.id, profile.id])).rows;
  assert.equal(await sendNext(), true);
  assert.match(await (await get("/drafts")).text(), /Subject and body are required/);
  assert.equal((await post(`/drafts/${invalidDraft.id}/retry`, {})).status, 302);
  assert.equal((await pool.query("SELECT status FROM drafts WHERE id=$1", [invalidDraft.id])).rows[0].status, "pending");

  config.placesKey = "test-key";
  const realFetch = globalThis.fetch;
  let releaseOlder: (() => void) | undefined;
  let olderStarted: (() => void) | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://places.googleapis.com/")) {
      const request = JSON.parse(String(init?.body)) as { textQuery: string };
      if (request.textQuery.startsWith("older ")) {
        await new Promise<void>((resolve) => { releaseOlder = resolve; olderStarted?.(); });
        return Response.json({ places: [{ id: "older-place", displayName: { text: "Older result" } }] });
      }
      return Response.json({ places: [{ id: "newer-place", displayName: { text: "Newer result" } }] });
    }
    return realFetch(input, init);
  });
  const startedSearch = new Promise<void>((resolve) => { olderStarted = resolve; });
  const olderSearch = post("/search", { category: "older", city: "Raleigh", source: "google" });
  await startedSearch;
  assert.equal((await post("/search", { category: "newer", city: "Raleigh", source: "google" })).status, 302);
  assert.ok(releaseOlder);
  releaseOlder();
  assert.equal((await olderSearch).status, 302);
  const latest = await (await get("/leads")).text();
  assert.match(latest, /Latest search: newer in Raleigh/);
  assert.match(latest, /Newer result/);
  assert.doesNotMatch(latest, /Older result/);
});
