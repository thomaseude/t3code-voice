// Where the companion keeps its settings and the T3 token.

import type { T3Pairing } from "./t3Backend.ts";

export const DEFAULT_T3_URL = "http://127.0.0.1:3773";

export interface CompanionConfig {
  t3: {
    baseUrl: string;
    /** Replaces the tested T3 versions. Only add a version after running the integration tests. */
    acceptedServerVersions?: string[];
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
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
