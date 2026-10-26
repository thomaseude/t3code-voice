// In-memory stand-ins for T3, used to drive the WebSocket adapter in unit tests.

import type { EnvironmentDescriptor } from "../../../../src/adapters/t3-websocket/compatibility.ts";
import {
  ConnectionClosedError,
  type RpcConnection,
  type StreamHandlers,
} from "../../../../src/adapters/t3-websocket/rpcConnection.ts";
import type { T3Transport } from "../../../../src/adapters/t3-websocket/webSocketBackend.ts";

export const COMPATIBLE_DESCRIPTOR: EnvironmentDescriptor = {
  serverVersion: "0.1.0",
  orchestrationProtocolVersion: 2,
  capabilities: { threadSettlement: true },
};

export interface FakeStream {
  tag: string;
  payload: unknown;
  handlers: StreamHandlers;
  cancelled: boolean;
  ended: boolean;
  /** Sends stream items, as T3 would in a Chunk. */
  push(...values: unknown[]): void;
  /** Ends the stream with an error, as T3 would with a Failure exit. */
  fail(error: Error): void;
}

export class FakeConnection implements RpcConnection {
  readonly requests: Array<{ tag: string; payload: unknown }> = [];
  readonly streams: FakeStream[] = [];
  readonly responses = new Map<string, unknown>();
  private readonly closeListeners: Array<() => void> = [];
  closed = false;

  request(tag: string, payload: unknown): Promise<unknown> {
    this.requests.push({ tag, payload });
    return Promise.resolve(this.responses.get(tag));
  }

  stream(tag: string, payload: unknown, handlers: StreamHandlers): () => void {
    const stream: FakeStream = {
      tag,
      payload,
      handlers,
      cancelled: false,
      ended: false,
      push: (...values) => {
        for (const value of values) if (!stream.cancelled && !stream.ended) handlers.onValue(value);
      },
      fail: (error) => {
        stream.ended = true;
        handlers.onEnd(error);
      },
    };
    this.streams.push(stream);
    return () => {
      stream.cancelled = true;
    };
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** Simulates the socket dropping. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams) {
      if (stream.cancelled || stream.ended) continue;
      stream.ended = true;
      stream.handlers.onEnd(new ConnectionClosedError());
    }
    for (const listener of this.closeListeners) listener();
  }

  lastStream(): FakeStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error("no stream was opened");
    return stream;
  }
}

export class FakeTransport implements T3Transport {
  descriptor: EnvironmentDescriptor = COMPATIBLE_DESCRIPTOR;
  readonly connections: FakeConnection[] = [];
  descriptorChecks = 0;

  async fetchDescriptor(): Promise<EnvironmentDescriptor> {
    this.descriptorChecks += 1;
    return this.descriptor;
  }

  /** When set, opening a socket fails with this error (and counts the attempt). */
  openError: Error | null = null;
  openAttempts = 0;

  async openConnection(): Promise<RpcConnection> {
    this.openAttempts += 1;
    if (this.openError) throw this.openError;
    const connection = new FakeConnection();
    this.connections.push(connection);
    return connection;
  }

  lastConnection(): FakeConnection {
    const connection = this.connections.at(-1);
    if (!connection) throw new Error("no connection was opened");
    return connection;
  }
}

/** Lets pending promises and callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

export function wireProject(id: string, title = id) {
  return {
    id,
    title,
    workspaceRoot: `/home/me/${title}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
  };
}

export function wireThread(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "p1",
    title: `Thread ${id}`,
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    latestRunId: null,
    activeRunId: null,
    activityRunStatus: null,
    status: "idle",
    lastError: null,
    lastErrorClass: null,
    pendingRuntimeRequest: null,
    archivedAt: null,
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
    ...fields,
  };
}

export function shellSnapshot(sequence: number, projects: unknown[], threads: unknown[] = []) {
  return {
    kind: "snapshot",
    snapshot: {
      schemaVersion: 2,
      snapshotSequence: sequence,
      projects,
      threads,
      archivedThreads: [],
    },
  };
}
