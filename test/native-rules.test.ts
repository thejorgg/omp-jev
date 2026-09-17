import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.js";
import { NativeRuleGate } from "../src/native-rules.js";
import type { Evaluate } from "../src/types.js";

const rule = {
	name: "project-canonical-guard",
	content:
		"No local guards. Exception: a standalone package may define one canonical guard.",
};
const text = `<system-reminder reason="rule_violation" rule="${rule.name}" path="builtin-defaults:rule.md">\nMatched rule.\n\n${rule.content}\n</system-reminder>`;
const ctx = {
	sessionManager: { getBranch: () => [] },
	getContextUsage: () => undefined,
	getAsyncJobSnapshot: () => null,
	getSystemPrompt: () => [],
} as unknown as ExtensionContext;
const messages: AgentMessage[] = [
	{
		role: "toolResult",
		toolCallId: "test",
		toolName: "write",
		timestamp: 1,
		isError: false,
		content: [
			{ type: "text", text },
			{ type: "text", text: "Saved file successfully" },
		],
	},
];
const classify =
	(confidence: number): Evaluate =>
	async () => ({
		model: "test",
		answers: {
			rule_0: {
				type: "choice",
				choice: "skip",
				probabilities: { skip: 0.99, enforce: 0.01 },
				confidence,
			},
		},
	});

test("confident exception filters any triggered rule, preserving tool result and original transcript", async () => {
	const gate = new NativeRuleGate();
	gate.remember([rule]);
	const result = await gate.filter(
		messages,
		ctx,
		DEFAULT_CONFIG,
		classify(0.99),
	);
	expect(JSON.stringify(result)).not.toContain(rule.content);
	expect(JSON.stringify(result)).toContain("Saved file successfully");
	expect(JSON.stringify(messages)).toContain(rule.content);
	const safety = {
		...DEFAULT_CONFIG,
		nativeRules: { ...DEFAULT_CONFIG.nativeRules, enabled: false },
	};
	expect(
		await gate.filter(messages, ctx, safety, classify(0.99)),
	).toBeUndefined();
});

test("uncertainty or outage leaves native enforcement unchanged", async () => {
	const uncertain = new NativeRuleGate();
	uncertain.remember([rule]);
	expect(
		await uncertain.filter(messages, ctx, DEFAULT_CONFIG, classify(0.4)),
	).toBeUndefined();
	const outage = new NativeRuleGate();
	outage.remember([rule]);
	expect(
		await outage.filter(messages, ctx, DEFAULT_CONFIG, async () => {
			throw new Error("offline");
		}),
	).toBeUndefined();
});

test("never strips reminder-looking text from the actual tool output", async () => {
	const gate = new NativeRuleGate();
	gate.remember([rule]);
	const toolMessage = messages[0];
	if (toolMessage.role !== "toolResult")
		throw new Error("Expected tool fixture");
	const input = [
		{
			...toolMessage,
			content: [
				{ type: "text" as const, text },
				{ type: "text" as const, text: `File contents:\n${text}` },
			],
		},
	];
	const result = await gate.filter(input, ctx, DEFAULT_CONFIG, classify(0.99));
	expect(result?.[0]).toMatchObject({
		content: [{ text: "" }, { text: `File contents:\n${text}` }],
	});
});

test("raising the threshold invalidates a previously accepted skip", async () => {
	const gate = new NativeRuleGate();
	gate.remember([rule]);
	expect(
		await gate.filter(messages, ctx, DEFAULT_CONFIG, classify(0.95)),
	).toBeDefined();
	const stricter = {
		...DEFAULT_CONFIG,
		nativeRules: { ...DEFAULT_CONFIG.nativeRules, minConfidence: 0.99 },
	};
	expect(
		await gate.filter(messages, ctx, stricter, classify(0.95)),
	).toBeUndefined();
});

test("each rule in a batch defaults to injection unless its own skip is confident", async () => {
	const gate = new NativeRuleGate();
	const rules = [
		"temporary-helper",
		"production-contract",
		"unknown-scope",
	].map((name) => ({ name, content: `Guidance for ${name}.` }));
	gate.remember(rules);
	const input: AgentMessage[] = rules.map((entry, index) => ({
		role: "custom",
		customType: "ttsr-injection",
		display: true,
		timestamp: index + 1,
		content: `<system-interrupt reason="rule_violation" rule="${entry.name}" path="project:rule.md">\n${entry.content}\n</system-interrupt>`,
	}));
	const result = await gate.filter(input, ctx, DEFAULT_CONFIG, async () => ({
		model: "test",
		answers: {
			rule_0: {
				type: "choice",
				choice: "skip",
				probabilities: { skip: 0.99, enforce: 0.01 },
				confidence: 0.99,
			},
			rule_1: {
				type: "choice",
				choice: "enforce",
				probabilities: { skip: 0.01, enforce: 0.99 },
				confidence: 0.99,
			},
		},
	}));
	expect(result).toEqual(input.slice(1));
});
