import { expect, jest, test } from "bun:test";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai";
import {
	formatPlannerResult,
	makePlan,
	type PlannerEnvironment,
} from "../src/planning.js";
import type {
	DiscoveryAction,
	DiscoveryObservation,
	DiscoveryTools,
} from "../src/discovery.js";

const TEST_API_KEY = "sk-test-key-DO-NOT-LEAK";

function readObservation(
	path: string,
	offset: number,
	limit: number,
): DiscoveryObservation {
	const lines = Array.from(
		{ length: limit },
		(_, index) => `${offset + index}|export function entry${index}() {}`,
	);
	return {
		text: lines.join("\n"),
		locations: [
			{
				path,
				line: offset,
				endLine: offset + limit - 1,
				symbol: "entry0",
				text: lines[0] ?? "",
			},
		],
	};
}

function harness(
	options: {
		responses?: MockResponse[];
		handler?: MockResponse;
		execute?: DiscoveryTools["execute"];
	} = {},
) {
	const actions: DiscoveryAction[] = [];
	const tools: DiscoveryTools = {
		inventory: async () => ({ files: ["src/auth.ts"], truncated: false }),
		execute: async (action, signal) => {
			actions.push(action);
			if (options.execute) return options.execute(action, signal);
			if (action.tool === "read") {
				return readObservation(
					action.path,
					action.offset ?? 1,
					action.limit ?? 200,
				);
			}
			return { text: "No matches", locations: [] };
		},
	};
	const model = createMockModel({
		id: "mock-planner",
		responses: options.responses,
		handler: options.handler,
	});
	const env: PlannerEnvironment = {
		model,
		apiKey: TEST_API_KEY,
		tools,
		streamFn: model.stream,
	};
	return { env, model, actions, tools };
}

const readAuth = {
	type: "toolCall",
	name: "read",
	arguments: { path: "src/auth.ts", offset: 1, limit: 40 },
} as const;

const validPlanArgs = {
	status: "ready",
	summary: "Rotate refresh tokens on login.",
	steps: [
		{
			id: "b",
			task: "Wire rotation into the login flow",
			dependsOn: ["a"],
			role: "implement_strong",
			acceptance: ["login response returns a rotated token"],
		},
		{
			id: "a",
			task: "Add a token rotation helper",
			dependsOn: [],
			role: "implement_fast",
			acceptance: ["rotation helper exists and is unit tested"],
		},
	],
	references: [{ path: "src/auth.ts", line: 5, endLine: 6 }],
};

function submitCall(args: Record<string, unknown>) {
	return { type: "toolCall", name: "submit_plan", arguments: args } as const;
}

test("a valid plan becomes ready with a derived next task, verified evidence, and no extra generation", async () => {
	const h = harness({
		responses: [
			{
				content: [readAuth],
				usage: {
					input: 100,
					output: 20,
					cacheRead: 5,
					cacheWrite: 10,
					totalTokens: 135,
				},
			},
			{
				content: [submitCall(validPlanArgs)],
				usage: {
					input: 200,
					output: 30,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 230,
				},
			},
		],
	});
	const result = await makePlan(
		{ goal: "Rotate refresh tokens on login." },
		h.env,
	);
	expect(result.status).toBe("ready");
	expect(result.nextTask?.id).toBe("a");
	expect(result.plan?.references).toEqual([
		{ path: "src/auth.ts", line: 5, endLine: 6 },
	]);
	expect(result.evidence.some((loc) => loc.path === "src/auth.ts")).toBe(true);
	expect(result.turns).toBe(2);
	expect(result.toolCalls).toBe(2);
	expect(result.usage).toEqual({
		input: 300,
		output: 50,
		cacheRead: 5,
		cacheWrite: 10,
		totalTokens: 365,
	});
	// The accepted submit_plan must stop the loop before another model call.
	expect(h.model.calls.length).toBe(2);
});

test("cancellation after submission cannot leave an executable handoff", async () => {
	const controller = new AbortController();
	const h = harness({
		responses: [
			{ content: [readAuth] },
			{ content: [submitCall(validPlanArgs)] },
		],
	});
	const result = await makePlan(
		{ goal: "Plan token rotation" },
		h.env,
		controller.signal,
		(progress) => {
			if (progress.toolCalls === 2) controller.abort();
		},
	);
	expect(result.status).toBe("aborted");
	expect(result.nextTask).toBeUndefined();
	expect(result.plan).toBeUndefined();
	expect(
		result.evidence.some((location) => location.path === "src/auth.ts"),
	).toBe(true);
});

test("an exhausted discovery budget cannot publish an executable handoff", async () => {
	const h = harness({
		responses: [
			{
				content: Array.from({ length: 49 }, (_, index) => ({
					type: "toolCall" as const,
					name: "read",
					arguments: { path: "src/auth.ts", offset: index + 1, limit: 2 },
				})),
			},
			{ content: [submitCall(validPlanArgs)] },
		],
	});
	const result = await makePlan({ goal: "Plan token rotation" }, h.env);
	expect(result.status).toBe("incomplete");
	expect(result.nextTask).toBeUndefined();
	expect(h.actions.length).toBe(48);
});

test("dangling references, dependency cycles, and prose alone are never ready", async () => {
	const h = harness({
		responses: [
			{ content: [readAuth] },
			{
				content: [
					submitCall({
						...validPlanArgs,
						references: [{ path: "src/never-read.ts", line: 1 }],
					}),
				],
			},
			{
				content: [
					submitCall({
						...validPlanArgs,
						steps: [
							{
								id: "a",
								task: "First",
								dependsOn: ["b"],
								role: "inspect",
								acceptance: ["x"],
							},
							{
								id: "b",
								task: "Second",
								dependsOn: ["a"],
								role: "inspect",
								acceptance: ["y"],
							},
						],
					}),
				],
			},
			{
				content: ["Trust me: the plan is to refactor everything."],
				stopReason: "stop",
			},
		],
	});
	const result = await makePlan(
		{ goal: "Rotate refresh tokens on login." },
		h.env,
	);
	expect(result.status).toBe("incomplete");
	expect(result.plan).toBeUndefined();
	expect(result.nextTask).toBeUndefined();
	expect(result.warnings.join("\n")).toContain("submit_plan rejected");
	expect(result.evidence.some((loc) => loc.path === "src/auth.ts")).toBe(true);
	expect(result.turns).toBe(4);
	expect(h.model.calls.length).toBe(4);
});

test("needs_input requires real blockers and never yields a next task", async () => {
	const h = harness({
		responses: [
			{ content: [readAuth] },
			{
				content: [
					submitCall({
						status: "needs_input",
						summary: "Blocked.",
						steps: [],
						blockers: [],
					}),
				],
			},
			{
				content: [
					submitCall({
						status: "needs_input",
						summary: "Blocked on provider choice.",
						steps: [],
						blockers: [
							"Which auth provider should issue the rotated tokens? Credentials are needed.",
						],
					}),
				],
			},
		],
	});
	const result = await makePlan(
		{ goal: "Rotate refresh tokens on login." },
		h.env,
	);
	expect(result.status).toBe("needs_input");
	expect(result.plan?.blockers).toHaveLength(1);
	expect(result.plan?.steps).toEqual([]);
	expect(result.nextTask).toBeUndefined();
	expect(result.warnings.join("\n")).toContain("submit_plan rejected");
});

test("model-call limit terminates incomplete while preserving evidence and progress", async () => {
	const h = harness({
		handler: { content: [readAuth] },
	});
	const progress: Array<{ model: string; toolCalls: number; turns: number }> =
		[];
	const result = await makePlan(
		{ goal: "Rotate refresh tokens." },
		h.env,
		undefined,
		(update) => {
			progress.push(update);
		},
	);
	expect(result.status).toBe("incomplete");
	expect(result.plan).toBeUndefined();
	expect(result.nextTask).toBeUndefined();
	expect(
		result.evidence.some((location) => location.path === "src/auth.ts"),
	).toBe(true);
	expect(result.toolCalls).toBe(16);
	expect(result.turns).toBe(16);
	// Hard cap: exactly the configured number of model calls, never more.
	expect(h.model.calls.length).toBe(16);
});

test("cancelling one concurrent request leaves its sibling untouched", async () => {
	const tools = harness().tools;
	const controller = new AbortController();
	// The hanging model cancels its own caller the moment its stream starts,
	// then stays delayed: the abort must unstick it without any real waiting.
	const hanging = createMockModel({
		id: "mock-planner",
		handler: () => {
			controller.abort();
			return { content: [readAuth], delayMs: 30_000 };
		},
	});
	const steady = createMockModel({
		id: "mock-planner",
		responses: [
			{ content: [readAuth] },
			{ content: [submitCall(validPlanArgs)] },
		],
	});
	const actions: DiscoveryAction[] = [];
	const sharedTools: DiscoveryTools = {
		inventory: tools.inventory,
		execute: async (action, signal) => {
			actions.push(action);
			return tools.execute(action, signal);
		},
	};
	const [cancelled, sibling] = await Promise.all([
		makePlan(
			{ goal: "Slow planning request." },
			{
				model: hanging,
				apiKey: TEST_API_KEY,
				tools: sharedTools,
				streamFn: hanging.stream,
			},
			controller.signal,
		),
		makePlan(
			{ goal: "Rotate refresh tokens on login." },
			{
				model: steady,
				apiKey: TEST_API_KEY,
				tools: sharedTools,
				streamFn: steady.stream,
			},
		),
	]);
	expect(cancelled.status).toBe("aborted");
	expect(cancelled.plan).toBeUndefined();
	expect(cancelled.warnings.join("\n")).not.toContain("Mock aborted");
	expect(sibling.status).toBe("ready");
	expect(sibling.nextTask?.id).toBe("a");
	// Only the sibling's discovery action ran; the cancelled call never reached a tool.
	expect(actions.length).toBe(1);
	expect(actions[0]?.tool).toBe("read");
});

test("a pre-aborted request starts no work", async () => {
	const h = harness({ responses: [{ content: [readAuth] }] });
	const controller = new AbortController();
	controller.abort();
	const result = await makePlan(
		{ goal: "Rotate refresh tokens." },
		h.env,
		controller.signal,
	);
	expect(result.status).toBe("aborted");
	expect(result.plan).toBeUndefined();
	expect(h.model.calls.length).toBe(0);
	expect(h.actions.length).toBe(0);
});

test("caller cancellation settles during pending authentication and late credentials cannot resume work", async () => {
	const controller = new AbortController();
	const authStarted = Promise.withResolvers<void>();
	const credentials = Promise.withResolvers<string | undefined>();
	const h = harness({ responses: [{ content: [readAuth] }] });
	const progress: Array<{ model: string; toolCalls: number; turns: number }> =
		[];
	const planning = makePlan(
		{ goal: "Rotate refresh tokens." },
		{
			...h.env,
			apiKey: () => {
				authStarted.resolve();
				return credentials.promise;
			},
		},
		controller.signal,
		(update) => {
			progress.push(update);
		},
	);

	await authStarted.promise;
	controller.abort();
	const result = await planning;
	const returnedResult = JSON.stringify(result);

	expect(result.status).toBe("aborted");
	expect(result.plan).toBeUndefined();
	expect(result.nextTask).toBeUndefined();
	expect(result.evidence).toEqual([]);
	expect(h.model.calls.length).toBe(0);
	expect(h.actions.length).toBe(0);
	expect(progress).toEqual([]);

	credentials.resolve(TEST_API_KEY);
	await credentials.promise;
	await Promise.resolve();

	expect(h.model.calls.length).toBe(0);
	expect(h.actions.length).toBe(0);
	expect(progress).toEqual([]);
	expect(JSON.stringify(result)).toBe(returnedResult);
});

test("wall deadline settles incomplete during pending authentication and ignores a late auth failure", async () => {
	// Keep SDK startup scheduling real; manually fire only the captured deadline.
	const timers = jest.spyOn(globalThis, "setTimeout");
	const authStarted = Promise.withResolvers<void>();
	const credentials = Promise.withResolvers<string | undefined>();
	const h = harness({ responses: [{ content: [readAuth] }] });
	const progress: Array<{ model: string; toolCalls: number; turns: number }> =
		[];

	try {
		const planning = makePlan(
			{ goal: "Rotate refresh tokens." },
			{
				...h.env,
				apiKey: () => {
					authStarted.resolve();
					return credentials.promise;
				},
			},
			undefined,
			(update) => {
				progress.push(update);
			},
		);

		const deadline = timers.mock.calls.find(
			([, delay]) =>
				typeof delay === "number" && delay > 179_000 && delay <= 180_000,
		)?.[0];
		timers.mockRestore();
		if (typeof deadline !== "function")
			throw new Error("Planner deadline was not armed");
		await authStarted.promise;
		deadline();
		const result = await planning;
		const returnedResult = JSON.stringify(result);

		expect(result.status).toBe("incomplete");
		expect(result.warnings).toContain("planning wall-clock deadline exceeded");
		expect(result.plan).toBeUndefined();
		expect(result.nextTask).toBeUndefined();
		expect(result.evidence).toEqual([]);
		expect(h.model.calls.length).toBe(0);
		expect(h.actions.length).toBe(0);
		expect(progress).toEqual([]);

		credentials.reject(
			new Error("late credential failure containing sk-live-must-not-leak"),
		);
		await Promise.resolve();

		expect(h.model.calls.length).toBe(0);
		expect(h.actions.length).toBe(0);
		expect(progress).toEqual([]);
		expect(JSON.stringify(result)).toBe(returnedResult);
		expect(returnedResult).not.toContain("sk-live-must-not-leak");
	} finally {
		timers.mockRestore();
	}
});

test("raw thinking traces, provider bodies, and credentials never escape", async () => {
	const secret = "sk-live-abc123";
	const leak = harness({
		responses: [
			{
				content: [
					{ type: "thinking", thinking: `SECRET deliberation ${secret}` },
					{ type: "text", text: "Checked the auth module." },
					readAuth,
				],
			},
			{ content: [submitCall(validPlanArgs)] },
		],
	});
	const observed = await makePlan({ goal: "Rotate refresh tokens." }, leak.env);
	expect(observed.status).toBe("ready");
	expect(observed.thinking).not.toContain("SECRET");
	expect(JSON.stringify(observed)).not.toContain(secret);
	expect(JSON.stringify(observed)).not.toContain(TEST_API_KEY);
	expect(formatPlannerResult(observed)).not.toContain("SECRET");
	expect(formatPlannerResult(observed)).not.toContain(TEST_API_KEY);

	const failing = harness({
		responses: [
			{ throw: `500 Internal Server Error body: {"api_key":"${secret}"}` },
		],
	});
	const failed = await makePlan(
		{ goal: "Rotate refresh tokens." },
		failing.env,
	);
	expect(failed.status).toBe("incomplete");
	expect(JSON.stringify(failed)).not.toContain(secret);
	expect(JSON.stringify(failed)).not.toContain("500 Internal");
	expect(formatPlannerResult(failed)).not.toContain(secret);
});
