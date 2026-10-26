// Startup check against the T3 version the companion was tested with.
//
// T3's protocol is not a stable public API, so the companion fails closed: if the server
// is not a version we tested, it refuses to run rather than risk sending wrong commands.

import { type ServerInfo, T3IncompatibleError } from "../../ports/t3Backend.ts";

export const SUPPORTED_ORCHESTRATION_PROTOCOL = 2;

export interface T3Pin {
  /** T3 server versions the adapter was tested against (see test/integration). */
  serverVersions: string[];
  /** Capability flags of the environment descriptor that the companion relies on. */
  requiredCapabilities: string[];
}

export const DEFAULT_T3_PIN: T3Pin = {
  // Add a version only after `T3_VERSION=<version> npm run test:integration` passes.
  serverVersions: ["0.1.0", "0.1.1"],
  // No feature used so far is gated by a capability flag. Add a flag here as soon as one is.
  requiredCapabilities: [],
};

/** The parts of `GET /.well-known/t3/environment` the check reads. */
export interface EnvironmentDescriptor {
  serverVersion: string;
  orchestrationProtocolVersion: number;
  capabilities: Record<string, unknown>;
}

/** Returns the list of mismatches; an empty list means the server is compatible. */
export function findIncompatibilities(descriptor: EnvironmentDescriptor, pin: T3Pin): string[] {
  const problems: string[] = [];

  if (descriptor.orchestrationProtocolVersion !== SUPPORTED_ORCHESTRATION_PROTOCOL) {
    problems.push(
      `orchestration protocol is ${descriptor.orchestrationProtocolVersion}, ` +
        `expected ${SUPPORTED_ORCHESTRATION_PROTOCOL}`,
    );
  }

  if (!pin.serverVersions.includes(descriptor.serverVersion)) {
    problems.push(
      `server version is ${descriptor.serverVersion}, tested versions: ${pin.serverVersions.join(", ")}`,
    );
  }

  for (const capability of pin.requiredCapabilities) {
    const value = descriptor.capabilities[capability];
    if (value === undefined || value === false || value === null) {
      problems.push(`required capability "${capability}" is missing`);
    }
  }

  return problems;
}

export function assertCompatible(descriptor: EnvironmentDescriptor, pin: T3Pin): void {
  const problems = findIncompatibilities(descriptor, pin);
  if (problems.length > 0) throw new T3IncompatibleError(problems);
}

export function toServerInfo(descriptor: EnvironmentDescriptor): ServerInfo {
  return {
    version: descriptor.serverVersion,
    protocolVersion: descriptor.orchestrationProtocolVersion,
  };
}
