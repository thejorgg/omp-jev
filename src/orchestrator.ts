import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStopEvent,
	ThinkingLevelChangeEntry,
} from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { evaluate } from "./client.js";
import {
	hasActionableTodos,
	redact,
	routerVisibleMessages,
	todoPhases,
} from "./orchestrator-context.js";
import {
	chooseNext,
	nextActionQuestion,
	routerState,
	stagePrompt,
	stageRole,
	type OrchestratorConfig,
	type Role,
	type RunState,
	type Stage,
} from "./orchestration.js";
import type { JevConfig } from "./types.js";

interface Dependencies {
	config(
		ctx: ExtensionContext,
	): Promise<{ main: JevConfig; orchestrator: OrchestratorConfig }>;
	enabled(ctx: ExtensionContext): Promise<boolean>;
	notice(ctx: ExtensionContext, message: string): void;
	changed?(ctx: ExtensionContext): Promise<void>;
}
type Model = NonNullable<ExtensionContext["model"]>;
type ThinkingSelection = ThinkingLevel | "auto" | undefined;
interface ActiveRun {
	state: RunState;
	config: OrchestratorConfig;
	main: JevConfig;
	models: Record<Role, Model>;
	originalModel?: Model;
	originalThinking: ThinkingSelection;
	manageThinking: boolean;
	selectedModel?: Model;
	selectedThinking?: ThinkingSelection;
	controller: AbortController;
	planningOnly: boolean;
	deciding: boolean;
	stageFailed: boolean;
	calls: number;
	routingMs: number;
}
const sessionKey = (ctx: ExtensionContext): string =>
	`${ctx.sessionManager.getSessionId()}\0${ctx.cwd}`;
const sameModel = (a: Model | undefined, b: Model | undefined): boolean =>
	Boolean(a && b && a.id === b.id && a.provider === b.provider);

/** Checkpoint controller: no manager LLM, generated tool arguments, or hidden worker process. */
export class JevOrchestrator {
	private runs = new Map<string, ActiveRun>();
	private goals = new Map<string, string>();
	private epochs = new Map<string, number>();
	private settled = new Set<string>();
	private modelQueue: Promise<unknown> = Promise.resolve();
	private restorations = new Map<string, Promise<void>>();

	constructor(
		private pi: ExtensionAPI,
		private deps: Dependencies,
	) {}
	isActive(ctx: ExtensionContext): boolean {
		return this.runs.has(sessionKey(ctx));
	}
	handlesStop(ctx: ExtensionContext): boolean {
		return this.isActive(ctx) || this.settled.has(sessionKey(ctx));
	}
	async userInput(ctx: ExtensionContext): Promise<void> {
		await this.stop(ctx, "paused for user input");
		this.settled.delete(sessionKey(ctx));
	}
	status(ctx: ExtensionContext): string {
		const run = this.runs.get(sessionKey(ctx));
		return run
			? `Orchestrator: ${run.state.stage}, stage ${run.state.steps}/${run.config.maxSteps}, ${run.calls} router calls, ${Math.round(run.routingMs)}ms routing total.`
			: "Orchestrator: idle (explicit /jev plan or /jev run).";
	}
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const pending = this.modelQueue.then(fn, fn);
		this.modelQueue = pending.catch(() => undefined);
		return pending;
	}
	private owns(ctx: ExtensionContext, run: ActiveRun): boolean {
		return (
			this.runs.get(sessionKey(ctx)) === run && !run.controller.signal.aborted
		);
	}
	private thinkingSelection(ctx: ExtensionContext): ThinkingSelection {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "thinking_level_change") {
				return entry.configured === "auto"
					? "auto"
					: this.pi.getThinkingLevel();
			}
		}
		return this.pi.getThinkingLevel();
	}
	private async select(
		ctx: ExtensionContext,
		run: ActiveRun,
		stage: Stage,
	): Promise<boolean> {
		return this.serialize(async () => {
			if (!this.owns(ctx, run)) return false;
			if (
				run.selectedModel &&
				this.thinkingSelection(ctx) !== run.selectedThinking
			)
				throw new Error("Thinking selection changed before stage transition");
			const role = stageRole(stage),
				model = run.models[role];
			const branchStart = ctx.sessionManager.getBranch().length;
			if (!(await this.pi.setModel(model)))
				throw new Error(
					`No authentication for configured ${role} model ${run.config.models[role]}`,
				);
			// Record the completed switch even when cancellation happened during setModel.
			run.selectedModel = model;
			// Best-effort heuristic: the host may append one effort reapplication.
			// Without source identity, the first record can instead be a user change.
			let switched = false,
				reapplied = false;
			let manualThinking: ThinkingLevelChangeEntry | undefined;
			const branch = ctx.sessionManager.getBranch();
			for (let i = branchStart; i < branch.length; i++) {
				const entry = branch[i];
				if (
					entry.type === "model_change" &&
					entry.model === `${model.provider}/${model.id}`
				)
					switched = true;
				if (entry.type === "thinking_level_change") {
					if (!switched || reapplied) manualThinking = entry;
					else reapplied = true;
				}
			}
			if (manualThinking) {
				// Do not let restoring the old model reapply its default over user intent.
				run.selectedModel = undefined;
				const selection =
					manualThinking.configured ??
					manualThinking.thinkingLevel ??
					"inherit";
				this.pi.setThinkingLevel(selection as ThinkingLevel);
				throw new Error("Thinking selection changed during model switch");
			}
			run.selectedThinking = this.thinkingSelection(ctx);
			if (!this.owns(ctx, run)) return false;
			// No selector entry can mean unresolved auto mode; never replace an unknown mode.
			// setModel can legitimately clamp effort or apply the target model's default.
			if (run.manageThinking)
				this.pi.setThinkingLevel(run.config.thinking[role] as ThinkingLevel);
			run.selectedThinking = this.thinkingSelection(ctx);
			return true;
		});
	}
	async stop(
		ctx: ExtensionContext,
		reason: string,
		forget = false,
	): Promise<void> {
		const key = sessionKey(ctx),
			run = this.runs.get(key);
		this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
		if (forget) this.settled.delete(key);
		if (forget) this.goals.delete(key);
		if (!run) {
			await this.restorations.get(key);
			return;
		}
		this.runs.delete(key);
		if (!forget) this.settled.add(key);
		run.controller.abort();
		// Publish the pending restoration before the first await so a concurrent
		// start() waits out settings and model restoration instead of snapshotting
		// the borrowed worker model as its own original.
		let restored!: () => void;
		const restoration = new Promise<void>((resolve) => {
			restored = resolve;
		});
		this.restorations.set(key, restoration);
		try {
			await this.deps
				.changed?.(ctx)
				.catch((error) =>
					this.deps.notice(
						ctx,
						`Jev settings restoration failed: ${String(error)}`,
					),
				);
			await this.serialize(async () => {
				// Best-effort checkpoint: native setModel can still race a later user change.
				const current = ctx.models.current();
				if (
					sameModel(current, run.selectedModel) &&
					this.thinkingSelection(ctx) === run.selectedThinking
				) {
					if (
						run.originalModel &&
						!(await this.pi.setModel(run.originalModel))
					) {
						this.deps.notice(
							ctx,
							"Jev could not restore the original model; select it with /model.",
						);
					}
					// The runtime accepts auto, although ExtensionAPI exposes the narrower effort enum.
					if (run.manageThinking)
						this.pi.setThinkingLevel(
							(run.originalThinking ?? "inherit") as ThinkingLevel,
						);
				}
			}).catch((error) =>
				this.deps.notice(ctx, `Jev model restoration failed: ${String(error)}`),
			);
		} finally {
			if (this.restorations.get(key) === restoration)
				this.restorations.delete(key);
			restored();
		}
		this.deps.notice(
			ctx,
			`Jev ${reason}. ${run.state.steps} stage(s), ${run.calls} router call(s), ${Math.round(run.routingMs)}ms routing total.`,
		);
	}
	async start(
		ctx: ExtensionCommandContext,
		suppliedGoal: string,
		planningOnly = false,
	): Promise<void> {
		if (
			!ctx.isIdle() ||
			ctx.hasPendingMessages() ||
			ctx.getAsyncJobSnapshot()?.running.length
		)
			throw new Error(
				"Wait for current work to finish or interrupt it before starting /jev run.",
			);
		if (this.isActive(ctx))
			throw new Error(
				"An orchestration run is already active; use /jev stop first.",
			);
		const key = sessionKey(ctx),
			goal = suppliedGoal.trim() || this.goals.get(key);
		const epoch = this.epochs.get(key) ?? 0;
		if (!goal)
			throw new Error(
				"Use /jev plan <goal> or /jev run <goal>. /jev run alone reuses your last explicit Jev goal in this session.",
			);
		// A preceding stop may still be restoring settings and the original model;
		// wait it out so the snapshot below records the user's model, never the
		// borrowed worker's. The epoch/idleness recheck after preparation still
		// guards anything that changes during the wait.
		const restoration = this.restorations.get(key);
		if (restoration) await restoration;
		const { main, orchestrator: config } = await this.deps.config(ctx);
		if (!(await this.deps.enabled(ctx)))
			throw new Error(
				`Jev is inactive; check /jev status and ${main.client.apiKeyEnv}.`,
			);
		if (goal.length > Math.min(8000, config.contextMaxChars / 2))
			throw new Error(
				"Goal is too long for the router budget; provide a short goal referencing the plan in this conversation.",
			);
		const models = {} as Record<Role, Model>;
		for (const role of ["planner", "fast", "strong", "reviewer"] as const) {
			const model = ctx.models.resolve(config.models[role]);
			if (!model)
				throw new Error(
					`Cannot resolve ${role} model ${config.models[role]}; edit /jev config orchestrator.`,
				);
			models[role] = model;
		}
		// Configuration/model discovery can await I/O; recheck ownership before taking control.
		if (
			!ctx.isIdle() ||
			ctx.hasPendingMessages() ||
			ctx.getAsyncJobSnapshot()?.running.length ||
			this.isActive(ctx) ||
			(this.epochs.get(key) ?? 0) !== epoch
		)
			throw new Error(
				"Session changed while preparing the run; nothing was started.",
			);
		const run: ActiveRun = {
			state: {
				goal,
				stage: "plan",
				steps: 1,
				repeated: 1,
				fastFailures: 0,
				escalated: false,
			},
			config,
			main,
			models,
			originalModel: ctx.models.current(),
			originalThinking: this.thinkingSelection(ctx),
			manageThinking: ctx.sessionManager
				.getBranch()
				.some((entry) => entry.type === "thinking_level_change"),
			controller: new AbortController(),
			planningOnly,
			deciding: false,
			stageFailed: false,
			calls: 0,
			routingMs: 0,
		};
		this.runs.set(key, run);
		this.goals.set(key, goal);
		try {
			await this.deps.changed?.(ctx);
			if (!(await this.select(ctx, run, "plan"))) return;
			if (ctx.hasPendingMessages()) {
				await this.stop(ctx, "paused for pending user input");
				return;
			}
			this.pi.sendMessage(
				{
					customType: "jev-orchestrator",
					content: stagePrompt(run.state, config),
					display: true,
				},
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			this.deps.notice(
				ctx,
				planningOnly
					? "Jev planning only; discuss the plan, then use /jev run to execute the same goal."
					: "Jev run started. /jev stop cancels routing; interrupt OMP to stop an in-flight worker.",
			);
		} catch (error) {
			await this.stop(ctx, "stopped during startup");
			throw error;
		}
	}
	noteToolResult(ctx: ExtensionContext, isError: boolean): void {
		const run = this.runs.get(sessionKey(ctx));
		if (run && isError) run.stageFailed = true;
	}
	async onAgentEnd(
		ctx: ExtensionContext,
		event: { willContinue?: boolean },
	): Promise<void> {
		// Deliberate aborts bypass session_stop; host retries and routed stages do not.
		if (!event.willContinue && this.isActive(ctx))
			await this.stop(ctx, "paused at terminal worker end");
	}
	async onStop(
		ctx: ExtensionContext,
		event: Pick<
			SessionStopEvent,
			"signal" | "stop_hook_active" | "last_assistant_message"
		>,
	): Promise<{ continue: true; additionalContext: string } | undefined> {
		const run = this.runs.get(sessionKey(ctx));
		if (!run || run.deciding) return;
		if (
			event.signal.aborted ||
			ctx.hasPendingMessages() ||
			ctx.getAsyncJobSnapshot()?.running.length
		) {
			await this.stop(ctx, "paused for interruption or pending work");
			return;
		}
		const assistant = event.last_assistant_message;
		if (
			assistant?.role === "assistant" &&
			(assistant.stopReason === "error" ||
				assistant.stopReason === "aborted" ||
				assistant.errorMessage)
		) {
			await this.stop(ctx, "paused after worker failure; no automatic retry");
			return;
		}
		if (run.planningOnly) {
			await this.stop(ctx, "plan ready; review it before /jev run");
			return;
		}
		if (
			!sameModel(ctx.models.current(), run.selectedModel) ||
			this.thinkingSelection(ctx) !== run.selectedThinking
		) {
			await this.stop(ctx, "paused after a model or thinking change");
			return;
		}
		run.deciding = true;
		try {
			if (!(await this.deps.enabled(ctx))) {
				await this.stop(ctx, "paused because Jev is inactive");
				return;
			}
			if (!this.owns(ctx, run)) return;
			if (run.stageFailed && stageRole(run.state.stage) === "fast")
				run.state.fastFailures++;
			const todos = todoPhases(ctx);
			const state = redact(
				routerState(
					run.state,
					routerVisibleMessages(ctx, run.config.recentMessages),
					todos,
					run.stageFailed,
					Math.min(run.main.context.maxChars, run.config.contextMaxChars),
				),
				run.main,
			);
			if (
				JSON.stringify(state).length >
				Math.min(run.main.context.maxChars, run.config.contextMaxChars)
			)
				throw new Error("Redacted router state exceeds the context budget");
			const questions = redact(
				{ next_action: nextActionQuestion },
				run.main,
			) as { next_action: typeof nextActionQuestion };
			const started = performance.now();
			run.calls++;
			const result = await evaluate(
				{ ...run.main.client, timeoutMs: run.config.timeoutMs },
				state,
				questions,
				AbortSignal.any([event.signal, run.controller.signal]),
			);
			run.routingMs += performance.now() - started;
			if (!this.owns(ctx, run) || event.signal.aborted) return;
			if (
				ctx.hasPendingMessages() ||
				ctx.getAsyncJobSnapshot()?.running.length
			) {
				await this.stop(ctx, "paused for new input or background work");
				return;
			}
			if (
				!sameModel(ctx.models.current(), run.selectedModel) ||
				this.thinkingSelection(ctx) !== run.selectedThinking
			) {
				await this.stop(ctx, "paused after a model or thinking change");
				return;
			}
			const route = chooseNext(
				result.answers.next_action,
				run.state,
				run.config,
				hasActionableTodos(todos),
				run.stageFailed,
			);
			this.pi.appendEntry("jev-orchestration", {
				stage: run.state.stage,
				next: route.action,
				reason: route.reason,
				routingMs: Math.round(performance.now() - started),
				steps: run.state.steps,
			});
			if (route.action === "done" || route.action === "ask_user") {
				await this.stop(
					ctx,
					route.action === "done"
						? "finished (review the worker's evidence)"
						: `paused: ${route.reason}`,
				);
				return;
			}
			const next = route.action;
			if (!(await this.select(ctx, run, next))) return;
			if (
				!this.owns(ctx, run) ||
				event.signal.aborted ||
				ctx.hasPendingMessages()
			) {
				await this.stop(ctx, "paused during stage transition");
				return;
			}
			run.state.repeated =
				next === run.state.stage ? run.state.repeated + 1 : 1;
			run.state.stage = next;
			run.state.steps++;
			if (next === "replan") run.state.escalated = true;
			run.stageFailed = false;
			this.deps.notice(
				ctx,
				`Jev → ${next} (${route.reason}); ${run.config.models[stageRole(next)]}.`,
			);
			return {
				continue: true,
				additionalContext: stagePrompt(run.state, run.config),
			};
		} catch (error) {
			if (this.owns(ctx, run))
				await this.stop(
					ctx,
					`paused; no automatic retry: ${error instanceof Error ? error.message : String(error)}`,
				);
		} finally {
			run.deciding = false;
			if (event.signal.aborted && this.owns(ctx, run))
				await this.stop(ctx, "paused after interruption");
		}
	}
}
