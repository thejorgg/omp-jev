import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	DEFAULT_DISPATCHER_CONFIG,
	DispatchEngine,
	NO_PATH,
	READ_SELECTED,
	REQUIRE_BIGGER_MODEL,
	TASK_FINISHED,
	treePaths,
	type DispatcherConfig,
} from "../src/dispatcher.js";
import type { JevConfig } from "../src/types.js";

/** One Jev HTTP request body captured by the fetch stub. */
interface DispatcherRequest {
	state: unknown;
	questions: Record<string, unknown>;
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

const policy = { enabled: false, minConfidence: 0.75, minProbability: 0.7 };
function makeConfig(apiKeyEnv: string): JevConfig {
	return {
		version: 1,
		enabled: true,
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
		thinking: { ...policy },
		delegation: { ...policy, overrideExplicit: false },
		safety: {
			...policy,
			tools: ["bash"],
			onUncertain: "block",
			onError: "block",
		},
		nativeRules: { ...policy },
		recovery: { ...policy, maxContinuations: 2 },
		dispatcher: { ...DEFAULT_DISPATCHER_CONFIG },
	};
}

interface TaskState {
	task: { id: string; description: string };
	candidatePaths: string[];
	completedActions: string[];
	stepsUsed: number;
}
function taskState(value: unknown): TaskState {
	assert.ok(
		value && typeof value === "object" && "task" in value,
		"state carries task",
	);
	const state = value as TaskState;
	assert.equal(typeof state.task.id, "string");
	return state;
}

interface Harness {
	engine: DispatchEngine;
	reads: string[];
	requests: DispatcherRequest[];
	setAnswers: (fn: (state: unknown) => Record<string, unknown>) => void;
}
function harness(config: Partial<DispatcherConfig> = {}): Harness {
	const apiKeyEnv = `JEV_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
	process.env[apiKeyEnv] = "fixture-secret";
	const main = makeConfig(apiKeyEnv);
	const oldFetch = globalThis.fetch;
	cleanup.push(() => {
		delete process.env[apiKeyEnv];
		globalThis.fetch = oldFetch;
	});
	const reads: string[] = [];
	const requests: DispatcherRequest[] = [];
	let answers: (state: unknown) => Record<string, unknown> = () => ({});
	globalThis.fetch = (async (_url, init) => {
		const body: DispatcherRequest = JSON.parse(String(init?.body));
		requests.push(body);
		// Every question must receive an answer; default unread candidates to no.
		const scripted = answers(body.state);
		const merged: Record<string, unknown> = { ...scripted };
		for (const id of Object.keys(body.questions))
			if (!(id in merged)) merged[id] = { type: "noul", noul: 0 };
		return Response.json({ model: "test-jev", answers: merged });
	}) as typeof fetch;
	const engine = new DispatchEngine(
		{} as ExtensionAPI,
		main,
		{ ...DEFAULT_DISPATCHER_CONFIG, ...config },
		async (path) => {
			reads.push(path);
			return { content: [{ type: "text", text: `contents of ${path}` }] };
		},
	);
	return {
		engine,
		reads,
		requests,
		setAnswers(fn) {
			answers = fn;
		},
	};
}

const choice = (pick: string, confidence = 0.99) => {
	const options = [READ_SELECTED, TASK_FINISHED, NO_PATH, REQUIRE_BIGGER_MODEL];
	const rest = options.filter((option) => option !== pick);
	const remainder = 0.15 / rest.length;
	return {
		type: "choice" as const,
		choice: pick,
		confidence,
		probabilities: Object.fromEntries(
			options.map((option) => [
				option,
				option === pick ? 0.85 : Number(remainder.toFixed(4)),
			]),
		),
	};
};
const noul = (probability: number) => ({
	type: "noul" as const,
	noul: probability,
});

test("dispatches queued narrow tasks to completion with batched reads", async () => {
	const h = harness();
	const script: string[] = [];
	h.setAnswers((state) => {
		script.push("ask");
		if (script.length === 1)
			return {
				next_action: choice(READ_SELECTED),
				read_0: noul(0.95),
				read_1: noul(0.9),
			};
		return { next_action: choice(TASK_FINISHED) };
	});
	const result = await h.engine.dispatch({
		tasks: [
			{
				id: "t1",
				description: "Summarize src/a.ts",
				paths: ["src/a.ts", "src/b.ts"],
			},
			{ id: "t2", description: "Summarize src/b.ts", paths: ["src/b.ts"] },
		],
		tree: "src/\n  a.ts\n  b.ts",
	});
	assert.deepEqual(h.reads, ["src/a.ts", "src/b.ts"]);
	assert.equal(result.status, "finished");
	assert.equal(result.results.length, 2);
	assert.match(result.results[0].summary ?? "", /contents of src\/a.ts/);
	const firstQuestions = h.requests[0].questions;
	assert.ok("read_0" in firstQuestions && "read_1" in firstQuestions);
	assert.equal("read_2" in firstQuestions, false);
});

test("advances software-side through the task queue on NO_PATH", async () => {
	const h = harness();
	const seen: string[] = [];
	h.setAnswers((state) => {
		seen.push(taskState(state).task.id);
		return { next_action: choice(NO_PATH) };
	});
	const result = await h.engine.dispatch({
		tasks: [
			{ id: "t1", description: "find x", paths: ["a.ts"] },
			{ id: "t2", description: "find y", paths: ["b.ts"] },
		],
		tree: "a.ts\nb.ts",
	});
	assert.deepEqual(seen, ["t1", "t2"]);
	assert.equal(result.status, "finished");
	assert.equal(result.results[0].status, NO_PATH);
	assert.equal(result.results[1].status, NO_PATH);
	assert.equal(h.reads.length, 0);
});

test("REQUIRE_BIGGER_MODEL returns control with full progress", async () => {
	const h = harness();
	const states: TaskState[] = [];
	h.setAnswers((state) => {
		states.push(taskState(state));
		return { next_action: choice(REQUIRE_BIGGER_MODEL) };
	});
	const result = await h.engine.dispatch({
		tasks: [{ id: "t1", description: "understand module graph", paths: [] }],
		tree: "only/a.ts",
	});
	assert.equal(result.status, "escalated");
	assert.equal(result.results[0].status, REQUIRE_BIGGER_MODEL);
	assert.equal(result.results[0].task.id, "t1");
	assert.deepEqual(states[0].candidatePaths, ["only/a.ts"]);
});

test("respects per-task step and global tool-call budgets", async () => {
	const h = harness({
		maxStepsPerTask: 2,
		maxActionsPerStep: 1,
		maxToolCalls: 1,
	});
	h.setAnswers((state) => {
		const pending = taskState(state).candidatePaths.length > 0;
		return {
			next_action: choice(pending ? READ_SELECTED : TASK_FINISHED),
			read_0: noul(0.95),
		};
	});
	const result = await h.engine.dispatch({
		tasks: [
			{
				id: "t1",
				description: "read everything",
				paths: ["file1.ts", "file2.ts"],
			},
		],
		tree: "file1.ts\nfile2.ts",
	});
	assert.equal(result.status, "escalated");
	assert.ok(h.reads.length <= 1);
});

test("invalid or low-confidence choices are retried, then escalate", async () => {
	const h = harness({ maxInvalidChoices: 2 });
	const script = [
		() => ({ next_action: choice(READ_SELECTED) }),
		() => ({ next_action: choice(READ_SELECTED, 0.4) }),
		() => ({ next_action: choice(TASK_FINISHED) }),
	];
	let i = 0;
	h.setAnswers(() => script[Math.min(i++, script.length - 1)]());
	const result = await h.engine.dispatch({
		tasks: [{ id: "t1", description: "t", paths: ["a.ts"] }],
		tree: "a.ts",
	});
	assert.deepEqual(h.reads, []);
	assert.equal(result.status, "finished");
});

test("no paths and no tree produces NO_PATH without any Jev call", async () => {
	const h = harness();
	h.setAnswers(() => ({ next_action: choice(NO_PATH) }));
	const result = await h.engine.dispatch({
		tasks: [{ id: "t1", description: "anything" }],
		tree: "",
	});
	assert.equal(result.results[0].status, NO_PATH);
	assert.equal(h.requests.length, 0);
	assert.equal(h.reads.length, 0);
});

test("signal abort stops the loop promptly", async () => {
	const h = harness();
	const controller = new AbortController();
	h.setAnswers(() => {
		controller.abort();
		return { next_action: choice(READ_SELECTED), read_0: noul(0.95) };
	});
	const result = await h.engine.dispatch(
		{ tasks: [{ id: "t1", description: "t", paths: ["a.ts"] }], tree: "a.ts" },
		controller.signal,
	);
	assert.equal(result.status, "aborted");
	assert.deepEqual(h.reads, []);
});

test("treePaths parses nested trees and skips directories", () => {
	assert.deepEqual(treePaths("src/\n  a.ts\n  b.ts\nREADME.md"), [
		"src/a.ts",
		"src/b.ts",
		"README.md",
	]);
});
