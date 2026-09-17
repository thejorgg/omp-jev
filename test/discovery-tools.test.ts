import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { DiscoveryAction } from "../src/discovery.js";
import { createDiscoveryTools } from "../src/discovery-tools.js";

// Boundaries under test: workspace confinement (../, URI schemes, escaping
// symlinks), secret exclusion from implicit discovery, gitignore/hidden
// inventory behavior, explicit pagination arithmetic, and abort semantics
// (aborts reject; they never become error text). Glob and LSP need a real
// Settings instance, so their fail-closed path is asserted against a bare
// ExtensionAPI stub instead.

let parent = "";
let workspace = "";
let gitReady = false;

beforeAll(() => {
	parent = fs.mkdtempSync(path.join(os.tmpdir(), "jev-discovery-"));
	workspace = path.join(parent, "ws");
	fs.mkdirSync(workspace);
	fs.writeFileSync(
		path.join(workspace, "code.ts"),
		"export const needle = 1;\n",
	);
	fs.mkdirSync(path.join(workspace, "sub"));
	fs.writeFileSync(
		path.join(workspace, "sub", "deep.ts"),
		"export const needleTwo = 2;\n",
	);
	const pages: string[] = [];
	for (let line = 1; line <= 250; line++) pages.push(`line ${line}`);
	fs.writeFileSync(path.join(workspace, "pages.ts"), `${pages.join("\n")}\n`);
	fs.writeFileSync(path.join(workspace, "secrets.pem"), "PRIVATE KEY MATERIAL");
	fs.writeFileSync(path.join(workspace, ".env"), "TOKEN=x");
	fs.writeFileSync(path.join(workspace, ".gitignore"), "generated/\n");
	fs.mkdirSync(path.join(workspace, "generated"));
	fs.writeFileSync(
		path.join(workspace, "generated", "gen.ts"),
		"export const gen = 3;\n",
	);
	// Symlink inside the workspace pointing at a file outside it.
	fs.writeFileSync(path.join(parent, "outside-secret.txt"), "OUTSIDE CONTENT");
	fs.symlinkSync(
		path.join(parent, "outside-secret.txt"),
		path.join(workspace, "escape-link.ts"),
	);
	try {
		execFileSync("git", ["init", "-q", workspace], { stdio: "ignore" });
		gitReady = true;
	} catch {
		gitReady = false;
	}
});

afterAll(() => {
	fs.rmSync(parent, { recursive: true, force: true });
});

const tools = () =>
	createDiscoveryTools(
		{} as ExtensionAPI,
		{ cwd: workspace } as unknown as ExtensionContext,
	);

test("inventory keeps plain files only: gitignored, hidden, secret, and symlinked entries are excluded", async () => {
	const inventory = await tools().inventory();
	const expected = ["code.ts", "pages.ts", "sub/deep.ts"];
	if (!gitReady) expected.push("generated/gen.ts");
	expect(inventory.truncated).toBe(false);
	expect(inventory.files.sort()).toEqual(expected.sort());
});

test("read pages are numbered, 1-based, and continue via nextOffset", async () => {
	const first = await tools().execute({ tool: "read", path: "pages.ts" });
	expect(first.error).toBeUndefined();
	expect(first.text.startsWith("1|line 1\n")).toBe(true);
	expect(first.nextOffset).toBe(201);
	expect(first.locations[0]).toEqual({ path: "pages.ts", line: 1 });
	const last = await tools().execute({
		tool: "read",
		path: "pages.ts",
		offset: 201,
		limit: 100,
	});
	expect(last.error).toBeUndefined();
	expect(last.text).toContain("250|line 250");
	expect(last.nextOffset).toBeUndefined();
});

test("read refuses content outside the workspace: ../, URI schemes, and escaping symlinks", async () => {
	const dotdot = await tools().execute({
		tool: "read",
		path: "../outside-secret.txt",
	});
	expect(dotdot.error).toContain("escapes the workspace");
	expect(dotdot.text).not.toContain("OUTSIDE CONTENT");
	const uri = await tools().execute({
		tool: "read",
		path: "file:///etc/hostname",
	});
	expect(uri.error).toContain("must be a local workspace path");
	const symlink = await tools().execute({
		tool: "read",
		path: "escape-link.ts",
	});
	expect(symlink.error).toContain("escapes the workspace");
	expect(symlink.text).not.toContain("OUTSIDE CONTENT");
});

test("grep surfaces nested symbols with positive line numbers and never leaks secret or escaping content", async () => {
	const observation = await tools().execute({
		tool: "grep",
		pattern: "needle|OUTSIDE|PRIVATE KEY",
	});
	expect(observation.error).toBeUndefined();
	const body = observation.text.split("\n").slice(1).join("\n");
	expect(body).toContain("needle");
	expect(body).not.toContain("OUTSIDE");
	expect(body).not.toContain("PRIVATE KEY");
	expect(observation.text).not.toContain("secrets.pem");
	expect(observation.text).not.toContain("escape-link.ts");
	for (const location of observation.locations) {
		expect(location.line === undefined || location.line > 0).toBe(true);
	}
});

test("grep pagination skips by absolute file offset across pages without overlap", async () => {
	for (let i = 0; i < 25; i++) {
		fs.writeFileSync(
			path.join(workspace, `pag${String(i).padStart(2, "0")}.ts`),
			`export const pagNeedle${i} = ${i};\n`,
		);
	}
	const instance = tools();
	const page1 = await instance.execute({ tool: "grep", pattern: "pagNeedle" });
	expect(page1.error).toBeUndefined();
	expect(page1.nextSkip).toBe(20);
	const page1Paths = new Set(page1.locations.map((location) => location.path));
	expect(page1Paths.size).toBe(20);
	const page2 = await instance.execute({
		tool: "grep",
		pattern: "pagNeedle",
		skip: page1.nextSkip,
	});
	expect(page2.error).toBeUndefined();
	expect(page2.nextSkip).toBeUndefined();
	for (const location of page2.locations) {
		expect(page1Paths.has(location.path)).toBe(false);
	}
});

test("grep fails closed when a member exists outside the workspace but skips missing members", async () => {
	const escaping = await tools().execute({
		tool: "grep",
		pattern: "needle",
		path: "../outside-secret.txt",
	});
	expect(escaping.error).toContain("escapes the workspace");
	const mixed = await tools().execute({
		tool: "grep",
		pattern: "needleTwo",
		path: "does-not-exist;sub",
	});
	expect(mixed.error).toBeUndefined();
	expect(mixed.text).toContain("needleTwo");
	expect(mixed.text).toContain("Skipped missing paths: does-not-exist");
});

test("ast_grep returns structural matches with line evidence and no excluded files", async () => {
	const observation = await tools().execute({
		tool: "ast_grep",
		pattern: "export const $NAME = $INIT",
		path: ".",
	});
	expect(observation.error).toBeUndefined();
	expect(observation.locations.length).toBeGreaterThanOrEqual(2);
	expect(
		observation.locations.every((location) => (location.line ?? 0) > 0),
	).toBe(true);
	expect(
		observation.locations.every(
			(location) => !location.path.includes("escape-link"),
		),
	).toBe(true);
});

test("aborted operations reject instead of returning error observations", async () => {
	const instance = tools();
	const signal = AbortSignal.abort();
	await expect(
		instance.execute({ tool: "grep", pattern: "needle" }, signal),
	).rejects.toThrow();
	await expect(instance.inventory(signal)).rejects.toThrow();
	await expect(
		instance.execute({ tool: "read", path: "code.ts" }, signal),
	).rejects.toThrow();
});

test("glob fails closed when the extension runtime supplies no BUILTIN_TOOLS/Settings", async () => {
	const observation = await tools().execute({ tool: "glob", path: "**/*.ts" });
	expect(observation.error).toContain("unavailable");
});

test("long source lines are reported as incomplete evidence", async () => {
	fs.writeFileSync(
		path.join(workspace, "long-line.ts"),
		`${"x".repeat(8192)}HIDDEN_TAIL\n`,
	);
	const result = await tools().execute({ tool: "read", path: "long-line.ts" });
	expect(result.truncated).toBe(true);
	expect(result.text).not.toContain("HIDDEN_TAIL");
});

test("read preserves compact JSON values beyond search-snippet width", async () => {
	const json = JSON.stringify({
		description: "x".repeat(1000),
		refreshEndpoint: "/session/refresh",
	});
	fs.writeFileSync(path.join(workspace, "compact.json"), json);
	const result = await tools().execute({ tool: "read", path: "compact.json" });
	expect(result.truncated).toBe(false);
	expect(
		JSON.parse(result.text.slice(result.text.indexOf("|") + 1)).refreshEndpoint,
	).toBe("/session/refresh");
});

test("AST results expose a cap even when exactly one match is omitted", async () => {
	fs.writeFileSync(
		path.join(workspace, "ast-cap.ts"),
		Array.from({ length: 101 }, (_, i) => `export const cap${i} = ${i};`).join(
			"\n",
		),
	);
	const result = await tools().execute({
		tool: "ast_grep",
		pattern: "export const $NAME = $VALUE",
		path: "ast-cap.ts",
		lang: "typescript",
	});
	expect(result.locations).toHaveLength(100);
	expect(result.truncated).toBe(true);
});
