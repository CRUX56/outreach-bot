import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { buildApp } from "../src/server.js";

test("latest search displays its results while retaining all saved leads", async (t) => {
  const originalPassword = config.adminPassword;
  const originalKey = config.placesKey;
  config.adminPassword = "test-password";
  config.placesKey = "test-key";
  t.after(() => { config.adminPassword = originalPassword; config.placesKey = originalKey; });

  const leads: { id: number; place_id: string; name: string; status: string }[] = [];
  let latest: { category: string; city: string; source: string; place_ids: string[] } | undefined;
  const processed: string[][] = [];
  const drafted: string[][] = [];
  const fakeQuery = async (sql: string, params: unknown[] = []) => {
    let rows: object[] = [];
    if (sql.includes("INSERT INTO leads")) {
      const [placeId, name] = params as string[];
      if (!leads.some((l) => l.place_id === placeId)) {
        const lead = { id: leads.length + 1, place_id: placeId, name, status: "new" };
        leads.push(lead);
        rows = [lead];
      }
    } else if (sql.includes("SELECT id, website, email FROM leads")) {
      assert.match(sql, /place_id = ANY/);
      processed.push(params[1] as string[]);
    } else if (sql.includes("SELECT * FROM sender_profiles")) {
      rows = [{}];
    } else if (sql.includes("SELECT * FROM leads WHERE status='qualified'")) {
      assert.match(sql, /place_id = ANY/);
      drafted.push(params[1] as string[]);
    } else if (sql.includes("INSERT INTO latest_lead_search")) {
      const [category, city, source, placeIds] = params;
      latest = { category: String(category), city: String(city), source: String(source), place_ids: placeIds as string[] };
    } else if (sql.includes("FROM latest_lead_search")) {
      rows = latest ? [latest] : [];
    } else if (sql.includes("SELECT * FROM leads")) {
      const ids = params[0] as string[] | undefined;
      rows = ids ? leads.filter((l) => ids.includes(l.place_id)) : leads;
    } else {
      throw new Error(`Unexpected query: ${sql}`);
    }
    return { rows, command: "", rowCount: rows.length, oid: 0, fields: [] };
  };
  t.mock.method(pool, "query", fakeQuery as typeof pool.query);

  let results: { id: string; displayName: { text: string } }[] = [];
  let fail = false;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://places.googleapis.com/")) {
      return fail
        ? new Response("unavailable", { status: 503 })
        : Response.json({ places: results });
    }
    if (String(input).startsWith("https://nominatim.openstreetmap.org/")) {
      return String(input).includes("extratags=1")
        ? Response.json(Array.from({ length: 10 }, (_, id) => ({ osm_type: "node", osm_id: id, name: `OSM business ${id}` })))
        : Response.json([{ boundingbox: ["1", "2", "3", "4"] }]);
    }
    return realFetch(input, init);
  });

  const server = buildApp().listen(0);
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const authorization = `Basic ${Buffer.from(`${config.adminUser}:${config.adminPassword}`).toString("base64")}`;
  const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization } });
  const search = (category: string, source = "google") => fetch(`${base}/search`, {
    method: "POST",
    headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ category, city: "Austin", source }),
    redirect: "manual",
  });

  assert.match(await (await get("/leads")).text(), /Showing all saved leads/);
  results = [{ id: "old", displayName: { text: "Old business" } }, { id: "shared", displayName: { text: "Shared business" } }];
  assert.equal((await search("plumber")).headers.get("location"), "/leads");
  results = [{ id: "new", displayName: { text: "New business" } }, { id: "shared", displayName: { text: "Shared business" } }];
  assert.equal((await search("dentist")).status, 302);
  const current = await (await get("/leads")).text();
  assert.match(current, /Latest search: dentist in Austin/);
  assert.match(current, /New business/);
  assert.match(current, /Shared business/);
  assert.doesNotMatch(current, /Old business/);
  assert.deepEqual(processed, [["old", "shared"], ["new", "shared"]]);
  assert.deepEqual(drafted, processed);
  const all = await (await get("/leads?view=all")).text();
  assert.match(all, /Old business/);
  assert.match(all, /New business/);

  assert.equal((await search("cafe", "osm")).status, 302);
  const osm = await (await get("/leads")).text();
  assert.match(osm, /Latest search: cafe in Austin \(OpenStreetMap\)/);
  assert.match(osm, /OSM business 0/);
  assert.doesNotMatch(osm, /Old business|New business/);
  assert.deepEqual(processed[2], Array.from({ length: 10 }, (_, id) => `osm:node/${id}`));

  results = [];
  await search("empty");
  const empty = await (await get("/leads")).text();
  assert.match(empty, /No leads found/);
  assert.doesNotMatch(empty, /Old business|New business/);

  fail = true;
  assert.equal((await search("failed")).status, 500);
  assert.match(await (await get("/leads")).text(), /Latest search: empty in Austin/);
  assert.match(await (await get("/leads?view=all")).text(), /Old business/);
});
