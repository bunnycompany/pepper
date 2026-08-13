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

## First results (2026-08-13, 12 bundles, grounding metric v0)

| Model | Grounding | Notes |
|---|---|---|
| Qwen2.5-7B-Instruct-4bit (base) | 64.5% | attributes adequately, generic register |
| pepper-7b-4bit (persona LoRA, unspecialized) | 38.1% | strong persona, invents entities under desk pressure |

The gap is the whole thesis: persona tuning without specialist grounding data
makes truthfulness *worse*. The specialist build (`pepper-desk`) must beat
the base model's grounding while keeping her voice — that is the release
gate for any model we ship.

## Run it

```sh
python3 bench/score_grounding.py bench/bundles/bundles.json <your-outputs.json>
```

Outputs file format: `{"model": "...", "results": [{"id": "<bundle-id>", "output": "..."}]}`.

## License

AGPL-3.0-only, like the desk it came from. MNN — all your models, all the time.
