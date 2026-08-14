# Hey Siri, ask Pepper

macOS 27's **Siri AI** (`/System/Applications/Siri AI.app`) lives in the App
Intents / Shortcuts ecosystem — which is the public seam Pepper plugs into.
No private APIs: Siri runs a Shortcut by voice, the Shortcut runs
`pepper research`, and Siri can read her findings back out loud.

## The Shortcut (one-time, ~60 seconds)

1. Open **Shortcuts** → New Shortcut, name it **“Pepper Research”**.
2. Add **Ask for Input** (Text) — prompt: “What should the desk dig into?”
3. Add **Run Shell Script** with:

   ```sh
   /usr/bin/env -S bash -lc 'pepper research "$1" --json' -- "$(cat)"
   ```

   - Shell: `bash` · Input: **Provided Input** → *as stdin* (`$(cat)` reads it)
   - If `pepper` isn’t on the Shortcut’s PATH, use the full path from
     `which pepper`.
4. Add **Get Dictionary Value** → key `report` (the `--json` output).
5. Add **Show Result** (or **Speak Text** — Siri reads her report aloud).

Then: **“Hey Siri, Pepper Research”** → dictate the question → she sweeps the
wire across multiple angles, writes the desk report on-device, files it as a
bulletin — and next time the studio is open, she presents it on air under the
DEEP DIVE kicker.

## What `pepper research` actually does

```
question
  → brain decomposes it into ~4 search angles
  → each angle sweeps Google News + Hacker News + arXiv (keyless HTTPS)
  → merged, deduped, ranked digest
  → DESK NOTES (private reasoning) + ON AIR report, written on-device
  → saved as a bulletin: she presents it in the newsroom
```

Direct use, no Siri required:

```sh
pepper research "what actually happened with the AISI agent evaluations"
```

`POST /api/research {"q": "…"}` does the same against a running studio, with
progress narrated over the studio's SSE stream.

## Notes

- Siri AI also registers the `siri://` URL scheme; its query grammar is
  undocumented, so the Shortcut path is the supported bridge for now.
- The report is only as good as the brain tier: Apple Foundation Models
  on-device is the intended experience; without any brain she returns an
  honest sources-only summary and says so.
