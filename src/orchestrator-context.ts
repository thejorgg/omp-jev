import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { visibleMessage } from "./context.js";
import type { Json } from "./types.js";

export { hasActionableTodos, redact, todoPhases } from "./context.js";

/** Visible worker evidence only; omit previous synthetic workflow instructions. */
export function routerVisibleMessages(
	ctx: ExtensionContext,
	limit: number,
): Json[] {
	const messages: Json[] = [];
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0 && messages.length < limit; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		if (!["user", "assistant", "toolResult"].includes(entry.message.role))
			continue;
		messages.unshift(visibleMessage(entry.message));
	}
	return messages;
}
