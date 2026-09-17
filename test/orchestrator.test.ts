import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { JevOrchestrator } from "../src/orchestrator.js";
import {
	ACTIONS,
	DEFAULT_ORCHESTRATOR,
	type Action,
	type OrchestratorConfig,
} from "../src/orchestration.js";
import type { JevConfig } from "../src/types.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function response(action: Action, confidence = 0.99): Response {
	return Response.json({
		model: "test-jev",
		answers: {
			next_action: {
				type: "choice",
				choice: action,
				confidence,
				probabilities: Object.fromEntries(
					ACTIONS.map((a) => [
						a,
						a === action ? 0.99 : 0.01 / (ACTIONS.length - 1),
					]),
				),
			},
		},
	});
}
function harness(configPatch: Partial<OrchestratorConfig> = {}) {
	const apiKeyEnv = `JEV_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
	process.env[apiKeyEnv] = "fixture-secret";
	const oldFetch = globalThis.fetch;
	cleanup.push(() => {
		delete process.env[apiKeyEnv];
		globalThis.fetch = oldFetch;
	});
	const state = {
		model: { id: "original", provider: "fixture", reasoning: true },
		thinking: "medium",
		configured: "medium",
		pending: false,
		idle: true,
		enabled: true,
		jobs: false,
	};
	const config = structuredClone({ ...DEFAULT_ORCHESTRATOR, ...configPatch });
	config.models = {
		planner: "planner",
		fast: "fast",
		strong: "strong",
		reviewer: "reviewer",
	};
	const main = {
		client: {
			endpoint: "https://api.typesafe.ai/v1/systemone",
			model: "jev-latest",
			apiKeyEnv,
			timeoutMs: 5000,
		},
		context: {
			maxChars: 48000,
			recentMessages: 12,
			includeSystemPrompt: false,
			redactKeys: ["token", "password"],
		},
	} as JevConfig;
	const messages: unknown[] = [],
		entries: unknown[] = [],
		notices: string[] = [],
		switches: string[] = [],
		requests: unknown[] = [];
	const branch: unknown[] = [
		{
			type: "thinking_level_change",
			thinkingLevel: "medium",
			configured: "medium",
		},
		{
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "Fix the authorized bug" }],
			},
		},
	];
	let classify: (init: RequestInit) => Promise<Response> = async () =>
		response("implement_strong");
	let changed: ((ctx: unknown) => Promise<void> | void) | undefined;
	globalThis.fetch = (async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return classify(init!);
	}) as typeof fetch;
	let select: (id: string) => Promise<boolean> = async () => true;
	const api = {
		setModel: async (model: typeof state.model) => {
			if (!(await select(model.id))) return false;
			state.model = model;
			branch.push({
				type: "model_change",
				model: `${model.provider}/${model.id}`,
			});
			switches.push(model.id);
			return true;
		},
		setThinkingLevel: (level: string) => {
			state.configured = level;
			state.thinking = level === "auto" ? "medium" : level;
			branch.push({
				type: "thinking_level_change",
				thinkingLevel: state.thinking,
				configured: level,
			});
		},
		getThinkingLevel: () => state.thinking,
		sendMessage: (...args: unknown[]) => messages.push(args),
		appendEntry: (...args: unknown[]) => entries.push(args),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/fixture",
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		getAsyncJobSnapshot: () => (state.jobs ? { running: [{}] } : null),
		models: {
			current: () => state.model,
			resolve: (id: string) =>
				id === "missing"
					? undefined
					: { id, provider: "fixture", reasoning: true },
		},
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => branch,
		},
	} as unknown as ExtensionCommandContext;
	let configuration = async () => ({ main, orchestrator: config });
	const controller = new JevOrchestrator(api, {
		config: () => configuration(),
		enabled: async () => state.enabled,
		notice: (_ctx, text) => {
			notices.push(text);
		},
		changed: async (context) => {
			await changed?.(context);
		},
	});
	const stopEvent = (signal = new AbortController().signal) => ({
		signal,
		stop_hook_active: true,
	});
	return {
		controller,
		ctx,
		state,
		config,
		main,
		messages,
		entries,
		notices,
		switches,
		requests,
		branch,
		stopEvent,
		classify: (fn: typeof classify) => {
			classify = fn;
		},
		select: (fn: typeof select) => {
			select = fn;
		},
		changed: (fn: typeof changed) => {
			changed = fn;
		},
		configuration: (fn: typeof configuration) => {
			configuration = fn;
		},
	};
}

test("controller registration is inert until an explicit start", () => {
	const h = harness();
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.equal(h.controller.handlesStop(h.ctx), false);
	assert.equal(h.requests.length, 0);
	assert.equal(h.messages.length, 0);
});
test("plan mode uses the planner once and does not auto-execute", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "Fix the bug", true);
	assert.equal(h.state.model.id, "planner");
	assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	assert.equal(h.requests.length, 0);
	assert.equal(h.state.model.id, "original");
	assert.equal(h.state.thinking, "medium");
	await h.controller.start(h.ctx, "");
	assert.equal(h.messages.length, 2);
	await h.controller.stop(h.ctx, "test cleanup");
});
test("plan -> strong implementation -> review -> done uses only Jev at boundaries", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "Fix the bug");
	h.classify(async () => response("implement_strong"));
	assert.equal(
		(await h.controller.onStop(h.ctx, h.stopEvent()))?.continue,
		true,
	);
	assert.equal(h.state.model.id, "strong");
	h.classify(async () => response("done")); // deterministic guard inserts review
	assert.match(
		(await h.controller.onStop(h.ctx, h.stopEvent()))!.additionalContext,
		/review/,
	);
	assert.equal(h.state.model.id, "reviewer");
	assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	assert.equal(h.state.model.id, "original");
	assert.equal(h.requests.length, 3);
	assert.equal(h.entries.length, 3);
	assert.equal(h.messages.length, 1); // no generated manager messages between stages
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.equal(h.controller.handlesStop(h.ctx), true);
});
test("missing roles and inactive Jev never start work", async () => {
	const h = harness();
	h.config.models.strong = "missing";
	await assert.rejects(
		() => h.controller.start(h.ctx, "goal"),
		/Cannot resolve strong/,
	);
	h.state.enabled = false;
	await assert.rejects(() => h.controller.start(h.ctx, "goal"), /inactive/);
	assert.equal(h.messages.length, 0);
	assert.equal(h.requests.length, 0);
});
test("failed model authentication unwinds startup", async () => {
	const h = harness();
	h.select(async () => false);
	await assert.rejects(
		() => h.controller.start(h.ctx, "goal"),
		/No authentication/,
	);
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.equal(h.messages.length, 0);
});
test("HTTP failure pauses without retries or raw-body disclosure", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	h.classify(
		async () => new Response("private upstream data", { status: 503 }),
	);
	assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	assert.equal(h.requests.length, 1);
	assert.equal(h.state.model.id, "original");
	assert.ok(!h.notices.join().includes("private upstream data"));
});
test("router timeout is bounded and does not continue", async () => {
	const h = harness({ timeoutMs: 100 });
	await h.controller.start(h.ctx, "goal");
	h.classify(
		(init) =>
			new Promise((_resolve, reject) =>
				init.signal!.addEventListener(
					"abort",
					() => reject(new Error("timeout")),
					{ once: true },
				),
			),
	);
	const keepAlive = setTimeout(() => {}, 1000);
	try {
		assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	} finally {
		clearTimeout(keepAlive);
	}
	assert.equal(h.requests.length, 1);
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.match(h.notices.join(), /timed out/);
});
test("concurrent stops coalesce and cancellation rejects stale router results", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	const entered = deferred<void>();
	h.classify((init) => {
		entered.resolve();
		return new Promise((_resolve, reject) =>
			init.signal!.addEventListener(
				"abort",
				() => reject(new Error("cancelled")),
				{ once: true },
			),
		);
	});
	const first = h.controller.onStop(h.ctx, h.stopEvent());
	await entered.promise;
	assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	await h.controller.stop(h.ctx, "cancelled");
	assert.equal(await first, undefined);
	assert.equal(h.requests.length, 1);
	assert.equal(h.state.model.id, "original");
	assert.equal(h.messages.length, 1);
});
test("cancellation during a model switch restores after the late switch, without dispatch", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	const entered = deferred<void>(),
		release = deferred<void>();
	h.select(async (id) => {
		if (id === "strong") {
			entered.resolve();
			await release.promise;
		}
		return true;
	});
	const transition = h.controller.onStop(h.ctx, h.stopEvent());
	await entered.promise;
	const cancel = h.controller.stop(h.ctx, "cancelled");
	release.resolve();
	await cancel;
	assert.equal(await transition, undefined);
	assert.equal(h.state.model.id, "original");
	assert.equal(h.messages.length, 1);
});
test("user input arriving during classification wins over the classifier", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	h.classify(async () => {
		h.state.pending = true;
		return response("implement_strong");
	});
	assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	assert.equal(h.state.model.id, "original");
	assert.ok(!h.switches.includes("strong"));
});
test("manual model and thinking changes are not overwritten on cancellation", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	h.state.model = { id: "user-choice", provider: "fixture", reasoning: true };
	h.state.thinking = "low";
	await h.controller.onStop(h.ctx, h.stopEvent());
	assert.equal(h.state.model.id, "user-choice");
	assert.equal(h.state.thinking, "low");
	assert.equal(h.requests.length, 0);
});
test("user input invalidates a start still awaiting configuration", async () => {
	const h = harness();
	const config = deferred<{
		main: JevConfig;
		orchestrator: OrchestratorConfig;
	}>();
	h.configuration(() => config.promise);
	const start = h.controller.start(h.ctx, "goal");
	await h.controller.userInput(h.ctx);
	config.resolve({ main: h.main, orchestrator: h.config });
	await assert.rejects(() => start, /Session changed/);
	assert.equal(h.messages.length, 0);
});
test("start waits out pending stop restoration instead of snapshotting the worker model", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	assert.equal(h.state.model.id, "planner");
	// Window 1: restoration is not even enqueued yet; deps.changed still awaits.
	const settingsRestored = deferred<void>();
	h.changed(() => settingsRestored.promise);
	const stopped = h.controller.stop(h.ctx, "test cleanup");
	const retried = h.controller.start(h.ctx, "");
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.equal(h.messages.length, 1);
	assert.equal(h.state.model.id, "planner");
	settingsRestored.resolve();
	await Promise.all([stopped, retried]);
	assert.equal(h.controller.isActive(h.ctx), true);
	assert.equal(h.messages.length, 2);
	// The retry borrowed the worker model; stopping it must return to A, never stay on B.
	await h.controller.stop(h.ctx, "test cleanup");
	assert.equal(h.state.model.id, "original");
	// Window 2: the serialized model restoration itself is still in flight.
	await h.controller.start(h.ctx, "");
	assert.equal(h.state.model.id, "planner");
	const modelRestored = deferred<void>();
	h.select(async (id) => {
		if (id === "original") await modelRestored.promise;
		return true;
	});
	const stoppedAgain = h.controller.stop(h.ctx, "test cleanup");
	const retriedAgain = h.controller.start(h.ctx, "");
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.equal(h.state.model.id, "planner");
	modelRestored.resolve();
	await Promise.all([stoppedAgain, retriedAgain]);
	assert.equal(h.controller.isActive(h.ctx), true);
	assert.equal(h.state.model.id, "planner");
	await h.controller.stop(h.ctx, "test cleanup");
	assert.equal(h.state.model.id, "original");
});
test("a repeated stop waits until the pending restoration has finished", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	const release = deferred<void>();
	h.changed(() => release.promise);
	const stopping = h.controller.stop(h.ctx, "first stop");
	let completed = false;
	const repeated = h.controller.stop(h.ctx, "repeated stop").then(() => {
		completed = true;
	});
	try {
		await Promise.resolve();
		assert.equal(completed, false);
	} finally {
		release.resolve();
		await Promise.all([stopping, repeated]);
	}
	assert.equal(h.state.model.id, "original");
	assert.equal(h.state.thinking, "medium");
});
test("secret and hidden-reasoning text do not enter router state", async () => {
	const h = harness();
	h.branch.push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private-thought" },
				{ type: "text", text: "fixture-secret visible evidence" },
			],
		},
	});
	await h.controller.start(h.ctx, "goal");
	await h.controller.onStop(h.ctx, h.stopEvent());
	const payload = JSON.stringify(h.requests);
	assert.ok(!payload.includes("fixture-secret"));
	assert.ok(!payload.includes("private-thought"));
	assert.match(payload, /visible evidence/);
	await h.controller.stop(h.ctx, "test cleanup");
});
test("settled runs suppress legacy recovery until real user input", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	await h.controller.stop(h.ctx, "cancelled");
	assert.equal(h.controller.handlesStop(h.ctx), true);
	assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	await h.controller.userInput(h.ctx);
	assert.equal(h.controller.handlesStop(h.ctx), false);
});
test("pre-aborted boundaries and exhausted budgets do not start another worker", async () => {
	const h = harness({ maxSteps: 1 });
	await h.controller.start(h.ctx, "goal");
	assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	assert.equal(h.state.model.id, "original");
	await h.controller.start(h.ctx, "goal");
	const count = h.requests.length;
	assert.equal(
		await h.controller.onStop(h.ctx, h.stopEvent(AbortSignal.abort())),
		undefined,
	);
	assert.equal(h.requests.length, count);
});

test("manual model changes during classification prevent the next stage", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	h.classify(async () => {
		h.state.model = { id: "manual", provider: "fixture", reasoning: true };
		return response("implement_strong");
	});
	assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	assert.equal(h.state.model.id, "manual");
	assert.ok(!h.switches.includes("strong"));
});

test("a failed review cannot be reported as completion", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	h.classify(async () => response("review"));
	await h.controller.onStop(h.ctx, h.stopEvent());
	h.classify(async () => response("done"));
	const event = {
		...h.stopEvent(),
		last_assistant_message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "Provider unavailable",
		},
	};
	assert.equal(
		await h.controller.onStop(
			h.ctx,
			event as Parameters<JevOrchestrator["onStop"]>[1],
		),
		undefined,
	);
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.ok(!h.notices.some((text) => text.includes("finished")));
	assert.equal(h.requests.length, 1);
});

test("terminal agent_end releases an interrupted run but scheduled continuations keep ownership", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	await h.controller.onAgentEnd(h.ctx, { willContinue: true });
	assert.equal(h.controller.isActive(h.ctx), true);
	await h.controller.onAgentEnd(h.ctx, {});
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.equal(h.state.model.id, "original");
	assert.equal(h.state.thinking, "medium");
	await h.controller.start(h.ctx, "goal");
	await h.controller.stop(h.ctx, "cleanup");
});

test("manual thinking changes before and during routing pause without overwriting the selection", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	h.state.thinking = "low";
	await h.controller.onStop(h.ctx, h.stopEvent());
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.equal(h.state.thinking, "low");
	assert.equal(h.requests.length, 0);
	await h.controller.start(h.ctx, "goal");
	h.classify(async () => {
		h.state.thinking = "medium";
		return response("implement_strong");
	});
	await h.controller.onStop(h.ctx, h.stopEvent());
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.equal(h.state.thinking, "medium");
	assert.ok(!h.switches.includes("strong"));
});

test("configured auto is restored rather than its effective effort", async () => {
	const h = harness();
	h.state.configured = "auto";
	h.branch.push({
		type: "thinking_level_change",
		configured: "auto",
		thinkingLevel: "medium",
	});
	await h.controller.start(h.ctx, "goal", true);
	await h.controller.onStop(h.ctx, h.stopEvent());
	assert.equal(h.state.configured, "auto");
});

test("without selector metadata orchestration preserves host thinking mode", async () => {
	const h = harness();
	h.branch.splice(0, 1);
	h.state.configured = "auto";
	await h.controller.start(h.ctx, "goal", true);
	assert.equal(h.state.configured, "auto");
	await h.controller.onStop(h.ctx, h.stopEvent());
	assert.equal(h.state.configured, "auto");
});

test("model defaults do not erase a manual thinking change while releasing ownership", async () => {
	const h = harness();
	h.select(async () => {
		h.state.thinking = "medium";
		return true;
	});
	await h.controller.start(h.ctx, "goal");
	h.state.thinking = "low";
	await h.controller.onStop(h.ctx, h.stopEvent());
	assert.equal(h.state.thinking, "low");
	assert.equal(h.controller.isActive(h.ctx), false);
});

test("model effort clamping during a stage switch does not look like user input", async () => {
	const h = harness();
	h.select(async () => {
		h.state.thinking = "low";
		return true;
	});
	await h.controller.start(h.ctx, "goal");
	assert.equal(h.state.thinking, "high");
	assert.equal(
		(await h.controller.onStop(h.ctx, h.stopEvent()))?.continue,
		true,
	);
	assert.equal(h.state.model.id, "strong");
	await h.controller.stop(h.ctx, "cleanup");
});

test("thinking changes during model authentication win over the stage default", async () => {
	const h = harness();
	await h.controller.start(h.ctx, "goal");
	h.select(async (id) => {
		if (id === "strong") {
			h.state.thinking = "low";
			h.branch.push({
				type: "thinking_level_change",
				configured: "low",
				thinkingLevel: "low",
			});
		}
		return true;
	});
	assert.equal(await h.controller.onStop(h.ctx, h.stopEvent()), undefined);
	assert.equal(h.controller.isActive(h.ctx), false);
	assert.equal(h.state.thinking, "low");
});

test("cancellation during the initial model switch restores the original session", async () => {
	const h = harness(),
		entered = deferred<void>(),
		release = deferred<void>();
	h.select(async (id) => {
		if (id === "planner") {
			entered.resolve();
			await release.promise;
		}
		return true;
	});
	const start = h.controller.start(h.ctx, "goal");
	await entered.promise;
	const cancel = h.controller.stop(h.ctx, "cancelled");
	release.resolve();
	await Promise.all([start, cancel]);
	assert.equal(h.state.model.id, "original");
	assert.equal(h.state.thinking, "medium");
	assert.equal(h.messages.length, 0);
});
