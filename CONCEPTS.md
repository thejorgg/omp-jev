# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Helper evaluation and discovery

### Benchmark fitting

Refining a Jev helper against frozen, independently checked cases while measuring answer quality, caller-visible evidence, and latency.

Results describe the evaluated cases; fitting them does not establish performance on unseen tasks.

### Jev decision

A structured judgment over supplied state and explicit alternatives or criteria, used to select an action or assess evidence rather than generate a plan or implementation.

### Discovery task

A request to locate repository evidence for one described behavior through bounded, read-only investigation.

A resolved outcome reports accepted evidence within the search's limits, not exhaustive coverage or proof of implementation ownership. Escalation preserves available evidence and leaves unattempted work for the caller; it does not itself launch another model.

### Source block

A file-and-line-anchored excerpt retained as evidence for a discovery task, rather than merely a candidate filename.

Source awaiting a relevance judgment is provisional. An interrupted search may retain it without claiming that the task resolved; accepted relevance still does not prove implementation ownership.

### Caller-visible report

The result text delivered to the model invoking a helper, distinct from internal decision inputs and retained tool metadata.
