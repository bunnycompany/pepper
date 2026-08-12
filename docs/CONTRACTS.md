# Pepper — Build Contracts

This document is the single source of truth for every module in Pepper. If your
module talks to another module, the shapes and signatures here are law. If a
contract seems wrong, implement it as written and flag the concern in your
report — do not unilaterally change an interface another module depends on.

## 1. What Pepper is

Pepper is MNN's (the **Model News Network**) 24/7 research intern and on-air
anchor. She is an npm-installable agent (`@bunnycompany/pepper`, CLI `pepper`)
that:

1. **Tracks topics** ("beats") the user assigns her.
2. **Sweeps the wire** on an interval: Google News RSS, Hacker News (Algolia),
   and arXiv — no API keys, plain HTTPS.
3. **Writes a bulletin** with an LLM brain: Apple Foundation Models on-device
   first, optional local OpenAI-compatible endpoint (Ollama / LM Studio)
   second, template fallback last. Summarization never leaves the machine.
4. **Anchors the broadcast** in a 3D newsroom webapp (Three.js): a VRM avatar
   (user-supplied at `~/.pepper/avatar.vrm`) or a built-in stylized Pepper,
   behind an MNN desk, with chyron lower-thirds, a ticker, and browser TTS.
5. **Exports a static site** (`pepper export`) so the newsroom + latest
   bulletins can be hosted on any static host (Cloudflare Pages) where
   visitors watch her read the news. This is "broadcast mode".

License: **AGPL-3.0-only**. Platform: macOS gets the full experience
(FoundationModels + launchd); other platforms still work via local-LLM or
fallback brain.

## 2. Voice bible (persona)

Pepper: early-career broadcaster energy — crisp, warm, quick, a little
earnest. Broadcast register: short declarative sentences, present tense,
active voice. She attributes claims to named sources ("per TechCrunch",
"a paper posted to arXiv says"). She NEVER invents facts, numbers, or names
not present in the wire notes. At most one wink/personality beat per bulletin.
No emojis on air. No markdown on air. No stage directions.

Canonical lines (fallback pools reuse and extend these; keep this voice):

- Opens: "Good {tod}. You're at the MNN research desk — I'm Pepper, and here's
  what moved." / "This is MNN. I'm Pepper. {n} stories crossed the desk —
  let's get into it." / "From the MNN studio — I'm Pepper. The wire has been
  busy."
- Handoffs: "Meanwhile —" / "Turning to {topic} —" / "Now to the {topic}
  desk —" / "And this kept crossing the wire —"
- Sign-offs: "That's the sweep. I'm Pepper — back on the hour, every hour.
  MNN." / "The desk never closes. I'm Pepper, and this has been MNN." /
  "More as it develops. For MNN, I'm Pepper. Stay curious out there."
- Tagline: "MNN — all your models, all the time."

Moods (exactly these strings): `breaking` | `developing` | `steady` | `quirky`.

## 3. Repo layout & file ownership

Already written (READ these, do not modify): `package.json`, `src/config.js`,
`src/log.js`, `src/store.js`, `src/server.js`, `docs/CONTRACTS.md`.

| Module | Owns exactly these files |
|---|---|
| sources | `src/fetchx.js`, `src/sources/rss.js`, `src/sources/news.js`, `src/sources/hn.js`, `src/sources/arxiv.js`, `src/research.js`, `test/research.test.js` |
| brain | `src/brain/brain.swift`, `src/brain/index.js`, `test/brain.test.js` |
| scene | `web/newsroom.js` |
| overlay | `web/index.html`, `web/style.css`, `web/ui.js` |
| cli | `bin/pepper.js`, `src/daemon.js`, `src/terminal.js`, `src/export.js` |
| voice+docs | `src/anchor.js`, `README.md`, `LICENSE`, `docs/DEPLOY.md` |

Never write outside your list. Shared style: ESM (`"type": "module"`),
`node:` prefixed builtins, Node >= 18.17, **no new dependencies** (only
`three` and `@pixiv/three-vrm` exist, browser-side only). Small pure
functions. Catch errors at boundaries; a failed source or brain call must
never crash a cycle. Use `log` from `src/log.js` server-side. Two-space
indent, no semicolon-free style, no TypeScript.

## 4. Data shapes

```js
// Topic
{ slug, name, query, lenses: ['news','hn','arxiv'], addedAt, lastSweepAt, muted }

// Item (as stored; sources return everything except id/topic/seenAt)
{ id, topic, title, url, source, lens: 'news'|'hn'|'arxiv',
  publishedAt: iso|null, seenAt: iso, points?: number, snippet?: string }

// Bulletin
{
  id: 'b-20260812-183000',        // store.bulletinId()
  at: iso,
  brain: 'foundation'|'local'|'fallback',
  open: string,                    // cold-open line
  signoff: string,
  segments: [{
    slug, topic, mood,             // mood ∈ §2
    headline: string,              // punchy, ≤ 10 words, no trailing period
    handoff: string|null,          // said BEFORE this segment (null for first)
    script: [string],              // 3–5 sentences she reads
    sources: [{ title, url, source, lens }],   // ≤ 5
    freshCount: number
  }],
  stats: { topicsSwept, itemsSeen, freshItems }
}

// config.json defaults (src/config.js DEFAULTS)
{ port: 4747, intervalMinutes: 15, voice: { enabled, rate },
  brain: { prefer: 'foundation', local: { url: '', model: '' } },
  site: { title, tagline } }
```

`~/.pepper/` (override with env `PEPPER_HOME`): `config.json`, `topics.json`,
`items/<slug>.jsonl`, `bulletins/<id>.json` + `bulletins/index.json`,
`brain/pepper-brain` (built binary), `logs/`, `avatar.vrm`.

## 5. Module contracts

### 5.1 sources

`src/fetchx.js`:
```js
export async function fetchText(url, { timeoutMs = 15000 } = {})  // → string|null (null on any failure; one retry; UA 'pepper-mnn/0.1 (+https://github.com/bunnycompany/pepper)')
export async function fetchJSON(url, opts)                        // → parsed|null
```

`src/sources/rss.js` — tolerant, dependency-free RSS2/Atom parser:
```js
export function parseFeed(xml)  // → [{ title, url, source, publishedAt, snippet }]
```
Must handle: `<item>` and `<entry>`, CDATA, numeric + named entities
(`&amp; &lt; &gt; &quot; &#39; &#x2019;`…), Atom `<link href>`, RSS `<link>`,
`<pubDate>/<published>/<updated>`, Google News `<source>` tag, strip tags from
descriptions, collapse whitespace. Never throws on malformed XML — best effort.

`src/sources/news.js` / `hn.js` / `arxiv.js`:
```js
export async function fetchTopic(query)  // → Item[] (without id/topic/seenAt); [] on failure
```
- news: `https://news.google.com/rss/search?q=<enc>&hl=en-US&gl=US&ceid=US:en`,
  cap 12. Titles like "Headline - Source": strip trailing " - Source" into
  `source` when the `<source>` tag is absent. `lens:'news'`.
- hn: `https://hn.algolia.com/api/v1/search_by_date?query=<enc>&tags=story&hitsPerPage=10`,
  map hits → `{title, url: url||hn item link, source:'Hacker News', points, lens:'hn'}`.
- arxiv: `https://export.arxiv.org/api/query?search_query=all:%22<enc>%22&sortBy=submittedDate&sortOrder=descending&max_results=6`,
  Atom; `source:'arXiv'`, `snippet` = abstract first ~200 chars, normalize
  whitespace in titles. `lens:'arxiv'`.

`src/research.js`:
```js
export function buildDigest(topicName, items)  // → string, ≤ 2400 chars
export async function runCycle({ emit })       // emit(type, data)
```
`buildDigest` lines: `- [News] Title (Source, 3h ago)` / `- [HN 214pts] Title`
/ `- [arXiv] Title — first 140 chars of abstract`. Age from publishedAt when
parseable.

`runCycle` — IMPORTANT: lazily `await import('./brain/index.js')` and
`'./anchor.js'` INSIDE the function (parallel build + boot resilience):
1. Topics = `store.listTopics()` minus muted. If none → return `{ quiet: true, reason: 'no topics' }`.
2. Per topic sequentially: `Promise.allSettled` its lens fetchers; fresh =
   `store.appendItems(slug, items)`; `store.touchTopic(slug, { lastSweepAt })`;
   `emit('sweep', { slug, topic: name, fresh: fresh.length })`.
3. `emit('ticker', { items: store.allRecentItems(30).map(i => ({ title, source, topic: i.topicName, url })) })`.
4. Segments for topics with fresh items (first ever cycle: all topics, using
   `recentItems(slug, 10)`): digest → `brain.segment({ topic: name, digest })`;
   validate (headline nonempty string, script = 1–6 strings, mood ∈ §2) else
   `anchor.fallbackSegment(topic, items)`. Attach `sources` (top ≤ 5 items),
   `freshCount`. `emit('segment', { slug })`.
5. If any segments: order breaking > developing > quirky > steady, then by
   freshCount desc; set `handoff` = null for first, else
   `anchor.handoffFor(i, topicName)`; open/signoff =
   `await brain.anchor(ctx)` else `anchor.pickOpenSignoff(ctx)` where
   `ctx = { tod: 'morning'|'afternoon'|'evening', n: segments.length, topics: [names], busy: freshTotal >= 12 }`;
   bulletin = `anchor.composeBulletin({ open, signoff, segments, brainMode, stats })`;
   `store.saveBulletin(bulletin)`; `emit('bulletin', { id })`.
6. Return `{ fresh, segments: segments.length, bulletinId: id|null, quiet: false }`.
Do NOT emit `cycle-start` / `cycle-end` / `status` — the server does.

### 5.2 brain

`src/brain/index.js` exports `getBrain()` → singleton with:
```js
async status()    // → { mode: 'foundation'|'local'|'fallback', reason?: string }
async segment({ topic, digest })  // → { headline, script: [..], mood } | null
async anchor(ctx)                 // → { open, signoff } | null
async generate({ instructions, prompt, max })  // → string | null
async ask(q)      // → { answer, mode } | null   (context: latest ~12 tracked titles)
stop()
```
Never throws — `null` on any failure so callers fall back. Tier order (config
`brain.prefer` may force): 1) **foundation** — build & spawn the Swift
sidecar; 2) **local** — `config.brain.local.url` set → POST OpenAI-style
`/v1/chat/completions` (Ollama/LM Studio), extract JSON from reply
defensively; 3) **fallback** — segment/anchor/generate return null.

Sidecar: source `src/brain/brain.swift` (ships in the npm package), built
lazily to `~/.pepper/brain/pepper-brain` via
`swiftc -parse-as-library -O brain.swift -o pepper-brain`. Rebuild when a
sha256 fingerprint of the source (stored at `paths.brainFingerprint`) changes.
Build errors → `paths.brainBuildLog`, mode falls through to local/fallback.
Respawn on crash (max 3 rapid). Timeouts: status 20s, generation 90s → kill &
respawn on hang. Serialize requests (one at a time).

**JSONL protocol** (one JSON object per line, both directions, `id` echoes):
```
→ {"id":1,"op":"status"}
← {"id":1,"ok":true,"framework":true,"availability":"available"}   // or "unavailable" + "reason"
→ {"id":2,"op":"segment","topic":"...","digest":"..."}
← {"id":2,"ok":true,"headline":"...","script":["..."],"mood":"developing"}
→ {"id":3,"op":"anchor","context":"evening; 3 stories across beats: a, b; busy"}
← {"id":3,"ok":true,"open":"...","signoff":"..."}
→ {"id":4,"op":"generate","instructions":"...","prompt":"...","max":400}
← {"id":4,"ok":true,"text":"..."}
← {"id":N,"ok":false,"error":"..."}   // any failure, including guardrail trips
```

Swift side: `#if canImport(FoundationModels)` + `if #available(macOS 26.0, *)`
guards so it compiles anywhere; `@main` + `-parse-as-library`; line-buffered
stdout (`setvbuf`/`fflush`); fresh `LanguageModelSession(instructions:)` per
request; guided generation with `@Generable` structs for segment
(headline/script/mood — use `.anyOf` guide for mood) and anchor
(open/signoff); `GenerationOptions(temperature: 0.7, maximumResponseTokens: ~450)`.
Persona instructions = §2 voice bible (condensed). Segment prompt: wire notes
+ "Write Pepper's on-air segment for this beat. Pick the strongest
through-line and lead with it. 3 to 5 sentences. Mention at least one source
by name. If the notes are thin, say what the desk is watching for next."
Catch guardrail/context-window errors → `ok:false`. This machine: macOS 27,
Swift 6.4, CLT SDK, model **available** (verified).

### 5.3 server (written — read `src/server.js`)

HTTP 127.0.0.1:4747: `GET /api/state|/api/latest|/api/bulletins[?limit]|/api/bulletins/:id|/api/ticker|/api/topics`,
`POST /api/topics {name,lenses?}|/api/cycle|/api/ask {q}`,
`DELETE /api/topics/:slug`, `GET /api/events` (SSE), `GET /avatar.vrm`,
`/vendor/three.module.js`, `/vendor/three-vrm.module.js`, `/vendor/jsm/*`,
static `web/`. SSE events: `status`, `cycle-start`, `sweep`, `ticker`,
`segment`, `bulletin` (`{id}` — client fetches `/api/bulletins/:id`),
`cycle-end`, `topics`.

### 5.4 scene — `web/newsroom.js`

Three.js module (import `three`, `three/addons/loaders/GLTFLoader.js`,
`@pixiv/three-vrm` — **relative-path-safe**: importmap in index.html maps
these to `./vendor/...`). Renders into `<canvas id="scene">`, full-window,
DPR-capped at 2, handles resize. Sets `window.newsroom` synchronously at
module load with:

```js
window.newsroom = {
  ready,                 // Promise<void>, resolves when first frame rendered
  avatar,                // 'vrm' | 'builtin' (after trying GET ./avatar.vrm)
  setOnAir(bool),        // ON AIR sign + broadcast lighting
  setTalking(bool),      // mouth/viseme animation on-off
  setMood(mood),         // §2 mood or 'idle' — lighting accents, brows, pace
  showOpen({ title }),   // wall shows MNN title card
  showSegment({ topic, headline, mood, sources }),  // wall shows story card
  showIdle({ topics }),  // wall shows TOPIC WATCH list
  sweep(bool),           // researching visuals (screens flicker/scan)
  pulseBreaking(),       // red flash + antenna/hair spring
  gesture(name),         // 'shuffle'|'sip'|'nod'|'wave' — short one-shots
  cut(shot),             // 'wide'|'med'|'close'|'screen' camera preset
}
```

Avatar: try VRM at `./avatar.vrm` (GLTFLoader + VRMLoaderPlugin,
`VRMUtils.rotateVRM0`, expressionManager visemes `aa` for talking, `blink`,
`happy`; humanoid normalized bones for seated pose + idle sway + head
look-at). 404/error → built-in Pepper from primitives (chibi: cream skin,
big head, pepper-red bob + ahoge antenna, navy blazer, earpiece + mic boom,
blinking eyes, animated mouth). Either way she sits behind the MNN desk.
Studio: glossy dark floor, curved MNN desk with glowing red logo + nameplate,
coffee mug (steam when idle), paper stack, 3-screen curved video wall (canvas
textures), ON AIR box, studio spotlights, dust motes, subtle fog, mouse
parallax. Idle behaviors on timers: blink, sway, occasional sip/shuffle.
60fps target; no external assets, no network beyond ./avatar.vrm.

### 5.5 overlay — `web/index.html`, `web/style.css`, `web/ui.js`

index.html: importmap `{"three":"./vendor/three.module.js","three/addons/":"./vendor/jsm/","@pixiv/three-vrm":"./vendor/three-vrm.module.js"}`,
then `<script type="module" src="./newsroom.js">`, then `ui.js`. DOM ids
(shared with css/ui): `#scene` canvas; `#bug` (MNN logo + LIVE/REPLAY pill +
`#clock`); `#status-pill` (brain mode + next-sweep countdown); `#lower-third`
(`.kicker`, `.headline`, `.line`); `#ticker` (`.ticker-label` "MNN WIRE",
`.ticker-track`); `#panel` + `#panel-toggle` (topics CRUD, bulletin history,
voice settings, GO LIVE button, ask-Pepper box); `#join-gate` (JOIN BROADCAST
▶ — unlocks TTS); `#toast`. Broadcast-quality chyron styling: skewed red
kicker tag, white headline bar, ticker marquee. Dark studio aesthetic,
MNN red `#e02020`, cyan accent `#35d6ff`. `ui.js` waits for
`window.newsroom.ready`.

**Modes** (ui.js): try `GET ./api/state` (2s timeout). OK → **studio mode**:
SSE wiring, panel enabled, countdown, live bulletins autoplay. Fail → fetch
`./data/broadcast.json` → **broadcast mode**: panel hidden (except voice
toggle + past shows), REPLAY bug, loop the newest bulletin with idle gaps,
"recorded HH:MM" stamp. All fetches RELATIVE (`./api/...`) so any domain/path
works.

**Player** (both modes): for a Bulletin: `setOnAir(true)` → `showOpen` + speak
`open` → per segment: optional `handoff`, `cut()`, `showSegment`, kicker/
headline in chyron, speak each `script` line (type-on text, `setTalking`
around utterance) → speak `signoff`, `gesture('shuffle')`, `setOnAir(false)`,
idle. `pulseBreaking()` on breaking segments. TTS: `speechSynthesis`, prefer
premium en voices, rate from config, voice picker in panel; muted → time
lines at `max(1.4s, chars*55ms)`. During SSE `sweep`: `newsroom.sweep(true)`
+ status text "Sweeping: {topic}". New SSE `bulletin` → fetch, enqueue,
autoplay when idle. Keyboard: `g` go-live, `m` mute, `p` panel.

### 5.6 cli — `bin/pepper.js` (+`src/daemon.js`, `src/terminal.js`, `src/export.js`)

`#!/usr/bin/env node`. Commands:
`pepper` → status+help; `start [--port N] [--open]`; `open`; `status`;
`add <topic...> [--lens news,hn,arxiv]`; `drop <topic>`; `topics`;
`now` (server running → POST /api/cycle, else inline runCycle once);
`brief [--json|--speak]` (latest bulletin, ANSI-styled, `--speak` pipes to
macOS `say`); `ask <question...>`; `export [--out dir]`; `doctor`;
`daemon install|uninstall|status`; `version`; `help`. Port discovery for
client commands: try config port then +1..+10 `/healthz`. Banner on start
(chili 🌶 + MNN box, urls, topic count, brain mode). `daemon.js`: launchd
LaunchAgent `com.bunnycompany.pepper` via `launchctl bootstrap gui/$UID`
(fallback `load`), plist in `~/Library/LaunchAgents`, logs to
`~/.pepper/logs/`. `terminal.js`: `renderBrief(bulletin)` + `doctor()`
(node/macOS/swiftc versions, brain build+availability via getBrain().status(),
home writable, port, launchd state; each line ✓/✗/–). `export.js`:
`exportSite({ outDir })` → copy `web/*`, vendor files
(`three.module.js`, `three-vrm.module.js`, `jsm/loaders/GLTFLoader.js`,
`jsm/utils/BufferGeometryUtils.js` — preserve `vendor/jsm/...` layout),
`avatar.vrm` if present, and write `data/broadcast.json`:
`{ generatedAt, site, topics: [names], bulletins: [≤10 newest full Bulletins], ticker: [...] }`.
Print deploy hint (Cloudflare Pages).

### 5.7 voice+docs — `src/anchor.js`, `README.md`, `LICENSE`, `docs/DEPLOY.md`

`src/anchor.js`:
```js
export function pickOpenSignoff(ctx)      // → { open, signoff } from pools (≥8 each, §2 voice, use ctx.tod/n/topics)
export function handoffFor(i, topicName)  // → varied handoff string
export function fallbackSegment(topicName, items)  // → { headline, script, mood } — headline from top item ≤ 60 chars; script 2–4 lines from templates naming real titles/sources; mood: fresh ≥ 10 ? 'developing' : 'steady'
export function composeBulletin({ open, signoff, segments, brainMode, stats })  // → Bulletin (id via store.bulletinId(), at, brain: brainMode)
```
Deterministic-ish variety: rotate pools by hour/topic hash, not Math.random-
only. LICENSE: exact GNU AGPL-3.0 text (fetch https://www.gnu.org/licenses/agpl-3.0.txt).
README: hero + tagline, quickstart (`npm i -g @bunnycompany/pepper` /
`npx`), commands table, "How she works" ASCII pipeline, requirements matrix
(full: Apple Silicon + macOS 26+ + Apple Intelligence; local-LLM tier;
fallback), VRM avatar drop-in (`~/.pepper/avatar.vrm`), 24/7 via
`pepper daemon install`, privacy note, broadcast-mode deploy pointer,
AGPL-3.0 + "MNN — all your models, all the time." `docs/DEPLOY.md`:
`pepper export` → Cloudflare Pages (dashboard drag-drop + wrangler), custom
domain steps.

## 6. Verification duties

Every agent: `node --check` every JS file you write. sources: `npm test`
passes offline (test parseFeed fixtures RSS2+Atom+CDATA+entities, store dedupe
via appendItems with PEPPER_HOME=tmp, buildDigest cap). brain: compile the
sidecar for real, run a live JSONL status+segment round-trip on this machine
(model is available), include output in report; `npm test` for any pure-JS
helpers. cli: run help/version/topics/add/drop/brief with `PEPPER_HOME=$(mktemp -d)`.
scene/overlay: syntax-check only — visual iteration happens after integration.
Do not run the full server or start long-lived processes. Do not `git commit`,
`npm install`, or touch files you don't own. Report deviations honestly.
