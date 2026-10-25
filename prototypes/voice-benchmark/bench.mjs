// PROTOTYPE — throwaway. Answers ticket #12: which OpenAI voice engine is good enough in French
// with English technical terms, how fast it answers, and what a mostly-idle session costs.
//
//   node bench.mjs synth                      # make the input audio from phrases.json (once)
//   node bench.mjs turns [--input synthetic] [--engines a,b,c]
//   node bench.mjs idle  [--minutes 30]  [--engines a,b,c]
//
// Engines: realtime:gpt-realtime-2.1, realtime:gpt-realtime-2.1-mini, live:gpt-live-1
// The OpenAI key is read from $OPENAI_API_KEY or ~/.config/t3voice/openai.env. It is never printed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RATE = 24000; // PCM16 mono
const BYTES_PER_MS = (RATE * 2) / 1000;
const DEFAULT_ENGINES = ["realtime:gpt-realtime-2.1", "realtime:gpt-realtime-2.1-mini", "live:gpt-live-1"];
const VOICE = "marin";
const SYNTH_VOICE = "cedar";

// $ per 1M tokens, from research/voice-engine.md. Cached text is priced like cached audio (rough).
const PRICES = {
  "gpt-realtime-2.1": { audioIn: 32, cachedIn: 0.4, audioOut: 64, textIn: 4, textOut: 24 },
  "gpt-realtime-2.1-mini": { audioIn: 10, cachedIn: 0.3, audioOut: 20, textIn: 0.6, textOut: 2.4 },
};
const LIVE_PRICE_PER_MIN = 0.05;

const INSTRUCTIONS = `Tu es l'assistant vocal d'un développeur qui pilote des agents de code.
Tu parles français. Les noms techniques (fichiers, branches, commandes, outils) restent en anglais, prononcés à l'anglaise.
Pour chaque demande, réponds en UNE phrase qui commence par « Compris : » et reformule la demande
en reprenant exactement les noms techniques entendus. N'ajoute rien d'autre.`;

// ---------- utilities ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  const file = path.join(os.homedir(), ".config/t3voice/openai.env");
  const line = fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
  if (!line) throw new Error(`No OPENAI_API_KEY in ${file}`);
  return line.slice("OPENAI_API_KEY=".length).trim();
}

function args() {
  const out = { _: process.argv[2] };
  for (let i = 3; i < process.argv.length; i += 2) out[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  return out;
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function readWavPcm(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF") return buf; // raw PCM
  if (buf.readUInt32LE(24) !== RATE || buf.readUInt16LE(22) !== 1 || buf.readUInt16LE(34) !== 16) {
    throw new Error(`${file}: expected 24 kHz mono 16-bit WAV`);
  }
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size;
  }
  throw new Error(`${file}: no data chunk`);
}

/** Trims leading/trailing silence so "end of speech" is the real end of the words. */
function trim(pcm, threshold = 500) {
  const samples = pcm.length / 2;
  let a = 0, b = samples - 1;
  while (a < samples && Math.abs(pcm.readInt16LE(a * 2)) < threshold) a++;
  while (b > a && Math.abs(pcm.readInt16LE(b * 2)) < threshold) b--;
  const pad = RATE / 20; // keep 50 ms
  return pcm.subarray(Math.max(0, a - pad) * 2, Math.min(samples, b + pad) * 2);
}

const silence = (ms) => Buffer.alloc(Math.round(ms * BYTES_PER_MS));

/** Streams PCM in real time (20 ms chunks), like a microphone would. */
async function stream(session, pcm, chunkMs = 20) {
  const chunk = chunkMs * BYTES_PER_MS, start = now();
  for (let i = 0, off = 0; off < pcm.length; i++, off += chunk) {
    session.sendAudio(pcm.subarray(off, off + chunk));
    const wait = start + (i + 1) * chunkMs - now();
    if (wait > 0) await sleep(wait);
  }
}

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const termHits = (terms, transcript) => terms.map((t) => ({ term: t, ok: norm(transcript).includes(norm(t)) }));

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

// ---------- engines ----------

/**
 * Common shape: emits "audio" (Buffer), "transcript" (text delta), "speechStopped", "responseDone",
 * "log" (string). Methods: sendAudio, say(text), close() -> usage summary.
 */
class RealtimeEngine extends EventEmitter {
  constructor(key, model, { vad = true, voice = VOICE, instructions = INSTRUCTIONS } = {}) {
    super();
    this.name = `realtime:${model}`;
    this.model = model;
    this.usage = { inputAudio: 0, inputText: 0, cachedAudio: 0, cachedText: 0, outputAudio: 0, outputText: 0 };
    this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    this.config = { vad, voice, instructions };
  }

  async open() {
    await new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); });
    this.ws.on("message", (raw) => this.#onEvent(JSON.parse(raw)));
    this.ws.on("close", (code, reason) => this.emit("log", `closed ${code} ${reason}`));
    const ready = new Promise((r) => this.once("_updated", r));
    this.#send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.config.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: RATE },
            turn_detection: this.config.vad ? { type: "semantic_vad", eagerness: "high" } : null,
          },
          output: { format: { type: "audio/pcm", rate: RATE }, voice: this.config.voice },
        },
      },
    });
    await ready;
  }

  #send(event) { this.ws.send(JSON.stringify(event)); }

  #onEvent(e) {
    switch (e.type) {
      case "session.updated": this.emit("_updated"); break;
      case "response.output_audio.delta": this.emit("audio", Buffer.from(e.delta, "base64")); break;
      case "response.output_audio_transcript.delta": this.emit("transcript", e.delta); break;
      case "input_audio_buffer.speech_started": this.emit("speechStarted"); break;
      case "input_audio_buffer.speech_stopped": this.emit("speechStopped"); break;
      case "response.done": {
        const u = e.response?.usage ?? {}, i = u.input_token_details ?? {}, c = i.cached_tokens_details ?? {}, o = u.output_token_details ?? {};
        this.usage.inputAudio += i.audio_tokens ?? 0;
        this.usage.inputText += i.text_tokens ?? 0;
        this.usage.cachedAudio += c.audio_tokens ?? 0;
        this.usage.cachedText += c.text_tokens ?? 0;
        this.usage.outputAudio += o.audio_tokens ?? 0;
        this.usage.outputText += o.text_tokens ?? 0;
        this.emit("responseDone", e.response?.status);
        break;
      }
      case "error": this.emit("log", `ERROR ${e.error?.message ?? JSON.stringify(e)}`); break;
    }
  }

  sendAudio(pcm) { this.#send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }); }

  say(text) {
    this.#send({ type: "response.create", response: { instructions: `Dis exactement ceci, en français, puis tais-toi : « ${text} »` } });
  }

  sendText(text) {
    this.#send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.#send({ type: "response.create" });
  }

  cost() {
    const p = PRICES[this.model], u = this.usage;
    if (!p) return null;
    return ((u.inputAudio - u.cachedAudio) * p.audioIn + (u.cachedAudio + u.cachedText) * p.cachedIn
      + (u.inputText - u.cachedText) * p.textIn + u.outputAudio * p.audioOut + u.outputText * p.textOut) / 1e6;
  }

  cacheHitRate() {
    const input = this.usage.inputAudio + this.usage.inputText;
    return input ? (this.usage.cachedAudio + this.usage.cachedText) / input : null;
  }

  async close() { this.ws.close(); }
}

class LiveEngine extends EventEmitter {
  constructor(key, model) {
    super();
    this.name = `live:${model}`;
    this.model = model;
    this.usage = null;
    this.openedAt = null;
    this.seenTypes = new Set();
    this.ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${key}` } });
  }

  async open() {
    await new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); });
    this.ws.on("message", (raw) => this.#onEvent(JSON.parse(raw)));
    this.ws.on("close", (code, reason) => this.emit("log", `closed ${code} ${reason}`));
    const ready = new Promise((r) => this.once("_started", r));
    this.#send({
      type: "session.start",
      event_id: "start-1",
      session: {
        model: this.model,
        instructions: INSTRUCTIONS,
        audio: { format: { type: "audio/pcm", rate: RATE }, output: { voice: VOICE } },
      },
    });
    await ready;
    this.openedAt = now();
  }

  #send(event) { this.ws.send(JSON.stringify(event)); }

  #onEvent(e) {
    if (!this.seenTypes.has(e.type)) { this.seenTypes.add(e.type); this.emit("log", `first ${e.type}`); }
    switch (e.type) {
      case "session.started": this.emit("_started"); break;
      case "session.output_audio.delta": this.emit("audio", Buffer.from(e.delta, "base64")); break;
      case "session.output_transcript.delta": this.emit("transcript", e.delta); break;
      case "session.closed": this.usage = e.usage ?? this.usage; this.emit("_closed"); break;
      case "error": this.emit("log", `ERROR ${e.error?.message ?? JSON.stringify(e)}`); break;
      default: if (e.usage) this.usage = e.usage; // cumulative snapshots
    }
  }

  sendAudio(pcm) { this.#send({ type: "session.input_audio.append", audio: pcm.toString("base64") }); }

  say(text) { this.#send({ type: "session.instructions.append", instructions: `Dis exactement ceci, puis tais-toi : « ${text} »` }); }

  cost() { return this.openedAt ? ((now() - this.openedAt) / 60000) * LIVE_PRICE_PER_MIN : null; }

  cacheHitRate() { return null; }

  async close() {
    const closed = new Promise((r) => { this.once("_closed", r); setTimeout(r, 5000); });
    this.#send({ type: "session.close" });
    await closed;
    this.ws.close();
  }
}

function makeEngine(key, spec, opts) {
  const [kind, model] = spec.split(":");
  return kind === "live" ? new LiveEngine(key, model) : new RealtimeEngine(key, model, opts);
}

/**
 * Collects one spoken answer. Realtime ends on response.done; GPT-Live has no end event,
 * so the answer ends after `quietMs` without audio.
 */
function collectAnswer(engine, { quietMs = 1500, timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const audio = [];
    let transcript = "", firstAudioAt = null, speechStoppedAt = null, quietTimer = null;
    const finish = () => {
      clearTimeout(quietTimer); clearTimeout(hardTimer);
      engine.off("audio", onAudio); engine.off("transcript", onText);
      engine.off("responseDone", onDone); engine.off("speechStopped", onStopped);
      resolve({ pcm: Buffer.concat(audio), transcript, firstAudioAt, speechStoppedAt });
    };
    const onAudio = (b) => {
      firstAudioAt ??= now();
      audio.push(b);
      if (engine instanceof LiveEngine) { clearTimeout(quietTimer); quietTimer = setTimeout(finish, quietMs); }
    };
    const onText = (t) => { transcript += t; };
    const onDone = () => finish();
    const onStopped = () => { speechStoppedAt ??= now(); };
    const hardTimer = setTimeout(finish, timeoutMs);
    engine.on("audio", onAudio); engine.on("transcript", onText);
    engine.on("responseDone", onDone); engine.on("speechStopped", onStopped);
  });
}

// ---------- commands ----------

const phrases = JSON.parse(fs.readFileSync(path.join(HERE, "phrases.json"), "utf8"));
const pad2 = (n) => String(n + 1).padStart(2, "0");

/** Synthetic inputs, read by a Realtime voice that is not the one under test. */
async function synth(key) {
  const dir = path.join(HERE, "inputs/synthetic");
  fs.mkdirSync(dir, { recursive: true });
  const engine = makeEngine(key, "realtime:gpt-realtime-2.1", {
    vad: false,
    voice: SYNTH_VOICE,
    instructions: "Tu es une machine de lecture. Lis le texte fourni mot pour mot, d'un ton naturel de développeur français. Les termes techniques anglais se prononcent à l'anglaise. N'ajoute rien.",
  });
  engine.on("log", (l) => console.log(`[synth] ${l}`));
  await engine.open();
  for (const [i, turn] of phrases.turns.entries()) {
    const answer = collectAnswer(engine);
    engine.sendText(`Lis exactement : ${turn.text}`);
    const { pcm, transcript } = await answer;
    fs.writeFileSync(path.join(dir, `${pad2(i)}.wav`), wav(trim(pcm)));
    console.log(`[synth] ${pad2(i)} ${(pcm.length / BYTES_PER_MS / 1000).toFixed(1)}s "${transcript}"`);
  }
  await engine.close();
  console.log(`Synthetic inputs written to ${dir}. Listen to a few before running "turns".`);
}

async function turns(key, spec, inputSet, outDir) {
  const dir = path.join(outDir, spec.replace(":", "_"));
  fs.mkdirSync(dir, { recursive: true });
  const engine = makeEngine(key, spec, {});
  const log = (l) => console.log(`[${spec}] ${l}`);
  engine.on("log", log);
  await engine.open();
  await stream(engine, silence(1000));
  const results = [];
  for (const [i, turn] of phrases.turns.entries()) {
    const pcm = trim(readWavPcm(path.join(HERE, "inputs", inputSet, `${pad2(i)}.wav`)));
    const answer = collectAnswer(engine);
    await stream(engine, pcm);
    const speechEnd = now();
    const tail = stream(engine, silence(3000));
    const a = await answer;
    await tail;
    const latency = a.firstAudioAt ? Math.round(a.firstAudioAt - speechEnd) : null;
    const vadDelay = a.speechStoppedAt ? Math.round(a.speechStoppedAt - speechEnd) : null;
    const hits = termHits(turn.terms, a.transcript);
    fs.writeFileSync(path.join(dir, `turn-${pad2(i)}.wav`), wav(a.pcm));
    results.push({ i: i + 1, latency, vadDelay, transcript: a.transcript, hits });
    log(`turn ${pad2(i)} latency=${latency}ms vad=${vadDelay}ms terms=${hits.filter((h) => h.ok).length}/${hits.length} "${a.transcript}"`);
    await stream(engine, silence(1000));
  }
  for (const [i, text] of phrases.announcements.entries()) {
    const answer = collectAnswer(engine);
    engine.say(text);
    const keepAlive = stream(engine, silence(1000));
    const a = await answer;
    await keepAlive;
    fs.writeFileSync(path.join(dir, `announcement-${pad2(i)}.wav`), wav(a.pcm));
    log(`announcement ${pad2(i)} "${a.transcript}"`);
  }
  const cost = engine.cost(), cacheHitRate = engine.cacheHitRate();
  await engine.close();
  const latencies = results.map((r) => r.latency).filter((x) => x != null);
  const allHits = results.flatMap((r) => r.hits);
  return {
    engine: spec,
    termAccuracy: allHits.filter((h) => h.ok).length / allHits.length,
    missedTerms: results.flatMap((r) => r.hits.filter((h) => !h.ok).map((h) => `${r.i}:${h.term}`)),
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    cost,
    cacheHitRate,
    usage: engine.usage,
    results,
  };
}

/** A mostly-idle session: silence streamed like an open mic, 3 user turns, an announcement every 5 min. */
async function idle(key, spec, minutes, inputSet, outDir) {
  const engine = makeEngine(key, spec, {});
  const log = (l) => console.log(`[${spec}] ${l}`);
  engine.on("log", log);
  await engine.open();
  const start = now(), end = start + minutes * 60000;
  const turnsAt = [2, 12, 22].filter((m) => m < minutes);
  let nextAnnouncement = 5, announcementIndex = 0, turnIndex = 0;
  while (now() < end) {
    const minute = (now() - start) / 60000;
    if (turnIndex < turnsAt.length && minute >= turnsAt[turnIndex]) {
      const pcm = trim(readWavPcm(path.join(HERE, "inputs", inputSet, `${pad2(turnIndex)}.wav`)));
      await stream(engine, pcm);
      log(`user turn ${turnIndex + 1} at ${minute.toFixed(1)} min`);
      turnIndex++;
    } else if (minute >= nextAnnouncement) {
      engine.say(phrases.announcements[announcementIndex++ % phrases.announcements.length]);
      log(`announcement at ${minute.toFixed(1)} min, cost so far $${engine.cost()?.toFixed(4)}`);
      nextAnnouncement += 5;
    }
    await stream(engine, silence(1000), 100);
  }
  const cost = engine.cost(), cacheHitRate = engine.cacheHitRate();
  await engine.close();
  const result = { engine: spec, minutes, cost, costPerHour: cost != null ? (cost * 60) / minutes : null, cacheHitRate, usage: engine.usage };
  fs.writeFileSync(path.join(outDir, `idle-${spec.replace(":", "_")}.json`), JSON.stringify(result, null, 2));
  return result;
}

// ---------- main ----------

const a = args();
const key = loadKey();
const engines = (a.engines ?? DEFAULT_ENGINES.join(",")).split(",");
const inputSet = a.input ?? "synthetic";
const outDir = path.join(HERE, "out", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));

if (a._ === "synth") {
  await synth(key);
} else if (a._ === "turns") {
  fs.mkdirSync(outDir, { recursive: true });
  const settled = await Promise.allSettled(engines.map((e) => turns(key, e, inputSet, outDir)));
  const summary = settled.map((s, i) => s.status === "fulfilled" ? s.value : { engine: engines[i], error: String(s.reason) });
  fs.writeFileSync(path.join(outDir, "turns.json"), JSON.stringify(summary, null, 2));
  console.table(summary.map((s) => ({
    engine: s.engine,
    terms: s.termAccuracy != null ? `${Math.round(s.termAccuracy * 100)}%` : s.error,
    p50: s.latencyP50, p95: s.latencyP95,
    cost: s.cost?.toFixed(4), cache: s.cacheHitRate != null ? `${Math.round(s.cacheHitRate * 100)}%` : "",
  })));
  console.log(`Audio and details in ${outDir}`);
} else if (a._ === "idle") {
  fs.mkdirSync(outDir, { recursive: true });
  const minutes = Number(a.minutes ?? 30);
  const settled = await Promise.allSettled(engines.map((e) => idle(key, e, minutes, inputSet, outDir)));
  console.table(settled.map((s, i) => s.status === "fulfilled"
    ? { engine: s.value.engine, cost: s.value.cost?.toFixed(4), perHour: s.value.costPerHour?.toFixed(3), cache: s.value.cacheHitRate != null ? `${Math.round(s.value.cacheHitRate * 100)}%` : "" }
    : { engine: engines[i], error: String(s.reason) }));
} else {
  console.log("usage: node bench.mjs synth | turns | idle   (see header)");
}
process.exit(0);
