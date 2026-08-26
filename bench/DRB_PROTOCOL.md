# DeepResearch Bench protocol (anti-contamination)

We tune Pepper's research agent against this benchmark. These rules keep the
published number meaningful.

## The split

`bench/drb-split.json` divides the 50 English tasks deterministically —
`sha256("pepper-drb-<id>") % 2` — so anyone can reproduce it and we cannot
cherry-pick after seeing results.

- **dev (23 tasks)** — iterate freely: run, read outputs, diagnose, repeat.
- **holdout (27 tasks)** — scored only to report a result, never read while
  tuning. A holdout score is the number we publish.

## What we optimize

**Fair game — capability that happens to score:**
- Pipeline improvements (reading source pages, broader search, synthesis
  passes, citation binding). RACE's four dimensions are published by the
  benchmark; building an agent that is genuinely more comprehensive,
  insightful, instruction-following, and readable is the intended response to
  a published rubric.
- Training data authored from *disjoint* topics, following the report format.

**Off limits — contamination:**
- Training on DRB task prompts, their reference reports, or the criteria file.
- Per-task prompt tuning, or any branch keyed to a benchmark task.
- Reading holdout outputs while iterating.
- Judge-specific gaming (writing to please one judge model's quirks).

## Reporting

Every published score names: which split, which judge, which agent version,
and the date. Scores from different splits are never mixed into one number.
Prior runs (2026-08-23/24) predate this protocol and used all 50 EN tasks;
they are labeled `en50-preprotocol` in the results table.
