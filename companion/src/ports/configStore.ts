// Where the companion keeps its settings and the T3 token.

import type { PairedDevice } from "./deviceAuth.ts";
import type { T3Pairing } from "./t3Backend.ts";

export const DEFAULT_T3_URL = "http://127.0.0.1:3773";
export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 8787;

export interface CompanionConfig {
  t3: {
    baseUrl: string;
    /** Replaces the tested T3 versions. Only add a version after running the integration tests. */
    acceptedServerVersions?: string[];
  };
  /** The HTTP API the iPhone calls. */
  server?: {
    /** Default 127.0.0.1: a local tunnel publishes it, nothing else should reach it. */
    host?: string;
    port?: number;
    /** Header a local proxy sets to the caller's IP, e.g. "cf-connecting-ip". */
    clientIpHeader?: string;
    /** HTTPS address the iPhone reaches the companion at, e.g. "https://voice.example.com". */
    publicUrl?: string;
  };
}

/** The pairing window `t3-voice pair` opens. It holds one code, until it expires or is used. */
export interface PairingWindow {
  /** SHA-256 of the one-time code, in hex. The code itself is never stored. */
  codeSha256: string;
  /** ISO date. */
  expiresAt: string;
}

export interface ConfigStore {
  /** Human-readable location, for messages. */
  readonly location: string;
  loadConfig(): Promise<CompanionConfig | null>;
  saveConfig(config: CompanionConfig): Promise<void>;
  /** The pairing holds a secret: implementations must keep it private and never log it. */
  loadT3Pairing(): Promise<T3Pairing | null>;
  saveT3Pairing(pairing: T3Pairing): Promise<void>;
  /** Paired iPhones, revoked ones included; an empty list when none was ever paired. */
  loadDevices(): Promise<PairedDevice[]>;
  /**
   * Reads the device list, applies the change and saves the result, as one step: `serve`
   * and the CLI both change the list, and neither may undo the other's change.
   */
  updateDevices(change: (devices: PairedDevice[]) => PairedDevice[]): Promise<PairedDevice[]>;
  /** The open pairing window, or null. An expired window may still be returned. */
  loadPairingWindow(): Promise<PairingWindow | null>;
  savePairingWindow(window: PairingWindow): Promise<void>;
  clearPairingWindow(): Promise<void>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
