import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createDiscoveryTools } from "../src/discovery-tools.js";

// Boundaries under test: workspace confinement (../, URI schemes, escaping
// symlinks), implicit secret exclusion, opt-in explicit sensitive-path
// exclusion, gitignore/hidden inventory behavior, explicit pagination
// arithmetic, and abort semantics (aborts reject; they never become error
// text). Glob and LSP need a real Settings instance, so their fail-closed path
// is asserted against a bare ExtensionAPI stub instead.

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
	fs.writeFileSync(path.join(workspace, ".projectrc"), "SAFE_CONFIG=true");
	fs.symlinkSync(
		path.join(workspace, "secrets.pem"),
		path.join(workspace, "secret-alias.ts"),
	);
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

const tools = (options?: Parameters<typeof createDiscoveryTools>[2]) =>
	createDiscoveryTools(
		{} as ExtensionAPI,
		{
			cwd: workspace,
			sessionManager: { getSessionFile: () => undefined },
		},
		options,
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
	const firstLocation = first.locations[0];
	if (!firstLocation) throw new Error("read returned no location");
	expect(firstLocation.path).toBe("pages.ts");
	expect(firstLocation.line).toBe(1);
	expect(firstLocation.endLine).toBe(200);
	expect(firstLocation.text?.startsWith("1|line 1\n")).toBe(true);
	const last = await tools().execute({
		tool: "read",
		path: "pages.ts",
		offset: 201,
		limit: 100,
	});
	expect(last.error).toBeUndefined();
	expect(last.text).toContain("250|line 250");
	expect(last.nextOffset).toBeUndefined();
	expect(last.locations[0]?.endLine).toBe(250);
});

test("sensitive-file policy blocks protected reads and symlink aliases without blocking source or safe hidden config", async () => {
	const guarded = tools({ excludeSensitiveFiles: true });
	const literalSecret = await guarded.execute({
		tool: "read",
		path: "secrets.pem",
	});
	expect(literalSecret.error).toContain("sensitive-file policy");
	expect(literalSecret.text).not.toContain("PRIVATE KEY MATERIAL");
	expect(literalSecret.locations).toEqual([]);

	const dotenv = await guarded.execute({ tool: "read", path: ".env" });
	expect(dotenv.error).toContain("sensitive-file policy");
	expect(dotenv.text).not.toContain("TOKEN=x");
	expect(dotenv.locations).toEqual([]);

	const alias = await guarded.execute({
		tool: "read",
		path: "secret-alias.ts",
	});
	expect(alias.error).toContain("sensitive-file policy");
	expect(alias.text).not.toContain("PRIVATE KEY MATERIAL");
	expect(alias.locations).toEqual([]);

	const source = await guarded.execute({ tool: "read", path: "code.ts" });
	expect(source.error).toBeUndefined();
	expect(source.text).toContain("export const needle = 1;");
	expect(source.locations[0]?.path).toBe("code.ts");
	const hiddenConfig = await guarded.execute({
		tool: "read",
		path: ".projectrc",
	});
	expect(hiddenConfig.error).toBeUndefined();
	expect(hiddenConfig.text).toContain("SAFE_CONFIG=true");
	expect(hiddenConfig.locations[0]?.path).toBe(".projectrc");
});

test("sensitive-file policy is opt-in for explicit dispatcher reads", async () => {
	const result = await tools().execute({ tool: "read", path: "secrets.pem" });
	expect(result.error).toBeUndefined();
	expect(result.text).toContain("PRIVATE KEY MATERIAL");
	expect(result.locations[0]?.path).toBe("secrets.pem");
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

// -------------------------------------------------------------------------
// ranked grep (query actions) and honest read pagination
// -------------------------------------------------------------------------

test("ranked grep ranks source before docs but keeps markdown discoverable; doc requests invert", async () => {
	fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
	fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(workspace, "src", "zorb.ts"),
		"export function zorbHandler(input) {\n  return zorbTransform(input);\n}\n",
	);
	fs.writeFileSync(
		path.join(workspace, "docs", "zorb.md"),
		"# zorbHandler notes\n\nzorbTransform converts raw input.\n",
	);
	const instance = tools();
	const sourceFirst = await instance.execute({
		tool: "grep",
		pattern: "zorb",
		query: "zorbHandler zorbTransform",
	});
	expect(sourceFirst.error).toBeUndefined();
	expect(
		sourceFirst.text.startsWith('grep "zorbHandler zorbTransform" ranked'),
	).toBe(true);
	expect(sourceFirst.locations[0]?.path).toBe("src/zorb.ts");
	// Markdown stays discoverable; it is only ranked below source.
	expect(sourceFirst.text).toContain("docs/zorb.md");
	const docFirst = await instance.execute({
		tool: "grep",
		pattern: "zorb",
		query: "zorbHandler documentation",
	});
	expect(docFirst.error).toBeUndefined();
	expect(docFirst.locations[0]?.path).toBe("docs/zorb.md");
	expect(docFirst.text).toContain("src/zorb.ts");
});

test("ranked grep surfaces a discriminative match late in a noisy file", async () => {
	const noise = Array.from(
		{ length: 40 },
		(_, i) => `widget padding row ${i} widget widget`,
	);
	fs.writeFileSync(
		path.join(workspace, "noisy.ts"),
		`${noise.join("\n")}\nconst tuned = applyWidget(widgetKernel);\n`,
	);
	const observation = await tools().execute({
		tool: "grep",
		pattern: "widget",
		query: "widget widgetKernel",
	});
	expect(observation.error).toBeUndefined();
	// Per-term scans give the rare term its own per-file sample, so the late
	// line is never crowded out by the common term's eight-match budget.
	const late = observation.locations.find(
		(location) => location.path === "noisy.ts" && location.line === 41,
	);
	expect(late).toBeDefined();
	expect(observation.text).toContain(
		"41|const tuned = applyWidget(widgetKernel);",
	);
	const noisySnippets = observation.locations.filter(
		(location) => location.path === "noisy.ts",
	);
	expect(noisySnippets.length).toBeGreaterThan(0);
	expect(noisySnippets.length).toBeLessThanOrEqual(6);
});

test("read pagination via nextOffset covers every line exactly once", async () => {
	const rows = Array.from({ length: 950 }, (_, i) => `row ${i + 1}`);
	fs.writeFileSync(
		path.join(workspace, "deep-read.ts"),
		`${rows.join("\n")}\n`,
	);
	const instance = tools();
	const seen = new Set<number>();
	let observation = await instance.execute({
		tool: "read",
		path: "deep-read.ts",
		limit: 1000,
	});
	let guard = 0;
	while (guard++ < 10) {
		expect(observation.error).toBeUndefined();
		const numbered = observation.text
			.split("\n")
			.filter((row) => /^\d+\|/.test(row));
		expect(numbered.length).toBeGreaterThan(0);
		expect(numbered.length).toBeLessThanOrEqual(400);
		for (const row of numbered)
			seen.add(Number(row.slice(0, row.indexOf("|"))));
		const location = observation.locations[0];
		if (!location) throw new Error("read page returned no location");
		const firstLine = Number(numbered[0].slice(0, numbered[0].indexOf("|")));
		const lastRow = numbered[numbered.length - 1];
		const lastLine = Number(lastRow.slice(0, lastRow.indexOf("|")));
		expect(location.line).toBe(firstLine);
		expect(location.endLine).toBe(lastLine);
		if (observation.nextOffset === undefined) break;
		// nextOffset is the first unread line; no page ever skips content.
		expect(observation.nextOffset).toBe(lastLine + 1);
		observation = await instance.execute({
			tool: "read",
			path: "deep-read.ts",
			offset: observation.nextOffset,
			limit: 1000,
		});
	}
	expect(seen.size).toBe(950);
	expect(Math.min(...seen)).toBe(1);
	expect(Math.max(...seen)).toBe(950);
	expect(observation.text).toContain("950|row 950");
	expect(observation.nextOffset).toBeUndefined();
});

test("ranked grep applies directory priorities as soft factors within the same scopes", async () => {
	fs.mkdirSync(path.join(workspace, "pri"), { recursive: true });
	fs.writeFileSync(
		path.join(workspace, "pri", "alpha.ts"),
		"export const quixote = 1;\n",
	);
	fs.writeFileSync(
		path.join(workspace, "beta.ts"),
		"export const quixote = 2;\n",
	);
	const instance = tools();
	const order = async (priorities?: Record<string, number>) => {
		const observation = await instance.execute({
			tool: "grep",
			pattern: "quixote",
			query: "quixote",
			priorities,
		});
		expect(observation.error).toBeUndefined();
		return observation.locations.map((location) => location.path);
	};
	expect((await order({ pri: 10 }))[0]).toBe("pri/alpha.ts");
	expect((await order({ ".": 10 }))[0]).toBe("beta.ts");
	// The 0.1 floor: a zero priority softens but never removes a directory.
	expect((await order({ ".": 0 }))[0]).toBe("pri/alpha.ts");
	expect((await order()).length).toBe(2);
});

test("ranked grep keeps plain-grep workspace boundaries and never leaks secrets", async () => {
	const instance = tools();
	const escaping = await instance.execute({
		tool: "grep",
		pattern: "quixote",
		query: "quixote source",
		path: "../outside-secret.txt",
	});
	expect(escaping.error).toContain("escapes the workspace");
	expect(escaping.text).not.toContain("OUTSIDE CONTENT");
	const mixed = await instance.execute({
		tool: "grep",
		pattern: "quixote",
		query: "quixote",
		path: "does-not-exist;pri",
	});
	expect(mixed.error).toBeUndefined();
	expect(mixed.text).toContain("Skipped missing paths: does-not-exist");
	expect(mixed.text).toContain("pri/alpha.ts");
	const secretHunt = await instance.execute({
		tool: "grep",
		pattern: "quixote",
		query: "PRIVATE KEY quixote material",
	});
	expect(secretHunt.error).toBeUndefined();
	expect(secretHunt.text).not.toContain("secrets.pem");
	expect(secretHunt.text).not.toContain("PRIVATE KEY MATERIAL");
	// Dropped secret files keep the page honestly partial.
	expect(secretHunt.truncated).toBe(true);
});

test("ranked grep honors the dispatcher page-size hint with validated bounds", async () => {
	const instance = tools();
	const page = await instance.execute({
		tool: "grep",
		pattern: "quixote",
		query: "quixote",
		limit: 1,
	});
	expect(page.error).toBeUndefined();
	expect(page.locations.map((location) => location.path)).toHaveLength(1);
	expect(page.nextSkip).toBeDefined();
	const tail = await instance.execute({
		tool: "grep",
		pattern: "quixote",
		query: "quixote",
		limit: 16,
		skip: page.nextSkip,
	});
	expect(tail.error).toBeUndefined();
	expect(tail.nextSkip).toBeUndefined();
	const names = tail.locations.map((location) => location.path);
	expect(names).not.toContain(page.locations[0]?.path);
});
