// The real Codex app-server: `codex app-server` spawned as a child process, spoken to in
// JSON-RPC over stdio. It uses the Codex login of the user the companion runs as (a ChatGPT
// login draws voice from the plan's quota, not from an API key).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CodexRpc, WireJson } from "./codexLiveEngine.ts";

export async function startCodexAppServer(): Promise<CodexRpc> {
  // The brain thread runs here: an empty folder, so it sees no project.
  const cwd = mkdtempSync(join(tmpdir(), "t3voice-codex-"));
  const child = spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
  let nextId = 1;
  let exited = false;
  const pending = new Map<number, { resolve: (v: WireJson) => void; reject: (e: Error) => void }>();
  const notificationListeners: Array<(method: string, params: WireJson) => void> = [];
  const requestListeners: Array<
    (method: string, params: WireJson, reply: (result: WireJson) => void) => void
  > = [];
  const exitListeners: Array<() => void> = [];

  const send = (message: WireJson) => {
    if (!exited) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  child.on("exit", () => {
    exited = true;
    rmSync(cwd, { recursive: true, force: true });
    for (const { reject } of pending.values()) reject(new Error("codex app-server exited"));
    pending.clear();
    for (const listener of exitListeners) listener();
  });
  child.on("error", () => child.emit("exit"));

  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: WireJson;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      const reply = (result: WireJson) => send({ id: message.id, result });
      for (const listener of requestListeners) listener(message.method, message.params, reply);
      return;
    }
    if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(String(message.error.message ?? "error")));
      else call?.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of notificationListeners) listener(message.method, message.params);
    }
  });

  const rpc: CodexRpc = {
    request(method, params) {
      if (exited) return Promise.reject(new Error("codex app-server exited"));
      const id = nextId++;
      send({ id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    onNotification: (listener) => notificationListeners.push(listener),
    onRequest: (listener) => requestListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    close: () => child.kill(),
  };

  await rpc.request("initialize", {
    clientInfo: { name: "t3-voice", title: null, version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  send({ method: "initialized" });
  return rpc;
}
