import crypto from "node:crypto";
import { config } from "./config.js";

const key = () => {
  if (config.appSecret.length < 16) throw new Error("APP_SECRET must be set (16+ chars)");
  return crypto.scryptSync(config.appSecret, "outreach-bot", 32);
};

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

export const unsubToken = (leadId: number) =>
  crypto.createHmac("sha256", key()).update(`unsub:${leadId}`).digest("hex").slice(0, 32);
