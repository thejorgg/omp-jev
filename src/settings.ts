import { loadConfig, loadRules, parseConfig } from "./config.js";
import { readOptional, saveDocument } from "./editor.js";
import { DEFAULT_ORCHESTRATOR, parseOrchestrator, type OrchestratorConfig } from "./orchestration.js";
import { configPaths, type ConfigName, type ConfigScope } from "./paths.js";
import { parseRules } from "./rules.js";

export async function loadOrchestrator(paths: string[]): Promise<OrchestratorConfig> {
	let config = structuredClone(DEFAULT_ORCHESTRATOR);
	for (const path of paths) {
		const text = await readOptional(path);
		if (text === undefined) continue;
		try { config = parseOrchestrator(JSON.parse(text), config); }
		catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return config;
}

export function documentValidator(name: ConfigName): (value: unknown) => unknown {
	if (name === "main") return parseConfig;
	if (name === "rules") return parseRules;
	return parseOrchestrator;
}

export async function initialDocument(name: ConfigName, paths: ReturnType<typeof configPaths>, scope: ConfigScope): Promise<unknown> {
	// Project files must be overlays, not a snapshot shadowing every global setting.
	if (scope === "project") return name === "rules" ? { version: 1, rules: [] } : { version: 1 };
	if (name === "main") return loadConfig(paths.config.slice(0, -1));
	if (name === "rules") return { version: 1, rules: await loadRules(paths.rules.slice(0, -1)) };
	return structuredClone(DEFAULT_ORCHESTRATOR);
}

/** Materialize every setting for easy external editing. Never replace an existing file. */
export async function initializeDocuments(paths: ReturnType<typeof configPaths>, scope: ConfigScope, names: ConfigName[] = ["main", "rules", "orchestrator"]): Promise<string[]> {
	const created: string[] = [];
	for (const name of names) {
		const path = paths[scope][name];
		if (await readOptional(path) !== undefined) continue;
		const initial = await initialDocument(name, paths, scope);
		await saveDocument(path, JSON.stringify(initial, null, 2), undefined);
		created.push(path);
	}
	return created;
}

export async function validateSettings(paths: ReturnType<typeof configPaths>): Promise<void> {
	await Promise.all([loadConfig(paths.config), loadRules(paths.rules), loadOrchestrator(paths.orchestrator)]);
}
