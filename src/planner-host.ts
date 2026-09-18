import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@oh-my-pi/pi-coding-agent";
import { Box, Text, type Component } from "@oh-my-pi/pi-tui";
import { createDiscoveryTools } from "./discovery-tools.js";
import {
	makePlan,
	type PlannerEnvironment,
	type PlannerProgress,
	type PlannerRequest,
	type PlannerResult,
} from "./planning.js";

/**
 * Host adapter for the isolated planning core.
 *
 * `capturePlanner` takes everything the planner needs from the calling session
 * — model, effective thinking level, session identity and the read-only
 * discovery backend bound to the calling context — synchronously, before any
 * await. A later `/model` selection can therefore never leak into an in-flight
 * plan, and the planner never mutates the parent session in return: no
 * `setModel`, no `getAgentSession`, no global setting changes.
 *
 * Authentication goes through the central host resolver
 * (`ctx.modelRegistry.resolver(model, id)`) with a per-invocation scope, so one
 * planning run keeps sticky credentials without inheriting another run's. The
 * model object is passed through untouched, preserving custom endpoints and
 * headers. A missing or unresolved model is an error, never a silent fallback.
 */
export function capturePlanner(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selector?: string,
): (
	request: PlannerRequest,
	signal?: AbortSignal,
	update?: (progress: PlannerProgress) => void,
) => Promise<PlannerResult> {
	const requested = selector?.trim();
	const model =
		requested === undefined || requested === "" || requested === "current"
			? ctx.models.current()
			: ctx.models.resolve(requested);
	if (!model)
		throw new Error(
			requested && requested !== "current"
				? `Cannot resolve planning model ${requested}; check the model selector.`
				: "No current model selected; choose a model before planning.",
		);
	const thinking = pi.getThinkingLevel();
	const apiKey = ctx.modelRegistry.resolver(
		model,
		`jev-plan:${ctx.sessionManager.getSessionId()}:${crypto.randomUUID()}`,
	);
	const cwd = ctx.cwd;
	const sessionFile = ctx.sessionManager.getSessionFile();
	const tools = createDiscoveryTools(
		pi,
		{ cwd, sessionManager: { getSessionFile: () => sessionFile } },
		{ excludeSensitiveFiles: true },
	);
	// Explicit off disables reasoning outright; inherit defers to the model
	// default. Anything else is the captured effort.
	const environment: PlannerEnvironment =
		thinking === "off"
			? { model, disableReasoning: true, apiKey, tools }
			: thinking === undefined || thinking === "inherit"
				? { model, apiKey, tools }
				: { model, reasoning: thinking, apiKey, tools };
	return (request, signal, update) =>
		makePlan(request, environment, signal, update);
}

/** Escape untrusted terminal controls before trusted theme styling is applied. */
function displayLines(value: unknown, limit: number): string[] {
	if (typeof value !== "string" || !value.trim()) return [];
	const text = value
		.slice(0, limit)
		.replace(
			/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
			(character) =>
				character === "\n"
					? "\n"
					: character === "\t"
						? "   "
						: `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
	const lines = text.split("\n");
	const body =
		value.length > limit
			? [...lines.slice(0, -1), `${lines.at(-1) ?? ""} [shortened]`]
			: lines;
	return body;
}

function line(value: string, theme: Theme): Text {
	return new Text(value, 0, 0).setStyleFn((content) =>
		theme.fg("toolOutput", content),
	);
}

function muted(value: string, theme: Theme): Text {
	return new Text(value, 0, 0).setStyleFn((content) =>
		theme.fg("muted", content),
	);
}

/** Custom messages have no host tool frame, so they own exactly one native box. */
export function renderPlannerMessage(
	message: { content?: unknown },
	_options: { expanded: boolean },
	theme: Theme,
): Component {
	const box = new Box(0, 1, (content) => theme.bg("customMessageBg", content), {
		chars: theme.boxRound,
		color: (content) => theme.fg("borderMuted", content),
	});
	const text = typeof message.content === "string" ? message.content : "";
	// Committed terminal scrollback cannot be expanded later. Keep the complete
	// core-bounded plan visible instead of hiding its final steps or blockers.
	for (const value of displayLines(text, text.length))
		box.addChild(line(value, theme));
	return box;
}

export function renderPlannerProgress(
	progress: PlannerProgress,
	theme: Theme,
): Component {
	const box = new Box(0, 1, (content) => theme.bg("customMessageBg", content), {
		chars: theme.boxRound,
		color: (content) => theme.fg("borderMuted", content),
	});
	box.addChild(line(`Jev planning - ${progress.model}`, theme));
	box.addChild(
		muted(
			`${progress.toolCalls} tool calls | ${progress.turns} model turns`,
			theme,
		),
	);
	box.addChild(muted("Esc to cancel | /jev plan stop", theme));
	return box;
}
