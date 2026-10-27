// Where the companion keeps its settings and the T3 token.

import type { PairedDevice } from "./deviceAuth.ts";
import type { T3Pairing } from "./t3Backend.ts";

export const DEFAULT_T3_URL = "http://127.0.0.1:3773";
export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 8787;

/**
 * The voice engine the companion opens sessions with (spec #15, decided with Thomas in #12
 * and #19), and the cheap text model that summarizes finished tasks (#22).
 */
export const DEFAULT_VOICE = {
  model: "gpt-live-1",
  voice: "brise",
  delegationModel: "gpt-5.6-terra",
  summaryModel: "gpt-5.4-mini",
};

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
  /** GPT-Live and summary settings; each one missing takes its DEFAULT_VOICE value. */
  voice?: {
    model?: string;
    voice?: string;
    /** The Responses model GPT-Live hands the user's requests and the tool calls to. */
    delegationModel?: string;
    /** The text model that summarizes what an agent did, for announcements. */
    summaryModel?: string;
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
  /** The OpenAI API key (a secret, never logged), or null when none is set up. */
  loadOpenAiKey(): Promise<string | null>;
  // Each file has one writer process, so no process can overwrite another's change:
  // `serve` writes the device list, the CLI writes revocations and pairing windows.

  /** Paired iPhones, revoked ones included; an empty list when none was ever paired. */
  loadDevices(): Promise<PairedDevice[]>;
  /**
   * Reads the device list, applies the change and saves the result. Only `serve` calls it,
   * and its calls run one at a time. `revokedAt` is not saved: only revokeDevice revokes.
   */
  updateDevices(change: (devices: PairedDevice[]) => PairedDevice[]): Promise<PairedDevice[]>;
  /** Called by `t3-voice devices revoke`. It must never overwrite the device list. */
  revokeDevice(id: string, revokedAt: string): Promise<void>;
  /** The open window for this code, or null. It may be expired or used. */
  loadPairingWindow(codeSha256: string): Promise<PairingWindow | null>;
  /** Opens a window. Each `t3-voice pair` opens and closes only its own window. */
  savePairingWindow(window: PairingWindow): Promise<void>;
  clearPairingWindow(codeSha256: string): Promise<void>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
