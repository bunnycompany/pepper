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

Every golden clip reads the same canonical passage, stored in
[`voices/transcripts.json`](../voices/transcripts.json) — the TTS worker
passes it as the reference transcript when conditioning on a clip. Switch
identity with `voice.identity` in `~/.pepper/config.json`
(`bright-anchor` is the default).

## Her real voice, on your machine

The local TTS tier has shipped. One command on any Apple Silicon Mac
(8GB is enough — that is the machine it was tuned on):

```sh
pepper voice install
```

What it does, in order, with honest failures at every step:

1. Finds a Python 3.10+ (Homebrew `python3.x` binaries preferred, newest
   first; 3.9 is rejected — mlx-audio needs 3.10).
2. Creates a venv at `~/.pepper/voice/venv`.
3. `pip install mlx-audio` into that venv — nothing touches your system
   Python.
4. Warms up `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit`, which downloads
   the weights once so her first broadcast doesn't stall.
5. Writes the ready marker `~/.pepper/voice/ready`.

`pepper voice status` shows the installed model, Python, and active identity;
`pepper doctor` grows a `voice` line; `pepper voice uninstall` removes
`~/.pepper/voice` entirely (rendered audio in `~/.pepper/audio` is kept —
delete it yourself to reclaim the space).

## How rendering works

When a bulletin is written, the server hands every line of the show to a
Python worker over the same line-oriented JSONL protocol the brain sidecar
uses. The worker runs Qwen3-TTS zero-shot: it conditions on the golden clip
for your configured identity plus its reference transcript, and writes one
24kHz mono 16-bit WAV per line into `~/.pepper/audio/<bulletinId>/`:

```
open.wav                  the cold open
<seg>-<line>.wav          each script line of each segment
handoff-<seg>.wav         the handoff before a segment, where one exists
signoff.wav               the sign-off
```

Once every line is on disk, the bulletin JSON gains `"audio": true` and the
studio hears an `audio-ready` event over SSE.

Measured on the 8GB M-series floor: real-time factor ≈ **1.25** (ten seconds
of Pepper takes about twelve and a half to render) and a warm model load of
≈ 2.4s. A full bulletin's audio lands shortly after the bulletin itself —
the newsroom never blocks on it.

## Fallback chain

Playback is per-file, so the chain degrades gracefully:

1. **Her real voice** — the webapp plays `./audio/<bulletinId>/<name>.wav`
   when the file exists.
2. **Browser TTS** — file missing (tier not installed, still rendering, or
   non-Apple hardware): `speechSynthesis` reads the line instead. The studio
   scores every available browser voice and auto-picks the best match for her
   register; the panel's voice picker lists candidates best-first. To raise
   that ceiling: on macOS download a premium voice once (System Settings →
   Accessibility → Spoken Content → System Voice → Manage Voices → **Ava** or
   **Zoe (Premium)**); Microsoft Edge ships free neural voices the picker
   ranks first automatically.

## Exports carry her voice

`pepper export` copies `~/.pepper/audio/<id>/` for every exported bulletin
into `<out>/audio/<id>/` (when it exists) and counts the WAVs in its summary.
The static site uses the same relative `./audio/...` URLs as the live studio,
so visitors to a deployed station — pepper.watch — hear her real voice.
Bulletins that were never rendered fall back to the visitor's browser TTS,
exactly like the live chain above.

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
table above, add its reference transcript to `voices/transcripts.json`, and
never delete a shipped golden clip — visitors' Peppers should not change
voices retroactively without their operator choosing it.
