// A minimal client for T3's WebSocket RPC (Effect RPC with JSON serialization).
//
// Wire format, checked against T3 0.1.0 and 0.1.1:
//   client → server  {_tag:"Request", id, tag, payload, headers:[]}
//                    {_tag:"Ack", requestId}            after each stream chunk
//                    {_tag:"Interrupt", requestId, interruptors:[]}   cancels a stream
//                    {_tag:"Ping"}
//   server → client  {_tag:"Chunk", requestId, values:[...]}          stream items
//                    {_tag:"Exit", requestId, exit:{_tag:"Success", value} | {_tag:"Failure", cause}}
//                    {_tag:"Pong"}, {_tag:"Defect", defect}

import type { WireJson } from "./wire.ts";

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export class ConnectionClosedError extends Error {
  constructor() {
    super("The connection to T3 closed.");
    this.name = "ConnectionClosedError";
  }
}

export interface StreamHandlers {
  onValue(value: unknown): void;
  /** Called once when the stream stops: no error when T3 ended it, an error otherwise. */
  onEnd(error?: Error): void;
}

export interface RpcConnection {
  request(tag: string, payload: unknown): Promise<unknown>;
  /** Starts a stream; returns a function that cancels it. */
  stream(tag: string, payload: unknown, handlers: StreamHandlers): () => void;
  onClose(listener: () => void): void;
  close(): void;
}

const OPEN_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 15_000;
/** With no message at all for this long, the socket is considered dead. */
const SILENCE_LIMIT_MS = 45_000;

type Pending =
  | { kind: "request"; resolve(value: unknown): void; reject(error: Error): void }
  | { kind: "stream"; handlers: StreamHandlers };

/** Opens a WebSocket to `url`. The URL carries a ticket, so it is never logged or reported. */
export function openRpcConnection(url: string): Promise<RpcConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const openTimer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out opening the WebSocket to T3."));
    }, OPEN_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve(new SocketRpcConnection(socket));
    });
    socket.addEventListener("error", () => {
      clearTimeout(openTimer);
      // Rejecting an already-resolved promise is a no-op, so this only reports open failures.
      reject(new Error("Could not open the WebSocket to T3 (was the ticket refused?)."));
    });
  });
}

class SocketRpcConnection implements RpcConnection {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly closeListeners: Array<() => void> = [];
  private closed = false;
  private lastMessageAt = Date.now();
  private readonly pingTimer: NodeJS.Timeout;
  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    socket.addEventListener("close", () => this.handleClose());
    this.pingTimer = setInterval(() => this.keepAlive(), PING_INTERVAL_MS);
  }

  request(tag: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new ConnectionClosedError());
      const id = this.send(tag, payload);
      this.pending.set(id, { kind: "request", resolve, reject });
    });
  }

  stream(tag: string, payload: unknown, handlers: StreamHandlers): () => void {
    if (this.closed) {
      handlers.onEnd(new ConnectionClosedError());
      return () => {};
    }
    const id = this.send(tag, payload);
    this.pending.set(id, { kind: "stream", handlers });
    return () => {
      if (!this.pending.delete(id)) return;
      this.write({ _tag: "Interrupt", requestId: id, interruptors: [] });
    };
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): void {
    this.socket.close();
    this.handleClose();
  }

  private send(tag: string, payload: unknown): string {
    const id = String(this.nextId++);
    this.write({ _tag: "Request", id, tag, payload, headers: [] });
    return id;
  }

  private write(message: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private keepAlive(): void {
    if (Date.now() - this.lastMessageAt > SILENCE_LIMIT_MS) {
      this.close();
      return;
    }
    this.write({ _tag: "Ping" });
  }

  private handleMessage(data: string): void {
    this.lastMessageAt = Date.now();
    let message: WireJson;
    try {
      message = JSON.parse(data);
    } catch {
      return; // Not a message we can understand; the stream will resync on its own.
    }

    if (message._tag === "Chunk") {
      const entry = this.pending.get(message.requestId);
      if (entry?.kind !== "stream") return;
      for (const value of message.values ?? []) entry.handlers.onValue(value);
      this.write({ _tag: "Ack", requestId: message.requestId });
    } else if (message._tag === "Exit") {
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      this.pending.delete(message.requestId);
      const failure = message.exit?._tag === "Success" ? null : describeFailure(message.exit);
      if (entry.kind === "request") {
        if (failure) entry.reject(new RpcError(failure));
        else entry.resolve(message.exit.value);
      } else {
        entry.handlers.onEnd(failure ? new RpcError(failure) : undefined);
      }
    } else if (message._tag === "Defect") {
      // A defect without a request id breaks the whole connection.
      this.close();
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.kind === "request") entry.reject(new ConnectionClosedError());
      else entry.handlers.onEnd(new ConnectionClosedError());
    }
    for (const listener of this.closeListeners) listener();
  }
}

/** Turns an Effect `Failure` exit into a short message. */
function describeFailure(exit: WireJson): string {
  const causes: WireJson[] = Array.isArray(exit?.cause) ? exit.cause : [];
  for (const cause of causes) {
    if (cause?._tag === "Fail") {
      const error = cause.error;
      return String(error?.message ?? error?._tag ?? "request failed");
    }
    if (cause?._tag === "Die") return String(cause.defect ?? "server defect");
  }
  if (causes.some((cause) => cause?._tag === "Interrupt")) return "request interrupted";
  return "request failed";
}
