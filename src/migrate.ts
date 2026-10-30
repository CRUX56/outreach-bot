import fs from "node:fs";
import path from "node:path";
import { pool } from "./db.js";

const dir = path.resolve("migrations");
await pool.query("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const done = await pool.query("SELECT 1 FROM _migrations WHERE name=$1", [f]);
  if (done.rowCount) continue;
  await pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
  await pool.query("INSERT INTO _migrations(name) VALUES($1)", [f]);
  console.log("applied", f);
}
await pool.end();
