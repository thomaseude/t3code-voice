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
  };
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
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
