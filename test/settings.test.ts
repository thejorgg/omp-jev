import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configCli, editorArgv } from "../src/config-cli.js";
import { loadConfig, loadRules } from "../src/config.js";
import { configPaths } from "../src/paths.js";
import { initializeDocuments, loadOrchestrator, validateSettings } from "../src/settings.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "jev settings "));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const paths = configPaths(join(root, "project"), join(root, "legacy"), join(root, "global configs"));
	await mkdir(join(root, "project"), { recursive: true });
	const put = async (path: string, value: unknown) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
	return { root, paths, put };
}
test("init creates every config with private permissions and never overwrites edits", async () => {
	const { paths, put } = await fixture();
	assert.equal((await initializeDocuments(paths, "global")).length, 3);
	for (const path of Object.values(paths.global)) assert.equal((await stat(path)).mode & 0o777, 0o600);
	await put(paths.global.orchestrator, { models: { strong: "my/model" } });
	assert.deepEqual(await initializeDocuments(paths, "global"), []);
	assert.equal((await loadOrchestrator(paths.orchestrator)).models.strong, "my/model");
	await validateSettings(paths);
});
test("legacy migration excludes project overrides and keeps legacy source untouched", async () => {
	const { paths, put } = await fixture();
	await put(paths.config[0], { client: { timeoutMs: 4200 } });
	await put(paths.project.main, { client: { timeoutMs: 900 } });
	const legacy = await readFile(paths.config[0], "utf8");
	await initializeDocuments(paths, "global");
	assert.equal(JSON.parse(await readFile(paths.global.main, "utf8")).client.timeoutMs, 4200);
	assert.equal((await loadConfig(paths.config)).client.timeoutMs, 900);
	assert.equal(await readFile(paths.config[0], "utf8"), legacy);
});
test("project init produces partial overlays that keep inheriting global changes", async () => {
	const { paths, put } = await fixture();
	await initializeDocuments(paths, "project");
	assert.deepEqual(JSON.parse(await readFile(paths.project.orchestrator, "utf8")), { version: 1 });
	await put(paths.global.orchestrator, { models: { strong: "custom/strong" }, timeoutMs: 800 });
	assert.equal((await loadOrchestrator(paths.orchestrator)).models.strong, "custom/strong");
	await put(paths.project.orchestrator, { models: { reviewer: "custom/reviewer" } });
	assert.equal((await loadOrchestrator(paths.orchestrator)).timeoutMs, 800);
	assert.equal((await loadOrchestrator(paths.orchestrator)).models.reviewer, "custom/reviewer");
});
test("rules migrate by ID and project IDs still override global IDs", async () => {
	const { paths, put } = await fixture();
	const rule = (message: string) => ({ id: "rule", events: ["manual"], question: { type: "noul", instructions: "Relevant?" }, outcomes: [{ when: { min: 0.9 }, action: { type: "message", message } }] });
	await put(paths.rules[0], { version: 1, rules: [rule("legacy")] });
	await put(paths.project.rules, { version: 1, rules: [rule("project")] });
	await initializeDocuments(paths, "global");
	assert.equal((await loadRules([paths.global.rules]))[0].outcomes[0].action.message, "legacy");
	assert.equal((await loadRules(paths.rules))[0].outcomes[0].action.message, "project");
});
test("malformed files are not overwritten and validation reports the file", async () => {
	const { paths } = await fixture();
	await initializeDocuments(paths, "global");
	await writeFile(paths.global.orchestrator, "{broken");
	assert.deepEqual(await initializeDocuments(paths, "global"), []);
	await assert.rejects(() => validateSettings(paths), /orchestrator.json/);
});
test("editor parser supports flags and quoted paths without shell expansion", () => {
	assert.deepEqual(editorArgv('"/my editor" --wait "a b"'), ["/my editor", "--wait", "a b"]);
	assert.deepEqual(editorArgv("nano '$(touch unsafe)'"), ["nano", "$(touch unsafe)"]);
	assert.throws(() => editorArgv('nano "broken'), /Unclosed/);
	assert.throws(() => editorArgv(" "), /empty/);
});
async function cliFixture(script: string) {
	const f = await fixture();
	const oldDir = process.cwd(), oldConfig = process.env.OMP_JEV_CONFIG_DIR, oldLegacy = process.env.OMP_JEV_LEGACY_AGENT_DIR;
	process.chdir(join(f.root, "project"));
	process.env.OMP_JEV_CONFIG_DIR = dirname(f.paths.global.main);
	process.env.OMP_JEV_LEGACY_AGENT_DIR = join(f.root, "legacy");
	cleanup.push(() => {
		process.chdir(oldDir);
		if (oldConfig === undefined) delete process.env.OMP_JEV_CONFIG_DIR; else process.env.OMP_JEV_CONFIG_DIR = oldConfig;
		if (oldLegacy === undefined) delete process.env.OMP_JEV_LEGACY_AGENT_DIR; else process.env.OMP_JEV_LEGACY_AGENT_DIR = oldLegacy;
	});
	const editor = join(f.root, "fake editor.cjs");
	await writeFile(editor, script);
	return { ...f, editor: `${JSON.stringify(process.execPath)} ${JSON.stringify(editor)}` };
}
test("CLI opens all three files with spaces safely and validates the saved edit", async () => {
	const f = await cliFixture('const fs = require("node:fs"); const files = process.argv.slice(2); if (files.length !== 3) process.exit(4); const p = files[2]; const c = JSON.parse(fs.readFileSync(p)); c.timeoutMs = 700; fs.writeFileSync(p, JSON.stringify(c));');
	await configCli(["config", "--editor", f.editor]);
	assert.equal((await loadOrchestrator(f.paths.orchestrator)).timeoutMs, 700);
});
test("invalid external edits preserve a draft and restore the last config", async () => {
	const f = await cliFixture('require("node:fs").writeFileSync(process.argv[2], "{bad");');
	await initializeDocuments(f.paths, "global");
	const before = await readFile(f.paths.global.orchestrator, "utf8");
	await assert.rejects(() => configCli(["config", "orchestrator", "--editor", f.editor]), /restored previous/);
	assert.equal(await readFile(f.paths.global.orchestrator, "utf8"), before);
	const drafts = (await readdir(dirname(f.paths.global.main))).filter(path => path.includes(".invalid-"));
	assert.equal(drafts.length, 1);
	assert.equal(await readFile(join(dirname(f.paths.global.main), drafts[0]), "utf8"), "{bad\n");
});
test("editor failures are reported without pretending the config was applied", async () => {
	const f = await cliFixture("process.exit(7);");
	await assert.rejects(() => configCli(["config", "main", "--editor", f.editor]), /Editor exited 7/);
});
