import { afterEach, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
	DispatchEngine,
	EXECUTE_SELECTED,
	NO_PATH,
	REQUIRE_BIGGER_MODEL,
	TASK_FINISHED,
	treePaths,
} from "../src/dispatcher.js";
import type {
	DiscoveryAction,
	DiscoveryObservation,
	DiscoveryTools,
} from "../src/discovery.js";
import type { DispatcherConfig, Json, Question } from "../src/types.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup.splice(0).reverse()) fn();
});

function harness(
	options: {
		budget?: Partial<DispatcherConfig>;
		decision?: (
			state: Json,
			questions: Record<string, Question>,
		) => string | Record<string, unknown>;
		execute?: DiscoveryTools["execute"];
		files?: string[];
	} = {},
) {
	let decisions = 0;
	const env = `JEV_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
	process.env[env] = "test-only";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { state, questions } = (await request.json()) as {
				state: Json;
				questions: Record<string, Question>;
			};
			decisions++;
			const decision = options.decision?.(state, questions) ?? TASK_FINISHED;
			const answers =
				typeof decision === "object"
					? decision
					: Object.fromEntries(
							Object.entries(questions).map(([id, q]) => [
								id,
								q.type === "choice"
									? {
											type: "choice",
											choice: decision,
											confidence: 0.99,
											probabilities: Object.fromEntries(
												Object.keys(q.criteria).map((label) => [
													label,
													label === decision ? 0.99 : 0.01 / 3,
												]),
											),
										}
									: { type: "noul", noul: 0.99 },
							]),
						);
			return Response.json({ model: "test", answers });
		},
	});
	cleanup.push(() => {
		server.stop(true);
		delete process.env[env];
	});
	const config = structuredClone(DEFAULT_CONFIG);
	config.client = {
		...config.client,
		apiKeyEnv: env,
		endpoint: `http://127.0.0.1:${server.port}/v1/systemone`,
	};
	Object.assign(config.dispatcher, options.budget);
	const actions: DiscoveryAction[] = [];
	const engine = new DispatchEngine(config, {
		inventory: async () => ({
			files: options.files ?? ["src/service.ts"],
			truncated: false,
		}),
		execute: async (action, signal) => {
			actions.push(action);
			return (
				options.execute?.(action, signal) ?? {
					text: "No matches",
					locations: [],
				}
			);
		},
	});
	return { engine, actions, decisions: () => decisions };
}
const hit = (path: string, line = 1): DiscoveryObservation => ({
	text: `${path}:${line}: export function renewToken() {}`,
	locations: [
		{
			path,
			line,
			symbol: "renewToken",
			text: "export function renewToken() {}",
		},
	],
});

test("a finished decision cannot discard later matching file pages", async () => {
	const h = harness({
		execute: async (action) =>
			action.tool === "grep" && !action.skip
				? { ...hit("src/issuer.ts", 40), nextSkip: 20, truncated: true }
				: hit("test/refresh.test.ts", 80),
	});
	const result = await h.engine.dispatch({
		tasks: [
			{ id: "refresh", description: "Find renewToken and related files" },
		],
	});
	expect(result.status).toBe("finished");
	expect(
		result.findings.map((location) => `${location.path}:${location.line}`),
	).toContain("test/refresh.test.ts:80");
});

test("negative decisions retain locations already found instead of returning NO_PATH", async () => {
	const h = harness({
		decision: () => NO_PATH,
		execute: async () => hit("src/service.ts", 90),
	});
	const result = await h.engine.dispatch({
		tasks: [{ id: "locate", description: "Find renewToken" }],
	});
	expect(result.results[0].status).toBe(TASK_FINISHED);
	expect(result.findings[0]).toMatchObject({
		path: "src/service.ts",
		line: 90,
	});
});

test("a failed search never establishes absence", async () => {
	const h = harness({
		decision: () => NO_PATH,
		execute: async () => {
			throw new Error("Search unavailable");
		},
	});
	const result = await h.engine.dispatch({
		tasks: [{ id: "locate", description: "Find renewToken" }],
	});
	expect(result.status).toBe("escalated");
	expect(result.results[0].status).toBe(REQUIRE_BIGGER_MODEL);
});

test("a classifier cannot finish a task without locating evidence", async () => {
	const h = harness();
	const result = await h.engine.dispatch({
		tasks: [{ id: "locate", description: "Find renewToken" }],
	});
	expect(result.status).toBe("escalated");
});

test("the evidence limit is a hard cap and is never reported as completion", async () => {
	const h = harness({
		budget: { maxEvidenceChars: 60 },
		execute: async () => ({ ...hit("src/service.ts"), text: "x".repeat(200) }),
	});
	const result = await h.engine.dispatch({
		tasks: [
			{ id: "locate", description: "Find renewToken" },
			{ id: "next", description: "Find callers" },
		],
	});
	expect(result.status).toBe("escalated");
	expect(
		result.results.flatMap((task) => task.evidence).join("").length,
	).toBeLessThanOrEqual(60);
	expect(result.remainingTasks.map((task) => task.id)).toEqual(["next"]);
});

test("tool budgets count indexing and stop further execution", async () => {
	const h = harness({
		budget: { maxToolCalls: 1 },
		decision: () => EXECUTE_SELECTED,
	});
	const result = await h.engine.dispatch({
		tasks: [{ id: "locate", description: "Find renewToken" }],
	});
	expect(result.status).toBe("escalated");
	expect(result.toolCalls).toBe(1);
	expect(h.actions).toEqual([]);
});

test("empty action selections cannot spin indefinitely", async () => {
	const h = harness({
		budget: { maxInvalidChoices: 1 },
		decision: (_state, questions) =>
			Object.fromEntries(
				Object.entries(questions).map(([id, q]) => [
					id,
					q.type === "choice"
						? {
								type: "choice",
								choice: EXECUTE_SELECTED,
								confidence: 0.99,
								probabilities: {
									[EXECUTE_SELECTED]: 0.99,
									[TASK_FINISHED]: 0.003,
									[NO_PATH]: 0.003,
									[REQUIRE_BIGGER_MODEL]: 0.004,
								},
							}
						: { type: "noul", noul: 0 },
				]),
			),
	});
	const result = await h.engine.dispatch({
		tasks: [{ id: "locate", description: "Find renewToken" }],
	});
	expect(result.status).toBe("escalated");
	expect(h.decisions()).toBeLessThanOrEqual(2);
});

test("cancellation preserves discovered locations and does not invoke further tools", async () => {
	const controller = new AbortController();
	const h = harness({
		execute: async () => hit("src/service.ts", 90),
		decision: () => {
			controller.abort();
			return EXECUTE_SELECTED;
		},
	});
	const result = await h.engine.dispatch(
		{ tasks: [{ id: "locate", description: "Find renewToken" }] },
		controller.signal,
	);
	expect(result.status).toBe("aborted");
	expect(result.findings[0]).toMatchObject({
		path: "src/service.ts",
		line: 90,
	});
	expect(h.actions).toHaveLength(1);
});

test("an empty explicit scope skips global discovery and advances the queue", async () => {
	const h = harness();
	const result = await h.engine.dispatch({
		tasks: [
			{ id: "first", description: "Find renewToken" },
			{ id: "second", description: "Find callers" },
		],
		tree: "",
	});
	expect(result.results.map((item) => item.status)).toEqual([NO_PATH, NO_PATH]);
	expect(h.decisions()).toBe(0);
	expect(h.actions).toEqual([]);
});

test("explicit nested trees preserve directory prefixes", () => {
	expect(treePaths("src/\n  nested/\n    service.ts\nREADME.md")).toEqual([
		"src/nested/service.ts",
		"README.md",
	]);
});

test("semantic relevance removes incidental keyword matches from findings", async () => {
	const h = harness({
		execute: async () => ({
			text: "issuer.ts renewToken\nstyles.ts tokenColor",
			locations: [
				{ path: "src/issuer.ts", line: 10 },
				{ path: "src/styles.ts", line: 20 },
			],
		}),
		decision: (state, questions) => {
			const candidates = (
				state as { relevanceCandidates: Array<{ id: string; path: string }> }
			).relevanceCandidates;
			return Object.fromEntries(
				Object.entries(questions).map(([id, q]) => [
					id,
					q.type === "choice"
						? {
								type: "choice",
								choice: TASK_FINISHED,
								confidence: 0.99,
								probabilities: {
									[TASK_FINISHED]: 0.99,
									[EXECUTE_SELECTED]: 0.003,
									[NO_PATH]: 0.003,
									[REQUIRE_BIGGER_MODEL]: 0.004,
								},
							}
						: {
								type: "noul",
								noul:
									candidates.find((item) => item.id === id)?.path ===
									"src/issuer.ts"
										? 0.98
										: 0.01,
							},
				]),
			);
		},
	});
	const result = await h.engine.dispatch({
		tasks: [{ id: "locate", description: "Find token renewal" }],
	});
	expect(result.findings.map((item) => item.path)).toEqual(["src/issuer.ts"]);
});

test("uncertain stopping decisions gather confidently selected source evidence", async () => {
	const h = harness({
		execute: async (action) =>
			action.tool === "read"
				? {
						...hit("src/service.ts"),
						text: "export function renewToken() { return refreshCredential(); }",
					}
				: hit("src/service.ts"),
		decision: (state, questions) => {
			const { completedActions, actions } = state as {
				completedActions: string[];
				actions: Array<{ id: string; tool: string }>;
			};
			const read = completedActions.some((label) => label.startsWith("read "));
			return Object.fromEntries(
				Object.entries(questions).map(([id, q]) => [
					id,
					q.type === "choice"
						? {
								type: "choice",
								choice: read ? TASK_FINISHED : EXECUTE_SELECTED,
								confidence: read ? 0.99 : 0.4,
								probabilities: {
									[TASK_FINISHED]: read ? 0.99 : 0.48,
									[EXECUTE_SELECTED]: read ? 0.01 : 0.52,
									[NO_PATH]: 0,
									[REQUIRE_BIGGER_MODEL]: 0,
								},
							}
						: {
								type: "noul",
								noul:
									id.startsWith("relevance_") ||
									actions.find((action) => action.id === id)?.tool === "read"
										? 0.99
										: 0,
							},
				]),
			);
		},
	});
	const result = await h.engine.dispatch({
		tasks: [{ id: "read", description: "Read renewToken" }],
		tree: "src/service.ts",
	});
	expect(result.status).toBe("finished");
	expect(result.results[0].evidence.join("\n")).toContain(
		"return refreshCredential()",
	);
});

test("a bounded batch collects the strongest selected evidence first", async () => {
	const h = harness({
		budget: { maxActionsPerStep: 1, maxToolCalls: 1 },
		execute: async (action) =>
			action.tool === "read"
				? {
						text:
							action.path === "src/issuer.ts"
								? "NEEDED_SOURCE_BODY"
								: "INCIDENTAL_SOURCE_BODY",
						locations: [{ path: action.path, line: 1 }],
					}
				: {
						text: "Both files mention renewal",
						locations: [
							{ path: "src/incidental.ts", line: 1 },
							{ path: "src/issuer.ts", line: 1 },
						],
					},
		decision: (state, questions) => {
			const actions = (
				state as { actions: Array<{ id: string; tool: string; path?: string }> }
			).actions;
			return Object.fromEntries(
				Object.entries(questions).map(([id, q]) => [
					id,
					q.type === "choice"
						? {
								type: "choice",
								choice: EXECUTE_SELECTED,
								confidence: 0.99,
								probabilities: {
									[EXECUTE_SELECTED]: 1,
									[TASK_FINISHED]: 0,
									[NO_PATH]: 0,
									[REQUIRE_BIGGER_MODEL]: 0,
								},
							}
						: {
								type: "noul",
								noul:
									id.startsWith("relevance_") ||
									actions.find((a) => a.id === id)?.path === "src/issuer.ts"
										? 0.99
										: 0.61,
							},
				]),
			);
		},
	});
	const result = await h.engine.dispatch({
		tasks: [
			{
				id: "read",
				description: "Read renewal source",
				paths: ["src/incidental.ts", "src/issuer.ts"],
			},
		],
		tree: "",
	});
	const evidence = result.results[0].evidence.join("\n");
	expect(evidence).toContain("NEEDED_SOURCE_BODY");
	expect(evidence).not.toContain("INCIDENTAL_SOURCE_BODY");
});

test("rejected windows advance and rejected reads return after new evidence", async () => {
	const h = harness({
		budget: { maxCandidatesPerStep: 1, maxInvalidChoices: 1 },
		execute: async (action) =>
			action.tool === "read"
				? {
						text:
							action.path === "bridge.ts"
								? "RELATED_CALLER_BODY"
								: "IMPLEMENTATION_BODY",
						locations: [{ path: action.path, line: 1 }],
					}
				: { text: "No initial matches", locations: [] },
		decision: (state, questions) => {
			const { actions, completedActions } = state as {
				actions: Array<{ id: string; tool: string; path?: string }>;
				completedActions: string[];
			};
			const readSource = completedActions.includes("read source.ts");
			const done = completedActions.includes("read bridge.ts");
			const choice = done ? TASK_FINISHED : EXECUTE_SELECTED;
			return Object.fromEntries(
				Object.entries(questions).map(([id, q]) => [
					id,
					q.type === "choice"
						? {
								type: "choice",
								choice,
								confidence: 0.99,
								probabilities: {
									[EXECUTE_SELECTED]: done ? 0 : 1,
									[TASK_FINISHED]: done ? 1 : 0,
									[NO_PATH]: 0,
									[REQUIRE_BIGGER_MODEL]: 0,
								},
							}
						: {
								type: "noul",
								noul:
									id.startsWith("relevance_") ||
									actions.some(
										(a) =>
											a.id === id &&
											(a.path === "source.ts" ||
												(readSource && a.path === "bridge.ts")),
									)
										? 0.99
										: 0,
							},
				]),
			);
		},
	});
	const result = await h.engine.dispatch({
		tasks: [
			{
				id: "related",
				description: "Read related code",
				paths: ["bridge.ts", "source.ts"],
			},
		],
		tree: "",
	});
	expect(result.status).toBe("finished");
	expect(result.results[0].evidence.join("\n")).toContain(
		"RELATED_CALLER_BODY",
	);
});

for (const selectedTool of ["read", "grep"] as const) {
	test(`explicit scopes can select ${selectedTool} without an extra search`, async () => {
		const h = harness({
			execute: async (action) => ({
				...hit("src/service.ts"),
				text:
					action.tool === "read"
						? "COMPLETE_SOURCE_BODY"
						: "MATCHED_SOURCE_LINE",
			}),
			decision: (state, questions) => {
				const { actions, completedActions } = state as {
					actions: Array<{ id: string; tool: string }>;
					completedActions: string[];
				};
				const choice = completedActions.length
					? TASK_FINISHED
					: EXECUTE_SELECTED;
				return Object.fromEntries(
					Object.entries(questions).map(([id, question]) => [
						id,
						question.type === "choice"
							? {
									type: "choice",
									choice,
									confidence: 1,
									probabilities: Object.fromEntries(
										Object.keys(question.criteria).map((label) => [
											label,
											label === choice ? 1 : 0,
										]),
									),
								}
							: {
									type: "noul",
									noul:
										id.startsWith("relevance_") ||
										actions.some(
											(action) =>
												action.id === id && action.tool === selectedTool,
										)
											? 1
											: 0,
								},
					]),
				);
			},
		});
		const result = await h.engine.dispatch({
			tasks: [
				{
					id: "source",
					description: "Read service source",
					paths: ["src/service.ts"],
				},
			],
			tree: "",
		});
		expect(result.status).toBe("finished");
		expect(result.toolCalls).toBe(1);
		expect(result.results[0].evidence.join("\n")).toContain(
			selectedTool === "read" ? "COMPLETE_SOURCE_BODY" : "MATCHED_SOURCE_LINE",
		);
	});
}
