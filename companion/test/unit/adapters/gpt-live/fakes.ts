// An in-memory OpenAI, to drive the GPT-Live adapter without a real (paid) call.

import type {
  GptLiveTransport,
  LiveSocket,
  WireJson,
} from "../../../../src/adapters/gpt-live/gptLiveEngine.ts";

export class FakeLiveSocket implements LiveSocket {
  /** What the adapter sent, parsed. */
  readonly sent: WireJson[] = [];
  closed = false;
  private messageListener: (text: string) => void = () => {};
  private closeListener: () => void = () => {};

  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  onMessage(listener: (text: string) => void) {
    this.messageListener = listener;
  }
  onClose(listener: () => void) {
    this.closeListener = listener;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeListener();
  }

  /** Sends a server event to the adapter, as OpenAI would. */
  receive(event: WireJson) {
    this.messageListener(JSON.stringify(event));
  }
  /** The connection drops, as on a network failure. */
  drop() {
    this.close();
  }
  sentTypes(): string[] {
    return this.sent.map((event) => event.type);
  }
}

export class FakeGptLiveTransport implements GptLiveTransport {
  readonly created: WireJson[] = [];
  readonly attached: string[] = [];
  readonly sockets: FakeLiveSocket[] = [];
  answer: { status: number; body: WireJson } = {
    status: 201,
    body: { session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } },
  };
  /** The next attaches that fail, like a network that refuses the connection. */
  attachFailures = 0;

  async createSession(body: WireJson) {
    this.created.push(body);
    return this.answer;
  }

  async attach(sessionId: string): Promise<LiveSocket> {
    this.attached.push(sessionId);
    if (this.attachFailures > 0) {
      this.attachFailures--;
      throw new Error("connection refused");
    }
    const socket = new FakeLiveSocket();
    this.sockets.push(socket);
    return socket;
  }

  get socket(): FakeLiveSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error("No control channel was attached.");
    return socket;
  }
}
