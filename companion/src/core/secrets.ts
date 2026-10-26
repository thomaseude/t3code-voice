// Last line of defence for anything the companion prints: masks values that look like
// credentials. Code must still never pass a secret to output in the first place.

const PATTERNS: Array<[RegExp, string]> = [
  [/([?&#](?:wsTicket|token|access_token|subject_token)=)[^&\s"']+/gi, "$1[redacted]"],
  [/(\b(?:Bearer|DPoP)\s+)[A-Za-z0-9._~+/=-]+/g, "$1[redacted]"],
  [/("(?:access_token|token|ticket|credential)"\s*:\s*")[^"]*"/gi, '$1[redacted]"'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
];

export function scrubSecrets(text: string): string {
  return PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}
