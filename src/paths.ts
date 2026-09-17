import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type ConfigName = "main" | "rules" | "orchestrator";
export type ConfigScope = "global" | "project";

/** Relative XDG_CONFIG_HOME values are ignored, as required by the XDG spec. */
export function configHome(env = process.env, home = homedir()): string {
	const override = env.OMP_JEV_CONFIG_DIR;
	if (override) {
		if (!isAbsolute(override)) throw new Error("OMP_JEV_CONFIG_DIR must be absolute");
		return override;
	}
	const xdg = env.XDG_CONFIG_HOME;
	return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "omp-jev");
}

export function configPaths(cwd: string, legacyAgentDir: string, globalDir = configHome()) {
	const global = {
		main: join(globalDir, "config.json"),
		rules: join(globalDir, "rules.json"),
		orchestrator: join(globalDir, "orchestrator.json"),
	};
	const project = {
		main: join(cwd, ".omp", "jev.json"),
		rules: join(cwd, ".jevrules"),
		orchestrator: join(cwd, ".omp", "jev-orchestrator.json"),
	};
	return {
		global, project,
		// Keep old installations working; canonical XDG files override legacy globals.
		config: [join(legacyAgentDir, "jev.json"), global.main, project.main],
		rules: [join(legacyAgentDir, ".jevrules"), global.rules, project.rules],
		orchestrator: [global.orchestrator, project.orchestrator],
	};
}
