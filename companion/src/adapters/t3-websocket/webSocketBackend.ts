// T3Backend adapter over T3's app protocol: `/ws`, orchestration protocol 2, one
// short-lived `wsTicket` per socket.

import {
  type LaunchThreadRequest,
  type Project,
  type RepositoryInfo,
  type SendMessageRequest,
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
import {
  ConnectionClosedError,
  openRpcConnection,
  type RpcConnection,
  RpcError,
} from "./rpcConnection.ts";
import {
  runOfMessage,
  runsToStop,
  toConfig,
  toLaunchThreadInput,
  toMessageDispatch,
  toRepositoryInfo,
  toShellEvent,
  type WireJson,
} from "./wire.ts";

const METHODS = {
  getConfig: "server.getConfig",
  subscribeShell: "orchestration.subscribeShell",
  listRefs: "vcs.listRefs",
  launchThread: "orchestration.launchThread",
  dispatchCommand: "orchestration.dispatchCommand",
  getThreadProjection: "orchestration.getThreadProjection",
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

  async inspectRepository(path: string): Promise<RepositoryInfo> {
    const answer = await this.call(METHODS.listRefs, { cwd: path }, "the repository's branches");
    return toRepositoryInfo(answer);
  }

  async launchThread(request: LaunchThreadRequest): Promise<{ threadId: string }> {
    const answer: WireJson = await this.command(
      METHODS.launchThread,
      toLaunchThreadInput(request),
      "the new thread",
    );
    if (typeof answer?.threadId !== "string") {
      throw new Error("T3 started no thread: its answer has no thread id.");
    }
    return { threadId: answer.threadId };
  }

  async sendMessage(request: SendMessageRequest): Promise<void> {
    await this.dispatch(toMessageDispatch(request));
  }

  async cancelQueuedMessage(
    commandId: string,
    threadId: string,
    messageId: string,
  ): Promise<boolean> {
    // T3 does not return the id of the run that waits with the message: read it back.
    const run = runOfMessage(await this.projection(threadId), messageId);
    // Cancelled already: an earlier try whose answer was lost took it back.
    if (run?.status === "cancelled") return true;
    if (run?.status !== "queued") return false;
    await this.dispatch({ type: "queued-run.cancel", commandId, threadId, runId: run.id });
    return true;
  }

  async stopThread(commandId: string, threadId: string): Promise<void> {
    // T3 0.1.0 has no `thread.stop` command: interrupt the active run and cancel the
    // queued ones, which both versions know. Each command gets its own id, derived from
    // `commandId` so that a retry sends the same ones.
    const { active, queued } = runsToStop(await this.projection(threadId));
    for (const runId of queued) {
      await this.dispatch({
        type: "queued-run.cancel",
        commandId: `${commandId}:${runId}`,
        threadId,
        runId,
      });
    }
    if (active !== null) {
      await this.dispatch({ type: "run.interrupt", commandId, threadId, runId: active });
    }
  }

  async archiveThread(commandId: string, threadId: string): Promise<void> {
    await this.dispatch({ type: "thread.archive", commandId, threadId });
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

  private projection(threadId: string): Promise<WireJson> {
    return this.call(METHODS.getThreadProjection, { threadId }, "the thread's runs");
  }

  /** One request that reads only: no retry needed beyond the caller's. */
  private async call(tag: string, payload: unknown, what: string): Promise<WireJson> {
    const connection = await this.connection();
    return withTimeout(connection.request(tag, payload), what);
  }

  /**
   * A command carrying a `commandId`. When the socket drops or T3 does not answer in time,
   * the command may or may not have run: it is sent once more with the same id, which T3
   * runs at most once.
   */
  private async command(tag: string, payload: unknown, what: string): Promise<WireJson> {
    try {
      return await this.call(tag, payload, what);
    } catch (error) {
      if (!(error instanceof ConnectionClosedError || error instanceof AnswerTimeoutError)) {
        throw error;
      }
      return this.call(tag, payload, what);
    }
  }

  private dispatch(command: WireJson): Promise<WireJson> {
    return this.command(METHODS.dispatchCommand, command, "an answer to the command");
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

class AnswerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerTimeoutError";
  }
}

/** Rejects when T3 has not answered in time, after calling `onTimeout` to clean up. */
function withTimeout<T>(answer: Promise<T>, what: string, onTimeout = () => {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new AnswerTimeoutError(`T3 did not send ${what} in time.`));
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
