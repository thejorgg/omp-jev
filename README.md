# omp-jev

TypeSafe Jev routing for Oh My Pi, with an opt-in checkpoint orchestrator and editable XDG configuration. Requires Bun >= 1.3.14 and OMP >= 18.2.3.

## Edit everything in nano

From this checkout:

```sh
bun install
bun bin/omp-jev.ts config --editor nano
```

Or expose the CLI with `bun link`, then:

```sh
omp-jev config --editor nano           # opens all three global configs
omp-jev config orchestrator           # models, prompts, limits and thresholds
omp-jev config rules                  # all custom Jev rules
omp-jev config main                   # API, context, safety and existing routing
omp-jev config all --project          # project overrides
omp-jev paths                        # print exact filenames
omp-jev check                        # validate effective settings without editing
```

Editor precedence: `--editor`, `$VISUAL`, `$EDITOR`, then `nano`. Commands with flags and quoted executable paths are supported, without invoking a shell. The CLI creates missing documents, preserves existing ones, and validates after a successful editor exit. Invalid edits are saved alongside the file as `.invalid-...` drafts, then the previous documents are restored. A nonzero editor exit leaves edits on disk and reports the failure; run `omp-jev check` before reloading.

Inside OMP:

```text
/jev config all
/jev config orchestrator
/jev rules
/jev config all project
/jev init
/jev paths
/jev reload
```

The in-OMP editor retains native Ctrl+G integration with `$VISUAL`/`$EDITOR`. Shell edits require `/jev reload` in an existing OMP session. Stop orchestration before editing; a run snapshots its settings at startup. Existing malformed files can still be opened for repair. `init` materializes files without opening an editor; startup never writes config files automatically.

The plugin and its automatic judgment policies are disabled by default. Native OMP thinking, judgment/eval and guards remain in control; loading this extension does not add duplicate classifier calls. Keep `"enabled": false` in the global main config to disable all plugin judgments, including `jev_decide`. Existing sessions must run `/jev reload` (or `/jev disable` immediately).

## Read-only planning (`jev_plan`)

```text
/jev plan Fix the login race without changing the public API
/jev plan {"goal":"Add a timeout override","context":"Only change jev_decide.","model":"current"}
/jev plan stop
```

Planning uses an isolated agent with workspace-confined read, glob, grep, AST and read-only LSP tools. It cannot edit files, run shell commands, invoke MCP tools, or start implementation. Selected repository evidence goes to the selected LLM provider through OMP's authentication, not to the TypeSafe classifier.

The default is the **current model and effective thinking level at invocation**. An explicit `model` uses OMP's model selectors; an unresolved selector fails instead of falling back. A later parent-model change does not alter an in-flight plan, and planning never switches the parent model.

AI callers can invoke `jev_plan` concurrently with independent goals, contexts, budgets and cancellation signals:

```json
{"goal":"Plan a per-call timeout for jev_decide","context":"Preserve configured defaults","model":"current"}
```

Supply a self-contained goal and any necessary `context`: parent conversation, system prompts and previous tool results are not copied automatically. The tool requires `/jev enable` or `"enabled": true`; the explicit command works as a one-off without enabling automatic policies. Both require authentication for the chosen LLM, but neither needs a TypeSafe key solely for planning.

Results distinguish `ready`, `needs_input`, `incomplete` and `aborted`. Ready plans contain task IDs, dependencies, suggested roles, acceptance checks and references validated against source ranges actually read. `nextTask` is the first dependency-free task, not permission to execute it. Only ready plans expose a next task; limits, provider failures and cancellation preserve partial evidence without declaring readiness.

The complete bounded plan appears in tool text and structured `details`; the command displays it in chat without steering an active parent or triggering a worker. A successful command remembers its goal for a later explicit `/jev run`; tool calls never replace that goal. `/jev plan stop` cancels command-owned planning only. Reload, disable, session navigation, workspace moves and shutdown invalidate that command's result.

Planning is bounded by 16 model calls, 48 discovery actions, 320,000 serialized-context characters, 8,192 output tokens per call and a 180-second wall deadline. Goals over 8,000 characters and explicit context over 32,000 characters are rejected, never silently clipped. Source references establish what was read, not that every recommendation is correct. Review the result before execution. Planning excludes common credential stores, including dotenv files, private-key files and `.ssh`/`.aws`/`.gnupg` paths, even when the model requests them explicitly. This is filename/path filtering, not a guarantee that ordinary source or caller-supplied context contains no secrets. Pending host credential refreshes may outlive cancellation, but cannot resume the cancelled planner.

### Local planning benchmark

The frozen 12-case repository benchmark used `openai-codex/gpt-6-astra`, high thinking: eight development cases and four held-out cases. Independent source-based grading covered grounding, completeness, dependencies, verification and scope/handoff (10 points per case).

| Variant | Development | Held-out | Median time, development / held-out | Median result characters, development / held-out |
| --- | ---: | ---: | ---: | ---: |
| Direct Astra reference | 78/80 | 39/40 | 53.9s / 51.7s | 2,812 / 3,295 |
| Previous planning prompt | 71/80 | Not run | 37.7s / — | 1,882 / — |
| Structured-handoff prompt experiment | 78/80 | Not run | 63.5s / — | 3,793 / — |
| Isolated planner, frozen `integrated-v4` | 77/80 | 40/40 | 77.1s / 117.3s | 7,103 / 8,892 |

The isolated planner matched the reference's combined **117/120**, not a demonstrated quality improvement over it. All 12 final outcomes were structurally valid: ten `ready`, two `needs_input`; no benchmark implementation was executed. Development deductions concern an underspecified post-decision persistence plan and caller-role reporting. It was slower and returned more text; its benefit is isolated, read-only, parallel planning with a validated handoff—not lower measured latency or output size.

The first live integrated development run scored 69/80: one case exhausted the original 160,000-character context limit and returned `incomplete`. The context limit was raised before the final prompt/budget freeze and held-out generation; that failure remains in the evidence. Later review fixes changed credential-file access, auth cancellation, command delivery/lifecycle and terminal rendering, not the frozen planning prompt, schemas or budgets. The table measures the pre-review `integrated-v4` snapshot, not a fresh quality benchmark of those fixes.

These are single-run, same-repository measurements with different tool backends, not statistical proof or a guarantee for other models. [Preserved evidence](docs/solutions/planning-benchmark-2026-09-17.json) includes the cases, rubric/adjudication, source hashes, every scored output, unsuccessful attempts, token/output measurements and verification boundaries.

## Run the orchestrator

For an explicit plugin-orchestrated run, use `/jev enable` in the current session first. This enables the plugin, but its thinking, delegation, safety, native-rule and recovery policies remain off unless individually enabled in configuration. Set `TYPESAFE_API_KEY` in the environment used to launch OMP, or change `client.apiKeyEnv` in the main config. Keep the key out of config files and version control. Configure OMP's `@slow` and `@smol` model roles, or replace the four model selectors in `orchestrator.json` with authenticated `provider/model-id` selectors.

Review a planning result and resolve any blockers before execution:

```text
/jev run
```

This reuses the last explicit Jev goal in this session, asks the planner to reconcile it with the current conversation, and starts execution. Alternatively, `/jev run <goal>` starts directly. Starting a run is authorization to work on that goal, not to expand scope, publish, deploy, or bypass approvals.

```text
/jev status
/jev stop
```

`stop` cancels routing, aborts an in-flight router request, and prevents further routed stages. **It does not kill an already-running worker/tool; interrupt OMP for that.** User input, observed selection changes, session navigation, reload, shutdown and pending work also stop or pause routing. Runs do not silently resume across process restarts. Model/thinking restoration uses best-effort ownership checks, not an atomic host transaction.

**Accepted execution-controller concurrency limitation:** automatic switching is retained in `/jev run`, not in isolated planning. OMP 18.2.3 exposes an unconditional asynchronous model setter without mutation ownership, cancellation or a selection revision. A manual model/thinking change made during an execution-stage switch or restoration can be overwritten by the late plugin operation. Journal checks cannot reliably distinguish a host default/clamp from a user choice. Avoid native selection changes while these operations are in flight: run `/jev stop`, wait for its completion notice and any worker to finish, then change settings. The execution controller does not guarantee preservation of concurrent manual selections.

## What runs where

```text
strong planner <-> user
       |
       v
Jev Choice -> deterministic controller -> OMP worker stage
       ^                                    |
       +------------ checkpoint ------------+
```

Jev selects only `inspect`, `implement_fast`, `implement_strong`, `test`, `debug`, `review`, `replan`, `done`, or `ask_user`. OMP generates code, tool arguments and explanations. There is no generative manager call between worker stages.

`/jev run` is a **same-session, model-switching checkpoint controller**, not a parallel execution swarm or a per-tool action generator. The worker finishes its assigned stage before Jev decides the next stage. Workers retain the shared conversation and OMP's normal tool lifecycle, authentication and configured guards. Stage prompts are instructions, not sandbox-enforced permissions; a reviewer is instructed to inspect rather than edit. This differs from the isolated, read-only `jev_plan` agent.

Defaults:

| Role | Model | Thinking | Work |
| --- | --- | --- | --- |
| Planner | `@slow` | high | Initial plan and replanning |
| Fast | `@smol` | low | Inspection, mechanical edits, focused verification |
| Strong | `@slow` | high | Hard implementation and debugging |
| Reviewer | `@slow` | high | Review before completion |

These execution-role model selectors, thinking levels and stage prompts are editable in `orchestrator.json`; they do not select the isolated `jev_plan` model. The controller makes one bounded Jev Choice request per completed execution stage, with a separate 1,500 ms timeout, no retries, six recent visible messages and a 16,000-character state budget by default. `/jev plan` makes no next-action router call. `/jev status` and completion notices report observed router calls and elapsed routing time.

Automatic plugin policies default off; explicitly configured custom rules and enabled policies can still make additional calls after plugin activation. The normal thinking classifier is skipped while the controller owns a stage. The controller exclusively owns its `session_stop` cycle, so legacy recovery and custom stop-continuation rules cannot extend or resurrect the same run.

Low-confidence decisions escalate once to the planner, then pause rather than guess. Service errors pause immediately. Repeated actions and fast-worker errors escalate. Completion is rejected while actionable todos or a stage error remain; a review stage is required by default. These checks do not prove code correctness. Confidence and choice probability are separate gates, neither a guarantee of correctness.

Terminal assistant/provider errors pause the controller without routing to completion. A terminal `agent_end` releases ownership even when interruption bypasses `session_stop`; host-scheduled continuations retain ownership. Model/thinking changes observed at checkpoints pause routing; concurrent changes during an awaited switch have the limitation above. Recorded automatic thinking mode is restored as `auto`, not its resolved effort. OMP 18.2.3 does not expose the configured selector directly; when the session has no thinking-selection record (including unresolved initial auto mode), the controller does not explicitly set role effort or restore the unknown selector. Native model switching may still apply the target model's defaults.

`maxSteps` defaults to 8, counting the initial plan; the accepted range is 1–9 to respect OMP's eight advisory stop continuations. There is no hidden unbounded retry loop. Any other extension can still affect OMP's execution; this controller is not isolation from other extensions.


## Read-only dispatcher (`jev_dispatch`)

The `jev_dispatch` tool accepts natural-language discovery tasks and optional path hints. `dispatcher.enabled` defaults to `true`, including in older configs that omit it. The tool is exposed only while Jev is active and the dispatcher is enabled; setting `dispatcher.enabled: false` removes it from the model's available tools. Session enable/disable, switching sessions, and config reloads update tool availability. The `/jev dispatcher` command remains an explicit one-off even when the tool is disabled.

`/jev config` always displays a dispatcher entry for valid main configs, preserving explicit settings and the selected scope's effective enabled value. Cancelling leaves the file unchanged; saving persists the entry. This is independent of `safety.enabled`.

Discovery uses workspace-local file reads, content grep, filename globbing, AST search, and OMP's read-only LSP navigation. Natural-language location requests rank files with separate keyword scans, select candidates through typed questions, then verify bounded source windows. Exact-symbol, related-files, and explicitly scoped requests retain the navigation loop. Jev does not generate executable code, arbitrary searches, or a prose report.

The calling model receives a plain-text report capped at 12,000 characters, not the full result JSON. Ranked `file:start-end` blocks coalesce agreeing source ranges, preserve gaps, and mark omissions. Full metadata stays in tool details. The native terminal panel shows progress, counts, elapsed time, and six leading file blocks. Use OMP's expand-tools shortcut (default **Ctrl+O**) for source, remaining locations, task outcomes, and warnings.

Each task ends `TASK_FINISHED`, `NO_PATH`, or `REQUIRE_BIGGER_MODEL`. Budget exhaustion, failed decisions, and cancellation retain bounded partial evidence; unverified source remains marked unranked. A failed location search cannot finish successfully just because earlier blocks looked relevant. Escalation stops the queue and returns untouched `remainingTasks`; it never spawns a model. These are bounded searches, not exhaustive proof of absence.

Discovery never writes source files or invokes shell commands, MCP tools, skills, or another agent. Paths are confined to the workspace after resolving symlinks. Implicit file scans respect gitignore, skip hidden files, and filter common private-key stores. Explicit file hints may read hidden files inside the workspace: do not supply secret files. Selected repository evidence is sent to the configured TypeSafe endpoint and remains untrusted data.

### Try it from chat

With `TYPESAFE_API_KEY` in OMP's environment (or your configured `client.apiKeyEnv`), run:

```text
/jev dispatcher
/jev dispatcher Find where NativeRuleGate is implemented
/jev dispatcher I want to read all files related to native rule selection
/jev dispatcher stop
```

The bare command shows help. A task runs immediately through Jev; results stay in chat and no LLM turn starts. Wait for any active agent/orchestrator run to finish first. Press **Esc** or **Ctrl+C** while the command is running, or use `/jev dispatcher stop`, to cancel and retain partial evidence.

For several tasks or explicit candidate files, pass the same JSON shape as the tool:

```text
/jev dispatcher {"tasks":[{"id":"manifest","description":"Read package.json to find the test command","paths":["package.json"]},{"id":"config","description":"Read tsconfig.json to find compiler options","paths":["tsconfig.json"]}],"tree":""}
```

Omitting `tree` inventories up to 10,000 workspace files and enables repository-wide bootstrap search. Supplying `tree` replaces that inventory with explicit candidates; `tree: ""` starts from `paths` alone. With an explicit scope, Jev can choose file reads or a scoped grep; no search is forced before that choice. Related locations discovered through navigation can still be followed. Results are bounded evidence, not a guarantee that every related file has been found.

Defaults: 12 decision steps per task, four actions per batch, 12 offered actions per decision, 32 total tool calls including inventory, and 24,000 retained evidence characters. `dispatcher.timeoutMs` defaults to 5,000 ms per Jev request; language servers use OMP's own timeouts and may take longer on first use.

Read evidence preserves up to 4,096 characters per source line; longer lines are explicitly marked as truncated. Search snippets remain capped at 400 characters. The 1 MiB file-read window and shared evidence budget still apply.

`minReadProbability` gates accepted source blocks; a location task needs a block reaching `minProbability` to finish. In the navigation loop, `minConfidence` and `minProbability` gate stop/escalation choices, while independently accepted read-only actions may gather more evidence. Rejected candidates are deferred until new evidence arrives; an entirely rejected window advances without replaying it. Every decision attempt consumes a step. `maxInvalidChoices` bounds repeated unusable continuation selections.

After updating extension code, use `/reload-plugins` or restart OMP. `/jev reload` reloads configuration only.

To test the checkout's extension without loading another installed copy:

```sh
omp --no-extensions -e ./src/extension.ts
```

Try an exact symbol, a related-files query, and a missing symbol. Expand the results, then cancel a running query to check partial evidence. LSP capability failures and truncated searches are shown as warnings, not treated as proof that a symbol is absent.


## Files and precedence

Default global directory: `~/.config/omp-jev`. An absolute `$XDG_CONFIG_HOME` changes this to `$XDG_CONFIG_HOME/omp-jev`; an absolute `$OMP_JEV_CONFIG_DIR` overrides the directory directly.

| Settings | Global | Project |
| --- | --- | --- |
| API, context and existing policies | `config.json` | `.omp/jev.json` |
| Custom rules | `rules.json` | `.jevrules` |
| Controller, models and prompts | `orchestrator.json` | `.omp/jev-orchestrator.json` |

Main config precedence is defaults -> legacy agent-directory `jev.json` -> XDG `config.json` -> project `.omp/jev.json`. Rules load in the equivalent order; later rule IDs override earlier IDs. Orchestrator config loads defaults -> XDG -> project. Nested config objects are merged; arrays replace the corresponding array.

The extension uses OMP's actual agent directory for legacy files. The standalone CLI uses `~/.omp/agent`; set `OMP_JEV_LEGACY_AGENT_DIR` when using a custom OMP agent directory. On first global initialization, legacy settings/rules are copied into the new global documents **without incorporating project overrides**. Legacy files are never deleted or rewritten. The new files then take precedence. New project config documents are minimal overlays, not full default snapshots that accidentally hide later global changes.

Editing defaults changed deliberately: `/jev rules` now edits **global** rules; use `/jev rules project` for repository-local rules. `/jev config` edits the global main config. `/jev config all` edits all three.

Configuration is strict JSON: unknown keys, malformed schemas and out-of-range values are errors. Files created through the editors use mode 0600. Configuration paths and their effective precedence appear in `/jev status`.

## Existing features

The extension retains Jev thinking selection, eligible task delegation to the supplied `smol`/`slow` agent presets, tool safety classification, custom Choice/Noul/Score rules, native-rule relevance filtering, stop recovery and the `jev_decide` tool. See `examples/jev.json` and `examples/.jevrules` for the pre-existing policy formats. Custom rules belong in global `rules.json` or project `.jevrules`.

If native-rule filtering is explicitly enabled, Jev assesses every triggered rule by content and operation context, not a name allowlist. Injection is the default; only a confident exemption removes guidance. Temporary or internal code can make production-facing requirements irrelevant, but does not blanket-exempt safety or universal requirements. Remove obsolete `nativeRules.names` keys from existing configs. Filtering affects model context only, not OMP's earlier UI notification or interruption.

Classifier state includes the goal, bounded visible conversation/tool output, todos and controller metadata. Hidden reasoning and images are excluded from the orchestrator state. Redaction reuses the existing best-effort key/token rules; it is not comprehensive secret detection. Do not send repositories or data to TypeSafe without authorization.

## Verification

```sh
bun install --frozen-lockfile
bun run check
bun test
```

New tests exercise routing budgets and thresholds, failure escalation, mandatory review, cancellation/startup races, model restoration, compact/redacted state, XDG precedence, migration, project overlays, editor argument handling and invalid-draft recovery. Controller tests mock the provider and OMP host while using the real Jev client validator; they do not measure live Jev routing quality or real-model implementation quality.

For a live smoke test, use a disposable repository and authenticated model roles: run `/jev enable`, `/jev test`, `/jev plan` for a small change, inspect the plan, then `/jev run`. Check the displayed stage/model transitions, cancel a run, verify restoration with `/jev status` and `/model`, and run your project tests independently. Use `/jev disable` afterward to return control entirely to native OMP.
