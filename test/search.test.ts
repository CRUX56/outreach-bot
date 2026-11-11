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
  let latest: { category: string; city: string; source: string; place_ids: string[]; generation: number } | undefined;
  let generation = 0;
  const processed: string[][] = [];
  const drafted: string[][] = [];
  let migrationMissing = false;
  const fakeQuery = async (sql: string, params: unknown[] = []) => {
    let rows: object[] = [];
    if (sql.includes("nextval('lead_search_generation_seq')")) {
      rows = [{ generation: ++generation }];
    } else if (sql.includes("INSERT INTO leads")) {
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
      const [category, city, source, placeIds, searchGeneration] = params;
      if (!latest || latest.generation < Number(searchGeneration)) latest = { category: String(category), city: String(city), source: String(source), place_ids: placeIds as string[], generation: Number(searchGeneration) };
    } else if (sql.includes("FROM latest_lead_search")) {
      if (migrationMissing) throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      rows = latest ? [latest] : [];
    } else if (sql.includes("SELECT l.*") && sql.includes("FROM leads l")) {
      const ids = params[0] as string[] | undefined;
      if (ids) {
        assert.match(sql, /ORDER BY array_position/);
        rows = ids.flatMap((id) => leads.filter((l) => l.place_id === id));
      } else rows = leads;
    } else {
      throw new Error(`Unexpected query: ${sql}`);
    }
    return { rows, command: "", rowCount: rows.length, oid: 0, fields: [] };
  };
  t.mock.method(pool, "query", fakeQuery as typeof pool.query);

  let results: { id: string; displayName: { text: string } }[] = [];
  let fail = false;
  let race = false;
  let releaseOlder: (() => void) | undefined;
  let olderStarted: (() => void) | undefined;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://places.googleapis.com/")) {
      if (race) {
        const request = JSON.parse(String(init?.body)) as { textQuery: string };
        if (request.textQuery.startsWith("older ")) {
          await new Promise<void>((resolve) => { releaseOlder = resolve; olderStarted?.(); });
          return Response.json({ places: [{ id: "older-race", displayName: { text: "Older race" } }] });
        }
        return Response.json({ places: [{ id: "newer-race", displayName: { text: "Newer race" } }] });
      }
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

  migrationMissing = true;
  const migrationError = await get("/leads");
  assert.equal(migrationError.status, 503);
  assert.match(await migrationError.text(), /npm run migrate/);
  migrationMissing = false;
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
  assert.ok(current.indexOf("New business") < current.indexOf("Shared business"));
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

  race = true;
  const started = new Promise<void>((resolve) => { olderStarted = resolve; });
  const older = search("older");
  await started;
  assert.equal((await search("newer")).status, 302);
  assert.ok(releaseOlder);
  releaseOlder();
  assert.equal((await older).status, 302);
  const afterRace = await (await get("/leads")).text();
  assert.match(afterRace, /Latest search: newer in Austin/);
  assert.match(afterRace, /Newer race/);
  assert.doesNotMatch(afterRace, /Older race/);
});
