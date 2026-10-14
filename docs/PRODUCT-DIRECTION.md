# Product Direction: The Verifiable Project Cognition Layer

## Product goal

`fluffy-context` should become the agent-neutral cognition layer for large,
multi-agent repositories. It preserves work across sessions and branches,
turns useful discoveries and failed approaches into scoped project knowledge,
and delivers only a bounded, evidence-backed context package when an agent
needs it.

The product is not a transcript archive and is not a replacement for a code
index. Its durable unit is a claim with provenance, applicability, lifecycle
state, and a path to verification. The system must make it cheaper for a new
agent to become correct without making unverified memory look authoritative.

## Differentiation

The comparison below is based on the public CodeGraph README and the current
`fluffy-context` implementation.

| Dimension | CodeGraph | fluffy-context | Strategic decision |
| --- | --- | --- | --- |
| Primary object | Code symbols, imports, call graph, embeddings | Work state, evidence, knowledge, deadends, notes, host activity | Own the project cognition ledger; integrate with code indexes rather than reimplement them |
| Main question | “What code is related to this symbol or change?” | “What does this project already know, what failed, and what is safe to reuse on this task?” | Return a task-scoped evidence package with explicit confidence and omissions |
| Time model | Persistent index with incremental code reindexing | Append-only, hash-linked lifecycle events across sessions and branches | Preserve history and explain why a claim is current, retired, or awaiting review |
| Agent model | MCP/IDE integrations plus agent rules | CLI, MCP, hooks, project guidance, and a stable agent API | Keep the protocol independent from any one model or editor |
| Memory quality | Project memories and semantic search | Candidate → verified → deprecated/rejected records tied to source changes and tests | Make verification and source freshness first-class |
| Failure knowledge | Debug memories can be stored | Structured deadends include attempt, reason, evidence, scope, and applicability | Treat failed approaches as reusable engineering evidence |
| Measurement | Tool/index telemetry | Operation, host interface, trigger, reuse, evidence adoption, and paired task outcomes | Measure agent workflow quality, not only index/query latency |
| Noise boundary | Exclusion rules protect the index | Import boundaries, privacy redaction, worktree/nested-repository filtering, bounded admission | Make “垃圾文件” and stale branch material observable and non-authoritative |

### Defensible wedge

CodeGraph can answer structural questions very well. `fluffy-context` should
answer the continuity and trust questions around those results:

1. What was the last verified state of this task on this branch?
2. Which previous attempts failed, for what reproducible reason, and under what
   scope?
3. Which evidence changed since it was last reviewed?
4. Did the host actually trigger and deliver the context, and did the task
   outcome improve?

The integration boundary is deliberate: a future adapter may attach CodeGraph
symbols, callers, or impact results as evidence references. It must not import
the entire graph into the cognition journal or silently promote search results
to verified knowledge.

## Agent development effectiveness

Yes, an agent-focused effectiveness layer belongs in this project, with strict
measurement boundaries. The first version should record workflow facts rather
than infer productivity claims:

- host/interface and trigger: CLI, MCP, agent API, or hook; session and task
  identity; trigger event and whether it was supported by the host;
- delivery: requested, returned, unchanged, delta, replacement, omitted items,
  and output budget;
- adoption: evidence IDs referenced by a later checkpoint, note, decision, or
  test result;
- outcome: task completion, test result, retry/deadend count, and elapsed time
  when explicitly recorded;
- cost: provider input/output tokens when available, otherwise clearly marked
  estimates; never present character estimates as billing data.

The report must show sample counts and `unavailable` for missing provider or
outcome data. It must not claim token savings, ROI, or agent quality from
retrieval counts alone.

## Beta.8 release objective

Beta.8 is published on the npm beta channel. The October 14 ZCode integration
fixes are committed and planned for beta.10; beta.9 will be skipped. The dated
follow-up priorities and acceptance gates are in `docs/OCTOBER-2026-PLAN.md`.

**Objective:** make host-trigger coverage and context delivery measurable while
keeping the evidence ledger trustworthy and cheap to inspect in large projects.

Beta.8 is successful when a maintainer can run one read-only report and answer:

- which host interfaces actually invoked `fluffy-context`;
- which lifecycle triggers were observed, missing, or unsupported;
- how often delivery was full, delta, replacement, unchanged, or failed;
- how many delivered evidence items were later adopted or verified;
- whether the report is based on measured data, estimates, or unavailable data.

## Beta.8 engineering tasks

### B8.1 Host capability and trigger ledger

Status: implemented in the local development tree; real host coverage remains
to be validated during B8.6.

- Add a versioned capability declaration for each adapter: supported triggers,
  session/task identity, delivery mode, and fallback guidance.
- Record trigger observations separately from operation completion so a host
  that never calls the tool is distinguishable from a tool failure.
- Add CLI/MCP output for capability inspection; keep it read-only.
- Acceptance: synthetic CLI, MCP, agent API, and Claude hook fixtures produce
  deterministic capability and trigger records without recording prompt text.

### B8.2 Delivery telemetry and coverage report

Status: implemented in the local beta.8 tree. Real host coverage remains a
release acceptance item.

- Extend usage reporting with `byInterface`, `byTrigger`, delivery mode, and
  success/error rates while retaining the existing `byOperation` contract.
- Include observed, expected, unsupported, and unknown trigger counts; do not
  turn missing observations into failures when the host has no such event.
- Add an ASCII summary suitable for CI artifacts and a JSON schema version.
- Acceptance: empty journals, old beta journals, and mixed-interface journals
  remain readable; report generation never appends an event.

### B8.3 Incremental journal read index

Status: implemented for sealed segments with explicit rebuild and read-only
report fallback. The authoritative full-chain verification remains separate.

- Add a hash/offset index for journal segments and invalidate it on archive,
  restore, or chain verification failure.
- Keep the append-only journal authoritative; the index is disposable cache.
- Acceptance: repeated reports on a large fixture avoid full rescans, and a
  deleted or corrupted index is rebuilt without data loss.

### B8.4 Fixed-task effectiveness harness

Status: input validation and paired reporting are implemented. Real paired
measurements remain to be collected; see `docs/EFFECTIVENESS.md`.

- Define five paired tasks: resume, repeated error, cross-file change, branch
  switch, and conflicting knowledge.
- Capture task result, test result, evidence adoption, retries, and provider
  usage when supplied by the host.
- Acceptance: the harness reports paired deltas with sample counts and marks
  missing measurements unavailable; it does not fabricate a control baseline.

### B8.5 Large-project noise and privacy gate

Status: the synthetic fixture is implemented and passing locally. Other
operating systems remain in the release matrix.

- Add fixtures for nested repositories, old worktrees, generated files, and
  credential-like text.
- Verify preview is zero-write, candidates retain source fingerprints, and
  rejected/changed material cannot enter verified context automatically.
- Acceptance: the fixture candidate count and excluded paths are stable across
  Windows path separators and repeated scans.

### B8.6 Release validation

Status: beta.8 is published. Installed-package MCP acceptance has a repeatable
script; Zcode/Codex model adoption and macOS/Linux runs remain pending.

- Run the full test suite, package smoke test, and `npm run install:local`.
- Reconnect at least one MCP host after global installation and record actual
  capability/trigger observations in the release checkpoint.
- Keep the report, fixed-task harness, and install receipt reproducible from a
  clean checkout for each subsequent beta.

## Success metrics for the next decision

These are release gates, not promises of user benefit:

- 100% of supported synthetic triggers produce a classified observation;
- 0% of report commands write journal events;
- old beta journals remain readable with no migration required for reporting;
- every effectiveness metric is labelled measured, estimated, derived, or
  unavailable;
- no verified knowledge is created by telemetry or import automatically;
- at least one real host workflow yields a reconnectable capability and trigger
  receipt.
