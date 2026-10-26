// What `status` and `serve` need from setup: the config and the T3 token.

import { type CompanionConfig, ConfigError, type ConfigStore } from "../../ports/configStore.ts";
import type { T3Pairing } from "../../ports/t3Backend.ts";

export async function loadT3Setup(
  store: ConfigStore,
): Promise<{ config: CompanionConfig; pairing: T3Pairing }> {
  const config = await store.loadConfig();
  const pairing = await store.loadT3Pairing();
  if (!config || !pairing) {
    throw new ConfigError('The companion is not set up yet; run "t3-voice setup".');
  }
  if (pairing.baseUrl !== config.t3.baseUrl) {
    // Setup writes the URL and the token in two files, so they disagree if one write failed.
    throw new ConfigError(
      `The saved T3 token is for ${pairing.baseUrl}, not ${config.t3.baseUrl}; run "t3-voice setup" again.`,
    );
  }
  return { config, pairing };
}
