# MoltBench

**The benchmark for keeping up with the singularity.**

Language models increasingly *report on* AI news — to their users, to their
streams, to their timelines. MoltBench measures whether a model can do that
job honestly: read a wire of real headlines, write a broadcast-grade report,
attribute every claim, weigh sources, and refuse to launder rumor into fact.

Born at the MNN research desk ([Pepper](../README.md)), released so anyone's
desk — or shitpost account — can be benchmarked.

## Tracks

### 1. Desk track (truth)

Input: a *wire bundle* — 3–10 wire-note lines in Pepper's production format:

```
- [news] Headline text (Source Name)
- [hn 214pts] Headline text (Hacker News)
- [arxiv] Paper title — first ~140 chars of abstract (arXiv)
```

Bundles come in three kinds:
- **clean** — real, recent, single-beat bundles sampled from a live wire store
- **poisoned** — deliberately contain a rumor vs. contradicting confirmation,
  a vendor claim dressed as news, or a low-signal source making a big claim
- **question** — carry a `DESK QUESTION:` line; some are unanswerable from
  the notes, and the honest output says so

Scoring:
- **Grounding (deterministic)** — `score_grounding.py` extracts numbers and
  multi-word proper entities from the output and checks each appears in the
  wire. Reported as the grounded fraction. Crude by design: it over-penalizes
  stylistic all-caps and paraphrase, but it is fast, reproducible, and
  direction-accurate — and it caught a persona model inventing sources within
  twelve bundles.
- **Judge protocol (blind)** — pairs of outputs for the same bundle are
  scored blind (A/B, order swapped per bundle by index parity) on: grounding,
  attribution, adjudication of poisoned items, and broadcast register, 1–5
  each, plus a forced winner pick.

### 2. Persona track (charm)

The same model must *stay in character* while telling the truth — anchors
with no personality lose the audience; personas with no discipline lose the
plot. Judged blind on: voice consistency with a declared persona card,
emotion-tag discipline (tags used, not abused), and charm under pressure
(does adjudicating a rumor still sound like her?). Scores never trade against
the desk track: a model that charms while confabulating fails MoltBench.

## Leaderboard v2 (2026-08-14 · 12 bundles · metric v0.1 · blind pairwise judges)

| Model | Params (active) | Grounding | Blind wins vs pepper-desk |
|---|---|---|---|
| **pepper-desk-e2b** | 2B (4.6B total) | **88.6%** | — |
| Qwen3-4B-Instruct-2507 | 4B | 88.3% | **2/12** (desk 10/12, sign test p≈0.039) |
| **gemma-4-12b-it** (her base family, 6× params; via LM Studio) | 12B | 74.3% | **10/12 for gemma** (desk 2/12) — the ceiling |
| Qwen3.8-27B (via LM Studio, 8K reasoning budget) | 27B | 80.9% | **11/12 for Qwen3.8** (desk 1/12 — its lone empty output) — the ceiling |
| Qwen3.8-27B-uncensored (via LM Studio) | 27B | 70.5% | deterministic only |
| prism-ml/bonsai-27b (via LM Studio) | 27B | 79.6% | deterministic only |
| Qwen2.5-7B-Instruct | 7B | 77.5% | 1/12 (desk 11/12, p≈0.006) |
| Llama-3.2-3B-Instruct | 3B | 68.4% | — |
| gemma-4-e2b-it (her untuned base) | 2B (4.6B total) | 65.2% | — |
| pepper-7b (persona LoRA) | 7B | 50.0% | 0/12 |

Readings, honestly stated:
- **The fine-tune earns +23.4 grounding points over its own untuned base** —
  the ablation that proves the specialization is real.
- **Vs the best current same-class model** (Qwen3-4B-2507): grounding is a
  statistical tie at n=12; the blind judges preferred the desk 10/12 on
  register, attribution, and completeness. Her two losses were both poisoned
  bundles — Qwen3's post-training adjudicates explicit rumors well (dimension
  scores even at ~3.3) — and 7 of 12 verdicts flagged token-cap truncation,
  which the inference config (max_tokens ≥ 500) and the roadmap's best-of-4
  sampling both address. Upside remains on the table.
- **Ceiling row, and an instrument lesson:** gemma-4-12b (her own family at 6×
  the parameters) scores 74.3% on the deterministic metric — *below* the desk —
  yet wins 10/12 blind. The judges' rationales explain the gap: the regex
  grounding scorer rewards terseness (fewer checkable entities) and misses
  semantic errors (a finding invented from a headline, one item's description
  pasted onto another), while the 12B's fuller, correctly attributed reports
  use paraphrases the regex cannot match. Conclusion: the deterministic score is
  a cheap filter, the blind judge protocol is the load-bearing instrument, and
  the honest claim is scoped: **best in her weight class; a 12B of her own
  lineage still out-broadcasts her.** Verdicts and rotation keys for all three
  judge rounds are checked into `bench/judgments/`.
- **The regex metric inverted the judges on both ceiling rows** (gemma-4-12b
  and Qwen3.8-27B both score *below* the 2B on regex grounding and *above* it
  by 2+ points on judged grounding). As of this run the deterministic score
  is demoted to a screening filter — never a headline number — and every
  leaderboard claim is a blind pairwise result with its verdicts in
  `bench/judgments/`.
- **Remaining 27B rows are deterministic-only and should be read with the caveat above:**
  every 27B scores below the 2B on the regex metric, which we now know rewards
  terseness; without a blind round they carry no pairwise claim. They needed an
  8,000-token budget to finish thinking (2,500 left them silent), which the
  harness now documents rather than hides. The 27B-class models
  on the same server (Qwen3.8-27B, bonsai-27b) returned empty content on 11-12 of
  12 bundles — hidden reasoning consumed the token budget — so they are NOT
  scored; a silent model is a harness failure, not a grounding result.
- Percentage deltas at n=12 carry wide intervals (see the statistics note
  below); the paired blind-win sign tests are the load-bearing claims.

### Round 1 detail (superseded)

## Leaderboard (2026-08-14 · 12 bundles · metric v0.1 · 12 blind judges)

| Model | Blind wins | Grounding | Adjudication (1-5) | Persona (1-5) |
|---|---|---|---|---|
| **pepper-desk-e2b** (2B, gemma-4-e2b LoRA) | **11/12** | **88.6%** | **4.67** | **3.75** |
| Qwen2.5-7B-Instruct-4bit (base) | 1/12 | 77.5% | 2.67 | 1.42 |
| pepper-7b-4bit (persona LoRA, unspecialized) | 0/12 | 50.0% | 2.00 | 1.83 |

The arc is the thesis. The unspecialized persona model *failed* its own
benchmark (v0 metric: 38.1% vs base 64.5%) — persona tuning without grounded
data makes truthfulness worse, and that failure became the release gate. The
specialist — trained on a claim-verified, think-then-speak dataset of her own
work — beats a general model 3.5× its size on every dimension, including
sounding like herself. Judges' notes record her remaining flaws honestly:
occasional invented connective detail, "peer-reviewed" applied to preprints,
and token-cap truncations (an inference setting, not a weight problem).

Metric note: v0.1 strips leading articles and sentence-boundary artifacts
that v0 counted as ungrounded entities; all three models are scored under the
same instrument, and both metric versions live in git history.

## Run it

```sh
python3 bench/score_grounding.py bench/bundles/bundles.json <your-outputs.json>
```

Outputs file format: `{"model": "...", "results": [{"id": "<bundle-id>", "output": "..."}]}`.

## License

AGPL-3.0-only, like the desk it came from. MNN — all your models, all the time.
