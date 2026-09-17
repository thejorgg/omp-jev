import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readOptional, saveDocument } from "./editor.js";
import { configPaths, type ConfigName, type ConfigScope } from "./paths.js";
import {
	documentValidator,
	initializeDocuments,
	validateSettings,
} from "./settings.js";

/** Parse editor argv only. No shell, expansion, interpolation, or evaluation. */
export function editorArgv(command: string): string[] {
	const words: string[] = [];
	let word = "",
		quote = "",
		escaped = false,
		started = false;
	for (const char of command) {
		if (escaped) {
			word += char;
			escaped = false;
			started = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = "";
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) {
				words.push(word);
				word = "";
				started = false;
			}
		} else {
			word += char;
			started = true;
		}
	}
	if (quote || escaped)
		throw new Error("Unclosed quote or trailing escape in editor command");
	if (started) words.push(word);
	if (!words.length || !words[0]) throw new Error("Editor command is empty");
	return words;
}

export async function configCli(args: string[]): Promise<void> {
	let scope: ConfigScope = "global";
	let editor: string | undefined;
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--project") scope = "project";
		else if (arg === "--editor") {
			editor = args[++i];
			if (!editor)
				throw new Error("--editor requires a command, e.g. --editor nano");
		} else if (arg.startsWith("--") && arg !== "--help")
			throw new Error(`Unknown option: ${arg}`);
		else positional.push(arg);
	}
	const [command = "config", target = "all", ...extra] = positional;
	if (["--help", "help"].includes(command)) {
		console.log(
			"omp-jev config [all|main|rules|orchestrator] [--project] [--editor nano]\nomp-jev init [--project]\nomp-jev paths [--project]\nomp-jev check\nEditor: --editor, then VISUAL, then EDITOR, then nano. Changes require /jev reload in an already-running OMP session.",
		);
		return;
	}
	if (extra.length || !["config", "init", "paths", "check"].includes(command))
		throw new Error("Usage: omp-jev config|init|paths|check (see --help)");
	if (!["all", "main", "rules", "orchestrator"].includes(target))
		throw new Error(`Unknown config: ${target}`);
	// OMP's normal global agent directory; callers using a custom host directory can override it.
	const paths = configPaths(
		process.cwd(),
		process.env.OMP_JEV_LEGACY_AGENT_DIR || join(homedir(), ".omp", "agent"),
	);
	const names: ConfigName[] =
		target === "all"
			? ["main", "rules", "orchestrator"]
			: [target as ConfigName];
	if (command === "paths") {
		for (const name of names) console.log(`${name}: ${paths[scope][name]}`);
		return;
	}
	if (command === "check") {
		await validateSettings(paths);
		console.log(
			"Jev configuration, rules and orchestrator settings are valid.",
		);
		return;
	}
	const created = await initializeDocuments(paths, scope, names);
	for (const path of created) console.log(`Created ${path}`);
	if (command === "init") return;
	const files = names.map((name) => paths[scope][name]);
	const before = await Promise.all(files.map(readOptional));
	const [executable, ...flags] = editorArgv(
		editor || process.env.VISUAL || process.env.EDITOR || "nano",
	);
	const result = spawnSync(executable, [...flags, ...files], {
		stdio: "inherit",
		shell: false,
	});
	if (result.error)
		throw new Error(
			`Cannot launch ${executable}: ${result.error.message}. Use --editor nano or set EDITOR.`,
		);
	if (result.status !== 0)
		throw new Error(
			`Editor exited ${result.status ?? result.signal}; edits were left on disk. Run omp-jev check before /jev reload.`,
		);
	const after = await Promise.all(files.map(readOptional));
	try {
		for (let i = 0; i < names.length; i++) {
			if (after[i] === undefined) throw new Error(`${files[i]} was removed`);
			documentValidator(names[i])(JSON.parse(after[i]!));
		}
		await validateSettings(paths);
	} catch (error) {
		// Preserve invalid drafts and restore only files unchanged since our post-editor read.
		// Optimistic checks refuse to clobber concurrent edits; never rewrite an unrelated file.
		for (let i = 0; i < files.length; i++) {
			if (before[i] === after[i]) continue;
			if (after[i] !== undefined) {
				const draft = `${files[i]}.invalid-${Date.now()}-${i}`;
				await saveDocument(draft, after[i]!, undefined);
				console.error(`Saved invalid draft: ${draft}`);
			}
			if (before[i] !== undefined)
				await saveDocument(files[i], before[i]!, after[i]);
		}
		throw new Error(
			`Configuration not applied; restored previous documents. ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	console.log(
		"Saved and validated. In an existing OMP session, run /jev reload.",
	);
}
