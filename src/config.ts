import { readFile } from "node:fs/promises";
import { isRecord } from "./guards.js";
import { parseRules } from "./rules.js";
import type { JevConfig, Rule } from "./types.js";

export const DEFAULT_CONFIG: JevConfig = {
	version: 1,
	enabled: false,
	client: {
		endpoint: "https://api.typesafe.ai/v1/systemone",
		model: "jev-latest",
		apiKeyEnv: "TYPESAFE_API_KEY",
		timeoutMs: 5000,
	},
	context: {
		maxChars: 48000,
		recentMessages: 12,
		includeSystemPrompt: false,
		redactKeys: [
			"authorization",
			"apiKey",
			"api_key",
			"password",
			"token",
			"secret",
			"access_token",
		],
	},
	thinking: { enabled: false, minConfidence: 0.75, minProbability: 0.7 },
	delegation: {
		enabled: false,
		minConfidence: 0.75,
		minProbability: 0.7,
		overrideExplicit: false,
	},
	safety: {
		enabled: false,
		minConfidence: 0.8,
		minProbability: 0.8,
		tools: ["bash", "eval", "write", "edit", "ssh", "task", "hub"],
		onUncertain: "block",
		onError: "block",
	},
	nativeRules: {
		enabled: false,
		minConfidence: 0.9,
		minProbability: 0.9,
	},
	recovery: {
		enabled: false,
		minConfidence: 0.8,
		minProbability: 0.75,
		maxContinuations: 2,
	},
};

type LeafParser = (value: unknown, path: string) => unknown;
type SchemaNode = LeafParser | { [key: string]: SchemaNode };

function fail(path: string, problem: string): never {
	throw new Error(`jev config: ${path} ${problem}`);
}

function bool(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail(path, "must be a boolean");
	return value;
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0)
		fail(path, "must be a non-empty string");
	return value;
}

function unit(value: unknown, path: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 1
	)
		fail(path, "must be a number between 0 and 1");
	return value;
}

const boundedInt =
	(min: number, max: number) =>
	(value: unknown, path: string): number => {
		if (
			typeof value !== "number" ||
			!Number.isInteger(value) ||
			value < min ||
			value > max
		) {
			fail(
				path,
				`must be an integer between ${min} and ${max}${typeof value === "number" ? `, got ${value}` : ""}`,
			);
		}
		return value;
	};

const oneOf =
	<T extends string>(...allowed: T[]) =>
	(value: unknown, path: string): T => {
		if (typeof value !== "string" || !allowed.includes(value as T))
			fail(path, `must be one of: ${allowed.join(", ")}`);
		return value as T;
	};

function stringList(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) fail(path, "must be an array of strings");
	return value.map((entry, i) => text(entry, `${path}[${i}]`));
}

const literal =
	(expected: unknown, label: string) =>
	(value: unknown, path: string): unknown => {
		if (value !== expected)
			fail(
				path,
				`must be ${label}${value === undefined ? "" : `, got ${JSON.stringify(value)}`}`,
			);
		return expected;
	};

const POLICY: { [key: string]: SchemaNode } = {
	enabled: bool,
	minConfidence: unit,
	minProbability: unit,
};

const CONFIG_SCHEMA: { [key: string]: SchemaNode } = {
	version: literal(1, "1"),
	enabled: bool,
	client: {
		endpoint: text,
		model: text,
		apiKeyEnv: text,
		timeoutMs: boundedInt(100, 120_000),
	},
	context: {
		maxChars: boundedInt(1_024, 1_000_000),
		recentMessages: boundedInt(0, 100),
		includeSystemPrompt: bool,
		redactKeys: stringList,
	},
	thinking: POLICY,
	delegation: { ...POLICY, overrideExplicit: bool },
	safety: {
		...POLICY,
		tools: stringList,
		onUncertain: oneOf("block", "allow"),
		onError: oneOf("block", "allow"),
	},
	nativeRules: POLICY,
	recovery: { ...POLICY, maxContinuations: boundedInt(0, 3) },
};

function applySection(
	schema: { [key: string]: SchemaNode },
	value: unknown,
	defaults: Record<string, unknown>,
	path: string,
): Record<string, unknown> {
	if (value === undefined) return structuredClone(defaults);
	if (!isRecord(value)) fail(path || "config", "must be an object");
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(schema, key))
			fail(path ? `${path}.${key}` : key, "is not a recognized field");
	}
	const parsed: Record<string, unknown> = {};
	for (const [key, node] of Object.entries(schema)) {
		const child = value[key];
		const childPath = path ? `${path}.${key}` : key;
		if (child === undefined) {
			parsed[key] = structuredClone(defaults[key]);
		} else if (typeof node === "function") {
			parsed[key] = node(child, childPath);
		} else if (isRecord(defaults[key])) {
			parsed[key] = applySection(node, child, defaults[key], childPath);
		} else {
			parsed[key] = applySection(node, child, {}, childPath);
		}
	}
	return parsed;
}

export function parseConfig(value: unknown): JevConfig {
	return applySection(
		CONFIG_SCHEMA,
		value,
		DEFAULT_CONFIG as unknown as Record<string, unknown>,
		"",
	) as unknown as JevConfig;
}

function mergeRaw(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (key === "__proto__")
			fail(
				key,
				"is not a permitted config field (prototype keys are rejected)",
			);
		const current = merged[key];
		merged[key] =
			isRecord(current) && isRecord(value) ? mergeRaw(current, value) : value;
	}
	return merged;
}

export async function loadConfig(path: string | string[]): Promise<JevConfig> {
	const paths = Array.isArray(path) ? path : [path];
	let raw: Record<string, unknown> = {};
	for (const filePath of paths) {
		let file: string;
		try {
			file = await readFile(filePath, "utf8");
		} catch (err) {
			if (isRecord(err) && err.code === "ENOENT") continue;
			throw new Error(
				`jev config: cannot read config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(file);
		} catch (err) {
			throw new Error(
				`jev config: config file ${filePath} contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (!isRecord(parsed))
			fail(`config file ${filePath}`, "must contain a JSON object");
		raw = mergeRaw(raw, parsed);
	}
	return parseConfig(raw);
}

export async function loadRules(paths: string[]): Promise<Rule[]> {
	const rules: Rule[] = [];
	for (const filePath of paths) {
		let file: string;
		try {
			file = await readFile(filePath, "utf8");
		} catch (err) {
			if (isRecord(err) && err.code === "ENOENT") continue;
			throw new Error(
				`jev rules: cannot read rules file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(file);
		} catch (err) {
			throw new Error(
				`jev rules: rules file ${filePath} contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		for (const rule of parseRules(parsed)) {
			// Later files win by ID: project rules intentionally replace global ones (global -> project merge).
			const existing = rules.findIndex((loaded) => loaded.id === rule.id);
			if (existing === -1) rules.push(rule);
			else rules[existing] = rule;
		}
	}
	return rules;
}
