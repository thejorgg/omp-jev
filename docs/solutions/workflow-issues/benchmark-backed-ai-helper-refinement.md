---
title: "Benchmark-backed refinement of Jev helpers"
date: "2026-09-18"
category: "workflow-issues"
module: "Jev discovery"
problem_type: "workflow_issue"
component: "development_workflow"
severity: "medium"
applies_when:
  - "Refining an AI helper's decisions, evidence selection, or caller-visible output"
  - "Comparing prompt or search strategies against source-checked reference answers"
  - "Transferring the discovery evaluation workflow to planning and parallel AI callers"
tags:
  - "benchmark-fitting"
  - "evaluation"
  - "jev-dispatch"
  - "jev-plan"
  - "planning"
  - "active-model"
  - "parallel-calls"
  - "context-budget"
---

# Benchmark-backed refinement of Jev helpers

## Context

The 2026-09-17 discovery experiment compared a Jev helper with independently source-checked reference answers from a larger model. The original helper often found related files without reaching the requested source range, while returning a median 50,217.5 characters of result JSON to its caller.

The selected implementation ranks candidates, verifies source windows, and emits a bounded report. The code explains that mechanism; it does not preserve the rejected strategies, corrected baseline, or quality-versus-latency tradeoff. This learning records that evaluation method so it can be reused for `/jev plan`, without claiming that planning has already received the same benchmark or parallel-call support.

## Guidance

1. **Freeze tasks and references before comparing strategies.** Use real repository questions, multiple code shapes, and negative cases. Generate reference answers independently of the candidate strategy, then check them against source; a larger model's answer is not ground truth by itself. Record repository state or source hashes. The discovery corpus contained 20 tasks across seven repositories: 18 positive and two absent-feature cases. All 21 reference files were unchanged at final scoring.

2. **Separate retrieval, answer quality, and abstention.** Discovery used three measures: a reference file among the first three unique returned files; emitted source overlapping a reference range; and no invented answer on absent-feature cases. A file hit is not an implementation hit. An incomplete bounded search is not proof that a feature is absent. For planning, use an outcome-based rubric rather than textual agreement with a reference plan or a preferred number of steps; equivalent valid plans must remain acceptable.

3. **Measure the actual caller-visible report.** Keep internal decision input, selected evidence, model-facing content, UI presentation, and diagnostic metadata separate. The baseline's raw evidence recovered one answer missing from its structured findings: the fair source-range baseline was **7/18**, not 6/18. Prototype character counts covered selected blocks only and cannot be compared with complete reports. In the current tool, formatted text goes into `content`, while the full result stays in `details` (`src/extension.ts:742-745`). The report has a hard character bound (`src/discovery-output.ts:35`, `src/discovery-output.ts:466-470`).

4. **Compare strategies without changing the cases or hiding failures.** Keep losing variants and their failure modes. Forced file choice improved file hits but answered both absent-feature cases incorrectly. File selection followed by source verification retained useful file ranking without forcing a final answer. Count failed runs as misses, and identify missing timing or size measurements instead of treating them as zero-cost successes. Do not add repository-specific exceptions merely to pass a fixture.

5. **Integrate, then rerun the production path.** Prototype success is not proof of the shipped formatter, budgets, pagination, cancellation, or caller experience. The integrated path publishes pending source before relevance verification and retains bounded partial evidence if interrupted (`src/dispatcher.ts:718-738`, `src/dispatcher.ts:766-802`). A failed location search cannot resolve merely because earlier evidence passed a threshold (`src/dispatcher.ts:995-1017`). Verify these boundary cases and the actual command/tool surface, not just the ranking helper.

6. **Report tradeoffs and residual misses.** The integrated run reduced median model-facing text by 91.9%, but median discovery latency increased from 750 to 1,680 ms. A correctly escalated partial answer and a confidently wrong completion are different outcomes. Preserve that distinction rather than presenting one aggregate accuracy number.

7. **Separate fitting from generalization.** The discovery cases were frozen but used during refinement. No held-out study was performed. For a new planning benchmark, reserve unseen tasks, include relevant model/settings variants, and evaluate after tuning. Reuse the measurement discipline, not discovery-specific thresholds or output budgets.

## Why This Matters

Optimizing a convenient intermediate metric can reward the wrong system: forcing a file choice raises file recall while destroying abstention; shrinking selected blocks does not prove the caller receives less context; accepting a related caller does not identify the implementation owner. Independent references, comparable output measurements, and explicit failure accounting make these tradeoffs visible.

The useful result of benchmark fitting is a measured operating point with known limits, not a claim that the helper matches a larger model generally.

## When to Apply

- Changing Jev helper prompts, ranking, decision policies, budgets, or output shaping.
- Evaluating whether an AI caller can use a helper's answer without another broad search.
- Adapting the workflow to planning, including the requested parallel-call and current-active-model modes.

## Examples

### Discovery strategy comparison

These are historical results from the same 20-case development corpus, not predictions for other repositories.

| Strategy | Reference file in top three /18 | Reference range /18 | Safe absent cases /2 | Run errors |
|---|---:|---:|---:|---:|
| Original dispatcher | 8 | 7* | 2 | 0 |
| Broad relevance | 15 | 11 | 2 | 0 |
| Block-only verification | 5 | 5 | 2 | 0 |
| Directory lanes | 15 | 10 | 1 | 0 |
| Forced file choice | 16 | 10 | 0 | 0 |
| Routed prototype | 11 | 10 | 2 | 2 |
| File selection followed by scanning | 16 | 15 | 2 | 1 |
| Integrated implementation | 17 | 16 | 2 | 0 |
| Source-checked Astra reference | 18 | 18 | 2 | — |

*The baseline had six structured range hits plus one in raw retained evidence: the Relace authentication-header case. Final integrated range scoring checked source actually emitted in the caller-facing report, not merely internal location metadata.*

The routed prototype failed on singleton Choice options; the file-scan prototype encountered a probability-sum tolerance boundary. Error rows remained misses. Timing/size medians excluded unmeasured error rows. Astra ran per-repository reference batches, so its per-task latency and model-facing payload were not comparable measurements.

The final integrated report had a median 4,078 characters, maximum 11,932, and median latency 1,680 ms. Both production runs recovered 16/18 reference ranges. Verification recorded 168 passing tests, a passing TypeScript check, and actual OMP terminal checks for compact output, source expansion, cancellation, and wide/narrow layouts.

Two external benchmark cases remained unresolved:

- **Aura Farm inventory saving:** the correct service appeared, but the decision budget expired before the reference save/update path. The result correctly escalated with partial evidence.
- **ClashedAces matchmaking:** a UI caller was returned instead of the queue-owning implementation, yet the result reported completion. The relevance judgment did not reject that caller; acceptance thresholds are not proof of implementation ownership.

The measurements and caveats above are retained here so the learning does not depend on temporary benchmark files surviving.

### Transfer to planning: requested, not yet verified

**North star (user requirement):** planning quality comparable to directly using `pi --model 'openai-codex/gpt-6-astra'`. Compare the helper against that direct-Astra baseline on the same goals and authorized repository context. Correctness, grounding, dependency order, and verification coverage come before smaller output, lower latency, or parallel throughput; similar wording is not the target.

Keep that reference model explicit in the experiment and independently check its plans. This is a quality target for the next planning benchmark, not a measured planning result from the discovery experiment, and not a reason to silently override the caller's model in the requested current-active-model mode.

The user wants larger-model AIs to invoke planning in parallel and a mode that uses the caller's current active model. This is a new validation target, not a description of existing concurrency support.

`/jev plan` already starts a planning-only orchestrator run (`src/extension.ts:852-858`). It refuses to start while the session has active or pending work (`src/orchestrator.ts:245-255`), resolves configured role selectors (`src/orchestrator.ts:279-286`), and changes the shared session model for a stage (`src/orchestrator.ts:124-132`). The default planner selector is `@slow` (`src/orchestration.ts:47-53`), not a per-call inheritance policy for the caller's active model. Planning-only completion stops before automatic implementation (`src/orchestrator.ts:390-393`); the planner prompt is an instruction, not a sandbox (`src/orchestration.ts:54-55`, `README.md:82`). Do not assume wrapping this session-owning command makes it a concurrent tool.

Apply the workflow to these **proposed benchmark axes** before claiming the requested behavior:

| Axis | Evidence the planning benchmark should require |
|---|---|
| Plan quality | Source-supported work, necessary dependencies, verification/acceptance coverage, and correct clarification or refusal when information or authorization is missing; allow equivalent valid plans. |
| AI-callable surface | Exercise the intended structured tool entry point as well as the command; measure the complete caller-visible result, not only extracted plan steps. |
| Parallel callers | Independent requests do not mix goals, evidence, results, or budgets; cancelling one does not cancel or corrupt another. |
| Current active model | Record model identity at invocation; verify the requested mode uses that identity rather than a hard-coded model or unrelated role selector. Include overlapping calls around a model change. |
| Session ownership | Planning does not unexpectedly change the caller's model, overwrite a later user selection, or start implementation. Do not equate a planning prompt with enforced read-only permissions. |
| Generalization and cost | Evaluate unseen tasks and relevant model settings; report correctness, failure/abstention, complete payload size, and latency separately. |

These axes preserve the requested intent without prescribing an untested API or claiming a planning implementation was delivered by this documentation run.

## Related

- [Discovery behavior and caller-facing output](../../../README.md#read-only-dispatcher-jev_dispatch)
- [Existing planning and orchestration workflow](../../../README.md#run-the-orchestrator)
- [Project vocabulary](../../../CONCEPTS.md)
