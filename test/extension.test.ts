import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as typebox from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import extension from "../src/extension.js";
import type { Json, Question, Rule } from "../src/types.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface Payload {
	state: Json;
	questions: Record<string, Question>;
}
interface HookResult {
	input: { tasks: { agent?: string }[] };
	block: boolean;
	reason: string;
	continue: boolean;
	additionalContext: string;
}
interface FixtureEntry {
	type: "message";
	message: {
		role: string;
		timestamp: number;
		content: (
			| { type: "text"; text: string }
			| { type: "thinking"; thinking: string }
		)[];
	};
}
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function harness(
	options: {
		config?: object;
		rules?: Rule[];
		choices?: Record<string, string>;
		confidence?: number;
		fail?: boolean;
	} = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "omp-jev-test-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const keyEnv = `OMP_JEV_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
	process.env[keyEnv] = "test-secret";
	cleanup.push(() => {
		delete process.env[keyEnv];
	});
	const requests: Payload[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const payload = (await request.json()) as Payload;
			requests.push(payload);
			if (options.fail)
				return new Response("private server error", { status: 503 });
			const answers = Object.fromEntries(
				Object.entries(payload.questions).map(([id, question]) => {
					if (question.type === "noul")
						return [id, { type: "noul", noul: 0.99 }];
					if (question.type !== "choice")
						throw new Error("Unexpected question");
					const labels = Object.keys(question.criteria);
					const choice =
						options.choices?.[id] ?? (id === "safety" ? "allow" : labels[0]);
					return [
						id,
						{
							type: "choice",
							choice,
							confidence: options.confidence ?? 0.99,
							probabilities: Object.fromEntries(
								labels.map((label) => [
									label,
									label === choice ? 0.99 : 0.01 / (labels.length - 1),
								]),
							),
						},
					];
				}),
			);
			return Response.json({ model: "test-jev", answers });
		},
	});
	cleanup.push(() => {
		server.stop(true);
	});
	await mkdir(join(dir, ".omp"));
	await writeFile(
		join(dir, ".omp", "jev.json"),
		JSON.stringify({
			client: {
				endpoint: `http://127.0.0.1:${server.port}/v1/systemone`,
				apiKeyEnv: keyEnv,
			},
			...options.config,
		}),
	);
	if (options.rules)
		await writeFile(
			join(dir, ".jevrules"),
			JSON.stringify({ version: 1, rules: options.rules }),
		);
	const handlers: Record<string, Handler> = {};
	const levels: string[] = [];
	const messages: unknown[] = [];
	let reminders = true;
	const api = {
		typebox,
		pi: {
			getAgentDir: () => join(dir, "global"),
			settings: {
				get: () => reminders,
				override: (_key: string, value: boolean) => {
					reminders = value;
				},
			},
		},
		on: (name: string, fn: Handler) => {
			handlers[name] = fn;
		},
		registerTool: () => {},
		registerCommand: () => {},
		setThinkingLevel: (level: string) => levels.push(level),
		sendMessage: (message: unknown) => messages.push(message),
	} as unknown as ExtensionAPI;
	const branch: FixtureEntry[] = [
		{
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "Do the authorized task" }],
				timestamp: 1,
			},
		},
	];
	const ctx = {
		cwd: dir,
		hasUI: true,
		mode: "print",
		ui: { notify() {} },
		model: { id: "test", provider: "local", reasoning: true },
		sessionManager: {
			getSessionId: () => "test-session",
			getBranch: () => branch,
		},
		getContextUsage: () => undefined,
		getAsyncJobSnapshot: () => null,
		hasPendingMessages: () => false,
		getSystemPrompt: () => ["private system prompt"],
	} as unknown as ExtensionContext;
	extension(api);
	// This fixture invokes known extension callbacks; each assertion exercises its event's result shape.
	const run = async (name: string, event: object = {}): Promise<HookResult> =>
		(await handlers[name]({ type: name, ...event }, ctx)) as HookResult;
	await run("session_start");
	return {
		run,
		requests,
		levels,
		messages,
		branch,
		ctx,
		reminders: () => reminders,
	};
}

describe("extension policy consequences", () => {
	test("reroutes eligible batch tasks but preserves explicit and specialist agents", async () => {
		const h = await harness({
			choices: { delegate_0: "slow", delegate_3: "smol" },
		});
		const input = {
			context: "Independent work",
			tasks: [
				{ task: "Diagnose a hard race" },
				{ task: "Review security", agent: "reviewer" },
				{ task: "Cheap edit", agent: "smol" },
				{ task: "Mechanical edit" },
			],
		};
		const result = await h.run("tool_call", { toolName: "task", input });
		expect(result.input.tasks.map((task) => task.agent)).toEqual([
			"slow",
			"reviewer",
			"smol",
			"smol",
		]);
		expect(input.tasks[0]).not.toHaveProperty("agent");
		expect(h.requests[0].state).toMatchObject({
			event: { input: { context: "Independent work" } },
		});
	});

	test("uncertainty retains thinking and delegation but blocks selected unsafe execution", async () => {
		const h = await harness({
			confidence: 0.2,
			config: { safety: { tools: ["bash"] } },
		});
		await h.run("before_agent_start", { prompt: "Task" });
		expect(h.levels).toEqual([]);
		expect(
			await h.run("tool_call", {
				toolName: "task",
				input: { tasks: [{ task: "Task" }] },
			}),
		).toBeUndefined();
		const result = await h.run("tool_call", {
			toolName: "bash",
			input: { command: "rm -rf data" },
		});
		expect(result.block).toBe(true);
		expect(result.reason).toContain("uncertain");
	});

	test("failed safety service never turns into implicit permission", async () => {
		const h = await harness({ fail: true });
		const result = await h.run("tool_call", {
			toolName: "bash",
			input: { command: "delete data" },
		});
		expect(result.block).toBe(true);
		expect(result.reason).not.toContain("private server error");
	});

	test("blocking user rules cannot be bypassed by retrying within a cooldown", async () => {
		const h = await harness({
			config: { safety: { enabled: false } },
			rules: [
				{
					id: "no-publish",
					events: ["tool_call"],
					tools: ["bash"],
					question: {
						type: "noul",
						instructions: "Is this a publish operation?",
					},
					outcomes: [
						{
							when: { min: 0.9 },
							action: { type: "block", message: "No publishing" },
						},
					],
					cooldownTurns: 10,
				},
			],
		});
		const event = { toolName: "bash", input: { command: "npm publish" } };
		expect((await h.run("tool_call", event)).block).toBe(true);
		expect((await h.run("tool_call", event)).block).toBe(true);
	});

	test("stop guidance is bounded and aborts never start a continuation", async () => {
		const h = await harness({ choices: { recovery: "rescuer" } });
		const event = {
			stop_hook_active: false,
			signal: new AbortController().signal,
		};
		expect(h.reminders()).toBe(false);
		expect((await h.run("session_stop", event)).additionalContext).toContain(
			"slow-rescuer",
		);
		expect(
			(await h.run("session_stop", { ...event, stop_hook_active: true }))
				.continue,
		).toBe(true);
		expect(
			await h.run("session_stop", { ...event, stop_hook_active: true }),
		).toBeUndefined();
		expect(
			await h.run("session_stop", { ...event, signal: AbortSignal.abort() }),
		).toBeUndefined();
		await h.run("session_shutdown");
		expect(h.reminders()).toBe(true);
	});

	test("state redacts secrets and does not send hidden reasoning or system prompt", async () => {
		const h = await harness();
		h.branch.push({
			type: "message",
			message: {
				role: "assistant",
				timestamp: 2,
				content: [
					{ type: "thinking", thinking: "hidden reasoning" },
					{ type: "text", text: "Visible progress" },
				],
			},
		});
		await h.run("tool_call", {
			toolName: "bash",
			input: { command: "echo test-secret", token: "private-token" },
		});
		const state = JSON.stringify(h.requests[0].state);
		expect(state).toContain("Visible progress");
		expect(state).not.toContain("test-secret");
		expect(state).not.toContain("private-token");
		expect(state).not.toContain("hidden reasoning");
		expect(state).not.toContain("private system prompt");
	});
});
