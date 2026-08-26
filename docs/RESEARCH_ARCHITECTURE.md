# PEPPER RESEARCH v3 — architecture and build plan

**Status:** design document. Nothing here is built yet. Written 2026-08-26 against
`src/deepresearch.js` @ 565 lines (git a4756f2), `src/brain/index.js` @ 687 lines.

**Scope:** the design for a routed, multi-model, tool-using local research agent —
the loop, the roles, the model assignment on Pepper's fleet, the tools, where
verification sits, how `[n]` citations stay mechanically bound end to end, how the
whole thing degrades down to an 8GB MacBook, what to build in what order, what not
to build, and what may honestly be claimed.

**The one constraint that outranks everything:** Pepper runs on hardware the user
owns. No API keys, no accounts, no cloud inference. Every model, every tool, every
fallback in this document satisfies that or is marked as not satisfying it.

---

## 0. Where v2 actually is

`pepper research --long` today:

1. One 2B call decomposes the question into ≤8 search angles
   (`src/deepresearch.js:421-455`), with a deterministic facet fallback when the
   model emits junk.
2. One sweep per angle across news / HN / arXiv / web
   (`src/deepresearch.js:466-494`). arXiv only fires on the first two angles
   (`:468-470`).
3. `pickForReading` takes ≤16 pages, ≤3 per host, ≤5 per lens (`:169-196`), and
   `readSources` hangs raw page text on the item (`:199-228`).
4. One 2B call per angle writes a section from ≤6 excerpts (`:327-346`).
5. One synthesis call over 320-char section clips, then intro and outro over the
   same clips (`:349-388`; `RECAP_CHARS = 320` at `:27`).
6. Citations: items are numbered by array position (`:328`), sections are told
   which numbers they may use, and the Sources list is generated from the item
   array (`:402-405`).

Measured (bench/README.md): RACE 0.280 overall / 0.241 insight under a local
gemma-4-26B-A4B judge, against Claude-3.7-Sonnet deep research at 0.420 under the
same judge. FACT citation validity 81.8%, 0.92 citations per extracted statement.

### The four defects v3 exists to fix

**D1 — the citation set widens after writing.** `src/deepresearch.js:401`:

```js
for (const m of prose.matchAll(/\[(\d{1,4})\]/g)) offered.add(Number(m[1]));
```

Any bracketed number the model emits is added to `offered`, and `offered` is what
selects the Sources list at `:402-405`. A model that writes `[7]` in a section that
was never shown item 7 gets item 7's real URL printed next to a claim item 7 does
not support. Invented *links* are already structurally impossible — there is no code
path from model text to a URL — but invented *bindings* are not. This is the exact
shape of the 18.2% FACT failure: support mismatch, not fabricated URLs.

**D2 — one model does every job.** Decomposition, section writing, synthesis, intro
and outro all go through the same `brain.generate` with no role
(`src/brain/index.js:628`). The literature is consistent that planning capacity
dominates and executor capacity does not: scaling the delegation backbone moves
+11 EM, scaling the execution sub-agent moves +2.6
(https://arxiv.org/abs/2607.07548). Pepper spends her scarcest capacity on the
highest-volume role and her cheapest call on the highest-entropy decision.

**D3 — the outline is fixed before a single page is read.** The `angles` array is
computed at `:421` and each angle becomes a section verbatim. WebWeaver's ablation
takes DRB overall 48.85 → 50.82 and Insight 46.33 → 48.35 purely by re-optimising
the outline across 3 rounds instead of 1 (https://arxiv.org/abs/2509.13312). The
static plan is the specific pattern the 2026 work invalidated.

**D4 — depth 1.** One sweep per angle, no second round, no gap detection, no
re-query. The budget study puts more search rounds (to ~3) above retrieval quality,
above completion tokens, and above model size: Qwen3-14B on HotpotQA goes 48.18% →
69.38% from 1 → 3 searches, then plateaus
(https://arxiv.org/abs/2603.08877). The same study finds a smaller model with three
searches ≈ a larger model with one, which is the single most important number for
this project: the 2B may not be what caps 0.280.

---

## 1. Design invariants

These are the rules the loop may not break. Every one of them is a decision that a
future contributor will be tempted to undo; each has a measurement behind it.

| # | Invariant | Why |
|---|---|---|
| **I1** | **Control flow lives in JavaScript. No model ever decides whether to continue.** | 38% of documented infinite agentic loops depend on model output for termination (https://arxiv.org/abs/2607.01641). Below ~7B, tool-calling is absent rather than degraded, and adding a routing layer made it worse. |
| **I2** | **A `[n]` is allocated by the harness at source-record creation, never by a model.** A model receives numbers; it never emits a URL and never sees one. | Makes an invented URL structurally impossible. Already true in v2 and it is why FACT failures are mismatches, not fabrications. Keep it. |
| **I3** | **An extracted claim enters the ledger only if its quote is a verbatim substring of the stored page text.** | Free, deterministic, and the strongest anti-fabrication device in the design. Cheaper and stricter than any model check. |
| **I4** | **A section writer sees only the evidence bound to its own outline node, and only citations from that node's offered set survive.** | WebWeaver's node-bound retrieval vs an all-evidence-in-context baseline: citation accuracy 86.73% → 93.37%, Insight 42.72 → 50.02 (https://arxiv.org/abs/2509.13312). It also removes the long-context requirement entirely. |
| **I5** | **No small model is ever asked to critique, verify, or reflect on its own output.** | Self-critique on 7-8B models is net-negative: Cohen's d −0.14 to −0.33, negative in 78% of conditions; meta-cognitive prompts cut calculation errors −4.2% but raised hallucinations +4.5% (https://arxiv.org/abs/2601.00513). |
| **I6** | **Verification is cross-family from generation.** | Generator/verifier correlation ρ=0.54 cross-family vs ρ=0.77 within-family; only 9.6% of one family's self-consistent errors reproduce in another (https://arxiv.org/abs/2505.17656, https://arxiv.org/abs/2603.25450). |
| **I7** | **The in-loop critic is never the benchmark judge model.** | `bench/DRB_PROTOCOL.md` forbids judge-specific gaming. An in-loop critic that is the judge turns the loop into gradient descent on the scorer. |
| **I8** | **Every stage prompt stays under ~24,000 characters (~7k tokens).** | MLX throughput collapses past ~32k context: Qwen 32B Q4 on M3 Ultra runs 31.2 tok/s at 1K, 19.0 at 32K, 8.5 at 128K; prompt processing 345 → 154 tok/s (https://github.com/ml-explore/mlx/discussions/3209). There is no "read forty pages into one context" design on this hardware. |
| **I9** | **Every run writes a complete, replayable ledger to disk.** | Crash-proofing, auditability, reproducibility — and a logged trajectory is training data for free. The filesystem-as-memory-bank pattern reaches 53.94 RACE (https://arxiv.org/abs/2602.01566). |
| **I10** | **Nothing throws. Every degraded path produces a report and says what it lost.** | Existing contract in `src/brain/index.js` and `src/deepresearch.js`. Non-negotiable. |

---

## 2. The architecture

### 2.1 The loop

```
  scope  →  [ round 1..N: sweep → rank → read → extract → cover → revise → gap ]  →  write  →  audit  →  emit
     |                                        ^                              |
   planner                                    +---------- FIFO gap queue ----+
```

Stated as code (this is the replacement for `runDeepResearch`'s body):

```
runDeepResearch(question, { emit, long }):
  ledger  = openLedger(runId)                       # ~/.pepper/research/<runId>/
  budget  = { rounds: 4, wallMs: 480_000, fetches: 48, llmCalls: 90 }

  # ---- SCOPE (planner, 1 call) -------------------------------------------
  plan     = planner.scope(question)                # → checklist[] + outline[] + queries[]
  ledger.writeChecklist(plan.checklist)
  ledger.writeOutline(plan.outline)
  queue    = new FifoQueue(plan.queries)            # gap questions to the FRONT,
                                                    # the original question to the BACK

  # ---- ROUNDS ------------------------------------------------------------
  for round in 1..budget.rounds:
     queries = queue.take(6)                        # deduped by normalized string + trigram
     hits    = sweep(queries, lenses)               # mechanical, parallel, per-lens paced
     picks   = rank(hits, queries, ledger)          # BM25 + RRF (+ cross-encoder if served)
     read(picks, ledger)                            # fetchx → sources/<sid>.txt, allocates [n]
     extract(picks, ledger)                         # executor, schema-locked, quote-gated
     cov = coverage(ledger)                         # MECHANICAL. counts, not opinions.

     if stop(cov, budget, round): break             # see §2.2

     outline = planner.revise(outline, cov, ledger) # rewrite the outline against evidence
     gaps    = critic.gaps(checklist, outline, cov) # DIFFERENT model from the writer
     queue.pushFront(gaps.queries)
     queue.pushBack(plan.queries[0])                # original question rotates to the back

  # ---- WRITE (per node, node-bound evidence) -----------------------------
  for node in outline where node.status != 'empty':
     ev      = ledger.evidenceFor(node)             # ONLY this node's evidence
     section = writer.section(node, ev)             # sees [n] tokens, never URLs
     section = bindCitations(section, ev.offered)   # strip every [n] outside the set
     ledger.writeSection(node, section)

  synthesis = synth.crossSection(outline, ledger)   # map-reduce over node digests
  intro     = writer.intro(outline, ledger)         # from node evidence, not 320-char clips
  outro     = writer.gaps(checklist, cov)           # from the UNCOVERED checklist items

  # ---- AUDIT (cross-family, before emit) ---------------------------------
  verdicts  = verify(report, ledger)                # MiniCheck + cross-family 2nd opinion
  report    = applyVerdicts(report, verdicts)       # drop / demote / keep, logged
  ledger.writeReport(report, verdicts)
```

Two structural notes.

**The gap queue is FIFO, not recursive.** New gap questions go to the front, the
original question rotates to the back, one shared context throughout. Recursive
sub-question descent is rejected because there is no principled way to budget a
sub-question's tokens; the FIFO shape "balances depth and breadth, ensuring the
system always returns to the original question with progressively better
knowledge" (https://jina.ai/news/a-practical-guide-to-implementing-deepsearch-deepresearch/,
https://github.com/jina-ai/node-DeepResearch).

**The working context is rebuilt each round, not accumulated.** A round's planner
prompt contains exactly three things: the question, the current outline + coverage
table, and the last round's result summary. O(1) memory, constant prefill, no
lost-in-the-middle decay — which is what makes I8 survivable
(https://arxiv.org/abs/2511.07327).

### 2.2 Stopping criteria

Two independent stop conditions, both computed by the harness. Never model
confidence.

**(a) Coverage satisfied** — every checklist item `c` has
`c.evidence.length >= need.sources` from `>= need.hosts` distinct hosts and
`>= need.lenses` distinct lenses. Defaults `{sources: 2, hosts: 2, lenses: 2}`;
`kind: "figure"` items get `{sources: 2, hosts: 2, lenses: 1}` because a statistical
release often exists on exactly one authoritative host.

**(b) Budget tripped** — any of:

| Bound | Default (`--long`) | Enforced in |
|---|---|---|
| `rounds` | 4 | round loop |
| `wallMs` | 480_000 (8 min) | checked at the top of every round *and* before each read batch |
| `fetches` | 48 | `read()` |
| `llmCalls` | 90 | `brain.generate` wrapper, per run |

Both are enforced **at the exact scope where the feedback loop closes** — the round
loop — because the analysis of 68 confirmed infinite agentic loops across 47
projects found that all 68 share one root cause: the repeated path lacks a strong
bound, and 66% of them hide the feedback path inside a framework API
(https://arxiv.org/abs/2607.01641).

**Beast mode.** When the budget trips with coverage unsatisfied, the loop enters a
terminal state where every action except writing is disabled, and the report's
closing section names the uncovered checklist items explicitly. Premature stopping
and unbounded running are both failures; explicit evidence-sufficiency criteria plus
a hard bound is the documented fix (https://arxiv.org/abs/2604.24978).

**What is deliberately *not* a stop condition:** the model saying it has enough. Ever.

### 2.3 The diagram

```
                             pepper research "<question>" --long
                                            │
                                            ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  SCOPE                                                    role: planner  (1 call)│
│  question ──► checklist.json  { cid, ask, kind, need:{sources,hosts,lenses} }[]   │
│           └─► outline.json    { nid, title, covers:[cid], evidence:[eid] }[]      │
│           └─► seed queries ──► FIFO gap queue                                     │
└──────────────────────────────────────────────────────────────────────────────────┘
                                            │
        ┌───────────────────────────────────┴─────────────────────────────────┐
        │                       ROUND 1 .. N   (N ≤ 4, hard)                  │
        │                                                                      │
        │   queue.take(6)                                                       │
        │        │                                                              │
        │        ▼                                                              │
        │  ┌───────────── SWEEP ─────────────┐   mechanical, no model           │
        │  │ news.js  hn.js  arxiv.js        │                                  │
        │  │ web.js   searxng.js  edgar.js   │  ── keyless HTTP ──►  the wire    │
        │  └────────────────┬────────────────┘                                  │
        │                   ▼                                                   │
        │  ┌───────────── RANK ──────────────┐   BM25 + RRF + lens/host caps     │
        │  │ rank.js  (+ bge-reranker if up) │   NO LLM HERE. 241ms vs 1549ms.   │
        │  └────────────────┬────────────────┘                                  │
        │                   ▼                                                   │
        │  ┌───────────── READ ──────────────┐   fetchx.js                       │
        │  │ direct → textutil → PDFKit      │   ┌──────────────────────────┐    │
        │  │        → Wayback snapshot       │──►│  ALLOCATES [n] HERE      │    │
        │  └────────────────┬────────────────┘   │  sources/<sid>.json+.txt │    │
        │                   │                    │  cite:n ⇔ a fetched URL  │    │
        │                   ▼                    └──────────────────────────┘    │
        │  ┌──────────── EXTRACT ────────────┐   role: executor (2B, schema)      │
        │  │ {claim, quote, sid} per page    │                                    │
        │  │ ██ GATE 1: quote must be a      │   fan out; one endpoint;            │
        │  │    verbatim substring of .txt   │   continuous batching absorbs it    │
        │  └────────────────┬────────────────┘                                    │
        │                   ▼                                                     │
        │  ┌──────────── COVER ──────────────┐   MECHANICAL — counting, not        │
        │  │ per cid: #sources #hosts #lens  │   judgement. This is the stop       │
        │  └────────────────┬────────────────┘   signal AND the progress display.  │
        │                   │                                                      │
        │       satisfied? ─┴─ yes ─────────────────────────────────────────────┐  │
        │              no │                                                     │  │
        │                 ▼                                                     │  │
        │  ┌──── REVISE OUTLINE ────┐  role: planner   (rewrite against evidence)│  │
        │  └────────────┬───────────┘                                            │  │
        │               ▼                                                        │  │
        │  ┌──── NAME GAPS ─────────┐  role: critic  ── DIFFERENT MODEL FROM     │  │
        │  │ which cid lack evidence│                   THE WRITER (I6), and     │  │
        │  │ → next round's queries │                   NOT the bench judge (I7) │  │
        │  └────────────┬───────────┘                                            │  │
        │               └──► queue.pushFront(gaps) ; queue.pushBack(original)    │  │
        └─────────────────────────────────────────────────────────────────────┬──┘  │
                                                                              │     │
                    ┌─────────────────────────────────────────────────────────┴─────┘
                    ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  WRITE — one call per outline node                          role: writer          │
│                                                                                   │
│   node n2 ──► ledger.evidenceFor(n2)  ──►  ONLY n2's evidence in the prompt       │
│                                            (I4 — prune after; never accumulate)   │
│           ──► prose with [7] [12] [19]                                            │
│           ──► ██ GATE 2: bindCitations() strips every [n] not offered to n2       │
│                                                                                   │
│  SYNTHESIS  role: synth   (map-reduce over node digests — never one giant ctx)    │
│  INTRO/OUTRO role: writer (from node evidence + uncovered checklist, not clips)   │
└──────────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  AUDIT  ██ GATE 3 — cross-family, before anything is emitted                      │
│                                                                                   │
│   each sentence + its cited quotes ──► MiniCheck-FT5 (770M encoder) entailment    │
│        below threshold ──► cross-family 2nd opinion (2B if writer is Qwen)        │
│        still failing    ──► drop | demote to "the desk could not confirm"          │
│                                                                                   │
│   verdicts.jsonl  +  a confidence footer in the report (auditability is the point)│
└──────────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
        report.md  ·  Sources list generated FROM THE LEDGER ONLY  ·  bulletin
```

### 2.4 Roles → models on this fleet

Seven roles. The routing table is static — the stage is always known at the call
site, so there is no unknown query to route and a learned router buys nothing while
adding a failure mode. Rule-based routing is <1ms against 500-2000ms LLM responses
(https://www.lmsys.org/blog/2024-07-01-routellm/ is the case *for* learned routing,
and it is a case about unknown incoming queries — which this is not).

**Tier A — M3 Ultra 512GB, everything resident:**

| Role | Model | Serve | Resident | Why this one |
|---|---|---|---|---|
| **planner** | Qwen3.8-27B (dense, 4-bit) | mlx_lm :8083 | ~18GB | Planning tokens are the highest-entropy decision points in the pipeline and currently get her cheapest call. Already downloaded. Non-Gemma, which clears the judge-family rule. Upgrade path: AgentCPM-Report-8B (§2.9). |
| **executor** (read → claims) | pepper-desk-e2b (2B) + constrained decoding | mlx_lm :8081 | ~4GB | Her measured 88.6% deterministic grounding, +23.4 over its own untuned base, beats every larger model tested on refusal-to-invent (bench/README.md). Highest-volume role; fan out and let continuous batching absorb it. |
| **writer** (sections, intro, outro) | Qwen3.8-27B (shares :8083 with planner) | mlx_lm :8083 | (shared) | Her own blind protocol says this: Qwen3.8-27B beat the 2B **11/12** and gemma-4-12b beat it **10/12** on judged desk quality. Section writing is the role the 2B measurably loses. |
| **synth** (cross-section) | DeepSeek-V4-Flash (284B/13B-A, MIT, 4-bit) — *optional*; falls back to planner endpoint | mlx_lm :8084 | ~165GB | Her weakest dimension (insight 0.241) and the one a ≤3B model structurally cannot do. Fastest per-token big model on the fleet. **Optional because 165GB resident to serve one call per report is a poor trade unless it is already up.** |
| **critic** (gap detection) | DeepSeek-V4-Flash, else gemma-4-12b | :8084 / :8085 | (shared / ~8GB) | Must differ from the writer (I6) *and* from the bench judge (I7). See the constraint table below. |
| **verify** | MiniCheck-Flan-T5-Large (770M) + pepper-desk-e2b as cross-family 2nd opinion | sidecar | ~1.5GB | 74.7% balanced accuracy on LLM-AggreFact vs GPT-4's 75.3%, at ~400× lower cost (https://arxiv.org/abs/2404.10774, weights https://huggingface.co/lytang/MiniCheck-Flan-T5-Large). |
| **rank** | bge-reranker-v2-m3 cross-encoder — *optional* | sidecar | ~1GB | No LLM belongs in triage. 241ms average vs 1549ms for an LLM at the same job (https://huggingface.co/BAAI/bge-reranker-v2-m3). BM25+RRF is the zero-dependency default; the reranker is the upgrade. |
| **voice** (final restyle, never compose) | pepper-desk-e2b | :8081 | (shared) | Her voice is in those weights — 452 verified wire→report pairs. It restyles sentences and re-passes Gate 3. It never adds a fact. **Disabled during benchmark runs** — see the constraint table. |

Resident total without DeepSeek ≈ **33GB**; with it ≈ **198GB** of 512GB.

**Serving reality.** MLX serializes across processes: three mlx_lm servers on three
ports gives three *resident* models competing for one GPU and one memory bus, not
three-way parallelism. The parallelism that exists is continuous batching *within*
one served model — LM Studio's mlx-engine measures 2.2× on four concurrent short
chats and 82% less extra RAM on parallel long prompts
(https://lmstudio.ai/blog/mlx-engine-agentic-workloads). So: **stages run
sequentially; fan-out happens inside a stage, against one endpoint.** Fan all 12
page-extractions at :8081; then all 6 section drafts at :8083; then one synth call.
Do not try to overlap the 2B and the 27B — that is contention, not speed.

Turn on prompt-prefix caching before anything else: the role instruction block is
byte-identical on every call of that role, and it is the cheapest throughput
available.

**Family constraint table** (this is the part that is easy to get wrong):

| Constraint | Rule | Assignment that satisfies it |
|---|---|---|
| C1 | verifier ≠ writer family | writer Qwen · verifier MiniCheck (Flan-T5) + 2B (Gemma) |
| C2 | in-loop critic ≠ writer family | writer Qwen · critic DeepSeek (or gemma-4-12b) |
| C3 | in-loop critic ≠ any bench judge model | critic DeepSeek/gemma-4-12b · judges gemma-4-26B-A4B + MiniMax-M2.7 |
| C4 | bench judge panel spans ≥2 families; publish the **lower** number | gemma-4-26B-A4B **and** MiniMax-M2.7 |
| C5 | residual same-family leakage is disclosed with its measured size | the 2B is Gemma-lineage and one judge is Gemma: same-series leakage measures **+8.9%** (https://arxiv.org/abs/2502.01534). Mitigation: the 2B produces only quote-gated extractions during bench runs, and the voice pass is disabled (`--no-voice-pass`). |

C5 is the uncomfortable one and it is why §5 opens with re-baselining. Under the
current setup, a gemma-4-e2b writer is judged by a gemma-4-26B judge — same family,
same series — while Claude-3.7-Sonnet at 0.420 is cross-family and receives no such
credit. The honest reading is that **the real gap is probably wider than 0.420 vs
0.280, not narrower.**

### 2.5 Tools

All keyless. All either self-hosted or plain public HTTP with no account.

| Tool | File | Status | Notes |
|---|---|---|---|
| Google News RSS | `src/sources/news.js` | exists | 12 items/query. **Its URLs are encoded redirect wrappers that land on a JS interstitial and can never yield article text** — `UNREADABLE_HOSTS` at `src/deepresearch.js:162` already skips them for the read budget (git a4756f2). So this lens supplies headlines and citations, not evidence, which is precisely why R8's lenses matter. |
| HN Algolia | `src/sources/hn.js` | exists | 10 items/query, unthrottled in practice. |
| arXiv | `src/sources/arxiv.js` | exists, **change** | Primary is `api.firecrawl.dev` (`:11`) — keyless but a **third-party cloud index**. See the promise note below. v3 adds `arxiv.org/html/{id}` full text: measured 11/12 of the most recent cs.CL submissions return 200, and text yield on one paper goes 3,726 chars (`/abs/`) → 11,996 chars (`/html/`, capped). |
| General web | `src/sources/web.js` | exists, **change** | DDG HTML endpoint. Already paced at 800ms with a 5-minute cooldown (`:10-11`). Remaining problems: the in-block retry (`:130-136`) doubles volume against a service that just throttled; there is no result cache; and the cooldown returns `null` for the rest of the run instead of falling through to another lens. |
| **SearXNG** | `src/sources/searxng.js` | **new** | Self-hosted on the M3 Ultra. AGPL-3.0 (license-aligned), keyless, first-class JSON API, fans one query across ~10 upstream engines with per-engine pacing and rotation — so no single engine sees the burst that trips the ~5-query cliff. This is the only sustainable multi-query open-web route. |
| **SEC EDGAR** | `src/sources/edgar.js` | **new** | `efts.sec.gov/LATEST/search-index?q=…&forms=10-K` is a raw Elasticsearch endpoint over every filing; the canonical `sec.gov/Archives/...` URL is reconstructible by string arithmetic, so citations are verifiable *by construction*. Also `data.sec.gov/submissions/CIK##########.json` and `data.sec.gov/api/xbrl/companyconcept/...` for audited line items. Measured: 12 rapid queries → 12× HTTP 200, no throttling. Requires the contact UA below — with the default UA every one of these is a 403. |
| Page reader | `src/fetchx.js` | exists, **change** | See §2.6. |
| Rank | `src/rank.js` | **new** | BM25 over title+snippet+first-2k-chars, RRF fusion with recency and lens priors, per-host and per-lens caps. ~60 lines of pure JS, no dependency, deterministic, and it handles the exact-term matches (tickers, statute names, model names) that dense retrieval misses. |
| Verify | `src/verify.js` | **new** | MiniCheck sidecar + cross-family second opinion. |

**Per-host User-Agent policy.** `headersFor()` at `src/fetchx.js:12-16` sends one
hardcoded UA for everything. Measured on this machine: `www.bls.gov` and
`www.sec.gov` return 403 for Pepper's UA *and* for a spoofed browser UA, and **200**
for a UA in SEC's required format (a name plus a contact email). Spoofing does not
work; identifying yourself does. Add a host→UA table, operator-configurable:

```json
"research": { "contactUA": "Pepper Research (you@example.com)" }
```

applied to `*.sec.gov`, `data.sec.gov`, `efts.sec.gov`, `*.bls.gov`. This is
simultaneously the polite answer and the working one, and it converts three current
hard failures into full-text primary sources.

**A promise note that belongs in the README, not buried here.** "Keyless" is not the
same as "no network" and not the same as "no third party." Pepper's promise is: no
API keys, no accounts, and **no cloud inference** — nothing she summarises leaves the
machine. `api.firecrawl.dev` in `src/sources/arxiv.js:11` is a keyless third-party
*index*, and Google News RSS, HN Algolia, DDG and Wayback are third-party *sources*.
That is what a research agent is. But it should be stated, and `--no-thirdparty`
should exist to drop to arXiv Atom + self-hosted SearXNG + EDGAR only, for anyone
who wants the strict reading.

### 2.6 Reader coverage

Measured with Pepper's own `fetchArticle` over 24 representative research URLs:
**11/24 = 46% success.** Failures: 10 bot-block/paywall (401/403), 2 extractor
misses under the 200-char floor, 1 timeout. Four cheap fixes, in order of payoff:

1. **Per-host contact UA** (above). Fixes sec.gov, bls.gov, data.sec.gov outright.
2. **`textutil` fallback.** macOS ships `/usr/bin/textutil`, which runs WebKit's own
   HTML parser. When `extractArticle` returns under `MIN_TEXT`, spawn
   `textutil -convert txt -format html -stdin -stdout`. Measured on the two
   extractor failures: brookings.edu 195 → **28,714 chars**; arstechnica.com
   162 → **7,748 chars**. It keeps boilerplate, which a quote-gated extraction pass
   tolerates far better than it tolerates an empty page.
3. **PDF via PDFKit.** `fetchArticle` gates on content-type at
   `src/fetchx.js:348-352` and discards every `application/pdf` — the native format
   of statistical releases, central-bank reports and NGO research. Pepper already
   builds and runs a Swift sidecar (`src/brain/brain.swift` → `~/.pepper/brain/`),
   so the toolchain, the lazy-build pattern and the `xcode-select` gate all exist.
   Measured: `swiftc -O` build 94s one-time; then **98,590 characters from a 3.7MB
   31-page arXiv PDF in 0.28s user / 3.1s wall**, correct reading order.
4. **Wayback fallback.** On 401/403/404/timeout, query
   `archive.org/wayback/available?url=…` and refetch the snapshot, tagging the item
   with the snapshot date so the report can say when the page was read. Measured:
   reuters.com and bls.gov both had snapshots (BLS snapshot two days old) and both
   refetched 200; pewresearch.org had none. It is slow — >40s for the Reuters
   snapshot — so it runs only when the direct fetch has already failed, and it
   counts against the same fetch budget.

Target after all four: **75-85% of research URLs readable**, measured on the same
24-URL probe checked into `bench/reader-probe.json`.

### 2.7 Data flow and the citation binding

The ledger is the whole answer to "where does `[n]` live."

```
~/.pepper/research/<runId>/
  run.json            { question, startedAt, config, budget, version, gitSha }
  checklist.json      [ { cid, ask, kind, need:{sources,hosts,lenses} } ]
  outline.json        [ { nid, title, covers:[cid], evidence:[eid], status } ]
  rounds/1.json       { queries[], hits, picks, reads, extracted, coverage, gaps }
  sources/s07.json    { sid, cite, url, finalUrl, host, lens, title, publishedAt,
                        fetchedAt, via, sha256, chars, textPath }
  sources/s07.txt     the exact text that was read, as read
  evidence.jsonl      { eid, sid, cite, cid, nid, kind, claim, quote, offset, round, by }
  sections/n2.md      the written section, post-bindCitations
  verdicts.jsonl      { sentence, cites[], entail, verdict, by }
  report.md           the emitted report
```

**The binding chain, and why an invented URL is structurally impossible:**

```
  a URL is fetched  ──►  a source record is created  ──►  cite = next integer
       │                        (sources/s07.json)                │
       │                                                          │
       └── the URL string exists ONLY here ───────────────────────┘
                                                                   │
  extraction prompt sees:  "[7] <title> — <host>\n<page text>"     │  ← number, not URL
  extraction returns:      { claim, quote }  bound to sid=s07 by   │
                           the harness, never by the model         │
                                    │                              │
  GATE 1 — quote must be a verbatim substring of sources/s07.txt   │
                                    ▼                              │
  evidence record eid=e12 { cite: 7, sid: s07, quote, claim }      │
                                    │                              │
  node n2 offers { 7, 12, 19 } ──► writer prompt shows those blocks│
  writer returns prose containing [7] [12] [23]                    │
                                    │                              │
  GATE 2 — bindCitations(prose, {7,12,19}) strips [23]             │
                                    ▼                              │
  Sources list is generated by iterating ledger source records ────┘
                          NOT by scanning the prose
```

There are exactly two places a URL can enter a report: a source record created by a
successful fetch, and the Sources list generated from those records. There is no
third. A model cannot emit a URL because it is never shown one, and cannot promote
an unrelated source because Gate 2 removes any citation outside its node's offered
set.

**This is the change that fixes D1.** v2's `offered` set widens from the prose at
`src/deepresearch.js:401`, so an in-range hallucinated `[n]` silently promotes a
real-but-unrelated source into the Sources list. v3 never scans prose to decide what
is cited; it scans prose only to decide what to *strip*.

### 2.8 Where verification sits

Three gates, in increasing cost and decreasing certainty. Two of the three cost
nothing and require no model.

| Gate | Where | Mechanism | Cost | Catches |
|---|---|---|---|---|
| **1. Quote gate** | end of `extract()` | `sources/<sid>.txt.includes(normalize(quote))` | free | fabricated evidence, paraphrase drift, cross-source contamination |
| **2. Binding gate** | end of each `write()` | `bindCitations(prose, node.offered)` | free | citation-to-source mismatch (the 18.2% FACT failure) |
| **3. Entailment gate** | after write, before emit | MiniCheck-FT5 per sentence against its cited quotes; flagged → cross-family second opinion; still failing → drop or demote | ~seconds for ~60 claims | unsupported inference, over-claiming, vendor claim laundered into fact |

Gate 3 emits a confidence footer into the report and `verdicts.jsonl` into the
ledger. That footer is not decoration — auditability is the product's promise, and
"here are the 4 sentences the desk could not entail against its own sources" is a
better artifact than a silent 96%.

**The gate that does not exist, on purpose:** there is no "ask the writer whether it
is confident" step and no "ask the 2B if the section is complete" step. I5.

### 2.9 Optional: serve a purpose-trained agent model

The strongest reproducible open-weight DRB results come from models *trained on the
research loop*, not from harnesses alone:

- **AgentCPM-Report-8B** (MiniCPM4.1-8B base, Apache-2.0, safetensors + GGUF, built
  for offline local deployment): 50.11 RACE / 52.64 Insight on DeepResearch Bench —
  above Gemini-2.5-Pro-deepresearch at 49.71 / 49.45. It gets there by interleaving
  evidence-based drafting with reasoning-driven deepening across ~40 retrieval
  rounds, revising the outline mid-write. https://arxiv.org/abs/2602.06540 ·
  https://huggingface.co/openbmb/AgentCPM-Report
- **WebWeaver** SFT on Qwen3-30B-A3B: 46.77 → 50.62 RACE, citation accuracy
  25.0% → 85.90%. https://arxiv.org/abs/2509.13312
- **Tongyi-DeepResearch-30B-A3B** (30.5B total / 3.3B active — small-model latency
  at large-model quality on MLX, ~17GB at 4-bit).
  https://huggingface.co/Alibaba-NLP/Tongyi-DeepResearch-30B-A3B

**Those are 0-100 numbers under DRB's official judge. Pepper's 0.280 is 0-1 under a
local gemma judge. The two must never be printed side by side without that
sentence.** But the direction is the point: an 8B beats frontier cloud deep research
on this benchmark, which means the ceiling for a local agent is set by the *loop and
the training*, not by how much model fits in 512GB.

Recommendation: build the harness first (it is what makes any model better), then
serve AgentCPM-Report-8B into the `planner` + `writer` roles as an A/B on the dev
split. Keep pepper-desk-e2b for the two jobs it genuinely wins — grounded extraction
at volume, and sounding like herself.

### 2.10 Wall clock, honestly

Tier A, 5 checklist items, 4 rounds, 12 pages read per round, 6 sections:

| Stage | Calls | Estimate |
|---|---|---|
| scope | 1 planner | ~25s |
| per round: sweep + rank + read | 0 LLM | ~45s (paced lenses, concurrency 4) |
| per round: extract | 12 executor, batched | ~40s |
| per round: revise + gaps | 2 planner/critic | ~50s |
| × 3-4 rounds | | **~7-9 min** |
| write 6 sections | 6 writer | ~2.5 min |
| synthesis + intro + outro | 3 | ~1.5 min |
| audit | encoder + a few 2B calls | ~30s |
| **total** | ~90 LLM calls | **~12-16 min** |

That is 3-4× the current `--long` runtime. It is a real cost and it should be said
out loud rather than buried. Mitigations: speculative decoding on the writer
(pair Qwen3.8-27B with a Qwen 3.5 4B draft; MLX implementations report 2.3× on
Metal, and one verify-only approach took a 27B from 7 → 18.3 tok/s), prompt-prefix
caching, and `--rounds 2` as the default for interactive use with `--rounds 4`
reserved for `--long`.

The structural advantage worth claiming: parallel researchers cost cloud vendors
~15× tokens (https://www.anthropic.com/engineering/multi-agent-research-system) and
cost Pepper ~2-4× wall clock on a batched M3 Ultra. Breadth is *cheaper* for her
than for the products she is benchmarked against.

---

## 3. Graceful degradation ladder

The architecture is the same at every tier. What changes is who holds each role,
and each tier states in the report what it lost.

### Tier A — the full fleet (M3 Ultra + LAN)

Everything in §2.4. Seven distinct roles, 4 rounds, all six lenses, all three gates,
cross-family critic, cross-family verifier.

### Tier A′ — 8GB MacBook or M2 on the LAN, pointed at the Ultra

**This is a first-class tier, not a workaround.** Point `brain.roles.*.url` at the
Ultra's ports and get Tier A. Still hardware the user owns, still no keys, no
accounts, no cloud. The README should say the fleet counts as local, because it
does; "local" has always meant "your machine", and a Mac on your desk talking to a
Mac in your closet is your machine twice.

The degradation decision is therefore three-axis, not one: what is resident here,
what is reachable on the LAN, what runs with nothing else available.

### Tier B — one M-series Mac with her 2B

One endpoint, one model. Roles collapse, and the collapse is governed by I1 and I5.

| Role | Tier B holder | What changes |
|---|---|---|
| planner | pepper-desk-e2b — **enumerated moves only** | The planner never free-forms a plan. It picks from a fixed enum of question facets (the deterministic facet list already at `src/deepresearch.js:441-443`) and fills a fixed checklist template. A 2B follows decomposition instructions in far fewer cases than a large model — Mistral-8B 76% vs Mistral-Large-2 96.5% (https://arxiv.org/html/2509.06544v1) — so the harness supplies the structure and the model supplies only the nouns. |
| executor | pepper-desk-e2b | unchanged — this is its trained job |
| writer | pepper-desk-e2b | unchanged in shape; expect the register/completeness deficit her own blind rounds measured (loses 11/12 to Qwen3.8-27B, 10/12 to gemma-4-12b) |
| synth | pepper-desk-e2b over node digests, hard-capped | **labelled in the report**: "composed from section digests, not a cross-evidence synthesis" |
| critic | **deleted** | I5 forbids self-critique. Gap detection becomes purely mechanical: the coverage table names the uncovered checklist items and a template turns each into a query. This is strictly worse than a real critic and strictly better than pseudo-reflection. |
| verify | Gates 1 and 2 only; Gate 3 only if MiniCheck is installed (~1.5GB) | |
| rank | BM25 + RRF | no cross-encoder |
| rounds | 3 | |

**What is lost:** insight (the dimension a ≤3B model structurally cannot supply —
models ≤3B do not consistently benefit from long chain-of-thought or distillation
off strong reasoners, https://arxiv.org/html/2502.12143v1), adaptive outlining, and
cross-model gap detection, which is the largest Insight lever in the literature.
Expected: better than today's 0.280 because of the mechanical items (binding,
depth, retrieval, reader coverage) and short of Tier A.

### Tier C — 8GB MacBook, Apple Foundation Models only, off-LAN

Apple's on-device model is ~3B with a **4,096-token context window in which prompt
and response must both fit**
(https://developer.apple.com/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window).
That single fact rewrites the tier:

- `maxPromptChars` drops to **~2,400** for every role. Section prompts as designed
  do not fit; extraction becomes strictly one page per call.
- Rounds drop to **1**. There is no budget for a second sweep after paying for
  single-page extraction.
- **No synthesis pass.** The cross-section section is replaced by a deterministic
  stitch of node digests, with a banner: *"Composed without a synthesis pass — this
  machine is running on the on-device model alone."*
- Gates 1 and 2 only. MiniCheck does not fit alongside the rest.
- Lenses: news + hn + arxiv + web. No reranker, no PDF sidecar if Command Line
  Tools are absent.

**What is lost:** everything above comprehensiveness. Her own measurement is the
honest expectation: the same agent on Apple FM scored **0.190 / 0.143** against the
2B's 0.280 / 0.241 — and Apple FM emitted memo-format and empty `ON AIR` blocks
under the desk prompt, losing 9/12 blind to the 2B (bench/README.md).

**Keep this tier anyway.** It is the zero-setup default that makes `npx pepper`
work on any Mac with no download, and that is worth more to the project than the
score. It should simply never be the tier that a benchmark number is quoted from
without the label.

### An either/or worth knowing about on 8GB

Ternary Bonsai-27B is a compressed Qwen3.6-27B at 5.9GB (1.71 effective bits, ~95%
benchmark retention, 262K context; MLX and GGUF builds exist —
https://prismml.com/news/bonsai-27b). On 8GB you can hold ternary Bonsai *or* the
small verified cast (2B + reranker + MiniCheck ≈ 6.5GB), not both. **Take the
verified cast.** The 1-bit Bonsai variant drops agentic tool use 80.0 → 66.0 —
4.6× more damage than to math reasoning — so it must never hold a structured role.
Bonsai's ternary build is a reasonable Tier B planner/writer on a 32GB M2, and
Pepper's own MoltBench already measured bonsai-27b at 79.6% deterministic grounding
(deterministic-only, no blind round, so it carries no pairwise claim).

---

## 4. The ranked build queue

Ranked by evidence-per-unit-work. Each item states the expected gain with its
literature anchor, the cost, the files, and how it is measured.

**Measurement discipline for every item:**
- **Dev split only** — the 23 EN tasks in `bench/drb-split.json` (`dev`). Holdout is
  scored to publish, never to iterate (`bench/DRB_PROTOCOL.md`).
- **Two-family judge panel** — gemma-4-26B-A4B and MiniMax-M2.7, both scale-validated
  by rescoring the bundled Claude-3.7-Sonnet reports (the existing check produced
  0.4198 local vs 0.4218 official, Δ0.002). Report both; the lower is the number.
- **Paired per-task deltas**, 10k-resample paired bootstrap 95% CI. n=23 is small;
  a delta whose CI crosses zero is a lean, not a result.
- **Free harness metrics on every run**, so most iterations never pay for a judge:
  `citation-in-set rate` · `quote-gate pass rate` · `evidence per checklist item` ·
  `distinct hosts per item` · `coverage@stop` · `pages read / pages attempted` ·
  `entailment pass rate` · `wall clock` · `LLM calls`.
- Expected gains below are **literature-anchored priors, not predictions.** Every
  number cited was measured on a different model, a different benchmark, or both.

---

### R0. Re-baseline the judge — do this before anything else

- **Gain:** none to the score. It makes every subsequent number real.
- **Why:** pepper-desk-e2b is a gemma-4-e2b LoRA and the RACE judge is
  gemma-4-26B-A4B — same family, same series, measured preference leakage **+8.9%**,
  against +23.6% for same-model (https://arxiv.org/abs/2502.01534). Claude-3.7 at
  0.420 is cross-family and gets none of it. Judges recognise related outputs at
  only 41-53% accuracy, so this is invisible without the ablation.
- **Cost:** one rescoring run over the archived
  `bench/external/reports-pepper-desk-en50.jsonl`. No retraining, no new code beyond
  a judge-model flag.
- **Files:** `bench/DRB_PROTOCOL.md` (add the panel rule + the family constraint
  table), `bench/README.md` (republish the table with both judges).
- **Measured by:** the delta between the gemma-judged and MiniMax-judged scores on
  the same archived reports. If that delta is small, say so and move on; if it is
  ~8-9%, the published number changes and the honest gap widens.

---

### R1. The ledger + per-node citation binding

- **Gain:** FACT citation validity **81.8% → target ≥ 92%**. Anchor: WebWeaver's
  node-bound retrieval vs an all-evidence-in-context baseline moves citation accuracy
  86.73% → 93.37%, with Insight +7.3 as a side effect
  (https://arxiv.org/abs/2509.13312).
- **Cost:** ~1-2 days. It *reduces* tokens per call.
- **Files:** new `src/research/ledger.js`; `src/deepresearch.js` — delete the
  prose-widening at `:401`, replace `byAngle` buckets with outline nodes, replace
  `num = new Map(items.map(...))` at `:328` with ledger-allocated cites.
- **Measured by:** FACT `valid_rate` on dev; harness `citation-in-set rate` (free,
  every run, should be 1.000 by construction after this lands — if it is not, the
  gate has a bug).

---

### R2. Extraction pass with the verbatim-quote gate

- **Gain:** the specificity that Comprehensiveness and Insight are actually scored
  on, plus it moves the 2B into the role its measurements support. Anchors: separated
  extraction beats fused passes and compression preserves signal
  (https://arxiv.org/abs/2310.04408); a 1.7B distilled executor matched a frontier
  sub-agent at 37% fewer tokens (https://arxiv.org/abs/2607.07548); her own 88.6%
  deterministic grounding is an extraction result, not a composition result.
- **Cost:** 1-2 days, plus schema support in the brain (R5's validator can land
  first or alongside).
- **Files:** new `src/research/extract.js`; `src/brain/index.js` (schema-locked
  generate); `src/deepresearch.js` (replace `sectionNotes` excerpt-stuffing at
  `:233-279` with node-bound evidence assembly).
- **Schema:**
  ```json
  { "claims": [ { "kind": "figure|event|claim|quote",
                  "claim": "one sentence, no citation markers",
                  "quote": "verbatim span from the page, 10-40 words" } ] }
  ```
- **Measured by:** `quote-gate pass rate` (free — this is also the diagnostic for
  whether constrained decoding is worth adding); `evidence per checklist item`;
  then dev RACE Comprehensiveness + Insight.

---

### R3. Depth: 3-4 rounds with the FIFO gap queue and mechanical stopping

- **Gain:** the best-measured single lever available. 1 → 3 searches took Qwen3-14B
  from 48.18% to 69.38% on HotpotQA, then plateaued; and *"smaller models with three
  searches approximated single-search performance of larger models"*
  (https://arxiv.org/abs/2603.08877).
- **Cost:** 2 days. 3× the fetches, which are free and keyless. No new model
  capability required.
- **Files:** `src/deepresearch.js` (the round loop, the queue, `stop()`);
  new `src/research/coverage.js`.
- **Measured by:** `coverage@stop` and `evidence per checklist item` first (free);
  then dev RACE. Also watch wall clock — this is where the minutes go.

---

### R4. Retrieval quality: BM25 + RRF, then optionally a cross-encoder

- **Gain:** hybrid retrieval +6.36pp, hybrid + re-ranking +9.29pp — the largest
  consistent gain in the budget study (https://arxiv.org/abs/2603.08877).
- **Cost:** 1 day for BM25+RRF (~60 lines, zero dependency). +0.5 day for the
  bge-reranker sidecar (~1GB, https://huggingface.co/BAAI/bge-reranker-v2-m3).
- **Do not build an embedding lane.** Measured on this machine: Apple's
  `NLEmbedding.sentenceEmbedding(.english)` scored a paraphrase pair at cos 0.295
  against an unrelated pair at 0.263 — a 0.03 gap. `NLContextualEmbedding` ranked an
  off-topic sentence (0.879) statistically level with the correct answer (0.948) and
  put "cats" (0.814) above "transformer architecture" (0.801), at ~1 text/second.
  Neither was trained with a retrieval objective and it shows.
- **Files:** new `src/rank.js`; `src/deepresearch.js` (`pickForReading` at `:169-196`
  becomes `rank()`); optional `src/rank-sidecar/`.
- **Measured by:** precision of the read set — `pages read that yielded ≥1 gated
  quote / pages read` (free). Then dev RACE.

---

### R5. Role routing in the brain + the planner on the 27B

- **Gain:** capacity asymmetry. Scaling the delegation backbone moves ~+11 EM;
  scaling the execution sub-agent moves ~+2.6 (https://arxiv.org/abs/2607.07548).
  Enforcing an explicit plan stage moved DeepPlanner's metric 63.4 → 64.4
  (https://aclanthology.org/2026.findings-acl.370/). Planning tokens are 1-3 calls
  per report against 40+ extraction calls — this is nearly free in tokens.
- **Cost:** ~1-2 days. A config table, a resolver, a validator, a repair path.
- **Files:** `src/brain/index.js` (add `role` to `generate`; `PREFER_TIERS` at `:349`
  becomes a per-role resolution chain; per-role `maxPromptChars`, temperature, and
  schema); `src/config.js` (`DEFAULTS.brain.roles`).
- **Contract:**
  ```js
  brain.generate({ role, instructions, prompt, max, schema })
  //  role      → static table lookup; unknown role falls back to 'default'
  //  schema    → parse → validate → ONE surgical repair nudge naming the violated
  //              field → null. Never throws, never loops.
  //  resolution: role endpoint → brain.local → foundation → fallback.
  //  HARD RULE: if the resolved tier is 'foundation' and the role is
  //  planner|writer|synth, the harness takes the Tier C path instead of sending an
  //  oversized prompt into a 4,096-token window.
  ```
- **Measured by:** A/B on dev with `planner: 2B` vs `planner: Qwen3.8-27B`, every
  other role fixed. This is the cleanest single-variable experiment in the queue.

---

### R6. Dynamic outline — revise against evidence each round

- **Gain:** DRB overall 48.85 → 50.82 and Insight 46.33 → 48.35 going from 1 to 3
  outline-optimisation rounds (https://arxiv.org/abs/2509.13312); the same monotone
  gain across 0/1/2/3 critic-generator rounds in
  https://arxiv.org/abs/2605.11732. RhinoInsight's ablation on DeepConsult:
  no control modules 3.65 avg / 18.14% win → checklist only 5.31/30.12% → evidence
  audit only 5.45/31.24% → both 6.82/68.51% (https://arxiv.org/abs/2511.18743).
- **Cost:** 2 days. Depends on R1 (nodes) and R5 (planner role).
- **Files:** `src/deepresearch.js`; new `src/research/outline.js`.
- **Measured by:** dev RACE Comprehensiveness + Insight; plus a free structural
  metric — `outline nodes changed per round` (if it is 0, the planner is not
  actually revising and the prompt is wrong).

---

### R7. Reader coverage: contact UA, textutil, PDFKit, Wayback

- **Gain:** read success **46% → 75-85%** on the 24-URL probe. Every downstream
  dimension is bounded by how much real page text exists; this is the supply side.
- **Cost:** ~2 days total. UA table ~10 lines. textutil ~15 lines + a spawn. Wayback
  ~30 lines. PDFKit ~40 lines Swift + ~20 lines JS, reusing the existing lazy-build
  and `xcode-select` gate.
- **Files:** `src/fetchx.js` (`headersFor` at `:12-16`; the content-type gate at
  `:348-352`; a fallback chain in `fetchArticle`); new
  `src/brain/pdftext.swift`; `src/config.js` (`research.contactUA`).
- **Measured by:** check in `bench/reader-probe.json` (the 24 URLs) and a
  `node bench/reader-probe.js` script reporting success rate by failure class. This
  is a free, fast, deterministic regression test — run it in CI.

---

### R8. New lenses: SearXNG, EDGAR, arXiv `/html`

- **Gain:** breadth on the DRB task categories where news+HN+arXiv returns
  commentary instead of evidence — demography, insurance markets, public policy,
  named-company analysis. arXiv `/html` roughly triples grounding text per paper
  (3,726 → 11,996 chars measured, the latter capped).
- **Cost:** arXiv `/html` ~5 lines. EDGAR ~60 lines. SearXNG ~80 lines plus standing
  up the container on the Ultra.
- **Files:** `src/sources/arxiv.js` (`/html/{id}` first, `/abs/` fallback);
  new `src/sources/edgar.js`; new `src/sources/searxng.js`;
  `src/sources/web.js` (normalized-query cache + host circuit breaker + fall-through
  to another lens instead of the in-block retry at `:130-136`).
- **The rate-limit fact that governs `web.js`:** measured on this machine
  2026-08-26 — DDG's HTML endpoint soft-blocks after ~5 queries in a short window,
  returning HTTP 200 with a 14.1KB anomaly page and zero results; the block survived
  2s pacing (0/10), 6s pacing (0/10), and was still blocking ~12 minutes later,
  though it recovered at 20s spacing. Mojeek cliffs at the same count and recovers
  in ~5 minutes. Public SearXNG instances are gated (searx.be interstitial,
  priv.au 429). `--long` issues 5-6 queries, which is exactly the cliff. Self-hosting
  SearXNG is the only sustainable fix; caching and a circuit breaker are the cheap
  mitigations.
- **Measured by:** per-lens contribution to gated evidence (free) — which lens
  produced quotes that survived Gate 1 — and dev RACE on the non-tech dev tasks
  specifically.

---

### R9. Cross-model critic for gap detection

- **Gain:** the largest Insight lever in the literature. AgentDisCo's critic +
  generator reaches 51.44 RACE / 52.49 Insight on Gemini-2.5-Pro vs
  Gemini-2.5-Pro-Deepresearch's 49.71 / 49.45, and 54.02 / 56.65 on Claude-Opus-4.6
  (https://arxiv.org/abs/2605.11732). VeriTrace's three regulatory loops give
  +4.22pp DRB Insight on *matched* backbones — i.e. the gain is the mechanism, not
  the model (https://arxiv.org/abs/2605.26081).
- **Cost:** 1 day after R5/R6. 3-6 extra big-model calls per report.
- **Constraint:** the critic must differ from the writer family (I6) *and* from the
  bench judge model (I7). See the family constraint table in §2.4.
- **Files:** new `src/research/critic.js`; `src/deepresearch.js`; `src/config.js`.
- **Measured by:** dev RACE Insight specifically, A/B with the critic disabled;
  plus `gap queries that produced new gated evidence / gap queries issued` (free).

---

### R10. Entailment gate (MiniCheck) + cross-family second opinion

- **Gain:** the last mile of FACT, plus the confidence footer. MiniCheck-FT5 (770M)
  hits 74.7% balanced accuracy on LLM-AggreFact against GPT-4's 75.3%, at ~400×
  lower cost — $0.24 vs $107 on the 13K test set (https://arxiv.org/abs/2404.10774).
- **Cost:** 2 days. **Honest caveat: this is the one item that adds a Python
  dependency**, which cuts against the zero-dependency ethos of the repo. Options:
  (a) an optional Python sidecar behind `pepper verify install`, mirroring the
  existing `pepper voice install` pattern; (b) ONNX export + a small runtime; (c)
  skip it and ship Gates 1+2 only, which already carry most of the FACT gain.
  Recommendation: (a), optional, off by default, and Gates 1+2 are never optional.
- **Files:** new `src/verify.js`; new `src/verify/` sidecar; `src/deepresearch.js`;
  `src/config.js`.
- **Measured by:** FACT `valid_rate` delta on dev with the gate on vs off; plus
  `entailment pass rate` and the count of dropped/demoted sentences per report.

---

### R11. Formalise the harness guardrails

- **Gain:** reliability and variance, which at n=23 is worth as much as mean score.
  A documented harness review took an 8B local model from ~53% to 99.3% on agentic
  tasks purely through six scaffolding mechanisms — schema validation with a repair
  path, surgical retry nudges, a step enforcer, tiered context compaction, a
  synthetic mandatory action, and per-model sampling params
  (https://dev.to/andrew-ooo/forge-review-8b-local-model-hits-99-on-agentic-tasks-18kc).
  The framing — *"the gap is not really a model problem, it's a harness problem"* —
  is the thesis of this whole document.
- **Cost:** 1-2 days. Pure engineering, no extra inference.
- **What it replaces:** `scrubProse()` at `src/deepresearch.js:284-302` and the
  angle-salvage regexes at `:429-433` are an ad-hoc version of this. They are the
  code documenting the failure mode in real time. Formalise them into a validator
  and keep them as the last line of defence for prose roles.
- **Files:** `src/brain/index.js` (validated-generate wrapper, per-role sampling,
  prompt-prefix caching, per-run call counter); `src/deepresearch.js`.
- **Measured by:** `schema-repair rate` and `null-generation rate` per role (free);
  variance of dev RACE across 3 repeat runs of the same 5 tasks.

---

### R12. Parallel bounded researchers (optional, after everything above)

- **Gain:** breadth on questions that genuinely decompose into independent
  sub-questions. Opus-4 lead + Sonnet-4 subagents beat single-agent Opus 4 by 90.2%
  on Anthropic's internal research eval, and token usage alone explains 80% of the
  performance variance (https://www.anthropic.com/engineering/multi-agent-research-system).
- **Cost:** 2-4× wall clock batched on one endpoint; 15× if run naively in series.
- **Two non-negotiables:** one centralising orchestrator that inspects sub-agent
  output before it propagates — independent uncoordinated agents amplified errors
  17.2× in a 180-configuration study
  (https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them);
  and every sub-researcher gets an objective, an output format, source guidance and
  explicit boundaries. Given I1, "sub-agent" means a bounded harness-driven
  researcher, never an autonomous one.
- **Scale effort to complexity**, do not fix a count: 1 researcher for fact-finding,
  2-4 for comparisons, more only for genuinely broad questions.
- **Measured by:** dev RACE Comprehensiveness against wall clock. If the
  comprehensiveness gain per minute is below what another round buys, do not ship it.

---

### R13. Serve a purpose-trained agent model (optional, highest ceiling)

- **Gain:** the ceiling. See §2.9.
- **Cost:** ~9GB resident for AgentCPM-Report-8B at 8-bit; one more mlx_lm port; a
  role-table edit. The harness must exist first — these models are trained for a
  search/browse loop and want a real tool interface, which is fine at 8-30B and
  impossible at 2B.
- **Files:** `src/config.js` only, if R5 landed properly. That is the test of whether
  R5 was built right.
- **Measured by:** dev RACE, A/B against Qwen3.8-27B in the same roles.

---

### Not in the queue, but adjacent

`docs/DESK_MODEL_ROADMAP.md` items **A1** (best-of-4 with the grounding scorer as
verifier), **A3** (scorer-directed surgical repair) and **B5** (extract-then-compose)
compose with this architecture rather than competing with it. A1's verifier is Gate 1
generalised; A3's repair path is R11's repair nudge; B5 *is* R2. When both documents
are worked at once, R1-R4 land first, because a training result measured on a broken
harness measures the harness.

---

## 5. What NOT to build

Each of these looks attractive and has a specific negative result behind it.

**Do not give the 2B tools, a ReAct loop, or JSON action selection.** Below ~7B,
tool-calling is absent rather than degraded: models reason about needing a tool and
then confabulate the answer instead of calling it. A published Llama-3B benchmark
recorded 0% tool invocation across 9 tasks and 11% overall accuracy, and adding a
routing layer dropped accuracy to 0% — *"architectural sophistication cannot
manufacture missing capability"*
(https://dev.to/anak_wannaphaschaiyong_11/why-small-llms-fail-at-tool-calling-the-shocking-discovery-from-our-llama-3b-benchmark-5lg).
LangChain's own local-deep-researcher warns that DeepSeek-R1 7B and 1.5B cannot
produce the required JSON and hit fallbacks
(https://github.com/langchain-ai/local-deep-researcher). Pepper's
`brain.generate({instructions, prompt, max})` — no tools, no multi-turn, harness owns
the loop — is the architecturally correct interface for a 2B, not a limitation.

**Do not ask any small model to critique, verify, or reflect on its own output.**
Net-negative, not merely useless: Cohen's d −0.14 to −0.33 across
Llama-3-8B / Mistral-7B / Qwen-2.5-7B over 10,734 traces, negative in 78% of
conditions; meta-cognitive prompts cut calculation errors −4.2% but raised
hallucinations +4.5% and logical leaps +3.3%
(https://arxiv.org/abs/2601.00513). Route it to the cross-family critic or replace it
with a mechanical check. RAG-style retrieval grounding is the one scaffold that
reliably helps small models (d = 0.23-0.93 in the same study) — which is the whole
justification for spending budget on search depth rather than reasoning turns.

**Do not let a model decide when to stop.** 38% of 68 confirmed infinite agentic
loops depend on model output for termination, and 96% risk cost exhaustion
(https://arxiv.org/abs/2607.01641). Coverage counting and hard bounds, always.

**Do not build recursive sub-question descent.** Fully resolving each sub-question
and its sub-sub-questions before returning has no principled token budget. Use the
FIFO gap queue
(https://jina.ai/news/a-practical-guide-to-implementing-deepsearch-deepresearch/).

**Do not use an LLM to deduplicate queries or to triage search results.** Jina found
LLM dedup uncontrollable and switched to embeddings; and for ranking, a cross-encoder
averages 241ms against an LLM's 1549ms for the same job
(https://huggingface.co/BAAI/bge-reranker-v2-m3). For Pepper specifically: normalized
string + trigram similarity for dedup, BM25+RRF for ranking. Both remove judgement
from the weak model, which is the point.

**Do not build an on-device embedding lane on Apple's NaturalLanguage framework.**
Measured above: a 0.03 similarity gap between a paraphrase and an unrelated sentence,
off-topic content ranked level with the correct answer, ~1 text/second. Neither
`NLEmbedding` nor `NLContextualEmbedding` was trained with a retrieval objective.

**Do not build a learned/LLM router.** The stage is always known at the call site;
there is no unknown query to classify. Rule-based routing is <1ms; an LLM router adds
500-2000ms and a failure mode. Add dynamic routing at exactly one place —
escalation — and make the escalation signal deterministic (entailment below
threshold, a citation that failed Gate 2, a schema repair that failed twice).

**Do not write long multi-instruction system prompts for the 2B.** `SECTION_INSTRUCTIONS`
at `src/deepresearch.js:304-313` carries roughly eleven distinct instructions in one
block. Small models degrade sharply under instruction count, and Gemma-3-4B in
particular shows *"drastic trade-offs rather than gradual degradations"* under
multi-task prompts (https://www.mdpi.com/2079-9292/14/21/4349). For the 2B roles,
split into one instruction per call or compile the procedure into weights — which is
what pepper-desk-e2b already is, and what its next fine-tune should target
(https://arxiv.org/abs/2605.22502).

**Do not put the 1-bit Bonsai build in any structured or tool-using role.** Agentic
tool use drops 80.0 → 66.0 in the 1-bit variant — 4.6× more damage than to math
reasoning (https://prismml.com/news/bonsai-27b). Ternary only, for anything with a
schema.

**Do not try to run three big models in parallel on the M3 Ultra.** MLX serializes
across processes. Three servers gives three resident models and one GPU. Sequential
stages, fan-out within a stage.

**Do not attempt single-context synthesis over forty pages.** Throughput collapses
past ~32k (https://github.com/ml-explore/mlx/discussions/3209) and the KV cache is
FP16, so it dominates bandwidth at long context and weight quantization stops
mattering. Map-reduce over the evidence ledger.

**Do not plan to run Kimi-K3 on this hardware.** 2.8T total / 104B active, ~1.56TB in
MXFP4. It does not fit 512GB at any usable quantization. Treat it as unrunnable, not
as an option.

**Do not use budget forcing as a quality mechanism.** Forcing extra compute past the
plateau *"provides limited practical benefit, largely matching baseline accuracy"*
(https://arxiv.org/abs/2603.08877). Rounds buy quality until ~3; tokens spent after
the coverage criteria are met buy nothing.

**Do not spawn uncoordinated parallel agents.** 17.2× error amplification without a
centralising orchestrator
(https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them).

**Do not let the in-loop critic be the benchmark judge.** It is judge gaming with
extra steps, and `bench/DRB_PROTOCOL.md` already forbids it.

---

## 6. The honest claim

### What 0.280 is, and what it is not

0.280 overall / 0.241 insight is RACE on the 50 EN DeepResearch Bench tasks, scored
by a local gemma-4-26B-A4B judge, in a single run, before `bench/DRB_PROTOCOL.md`
existed (it is labelled `en50-preprotocol`). The judge's scale was validated by
rescoring the benchmark's own bundled Claude-3.7-Sonnet reports: 0.4198 local vs
0.4218 official, Δ0.002. So the scale transfers *for that model under that judge*.

It is **not** comparable to the DeepResearch Bench public leaderboard. That
leaderboard moved its RACE evaluator from Gemini-2.5-Pro to GPT-5.5 in May 2026 and
current top public scores sit in the 47-56 range on a 0-100 scale
(https://github.com/Ayanami0730/deep_research_bench). It is also worth knowing that
DeepResearch Bench II now scores against ~9,430 expert yes/no rubric items and finds
even the strongest agents pass under half of them, with the largest deficits in
Information Recall and Analysis (https://arxiv.org/abs/2601.08536,
https://github.com/imlrz/DeepResearch-Bench-II) — and that search-time contamination
has been documented as inflating public-benchmark results for agents that can
retrieve benchmark-adjacent content (https://arxiv.org/abs/2606.05241).

And per R0, 0.280 is probably **flattered** by same-family preference leakage that
Claude-3.7's 0.420 does not receive.

### What this architecture could plausibly reach

Stated as ranges, with the reasoning exposed, on the **holdout split under the
two-family panel**, publishing the lower judge:

| | Overall | Basis |
|---|---|---|
| Today | 0.280 | measured, EN-50, single judge, pre-protocol |
| **Mechanical items only** (R1-R4, R7, R8, R11 — no tier change, still the 2B everywhere) | **0.30 - 0.35** | Depth, retrieval quality, reader coverage and citation binding are the four best-measured levers and none needs a bigger model. The anchor for "an 8B with 3 searches ≈ a large model with 1 search" is https://arxiv.org/abs/2603.08877. |
| **+ the routed tier** (R5, R6, R9, R10 — planner/writer/critic on 27B-class) | **0.33 - 0.40** | The planner-capacity, dynamic-outline and cross-model-critic results are individually strong and jointly sub-additive. Planning + reflection combined gave only +6.40pp where planning alone gave +5.69pp and reflection alone +4.71pp — these levers overlap. |
| **+ a purpose-trained agent model** (R13) | **plausibly 0.40 - 0.45; unproven** | This is the only configuration with a credible path to frontier parity under her judge, and it rests on transferring results measured on a different scale under a different judge. |

**Those ranges are engineering targets, not forecasts.** Every anchor behind them was
measured on a different model, a different benchmark, or both, and n=23 on the dev
split gives wide intervals. A range that is not reproduced on holdout under both
judges is a hypothesis.

### What it would take to actually match frontier

Three things, in order:

1. **The harness.** The existence proof that this is the binding constraint:
   FS-Researcher's GPT-5-mini configuration at 10 rounds reaches 46.63 RACE against
   OpenAI Deep Research's 46.45 with its full frontier stack
   (https://arxiv.org/abs/2602.01566). RhinoInsight states it directly — the key is
   not enhancing model capability but incorporating control mechanisms for context
   and model behaviour (https://arxiv.org/abs/2511.18743).
2. **A model trained on the loop, not just prompted into it.** WebWeaver took an
   open Qwen3-30B-A3B from 46.77 to 50.62 RACE with 85.90% citation accuracy;
   AgentCPM-Report-8B reaches 50.11 / 52.64 above Gemini-2.5-Pro deep research's
   49.71 / 49.45. Both are training results. Serving those weights is a config
   change; reproducing them from scratch is not.
3. **Honest measurement.** R0, the two-family panel, holdout discipline, and never
   mixing splits or judges into one number.

**What this architecture cannot fix:** a ≤3B model's synthesis ceiling. Models ≤3B do
not consistently benefit from long chain-of-thought or from distillation off strong
reasoners (https://arxiv.org/html/2502.12143v1), and multi-document holistic
reasoning is the specific capability the literature flags as still needing larger
models (https://arxiv.org/html/2410.11996). Insight 0.241 is her weakest dimension
and it is weak for a structural reason. Tier B and Tier C will always be short there.
The counterexample worth knowing is that a *purpose-trained* 7-8B can beat an
untrained 32B on long-context reasoning (https://arxiv.org/pdf/2510.19363) — which is
the argument for R13, not against the ceiling.

### What to claim publicly, and what stays a caveat

**Claimable, because they are properties of the code, not scores:**

- Runs entirely on hardware the user owns. No API keys, no accounts, no cloud
  inference. Nothing she summarises leaves the machine.
- **A citation cannot point at a URL she did not fetch.** The number is allocated at
  fetch time, the model never sees a URL, and the Sources list is generated from the
  ledger. This is architectural, not statistical, and it is rare.
- **Every claim carries a verbatim quote that was checked against the stored page
  text before it entered the report** (Gate 1).
- Every run leaves a complete, replayable ledger on disk: the pages as read, the
  quotes as extracted, the coverage table, the verdicts. Anyone can audit any report.
- The controlled comparisons: same agent, same sources, same prompts, same judge,
  only the brain differs. Her fine-tuned 2B scores 48% higher overall than Apple's
  stock on-device model, +68% on insight, +81% on readability.
- The harness metrics — read success rate, quote-gate pass rate, citation-in-set
  rate, coverage at stop — because they are deterministic and reproducible offline.

**Caveats that travel with any number, every time:**

- Which split (dev / holdout / en50-preprotocol), which judge, which agent version,
  which date. Never mix splits or judges into one number.
- Her judge is family-adjacent to her 2B; measured same-series preference leakage is
  +8.9%; the panel's lower number is the one published; the frontier comparison is
  cross-family and receives no such credit, so **the real gap is likely wider than it
  looks.**
- 0-1 local-judge RACE and 0-100 official-judge RACE are different instruments.
  Never print them side by side without saying so.
- Single run, EN-only, small n. Paired bootstrap CIs, or it is a lean and not a
  result.
- "Keyless" means no keys and no accounts and no cloud inference. It does not mean
  no third-party sources; `api.firecrawl.dev`, Google News, HN Algolia, DDG and
  Wayback are third parties, and `--no-thirdparty` exists for the strict reading.
- Tier C (Apple Foundation Models, 4,096-token window) is a different agent in
  practice and its numbers are labelled as such.

**What must never be said:** that Pepper beats frontier deep research; that a local
judge number is a leaderboard number; that any of the ranges in the table above have
been achieved. When one of them is achieved, on holdout, under both judges, with the
CI printed — then it is a result, and it will be a genuinely good one.

---

## 7. Appendix

### 7.1 Config additions

```json
{
  "brain": {
    "prefer": "foundation",
    "local": { "url": "http://studio.local:8081", "model": "pepper-desk-e2b" },
    "roles": {
      "planner":   { "url": "http://studio.local:8083", "model": "qwen3.8-27b",
                     "max": 700, "maxPromptChars": 18000, "temperature": 0.3 },
      "executor":  { "url": "http://studio.local:8081", "model": "pepper-desk-e2b",
                     "max": 400, "maxPromptChars": 9000,  "temperature": 0.2 },
      "writer":    { "url": "http://studio.local:8083", "model": "qwen3.8-27b",
                     "max": 640, "maxPromptChars": 14000, "temperature": 0.7 },
      "synth":     { "url": "http://studio.local:8084", "model": "deepseek-v4-flash",
                     "max": 700, "maxPromptChars": 20000, "temperature": 0.6 },
      "critic":    { "url": "http://studio.local:8084", "model": "deepseek-v4-flash",
                     "max": 400, "maxPromptChars": 12000, "temperature": 0.4 },
      "voice":     { "url": "http://studio.local:8081", "model": "pepper-desk-e2b",
                     "max": 560, "maxPromptChars": 9000,  "temperature": 0.8 }
    }
  },
  "research": {
    "rounds": 4,
    "wallClockMs": 480000,
    "maxFetches": 48,
    "maxLlmCalls": 90,
    "coverage": { "sources": 2, "hosts": 2, "lenses": 2 },
    "lenses": ["news", "hn", "arxiv", "web", "searxng", "edgar"],
    "searxng": "http://studio.local:8888",
    "reranker": "http://studio.local:8090",
    "verify":   "http://studio.local:8091",
    "contactUA": "Pepper Research (you@example.com)",
    "thirdParty": true,
    "voicePass": true,
    "ledgerDir": "~/.pepper/research",
    "keepRuns": 50
  }
}
```

Unset roles fall through to `brain.local`, then `foundation`, then `fallback` — so
an existing single-endpoint install keeps working with no config change, and lands
on Tier B automatically.

### 7.2 New and changed files

```
src/deepresearch.js        rewritten around the ledger + round loop; public
                           runDeepResearch(question, { emit, long }) signature is
                           UNCHANGED (CLI, POST /api/research and the Siri bridge
                           all depend on it — see docs/CONTRACTS.md)
src/brain/index.js         + role routing, schema validate-and-repair, per-role
                           sampling + maxPromptChars, per-run call counter,
                           prompt-prefix caching
src/fetchx.js              + per-host UA table, textutil fallback, PDF branch,
                           Wayback fallback
src/config.js              + DEFAULTS.brain.roles, DEFAULTS.research
src/research/ledger.js     NEW  run dir, source records, evidence.jsonl, cite alloc
src/research/extract.js    NEW  schema-locked extraction + Gate 1
src/research/outline.js    NEW  scope, revise, node→evidence resolution
src/research/coverage.js   NEW  the coverage table + stop()
src/research/critic.js     NEW  cross-family gap detection
src/rank.js                NEW  BM25 + RRF + caps (+ optional cross-encoder)
src/verify.js              NEW  Gate 3
src/sources/searxng.js     NEW
src/sources/edgar.js       NEW
src/sources/arxiv.js       + /html/{id} full text
src/sources/web.js         + result cache, host circuit breaker, lens fall-through
src/brain/pdftext.swift    NEW  PDFKit extractor, lazily built like brain.swift
bench/reader-probe.json    NEW  24 URLs + expected classes
bench/reader-probe.js      NEW  deterministic reader regression, CI-safe
bench/DRB_PROTOCOL.md      + judge panel rule, family constraint table
test/research.test.js      + citation binding, quote gate, stop conditions
```

### 7.3 The free metrics, in one place

Emitted to `run.json` on every run, printed by `pepper research --json`, and the
first thing to look at before paying for a judge:

```
citation-in-set rate      should be 1.000 by construction after R1
quote-gate pass rate      extraction fidelity; low ⇒ tighten the schema/prompt
evidence per checklist    coverage depth
distinct hosts per item   source diversity
coverage@stop             fraction of checklist items satisfied when the loop ended
read success rate         pages with ≥ MIN_TEXT / pages attempted
read precision            pages that yielded ≥1 gated quote / pages read
entailment pass rate      Gate 3, when enabled
schema-repair rate        per role — the R11 health signal
null-generation rate      per role — the other R11 health signal
wall clock, LLM calls     budget honesty
```

---

*Pepper is AGPL-3.0-only. So is this plan. MNN — all your models, all the time.*
