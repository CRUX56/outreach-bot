import { q } from "./db.js";

const UA = { "user-agent": "outreach-bot/0.1 (self-hosted lead finder)" };

// Common business words -> OSM tags (Overpass) and keyword variants (Nominatim)
const TAGS: Record<string, string[]> = {
  plumber: ["craft=plumber"], electrician: ["craft=electrician"], hvac: ["craft=hvac"],
  carpenter: ["craft=carpenter"], painter: ["craft=painter"], roofer: ["craft=roofer"],
  landscaper: ["craft=gardener"], gardener: ["craft=gardener"], locksmith: ["shop=locksmith"],
  restaurant: ["amenity=restaurant"], cafe: ["amenity=cafe"], bar: ["amenity=bar"],
  dentist: ["amenity=dentist"], doctor: ["amenity=doctors"], vet: ["amenity=veterinary"],
  salon: ["shop=hairdresser", "shop=beauty"], barber: ["shop=hairdresser"],
  gym: ["leisure=fitness_centre"], bakery: ["shop=bakery"], florist: ["shop=florist"],
  mechanic: ["shop=car_repair"], "auto repair": ["shop=car_repair"], lawyer: ["office=lawyer"],
  accountant: ["office=accountant"], "real estate": ["office=estate_agent"], photographer: ["craft=photographer", "shop=photo"],
  cleaner: ["craft=cleaning"], contractor: ["craft=builder"],
};
const ALIASES: Record<string, string[]> = {
  plumber: ["plumbing"], electrician: ["electrical", "electric"], roofer: ["roofing"], landscaper: ["landscaping", "lawn"],
  painter: ["painting"], cleaner: ["cleaning"], mechanic: ["auto repair"], lawyer: ["law", "attorney"], hvac: ["heating", "air conditioning"],
  contractor: ["construction", "remodeling"], barber: ["barber shop"], salon: ["hair salon"], vet: ["veterinary"],
};

const esc = (s: string) => s.replace(/[\\"]/g, "\\$&");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type El = { type: string; id: number; tags: Record<string, string> };

// Nominatim keyword search: fast, returns website/email/phone in extratags. Public policy: max 1 req/sec.
async function nominatimSearch(category: string, view: string): Promise<El[]> {
  const key = category.trim().toLowerCase();
  const out = new Map<string, El>();
  for (const term of [key, ...(ALIASES[key] ?? [])]) {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&extratags=1&limit=40&bounded=1&viewbox=${view}&q=${encodeURIComponent(term)}`, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (r.ok)
      for (const x of (await r.json()) as any[]) {
        const name = x.name || x.display_name?.split(",")[0];
        if (name) out.set(`${x.osm_type}/${x.osm_id}`, { type: x.osm_type, id: x.osm_id, tags: { name, ...x.extratags } });
      }
    await sleep(1100);
  }
  return [...out.values()];
}

// Overpass tag search: more complete but public servers are often overloaded, so failures are non-fatal
async function overpassSearch(category: string, bbox: string, max: number): Promise<El[]> {
  const key = category.trim().toLowerCase();
  const tags = TAGS[key];
  const filters = tags ? tags.map((t) => { const [k, v] = t.split("="); return `["${k}"="${v}"]`; }) : [`["name"~"${esc(key)}",i]`];
  const parts = filters.flatMap((f) => ["node", "way"].map((t) => `${t}${f}["name"](${bbox});`));
  const ql = `[out:json][timeout:40];(${parts.join("")});out center tags ${max * 2};`;
  for (const host of ["https://overpass-api.de", "https://overpass.kumi.systems"]) {
    try {
      const res = await fetch(`${host}/api/interpreter`, {
        method: "POST", headers: { ...UA, "content-type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(ql)}`, signal: AbortSignal.timeout(45000),
      });
      if (res.ok) return (((await res.json()) as any).elements ?? []) as El[];
    } catch {}
  }
  return [];
}

export async function searchOsm(category: string, city: string, max = 60) {
  const geo = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(city)}`, { headers: UA, signal: AbortSignal.timeout(20000) });
  const g: any[] = geo.ok ? await geo.json() : [];
  if (!g.length) throw new Error(`Could not locate "${city}"`);
  const [s, n, w, e] = g[0].boundingbox.map(Number);
  await sleep(1100);

  const found = new Map<string, El>();
  for (const el of await nominatimSearch(category, `${w},${n},${e},${s}`)) found.set(`${el.type}/${el.id}`, el);
  if (found.size < 10)
    for (const el of await overpassSearch(category, `${s},${w},${n},${e}`, max)) found.set(`${el.type}/${el.id}`, el);

  const els = [...found.values()].filter((x) => x.tags?.name);
  let added = 0;
  const selected = els.slice(0, max);
  for (const el of selected) {
    const t = el.tags;
    const r = await q(
      `INSERT INTO leads(place_id,name,category,city,phone,website,email) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (place_id) DO NOTHING RETURNING id`,
      [`osm:${el.type}/${el.id}`, t.name, category, city, t.phone ?? t["contact:phone"] ?? null,
       t.website ?? t["contact:website"] ?? null, (t.email ?? t["contact:email"] ?? null)?.toLowerCase() ?? null],
    );
    added += r.length;
  }
  return { found: els.length, added, placeIds: selected.map((el) => `osm:${el.type}/${el.id}`) };
}

// Minimal CSV parser supporting quoted fields
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

// Header columns (case-insensitive): name (required), website, email, phone, category, city
export async function importCsv(text: string) {
  const [head, ...rows] = parseCsv(text);
  if (!head) throw new Error("Empty CSV");
  const idx = (n: string) => head.findIndex((h) => h.trim().toLowerCase() === n);
  const [iN, iW, iE, iP, iC, iCity] = ["name", "website", "email", "phone", "category", "city"].map(idx);
  if (iN < 0) throw new Error("CSV needs a 'name' column");
  const get = (r: string[], i: number) => (i >= 0 ? r[i]?.trim() || null : null);
  let added = 0;
  for (const r of rows) {
    const name = get(r, iN);
    if (!name) continue;
    const website = get(r, iW), email = get(r, iE)?.toLowerCase() ?? null;
    const res = await q(
      `INSERT INTO leads(place_id,name,category,city,phone,website,email) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (place_id) DO NOTHING RETURNING id`,
      [`csv:${(website ?? email ?? name).toLowerCase()}`, name, get(r, iC), get(r, iCity), get(r, iP), website, email],
    );
    added += res.length;
  }
  return { found: rows.length, added };
}
