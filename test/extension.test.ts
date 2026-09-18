import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import * as typebox from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { BUILTIN_TOOLS, Settings } from "@oh-my-pi/pi-coding-agent";
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
					if (question.type === "noul") {
						const state = payload.state as {
							actions?: Array<{ id: string; tool: string }>;
						};
						const action = state.actions?.find((item) => item.id === id);
						return [
							id,
							{
								type: "noul",
								noul: action && action.tool !== "read" ? 0 : 0.99,
							},
						];
					}
					if (question.type !== "choice")
						throw new Error("Unexpected question");
					const labels = Object.keys(question.criteria);
					const state = payload.state as { completedActions?: string[] };
					const scripted = options.choices?.[id];
					const choice =
						scripted === "EXECUTE_SELECTED" &&
						state.completedActions?.some((item) => item.startsWith("read "))
							? "TASK_FINISHED"
							: (scripted ?? (id === "safety" ? "allow" : labels[0]));
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
	const { client: clientOverride, ...configOverride } = (options.config ??
		{}) as { client?: Record<string, unknown> };
	await writeFile(
		join(dir, ".omp", "jev.json"),
		JSON.stringify({
			enabled: true,
			thinking: { enabled: true },
			delegation: { enabled: true },
			safety: { enabled: true },
			nativeRules: { enabled: true },
			recovery: { enabled: true },
			...configOverride,
			client: {
				endpoint: `http://127.0.0.1:${server.port}/v1/systemone`,
				apiKeyEnv: keyEnv,
				...clientOverride,
			},
		}),
	);
	if (options.rules)
		await writeFile(
			join(dir, ".jevrules"),
			JSON.stringify({ version: 1, rules: options.rules }),
		);
	const tools: Record<
		string,
		{
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal?: AbortSignal,
				update?: unknown,
				ctx?: ExtensionContext,
			) => Promise<{ details?: unknown }>;
		}
	> = {};
	const handlers: Record<string, Handler> = {};
	const commands: Record<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<unknown>
	> = {};
	const levels: string[] = [];
	const messages: unknown[] = [];
	const notices: string[] = [];
	const switches: string[] = [];
	const runtimeSettings = Settings.isolated({ "todo.reminders": true });
	let currentModel = { id: "original", provider: "local", reasoning: true };
	const switchModel = async (model: { id: string; provider: string }) => {
		currentModel = {
			...currentModel,
			id: model.id,
			provider: model.provider,
		};
		switches.push(model.id);
		return true;
	};
	const api = {
		typebox,
		pi: {
			BUILTIN_TOOLS,
			Settings,
			getAgentDir: () => join(dir, "global"),
			settings: runtimeSettings,
		},
		on: (name: string, fn: Handler) => {
			handlers[name] = fn;
		},
		registerTool: (spec: unknown) => {
			const tool = spec as { name: string } & (typeof tools)[string];
			tools[tool.name] = tool;
		},
		registerCommand: (
			name: string,
			spec: {
				handler: (args: string, ctx: ExtensionCommandContext) => unknown;
			},
		) => {
			commands[name] = spec.handler as (
				args: string,
				ctx: ExtensionCommandContext,
			) => Promise<unknown>;
		},
		registerMessageRenderer: () => {},
		setThinkingLevel: (level: string) => levels.push(level),
		setModel: switchModel,
		getThinkingLevel: () => "medium",
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
		ui: {
			setWidget: () => {},
			notify: (text: string) => {
				notices.push(text);
			},
		},
		model: { id: "test", provider: "local", reasoning: true },
		models: {
			current: () => currentModel,
			resolve: (id: string) =>
				id === "missing"
					? undefined
					: { id, provider: "local", reasoning: true },
		},
		modelRegistry: {
			resolver: () => "fixture-key",
		},
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "test-session",
			getCwd: () => dir,
			getSessionFile: () => undefined,
			getBranch: () => branch,
		},
		getContextUsage: () => undefined,
		getAsyncJobSnapshot: () => null,
		hasPendingMessages: () => false,
		getSystemPrompt: () => ["private system prompt"],
	} as unknown as ExtensionCommandContext;
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
		commands,
		tools,
		switchModel: async (id: string) => {
			await switchModel({ id, provider: "local" });
		},
		reminders: () => runtimeSettings.get("todo.reminders"),
		notices: () => notices,
		switches: () => switches,
	};
}

describe("extension policy consequences", () => {
	test("disabled plugin leaves native tools, thinking and recovery untouched", async () => {
		const h = await harness({ config: { enabled: false } });
		await h.run("before_agent_start", { prompt: "Implement the task" });
		expect(
			await h.run("tool_call", { toolName: "eval", input: { code: "1 + 1" } }),
		).toBeUndefined();
		expect(
			await h.run("session_stop", {
				signal: new AbortController().signal,
				stop_hook_active: false,
			}),
		).toBeUndefined();
		expect(h.requests).toEqual([]);
		expect(h.levels).toEqual([]);
		expect(h.messages).toEqual([]);
		expect(h.reminders()).toBe(true);
	});
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
			config: { safety: { enabled: true, tools: ["bash"] } },
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

	test("delivered user input pauses an active run while orchestrator stage messages do not", async () => {
		const h = await harness();
		await h.commands.jev("run fix the login bug", h.ctx);
		expect(h.messages[0]).toMatchObject({ customType: "jev-orchestrator" });
		expect(h.switches()).toEqual(["@slow"]);
		// The orchestrator's own checkpoint guidance is delivered as an agent-attributed
		// custom message; it must not cancel the run it drives.
		await h.run("message_start", {
			message: {
				role: "custom",
				customType: "jev-orchestrator",
				content: [{ type: "text", text: "Jev checkpoint 1/8: plan." }],
				display: true,
				attribution: "agent",
				timestamp: 2,
			},
		});
		// Synthetic or agent-attributed user-role deliveries (host continuations) are
		// likewise not user input.
		await h.run("message_start", {
			message: {
				role: "user",
				content: [{ type: "text", text: "auto-continuation" }],
				synthetic: true,
				attribution: "agent",
				timestamp: 3,
			},
		});
		await h.commands.jev("status", h.ctx);
		expect(h.notices().at(-1)).toContain("Orchestrator: plan, stage 1/");
		// RPC prompt/steer/follow_up deliveries surface as user-role message_start
		// events; they must release the controller and restore the session model.
		await h.run("message_start", {
			message: {
				role: "user",
				content: [
					{ type: "text", text: "Stop routing and answer my question" },
				],
				attribution: "user",
				timestamp: 4,
			},
		});
		expect(h.notices().join("\n")).toContain("paused for user input");
		expect(h.switches()).toEqual(["@slow", "original"]);
		await h.commands.jev("status", h.ctx);
		expect(h.notices().at(-1)).toContain("Orchestrator: idle");
	});

	test("settled orchestration keeps suppressing recovery until a real user delivery clears it", async () => {
		const h = await harness({
			choices: { next_action: "ask_user", recovery: "rescuer" },
		});
		await h.commands.jev("run draft the migration", h.ctx);
		const stopEvent = {
			stop_hook_active: false,
			signal: new AbortController().signal,
		};
		// The routed run settles when the router asks the user to decide.
		expect(await h.run("session_stop", stopEvent)).toBeUndefined();
		expect(h.notices().join("\n")).toContain("paused");
		// Later stop boundaries stay suppressed: legacy recovery must not fire.
		expect(await h.run("session_stop", stopEvent)).toBeUndefined();
		// Delivering the orchestrator's own stage guidance does not clear the settlement.
		await h.run("message_start", {
			message: {
				role: "custom",
				customType: "jev-orchestrator",
				content: [{ type: "text", text: "Jev checkpoint 1/8: plan." }],
				display: true,
				attribution: "agent",
				timestamp: 2,
			},
		});
		expect(await h.run("session_stop", stopEvent)).toBeUndefined();
		// A real user delivery clears the settled suppression and legacy recovery resumes.
		await h.run("message_start", {
			message: {
				role: "user",
				content: [{ type: "text", text: "Run the plan now" }],
				attribution: "user",
				timestamp: 3,
			},
		});
		const result = await h.run("session_stop", stopEvent);
		expect(result.continue).toBe(true);
		expect(result.additionalContext).toContain("slow-rescuer");
	});

	test("typed TUI input still pauses immediately while /jev commands do not", async () => {
		const h = await harness();
		await h.commands.jev("run fix the login bug", h.ctx);
		await h.run("input", { text: "/jev status" });
		await h.commands.jev("status", h.ctx);
		expect(h.notices().at(-1)).toContain("Orchestrator: plan, stage 1/");
		await h.run("input", { text: "wait, reconsider the approach" });
		expect(h.notices().join("\n")).toContain("paused for user input");
		await h.commands.jev("status", h.ctx);
		expect(h.notices().at(-1)).toContain("Orchestrator: idle");
	});

	test("jev_dispatch reads workspace files and finishes the queue", async () => {
		const h = await harness({
			config: { dispatcher: { enabled: true } },
			choices: { next_action: "EXECUTE_SELECTED" },
		});
		await writeFile(join(h.ctx.cwd, "a.ts"), "export const alpha = 1;\n");
		const tool = h.tools.jev_dispatch;
		expect(tool).toBeDefined();
		const result = await tool.execute(
			"t",
			{ tasks: [{ id: "t1", description: "read a.ts", paths: ["a.ts"] }] },
			undefined,
			undefined,
			h.ctx,
		);
		const details = result.details as {
			status: string;
			results: Array<{ status: string; summary: string }>;
		};
		expect(details.status).toBe("finished");
		expect(details.results[0].status).toBe("TASK_FINISHED");
		expect(
			(
				result.details as { results: Array<{ evidence: string[] }> }
			).results[0].evidence.join("\n"),
		).toContain("export const alpha = 1;");
	});

	test("jev_dispatch refuses paths outside the workspace", async () => {
		const h = await harness({
			config: { dispatcher: { enabled: true } },
			choices: { next_action: "EXECUTE_SELECTED" },
		});
		const outside = await mkdtemp(join(tmpdir(), "jev-outside-"));
		cleanup.push(() => rm(outside, { recursive: true, force: true }));
		await writeFile(
			join(outside, "private.ts"),
			"PRIVATE_CONTENT_MUST_NOT_ESCAPE",
		);
		const result = await h.tools.jev_dispatch.execute(
			"t",
			{
				tasks: [
					{
						id: "t1",
						description: "read secrets",
						paths: [join(outside, "private.ts")],
					},
				],
				tree: "",
			},
			undefined,
			undefined,
			h.ctx,
		);
		expect(JSON.stringify(result)).not.toContain(
			"PRIVATE_CONTENT_MUST_NOT_ESCAPE",
		);
		expect(JSON.stringify(h.requests)).not.toContain(
			"PRIVATE_CONTENT_MUST_NOT_ESCAPE",
		);
		expect(result.details).toMatchObject({ status: "escalated" });
	});

	test("dispatcher command runs once without enabling automatic policies or the tool", async () => {
		const h = await harness({
			config: { enabled: false, dispatcher: { enabled: false } },
			choices: { next_action: "EXECUTE_SELECTED" },
		});
		await writeFile(join(h.ctx.cwd, "a.ts"), "export const alpha = 1;\n");
		await h.commands.jev("dispatcher Read a.ts", h.ctx);
		expect(h.messages).toContainEqual(
			expect.objectContaining({
				customType: "jev-dispatcher",
				display: true,
				details: expect.objectContaining({
					status: "finished",
					results: [
						expect.objectContaining({
							status: "TASK_FINISHED",
							evidence: expect.arrayContaining([
								expect.stringContaining("export const alpha = 1;"),
							]),
						}),
					],
				}),
			}),
		);
		await expect(
			h.tools.jev_dispatch.execute(
				"still-disabled",
				{ tasks: [{ id: "read", description: "Read a.ts" }] },
				undefined,
				undefined,
				h.ctx,
			),
		).rejects.toThrow(/disabled/);
		await h.run("before_agent_start", { prompt: "Keep native behavior" });
		expect(h.levels).toEqual([]);
		expect(h.switches()).toEqual([]);
	});

	test("dispatcher command hands back an escalated task and the untouched queue", async () => {
		const h = await harness({
			config: { enabled: false },
			choices: { next_action: "REQUIRE_BIGGER_MODEL" },
		});
		const tasks = [
			{ id: "investigate", description: "Explain the architecture" },
			{ id: "later", description: "Inspect the tests" },
		];
		await h.commands.jev(
			`dispatcher ${JSON.stringify({ tasks, tree: "a.ts" })}`,
			h.ctx,
		);
		expect(h.messages).toContainEqual(
			expect.objectContaining({
				customType: "jev-dispatcher",
				details: expect.objectContaining({
					status: "escalated",
					results: [
						expect.objectContaining({
							task: tasks[0],
							status: "REQUIRE_BIGGER_MODEL",
						}),
					],
					remainingTasks: [tasks[1]],
				}),
			}),
		);
		expect(h.requests).toHaveLength(1);
		expect(h.switches()).toEqual([]);
	});

	test("dispatcher command validates the entire JSON queue before sending data", async () => {
		const h = await harness({ config: { enabled: false } });
		await h.commands.jev(
			`dispatcher ${JSON.stringify({
				tasks: [
					{ id: "valid", description: "Read a.ts" },
					{ id: "invalid", description: 42 },
				],
			})}`,
			h.ctx,
		);
		expect(h.requests).toEqual([]);
		expect(h.messages).toEqual([]);
		expect(h.notices().at(-1)).toMatch(/description/);
	});

	test("jev_plan honours a pre-cancelled caller signal without planning work", async () => {
		const h = await harness();
		const result = await h.tools.jev_plan.execute(
			"t",
			{ goal: "Fix it" },
			AbortSignal.abort(),
			undefined,
			h.ctx,
		);
		const details = result.details as {
			status: string;
			model: string;
			toolCalls: number;
		};
		expect(details.status).toBe("aborted");
		expect(details.model).toBe("local/original");
		expect(details.toolCalls).toBe(0);
		expect(JSON.stringify(result)).toContain("Plan aborted");
		// Planning runs on the selected LLM; the TypeSafe classifier is unused.
		expect(h.requests).toHaveLength(0);
	});

	test("jev_plan captures the model before awaiting configuration", async () => {
		const h = await harness();
		const pending = h.tools.jev_plan.execute(
			"t",
			{ goal: "Fix it" },
			AbortSignal.abort(),
			undefined,
			h.ctx,
		);
		await h.switchModel("other-model");
		const result = await pending;
		expect((result.details as { model: string }).model).toBe("local/original");
	});

	test("jev_plan requires the enabled plugin but not the TypeSafe key", async () => {
		const disabled = await harness({ config: { enabled: false } });
		await expect(
			disabled.tools.jev_plan.execute(
				"t",
				{ goal: "Fix it" },
				AbortSignal.abort(),
				undefined,
				disabled.ctx,
			),
		).rejects.toThrow(/inactive/);

		const h = await harness({
			config: { client: { apiKeyEnv: "OMP_JEV_TEST_UNSET_KEY" } },
		});
		const result = await h.tools.jev_plan.execute(
			"t",
			{ goal: "Fix it" },
			AbortSignal.abort(),
			undefined,
			h.ctx,
		);
		expect((result.details as { status: string }).status).toBe("aborted");
		expect(h.requests).toHaveLength(0);
	});

	test("failed command planning publishes an incomplete result and sets no run goal", async () => {
		const h = await harness();
		// The fixture provider cannot serve model calls, so the real planner
		// reports an honest incomplete result without network access.
		await h.commands.jev("plan Fix the bug", h.ctx);
		const published = JSON.stringify(h.messages);
		expect(published).toContain('"customType":"jev-planner"');
		expect(published).toContain("Plan incomplete");
		expect(published).toContain("local/original");
		// An incomplete plan is not an executable goal for /jev run.
		await h.commands.jev("run", h.ctx);
		expect(h.switches()).toEqual([]);
		expect(h.notices().join("\n")).toMatch(/goal/);
	});

	test("moving the session during planning suppresses the old workspace result", async () => {
		const h = await harness();
		let liveCwd = h.ctx.cwd;
		Object.defineProperty(h.ctx.sessionManager, "getCwd", {
			value: () => liveCwd,
		});
		h.ctx.ui.setWidget = (_name, widget) => {
			if (widget !== undefined) liveCwd = join(h.ctx.cwd, "moved");
		};
		await h.commands.jev("plan Inspect the old workspace", h.ctx);
		expect(liveCwd).not.toBe(h.ctx.cwd);
		expect(h.messages).toEqual([]);
	});

	test("/jev plan validates JSON and model selectors before planning starts", async () => {
		const h = await harness();
		await h.commands.jev('plan {"goal": 42}', h.ctx);
		expect(h.messages).toHaveLength(0);
		expect(h.notices().at(-1)).toMatch(/goal/);
		await h.commands.jev('plan {"goal":"Fix it","model":"missing"}', h.ctx);
		expect(h.messages).toHaveLength(0);
		expect(h.notices().join("\n")).toMatch(/missing/);
	});

	test("/jev plan stop reports when nothing is running", async () => {
		const h = await harness();
		await h.commands.jev("plan stop", h.ctx);
		expect(h.notices().at(-1)).toMatch(/No Jev planning/);
	});
});
