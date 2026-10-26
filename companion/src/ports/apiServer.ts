// The HTTP API as `t3-voice serve` starts it. main.ts plugs the HTTP adapter in.

export interface ApiServerOptions {
  host: string;
  port: number;
  /** Header a local proxy sets to the caller's IP, e.g. "cf-connecting-ip". */
  clientIpHeader?: string;
}

export interface RunningApiServer {
  url: string;
  close(): Promise<void>;
}
