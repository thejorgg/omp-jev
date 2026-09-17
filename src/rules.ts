import { validateQuestion } from "./client.js";
import { isJson, isRecord } from "./guards.js";
import type {
	Answer,
	Gate,
	Json,
	Question,
	Rule,
	RuleAction,
	RuleEvent,
	RuleMatch,
} from "./types.js";

const EVENTS: readonly RuleEvent[] = [
	"before_agent_start",
	"tool_call",
	"tool_result",
	"session_stop",
	"manual",
];
const ACTION_TYPES: readonly string[] = ["message", "block", "continue"];
const GATE_KEYS: readonly string[] = [
	"choice",
	"minProbability",
	"minConfidence",
	"min",
	"max",
];
const RULE_KEYS: readonly string[] = [
	"id",
	"enabled",
	"events",
	"tools",
	"question",
	"state",
	"outcomes",
	"cooldownTurns",
];
const OUTCOME_KEYS: readonly string[] = ["when", "action"];
const ACTION_KEYS: readonly string[] = ["type", "message"];

function fail(path: string, problem: string): never {
	throw new Error(`jev rules: ${path} ${problem}`);
}

function checkKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(path, `has unknown field "${key}"`);
	}
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0)
		fail(path, "must be a non-empty string");
	return value;
}

function requireUnit(value: unknown, path: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 1
	)
		fail(path, "must be a number between 0 and 1");
	return value;
}

function requireFinite(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		fail(path, "must be a finite number");
	return value;
}

function requireQuestion(value: unknown, path: string): Question {
	try {
		return validateQuestion(value);
	} catch (err) {
		fail(
			`${path}.question`,
			`is not a valid Jev question: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function parseEvents(raw: unknown, path: string): RuleEvent[] {
	if (!Array.isArray(raw) || raw.length === 0)
		fail(
			`${path}.events`,
			`must be a non-empty array of rule events (${EVENTS.join(", ")})`,
		);
	return raw.map((event, i) => {
		if (typeof event !== "string" || !EVENTS.includes(event as RuleEvent)) {
			fail(
				`${path}.events[${i}]`,
				`must be one of: ${EVENTS.join(", ")}${typeof event === "string" ? `, got "${event}"` : ""}`,
			);
		}
		return event as RuleEvent;
	});
}

function parseGate(raw: unknown, path: string, question: Question): Gate {
	if (raw === undefined) fail(path, "is required");
	if (!isRecord(raw)) fail(path, "must be an object");
	checkKeys(raw, GATE_KEYS, path);
	const gate: Gate = {};
	if (raw.choice !== undefined)
		gate.choice = requireString(raw.choice, `${path}.choice`);
	if (raw.minProbability !== undefined)
		gate.minProbability = requireUnit(
			raw.minProbability,
			`${path}.minProbability`,
		);
	if (raw.minConfidence !== undefined)
		gate.minConfidence = requireUnit(
			raw.minConfidence,
			`${path}.minConfidence`,
		);
	if (raw.min !== undefined) gate.min = requireFinite(raw.min, `${path}.min`);
	if (raw.max !== undefined) gate.max = requireFinite(raw.max, `${path}.max`);
	if (gate.min !== undefined && gate.max !== undefined && gate.min > gate.max)
		fail(path, `has "min" ${gate.min} greater than "max" ${gate.max}`);
	if (question.type === "choice") {
		if (gate.choice === undefined)
			fail(path, 'must specify an exact "choice" for choice questions');
		if (gate.min !== undefined || gate.max !== undefined) {
			fail(
				path,
				'cannot use "min"/"max" with choice questions (use "choice" plus optional "minProbability"/"minConfidence")',
			);
		}
		if (!Object.hasOwn(question.criteria, gate.choice)) {
			fail(
				path,
				`choice "${gate.choice}" is not defined in question criteria (${Object.keys(question.criteria).join(", ")})`,
			);
		}
	} else if (question.type === "noul") {
		if (
			gate.choice !== undefined ||
			gate.minProbability !== undefined ||
			gate.minConfidence !== undefined
		) {
			fail(
				path,
				'noul questions only support direct "min"/"max" gates (no choice, probability, or confidence)',
			);
		}
		if (gate.min !== undefined && (gate.min < 0 || gate.min > 1))
			fail(`${path}.min`, "must be between 0 and 1 for noul questions");
		if (gate.max !== undefined && (gate.max < 0 || gate.max > 1))
			fail(`${path}.max`, "must be between 0 and 1 for noul questions");
	} else {
		if (gate.choice !== undefined || gate.minProbability !== undefined) {
			fail(
				path,
				'score questions only support "min"/"max" plus optional "minConfidence" gates',
			);
		}
		const top = question.criteria.length - 1;
		if (gate.min !== undefined && (gate.min < 0 || gate.min > top))
			fail(`${path}.min`, `must be a score level between 0 and ${top}`);
		if (gate.max !== undefined && (gate.max < 0 || gate.max > top))
			fail(`${path}.max`, `must be a score level between 0 and ${top}`);
	}
	return gate;
}

function parseAction(
	raw: unknown,
	events: RuleEvent[],
	path: string,
): RuleAction {
	if (!isRecord(raw)) fail(path, 'must be an object with "type" and "message"');
	checkKeys(raw, ACTION_KEYS, path);
	if (typeof raw.type !== "string" || !ACTION_TYPES.includes(raw.type)) {
		fail(
			`${path}.type`,
			`must be one of: ${ACTION_TYPES.join(", ")}${typeof raw.type === "string" ? `, got "${raw.type}"` : ""}`,
		);
	}
	if (typeof raw.message !== "string")
		fail(`${path}.message`, "must be a string");
	if (raw.type === "block" && !events.every((event) => event === "tool_call")) {
		fail(
			path,
			'"block" actions are only allowed on rules listening to the "tool_call" event',
		);
	}
	if (
		raw.type === "continue" &&
		!events.every((event) => event === "session_stop")
	) {
		fail(
			path,
			'"continue" actions are only allowed on rules listening to the "session_stop" event',
		);
	}
	return { type: raw.type as RuleAction["type"], message: raw.message };
}

function parseRule(raw: unknown, path: string): Rule {
	if (!isRecord(raw)) fail(path, "must be an object");
	checkKeys(raw, RULE_KEYS, path);
	const id = requireString(raw.id, `${path}.id`);
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
		fail(`${path}.enabled`, "must be a boolean");
	const events = parseEvents(raw.events, path);
	let tools: string[] | undefined;
	if (raw.tools !== undefined) {
		if (!Array.isArray(raw.tools))
			fail(
				`${path}.tools`,
				'must be an array of tool names (exact names or "*")',
			);
		tools = raw.tools.map((tool, i) =>
			requireString(tool, `${path}.tools[${i}]`),
		);
	}
	const question = requireQuestion(raw.question, path);
	if (raw.state !== undefined && !isJson(raw.state)) {
		fail(
			`${path}.state`,
			"must be valid JSON (null, booleans, finite numbers, strings, arrays, objects)",
		);
	}
	if (!Array.isArray(raw.outcomes) || raw.outcomes.length === 0)
		fail(`${path}.outcomes`, "must be a non-empty array");
	const outcomes = raw.outcomes.map((rawOutcome, i) => {
		const outcomePath = `${path}.outcomes[${i}]`;
		if (!isRecord(rawOutcome))
			fail(outcomePath, 'must be an object with "when" and "action"');
		checkKeys(rawOutcome, OUTCOME_KEYS, outcomePath);
		return {
			when: parseGate(rawOutcome.when, `${outcomePath}.when`, question),
			action: parseAction(rawOutcome.action, events, outcomePath),
		};
	});
	if (
		raw.cooldownTurns !== undefined &&
		(typeof raw.cooldownTurns !== "number" ||
			!Number.isInteger(raw.cooldownTurns) ||
			raw.cooldownTurns < 0)
	) {
		fail(`${path}.cooldownTurns`, "must be a non-negative integer");
	}
	return {
		id,
		enabled: raw.enabled as boolean | undefined,
		events,
		tools,
		question,
		state: raw.state as Json | undefined,
		outcomes,
		cooldownTurns: raw.cooldownTurns as number | undefined,
	};
}

export function parseRules(value: unknown): Rule[] {
	if (!isRecord(value))
		fail("document", 'must be an object with "version" and "rules"');
	checkKeys(value, ["version", "rules"], "document");
	if (value.version !== 1)
		fail(
			"version",
			`must be 1${value.version === undefined ? "" : `, got ${JSON.stringify(value.version)}`}`,
		);
	if (!Array.isArray(value.rules)) fail("rules", "must be an array");
	const seen = new Set<string>();
	return value.rules.map((raw, index) => {
		const rule = parseRule(raw, `rules[${index}]`);
		if (seen.has(rule.id))
			fail(`rules[${index}]`, `duplicates rule id "${rule.id}"`);
		seen.add(rule.id);
		return rule;
	});
}

export function matchesGate(answer: Answer, gate: Gate): boolean {
	if (answer.type === "noul") {
		if (
			gate.choice !== undefined ||
			gate.minProbability !== undefined ||
			gate.minConfidence !== undefined
		)
			return false;
		if (gate.min !== undefined && answer.noul < gate.min) return false;
		if (gate.max !== undefined && answer.noul > gate.max) return false;
		return true;
	}
	if (answer.type === "score") {
		if (gate.choice !== undefined || gate.minProbability !== undefined)
			return false;
		if (gate.min !== undefined && answer.score < gate.min) return false;
		if (gate.max !== undefined && answer.score > gate.max) return false;
		if (
			gate.minConfidence !== undefined &&
			answer.confidence < gate.minConfidence
		)
			return false;
		return true;
	}
	if (
		gate.choice === undefined ||
		gate.min !== undefined ||
		gate.max !== undefined
	)
		return false;
	if (answer.choice !== gate.choice) return false;
	if (gate.minProbability !== undefined) {
		const probability = Object.hasOwn(answer.probabilities, answer.choice)
			? answer.probabilities[answer.choice]
			: 0;
		if (probability < gate.minProbability) return false;
	}
	if (
		gate.minConfidence !== undefined &&
		answer.confidence < gate.minConfidence
	)
		return false;
	return true;
}

export function matchRules(
	rules: Rule[],
	answers: Record<string, Answer>,
): RuleMatch[] {
	const matches: RuleMatch[] = [];
	for (const rule of rules) {
		if (rule.enabled === false) continue;
		if (!Object.hasOwn(answers, rule.id)) continue;
		const answer = answers[rule.id];
		if (answer.type !== rule.question.type) continue;
		for (const outcome of rule.outcomes) {
			if (matchesGate(answer, outcome.when)) {
				matches.push({ rule, answer, action: outcome.action });
				break;
			}
		}
	}
	return matches;
}
