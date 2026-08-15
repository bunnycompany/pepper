# DESK MODEL ROADMAP
**pepper-desk-e2b program — August 2026**

Strategy in one paragraph: pepper's unfair advantage is a deterministic, per-claim grounding checker that most labs have to approximate with a trained reward model. Every high-leverage move below reuses that one asset in a new role — as an inference-time verifier (best-of-N), a repair signal, a training-data filter (RFT), a preference labeler (DPO), a difficulty estimator (curriculum), and finally a verifiable RL reward (GRPO). The literature says stop buying SFT data (gains saturate near ~1k examples; [arXiv 2506.14681](https://arxiv.org/html/2506.14681v2), [2509.17167](https://arxiv.org/pdf/2509.17167)) and start buying verified compute. One caveat gates everything: the current 11.1-pt desk-vs-base grounding gap is underpowered at n=12 bundles (needs ~61 for 80% power at measured SD=0.309), so MoltBench's instrument upgrades (§3) are not housekeeping — they are the precondition for believing any experiment below moved the needle.

Shared infrastructure note: experiments A1, B1, B2, and C1 all consume the same artifact — a batched best-of-N sampling + scoring script over the 452 prompts. Build it once (A1), reuse it four times.

---

## 1. Ranked experiment queue

### Tier A — Quick wins (one Mac-Studio session each)

**A1. Best-of-4 sampling with the grounding scorer as verifier**
- **Hypothesis:** Selecting the best of 4 sampled ON AIR reports by deterministic grounding score lifts grounding from 88.6% toward the mid-90s with zero training, replicating the small-model + external-verifier result of T1 ([arXiv 2504.04718](https://arxiv.org/abs/2504.04718), 1B beats 8B) and compute-optimal test-time scaling ([arXiv 2408.03314](https://arxiv.org/abs/2408.03314)).
- **Method:** Sample N=4 at T≈0.8 from identical prompts via `mlx_lm` batched generation with cached shared prefix; score each with `bench/score_grounding.py`; emit argmax, tie-break on DESK NOTES/ON AIR structural completeness. If all 4 score below threshold, flag the segment for re-digest instead of airing (free abstention signal).
- **Cost:** 4x decode; with batching (~261 tok/s aggregate over 4 streams on M3 Ultra per rapidmlx.com) and prompt caching, ~8–15s per report vs 3–4s. Script: one afternoon.
- **Expected gain:** Largest single grounding jump available; gains from N>4 plateau quickly ([FineVerify, arXiv 2606.00660](https://arxiv.org/abs/2606.00660): most gains by N=4, plateau 12–16).
- **MoltBench:** Add a `pepper-desk-e2b (bo4)` leaderboard row; same bundles, deterministic metric, paired bootstrap CI vs single-shot row.

**A2. Claim-level cross-sample disagreement as the rumor signal** *(free rider on A1)*
- **Hypothesis:** Claims appearing in 1/4 samples are confabulations; claims in 4/4 are stable — cross-sample disagreement routes claims into the "unconfirmed" register better than single-pass judgment (SelfCheckGPT lineage; consensus of 2026 hallucination surveys, [arXiv 2510.06265](https://arxiv.org/abs/2510.06265)).
- **Method:** Reuse the grounding scorer's claim extractor across the 4 samples from A1; align claims by string/entity overlap; claims below a stability threshold get dropped or tagged unverified in the emitted report.
- **Cost:** Zero extra generation; milliseconds of string processing.
- **Expected gain:** Direct attack on the adjudication axis, pepper's strongest track (4.67 vs 2.67).
- **MoltBench:** Measured by the poisoned-bundle binary rubrics of v2 (§3.4) — "reports contradiction rather than picking the rumor: Y/N".

**A3. Scorer-directed surgical repair pass (no free-form self-critique)**
- **Hypothesis:** Feeding back the *specific failed claims + matching wire lines* with a rewrite-only-flagged-sentences instruction recovers most of the residual 11.4% failures; open-ended self-critique will not (SLMs need external verifiers to self-correct: [OpenReview AbO4lCvlo3](https://openreview.net/pdf?id=AbO4lCvlo3), [arXiv 2406.02378](https://arxiv.org/abs/2406.02378), [2503.08681](https://arxiv.org/abs/2503.08681)).
- **Method:** Conditional second pass triggered only under grounding threshold (~1-in-4 to 1-in-8 reports at current base rate). Prompt = failed claims + relevant wire lines + surgical instruction. Log (draft, feedback, repair) triples — they are STaSC-format training data for a later round.
- **Cost:** +15–30% amortized latency; +4s worst case per triggered report. Half a day of code.
- **Expected gain:** Composes multiplicatively with A1 (repair the best-of-4 winner).
- **MoltBench:** Grounding delta on the repaired-pipeline row; also report trigger rate and repair success rate per bundle.

**A4. Digest-order ablation: measured U-shape policy**
- **Hypothesis:** Instruction-at-end + load-bearing wire items first-and-last beats current ordering; small models at 4–8k show lost-in-the-middle strongly ([SIGIR 2026 reproduction, arXiv 2605.27105](https://arxiv.org/abs/2605.27105)) but effects are model-specific, and pepper can *measure* its own curve.
- **Method:** Permute wire-line order across the val set (3–4 permutations: current, U-shaped, reversed, instruction-at-end-only); score each sweep with the deterministic metric; adopt the winner as the pipeline's fixed ordering policy. Specifically test never burying contested/rumor items mid-context.
- **Cost:** One afternoon; ~452 x 4 short generations. Zero inference latency forever after.
- **Expected gain:** Literature swings run to 30%+ in the worst case; even 1–2 grounding points free is a good afternoon.
- **MoltBench:** It *is* a MoltBench run — per-position grounding scores become a permanent diagnostic plot.

**A5. Statistics + reproducibility patch for the scorer**
- **Hypothesis:** None — this is instrument debt. The 11/12 blind-win headline is already sound (exact sign test p=0.0063); the grounding-percentage comparisons are not (n=12, need ~61 bundles for the 11.1-pt delta).
- **Method:** Add to `score_grounding.py`: per-bundle paired diffs, 10k-resample paired bootstrap 95% CI (topic-clustered per [Anthropic error-bars, arXiv 2411.00640](https://arxiv.org/abs/2411.00640)), exact sign test, Wilson intervals on binaries. Check in the missing pepper-desk-e2b outputs (only `eval-base.json` and `eval-pepper.json` exist in `/Users/dalnk/pepper/bench/bundles/`; the headline 88.6% row is currently non-reproducible). Add a per-row manifest: metric version, model hashes, judge IDs, bundle date-cutoffs. State the n=12 power limitation in the README.
- **Cost:** Hours; ~30 lines of stdlib Python.
- **MoltBench:** This *is* MoltBench. No experiment above gets believed without it.

**A6. Field re-benchmark against the Aug-2026 roster**
- **Hypothesis:** The 11/12 win over Qwen2.5-7B is two generations stale; pepper-desk's real position is vs Nanbeige4.2-3B and II-Search-4B.
- **Method:** Run the §2 Tier-1 roster through MoltBench (wire→report on all bundles, deterministic metric + v2 judge protocol). One evaluation afternoon; ~15GB of quants.
- **Expected gain:** Either a headline ("452-example Mac-trained LoRA beats cluster-trained deep-search specialists on grounded desk work") or a study list.
- **MoltBench:** Full leaderboard refresh with paired CIs from A5.

### Tier B — Medium (a weekend)

**B1. Rejection-sampling distillation (RFT round 1)** — *first training move, do before any DPO/GRPO*
- **Hypothesis:** LoRA-SFT on verifier-filtered self-samples lifts base single-shot grounding several points, closing part of the best-of-4 gap into the policy itself (ReST-EM, STaR lineage; BOND shows best-of-N is distillable; [RFT overview](https://www.emergentmind.com/topics/rejection-sampling-fine-tuning-rft-ad4c417c-416b-40b6-bf9a-4653b83ddcfb), [survey 2505.02391](https://arxiv.org/pdf/2505.02391)).
- **Method:** Overnight sweep: 452 prompts x 8–16 samples (~3.3M tokens, single overnight job at >100 tok/s, faster batched). Keep only samples with 100% grounded claims + structural pass. LoRA-SFT on survivors with existing `mlx_lm.lora` tooling, same scale as the original 800-iter run; mix 5–10% general instruction data as forgetting replay ([arXiv 2501.13669](https://arxiv.org/pdf/2501.13669)); keep rank modest ([LoRA Learns Less and Forgets Less, arXiv 2405.09673](https://arxiv.org/abs/2405.09673)). Iterate 2–3 rounds if round 1 moves the metric. Log per-prompt pass rates — these are the difficulty bins for C1.
- **Cost:** Overnight sweep + hours of LoRA. Zero new training code; one sampling+scoring script (shared with A1).
- **Expected gain:** The cheapest evidence-per-dollar training step available; also produces B2's pairs and C1's curriculum for free.
- **MoltBench:** New leaderboard row; paired CI vs current checkpoint; probe the deep-research sub-tasks (decomposition, digesting) after the round for forgetting.

**B2. DPO/ORPO on grounding-ranked pairs (mlx-lm-lora)**
- **Hypothesis:** Preference tuning on (high-grounding, low-grounding) pairs cuts factual errors substantially — FactTune's automated-factuality DPO cut errors ~58% ([arXiv 2311.08401](https://www.emergentmind.com/papers/2311.08401)), and DPO's faithfulness gains are *largest below 3B* ([TrueBrief, arXiv 2601.04212](https://arxiv.org/pdf/2601.04212)) — directly favorable for a 2B specialist.
- **Method:** chosen = top grounding score from the B1 sweep, rejected = bottom score (optionally add blind-judge losers). Train with [mlx-lm-lora](https://github.com/Goekdeniz-Guelmez/mlx-lm-lora) (`--train-mode dpo --beta 0.1`); ORPO if the reference model pinches memory (it won't at 2B on unified memory). Pin the package version and validate the loss implementation on a toy run first — single-maintainer project.
- **Cost:** Pair construction is free (shared sweep); training hours on the M3 Ultra.
- **Expected gain:** The evidence-backed sweet spot for 2B factuality; no judge in the loop, so no reward hacking surface.
- **MoltBench:** Grounding + attribution axes with paired CIs; watch the style-controlled win rate (§3.5) to confirm gains aren't persona drift.

**B3. MoltBench v2 instrument build** — full list in §3; budget one weekend (NLI metric + attribution scorer + binary rubrics + bundle growth to ~50). Sequence it before or parallel with B1/B2 so training results land on the upgraded instrument.

**B4. Targeted hard-case data to ~800, then stop**
- **Hypothesis:** The steep part of the SFT curve is spent (gains concentrate in first ~300 examples, plateau near ~1k; [arXiv 2509.17167](https://arxiv.org/pdf/2509.17167), [LIMIT 2311.13133](https://arxiv.org/pdf/2311.13133)); remaining SFT value is coverage of observed failure modes only.
- **Method:** Mine MoltBench failure reports + B1 low-pass-rate prompts for failure taxonomy (conflicting wires, rumor adjudication, sparse wires, unanswerable questions); author ~300–350 claim-verified examples in exactly those modes; fold into the next LoRA round with replay mix.
- **Cost:** Curation time — the budget cap is the point. Do not exceed ~1k total.
- **MoltBench:** Per-failure-mode pass rates on the stratified v2 bundle set (§3.8).

**B5. Deep-research pipeline restructure: extract-then-compose + capped templated loop**
- **Hypothesis:** A 2B writes best from its trained input distribution; converting swept pages into wire-notes-format atomic claims before composition improves grounding and shrinks context (RECOMP, [arXiv 2310.04408](https://arxiv.org/abs/2310.04408): 6% compression, minimal loss; separated extraction beats fused passes, [arXiv 2606.08605](https://arxiv.org/abs/2606.08605)).
- **Method:** (1) Decomposition via constrained JSON (Outlines on mlx-lm — appropriate here, it's extraction not prose): 3–5 templated angles from a fixed enum. (2) Hard 2-iteration retrieval cap — 2 rounds capture 95% of 5-round gains ([arXiv 2606.21553](https://arxiv.org/abs/2606.21553), local-7B ablation); round 2 fires only on deterministically-thin retrieval, never model judgment. (3) Scripted RRF fusion — fixed hybrid beat adaptive routing in the same ablation. (4) Extractive claim pass per source into labeled markdown key-value wire-notes format (markdown beats JSON as reasoning input: [arXiv 2506.05182](https://arxiv.org/abs/2506.05182); distribution-match with the 452 training examples dominates everything). (5) LoRA writes ON AIR from the extracts.
- **Cost:** A weekend of pipeline code; +1–3s per source at inference, usually recouped in prefill savings.
- **MoltBench:** Measured externally via B6, plus the v2 attribution scorer per fetched source.

**B6. FRAMES external anchor**
- **Hypothesis:** MoltBench is self-referential; the deep-research product claim needs an external number, and a grounding-specialized local model can land inside the published frontier-agent citation-accuracy band (78–94%; best-system citation quality only ~65% under DRACO — beatable).
- **Method:** Fixed 50–100-question FRAMES sample (824 multi-hop Wikipedia questions) through the B5 pipeline; report accuracy plus FACT-style effective-citations + citation-accuracy ([DeepResearch Bench, arXiv 2506.11763](https://arxiv.org/abs/2506.11763)). Offline-scoreable, Wikipedia-grounded, free.
- **Cost:** Hours on-device plus a scoring script.
- **MoltBench:** Becomes the standing external-anchor section of the leaderboard.

**B7. Base migration: gemma-4-E4B-it**
- **Hypothesis:** Same recipe on E4B (~2x effective capacity, same family, post-trained explicitly for in-context attribution and hedging per [Gemma 4 TR, arXiv 2607.02770](https://arxiv.org/html/2607.02770v1) Sec. 3) beats the E2B checkpoint at still-Mac-trainable cost.
- **Method:** Rerun the (by now RFT-augmented) SFT recipe on `google/gemma-4-E4B-it` via a PLE-safe quant only (`mlx-community/gemma-4-e4b-it-OptiQ-4bit` — naive 4-bit quants break PLE layers, see mlx-community/gemma-4-e2b-4bit discussion #1). First benchmark *raw* E2B-it and E4B-it on the grounding metric to isolate exactly what the LoRA adds over Google's own attribution post-training.
- **Cost:** ~3–4GB at 4-bit; LoRA run comparable to the original 800-iter budget. A weekend including evals.
- **MoltBench:** Three-way row: raw E4B-it vs desk-E2B vs desk-E4B, paired CIs.

### Tier C — Ambitious (RLVR-class)

**C1. GRPO with the grounding checker as per-claim verifiable reward**
- **Hypothesis:** Online GRPO on top of the B1/B2 foundation adds Trust-Score-class gains (7–11.5 pts on 4–8B in [Ground-GRPO, arXiv 2506.15522](https://arxiv.org/html/2506.15522)); pepper meets both published preconditions the paper warns about — an SFT foundation (SFT-then-GRPO beats GRPO-alone by 7.5–23%; the 4B *degraded* without one) and a per-claim (process-level) reward, which beats outcome-only by ~10 pts at sub-1B scale ([arXiv 2607.02869](https://arxiv.org/html/2607.02869v1)).
- **Method:** mlx-lm-lora `--train-mode grpo --group-size 4`, custom rewards via `@register_reward_function`: dominant per-claim grounding weight + source-attribution correctness + rumor-adjudication correctness + small format term + length/coverage floor (anti-reward-hacking: block terse wire-restating). Train only on intermediate-difficulty prompts from B1's pass-rate bins — 0 < pass-rate < 1, nonzero reward variance ([VCRL](https://openreview.net/forum?id=FBhWTuMTYA); [arXiv 2506.05316](https://arxiv.org/pdf/2506.05316)); Ground-GRPO's staged curriculum added +6.8%. ~200 steps, ~900-token rollouts ≈ 3M generated tokens; rollouts dominate wall-clock (60–80%; small groups give 4–6x speedups per [2605.17570](https://arxiv.org/pdf/2605.17570)). Validate the GRPO loss on a toy run first.
- **Cost:** A weekend on the M3 Ultra; the expensive option but Mac-feasible at 2B.
- **Expected gain:** The ceiling raise after SFT-side methods saturate; also drifts less than SFT (on-policy), protecting the deep-research sub-tasks.
- **MoltBench:** Full v2 battery with special attention to DESK NOTES quality — only ON AIR is deterministically checked, so DESK NOTES degradation is the failure mode to watch via judge axes + binary rubrics.

**C2. Pleias-style synthetic retrieval-emulation data**
- **Hypothesis:** Mid-training-scale synthetic data emulating retrieval (the [Pleias-RAG recipe, arXiv 2504.18225](https://arxiv.org/abs/2504.18225) — quote-native grounding at 350M–1B) grows desk competence into the thousands-of-examples regime without hand claim-verification, because the deterministic checker filters the synthetic set.
- **Method:** Generate synthetic wire bundles from the live wire store + permutations (source swaps, injected contradictions, planted rumors); sample desk outputs; keep checker-passing examples (SimpleDeepSearcher-style trajectory synthesis, SFT-only — fits Mac budget where full RL environments don't).
- **Cost:** Inference-only generation over days of idle time; one LoRA round to consume it.
- **MoltBench:** Same battery; the interesting readout is whether synthetic scale beats B4's hand-curated hard cases.

**C3. AFM adapter port (demo only, explicitly not the main line)**
- **Hypothesis:** The desk recipe runs as an Apple Foundation Models rank-32 adapter (452 JSONL pairs is inside Apple's 100–1,000 band; M3 Ultra exceeds requirements; ~15 wire lines plausibly fits the ~4K window) — a "pepper desk inside a native iOS app" demo.
- **Method:** Apple Adapter Training Toolkit ([arXiv 2507.13575](https://arxiv.org/abs/2507.13575)); AFMTrainer GUI. Accept up front: entitlement gating, no open redistribution of the adapter, retrain-per-OS-update treadmill — which is why MLX+Gemma stays primary.
- **Cost:** A weekend; free on existing hardware; the entitlement application is the real cost.
- **MoltBench:** Run the bundle set through the adapter via the FoundationModels API; report as an off-leaderboard demo row.

---

## 2. Benchmark roster additions (HF ids)

Retire **Qwen2.5-7B** as the headline comparison — two generations stale.

**Tier 1 — same-class rivals, MLX-ready (the new headline field):**

| Model | HF id | Why |
|---|---|---|
| Nanbeige4.2-3B | `Nanbeige/Nanbeige4.2-3B` (run via `mlx-community/Nanbeige4.2-3B-OptiQ-4bit`) | Strongest general small at deep-search (xBench-DS 75 vs Qwen3-4B's 34 for 4.1; looped transformer; [arXiv 2607.22083](https://arxiv.org/abs/2607.22083)). Beating it = headline result. |
| II-Search-4B | `Intelligent-Internet/II-Search-4B` | Closest published recipe to pepper's task shape (search→weigh→report); official MLX quant; SimpleQA 91.8, Frames 67.5. |
| Agents-A1-4B | `InternScience/Agents-A1-4B` | Long-horizon agent control for the deep-research pipeline (GAIA 95.1, BrowseComp 66.8); mlx-community builds exist. |
| Qwen3.5-4B | `Qwen/Qwen3.5-4B` | The new default generalist rival; replaces Qwen2.5-7B as blind-judge opponent. **Verify mlx-lm supports its Gated DeltaNet layers first.** |
| Qwen3.5-2B | `Qwen/Qwen3.5-2B` | The fairest same-class (2B) opponent. Same MLX caveat. |

**Tier 2 — in-family + controls:**

| Model | HF id | Why |
|---|---|---|
| Gemma 4 E4B-it | `google/gemma-4-E4B-it` (PLE-safe quant only) | Next base candidate (B7); measures what capacity buys in-family. |
| Gemma 4 E2B-it (raw) | `google/gemma-4-E2B-it` | Ablation control: isolates the LoRA's contribution over Google's own attribution post-training. |
| SmolLM3-3B | `HuggingFaceTB/SmolLM3-3B` | Fully-open transparent-recipe control; also the Apache-end-to-end base candidate if the Gemma license ever chafes. |
| Pleias-RAG-1B | `PleIAs/Pleias-RAG-1B` | Citation-native cousin; stress-tests the grounding metric at half pepper's size. Check for a 2026 refresh before roster lock. |

**Tier 3 — conditional:**

| Model | HF id | Condition |
|---|---|---|
| LiteResearcher-4B | `simplex-ai-inc/LiteResearcher-4B` | Only if weights are actually live ([arXiv 2604.17931](https://arxiv.org/html/2604.17931v1)). |
| Nemotron 3 Nano | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` | Only if mlx-lm runs the Mamba-hybrid; ~16–20GB. "Desk-class active compute at 10x memory" ceiling row. |
| Gemma 4 26B-A4B | `google/gemma-4-26B-A4B-it` | In-family ceiling at desk-class active params. |

Completeness-only rows (low priority): `microsoft/Phi-4-mini-instruct`, `meta-llama/Llama-3.2-3B-Instruct`. Tier 1+2 totals ~15GB of quants; one evaluation afternoon.

---

## 3. MoltBench v2 upgrade list

1. **Claim-level NLI entailment as the headline metric** (`score_entailment.py`): sentence-split ON AIR, entail each claim against the wire bundle with **MiniCheck-FT5 (770M)** — GPT-4-level factuality checking at ~400x lower cost ([arXiv 2404.10774](https://arxiv.org/abs/2404.10774)) — or DeBERTa-v3+SummaC (windowed-max, 0.5 threshold). This exact stack runs on-device: [arXiv 2607.12257](https://arxiv.org/html/2607.12257) does it on an M4 Pro. Fixes substring matching's known blind spots (paraphrase over-penalty, wrong-source attribution, "peer-reviewed" applied to preprints). Keep v0.1 regex as a fast tripwire. Pin model hash + threshold + seed to preserve determinism.
2. **Span-level failure reports via LettuceDetect** (`KRLabsOrg` ModernBERT token classifier, 150–307M, MIT — AGPL-compatible; [arXiv 2502.17125](https://arxiv.org/abs/2502.17125)): per-bundle reports show the *invented span itself*, automating what judges' notes currently do by hand. RAGTruth re-annotation found 10x more hallucinated spans than the original labels — single-instrument benchmarks under-count, so run two instruments.
3. **Deterministic attribution scoring** (ALCE/FACT lineage; [ALCE](https://www.emergentmind.com/papers/2305.14627), [FACT/DRB, arXiv 2506.11763](https://arxiv.org/abs/2506.11763)): per attributed claim, entail against *the named source's wire line* — citation recall — and flag attributions to absent sources or claims laundered from other lines — precision. Catches "right fact, wrong source", invisible today. Wire lines are pre-labeled, so this is ~100 lines on top of item 1.
4. **Binary per-bundle rubrics for adjudication** (the DRB-II move: 9,430 binary rubrics replaced holistic judging to cut variance): replace judged 1–5 adjudication with 2–4 authored Y/N checks per poisoned bundle ("flags the Delphi claim as vendor marketing", "says unanswerable from these notes"). Also: **add the README-promised `question` bundles — `bundles.json` currently has 9 clean + 3 poisoned and zero question bundles**, including unanswerable ones scored on abstention ([arXiv 2605.11330](https://arxiv.org/html/2605.11330v1)).
5. **Judge protocol v2:** both-order judging with agreement-or-tie; independent axis scoring before winner pick; style-stripping (emotion tags, caps, sign-offs) + length-controlled win rates for the desk track — verbosity bias inflates judge preferences 15–30 pts, and style/format carry most preference leakage ([Preference Leakage, ICLR 2026, arXiv 2502.01534](https://arxiv.org/abs/2502.01534); style bias is actively exploitable, [arXiv 2605.26156](https://arxiv.org/abs/2605.26156)). **Never a Gemma-family judge for a Gemma-family candidate**; headline numbers from a 3-judge cross-provider panel. The persona's charm is the benchmark's biggest leakage risk: persona track keeps style as a measured axis, desk track must be style-blind.
6. **Statistics in the scorer** (from A5): paired bootstrap CIs (topic-clustered — bundles share beats, naive SEs can be 3x optimistic per [arXiv 2411.00640](https://arxiv.org/abs/2411.00640)), exact sign tests, Wilson intervals. README states the current power limits plainly: 11/12 wins p=0.0063 (sound); 11.1-pt grounding delta at n=12 (underpowered, needs ~61 bundles).
7. **Small-N policy as permanent regime** (MoltBench will live at 12–50 hand-curated bundles): Wilson for binaries, sign/Bayesian-paired for pairwise, KDE-smoothed bootstrap for non-binary scores, **no BCa for pairwise** (coverage collapses at small N), Holm-Bonferroni across the four judged axes (statsforevals.com; Demsar 2006). Publish the policy in the README to preempt "n=12" criticism.
8. **Grow to ~50 stratified bundles** — ~30 clean / ~12 poisoned / ~8 question: the knee of the power curve (80% power for ~12-pt deltas at measured SD=0.309; 10-pt needs ~75, 5-pt needs ~300 — not worth it). Record a wire-store date cutoff per bundle as a contamination guard. 50 bundles x 3–4 binary rubrics ≈ 180 scored checkpoints, DRB-II-defensible.
9. **External anchor section:** the FRAMES + FACT-axes run (B6) as a standing leaderboard section, so pepper's numbers sit on the same axes as commercial deep-research agents. Borrow DRB's axes; do not adopt the full judge-heavy benchmark.
10. **Reproducibility hygiene:** check in *all* leaderboard outputs (the desk-e2b outputs behind the 88.6% headline are absent from `bench/bundles/`), plus per-row manifests (metric version, NLI model hash, judge IDs + prompts, bundle cutoffs). The instrument and raw outputs are part of the benchmark.

---

## 4. Do not bother

- **Scaling hand-verified SFT data past ~1k examples.** 1k→20k showed no consistent gain and sometimes hurt ([arXiv 2506.14681](https://arxiv.org/html/2506.14681v2)); domain gains concentrate in the first ~300 ([2509.17167](https://arxiv.org/pdf/2509.17167)); LIMA/LIMIT confirm ~1k curated matches 50x more. At 452, pepper is past the steep part. Buy verified compute, not labels.
- **Full online-RL search environments (LiteResearcher/SearchGym/DeepSearch-World class).** Building a 32M-page deterministic virtual web and running agentic RL in it is GPU-cluster scale. Steal the curriculum-filter idea (C1); treat the rest as reading.
- **KTO.** Not implemented in mlx-lm-lora, and unneeded: the grounding checker produces *scored pairs*, which is exactly DPO/ORPO's input format, not KTO's binary thumbs.
- **Free-form self-critique / intrinsic self-correction prompting.** SLMs reliably fail at it without external verifiers ([arXiv 2406.02378](https://arxiv.org/abs/2406.02378), [2406.15673](https://arxiv.org/abs/2406.15673)); pepper has an external verifier, so always route correction through it (A3), never through "review your answer and improve".
- **Strict JSON/schema-constrained decoding for the report prose.** Format restrictions degrade reasoning, worst on small models ([Let Me Speak Freely, arXiv 2408.02442](https://arxiv.org/abs/2408.02442)); the two-section format is already baked in by 452 training examples. Light header/stop-token grammar at most; strict JSON only for pipeline plumbing (decomposition, extraction), NL-to-format conversion if machine-readable reports are ever needed.
- **LLM-judge rubric rewards inside the GRPO loop.** Rubrics-as-Rewards ([arXiv 2507.17746](https://arxiv.org/abs/2507.17746)) is judge-expensive *per rollout* — unaffordable at Mac rollout budgets and a reward-hacking surface. Use judges offline to build DPO pairs instead.
- **Speculative decoding for the 2B.** The draft/target gap is too small to pay (realistic 1.4–2x only when the target is big; contracollective.com 2026 benchmarks). Revisit only if a 7B-class writer/judge ever sits in the pipeline. Prompt caching + batching deliver the wins instead.
- **Best-of-N beyond ~4–8.** Coarse gains plateau by 12–16 samples ([arXiv 2508.16665](https://arxiv.org/abs/2508.16665), [2606.00660](https://arxiv.org/abs/2606.00660)); N=4 captures most of it at a quarter of the compute.
- **Model-decided retrieval routing and >2 search iterations.** Fixed hybrid RRF beat adaptive routing, and 2 iterations captured 95% of 5-iteration gains in the local-scale ablation ([arXiv 2606.21553](https://arxiv.org/abs/2606.21553)). A 2B should never spend capacity on orchestration a script can do; free-form iterative decomposition also drifts semantically at small scale (GenDec, [arXiv 2402.11166](https://arxiv.org/abs/2402.11166)).
- **Curriculum reordering for plain SFT.** Evidence is weak for SFT-phase curricula ([On the Limits of Curriculum Learning for Post-Training](https://openreview.net/pdf/4d5adc6abbe853332f5db6c8e3e468a6e0f4a9d0.pdf)); the strong evidence is RL-phase prompt *filtering* by reward variance — do that (C1), skip the SFT reshuffle.
- **AFM adapters as a distribution channel.** Entitlement-gated, closed-base, retrain-per-OS-update, no open redistribution — incompatible with the AGPL/open-weights posture. Demo only (C3).
- **Nemotron-3-Nano and Qwen3.5 on MLX without verification.** Mamba-hybrid and Gated DeltaNet support in mlx-lm is unconfirmed; verify before spending an eval slot (§2 Tier 3 / Tier 1 caveats).
- **Full DeepResearch Bench adoption.** Judge-heavy, PhD-task-shaped, English/Chinese-centric; borrow the RACE/FACT axes and the DRB-II binary-rubric method, run FRAMES for the external anchor.
- **Gemma-family judges for pepper models, and single-order judging.** Both are measured leakage vectors ([arXiv 2502.01534](https://arxiv.org/abs/2502.01534)); v2 protocol (§3.5) supersedes them.

---

**Dependency spine:** A5 (statistics) → A1 (sampling infra) → B1 (RFT, produces pairs + difficulty bins) → B2 (DPO) → C1 (GRPO). B3 (instrument v2) should land before B1's results are scored. A4, A6, B5, B6 are parallelizable at any time. B7 (E4B) waits until the recipe is RFT-hardened so the migration carries the best-known recipe, not the original one.
