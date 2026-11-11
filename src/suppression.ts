import type { PoolClient } from "pg";
import { pool } from "./db.js";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function withEmailLock<T>(email: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [normalizeEmail(email)]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function suppressEmail(email: string, reason: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("A valid email address is required");
  await withEmailLock(normalized, async (client) => {
    await client.query("INSERT INTO suppression(email,reason) VALUES($1,$2) ON CONFLICT (email) DO NOTHING", [normalized, reason]);
    await client.query("UPDATE leads SET status='unsubscribed' WHERE lower(trim(email))=$1", [normalized]);
    await client.query(`UPDATE drafts SET status='rejected', error='address suppressed'
      WHERE status IN ('pending','approved') AND lead_id IN (SELECT id FROM leads WHERE lower(trim(email))=$1)`, [normalized]);
  });
}
