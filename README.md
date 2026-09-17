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

## Run the orchestrator

Set `TYPESAFE_API_KEY` in the environment used to launch OMP, or change `client.apiKeyEnv` in the main config. Keep the key out of config files and version control. Configure OMP's `@slow` and `@smol` model roles, or replace the four model selectors in `orchestrator.json` with authenticated `provider/model-id` selectors.

```text
/jev plan Fix the login race without changing the public API
```

This asks the planner to inspect and propose a bounded plan, then stops. Discuss requirements and approve/refine the plan normally. It does not automatically begin implementation.

```text
/jev run
```

This reuses the last explicit Jev goal in this session, asks the planner to reconcile it with the current conversation, and starts execution. Alternatively, `/jev run <goal>` starts directly. Starting a run is authorization to work on that goal, not to expand scope, publish, deploy, or bypass approvals.

```text
/jev status
/jev stop
```

`stop` cancels the controller, aborts an in-flight router request, and prevents further routed stages. **It does not kill an already-running worker/tool; interrupt OMP for that.** User input, model changes, session navigation, reload, shutdown and pending work also stop or pause ownership. Runs do not silently resume across process restarts. Previous model/thinking settings are restored when still owned by the controller; explicit user changes are not overwritten.

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

This is a **same-session, model-switching checkpoint controller**, not a parallel subagent swarm or a per-tool action generator. The worker finishes its assigned stage before Jev decides the next stage. Workers retain the shared conversation and OMP's normal tool lifecycle, authentication and configured guards. Stage prompts are instructions, not sandbox-enforced permissions; a reviewer is instructed to inspect rather than edit.

Defaults:

| Role | Model | Thinking | Work |
| --- | --- | --- | --- |
| Planner | `@slow` | high | Initial plan and replanning |
| Fast | `@smol` | low | Inspection, mechanical edits, focused verification |
| Strong | `@slow` | high | Hard implementation and debugging |
| Reviewer | `@slow` | high | Review before completion |

Every model selector, thinking level and stage prompt is editable in `orchestrator.json`. The controller makes one bounded Jev Choice request per completed execution stage, with a separate 1,500 ms timeout, no retries, six recent visible messages and a 16,000-character state budget by default. `/jev plan` alone makes no next-action router call. `/jev status` and completion notices report observed router calls and elapsed routing time; no live latency/quality benchmark is implied.

Existing safety, custom-rule and other Jev hooks remain active and may make additional calls. The normal thinking classifier is skipped while the controller owns a stage, avoiding conflicting thinking-level changes. The controller exclusively owns its `session_stop` cycle, so legacy recovery and custom stop-continuation rules cannot extend or resurrect the same run. Their ordinary behavior returns on subsequent user input.

Low-confidence decisions escalate once to the planner, then pause rather than guess. Service errors pause immediately. Repeated actions and fast-worker errors escalate. Completion is rejected while actionable todos or a stage error remain; a review stage is required by default. These checks do not prove code correctness. Confidence and choice probability are separate gates, neither a guarantee of correctness.

`maxSteps` defaults to 8, counting the initial plan; the accepted range is 1–9 to respect OMP's eight advisory stop continuations. There is no hidden unbounded retry loop. Any other extension can still affect OMP's execution; this controller is not isolation from other extensions.

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

Classifier state includes the goal, bounded visible conversation/tool output, todos and controller metadata. Hidden reasoning and images are excluded from the orchestrator state. Redaction reuses the existing best-effort key/token rules; it is not comprehensive secret detection. Do not send repositories or data to TypeSafe without authorization.

## Verification

```sh
bun install --frozen-lockfile
bun run check
bun test
```

New tests exercise routing budgets and thresholds, failure escalation, mandatory review, cancellation/startup races, model restoration, compact/redacted state, XDG precedence, migration, project overlays, editor argument handling and invalid-draft recovery. Controller tests mock the provider and OMP host while using the real Jev client validator; they do not measure live Jev routing quality or real-model implementation quality.

For a live smoke test, use a disposable repository and authenticated model roles: run `/jev test`, `/jev plan` for a small change, inspect the plan, then `/jev run`. Check the displayed stage/model transitions, cancel a run, verify restoration with `/jev status` and `/model`, and run your project tests independently.
