# Pepper's voices

Pepper has three official voice identities. All three are **designed voices**:
synthesized from natural-language descriptions by
`mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit` (Apache-2.0) on
2026-08-13. **No human being's voice was cloned or referenced.** The WAVs in
[`voices/`](../voices) are the golden reference clips — the canonical identity
of each voice — and the exact design instructs are preserved below so the
provenance is reproducible.

| Identity | File | Design instruct |
|---|---|---|
| `bright-anchor` (default) | `voices/bright-anchor.wav` | "Early-twenties female news anchor, bright and warm, quick energetic pacing, clear diction, slight anime-heroine brightness, a smile in the voice" |
| `calm-pro` | `voices/calm-pro.wav` | "Young female broadcaster, calm confident newsroom register, warm mid-tone, crisp consonants, gentle upbeat lilt at sentence ends" |
| `vtuber-spark` | `voices/vtuber-spark.wav` | "Energetic female VTuber host, playful sparkle, fast but articulate, youthful timbre, cheerful with a professional edge" |

## How they're used

**Today** the studio speaks with your browser's own speech synthesis
(`speechSynthesis`) — the golden clips define where her voice is *going*, and
`config.voice.identity` records the chosen identity.

**The local TTS tier** (roadmap) serves her real voice: an
[mlx-audio](https://github.com/Blaizzy/mlx-audio) server runs
`Qwen3-TTS-12Hz-0.6B-Base` (4-bit, ~2.3GB), zero-shot conditioned on the
selected golden clip, streaming sentence-chunked 24kHz audio to the newsroom;
[wawa-lipsync](https://github.com/wass08/wawa-lipsync) drives the VRM mouth
client-side. Low-power machines fall back to a Kokoro CoreML build on the
Apple Neural Engine, and the browser fallback remains `speechSynthesis` /
kokoro-js. Her `[HAPPY]`-class emotion tags map to per-sentence instruct
strings on the Qwen backend and to VRM expressions simultaneously.

## Compliance

Synthesized audio shipped to the public web must carry machine-readable
AI-generation marking (EU AI Act, Art. 50 — in force since 2026-08-02).
The local tier adds stream metadata at minimum; PerTh watermarking comes for
free if a Chatterbox-based tier ships.

## Changing or adding a voice

Design a new one (any M-series Mac, ~5GB free):

```sh
pip install mlx-audio
python -c "
from mlx_audio.tts.utils import load_model
m = load_model('mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit')
# iterate the generator; each chunk has .audio at 24kHz
"
```

Save the winning take as `voices/<identity>.wav`, add its instruct to the
table above, and never delete a shipped golden clip — visitors' Peppers
should not change voices retroactively without their operator choosing it.
