import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await pool.query(text, params)).rows as T[];
