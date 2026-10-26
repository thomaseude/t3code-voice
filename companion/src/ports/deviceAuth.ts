// Checks the token a paired iPhone sends with every request.
//
// Today the companion issues its own opaque tokens; a future cloud could issue signed ones
// behind the same port.

/** A paired device, as known once its token was checked. */
export interface Device {
  id: string;
  name: string;
}

export interface DeviceAuth {
  /** The device the token belongs to, or null when the token is unknown or revoked. */
  authenticate(token: string): Promise<Device | null>;
}

/** A device as the companion stores it. Only a hash of its token is kept. */
export interface PairedDevice {
  id: string;
  name: string;
  /** SHA-256 of the device token, in hex. The token itself is never stored. */
  tokenSha256: string;
  /** ISO dates. */
  pairedAt: string;
  revokedAt: string | null;
}
