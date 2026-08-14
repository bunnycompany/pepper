# Pepper launch plan

One rule above all: **the announcement leads with receipts.** The tweet does
not go out until pepper-desk has published MoltBench scores beating the base
model. "We made an anchor waifu" gets a day of attention; "our 2B on-device
researcher out-grounds its base model on a public benchmark, here's the
recipe" gets cited.

## Domain map

| Domain | Content | Source |
|---|---|---|
| pepper.software | Landing + install | `site/software/` |
| pepper.watch, pepper.移动 (`pepper.xn--6frz82g`) | The broadcast (static export) | `pepper export` |
| pepper.company | MNN, the "corporate entity" (lore page) | `site/company/` |
| pepper.ceo | Pepper's personal page | `site/ceo/` |
| pepper.cafe | → redirect to pepper.watch | Cloudflare rule |
| pepper.tools | → redirect to pepper.software | Cloudflare rule |
| pepper.fund | Parked (she covers markets; she does not run one) | — |

All served from Cloudflare Pages on the `bunny` account; refresh the watch
sites by re-running `pepper export` + `wrangler pages deploy`.

## Launch sequence

1. **T-0 prep (done / in flight)**
   - npm `@bunnycompany/pepper@0.0.1` — audited, staged; needs `npm login` + publish
   - Sites built and deployed (pages.dev), custom domains attached in dash
   - pepper-desk-e2b v2 training on the groomed think-then-speak dataset
2. **Gate** — MoltBench: pepper-desk must beat base Qwen-7B's 64.5% grounding
   with judges confirming persona + adjudication quality. Publish the run
   (bundles, outputs, scores) in `bench/`.
3. **Model day** — push `pepper-desk-e2b` (+ `pepper-7b` as the persona
   model) to Hugging Face under bunnycompany with the model card + bench
   receipts; update README + pepper.software with the HF links.
4. **Announce** — thread from @pepper_research (drafts in
   `docs/launch/TWEETS.md`), HN Show HN, and a bulletin where Pepper covers
   her own launch on pepper.watch (she would).

## What needs a human (account logins I don't hold)

- `npm login` → then `npm publish` in the repo root
- `huggingface-cli login` on m2 (models live there) → I stage the upload
- Twitter: paste the thread from TWEETS.md
- Cloudflare dash: attach custom domains to the four Pages projects
  (Workers & Pages → project → Custom domains → add; zones already active)

## Voice on launch day

Browser TTS ships day one (works for every visitor, zero infra). The designed
voice tier (Qwen3-TTS + golden clips in `voices/`) follows as a point release
so launch day has one story: the benchmarked researcher.
