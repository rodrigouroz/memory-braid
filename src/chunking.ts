import crypto from "node:crypto";

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeForHash(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}
