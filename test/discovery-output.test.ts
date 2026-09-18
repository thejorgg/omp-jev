import { expect, test } from "bun:test";
import type { DiscoveryFinding } from "../src/discovery.js";
import type { DispatcherResult } from "../src/dispatcher.js";
import {
	formatDispatcherResult,
	sourceBlockLabel,
	sourceBlockLines,
	sourceBlocks,
} from "../src/discovery-output.js";

function finding(
	overrides: Partial<DiscoveryFinding> & { path: string },
): DiscoveryFinding {
	return { via: "grep", ...overrides };
}

function result(overrides: Partial<DispatcherResult> = {}): DispatcherResult {
	return {
		status: "finished",
		results: [],
		toolCalls: 12,
		decisions: 4,
		elapsedMs: 8200,
		findings: [],
		warnings: [],
		remainingTasks: [],
		...overrides,
	};
}

test("overlapping agreeing findings coalesce into one exact block", () => {
	const blocks = sourceBlocks([
		finding({
			path: "src/a.ts",
			line: 10,
			endLine: 12,
			text: "10|alpha\n11|beta\n12|gamma",
			relevance: 0.9,
		}),
		finding({
			path: "src/a.ts",
			line: 11,
			endLine: 14,
			text: "11|beta\n12|gamma\n13|delta\n14|epsilon",
			via: "read",
			relevance: 0.8,
		}),
	]);
	expect(blocks).toHaveLength(1);
	expect(blocks[0]!.segments).toEqual([{ start: 10, end: 14 }]);
	expect(blocks[0]!.lines).toEqual([
		{ line: 10, content: "alpha" },
		{ line: 11, content: "beta" },
		{ line: 12, content: "gamma" },
		{ line: 13, content: "delta" },
		{ line: 14, content: "epsilon" },
	]);
	expect(blocks[0]!.via).toEqual(["grep", "read"]);
	expect(blocks[0]!.relevance).toBe(0.9);
});

test("disjoint ranges stay separate segments with an elision marker", () => {
	const blocks = sourceBlocks([
		finding({ path: "src/a.ts", line: 10, text: "10|one\n11|two" }),
		finding({ path: "src/a.ts", line: 20, text: "20|three" }),
	]);
	expect(blocks).toHaveLength(1);
	expect(blocks[0]!.segments).toEqual([
		{ start: 10, end: 11 },
		{ start: 20, end: 20 },
	]);
	expect(sourceBlockLines(blocks[0]!)).toEqual([
		"10|one",
		"11|two",
		"…",
		"20|three",
	]);
});

test("conflicting overlapping source is not silently merged", () => {
	const blocks = sourceBlocks([
		finding({ path: "src/a.ts", line: 10, text: "10|left" }),
		finding({
			path: "src/a.ts",
			line: 10,
			endLine: 11,
			text: "10|right\n11|other",
		}),
	]);
	expect(blocks).toHaveLength(2);
	expect(sourceBlockLines(blocks[0]!)).toEqual(["10|left"]);
	expect(sourceBlockLines(blocks[1]!)).toEqual(["10|right", "11|other"]);
});

test("relevance ranks blocks first and unranked partial evidence stays marked", () => {
	const blocks = sourceBlocks([
		finding({ path: "b.ts", line: 1 }),
		finding({ path: "c.ts", line: 1, relevance: 0.7 }),
		finding({ path: "a.ts", line: 1, relevance: 0.9 }),
	]);
	expect(blocks.map((block) => block.path)).toEqual(["a.ts", "c.ts", "b.ts"]);
	expect(blocks[2]!.relevance).toBeUndefined();
	expect(sourceBlockLabel(blocks[2]!)).toContain("unranked");
	expect(sourceBlockLabel(blocks[0]!)).toContain("relevance 0.90");
});

test("single numbered-looking row is only trusted when it matches its anchor", () => {
	const mismatched = sourceBlocks([
		finding({ path: "data.txt", line: 5, text: "99|123|fallback" }),
	]);
	expect(mismatched[0]!.lines).toEqual([
		{ line: 5, content: "99|123|fallback" },
	]);
	const trusted = sourceBlocks([
		finding({ path: "src/a.ts", line: 7, text: "7|matched" }),
	]);
	expect(trusted[0]!.lines).toEqual([{ line: 7, content: "matched" }]);
});

test("aborted results never read as complete and keep the abort notice", () => {
	const output = formatDispatcherResult(
		result({
			status: "aborted",
			findings: [finding({ path: "src/a.ts", line: 3, text: "3|hit" })],
			warnings: [
				"Cancelled; collected locations are partial. Remaining tasks were not completed.",
			],
		}),
	);
	expect(output).toContain("aborted before completion; findings are partial");
	expect(output).toContain("Cancelled; collected locations are partial");
	expect(output).toContain("3|hit");
	expect(output).not.toContain("finished");
	expect(output).not.toContain('"findings"');
	expect(output.match(/3\|hit/g)).toHaveLength(1);
});

test("escalated results surface unresolved work", () => {
	const output = formatDispatcherResult(
		result({
			status: "escalated",
			results: [
				{
					task: { id: "routes", description: "Read the refresh flow" },
					status: "REQUIRE_BIGGER_MODEL",
					summary: "Jev requested a larger model; no model was spawned.",
					evidence: [],
					findings: [],
				},
			],
			remainingTasks: [{ id: "tests", description: "Find tests for refresh" }],
		}),
	);
	expect(output).toContain("escalated; unresolved tasks need a larger model");
	expect(output).toContain("routes: needs a larger model");
	expect(output).toContain("Not attempted (unresolved):");
	expect(output).toContain("tests: Find tests for refresh");
});

test("raw outcome evidence is a fallback only when no findings exist", () => {
	const withFindings = formatDispatcherResult(
		result({
			findings: [finding({ path: "src/a.ts", line: 3, text: "3|hit" })],
			results: [
				{
					task: { id: "t1", description: "d" },
					status: "TASK_FINISHED",
					summary: "done",
					evidence: ["--- grep x ---\n3|hit"],
					findings: [],
				},
			],
		}),
	);
	const withoutFindings = formatDispatcherResult(
		result({
			results: [
				{
					task: { id: "t1", description: "d" },
					status: "NO_PATH",
					summary: "nothing",
					evidence: ["--- grep x ---\nno matches"],
					findings: [],
				},
			],
		}),
	);
	expect(withFindings).not.toContain("--- grep x ---");
	expect(withoutFindings).toContain(
		"No locations found in the searched scope.",
	);
	expect(withoutFindings).toContain("Retained evidence:");
	expect(withoutFindings).toContain("--- grep x ---");
});

test("oversized output is bounded with explicit omissions and keeps abort notices", () => {
	const pad = "filler ".repeat(200);
	const findings = Array.from({ length: 3 }, (_, index) =>
		finding({
			path: `src/file${index}.ts`,
			line: 1,
			text: Array.from({ length: 2000 }, (_, line) => `${line + 1}|x`).join(
				"\n",
			),
			relevance: 0.5,
		}),
	);
	const warnings = Array.from(
		{ length: 20 },
		(_, index) => `note ${index}: ${pad}`,
	);
	warnings[0] = "aborted: discovery cancelled mid-run";
	const output = formatDispatcherResult(result({ findings, warnings }));
	expect(output.length).toBeLessThanOrEqual(12_000);
	expect(output).toContain("more locations omitted for length");
	expect(output).toContain("more warnings omitted");
	expect(output).toContain("aborted: discovery cancelled mid-run");
});
