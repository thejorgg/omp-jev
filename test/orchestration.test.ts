import { test } from "bun:test";
import assert from "node:assert/strict";
import { ACTIONS, DEFAULT_ORCHESTRATOR, chooseNext, nextActionQuestion, parseOrchestrator, routerState, stagePrompt, stageRole, type Action, type RunState } from "../src/orchestration.js";
import { validateQuestion } from "../src/client.js";
import { configHome, configPaths } from "../src/paths.js";
import type { Answer } from "../src/types.js";

const state = (patch: Partial<RunState> = {}): RunState => ({ goal: "Fix the bug", stage: "plan", steps: 1, repeated: 1, fastFailures: 0, escalated: false, ...patch });
const answer = (choice: Action, confidence = 0.99, probability = 0.99): Answer => ({ type: "choice", choice, confidence, probabilities: Object.fromEntries(ACTIONS.map(a => [a, a === choice ? probability : (1 - probability) / (ACTIONS.length - 1)])) });
const next = (choice: Action, patch: Partial<RunState> = {}, pending = false, failed = false) => chooseNext(answer(choice), state(patch), DEFAULT_ORCHESTRATOR, pending, failed).action;

test("defaults round-trip and the routing question matches the actual Jev API", () => {
	assert.deepEqual(parseOrchestrator(JSON.parse(JSON.stringify(DEFAULT_ORCHESTRATOR))), DEFAULT_ORCHESTRATOR);
	assert.deepEqual(validateQuestion(nextActionQuestion), nextActionQuestion);
});
test("config overlays preserve unrelated roles and prompts without mutating defaults", () => {
	const config = parseOrchestrator({ models: { strong: "provider/custom" }, prompts: { review: "custom review" } });
	assert.equal(config.models.fast, "@smol"); assert.equal(config.models.strong, "provider/custom");
	assert.equal(DEFAULT_ORCHESTRATOR.models.strong, "@slow");
	assert.equal(parseOrchestrator({ thinking: { fast: "medium" } }, config).prompts.review, "custom review");
});
test("config rejects unknown, prototype, invalid and oversized settings", () => {
	for (const invalid of [null, [], { maxSteps: 10 }, { maxSteps: 1.5 }, { timeoutMs: 0 }, { minConfidence: NaN }, { minProbability: 1.1 }, { requireReview: "yes" }, { models: { strong: "" } }, { thinking: { fast: "turbo" } }, { nope: 1 }, JSON.parse('{"__proto__":{}}'), { models: JSON.parse('{"__proto__":"bad"}') }, { prompts: { plan: "x".repeat(16001) } }]) assert.throws(() => parseOrchestrator(invalid));
});
test("strong code stays strong; mechanical code may go fast", () => {
	assert.equal(next("implement_strong"), "implement_strong"); assert.equal(next("implement_fast"), "implement_fast");
	assert.equal(stageRole("implement_strong"), "strong"); assert.equal(stageRole("review"), "reviewer"); assert.equal(stageRole("replan"), "planner");
});
test("uncertainty escalates once and then pauses, rather than cheap guessing", () => {
	assert.equal(chooseNext(answer("implement_fast", 0.2), state(), DEFAULT_ORCHESTRATOR, false).action, "replan");
	assert.equal(chooseNext(answer("implement_fast", 0.99, 0.2), state(), DEFAULT_ORCHESTRATOR, false).action, "replan");
	assert.equal(chooseNext(undefined, state({ escalated: true }), DEFAULT_ORCHESTRATOR, false).action, "ask_user");
});
test("a request for user input always stops, even with low confidence", () => {
	assert.equal(chooseNext(answer("ask_user", 0.1), state(), DEFAULT_ORCHESTRATOR, false).action, "ask_user");
});
test("done cannot skip review, pending todos or failed-tool evidence", () => {
	assert.equal(next("done", { stage: "implement_strong" }), "review");
	assert.equal(next("done", { stage: "review" }), "done");
	assert.equal(next("done", { stage: "review" }, true), "replan");
	assert.equal(next("done", { stage: "review" }, false, true), "replan");
});
test("review requirement can be explicitly disabled, not accidentally bypassed", () => {
	assert.equal(chooseNext(answer("done"), state(), parseOrchestrator({ requireReview: false }), false).action, "done");
});
test("fast failures escalate and repeated stages terminate predictably", () => {
	assert.equal(next("implement_fast", { fastFailures: 2 }), "debug");
	assert.equal(next("inspect", { stage: "inspect", repeated: 2 }), "replan");
	assert.equal(next("replan", { stage: "replan", repeated: 2 }), "ask_user");
});
test("stage cap never grants unreviewed completion", () => {
	assert.equal(next("implement_strong", { steps: 8 }), "ask_user");
	assert.equal(next("done", { steps: 8, stage: "test" }), "ask_user");
	assert.equal(next("done", { steps: 8, stage: "review" }), "done");
});
test("state truncates only history and refuses oversized indispensable state", () => {
	const original = ["x".repeat(4000), "recent"];
	const bounded = routerState(state(), original, [], false, 1000) as Record<string, unknown>;
	assert.deepEqual(bounded.recentMessages, ["recent"]); assert.equal(bounded.historyTruncated, true); assert.equal(original.length, 2);
	assert.throws(() => routerState(state({ goal: "x".repeat(2000) }), [], [], false, 1000));
});
test("worker instructions retain user scope and the chosen stage", () => {
	const prompt = stagePrompt(state({ stage: "implement_strong" }), DEFAULT_ORCHESTRATOR);
	assert.match(prompt, /not new user authorization/); assert.match(prompt, /implement_strong/); assert.match(prompt, /Fix the bug/);
});
test("canonical config honors absolute XDG and explicit directory overrides", () => {
	assert.equal(configHome({}, "/home/test"), "/home/test/.config/omp-jev");
	assert.equal(configHome({ XDG_CONFIG_HOME: "/xdg" }, "/home/test"), "/xdg/omp-jev");
	assert.equal(configHome({ XDG_CONFIG_HOME: "relative" }, "/home/test"), "/home/test/.config/omp-jev");
	assert.equal(configHome({ OMP_JEV_CONFIG_DIR: "/custom" }, "/home/test"), "/custom");
	assert.throws(() => configHome({ OMP_JEV_CONFIG_DIR: "relative" }, "/home/test"));
});
test("legacy global, canonical global, and project paths keep deterministic precedence", () => {
	const paths = configPaths("/repo", "/legacy", "/xdg/omp-jev");
	assert.deepEqual(paths.config, ["/legacy/jev.json", "/xdg/omp-jev/config.json", "/repo/.omp/jev.json"]);
	assert.deepEqual(paths.rules, ["/legacy/.jevrules", "/xdg/omp-jev/rules.json", "/repo/.jevrules"]);
	assert.deepEqual(paths.orchestrator, ["/xdg/omp-jev/orchestrator.json", "/repo/.omp/jev-orchestrator.json"]);
});
