import type {
	Answer,
	ClientConfig,
	Entry,
	Evaluation,
	Json,
	Question,
} from "./types.js";

// Docs: https://docs.typesafe.ai/api.md — POST {state, model, questions} with a
// Bearer key; one validated answer per question id comes back. Hot hook path:
// single batched request, no retries, hard timeout, fails closed on anything
// the API contract does not guarantee.
const PROB_SUM_TOLERANCE = 0.01;

function fail(message: string): never {
	throw new Error(`jev: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isJson(value: unknown): value is Json {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	return isPlainObject(value) && Object.values(value).every(isJson);
}

// Entry = what questions may carry as instructions/criteria: string, null,
// array, or plain object of JSON (numbers/booleans only nested, per docs).
function isEntry(value: unknown): value is Entry {
	if (value === null || typeof value === "string") return true;
	if (Array.isArray(value)) return value.every(isJson);
	return isPlainObject(value) && Object.values(value).every(isJson);
}

function rejectUnknownFields(
	value: Record<string, unknown>,
	allowed: string[],
	where: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(`${where} has unknown field "${key}"`);
	}
}

export function validateQuestion(value: unknown): Question {
	if (!isPlainObject(value)) fail("question must be an object");
	const type = value.type;
	if (type !== "noul" && type !== "choice" && type !== "score") {
		fail(`question has invalid type ${JSON.stringify(type)}`);
	}
	rejectUnknownFields(
		value,
		["type", "instructions", "criteria"],
		`${type} question`,
	);
	if (value.instructions === undefined)
		fail(`${type} question is missing "instructions"`);
	if (!isEntry(value.instructions))
		fail(
			`${type} question "instructions" must be a string, null, array, or plain object`,
		);
	if (type === "noul") {
		if (value.criteria === undefined) return value as Question;
		if (!isPlainObject(value.criteria))
			fail('noul question "criteria" must be an object');
		rejectUnknownFields(
			value.criteria,
			["true", "false"],
			'noul question "criteria"',
		);
		for (const key of ["true", "false"] as const) {
			if (value.criteria[key] !== undefined && !isEntry(value.criteria[key])) {
				fail(
					`noul question criteria.${key} must be a string, null, array, or plain object`,
				);
			}
		}
	} else if (type === "choice") {
		if (value.criteria === undefined)
			fail('choice question is missing "criteria"');
		if (!isPlainObject(value.criteria))
			fail('choice question "criteria" must be an object');
		if (Object.keys(value.criteria).length < 2)
			fail("choice question needs at least 2 options");
		for (const [option, entry] of Object.entries(value.criteria)) {
			if (!isEntry(entry))
				fail(
					`choice option "${option}" must be a string, null, array, or plain object`,
				);
		}
	} else {
		if (value.criteria === undefined)
			fail('score question is missing "criteria"');
		if (!Array.isArray(value.criteria))
			fail('score question "criteria" must be an array of level descriptions');
		if (value.criteria.length < 2)
			fail("score question needs at least 2 levels");
		for (const [index, entry] of value.criteria.entries()) {
			if (!isEntry(entry))
				fail(
					`score level ${index} must be a string, null, array, or plain object`,
				);
		}
	}
	return value as Question;
}

function prob(value: unknown, where: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 1
	) {
		fail(`${where} must be a finite number in [0, 1]`);
	}
	return value;
}

function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => key in value);
}

function probDistribution(
	value: unknown,
	keys: string[],
	where: string,
): Record<string, number> {
	if (!isPlainObject(value) || !sameKeys(value, keys)) {
		fail(
			`${where} "probabilities" must have exactly the keys ${keys.map((key) => `"${key}"`).join(", ")}`,
		);
	}
	const out: Record<string, number> = Object.create(null);
	let sum = 0;
	for (const key of keys) {
		out[key] = prob(value[key], `${where} probabilities["${key}"]`);
		sum += out[key];
	}
	if (Math.abs(sum - 1) > PROB_SUM_TOLERANCE) {
		fail(
			`${where} probabilities must sum to 1 within ${PROB_SUM_TOLERANCE} (got ${sum})`,
		);
	}
	return out;
}

export function validateAnswer(question: Question, value: unknown): Answer {
	if (!isPlainObject(value)) fail("answer must be an object");
	if (value.type !== question.type) {
		fail(`answer type does not match question type "${question.type}"`);
	}
	if (question.type === "noul") {
		// Noul is a bare probability — it has no confidence field by design.
		rejectUnknownFields(value, ["type", "noul"], "noul answer");
		return { type: "noul", noul: prob(value.noul, 'noul answer "noul"') };
	}
	if (question.type === "choice") {
		rejectUnknownFields(
			value,
			["type", "choice", "probabilities", "confidence"],
			"choice answer",
		);
		const options = Object.keys(question.criteria);
		if (typeof value.choice !== "string" || !options.includes(value.choice)) {
			fail("choice answer is not one of the question options");
		}
		const probabilities = probDistribution(
			value.probabilities,
			options,
			"choice answer",
		);
		if (
			probabilities[value.choice] < Math.max(...Object.values(probabilities))
		) {
			fail(
				`choice answer "${value.choice}" is not the highest-probability option`,
			);
		}
		return {
			type: "choice",
			choice: value.choice,
			probabilities,
			confidence: prob(value.confidence, 'choice answer "confidence"'),
		};
	}
	rejectUnknownFields(
		value,
		["type", "score", "legend", "probabilities", "confidence"],
		"score answer",
	);
	const levelKeys = Array.from({ length: question.criteria.length }, (_, i) =>
		String(i),
	);
	if (
		typeof value.score !== "number" ||
		!Number.isFinite(value.score) ||
		value.score < 0 ||
		value.score > levelKeys.length - 1
	) {
		fail(
			`score answer must be a finite number in [0, ${levelKeys.length - 1}]`,
		);
	}
	if (!isPlainObject(value.legend) || !sameKeys(value.legend, levelKeys)) {
		fail(
			`score answer "legend" must map exactly the level keys ${levelKeys.map((key) => `"${key}"`).join(", ")}`,
		);
	}
	const legend: Record<string, Entry> = {};
	for (const key of levelKeys) {
		if (!isEntry(value.legend[key]))
			fail(
				`score answer legend["${key}"] must be a string, null, array, or plain object`,
			);
		legend[key] = value.legend[key] as Entry;
	}
	return {
		type: "score",
		score: value.score,
		legend,
		probabilities: probDistribution(
			value.probabilities,
			levelKeys,
			"score answer",
		),
		confidence: prob(value.confidence, 'score answer "confidence"'),
	};
}

function parseEndpoint(config: Record<string, unknown>): string {
	const raw = config.endpoint;
	if (typeof raw !== "string" || raw.length === 0)
		fail('config "endpoint" must be a nonempty string');
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		fail('config "endpoint" is not a valid URL');
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		fail('config "endpoint" must use http(s)');
	if (url.username !== "" || url.password !== "")
		fail('config "endpoint" must not embed credentials');
	const hostname = url.hostname;
	const loopback =
		hostname === "localhost" ||
		hostname === "[::1]" ||
		/^127\.\d+\.\d+\.\d+$/.test(hostname);
	if (url.protocol === "http:" && !loopback)
		fail(
			'config "endpoint" must use https (http is allowed only for loopback hosts)',
		);
	return url.toString();
}

function requireString(config: Record<string, unknown>, field: string): string {
	const value = config[field];
	if (typeof value !== "string" || value.length === 0)
		fail(`config "${field}" must be a nonempty string`);
	return value;
}

function requireTimeoutMs(config: Record<string, unknown>): number {
	const value = config.timeoutMs;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		fail('config "timeoutMs" must be a positive finite number');
	return value;
}

function abortCause(
	signal: AbortSignal | undefined,
	timer: AbortSignal,
	timeoutMs: number,
): Error | null {
	if (signal?.aborted) return new Error("jev: evaluate aborted by caller");
	if (timer.aborted)
		return new Error(`jev: evaluate timed out after ${timeoutMs}ms`);
	return null;
}

export async function evaluate(
	config: ClientConfig,
	state: Json,
	questions: Record<string, Question>,
	signal?: AbortSignal,
): Promise<Evaluation> {
	if (!isPlainObject(config)) fail("config must be an object");
	const endpoint = parseEndpoint(config);
	const model = requireString(config, "model");
	const apiKeyEnv = requireString(config, "apiKeyEnv");
	const timeoutMs = requireTimeoutMs(config);
	const apiKey = process.env[apiKeyEnv];
	if (typeof apiKey !== "string" || apiKey.length === 0)
		fail(`API key environment variable "${apiKeyEnv}" is not set`);

	if (!isJson(state)) fail("state must be valid JSON");
	if (!isPlainObject(questions)) fail("questions must be an object");
	const ids = Object.keys(questions);
	if (ids.length === 0) fail("questions map must not be empty");
	for (const id of ids) validateQuestion(questions[id]);

	// One batched request for the whole map; the API answers under the same ids.
	const body = JSON.stringify({ state, model, questions });
	const timer = AbortSignal.timeout(timeoutMs);
	const abortSignal = signal ? AbortSignal.any([signal, timer]) : timer;
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body,
			redirect: "error",
			signal: abortSignal,
		});
	} catch {
		throw (
			abortCause(signal, timer, timeoutMs) ??
			new Error("jev: evaluate network request failed")
		);
	}
	if (!response.ok)
		fail(`evaluate request failed with HTTP ${response.status}`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		// No cause: parser errors can quote fragments of the raw body.
		throw (
			abortCause(signal, timer, timeoutMs) ??
			new Error("jev: evaluate response was not valid JSON")
		);
	}
	if (!isPlainObject(payload)) fail("evaluate response must be an object");
	if (typeof payload.model !== "string" || payload.model.length === 0)
		fail('evaluate response is missing "model"');
	if (!isPlainObject(payload.answers))
		fail('evaluate response is missing "answers" map');

	const answers: Record<string, Answer> = Object.create(null);
	for (const id of ids) {
		const raw = payload.answers[id];
		if (raw === undefined)
			fail(`evaluate response is missing an answer for question "${id}"`);
		answers[id] = validateAnswer(questions[id], raw);
	}
	for (const id of Object.keys(payload.answers)) {
		if (!Object.hasOwn(answers, id))
			fail("evaluate response has an unexpected answer");
	}
	return { model: payload.model, answers };
}
