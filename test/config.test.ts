import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	loadConfig,
	loadRules,
	parseConfig,
} from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "omp-jev-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function patch(path: string, value: unknown): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	let node = root;
	const keys = path.split(".");
	for (const [i, key] of keys.entries()) {
		if (i === keys.length - 1) {
			node[key] = value;
		} else {
			const next: Record<string, unknown> = {};
			node[key] = next;
			node = next;
		}
	}
	return root;
}

describe("parseConfig", () => {
	test("deep merges partial input without disturbing sibling defaults", () => {
		const config = parseConfig({
			client: { timeoutMs: 9000 },
			context: { maxChars: 2048 },
			recovery: { enabled: false },
		});
		expect(config.client).toEqual({
			...DEFAULT_CONFIG.client,
			timeoutMs: 9000,
		});
		expect(config.context).toEqual({
			...DEFAULT_CONFIG.context,
			maxChars: 2048,
		});
		expect(config.recovery.enabled).toBe(false);
		expect(config.recovery.maxContinuations).toBe(
			DEFAULT_CONFIG.recovery.maxContinuations,
		);
		expect(config.safety).toEqual(DEFAULT_CONFIG.safety);
		expect(config.nativeRules).toEqual(DEFAULT_CONFIG.nativeRules);
	});

	test("rejects unknown fields and malformed sections", () => {
		expect(() => parseConfig({ context: { maxCharz: 48000 } })).toThrow();
		expect(() => parseConfig({ rateLimit: 5 })).toThrow();
		expect(() => parseConfig({ context: 5 })).toThrow();
		expect(() => parseConfig(null)).toThrow();
		expect(() =>
			parseConfig(JSON.parse('{"__proto__": {"enabled": false}}')),
		).toThrow();
	});

	test("enforces strict integer bounds", () => {
		const expectBounds = (path: string, min: number, max: number) => {
			expect(parseConfig(patch(path, min))).toMatchObject(patch(path, min));
			expect(parseConfig(patch(path, max))).toMatchObject(patch(path, max));
			expect(() => parseConfig(patch(path, min - 1))).toThrow();
			expect(() => parseConfig(patch(path, max + 1))).toThrow();
		};
		expectBounds("context.maxChars", 1024, 1_000_000);
		expectBounds("context.recentMessages", 0, 100);
		expectBounds("client.timeoutMs", 100, 120_000);
		expectBounds("recovery.maxContinuations", 0, 3);
	});

	test("rejects non-finite numbers and out-of-range thresholds", () => {
		expect(() => parseConfig(patch("context.maxChars", Number.NaN))).toThrow();
		expect(() =>
			parseConfig(patch("client.timeoutMs", Number.POSITIVE_INFINITY)),
		).toThrow();
		expect(() => parseConfig(patch("thinking.minConfidence", 1.5))).toThrow();
		expect(() => parseConfig(patch("thinking.minConfidence", -0.1))).toThrow();
		expect(
			parseConfig(patch("thinking.minConfidence", 1)).thinking.minConfidence,
		).toBe(1);
		expect(
			parseConfig(patch("safety.minProbability", 0)).safety.minProbability,
		).toBe(0);
	});

	test("rejects config versions other than 1", () => {
		expect(() => parseConfig({ version: 2 })).toThrow();
	});
});

describe("loadConfig", () => {
	test("skips missing files and yields defaults", async () => {
		expect(await loadConfig(join(dir, "absent.json"))).toEqual(DEFAULT_CONFIG);
		expect(await loadConfig([join(dir, "absent.json")])).toEqual(
			DEFAULT_CONFIG,
		);
	});

	test("rejects malformed JSON instead of silently ignoring it", async () => {
		const broken = join(dir, "broken.json");
		writeFileSync(broken, "{ definitely not json");
		await expect(loadConfig(broken)).rejects.toThrow();
		const notAnObject = join(dir, "array.json");
		writeFileSync(notAnObject, "[]");
		await expect(loadConfig(notAnObject)).rejects.toThrow();
	});

	test("rejects prototype keys before they can evade validation", async () => {
		const protoFile = join(dir, "proto.json");
		writeFileSync(protoFile, '{"__proto__": {"enabled": false}}');
		await expect(loadConfig(protoFile)).rejects.toThrow();
	});

	test("merges overlays in order; defaults fill only remaining gaps", async () => {
		const globalFile = join(dir, "jev-global.json");
		const projectFile = join(dir, "jev-project.json");
		writeFileSync(
			globalFile,
			JSON.stringify({
				version: 1,
				client: { timeoutMs: 100, model: "global-model" },
				context: { maxChars: 2048 },
			}),
		);
		writeFileSync(
			projectFile,
			JSON.stringify({
				client: { model: "project-model" },
				recovery: { maxContinuations: 3 },
			}),
		);
		const config = await loadConfig([globalFile, projectFile]);
		expect(config.client).toEqual({
			...DEFAULT_CONFIG.client,
			timeoutMs: 100,
			model: "project-model",
		});
		expect(config.context.maxChars).toBe(2048);
		expect(config.recovery.maxContinuations).toBe(3);
		expect(config.safety).toEqual(DEFAULT_CONFIG.safety);
	});
});

describe("loadRules", () => {
	const ruleDoc = (rules: unknown[]) => JSON.stringify({ version: 1, rules });
	const rule = (id: string, message: string) => ({
		id,
		events: ["before_agent_start"],
		question: { type: "noul", instructions: "i" },
		outcomes: [{ when: { min: 0.5 }, action: { type: "message", message } }],
	});

	test("skips missing files, throws on malformed ones", async () => {
		const good = join(dir, "good-rules.json");
		writeFileSync(good, ruleDoc([rule("g1", "hello")]));
		const rules = await loadRules([join(dir, "absent.json"), good]);
		expect(rules.map((loaded) => loaded.id)).toEqual(["g1"]);
		const bad = join(dir, "bad-rules.json");
		writeFileSync(bad, '{"version":1,"rules":[');
		await expect(loadRules([bad])).rejects.toThrow();
	});

	test("later files replace rules by id (global -> project)", async () => {
		const globalFile = join(dir, "global-rules.json");
		const projectFile = join(dir, "project-rules.json");
		writeFileSync(
			globalFile,
			ruleDoc([rule("shared", "global"), rule("only-global", "g")]),
		);
		writeFileSync(
			projectFile,
			ruleDoc([rule("shared", "project"), rule("only-project", "p")]),
		);
		const rules = await loadRules([globalFile, projectFile]);
		expect(rules.map((loaded) => loaded.id)).toEqual([
			"shared",
			"only-global",
			"only-project",
		]);
		const shared = rules.find((loaded) => loaded.id === "shared");
		expect(shared && shared.outcomes[0].action.message).toBe("project");
	});

	test("rejects duplicate ids within one file", async () => {
		const dup = join(dir, "dup-rules.json");
		writeFileSync(dup, ruleDoc([rule("same", "a"), rule("same", "b")]));
		await expect(loadRules([dup])).rejects.toThrow();
	});
});
