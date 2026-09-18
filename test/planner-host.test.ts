import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { capturePlanner } from "../src/planner-host.js";

function fixture(empty = false) {
	let current = empty
		? undefined
		: { id: "original", provider: "local", reasoning: true };
	const pi = { getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/fixture",
		models: {
			current: () => current,
			resolve: () => undefined,
		},
		modelRegistry: { resolver: () => "unused-fixture-key" },
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
	return {
		pi,
		ctx,
		replaceCurrent: () => {
			current = { id: "other", provider: "local", reasoning: true };
		},
	};
}

test("a captured invocation does not adopt a later model selection", async () => {
	const h = fixture();
	const plan = capturePlanner(h.pi, h.ctx);
	h.replaceCurrent();
	const result = await plan(
		{ goal: "Inspect the change" },
		AbortSignal.abort(),
	);
	assert.equal(result.model, "local/original");
	assert.equal(h.ctx.models.current()?.id, "other");
});

test("unresolved selectors and absent current models never fall back", () => {
	const h = fixture();
	assert.throws(() => capturePlanner(h.pi, h.ctx, "missing"));
	const empty = fixture(true);
	assert.throws(() => capturePlanner(empty.pi, empty.ctx));
	assert.throws(() => capturePlanner(empty.pi, empty.ctx, "current"));
});
