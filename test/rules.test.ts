import { describe, expect, test } from "bun:test";
import { matchRules, matchesGate, parseRules } from "../src/rules.ts";
import type {
	Answer,
	Gate,
	Question,
	Rule,
	RuleAction,
	RuleEvent,
} from "../src/types.ts";

const makeRule = (
	overrides: Partial<Rule> & Pick<Rule, "id" | "outcomes">,
): Rule => ({
	enabled: true,
	events: ["before_agent_start"],
	question: {
		type: "choice",
		instructions: "pick",
		criteria: { a: "option a", b: "option b" },
	},
	...overrides,
});

const choiceAnswer = (
	choice: string,
	probability: number,
	confidence: number,
): Answer => ({
	type: "choice",
	choice,
	probabilities: { [choice]: probability },
	confidence,
});

describe("parseRules", () => {
	test("accepts choice/noul/score rules with structured instructions and arbitrary JSON state", () => {
		const rules = parseRules({
			version: 1,
			rules: [
				{
					id: "pick",
					events: ["tool_call"],
					tools: ["bash", "*"],
					question: {
						type: "choice",
						instructions: "classify",
						criteria: { yes: "y", no: "n" },
					},
					outcomes: [
						{
							when: { choice: "yes", minProbability: 0.7, minConfidence: 0.5 },
							action: { type: "block", message: "blocked" },
						},
					],
				},
				{
					id: "flag",
					enabled: false,
					events: ["before_agent_start"],
					question: {
						type: "noul",
						instructions: { look: ["a", "b"], answer: "bool" },
						criteria: { true: "t", false: "f" },
					},
					state: { nested: { list: [1, "two", null, true] } },
					outcomes: [
						{ when: { min: 0.5 }, action: { type: "message", message: "m" } },
					],
				},
				{
					id: "grade",
					events: ["session_stop"],
					cooldownTurns: 2,
					question: {
						type: "score",
						instructions: "grade it",
						criteria: Array.from({ length: 11 }, (_, i) => String(i)),
					},
					outcomes: [
						{
							when: { min: 7, max: 10, minConfidence: 0.6 },
							action: { type: "continue", message: "continue" },
						},
					],
				},
			],
		});
		expect(rules.map((rule) => rule.id)).toEqual(["pick", "flag", "grade"]);
		expect(rules[0].tools).toEqual(["bash", "*"]);
		expect(rules[1].enabled).toBe(false);
		expect(rules[1].state).toEqual({
			nested: { list: [1, "two", null, true] },
		});
		expect(rules[2].cooldownTurns).toBe(2);
	});

	test("rejects gates incompatible with the question type", () => {
		const doc = (question: Question, when: Gate) => ({
			version: 1,
			rules: [
				{
					id: "r",
					events: ["before_agent_start"],
					question,
					outcomes: [{ when, action: { type: "message", message: "m" } }],
				},
			],
		});
		const choiceQuestion: Question = {
			type: "choice",
			instructions: "i",
			criteria: { a: "a", b: "b" },
		};
		const noulQuestion: Question = { type: "noul", instructions: "i" };
		const scoreQuestion: Question = {
			type: "score",
			instructions: "i",
			criteria: ["low", "high"],
		};
		expect(() =>
			parseRules(doc(noulQuestion, { min: 0.5, minProbability: 0.5 })),
		).toThrow();
		expect(() =>
			parseRules(doc(noulQuestion, { minConfidence: 0.5 })),
		).toThrow();
		expect(() =>
			parseRules(doc(choiceQuestion, { choice: "a", min: 0 })),
		).toThrow();
		expect(() => parseRules(doc(choiceQuestion, {}))).toThrow();
		expect(() =>
			parseRules(doc(scoreQuestion, { min: 1, minProbability: 0.5 })),
		).toThrow();
		expect(() => parseRules(doc(scoreQuestion, { choice: "a" }))).toThrow();
		expect(() => parseRules(doc(choiceQuestion, { choice: "zzz" }))).toThrow();
		expect(() => parseRules(doc(noulQuestion, { min: 1.5 }))).toThrow();
		expect(() => parseRules(doc(scoreQuestion, { max: 5 }))).toThrow();
	});

	test("allows block only on tool_call and continue only on session_stop", () => {
		const doc = (events: RuleEvent[], action: RuleAction) => ({
			version: 1,
			rules: [
				{
					id: "r",
					events,
					question: {
						type: "choice",
						instructions: "i",
						criteria: { a: "a", b: "b" },
					},
					outcomes: [{ when: { choice: "a" }, action }],
				},
			],
		});
		expect(() =>
			parseRules(doc(["session_stop"], { type: "block", message: "m" })),
		).toThrow();
		expect(() =>
			parseRules(doc(["tool_call", "manual"], { type: "block", message: "m" })),
		).toThrow();
		expect(() =>
			parseRules(doc(["tool_call"], { type: "continue", message: "m" })),
		).toThrow();
		expect(() =>
			parseRules(
				doc(["session_stop", "manual"], { type: "continue", message: "m" }),
			),
		).toThrow();
		expect(
			parseRules(doc(["tool_call"], { type: "block", message: "m" }))[0]
				.outcomes[0].action.type,
		).toBe("block");
		expect(
			parseRules(doc(["session_stop"], { type: "continue", message: "m" }))[0]
				.outcomes[0].action.type,
		).toBe("continue");
		expect(
			parseRules(
				doc(["before_agent_start", "manual"], {
					type: "message",
					message: "m",
				}),
			)[0].events,
		).toEqual(["before_agent_start", "manual"]);
	});

	test("rejects malformed documents, gates, actions, and state", () => {
		const baseRule = {
			id: "r",
			events: ["before_agent_start"],
			question: { type: "noul", instructions: "i" },
			outcomes: [
				{ when: { min: 0.5 }, action: { type: "message", message: "m" } },
			],
		};
		expect(() => parseRules({ version: 2, rules: [baseRule] })).toThrow();
		expect(() => parseRules({ rules: [baseRule] })).toThrow();
		expect(() =>
			parseRules({ version: 1, rules: [baseRule], extra: true }),
		).toThrow();
		expect(() =>
			parseRules({ version: 1, rules: [baseRule, { ...baseRule }] }),
		).toThrow();
		expect(() =>
			parseRules({
				version: 1,
				rules: [{ ...baseRule, events: ["tool_cal"] }],
			}),
		).toThrow();
		expect(() =>
			parseRules({ version: 1, rules: [{ ...baseRule, cooldownTurns: -1 }] }),
		).toThrow();
		expect(() =>
			parseRules({
				version: 1,
				rules: [{ ...baseRule, state: { fn: () => 1 } }],
			}),
		).toThrow();
		expect(() =>
			parseRules({
				version: 1,
				rules: [
					{
						...baseRule,
						outcomes: [
							{ when: { mins: 1 }, action: { type: "message", message: "m" } },
						],
					},
				],
			}),
		).toThrow();
		expect(() =>
			parseRules({
				version: 1,
				rules: [
					{
						...baseRule,
						outcomes: [
							{
								when: { min: 0.9, max: 0.5 },
								action: { type: "message", message: "m" },
							},
						],
					},
				],
			}),
		).toThrow();
		expect(() =>
			parseRules({
				version: 1,
				rules: [
					{
						...baseRule,
						outcomes: [
							{ when: { min: 1 }, action: { type: "noop", message: "m" } },
						],
					},
				],
			}),
		).toThrow();
		expect(() =>
			parseRules({
				version: 1,
				rules: [
					{ ...baseRule, question: { type: "choice", instructions: "i" } },
				],
			}),
		).toThrow();
	});
});

describe("matchesGate", () => {
	test("noul min/max boundaries are inclusive", () => {
		const gate: Gate = { min: 0.75, max: 0.9 };
		expect(matchesGate({ type: "noul", noul: 0.75 }, gate)).toBe(true);
		expect(matchesGate({ type: "noul", noul: 0.9 }, gate)).toBe(true);
		expect(matchesGate({ type: "noul", noul: 0.749 }, gate)).toBe(false);
		expect(matchesGate({ type: "noul", noul: 0.91 }, gate)).toBe(false);
		expect(matchesGate({ type: "noul", noul: 0.1 }, {})).toBe(true);
		expect(matchesGate({ type: "noul", noul: 0.9 }, { choice: "x" })).toBe(
			false,
		);
		expect(
			matchesGate({ type: "noul", noul: 0.9 }, { minConfidence: 0.5 }),
		).toBe(false);
	});

	test("score boundaries are inclusive and honor confidence", () => {
		const gate: Gate = { min: 7, max: 10, minConfidence: 0.6 };
		expect(
			matchesGate(
				{
					type: "score",
					score: 7,
					legend: {},
					probabilities: {},
					confidence: 0.6,
				},
				gate,
			),
		).toBe(true);
		expect(
			matchesGate(
				{
					type: "score",
					score: 10,
					legend: {},
					probabilities: {},
					confidence: 1,
				},
				gate,
			),
		).toBe(true);
		expect(
			matchesGate(
				{
					type: "score",
					score: 6.99,
					legend: {},
					probabilities: {},
					confidence: 0.9,
				},
				gate,
			),
		).toBe(false);
		expect(
			matchesGate(
				{
					type: "score",
					score: 10,
					legend: {},
					probabilities: {},
					confidence: 0.59,
				},
				gate,
			),
		).toBe(false);
		expect(
			matchesGate(
				{
					type: "score",
					score: 5,
					legend: {},
					probabilities: {},
					confidence: 0.9,
				},
				{ minProbability: 0.5 },
			),
		).toBe(false);
	});

	test("choice requires the exact choice plus probability/confidence thresholds", () => {
		const gate: Gate = {
			choice: "map",
			minProbability: 0.7,
			minConfidence: 0.6,
		};
		expect(matchesGate(choiceAnswer("map", 0.7, 0.6), gate)).toBe(true);
		expect(matchesGate(choiceAnswer("map", 0.69, 0.6), gate)).toBe(false);
		expect(matchesGate(choiceAnswer("map", 0.7, 0.59), gate)).toBe(false);
		expect(matchesGate(choiceAnswer("record", 0.9, 0.9), gate)).toBe(false);
		expect(matchesGate(choiceAnswer("map", 0.9, 0.9), { min: 0.5 })).toBe(
			false,
		);
		expect(matchesGate(choiceAnswer("map", 0.9, 0.9), {})).toBe(false);
	});
});

describe("matchRules", () => {
	test("emits the first matching outcome per rule, skipping disabled and unanswered rules", () => {
		const first = makeRule({
			id: "first",
			outcomes: [
				{
					when: { choice: "yes", minProbability: 0.9 },
					action: { type: "message", message: "first" },
				},
				{
					when: { choice: "yes" },
					action: { type: "message", message: "second" },
				},
			],
		});
		const disabled = makeRule({
			id: "disabled",
			enabled: false,
			outcomes: [
				{
					when: { choice: "yes" },
					action: { type: "message", message: "off" },
				},
			],
		});
		const unmatched = makeRule({
			id: "unmatched",
			outcomes: [
				{ when: { choice: "no" }, action: { type: "message", message: "no" } },
			],
		});
		const answers = {
			first: choiceAnswer("yes", 0.95, 0.9),
			unmatched: choiceAnswer("yes", 1, 1),
		};
		const matches = matchRules([first, disabled, unmatched], answers);
		expect(matches).toHaveLength(1);
		expect(matches[0].rule.id).toBe("first");
		expect(matches[0].action.message).toBe("first");
		expect(matches[0].answer).toEqual(answers.first);
	});

	test("matches noul and score rules against their own answer kinds", () => {
		const noulRule = makeRule({
			id: "noul",
			question: { type: "noul", instructions: "i" },
			outcomes: [
				{ when: { min: 0.5 }, action: { type: "message", message: "n" } },
			],
		});
		const scoreRule = makeRule({
			id: "score",
			question: { type: "score", instructions: "i", criteria: ["low", "high"] },
			outcomes: [
				{ when: { min: 8 }, action: { type: "continue", message: "go" } },
			],
		});
		const matches = matchRules([noulRule, scoreRule], {
			noul: { type: "noul", noul: 0.6 },
			score: {
				type: "score",
				score: 8,
				legend: {},
				probabilities: {},
				confidence: 0.5,
			},
		});
		expect(matches.map((match) => match.rule.id)).toEqual(["noul", "score"]);
		expect(matchRules([noulRule], {})).toEqual([]);
	});
});
