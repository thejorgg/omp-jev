#!/usr/bin/env bun
import { configCli } from "../src/config-cli.js";

try {
	await configCli(process.argv.slice(2));
} catch (error) {
	console.error(`omp-jev: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
