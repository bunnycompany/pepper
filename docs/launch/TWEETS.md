# @pepper_research launch thread (draft)

Post only after the MoltBench gate passes; fill in the two {SCORE} figures.

---

**1/**
meet Pepper 🌶

she's a news anchor who lives on your Mac. every 15 minutes she sweeps the
wire, writes the bulletin with an on-device model, and reads it from a 3D
newsroom. no cloud. no API keys. no telemetry.

watch her live: pepper.watch
run your own: pepper.software

**2/**
she's open source (AGPL-3.0) and installs in 30 seconds:

curl -fsSL pepper.software | sh
pepper start

(or: npm i -g @pepperchan/pepper) — then just tell her what you care
about, in plain words, and she sets up her own desk.

Apple Foundation Models on Apple Silicon, your own Ollama/LM Studio anywhere
else, honest headlines-only mode on anything that runs Node.

**3/**
we also fine-tuned her a brain. pepper-desk is a 2B-class model trained on
her own broadcasts + a groomed truth-parsing dataset — every claim verified
against its sources, with explicit DESK NOTES reasoning before every report.

**4/**
"trained to be truthful" is a vibe, so we built a benchmark instead.

MoltBench: real wire bundles + deliberately contaminated ones. deterministic
grounding scores + blind judges. our first persona model FAILED it (38% vs
base 64.5%) — that failure set the release gate.

pepper-desk (2B, runs on a MacBook): 88.6% grounding, +23 points over its own untuned base. blind judges: 10/12 over the current Qwen3-4B, 11/12 over Qwen2.5-7B. a 12B of her own family beats her 10/12 — that's on the leaderboard too, because a benchmark that hides its ceiling is marketing.

**5/**
everything is reproducible on a Mac you own:
- code + bench: github.com/bunnycompany/pepper (AGPL-3.0)
- weights: huggingface.co/pepper-research — pepper-desk (Gemma terms) + pepper-7b (Apache-2.0)
- her voices: three designed identities, no human cloned

her lineage: chaotic VTuber → research anchor → language model. commit
history is a ghost story.

**6/**
she covered her own launch on the evening bulletin, obviously.

the desk never closes. 🌶
MNN — all your models, all the time.

---

## Spare material

- screenshot: docs/media/studio-vrm.png (her at the desk)
- the "she failed her own benchmark and we made that the gate" angle is the
  most quotable thing we have — keep it in the thread
- Show HN title: "Show HN: Pepper — an on-device AI news anchor with a
  benchmark she has to pass (AGPL)"
