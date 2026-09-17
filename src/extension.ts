import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { evaluate, validateQuestion } from "./client.js";
import { loadConfig, loadRules } from "./config.js";
import {
	hasActionableTodos,
	makeState,
	redact,
	todoPhases,
} from "./context.js";
import {
	acceptedChoice,
	delegationQuestion,
	eligibleTask,
	recoveryMessages,
	recoveryQuestion,
	safetyQuestion,
	thinkingQuestion,
} from "./decisions.js";
import { editDocument, readOptional } from "./editor.js";
import { configPaths, type ConfigName, type ConfigScope } from "./paths.js";
import {
	documentValidator,
	initialDocument,
	initializeDocuments,
	loadOrchestrator,
} from "./settings.js";
import { JevOrchestrator } from "./orchestrator.js";
import { NativeRuleGate } from "./native-rules.js";
import { matchRules } from "./rules.js";
import type {
	Answer,
	Evaluate,
	JevConfig,
	Json,
	Question,
	Rule,
	RuleEvent,
	RuleMatch,
} from "./types.js";

interface Session {
	config: JevConfig;
	rules: Rule[];
	turn: number;
	continuations: number;
	lastActions: Map<string, number>;
	native: NativeRuleGate;
	previousReminders?: boolean;
	warnings: Set<string>;
	lastDecision?: string;
	orchestrating?: boolean;
}

export default function jevExtension(pi: ExtensionAPI): void {
	const sessions = new Map<string, Promise<Session>>();
	let enabledOverride: boolean | undefined;
	let reminderOwner: Session | undefined;
	const paths = (ctx: ExtensionContext) =>
		configPaths(ctx.cwd, pi.pi.getAgentDir());
	const key = (ctx: ExtensionContext) =>
		`${ctx.sessionManager.getSessionId()}\0${ctx.cwd}`;
	const get = (ctx: ExtensionContext): Promise<Session> => {
		const id = key(ctx);
		let loaded = sessions.get(id);
		if (!loaded) {
			const locations = paths(ctx);
			loaded = Promise.all([
				loadConfig(locations.config),
				loadRules(locations.rules),
			]).then(([config, rules]) => ({
				config,
				rules,
				turn: 0,
				continuations: 0,
				lastActions: new Map(),
				native: new NativeRuleGate(),
				warnings: new Set(),
			}));
			sessions.set(id, loaded);
		}
		return loaded;
	};
	const enabled = (session: Session) =>
		(enabledOverride ?? session.config.enabled) &&
		Boolean(process.env[session.config.client.apiKeyEnv]);
	const notice = (ctx: ExtensionContext, text: string, error = false): void => {
		if (ctx.hasUI) ctx.ui.notify(text, error ? "warning" : "info");
		else console.error(text);
	};
	const warn = (
		session: Session,
		ctx: ExtensionContext,
		text: string,
	): void => {
		if (session.warnings.has(text)) return;
		session.warnings.add(text);
		notice(ctx, text, true);
	};
	const restoreReminders = (): void => {
		if (reminderOwner?.previousReminders !== undefined) {
			if (pi.pi.settings.get("todo.reminders") === false)
				pi.pi.settings.override(
					"todo.reminders",
					reminderOwner.previousReminders,
				);
			reminderOwner.previousReminders = undefined;
		}
		reminderOwner = undefined;
	};
	const syncReminders = (session: Session): void => {
		const settings = pi.pi.settings;
		if (reminderOwner && reminderOwner !== session) restoreReminders();
		if (
			enabled(session) &&
			(session.config.recovery.enabled || session.orchestrating)
		) {
			if (session.previousReminders === undefined)
				session.previousReminders = settings.get("todo.reminders");
			settings.override("todo.reminders", false);
			reminderOwner = session;
		} else if (session.previousReminders !== undefined) {
			restoreReminders();
		}
	};
	const client =
		(session: Session): Evaluate =>
		async (state, questions, signal) => {
			const cleanState = redact(state, session.config);
			const cleanQuestions = Object.fromEntries(
				Object.entries(questions).map(([id, question]) => [
					id,
					validateQuestion(redact(question, session.config)),
				]),
			);
			if (JSON.stringify(cleanState).length > session.config.context.maxChars)
				throw new Error("Jev state exceeds context.maxChars");
			return evaluate(
				session.config.client,
				cleanState,
				cleanQuestions,
				signal,
			);
		};
	const selectRules = (
		session: Session,
		event: RuleEvent,
		tool?: string,
	): Rule[] =>
		session.rules.filter(
			(rule) =>
				rule.enabled !== false &&
				rule.events.includes(event) &&
				(!rule.tools ||
					(tool !== undefined &&
						(rule.tools.includes(tool) || rule.tools.includes("*")))) &&
				(rule.outcomes.some((outcome) => outcome.action.type === "block") ||
					session.turn - (session.lastActions.get(rule.id) ?? -Infinity) >
						(rule.cooldownTurns ?? 0)),
		);
	const ruleQuestions = (rules: Rule[]): Record<string, Question> =>
		Object.fromEntries(
			rules.map((rule, index) => [
				`custom_${index}`,
				rule.state === undefined
					? rule.question
					: {
							...rule.question,
							instructions: {
								question: rule.question.instructions,
								ruleState: rule.state,
							},
						},
			]),
		);
	const ruleState = (rules: Rule[]): Record<string, Json> =>
		Object.fromEntries(
			rules.map((rule, index) => [`custom_${index}`, rule.state ?? null]),
		);
	const matches = (
		session: Session,
		rules: Rule[],
		answers: Record<string, Answer>,
	): RuleMatch[] => {
		const results = matchRules(
			rules,
			Object.fromEntries(
				rules.map((rule, index) => [rule.id, answers[`custom_${index}`]]),
			),
		);
		for (const match of results)
			if (match.action.type !== "block")
				session.lastActions.set(match.rule.id, session.turn);
		return results;
	};
	const send = (text: string): void =>
		pi.sendMessage(
			{ customType: "jev-guidance", content: text, display: false },
			{ deliverAs: "nextTurn" },
		);

	const orchestrator: JevOrchestrator = new JevOrchestrator(pi, {
		config: async (ctx) => ({
			main: (await get(ctx)).config,
			orchestrator: await loadOrchestrator(paths(ctx).orchestrator),
		}),
		enabled: async (ctx) => enabled(await get(ctx)),
		notice: (ctx, message) => notice(ctx, message),
		changed: async (ctx) => {
			const session = await get(ctx);
			session.orchestrating = orchestrator.isActive(ctx);
			syncReminders(session);
		},
	});
	// Typed TUI input cancels at submission time; RPC prompt/steer/follow_up never reach the
	// input event. Their deliveries surface as user-role message_start events in every mode,
	// while Jev's own stage guidance travels as agent-attributed custom messages, so delivery
	// of real user content releases the run and clears settled suppression without the
	// orchestrator cancelling itself.
	pi.on("input", async (event, ctx) => {
		if (!/^\/jev(?:\s|$)/.test(event.text.trim()))
			await orchestrator.userInput(ctx);
	});
	pi.on("message_start", async (event, ctx) => {
		const message = event.message;
		if (
			message.role !== "user" ||
			message.synthetic ||
			message.attribution === "agent"
		)
			return;
		await orchestrator.userInput(ctx);
	});
	pi.on("session_before_switch", async (_event, ctx) => {
		await orchestrator.stop(ctx, "paused before session switch");
	});
	pi.on("session_before_branch", async (_event, ctx) => {
		await orchestrator.stop(ctx, "paused before branching");
	});
	pi.on("session_before_tree", async (_event, ctx) => {
		await orchestrator.stop(ctx, "paused before navigation");
	});
	pi.on("agent_end", async (event, ctx) => {
		await orchestrator.onAgentEnd(ctx, event);
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const session = await get(ctx);
			syncReminders(session);
			if (
				(enabledOverride ?? session.config.enabled) &&
				!process.env[session.config.client.apiKeyEnv]
			) {
				warn(
					session,
					ctx,
					`Jev inactive: set ${session.config.client.apiKeyEnv}; no classifier requests or guardrails are active.`,
				);
			}
		} catch (error) {
			notice(ctx, `Jev configuration failed: ${String(error)}`, true);
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await orchestrator.stop(ctx, "stopped at shutdown", true);
		const loading = sessions.get(key(ctx));
		sessions.delete(key(ctx));
		if (!loading) return;
		try {
			const session = await loading;
			if (reminderOwner === session) restoreReminders();
		} catch {
			/* A rejected configuration never took ownership of reminders. */
		}
	});
	pi.on("session_switch", async (_event, ctx) => {
		restoreReminders();
		syncReminders(await get(ctx));
	});
	pi.on("turn_start", async (_event, ctx) => {
		if (enabledOverride !== false) (await get(ctx)).turn++;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (enabledOverride === false) return;
		const session = await get(ctx);
		syncReminders(session);
		if (!enabled(session)) return;
		const rules = selectRules(session, "before_agent_start");
		const questions = ruleQuestions(rules);
		if (
			session.config.thinking.enabled &&
			ctx.model?.reasoning &&
			!orchestrator.isActive(ctx)
		)
			questions.thinking = thinkingQuestion;
		if (!Object.keys(questions).length) return;
		try {
			const result = await client(session)(
				makeState(
					ctx,
					session.config,
					{ type: event.type, prompt: event.prompt },
					{ ruleState: ruleState(rules) },
				),
				questions,
			);
			const choice = acceptedChoice(
				result.answers.thinking,
				session.config.thinking,
			);
			if (choice) {
				pi.setThinkingLevel(choice as ThinkingLevel);
				session.lastDecision = `thinking: ${choice}`;
			}
			const actions = matches(session, rules, result.answers);
			const content = actions.map((match) => match.action.message).join("\n\n");
			if (content)
				return {
					message: { customType: "jev-guidance", content, display: false },
				};
		} catch (error) {
			warn(
				session,
				ctx,
				`Jev start decision unavailable; keeping OMP behavior. ${String(error)}`,
			);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (enabledOverride === false) return;
		let session: Session;
		try {
			session = await get(ctx);
		} catch {
			return {
				block: true,
				reason:
					"Jev configuration is invalid. Ask the user to correct it with /jev config or /jev rules and /jev reload.",
			};
		}
		if (!enabled(session) || event.toolName === "jev_decide") return;
		const config = session.config;
		const rules = selectRules(session, "tool_call", event.toolName);
		const questions = ruleQuestions(rules);
		const safety =
			config.safety.enabled &&
			(config.safety.tools.includes(event.toolName) ||
				config.safety.tools.includes("*"));
		if (safety) questions.safety = safetyQuestion;
		const tasks =
			event.toolName === "task"
				? Array.isArray(event.input.tasks)
					? event.input.tasks
					: [event.input]
				: [];
		const eligible = config.delegation.enabled
			? tasks.flatMap((task, index) =>
					eligibleTask(task, config.delegation.overrideExplicit) ? [index] : [],
				)
			: [];
		for (const index of eligible)
			questions[`delegate_${index}`] = delegationQuestion(index);
		if (!Object.keys(questions).length) return;
		try {
			// Normalize single-task input only in classifier state, never in execution input.
			const stateInput =
				event.toolName === "task" ? { ...event.input, tasks } : event.input;
			const result = await client(session)(
				makeState(
					ctx,
					config,
					{ type: event.type, toolName: event.toolName, input: stateInput },
					{ ruleState: ruleState(rules) },
				),
				questions,
			);
			if (safety) {
				const decision = acceptedChoice(result.answers.safety, config.safety);
				if (
					decision === "block" ||
					decision === "review" ||
					(!decision && config.safety.onUncertain === "block")
				) {
					return {
						block: true,
						reason: `Jev safety: ${decision ?? "uncertain"}. This operation was not executed. Reassess its scope, consequences and the user's authorization; narrow the operation or ask the user rather than bypassing the guard.`,
					};
				}
			}
			const actions = matches(session, rules, result.answers);
			const blocks = actions.filter((match) => match.action.type === "block");
			if (blocks.length)
				return {
					block: true,
					reason: blocks.map((match) => match.action.message).join("\n\n"),
				};
			for (const match of actions) send(match.action.message);
			let changed = false;
			const routed = tasks.map((task, index) => {
				const agent = acceptedChoice(
					result.answers[`delegate_${index}`],
					config.delegation,
				);
				if (!agent || !eligible.includes(index)) return task;
				changed = true;
				session.lastDecision = `task ${index}: ${agent}`;
				return { ...task, agent };
			});
			if (changed && event.toolName === "task")
				return {
					input: Array.isArray(event.input.tasks)
						? { ...event.input, tasks: routed }
						: routed[0],
				};
		} catch (error) {
			if (safety && config.safety.onError === "block")
				return {
					block: true,
					reason:
						"Jev safety classification unavailable; operation was not executed. Ask the user to check /jev status or revise the policy; do not bypass the guard.",
				};
			if (
				rules.some((rule) =>
					rule.outcomes.some((outcome) => outcome.action.type === "block"),
				)
			)
				return {
					block: true,
					reason:
						"A configured Jev blocking rule could not be evaluated; operation was not executed.",
				};
			warn(
				session,
				ctx,
				`Jev tool decision unavailable; original routing retained. ${String(error)}`,
			);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		orchestrator.noteToolResult(ctx, event.isError === true);
		if (enabledOverride === false) return;
		const session = await get(ctx);
		if (!enabled(session)) return;
		const rules = selectRules(session, "tool_result", event.toolName);
		if (!rules.length) return;
		try {
			const result = await client(session)(
				makeState(
					ctx,
					session.config,
					{
						type: event.type,
						toolName: event.toolName,
						input: event.input,
						content: event.content,
						isError: event.isError,
					},
					{ ruleState: ruleState(rules) },
				),
				ruleQuestions(rules),
			);
			const content = matches(session, rules, result.answers).map((match) => ({
				type: "text" as const,
				text: match.action.message,
			}));
			if (content.length) return { content: [...event.content, ...content] };
		} catch (error) {
			warn(session, ctx, `Jev result rule unavailable: ${String(error)}`);
		}
	});

	pi.on("session_stop", async (event, ctx) => {
		// One owner per stop boundary: never race the new controller with legacy recovery.
		if (orchestrator.handlesStop(ctx)) return orchestrator.onStop(ctx, event);
		if (enabledOverride === false) return;
		const session = await get(ctx);
		if (
			!enabled(session) ||
			event.signal.aborted ||
			ctx.hasPendingMessages() ||
			ctx.getAsyncJobSnapshot()?.running.length
		)
			return;
		if (!event.stop_hook_active) session.continuations = 0;
		if (session.continuations >= session.config.recovery.maxContinuations)
			return;
		const rules = selectRules(session, "session_stop");
		const questions = ruleQuestions(rules);
		if (session.config.recovery.enabled) questions.recovery = recoveryQuestion;
		if (!Object.keys(questions).length) return;
		try {
			const result = await client(session)(
				makeState(
					ctx,
					session.config,
					{ type: event.type, stopHookActive: event.stop_hook_active },
					{ ruleState: ruleState(rules), continuations: session.continuations },
				),
				questions,
				event.signal,
			);
			if (event.signal.aborted) return;
			const actions = matches(session, rules, result.answers);
			for (const match of actions)
				if (match.action.type === "message") send(match.action.message);
			const messages = actions
				.filter((match) => match.action.type === "continue")
				.map((match) => match.action.message);
			const choice = acceptedChoice(
				result.answers.recovery,
				session.config.recovery,
			);
			if (
				choice &&
				choice !== "settle" &&
				(choice !== "todo" || hasActionableTodos(todoPhases(ctx)))
			) {
				messages.push(recoveryMessages[choice]);
				session.lastDecision = `recovery: ${choice}`;
			}
			if (!messages.length) return;
			session.continuations++;
			return { continue: true, additionalContext: messages.join("\n\n") };
		} catch (error) {
			warn(
				session,
				ctx,
				`Jev recovery unavailable; no automatic retry or continuation. ${String(error)}`,
			);
			// Restore OMP's reminder policy rather than silently owning a failed classifier.
			if (session.previousReminders !== undefined) {
				restoreReminders();
			}
		}
	});

	pi.on("ttsr_triggered", async (event, ctx) => {
		if (enabledOverride !== false)
			(await get(ctx)).native.remember(event.rules);
	});
	pi.on("context", async (event, ctx) => {
		if (enabledOverride === false) return;
		const session = await get(ctx);
		if (!enabled(session)) return;
		const messages = await session.native.filter(
			event.messages,
			ctx,
			session.config,
			client(session),
		);
		if (messages) return { messages };
	});

	const T = pi.typebox.Type;
	pi.registerTool({
		name: "jev_decide",
		label: "Jev decision",
		description:
			"Ask TypeSafe Jev a bounded Choice, Noul (yes-probability), or Score question instead of an LLM. Supply arbitrary structured state and questions, or a configured manual rule ID. Returns typed answers and matched user messages, not generated prose. Choice/Score confidence is distinct from probability. Does not grant permissions, execute actions, or choose unbounded text.",
		parameters: T.Object({
			state: T.Unknown(),
			questions: T.Optional(T.Record(T.String(), T.Unknown())),
			rule: T.Optional(T.String()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const session = await get(ctx);
			if (!enabled(session))
				throw new Error(
					"Jev is inactive. Check /jev status and the configured API key environment variable.",
				);
			let questions: Record<string, Question>;
			let rules: Rule[] = [];
			if (params.rule) {
				if (params.questions)
					throw new Error("Provide questions or rule, not both");
				const rule = session.rules.find(
					(rule) =>
						rule.id === params.rule &&
						rule.enabled !== false &&
						rule.events.includes("manual"),
				);
				if (!rule) throw new Error("Unknown or disabled manual Jev rule");
				rules = [rule];
				questions = ruleQuestions(rules);
			} else {
				if (!params.questions || !Object.keys(params.questions).length)
					throw new Error(
						"Provide a nonempty questions map or a manual rule ID",
					);
				questions = Object.fromEntries(
					Object.entries(params.questions).map(([id, question]) => [
						id,
						validateQuestion(question),
					]),
				);
			}
			const result = await client(session)(
				makeState(
					ctx,
					session.config,
					{ type: "manual", state: params.state },
					{ ruleState: ruleState(rules) },
				),
				questions,
				signal,
			);
			const actions = rules.length
				? matches(session, rules, result.answers).map((match) => ({
						rule: match.rule.id,
						message: match.action.message,
					}))
				: [];
			return {
				content: [
					{ type: "text", text: JSON.stringify({ ...result, actions }) },
				],
				details: { ...result, actions },
			};
		},
	});

	const output = (ctx: ExtensionCommandContext, text: string): void => {
		if (ctx.hasUI) ctx.ui.notify(text, "info");
		else console.log(text);
	};
	const reload = async (ctx: ExtensionCommandContext): Promise<Session> => {
		const old = await sessions.get(key(ctx))?.catch(() => undefined);
		// Load first: invalid edits must not replace the last known working configuration.
		const locations = paths(ctx);
		const [config, rules] = await Promise.all([
			loadConfig(locations.config),
			loadRules(locations.rules),
			loadOrchestrator(locations.orchestrator),
		]);
		await orchestrator.stop(ctx, "paused for configuration reload");
		restoreReminders();
		const next: Session = {
			config,
			rules,
			turn: old?.turn ?? 0,
			continuations: old?.continuations ?? 0,
			lastActions: new Map(),
			native: old?.native ?? new NativeRuleGate(),
			warnings: new Set(),
		};
		sessions.set(key(ctx), Promise.resolve(next));
		syncReminders(next);
		return next;
	};
	pi.registerCommand("jev", {
		description:
			"Jev: plan/run <goal>, stop, status, config [all|orchestrator] [project], rules [project], init, paths, reload, enable, disable, test",
		handler: async (args, ctx) => {
			const [command = "status", scope, extraScope] = args
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			try {
				const locations = paths(ctx);
				if (command === "plan" || command === "run") {
					await orchestrator.start(
						ctx,
						args.trim().slice(command.length).trim(),
						command === "plan",
					);
					return;
				}
				if (command === "stop") {
					await orchestrator.stop(
						ctx,
						"routing stopped; interrupt OMP to cancel an in-flight worker",
					);
					output(ctx, orchestrator.status(ctx));
					return;
				}
				if (command === "paths" || command === "init") {
					const target: ConfigScope =
						scope === "project" ? "project" : "global";
					if (command === "init") await initializeDocuments(locations, target);
					output(
						ctx,
						Object.entries(locations[target])
							.map(([name, path]) => `${name}: ${path}`)
							.join("\n"),
					);
					return;
				}
				if (command === "disable") {
					await orchestrator.stop(ctx, "disabled");
					enabledOverride = false;
					restoreReminders();
					output(
						ctx,
						"Jev disabled for this session. Edit /jev config to persist.",
					);
					return;
				}
				if (command === "config" || command === "rules") {
					const tokens = [scope, extraScope].filter(Boolean);
					if (
						tokens.some(
							(token) =>
								![
									"main",
									"all",
									"orchestrator",
									"rules",
									"global",
									"project",
								].includes(token!),
						)
					)
						throw new Error(
							"Use /jev config [main|rules|orchestrator|all] [project]",
						);
					const target: ConfigScope = tokens.includes("project")
						? "project"
						: "global";
					const name =
						command === "rules"
							? "rules"
							: (tokens.find((token) =>
									["main", "rules", "orchestrator", "all"].includes(token!),
								) ?? "main");
					const names: ConfigName[] =
						name === "all"
							? ["main", "rules", "orchestrator"]
							: [name as ConfigName];
					if (orchestrator.isActive(ctx))
						throw new Error(
							"Use /jev stop before editing settings, then interrupt any in-flight worker.",
						);
					let saved = false;
					for (const selected of names) {
						const path = locations[target][selected];
						// Malformed existing files must still be repairable from this interface.
						const initial =
							(await readOptional(path)) === undefined
								? await initialDocument(selected, locations, target)
								: {};
						saved =
							(await editDocument(
								ctx,
								path,
								initial,
								documentValidator(selected),
							)) || saved;
					}
					if (saved) {
						await reload(ctx);
						output(
							ctx,
							"Jev configuration, rules and orchestrator settings saved and reloaded.",
						);
					}
					return;
				}
				if (command === "reload") {
					enabledOverride = undefined;
					await reload(ctx);
					output(
						ctx,
						"Jev configuration, rules and orchestrator settings reloaded.",
					);
					return;
				}
				const session = await get(ctx);
				if (command === "enable") {
					enabledOverride = true;
					syncReminders(session);
					output(
						ctx,
						`Jev enabled for this session. Edit /jev config to persist. Active: ${enabled(session)}.`,
					);
					return;
				}
				if (command === "test") {
					if (!enabled(session))
						throw new Error("Jev is inactive; check /jev status");
					const result = await client(session)(
						{ task: "Change the label Cancel to Close; no other changes." },
						{
							tier: {
								type: "choice",
								instructions: "What is the task difficulty?",
								criteria: {
									easy: "A small mechanical edit",
									hard: "Deep reasoning required",
								},
							},
						},
					);
					output(ctx, JSON.stringify(result, null, 2));
					return;
				}
				if (command !== "status") {
					output(
						ctx,
						"/jev plan <goal> | run [goal] | stop | status | config [all|main|rules|orchestrator] [project] | rules [project] | init [project] | paths | reload | enable | disable | test. Shell: omp-jev config --editor nano. Editors support Ctrl+G ($VISUAL/$EDITOR).",
					);
					return;
				}
				output(
					ctx,
					[
						`Jev: ${enabled(session) ? "active" : "inactive"}; key ${process.env[session.config.client.apiKeyEnv] ? "configured" : "missing"} (${session.config.client.apiKeyEnv})`,
						`Model: ${session.config.client.model}; endpoint: ${session.config.client.endpoint}`,
						`Thinking: ${session.config.thinking.enabled}; delegation: ${session.config.delegation.enabled}; safety: ${session.config.safety.enabled}; recovery: ${session.config.recovery.enabled}`,
						`Native rule relevance: ${session.config.nativeRules.enabled} (all triggered rules; inject by default, skip only confident contextual exemptions; model context only, cannot prevent native UI/interrupt).`,
						`Rules: ${session.rules.filter((rule) => rule.enabled !== false).length} active. Last decision: ${session.lastDecision ?? "none"}`,
						`Config (later wins): ${locations.config.join(" -> ")}`,
						orchestrator.status(ctx),
						`Orchestrator config: ${locations.orchestrator.join(" -> ")}`,
						`Rules (project IDs override global): ${locations.rules.join(" -> ")}`,
						`State sent to TypeSafe: recent visible messages, current operation/task, todos, model/job metadata. System prompt: ${session.config.context.includeSystemPrompt}. Secrets redacted best-effort; not a sandbox.`,
						"Delegation covers task calls (including nested tool.task); eval agent() bypasses task hooks. Native network retries and text-generation tiny tasks are unchanged.",
					].join("\n"),
				);
			} catch (error) {
				notice(
					ctx,
					`Jev: ${error instanceof Error ? error.message : "operation failed"}`,
					true,
				);
			}
		},
	});
}
