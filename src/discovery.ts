import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Only local, read-only operations can be proposed to Jev. */
export type DiscoveryAction =
	| { tool: "read"; path: string; offset?: number; limit?: number }
	| { tool: "glob"; path: string }
	| { tool: "grep"; pattern: string; path?: string; skip?: number }
	| { tool: "ast_grep"; pattern: string; path: string; lang?: string }
	| {
			tool: "lsp";
			action:
				| "symbols"
				| "definition"
				| "references"
				| "implementation"
				| "type_definition"
				| "hover";
			file?: string;
			line?: number;
			symbol?: string;
			query?: string;
	  };

export interface DiscoveryLocation {
	path: string;
	line?: number;
	symbol?: string;
	text?: string;
}

export interface DiscoveryObservation {
	text: string;
	locations: DiscoveryLocation[];
	truncated?: boolean;
	/** For file-page searches. Undefined means no further page is available. */
	nextSkip?: number;
	/** For bounded reads. */
	nextOffset?: number;
	error?: string;
}

export interface DiscoveryInventory {
	files: string[];
	truncated: boolean;
}

export interface DiscoveryTools {
	inventory(signal?: AbortSignal): Promise<DiscoveryInventory>;
	execute(
		action: DiscoveryAction,
		signal?: AbortSignal,
	): Promise<DiscoveryObservation>;
}

export type DiscoveryToolsFactory = (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
) => DiscoveryTools;

export interface DiscoveryFinding extends DiscoveryLocation {
	via: DiscoveryAction["tool"];
	/** Jev's semantic relevance probability; absent on unranked partial evidence. */
	relevance?: number;
}

export interface DiscoveryProgress {
	phase: "indexing" | "selecting" | "searching" | "finished";
	task: string;
	taskIndex: number;
	totalTasks: number;
	toolCalls: number;
	decisions: number;
	files: number;
	elapsedMs: number;
	actions: string[];
}
