// Helpers for the companion's secrets: masking them in output, and creating, hashing and
// comparing the ones it issues (device tokens, pairing codes).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PATTERNS: Array<[RegExp, string]> = [
  [/([?&#](?:wsTicket|token|access_token|subject_token)=)[^&\s"']+/gi, "$1[redacted]"],
  [/(\b(?:Bearer|DPoP)\s+)[A-Za-z0-9._~+/=-]+/g, "$1[redacted]"],
  [/("(?:access_token|token|ticket|credential)"\s*:\s*")[^"]*"/gi, '$1[redacted]"'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
];

/**
 * Last line of defence for anything the companion prints: masks values that look like
 * credentials. Code must still never pass a secret to output in the first place.
 */
export function scrubSecrets(text: string): string {
  return PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}

/** A random secret of `bytes` bytes, URL-safe. */
export function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 in hex: how the companion stores the secrets it issues. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Compares two SHA-256 hex hashes in constant time. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The error's class name, for logs: its message could quote the user's request. */
export function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}
