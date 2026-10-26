// `t3-voice pair`: opens the pairing window and shows the QR code the T3 Voice app scans.
// `t3-voice serve` checks the code (POST /pair) and saves the device with the code's hash.

import { renderUnicodeCompact } from "uqr";
import { openPairingWindow, PAIRING_WINDOW_MS } from "../../core/pairing.ts";
import { ConfigError, type ConfigStore } from "../../ports/configStore.ts";

const POLL_MS = 1000;

export interface PairOptions {
  store: ConfigStore;
  out(line: string): void;
  /** Current time in milliseconds; injectable for tests. */
  now?: () => number;
  /** Waits `ms`, or less when the user presses Ctrl-C ("stop"). */
  wait(ms: number): Promise<"tick" | "stop">;
  renderQr?: (text: string) => string;
}

/** Returns the exit code: 0 once a device paired, 1 otherwise. */
export async function runPair({
  store,
  out,
  now = Date.now,
  wait,
  renderQr = renderUnicodeCompact,
}: PairOptions): Promise<number> {
  const config = await store.loadConfig();
  const publicUrl = config?.server?.publicUrl;
  if (!publicUrl) {
    throw new ConfigError(
      `Set "server.publicUrl" in ${store.location}/config.json to the HTTPS address the ` +
        `iPhone reaches the companion at, for example "https://voice.example.com".`,
    );
  }
  const { code, window } = await openPairingWindow(store, now());
  // The code is shown only inside the QR code: it is a secret until it is used.
  const link = `t3voice://pair?${new URLSearchParams({ url: publicUrl, code })}`;
  out(renderQr(link));
  out(`Scan this QR code with T3 Voice. It works once, for ${PAIRING_WINDOW_MS / 60_000} minutes.`);
  out(`"t3-voice serve" must be running and reachable at ${publicUrl}. Ctrl-C cancels.`);

  for (;;) {
    const event = await wait(POLL_MS);
    const paired = (await store.loadDevices()).find(
      (device) => device.pairingCodeSha256 === window.codeSha256,
    );
    if (paired) {
      await store.clearPairingWindow(window.codeSha256);
      out(`Paired "${paired.name}" (${paired.id}).`);
      return 0;
    }
    const current = await store.loadPairingWindow();
    if (current?.codeSha256 !== window.codeSha256) {
      out(
        current === null
          ? "The pairing window was closed."
          : 'Another "t3-voice pair" replaced this pairing window.',
      );
      return 1;
    }
    if (event === "stop") {
      await store.clearPairingWindow(window.codeSha256);
      out("Pairing cancelled.");
      return 1;
    }
    if (now() >= Date.parse(window.expiresAt)) {
      await store.clearPairingWindow(window.codeSha256);
      out('The pairing window expired. Run "t3-voice pair" again.');
      return 1;
    }
  }
}
