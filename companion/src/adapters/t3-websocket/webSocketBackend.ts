// T3Backend adapter over T3's app protocol: `/ws`, orchestration protocol 2, one
// short-lived `wsTicket` per socket.

import {
  type Project,
  type ServerInfo,
  type ShellEvent,
  type ShellSubscriber,
  type ShellSubscription,
  type T3Backend,
  type T3Config,
  T3IncompatibleError,
} from "../../ports/t3Backend.ts";
import {
  assertCompatible,
  type EnvironmentDescriptor,
  SUPPORTED_ORCHESTRATION_PROTOCOL,
  type T3Pin,
  toServerInfo,
} from "./compatibility.ts";
import { fetchDescriptor, issueWebSocketTicket, T3HttpError } from "./http.ts";
import { openRpcConnection, type RpcConnection, RpcError } from "./rpcConnection.ts";
import { toConfig, toShellEvent } from "./wire.ts";

const METHODS = {
  getConfig: "server.getConfig",
  subscribeShell: "orchestration.subscribeShell",
};

/** How long a one-off call waits for T3's answer. Pings keep a socket open even when T3 never answers. */
const ANSWER_TIMEOUT_MS = 15_000;

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** How the adapter reaches T3. Tests replace it with an in-memory fake. */
export interface T3Transport {
  fetchDescriptor(): Promise<EnvironmentDescriptor>;
  openConnection(): Promise<RpcConnection>;
}

export interface WebSocketBackendOptions {
  transport: T3Transport;
  pin: T3Pin;
  /** Waits between reconnect attempts, in milliseconds. The last one repeats. */
  reconnectDelaysMs?: number[];
  /** Injectable for tests, which should not really wait. */
  wait?: (ms: number) => Promise<void>;
}

export function makeHttpTransport(baseUrl: string, token: string): T3Transport {
  return {
    fetchDescriptor: () => fetchDescriptor(baseUrl),
    openConnection: async () => {
      const ticket = await issueWebSocketTicket(baseUrl, token);
      const url = new URL("/ws", baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", ticket);
      url.searchParams.set("orchestrationProtocol", String(SUPPORTED_ORCHESTRATION_PROTOCOL));
      return openRpcConnection(url.toString());
    },
  };
}

export class WebSocketT3Backend implements T3Backend {
  private connectionPromise: Promise<RpcConnection> | null = null;
  private readonly subscriptions = new Set<ShellStream>();
  private closed = false;

  /** Last descriptor seen by the startup check. */
  private descriptor: EnvironmentDescriptor | null = null;

  private readonly options: WebSocketBackendOptions;

  constructor(options: WebSocketBackendOptions) {
    this.options = options;
  }

  /**
   * Runs the startup check and opens the connection. Throws T3IncompatibleError when the
   * server does not match the pinned version, before anything else is sent to it.
   */
  static async connect(options: WebSocketBackendOptions): Promise<WebSocketT3Backend> {
    const backend = new WebSocketT3Backend(options);
    await backend.connection();
    return backend;
  }

  serverInfo(): ServerInfo {
    if (!this.descriptor) throw new Error("Not connected to T3 yet.");
    return toServerInfo(this.descriptor);
  }

  async getConfig(): Promise<T3Config> {
    const connection = await this.connection();
    const answer = connection.request(METHODS.getConfig, {});
    return toConfig(await withTimeout(answer, "its configuration"));
  }

  async listProjects(): Promise<Project[]> {
    const connection = await this.connection();
    let cancel = () => {};
    const projects = new Promise<Project[]>((resolve, reject) => {
      cancel = connection.stream(
        METHODS.subscribeShell,
        {},
        {
          onValue: (item) => {
            const event = toShellEvent(item);
            if (event?.type !== "snapshot") return;
            cancel();
            resolve(event.projects);
          },
          onEnd: (error) => reject(error ?? new Error("T3 ended the shell stream early.")),
        },
      );
    });
    return withTimeout(projects, "the project list", () => cancel());
  }

  subscribeShell(
    subscriber: ShellSubscriber,
    options: { afterSequence?: number } = {},
  ): ShellSubscription {
    const stream = new ShellStream({
      connection: () => this.connection(),
      subscriber,
      afterSequence: options.afterSequence ?? null,
      reconnectDelaysMs: this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS,
      wait: this.options.wait ?? sleep,
    });
    this.subscriptions.add(stream);
    stream.start();
    return {
      close: () => {
        stream.stop();
        this.subscriptions.delete(stream);
      },
    };
  }

  close(): void {
    this.closed = true;
    for (const stream of this.subscriptions) stream.stop();
    this.subscriptions.clear();
    this.connectionPromise?.then((connection) => connection.close()).catch(() => {});
    this.connectionPromise = null;
  }

  /** The shared connection, opened on demand. Every new socket repeats the startup check. */
  connection(): Promise<RpcConnection> {
    if (this.closed) return Promise.reject(new Error("The T3 backend is closed."));
    if (!this.connectionPromise) {
      const opening = this.openCheckedConnection();
      this.connectionPromise = opening;
      opening.then(
        (connection) =>
          connection.onClose(() => {
            if (this.connectionPromise === opening) this.connectionPromise = null;
          }),
        () => {
          if (this.connectionPromise === opening) this.connectionPromise = null;
        },
      );
    }
    return this.connectionPromise;
  }

  private async openCheckedConnection(): Promise<RpcConnection> {
    const descriptor = await this.options.transport.fetchDescriptor();
    assertCompatible(descriptor, this.options.pin);
    this.descriptor = descriptor;
    return this.options.transport.openConnection();
  }
}

interface ShellStreamOptions {
  /** The backend's shared, checked connection. */
  connection(): Promise<RpcConnection>;
  subscriber: ShellSubscriber;
  afterSequence: number | null;
  reconnectDelaysMs: number[];
  wait(ms: number): Promise<void>;
}

/** One shell subscription that survives disconnects. */
class ShellStream {
  /** Sequence of the last event delivered; resuming asks T3 for what came after it. */
  private lastSequence: number | null;
  private cancelCurrent: (() => void) | null = null;
  private stopped = false;
  private failedAttempts = 0;
  private connected = false;
  private readonly options: ShellStreamOptions;
  private readonly subscriber: ShellSubscriber;

  constructor(options: ShellStreamOptions) {
    this.options = options;
    this.subscriber = options.subscriber;
    this.lastSequence = options.afterSequence;
  }

  start(): void {
    void this.subscribe();
  }

  stop(): void {
    this.stopped = true;
    this.cancelCurrent?.();
    this.cancelCurrent = null;
  }

  private async subscribe(): Promise<void> {
    if (this.stopped) return;
    let connection: RpcConnection;
    try {
      connection = await this.options.connection();
    } catch (error) {
      if (error instanceof T3IncompatibleError) return this.fail(error);
      if (error instanceof T3HttpError && (error.status === 401 || error.status === 403)) {
        // The token was revoked or expired: retrying won't help, the owner must re-pair.
        return this.fail(
          new Error(
            `T3 refused the companion's token (${error.status}); run "t3-voice setup" again.`,
          ),
        );
      }
      return this.retryLater();
    }
    if (this.stopped) return;

    const usedCursor = this.lastSequence !== null;
    const payload = usedCursor ? { afterSequence: this.lastSequence } : {};
    // An error before the first item is T3 refusing the request; after it, the stream broke.
    let accepted = false;
    this.cancelCurrent = connection.stream(METHODS.subscribeShell, payload, {
      onValue: (item) => {
        accepted = true;
        this.handleItem(item);
      },
      onEnd: (error) => {
        this.cancelCurrent = null;
        if (this.stopped) return;
        if (error instanceof RpcError && !accepted && usedCursor) {
          // T3 refused to resume from our cursor: start over from a fresh snapshot.
          this.lastSequence = null;
          void this.subscribe();
        } else if (error instanceof RpcError && !accepted) {
          // T3 refused a plain subscription (missing scope, changed schema...): retrying won't help.
          this.fail(new Error(`T3 refused the shell subscription: ${error.message}`));
        } else {
          this.retryLater();
        }
      },
    });
  }

  private handleItem(item: unknown): void {
    if (this.stopped) return;
    if (!this.connected) {
      this.connected = true;
      this.failedAttempts = 0;
      this.subscriber.onConnectionChange?.("connected");
    }
    const event = toShellEvent(item);
    if (!event || this.isReplayedEvent(event)) return;
    this.lastSequence = event.sequence;
    this.subscriber.onEvent(event);
  }

  /** Replay and live events can overlap after a resume; T3 says to dedupe by sequence. */
  private isReplayedEvent(event: ShellEvent): boolean {
    if (event.type === "snapshot") return false;
    return this.lastSequence !== null && event.sequence <= this.lastSequence;
  }

  private retryLater(): void {
    if (this.stopped) return;
    if (this.connected) {
      this.connected = false;
      this.subscriber.onConnectionChange?.("reconnecting");
    }
    const delays = this.options.reconnectDelaysMs;
    const delay = delays[Math.min(this.failedAttempts, delays.length - 1)] ?? 1_000;
    this.failedAttempts += 1;
    void this.options.wait(delay).then(() => this.subscribe());
  }

  private fail(error: Error): void {
    this.stopped = true;
    this.subscriber.onFatalError?.(error);
  }
}

function sleep(ms: number): Promise<void> {
  // Unref'd: a pending retry alone must not keep a finished CLI command alive.
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** Rejects when T3 has not answered in time, after calling `onTimeout` to clean up. */
function withTimeout<T>(answer: Promise<T>, what: string, onTimeout = () => {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`T3 did not send ${what} in time.`));
    }, ANSWER_TIMEOUT_MS);
    answer.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
