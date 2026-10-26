// Checks the token a paired iPhone sends with every request, and gives a token to a
// device that pairs.
//
// Today the companion issues its own opaque tokens; a future cloud could issue signed ones
// behind the same port.

/** A paired device, as known once its token was checked. */
export interface Device {
  id: string;
  name: string;
}

export interface Authentication {
  device: Device;
  /**
   * A new token for the device, when its token is old enough to be replaced. The device
   * must store it; its old token keeps working until the new one is used.
   */
  replacementToken: string | null;
}

export interface DeviceAuth {
  /** The device the token belongs to, or null when the token is unknown or revoked. */
  authenticate(token: string): Promise<Authentication | null>;
  /**
   * Adds a device and returns its first token. The token is a secret: never log it.
   * The device keeps the hash of the pairing code it used, so that code works once.
   */
  register(name: string, pairingCodeSha256: string): Promise<{ device: Device; token: string }>;
}

/** A device as the companion stores it. Only hashes of its tokens are kept. */
export interface PairedDevice {
  id: string;
  name: string;
  /** SHA-256 of the device token, in hex. The token itself is never stored. */
  tokenSha256: string;
  /** A replacement token sent to the device but not used yet (its SHA-256), or null. */
  nextToken: { sha256: string; issuedAt: string } | null;
  /** ISO dates. The token is replaced on use once it is 30 days old. */
  tokenIssuedAt: string;
  /** SHA-256 of the pairing code the device used. */
  pairingCodeSha256: string;
  pairedAt: string;
  revokedAt: string | null;
}
