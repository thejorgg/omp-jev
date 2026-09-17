import type { Theme } from "@oh-my-pi/pi-coding-agent";
import {
	Box,
	Container,
	Spacer,
	Text,
	TruncatedText,
	type Component,
} from "@oh-my-pi/pi-tui";
import type { DiscoveryFinding, DiscoveryProgress } from "./discovery.js";
import type { DispatcherResult } from "./dispatcher.js";

const COLLAPSED_LOCATIONS = 8;
const COLLAPSED_WARNINGS = 2;
const LABEL_CHARACTERS = 320;
const PREVIEW_CHARACTERS = 160;
const EVIDENCE_CHARACTERS = 3200;
const COLLAPSED_ROWS = 72;
const EXPANDED_ROWS = 400;
const PROGRESS_ROWS = 6;

/** Escape untrusted terminal controls before applying any trusted theme styling. */
function displayText(value: unknown, limit: number, multiline = false): string {
	if (typeof value !== "string") return "";
	let end = Math.min(value.length, limit);
	// Do not split a UTF-16 surrogate pair at the input-size bound.
	if (end < value.length && /[\ud800-\udbff]/.test(value[end - 1] ?? "")) end--;
	const text = value
		.slice(0, end)
		.replace(
			/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
			(character) => {
				if (multiline && character === "\n") return "\n";
				if (multiline && character === "\t") return "   ";
				return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
			},
		);
	return end < value.length ? `${text} [shortened]` : text;
}

function count(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function quantity(value: number, singular: string): string {
	const total = count(value);
	return `${total} ${singular}${total === 1 ? "" : "s"}`;
}

function elapsed(value: number): string {
	const milliseconds = count(value);
	if (milliseconds < 1000) return `${milliseconds} ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
	return `${Math.floor(milliseconds / 60_000)} min ${Math.floor((milliseconds % 60_000) / 1000)} s`;
}

function text(
	value: string,
	theme: Theme,
	color: Parameters<Theme["fg"]>[0] = "toolOutput",
	bold = false,
): Text {
	return new Text(value, 0, 0).setStyleFn((content) =>
		theme.fg(color, bold ? theme.bold(content) : content),
	);
}

/** Native children do the wrapping; the frame only bounds how many rows it emits. */
class BoundedContainer extends Container {
	#cached?: readonly string[];
	#sources: Array<readonly string[]> = [];
	#width = -1;

	constructor(
		private readonly maxRows: number,
		private readonly theme: Theme,
	) {
		super();
	}

	override invalidate(): void {
		super.invalidate();
		this.#cached = undefined;
	}

	override render(width: number): readonly string[] {
		const sources: Array<readonly string[]> = [];
		let rows = 0;
		let shortened = false;
		for (const child of this.children) {
			const lines = child.render(width);
			sources.push(lines);
			rows += lines.length;
			if (rows > this.maxRows) {
				shortened = true;
				break;
			}
		}
		if (
			this.#cached &&
			this.#width === width &&
			this.#sources.length === sources.length &&
			sources.every((lines, index) => lines === this.#sources[index])
		) {
			return this.#cached;
		}
		const result: string[] = [];
		const contentRows = shortened ? this.maxRows - 1 : this.maxRows;
		for (const lines of sources) {
			for (const line of lines) {
				if (result.length === contentRows) break;
				result.push(line);
			}
			if (result.length === contentRows) break;
		}
		if (shortened) {
			const notice = new TruncatedText(
				this.theme.fg(
					"muted",
					"Display limit reached; some content is hidden.",
				),
				0,
				0,
			);
			result.push(...notice.render(width));
		}
		this.#width = width;
		this.#sources = sources;
		this.#cached = result;
		return result;
	}
}

function findingRank(finding: DiscoveryFinding): number {
	return (
		(finding.relevance ?? 0.5) * 100 +
		(count(finding.line ?? 0) > 0 ? 4 : 0) +
		(finding.symbol ? 2 : 0) +
		(finding.text ? 1 : 0)
	);
}

function rankedFindings(findings: DiscoveryFinding[]): DiscoveryFinding[] {
	const unique = new Map<string, DiscoveryFinding>();
	for (const finding of findings) {
		const key = JSON.stringify([finding.path, finding.line, finding.symbol]);
		const previous = unique.get(key);
		if (!previous || findingRank(finding) > findingRank(previous)) {
			unique.set(key, finding);
		}
	}
	// Stable ties retain the engine's discovery order; anchored evidence comes first.
	return [...unique.values()].sort(
		(left, right) => findingRank(right) - findingRank(left),
	);
}

function addFindings(
	container: Container,
	findings: DiscoveryFinding[],
	expanded: boolean,
	theme: Theme,
): void {
	const visible = expanded ? findings : findings.slice(0, COLLAPSED_LOCATIONS);
	const more = findings.length - visible.length;
	if (more > 0) {
		container.addChild(
			text(
				`${quantity(more, "more location")} available when expanded.`,
				theme,
				"muted",
			),
		);
	}
	const groups = new Map<string, DiscoveryFinding[]>();
	for (const finding of visible) {
		const group = groups.get(finding.path);
		if (group) group.push(finding);
		else groups.set(finding.path, [finding]);
	}
	for (const [path, group] of groups) {
		container.addChild(new Spacer(1));
		for (let index = 0; index < group.length; index++) {
			const finding = group[index]!;
			const line = count(finding.line ?? 0);
			const location = `${displayText(path, LABEL_CHARACTERS)}${line > 0 ? `:${line}` : ""}`;
			const symbol = displayText(finding.symbol, LABEL_CHARACTERS);
			container.addChild(
				text(
					`${location}${symbol ? `  ${symbol}` : ""}`,
					theme,
					"accent",
					index === 0,
				),
			);
			const snippet = displayText(
				finding.text,
				expanded ? EVIDENCE_CHARACTERS : PREVIEW_CHARACTERS,
				expanded,
			);
			if (snippet)
				container.addChild(
					text(snippet, theme, expanded ? "toolOutput" : "muted"),
				);
			if (expanded) {
				container.addChild(
					text(
						`Source: ${displayText(finding.via, LABEL_CHARACTERS)}`,
						theme,
						"dim",
					),
				);
			}
		}
	}
}

function addOutcomes(
	container: Container,
	result: DispatcherResult,
	theme: Theme,
): void {
	for (const outcome of result.results) {
		container.addChild(new Spacer(1));
		const status =
			outcome.status === "TASK_FINISHED"
				? "Resolved"
				: outcome.status === "NO_PATH"
					? "No path in searched scope"
					: "Needs a larger model";
		container.addChild(
			text(
				`${displayText(outcome.task.id, LABEL_CHARACTERS)}: ${status}`,
				theme,
				outcome.status === "REQUIRE_BIGGER_MODEL" ? "warning" : "toolTitle",
				true,
			),
		);
		container.addChild(
			text(
				displayText(outcome.task.description, LABEL_CHARACTERS),
				theme,
				"muted",
			),
		);
		if (outcome.summary) {
			container.addChild(
				text(displayText(outcome.summary, EVIDENCE_CHARACTERS, true), theme),
			);
		}
		for (const evidence of outcome.evidence ?? []) {
			container.addChild(text("Evidence:", theme, "dim"));
			container.addChild(
				text(displayText(evidence, EVIDENCE_CHARACTERS, true), theme),
			);
		}
	}
	if (result.remainingTasks.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(text("Remaining tasks", theme, "warning", true));
		for (const task of result.remainingTasks) {
			container.addChild(
				text(
					`${displayText(task.id, LABEL_CHARACTERS)}: ${displayText(task.description, LABEL_CHARACTERS)}`,
					theme,
				),
			);
		}
	}
}

function fallbackContent(content: unknown): string {
	if (typeof content === "string")
		return displayText(content, EVIDENCE_CHARACTERS, true);
	if (!Array.isArray(content)) return "";
	const blocks: string[] = [];
	let remaining = EVIDENCE_CHARACTERS;
	for (const block of content) {
		if (
			!block ||
			typeof block !== "object" ||
			block.type !== "text" ||
			typeof block.text !== "string"
		)
			continue;
		blocks.push(displayText(block.text, remaining, true));
		remaining -= Math.min(block.text.length, remaining);
		if (remaining === 0) break;
	}
	return blocks.join("\n");
}

export function renderDispatcherCall(
	args: { tasks?: Array<{ description: string }> },
	_options: unknown,
	theme: Theme,
): Component {
	const container = new BoundedContainer(PROGRESS_ROWS, theme);
	const tasks = args.tasks ?? [];
	container.addChild(
		text(
			`Jev discovery - ${quantity(tasks.length, "task")}`,
			theme,
			"toolTitle",
			true,
		),
	);
	if (tasks.length === 1) {
		container.addChild(
			text(
				displayText(tasks[0]?.description, LABEL_CHARACTERS),
				theme,
				"muted",
			),
		);
	} else if (tasks.length === 0) {
		container.addChild(
			text("Waiting for a discovery request.", theme, "muted"),
		);
	} else {
		container.addChild(
			text("Local, read-only repository discovery.", theme, "muted"),
		);
	}
	return container;
}

export function renderDispatcherResult(
	result: { details?: DispatcherResult | DiscoveryProgress; content?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Component {
	const details = result.details;
	if (details && "phase" in details)
		return renderDispatcherProgress(details, theme);

	const container = new BoundedContainer(
		options.expanded ? EXPANDED_ROWS : COLLAPSED_ROWS,
		theme,
	);
	if (!details) {
		container.addChild(
			text(
				options.isPartial
					? "Discovery in progress"
					: "Discovery result unavailable",
				theme,
				"warning",
				true,
			),
		);
		const content = fallbackContent(result.content);
		container.addChild(
			text(content || "No structured discovery evidence was returned.", theme),
		);
		return container;
	}

	const findings = rankedFindings(details.findings);
	const unresolved =
		details.remainingTasks.length > 0 ||
		details.results.some(
			(outcome) => outcome.status === "REQUIRE_BIGGER_MODEL",
		);
	const incomplete =
		options.isPartial ||
		details.status !== "finished" ||
		unresolved ||
		details.warnings.length > 0;
	const status = options.isPartial
		? "In progress"
		: details.status === "aborted"
			? "Aborted"
			: details.status === "escalated"
				? "Needs a larger model"
				: incomplete
					? "Partial findings"
					: "Finished";
	container.addChild(
		text(
			`Jev discovery - ${status}`,
			theme,
			incomplete ? "warning" : "toolTitle",
			true,
		),
	);
	const taskIds = new Set(details.results.map((outcome) => outcome.task.id));
	for (const task of details.remainingTasks) taskIds.add(task.id);
	const resolved = details.results.filter(
		(outcome) => outcome.status !== "REQUIRE_BIGGER_MODEL",
	).length;
	const files = new Set(findings.map((finding) => finding.path)).size;
	container.addChild(
		text(
			`${quantity(findings.length, "location")} in ${quantity(files, "file")} | ${resolved}/${taskIds.size} tasks resolved`,
			theme,
			"muted",
		),
	);
	container.addChild(
		text(
			`${quantity(details.toolCalls, "tool call")} | ${quantity(details.decisions, "decision")} | ${elapsed(details.elapsedMs)}`,
			theme,
			"muted",
		),
	);
	if (incomplete) {
		const notice = options.isPartial
			? "Search is still running; findings are provisional."
			: details.status === "aborted"
				? "Stopped before discovery finished; these findings are partial."
				: details.status === "escalated" || unresolved
					? "Discovery is incomplete; unresolved work needs a larger model."
					: "Search limits or warnings apply; these findings are not exhaustive.";
		container.addChild(text(notice, theme, "warning"));
	}
	const warnings = options.expanded
		? details.warnings
		: details.warnings.slice(0, COLLAPSED_WARNINGS);
	for (const warning of warnings) {
		container.addChild(
			text(`Note: ${displayText(warning, LABEL_CHARACTERS)}`, theme, "warning"),
		);
	}
	const hiddenWarnings = details.warnings.length - warnings.length;
	if (hiddenWarnings > 0) {
		container.addChild(
			text(
				`${quantity(hiddenWarnings, "more warning")} when expanded.`,
				theme,
				"muted",
			),
		);
	}
	if (findings.length > 0)
		addFindings(container, findings, options.expanded, theme);
	else
		container.addChild(
			text("No locations found in the searched scope.", theme, "muted"),
		);
	if (options.expanded) addOutcomes(container, details, theme);
	else if (details.results.length > 0 || details.remainingTasks.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(
			text(
				"Expand for task summaries, evidence, and remaining work.",
				theme,
				"muted",
			),
		);
	}
	return container;
}

/** Custom messages have no host tool frame, so they own exactly one native box. */
export function renderDispatcherMessage(
	message: { details?: DispatcherResult; content?: unknown },
	options: { expanded: boolean },
	theme: Theme,
): Component {
	const box = new Box(0, 1, (content) => theme.bg("customMessageBg", content), {
		chars: theme.boxRound,
		color: (content) => theme.fg("borderMuted", content),
	});
	box.addChild(
		renderDispatcherResult(message, { ...options, isPartial: false }, theme),
	);
	return box;
}

export function renderDispatcherProgress(
	progress: DiscoveryProgress,
	theme: Theme,
): Component {
	const container = new BoundedContainer(PROGRESS_ROWS, theme);
	const phase =
		progress.phase === "indexing"
			? "Indexing local files"
			: progress.phase === "selecting"
				? "Selecting next search"
				: progress.phase === "searching"
					? "Searching"
					: "Search stopped; preparing result";
	container.addChild(
		text(`Jev discovery - ${phase}`, theme, "toolTitle", true),
	);
	const total = count(progress.totalTasks);
	const position = Math.min(count(progress.taskIndex), total);
	container.addChild(
		text(
			`Task ${position}/${total} | ${quantity(progress.files, "file")} | ${quantity(progress.toolCalls, "tool call")} | ${quantity(progress.decisions, "decision")} | ${elapsed(progress.elapsedMs)}`,
			theme,
			"muted",
		),
	);
	const action = progress.actions[progress.actions.length - 1];
	const detail = action || progress.task;
	if (detail)
		container.addChild(
			text(displayText(detail, PREVIEW_CHARACTERS), theme, "muted"),
		);
	container.addChild(
		text("Esc to cancel | /jev dispatcher stop", theme, "muted"),
	);
	return container;
}
