// The Codex versions the voice adapter was tested with. Codex's `thread/realtime/*` API is
// experimental and changed between 0.156 and 0.165, so the adapter fails closed: an untested
// Codex is not used, and sessions open on the API engine instead.

/**
 * Add a version only after a voice session from the iPhone works on it: the session opens,
 * the assistant speaks, and a tool action with a spoken "oui" runs. `voice.acceptedCodexVersions`
 * in config.json replaces this list.
 */
export const DEFAULT_CODEX_VERSIONS = ["0.163.0"];

/**
 * The version in the `userAgent` that `initialize` returns, e.g. "0.163.0" in
 * "t3-voice/0.163.0 (Ubuntu 22.4.0; x86_64) unknown (t3-voice; 0.1.0)".
 */
export function codexVersionOf(userAgent: unknown): string | null {
  if (typeof userAgent !== "string") return null;
  return /^[^/\s]+\/(\S+)/.exec(userAgent)?.[1] ?? null;
}

/** Why this Codex must not be used, or null when it is a tested version. */
export function findCodexIncompatibility(
  version: string | null,
  acceptedVersions: string[],
): string | null {
  if (version === null) return "the codex app-server did not say its version";
  if (acceptedVersions.includes(version)) return null;
  return `codex ${version} is not a tested version (tested: ${acceptedVersions.join(", ")})`;
}
