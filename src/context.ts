import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "./guards.js";
import type { JevConfig, Json } from "./types.js";

/** Avoid shipping images, hidden reasoning, environment dumps or the whole transcript. */
export function visibleMessage(value: unknown): Json {
	if (!isRecord(value)) return null;
	const content =
		typeof value.content === "string"
			? value.content
			: Array.isArray(value.content)
				? value.content
						.flatMap((part: unknown) => {
							if (!isRecord(part)) return [];
							if (part.type === "text" && typeof part.text === "string")
								return [part.text];
							if (part.type === "toolCall")
								return [`Tool: ${String(part.name)}`];
							return [];
						})
						.join("\n")
				: "";
	return {
		role: String(value.role ?? "unknown"),
		text: content.slice(-4000),
		truncated: content.length > 4000,
		...(typeof value.toolName === "string" ? { tool: value.toolName } : {}),
		...(value.isError === true ? { isError: true } : {}),
	};
}

export function todoPhases(ctx: ExtensionContext): Json[] {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (
			entry.type === "custom" &&
			entry.customType === "user_todo_edit" &&
			isRecord(entry.data) &&
			Array.isArray(entry.data.phases)
		) {
			return entry.data.phases as Json[];
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (
			msg.role !== "toolResult" ||
			msg.toolName !== "todo" ||
			msg.isError ||
			!isRecord(msg.details) ||
			msg.details.op === "view"
		)
			continue;
		if (Array.isArray(msg.details.phases)) return msg.details.phases as Json[];
	}
	return [];
}

export function hasActionableTodos(phases: Json[]): boolean {
	return phases.some(
		(phase) =>
			isRecord(phase) &&
			Array.isArray(phase.tasks) &&
			phase.tasks.some(
				(task: unknown) =>
					isRecord(task) &&
					(task.status === "pending" || task.status === "in_progress"),
			),
	);
}

export function redact(value: unknown, config: JevConfig): Json {
	const keys = new Set(
		config.context.redactKeys.map((key) => key.toLowerCase()),
	);
	const secret = process.env[config.client.apiKeyEnv];
	const visit = (item: unknown, depth: number): Json => {
		if (depth > 40) throw new Error("Jev state nesting exceeds 40 levels");
		if (item === null || typeof item === "boolean") return item;
		if (typeof item === "number") return Number.isFinite(item) ? item : null;
		if (typeof item === "string") {
			let text = secret ? item.replaceAll(secret, "[REDACTED]") : item;
			text = text
				.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
				.replace(
					/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
					"[REDACTED]",
				);
			return text;
		}
		if (Array.isArray(item))
			return item.map((child) => visit(child, depth + 1));
		if (isRecord(item))
			return Object.fromEntries(
				Object.entries(item)
					.filter(([, child]) => child !== undefined)
					.map(([key, child]) => [
						key,
						keys.has(key.toLowerCase())
							? "[REDACTED]"
							: visit(child, depth + 1),
					]),
			);
		return null;
	};
	return visit(value, 0);
}

export function makeState(
	ctx: ExtensionContext,
	config: JevConfig,
	event: unknown,
	extra: Record<string, unknown> = {},
): Json {
	const branch = ctx.sessionManager.getBranch();
	const messages: Json[] = [];
	let latestUser: Json = null;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		if (messages.length < config.context.recentMessages)
			messages.unshift(visibleMessage(entry.message));
		if (latestUser === null && entry.message.role === "user")
			latestUser = visibleMessage(entry.message);
		if (messages.length >= config.context.recentMessages && latestUser !== null)
			break;
	}
	const usage = ctx.getContextUsage();
	const state = redact(
		{
			event,
			latestUser,
			recentMessages: messages,
			todos: todoPhases(ctx),
			model: ctx.model
				? { id: ctx.model.id, provider: ctx.model.provider }
				: null,
			contextUsage: usage
				? { tokens: usage.tokens, contextWindow: usage.contextWindow }
				: null,
			jobs: ctx.getAsyncJobSnapshot(),
			...(config.context.includeSystemPrompt
				? { systemPrompt: ctx.getSystemPrompt() }
				: {}),
			...extra,
		},
		config,
	) as Record<string, Json>;
	const recent = state.recentMessages as Json[];
	while (
		JSON.stringify(state).length > config.context.maxChars &&
		recent.length
	) {
		recent.shift();
		state.historyTruncated = true;
	}
	// Never silently approve a tool based on a truncated operation or rule state.
	if (JSON.stringify(state).length > config.context.maxChars)
		throw new Error(
			"Jev state exceeds context.maxChars; no classification performed",
		);
	return state;
}
