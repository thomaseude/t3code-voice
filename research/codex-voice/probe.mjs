// Spike step 1: can the companion open a Codex voice session with a ChatGPT login?
//
// Spawns `codex app-server`, starts an ephemeral thread (read-only sandbox, no shell, one
// dynamic tool), then `thread/realtime/start` over WebRTC with a hand-written SDP offer.
// Success = OpenAI sends back an SDP answer. No audio flows: the offer's ICE candidates are
// fake, so the call never connects, and the probe stops it after a few seconds.
//
// Usage: node research/codex-voice/probe.mjs
// Prints method names and sizes only: no token, no SDP content.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";

const cwd = mkdtempSync(join(tmpdir(), "codex-voice-probe-"));
const server = spawn("codex", ["app-server"], {
	cwd,
	stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
const seen = [];
let resolveSdp;
const sdpAnswer = new Promise((resolve) => {
	resolveSdp = resolve;
});

function request(method, params) {
	const id = nextId++;
	server.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
	);
	return new Promise((resolve, reject) =>
		pending.set(id, { resolve, reject, method }),
	);
}

function notify(method, params) {
	server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

createInterface({ input: server.stdout }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id !== undefined && pending.has(message.id)) {
		const { resolve, reject, method } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(`${method}: ${message.error.message}`));
		else resolve(message.result);
		return;
	}
	if (!message.method) return;
	seen.push(message.method);
	if (message.method === "thread/realtime/sdp")
		resolveSdp({ sdp: message.params.sdp });
	if (message.method === "thread/realtime/error") {
		console.log(`realtime error: ${message.params.message}`);
		resolveSdp({ error: message.params.message });
	}
	if (message.method === "thread/realtime/closed") {
		console.log(`realtime closed: ${message.params.reason}`);
	}
});

function fakeOffer() {
	const ufrag = randomBytes(4).toString("hex");
	const pwd = randomBytes(12).toString("hex");
	const fingerprint = Array.from(randomBytes(32), (b) =>
		b.toString(16).padStart(2, "0"),
	)
		.join(":")
		.toUpperCase();
	return [
		"v=0",
		`o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
		"s=-",
		"t=0 0",
		"a=group:BUNDLE 0 1",
		"a=msid-semantic: WMS",
		"m=audio 9 UDP/TLS/RTP/SAVPF 111",
		"c=IN IP4 0.0.0.0",
		"a=rtcp:9 IN IP4 0.0.0.0",
		`a=ice-ufrag:${ufrag}`,
		`a=ice-pwd:${pwd}`,
		"a=ice-options:trickle",
		`a=fingerprint:sha-256 ${fingerprint}`,
		"a=setup:actpass",
		"a=mid:0",
		"a=sendrecv",
		"a=rtcp-mux",
		"a=rtpmap:111 opus/48000/2",
		"a=fmtp:111 minptime=10;useinbandfec=1",
		"a=ssrc:1001 cname:probe",
		"m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
		"c=IN IP4 0.0.0.0",
		`a=ice-ufrag:${ufrag}`,
		`a=ice-pwd:${pwd}`,
		"a=ice-options:trickle",
		`a=fingerprint:sha-256 ${fingerprint}`,
		"a=setup:actpass",
		"a=mid:1",
		"a=sctp-port:5000",
		"a=max-message-size:262144",
		"",
	].join("\r\n");
}

const timeout = (ms, label) =>
	new Promise((_, reject) =>
		setTimeout(() => reject(new Error(`timeout: ${label}`)), ms),
	);

let threadId;
try {
	const init = await request("initialize", {
		clientInfo: { name: "t3-voice-probe", title: null, version: "0.0.0" },
		capabilities: { experimentalApi: true, requestAttestation: false },
	});
	notify("initialized");
	console.log(`initialize ok (${Object.keys(init ?? {}).join(", ")})`);

	const started = await request("thread/start", {
		cwd,
		ephemeral: true,
		sandbox: "read-only",
		approvalPolicy: "never",
		config: { features: { shell_tool: false } },
		developerInstructions:
			"You are the brain of a voice assistant. Use only your tools.",
		dynamicTools: [
			{
				type: "function",
				name: "list_tasks",
				description: "Lists the tasks the user follows.",
				inputSchema: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		],
	});
	threadId = started.thread.id;
	console.log("thread/start ok");

	await request("thread/realtime/start", {
		threadId,
		outputModality: "audio",
		transport: { type: "webrtc", sdp: fakeOffer() },
		version: "v3",
		clientManagedHandoffs: true,
	});
	console.log("thread/realtime/start accepted");

	const answer = await Promise.race([sdpAnswer, timeout(20_000, "SDP answer")]);
	if (answer.sdp) {
		const firstLine = answer.sdp.split(/\r?\n/)[0];
		console.log(
			`SDP answer received: ${answer.sdp.length} chars, starts with "${firstLine}"`,
		);
	}
	await new Promise((resolve) => setTimeout(resolve, 3000));
} catch (error) {
	console.log(`FAILED: ${error.message}`);
} finally {
	if (threadId) {
		await Promise.race([
			request("thread/realtime/stop", { threadId }).then(() =>
				console.log("realtime stopped"),
			),
			timeout(5000, "stop"),
		]).catch((error) => console.log(error.message));
	}
	console.log(`notifications seen: ${[...new Set(seen)].join(", ")}`);
	server.kill();
}
