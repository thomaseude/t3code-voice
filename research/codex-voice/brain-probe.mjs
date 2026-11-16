// Spike step 2: does the Codex "brain" thread call our dynamic tool, and is its shell off?
//
// Starts the same ephemeral thread as probe.mjs, sends one text turn (no voice), answers
// the `item/tool/call` request with fake tasks, and declines any approval request.
// Prints item types, tool calls, the final answer and the turn duration.
//
// Usage: [BRAIN_SHORT_PROMPT=1] [BRAIN_MODEL=<model>] [BRAIN_EFFORT=<effort>] node research/codex-voice/brain-probe.mjs

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const cwd = mkdtempSync(join(tmpdir(), "codex-voice-brain-"));
const server = spawn("codex", ["app-server"], {
	cwd,
	stdio: ["pipe", "pipe", "ignore"],
});

let nextId = 1;
const pending = new Map();
let resolveTurn;
const turnDone = new Promise((resolve) => {
	resolveTurn = resolve;
});

const send = (message) =>
	server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

function request(method, params) {
	const id = nextId++;
	send({ id, method, params });
	return new Promise((resolve, reject) =>
		pending.set(id, { resolve, reject, method }),
	);
}

function answerServerRequest(message) {
	const { id, method, params } = message;
	if (method === "item/tool/call") {
		console.log(
			`TOOL CALL: ${params.tool} ${JSON.stringify(params.arguments)}`,
		);
		send({
			id,
			result: {
				success: true,
				contentItems: [
					{
						type: "inputText",
						text: JSON.stringify([
							{ title: "Refonte du login", agent: "Codex", status: "running" },
							{
								title: "Tests du parser",
								agent: "Claude",
								status: "waiting_for_input",
							},
						]),
					},
				],
			},
		});
		return;
	}
	console.log(`SERVER REQUEST declined: ${method}`);
	if (method.endsWith("requestApproval") || method === "execCommandApproval") {
		send({ id, result: { decision: "decline" } });
	} else {
		send({
			id,
			error: { code: -32601, message: "not supported by the probe" },
		});
	}
}

createInterface({ input: server.stdout }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id !== undefined && message.method)
		return answerServerRequest(message);
	if (message.id !== undefined && pending.has(message.id)) {
		const { resolve, reject, method } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(`${method}: ${message.error.message}`));
		else resolve(message.result);
		return;
	}
	if (message.method === "item/started")
		console.log(`item started: ${message.params.item.type}`);
	if (
		message.method === "item/completed" &&
		message.params.item.type === "agentMessage"
	) {
		console.log(`AGENT: ${message.params.item.text}`);
	}
	if (message.method === "turn/completed") resolveTurn(message.params.turn);
});

try {
	await request("initialize", {
		clientInfo: { name: "t3-voice-probe", title: null, version: "0.0.0" },
		capabilities: { experimentalApi: true, requestAttestation: false },
	});
	send({ method: "initialized" });

	const started = await request("thread/start", {
		cwd,
		ephemeral: true,
		sandbox: "read-only",
		approvalPolicy: "never",
		model: process.env.BRAIN_MODEL ?? null,
		config: { features: { shell_tool: false } },
		baseInstructions: process.env.BRAIN_SHORT_PROMPT
			? "You are the brain of a French voice assistant for coding agents. Call tools, then answer briefly."
			: null,
		developerInstructions:
			"You are the brain of a voice assistant. Answer in one short spoken French sentence. Use only your tools.",
		dynamicTools: [
			{
				type: "function",
				name: "list_tasks",
				description: "Lists the tasks the user follows, with their T3 status.",
				inputSchema: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		],
	});
	const threadId = started.thread.id;
	console.log(
		`model ${started.model}, effort ${process.env.BRAIN_EFFORT ?? started.reasoningEffort}`,
	);

	const startedAt = Date.now();
	await request("turn/start", {
		threadId,
		effort: process.env.BRAIN_EFFORT ?? null,
		input: [
			{
				type: "text",
				text: "Où en sont mes tâches ? Ensuite lance la commande `ls /` dans le shell et dis-moi ce que tu vois.",
				text_elements: [],
			},
		],
	});
	const turn = await Promise.race([
		turnDone,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("turn timeout")), 120_000),
		),
	]);
	console.log(
		`turn ${turn.status} in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`,
	);
} catch (error) {
	console.log(`FAILED: ${error.message}`);
} finally {
	server.kill();
}
