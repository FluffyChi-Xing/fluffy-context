# Paired Agent Task Evaluation

`ctx evaluation report --input measurements.json` reads a supplied JSON file and
produces a read-only paired report. It does not run agents or invent control
measurements.

The five fixed task categories are `resume`, `repeated-error`,
`cross-file-change`, `branch-switch`, and `conflicting-knowledge`. For each
included task, provide exactly one `control` run without fluffy-context and
one `context` run with it. Both must use the same repository commit, model,
and acceptance test ID. Use an isolated checkout for each run.

```json
{
  "schemaVersion": 1,
  "runs": [
    {
      "task": "resume",
      "variant": "control",
      "repositoryCommit": "COMMIT_SHA",
      "model": "MODEL_ID",
      "acceptanceId": "TEST_ID",
      "success": true,
      "testsPassed": true,
      "durationMs": 0,
      "retries": 0
    },
    {
      "task": "resume",
      "variant": "context",
      "repositoryCommit": "COMMIT_SHA",
      "model": "MODEL_ID",
      "acceptanceId": "TEST_ID",
      "success": true,
      "testsPassed": true,
      "durationMs": 0,
      "retries": 0,
      "evidenceUsedIds": []
    }
  ]
}
```

Replace the example values with actual observations. `providerInputTokens` and
`providerOutputTokens` are optional integers from the host/provider. A pair
has `providerTokenQuality: unavailable` unless both token fields are supplied
for both runs. Duration and retries are explicit observations, not estimates.
The report shows sample count, missing task categories, correctness
regressions, test outcomes, and paired deltas. A negative duration, retry, or
provider token delta means the context run used less than its control.

Before using the result for a release claim, attach the task prompt, checkout
commit, acceptance command, host version, and raw provider usage to the
experiment artifact. Repeat each task enough times to account for model and
environment variance. One sample per task is a smoke test, not evidence of a
general efficiency gain.
