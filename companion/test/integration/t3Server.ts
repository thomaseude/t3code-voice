// Runs a throwaway `t3 serve` for integration tests: its own data directory, its own HOME
// (so no provider is logged in), a free loopback port. It never touches the user's T3.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_T3_PIN } from "../../src/adapters/t3-websocket/compatibility.ts";

const run = promisify(execFile);

/** `T3_BIN`, or the pinned version installed by T3's own installer. */
export function findT3Binary(): string | null {
  const candidates = [
    process.env.T3_BIN,
    join(homedir(), ".t3", "runtime", "versions", DEFAULT_T3_PIN.serverVersions[0] ?? "", "t3"),
  ];
  return candidates.find((path): path is string => Boolean(path && existsSync(path))) ?? null;
}

export class T3TestServer {
  readonly binary: string;
  readonly root: string;
  readonly baseUrl: string;
  private readonly port: number;
  private process: ChildProcess | null = null;
  private logs = "";

  private constructor(binary: string, root: string, port: number) {
    this.binary = binary;
    this.root = root;
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  static async start(binary: string): Promise<T3TestServer> {
    const root = await mkdtemp(join(tmpdir(), "t3voice-it-"));
    await mkdir(join(root, "home"));
    const server = new T3TestServer(binary, root, await freePort());
    await server.startProcess();
    return server;
  }

  get baseDir(): string {
    return join(this.root, "base");
  }

  /** A clean environment: nothing from the T3 that may be running this test leaks in. */
  private env(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: join(this.root, "home"), LANG: "C.UTF-8" };
  }

  async startProcess(): Promise<void> {
    this.process = spawn(
      this.binary,
      [
        "serve",
        "--base-dir",
        this.baseDir,
        "--port",
        String(this.port),
        "--host",
        "127.0.0.1",
        "--no-browser",
      ],
      { cwd: this.root, env: this.env(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const collect = (chunk: Buffer) => {
      this.logs = (this.logs + chunk.toString()).slice(-20_000);
    };
    this.process.stdout?.on("data", collect);
    this.process.stderr?.on("data", collect);
    await this.waitUntilUp();
  }

  async stopProcess(): Promise<void> {
    const child = this.process;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
    this.process = null;
  }

  async restart(): Promise<void> {
    await this.stopProcess();
    await this.startProcess();
  }

  async stop(): Promise<void> {
    await this.stopProcess();
    await rm(this.root, { recursive: true, force: true });
  }

  /** Mints a one-time pairing link, as the server owner would on the host. */
  async createPairingLink(
    scopes = ["orchestration:read", "orchestration:operate"],
  ): Promise<string> {
    const scopeArgs = scopes.flatMap((scope) => ["--scope", scope]);
    const { stdout } = await this.cli([
      "auth",
      "pairing",
      "create",
      "--base-dir",
      this.baseDir,
      ...scopeArgs,
      "--ttl",
      "5m",
      "--base-url",
      this.baseUrl,
      "--json",
    ]);
    return JSON.parse(stdout).pairUrl;
  }

  async addProject(title: string): Promise<string> {
    const path = join(this.root, "projects", title);
    await mkdir(path, { recursive: true });
    await this.cli(["project", "add", "--base-dir", this.baseDir, "--title", title, path]);
    return path;
  }

  private cli(args: string[]) {
    return run(this.binary, args, {
      cwd: this.root,
      env: this.env(),
      timeout: 60_000,
    }).catch((error) => {
      throw new Error(`t3 ${args.slice(0, 3).join(" ")} failed: ${error.stderr ?? error.message}`);
    });
  }

  private async waitUntilUp(): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (this.process?.exitCode !== null) break;
      try {
        // While starting, T3 accepts connections before it answers them.
        const response = await fetch(`${this.baseUrl}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`t3 serve did not start. Last output:\n${this.logs.slice(-3000)}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(),
      );
    });
  });
}
