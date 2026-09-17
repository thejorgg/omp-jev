import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { evaluate } from "./client.js";
import type {
	Answer,
	DispatcherConfig,
	JevConfig,
	Json,
	Question,
} from "./types.js";

export type { DispatcherConfig };

export const TASK_FINISHED = "TASK_FINISHED";
export const NO_PATH = "NO_PATH";
export const REQUIRE_BIGGER_MODEL = "REQUIRE_BIGGER_MODEL";
/** Execute the reads selected by this step's per-path noul answers. */
export const READ_SELECTED = "READ_SELECTED";

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
	enabled: false,
	timeoutMs: 1500,
	minConfidence: 0.75,
	minProbability: 0.7,
	minReadProbability: 0.6,
	maxStepsPerTask: 12,
	maxActionsPerStep: 4,
	maxCandidatesPerStep: 12,
	maxToolCalls: 32,
	maxEvidenceChars: 24000,
	maxInvalidChoices: 2,
};

export interface DispatcherTask {
	id: string;
	description: string;
	paths?: string[];
}

export interface DispatcherRequestInput {
	tasks: DispatcherTask[];
	tree: string;
}

export type TaskOutcome =
	| { status: typeof TASK_FINISHED; summary: string }
	| { status: typeof NO_PATH; summary?: string }
	| {
			status: typeof REQUIRE_BIGGER_MODEL;
			summary?: string;
			evidence: string[];
	  };

export interface DispatcherResult {
	status: "finished" | "escalated" | "aborted";
	results: Array<{ task: DispatcherTask } & TaskOutcome>;
	toolCalls: number;
}

export type ReadFile = (
	path: string,
	signal?: AbortSignal,
) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

/** Parse an indentation-based tree into concrete file paths. */
export function treePaths(tree: string): string[] {
	const paths: string[] = [];
	const stack: Array<{ depth: number; prefix: string }> = [];
	for (const line of tree.split("\n")) {
		if (!line.trim()) continue;
		const depth = line.length - line.trimStart().length;
		const name = line.trim();
		while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
		const prefix = stack.length ? `${stack[stack.length - 1].prefix}/` : "";
		if (name.endsWith("/")) {
			stack.push({ depth, prefix: prefix + name.slice(0, -1) });
		} else {
			paths.push(prefix + name);
		}
	}
	return paths;
}

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	".cache",
	"dist",
	"build",
	"target",
	".venv",
	"venv",
	"__pycache__",
]);

/** Render a bounded workspace tree (depth 3, common junk skipped). */
export async function workspaceTree(
	cwd: string,
	maxEntries = 400,
): Promise<string> {
	const lines: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > 3 || lines.length >= maxEntries) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (lines.length >= maxEntries) return;
			const indent = "  ".repeat(depth);
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				lines.push(`${indent}${entry.name}/`);
				await walk(resolve(dir, entry.name), depth + 1);
			} else if (entry.isFile()) {
				lines.push(`${indent}${entry.name}`);
			}
		}
	};
	await walk(cwd, 0);
	return lines.join("\n");
}

/**
 * Path-safe workspace file reader: only regular files inside `cwd`
 * (after symlink resolution), each truncated to `maxBytes`.
 */
export function createWorkspaceReader(cwd: string, maxBytes = 65536): ReadFile {
	return async (path) => {
		const target = resolve(cwd, path);
		const [root, real] = await Promise.all([
			realpath(cwd),
			realpath(target).catch(() => {
				throw new Error(`jev dispatch: ${path} does not exist`);
			}),
		]);
		const rel = relative(root, real);
		if (rel.startsWith("..") || rel === "" || rel.startsWith(sep))
			throw new Error(`jev dispatch: ${path} is outside the workspace`);
		const info = await stat(real);
		if (!info.isFile()) throw new Error(`jev dispatch: ${path} is not a file`);
		const text = (await readFile(real, "utf8")).slice(0, maxBytes);
		return { content: [{ type: "text", text }] };
	};
}

/** Parse `read <path>` and similar action log lines back into a path set. */
function completedPaths(active: ActiveTask): Set<string> {
	const done = new Set<string>();
	for (const entry of active.completed) {
		const match = /^read (.+?)(?: failed)?$/.exec(entry);
		if (match) done.add(match[1]);
	}
	return done;
}

class AbortedError extends Error {}

interface ActiveTask {
	task: DispatcherTask;
	steps: number;
	completed: string[];
	evidence: string[];
	invalidChoices: number;
}

export class DispatchEngine {
	constructor(
		private _pi: ExtensionAPI,
		private config: JevConfig,
		private dispatcher: DispatcherConfig,
		private readFile: ReadFile,
	) {}

	async dispatch(
		input: DispatcherRequestInput,
		signal?: AbortSignal,
	): Promise<DispatcherResult> {
		const results: DispatcherResult["results"] = [];
		let toolCalls = 0;
		for (const task of input.tasks) {
			if (signal?.aborted) return { status: "aborted", results, toolCalls };
			try {
				const outcome = await this.runTask(task, input, {
					getCalls: () => toolCalls,
					addCall: () => {
						toolCalls++;
					},
					signal,
				});
				results.push({ task, ...outcome });
				if (outcome.status === REQUIRE_BIGGER_MODEL)
					return { status: "escalated", results, toolCalls };
			} catch (error) {
				if (error instanceof AbortedError)
					return { status: "aborted", results, toolCalls };
				throw error;
			}
		}
		return { status: "finished", results, toolCalls };
	}

	private async runTask(
		task: DispatcherTask,
		input: DispatcherRequestInput,
		budget: {
			getCalls: () => number;
			addCall: () => void;
			signal?: AbortSignal;
		},
	): Promise<TaskOutcome> {
		const active: ActiveTask = {
			task,
			steps: 0,
			completed: [],
			evidence: [],
			invalidChoices: 0,
		};
		const universe = this.candidates(task, input);
		if (!universe.length) return { status: NO_PATH };
		while (active.steps < this.dispatcher.maxStepsPerTask) {
			this.throwIfAborted(budget.signal);
			const done = completedPaths(active);
			const pending = universe.filter((path) => !done.has(path));
			if (!pending.length)
				return { status: TASK_FINISHED, summary: this.summarize(active) };
			const offered = pending.slice(0, this.dispatcher.maxCandidatesPerStep);
			const questions = this.questions(offered);
			const state = this.buildState(active, input, offered);
			const answers = await evaluate(
				{ ...this.config.client, timeoutMs: this.dispatcher.timeoutMs },
				state,
				questions,
				budget.signal,
			).then((result) => result.answers);
			const next = this.accepted(answers.next_action);
			if (!next) {
				active.invalidChoices++;
				if (active.invalidChoices > this.dispatcher.maxInvalidChoices)
					return {
						status: REQUIRE_BIGGER_MODEL,
						summary:
							"dispatcher kept returning unusable or low-confidence choices",
						evidence: active.evidence,
					};
				continue;
			}
			if (next.choice === TASK_FINISHED)
				return { status: TASK_FINISHED, summary: this.summarize(active) };
			if (next.choice === NO_PATH) return { status: NO_PATH };
			if (next.choice === REQUIRE_BIGGER_MODEL)
				return { status: REQUIRE_BIGGER_MODEL, evidence: active.evidence };
			// READ_SELECTED: gather this step's noul-selected batch.
			const selected = offered.filter((path, index) => {
				const answer = answers[`read_${index}`];
				return (
					answer?.type === "noul" &&
					answer.noul >= this.dispatcher.minReadProbability
				);
			});
			if (!selected.length) {
				active.invalidChoices++;
				continue;
			}
			const batch = selected.slice(0, this.dispatcher.maxActionsPerStep);
			const read = await Promise.all(
				batch.map(async (path) => {
					if (budget.getCalls() >= this.dispatcher.maxToolCalls)
						return { path, text: "", overBudget: true };
					this.throwIfAborted(budget.signal);
					budget.addCall();
					try {
						const result = await this.readFile(path, budget.signal);
						return {
							path,
							text: result.content.map((part) => part.text).join("\n"),
						};
					} catch {
						return { path, text: "", failed: true };
					}
				}),
			);
			for (const item of read) {
				if (item.overBudget) continue;
				active.completed.push(
					`read ${item.path}${item.failed ? " failed" : ""}`,
				);
				if (!item.failed && item.text)
					active.evidence.push(`--- read ${item.path} ---\n${item.text}`);
			}
			if (read.some((item) => item.overBudget))
				return {
					status: REQUIRE_BIGGER_MODEL,
					summary: "tool-call budget exhausted",
					evidence: active.evidence,
				};
			active.steps++;
			if (this.evidenceSize(active) > this.dispatcher.maxEvidenceChars)
				return { status: TASK_FINISHED, summary: this.summarize(active) };
		}
		return {
			status: REQUIRE_BIGGER_MODEL,
			summary: "step budget exhausted",
			evidence: active.evidence,
		};
	}

	private candidates(
		task: DispatcherTask,
		input: DispatcherRequestInput,
	): string[] {
		const seen = new Set<string>();
		const list: string[] = [];
		for (const path of [...(task.paths ?? []), ...treePaths(input.tree)])
			if (!seen.has(path)) {
				seen.add(path);
				list.push(path);
			}
		return list;
	}

	private questions(offered: string[]): Record<string, Question> {
		const questions: Record<string, Question> = {
			next_action: {
				type: "choice",
				instructions:
					"You are the dispatcher for the current narrow read-only task. Decide the next step from the task description, the repository tree, the candidate paths offered this round, and the actions already completed. Choose READ_SELECTED to read the candidate paths you marked in the read_N questions. Choose TASK_FINISHED when completed reads already answer the task. Choose NO_PATH when no offered candidate can contain the needed information. Choose REQUIRE_BIGGER_MODEL when the task needs free-text search, broad reasoning, or write access.",
				criteria: {
					[READ_SELECTED]:
						"Read the candidates marked yes in the read_N questions.",
					[TASK_FINISHED]:
						"Completed reads already contain the information the task asks for.",
					[NO_PATH]:
						"No offered candidate path can contain the needed information.",
					[REQUIRE_BIGGER_MODEL]:
						"The task is too broad or ambiguous for read-only candidate selection.",
				},
			},
		};
		for (const [index, path] of offered.entries()) {
			questions[`read_${index}`] = {
				type: "noul",
				instructions: `Should we read "${path}" next to satisfy the task?`,
				criteria: {
					true: "This path likely contains information the task needs.",
					false: "This path is unlikely to help.",
				},
			};
		}
		return questions;
	}

	private buildState(
		active: ActiveTask,
		input: DispatcherRequestInput,
		offered: string[],
	): Json {
		const tail = active.evidence.join("\n").slice(-4000);
		return {
			task: { id: active.task.id, description: active.task.description },
			candidatePaths: offered,
			tree: input.tree,
			completedActions: active.completed,
			stepsUsed: active.steps,
			maxSteps: this.dispatcher.maxStepsPerTask,
			evidenceChars: this.evidenceSize(active),
			...(tail ? { recentEvidence: tail } : {}),
		};
	}

	private summarize(active: ActiveTask): string {
		return (
			active.evidence.join("\n").slice(0, this.dispatcher.maxEvidenceChars) ||
			`read ${active.completed.join(", ")}`
		);
	}

	private evidenceSize(active: ActiveTask): number {
		return active.evidence.join("").length;
	}

	private accepted(
		answer: Answer | undefined,
	): { choice: string; confidence: number; probability: number } | undefined {
		if (!answer || answer.type !== "choice") return undefined;
		const probability = answer.probabilities[answer.choice];
		if (typeof probability !== "number") return undefined;
		if (
			answer.confidence < this.dispatcher.minConfidence ||
			probability < this.dispatcher.minProbability
		)
			return undefined;
		return {
			choice: answer.choice,
			confidence: answer.confidence,
			probability,
		};
	}

	private throwIfAborted(signal: AbortSignal | undefined): void {
		if (signal?.aborted) throw new AbortedError();
	}
}
