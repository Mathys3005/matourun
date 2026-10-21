import crypto from "node:crypto";
import { env } from "../env.js";

/* AES-256-GCM for secrets kept in the database (Garmin tokens, push keys).
   The key is derived from JWT_SECRET with a purpose label, so each use has its own key. */

function key(purpose: string) {
  return crypto.createHash("sha256").update(`${purpose}:${env().JWT_SECRET}`).digest();
}

export function seal(purpose: string, text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(purpose), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function open(purpose: string, blob: string): string {
  const [iv, tag, data] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(purpose), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(data!), d.final()]).toString("utf8");
}
