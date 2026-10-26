// T3Connector adapter: version check, pairing and connection over T3's app protocol.

import type { ServerInfo, T3Backend, T3Connector, T3Pairing } from "../../ports/t3Backend.ts";
import { assertCompatible, DEFAULT_T3_PIN, type T3Pin, toServerInfo } from "./compatibility.ts";
import { exchangePairingCredential, fetchDescriptor, parsePairingCredential } from "./http.ts";
import { makeHttpTransport, WebSocketT3Backend } from "./webSocketBackend.ts";

export class WebSocketT3Connector implements T3Connector {
  async checkServer(baseUrl: string, acceptedVersions?: string[]): Promise<ServerInfo> {
    const descriptor = await fetchDescriptor(baseUrl);
    assertCompatible(descriptor, pinFor(acceptedVersions));
    return toServerInfo(descriptor);
  }

  pair(baseUrl: string, pairingLink: string): Promise<T3Pairing> {
    return exchangePairingCredential(baseUrl, parsePairingCredential(pairingLink));
  }

  connect(pairing: T3Pairing, acceptedVersions?: string[]): Promise<T3Backend> {
    return WebSocketT3Backend.connect({
      transport: makeHttpTransport(pairing.baseUrl, pairing.token),
      pin: pinFor(acceptedVersions),
    });
  }
}

function pinFor(acceptedVersions: string[] | undefined): T3Pin {
  return acceptedVersions?.length
    ? { ...DEFAULT_T3_PIN, serverVersions: acceptedVersions }
    : DEFAULT_T3_PIN;
}
