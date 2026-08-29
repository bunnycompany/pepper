/* Pepper — MNN broadcast overlay logic.
   Studio mode: talks to the local pepper server (REST + SSE).
   Broadcast mode: replays exported bulletins from ./data/broadcast.json.
   All requests are RELATIVE so the app works from any domain or subpath. */

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Safe facade over window.newsroom — every call is optional and caught, so a
   missing or failing scene can never take down the overlay. */
const N = new Proxy({}, {
  get: (_t, name) => (...args) => {
    try {
      const nr = window.newsroom;
      if (nr && typeof nr[name] === 'function') return nr[name](...args);
    } catch (e) {
      console.warn('[ui] newsroom.' + String(name) + ' failed:', e);
    }
    return undefined;
  },
});

const els = {};

const state = {
  mode: 'studio',            // 'studio' | 'broadcast'
  site: { title: 'MNN — Model News Network', tagline: 'All your models. All the time.' },
  topics: [],
  freshBySlug: new Map(),
  researching: false,
  sweepText: '',
  nextCycleAt: null,
  unlocked: false,
  playing: false,
  playToken: 0,
  booted: null,            // null until bootStudio/bootBroadcast completes
  sseDown: false,
  lastSeenBulletinId: null,
  queue: [],
  idleTimers: [],
  voices: [],
  voiceURI: '',
  rate: 1.02,
  voiceOn: true,
  heardHerVoice: false,      // a rendered-voice bulletin has actually played
  lastPlayedId: null,        // broadcast replay rotation cursor
  noSignalToasted: false,    // 'no signal' toasts once; the pill carries it after
  broadcast: null,           // exported data blob in broadcast mode
  es: null,
  esBackoff: 1000,
  esTimer: null,
};

/* ---------- tiny helpers ---------- */

function hhmm(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return '--:--'; }
}

function shortDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hhmm(iso);
  } catch { return ''; }
}

// "recorded" stamps: time alone for today, date + time otherwise — a week-old
// recording must never masquerade as this morning's.
function stamp(iso) {
  try {
    const d = new Date(iso);
    if (d.toDateString() === new Date().toDateString()) return hhmm(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + hhmm(iso);
  } catch { return hhmm(iso); }
}

function fmtMSS(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

async function fetchJSON(url, { timeoutMs = 12000, method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    if (data === null) throw new Error('invalid response');
    return data;
  } finally {
    clearTimeout(t);
  }
}

let toastTimer = null;
function toast(msg) {
  if (!els.toast) return;
  els.toast.textContent = String(msg);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 4200);
}

function topicName(slug) {
  const t = state.topics.find((x) => x.slug === slug);
  return t ? t.name : null;
}

/* ---------- real wire stats → the studio's WIRE ACTIVITY wall ---------- */

function pushWireStats() {
  try {
    const beats = state.topics.filter((t) => !t.muted).map((t) => ({
      name: t.name,
      count: state.freshBySlug.get(t.slug) || 0,
    }));
    const fresh = beats.reduce((a, b) => a + b.count, 0);
    const perHour = Math.round(fresh * (60 / Math.max(3, state.intervalMinutes || 15)));
    // Until the first sweep reports real counts, the wall keeps its
    // decorative animation — an all-zero chart on boot reads as broken.
    if (!beats.length || fresh === 0) return;
    N.setWireStats({ beats, perHour });
  } catch { /* decorative wall keeps animating */ }
}

// The truth line in the voice panel: her rendered voice vs browser fallback.
function updateVoicePanel(bulletin) {
  if (!els.voiceActive) return;
  const hers = !!(bulletin && bulletin.audio);
  els.voiceActive.hidden = !hers;
  if (hers && els.voiceIdentity) {
    els.voiceIdentity.textContent = (state.voiceIdentity || 'bright-anchor');
  }
  if (hers) state.heardHerVoice = true;
  // "Fallback voice" only makes sense once a rendered-voice bulletin has
  // actually played — before that the picker IS the voice.
  if (els.voiceSelectLabel) {
    els.voiceSelectLabel.textContent = state.heardHerVoice ? 'Fallback voice' : 'Voice';
  }
  // The rate slider only drives browser TTS — while her rendered voice plays
  // it would be a dead control, so say why instead of looking broken.
  if (els.voiceRate) {
    els.voiceRate.disabled = hers;
    const row = els.voiceRate.closest('.row');
    if (row) row.title = hers ? 'Her rendered voice has its own pacing' : '';
  }
}

/* ---------- chyron ---------- */

let typeToken = 0;

function setChyron({ kicker, headline, nameplate = false, breaking = false, sources = null }) {
  els.lowerThird.classList.remove('hidden');
  els.lowerThird.classList.toggle('nameplate', !!nameplate);
  els.kicker.classList.toggle('breaking', !!breaking);
  if (kicker != null) els.kicker.textContent = kicker;
  if (headline != null) els.headline.textContent = headline;
  renderChyronSources(sources);
}

// "Sources named" should mean sources reachable: a credit strip under the
// chyron, linked where the wire kept a URL. Links go quiet while the line is
// still typing (CSS gates on .line.typing) so a mid-read tap can't misfire.
function renderChyronSources(sources) {
  const box = els.chyronSources;
  if (!box) return;
  box.textContent = '';
  const seen = new Set();
  const list = [];
  for (const s of (Array.isArray(sources) ? sources : [])) {
    const name = s && (s.source || s.title);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push({ name, url: (s && s.url) || null });
    if (list.length >= 4) break;
  }
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  const lab = document.createElement('span');
  lab.className = 'src-label';
  lab.textContent = 'SOURCES';
  box.append(lab);
  for (const s of list) {
    if (s.url) {
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = s.name;
      box.append(a);
    } else {
      const sp = document.createElement('span');
      sp.textContent = s.name;
      box.append(sp);
    }
  }
}

function clearLine() {
  typeToken += 1;
  els.line.classList.remove('typing');
  els.lineText.textContent = '';
}

function hideChyron() {
  els.lowerThird.classList.add('hidden');
  renderChyronSources(null);
  clearLine();
}

function typeOn(text) {
  const my = ++typeToken;
  els.line.classList.add('typing');
  els.lineText.textContent = '';
  const total = Math.min(1600, Math.max(350, text.length * 14));
  const tick = 24;
  const per = Math.max(1, Math.ceil((text.length * tick) / total));
  let i = 0;
  const iv = setInterval(() => {
    if (my !== typeToken) { clearInterval(iv); return; }
    i = Math.min(text.length, i + per);
    els.lineText.textContent = text.slice(0, i);
    if (i >= text.length) {
      clearInterval(iv);
      els.line.classList.remove('typing');
    }
  }, tick);
}

/* ---------- voice ---------- */

function loadVoices() {
  try {
    const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    if (vs.length) {
      state.voices = vs.slice();
      buildVoiceSelect();
    }
  } catch (e) {
    console.warn('[ui] voices unavailable:', e);
  }
}

// Score every voice for Pepper's register (young, bright, female, clear).
// Browsers hide their best voices behind terrible defaults: Edge ships
// excellent Microsoft "Natural" voices, macOS has Premium/Enhanced voices
// once downloaded (System Settings → Accessibility → Spoken Content), and
// every list is polluted with novelty voices that must never read the news.
export function scoreVoice(v) {
  const n = (v.name || '').toLowerCase();
  if (!/^en/i.test(v.lang || '')) return -100;
  let s = 0;
  if (/\b(aria|jenny|michelle|emma|ana|sonia|libby)\b/.test(n) && /natural|online/.test(n)) s += 90;
  if (/siri/.test(n)) s += 45;
  if (/\b(ava|zoe|samantha|allison)\b/.test(n)) s += 55;
  if (/\b(serena|karen|moira|susan|kate|stephanie|tessa)\b/.test(n)) s += 35;
  if (/premium/.test(n)) s += 35;
  if (/enhanced/.test(n)) s += 25;
  if (/natural|neural/.test(n)) s += 20;
  if (/female/.test(n)) s += 10;
  if (/^en-us/i.test(v.lang)) s += 8;
  else if (/^en-(gb|au|ie|nz)/i.test(v.lang)) s += 4;
  if (v.localService) s += 6;
  if (/google (us|uk) english/.test(n)) s -= 25;
  if (/\bmale\b/.test(n) && !/female/.test(n)) s -= 12;
  if (/\b(fred|albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|kathy|grandma|grandpa|rocko|shelley|flo|eddy|reed|sandy)\b/.test(n)) s -= 80;
  return s;
}

function pickVoice() {
  const vs = state.voices;
  if (!vs.length) return null;
  if (state.voiceURI) {
    const chosen = vs.find((v) => v.voiceURI === state.voiceURI);
    if (chosen) return chosen;
  }
  return vs.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
}

function buildVoiceSelect() {
  const sel = els.voiceSelect;
  if (!sel) return;
  const current = state.voiceURI || ((pickVoice() || {}).voiceURI || '');
  sel.textContent = '';
  const mk = (v) => {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = v.name + ' (' + v.lang + ')';
    if (v.voiceURI === current) o.selected = true;
    return o;
  };
  // Best candidates first — visitors shouldn't have to dig for a good one.
  const en = state.voices.filter((v) => /^en/i.test(v.lang))
    .sort((a, b) => scoreVoice(b) - scoreVoice(a));
  const rest = state.voices.filter((v) => !/^en/i.test(v.lang));
  for (const v of en) sel.append(mk(v));
  if (rest.length) {
    const og = document.createElement('optgroup');
    og.label = 'Other languages';
    for (const v of rest) og.append(mk(v));
    sel.append(og);
  }
}

function applyVoiceConfig(v) {
  let stored = null;
  try {
    stored = localStorage.getItem('pepper.voiceOn');
    state.voiceURI = localStorage.getItem('pepper.voice') || '';
    const r = Number(localStorage.getItem('pepper.rate'));
    state.rate = r > 0 ? r : ((v && Number(v.rate)) || 1.02);
  } catch {
    state.rate = (v && Number(v.rate)) || 1.02;
  }
  state.voiceOn = stored != null ? stored === '1' : !(v && v.enabled === false);
  els.voiceEnabled.checked = state.voiceOn;
  els.voiceRate.value = String(state.rate);
  els.rateVal.textContent = state.rate.toFixed(2) + '×';
  updateMuteChip();
}

// Muted must never look broken: a persistent on-stage chip carries the state
// (including a mute remembered from a previous session) and unmutes on tap.
function updateMuteChip() {
  if (els.muteChip) els.muteChip.hidden = !!state.voiceOn;
}

function setVoiceOn(on) {
  state.voiceOn = !!on;
  try { localStorage.setItem('pepper.voiceOn', on ? '1' : '0'); } catch {}
  els.voiceEnabled.checked = state.voiceOn;
  updateMuteChip();
  if (!on) {
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch {}
    stopLineAudio();
  }
}

function utter(text) {
  return new Promise((resolve) => {
    let done = false;
    let guard = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = state.rate;
      u.pitch = 1.02;
      u.onend = finish;
      u.onerror = finish;
      guard = setTimeout(finish, Math.max(6000, text.length * 130));
      speechSynthesis.speak(u);
    } catch {
      finish();
    }
  });
}

async function speakLine(text, token = null) {
  if (text == null) return;
  const clean = String(text).trim();
  if (!clean) return;
  typeOn(clean);
  // Embeds are always silent: captions and lip-sync run, audio never does.
  const embedded = document.documentElement.classList.contains('embed');
  const voiced = !embedded && state.voiceOn && 'speechSynthesis' in window;
  N.setTalking(true);
  try {
    if (voiced) await utter(clean);
    else await sleep(Math.max(1400, clean.length * 55));
  } finally {
    // A superseded playback's line must not shut the mouth of the one that
    // replaced it (cancelled utterances settle late; muted sleeps later still).
    if (token == null || token === state.playToken) N.setTalking(false);
  }
  await sleep(180);
}

/* ---------- her real voice: rendered audio files ---------- */

/* When the server has rendered a bulletin with Pepper's cloned voice
   (bulletin.audio === true), each line prefers its WAV over browser TTS:
     ./audio/<bulletinId>/open.wav
     ./audio/<bulletinId>/handoff-<segIdx>.wav   (only where segment.handoff)
     ./audio/<bulletinId>/<segIdx>-<lineIdx>.wav
     ./audio/<bulletinId>/signoff.wav
   URLs are relative, so the same scheme works against the studio server and
   on the exported static broadcast site. Any file that is missing or fails
   to play falls back to the speakLine TTS path for that line only. */

/* One shared AudioContext, created and resume()d inside the JOIN tap: iOS
   Safari treats the whole context as user-activated from then on, so every
   later line plays in her real voice — a fresh Audio() element per line loses
   the activation after the first await and degrades to TTS. (A single graph
   also gives mouth-sync somewhere to tap later.) The <audio>-element path
   below stays as the fallback for browsers without WebAudio. */

let audioCtx = null;
let currentAudio = null;  // { el, finish } for the <audio> line playing right now
let currentSource = null; // { src, finish } for the WebAudio line playing right now
let lineAudioGen = 0;     // bumped by stopLineAudio: a line still decoding when
                          // the stop landed must never start playing afterwards

function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  } catch { audioCtx = null; }
  return audioCtx;
}

function stopLineAudio() {
  lineAudioGen += 1;
  const s = currentSource;
  if (s) {
    currentSource = null;
    s.finish(true); // deliberate stop — settle the line, no TTS fallback
  }
  const a = currentAudio;
  if (!a) return;
  currentAudio = null;
  try { a.el.pause(); } catch {}
  a.finish(true); // deliberate stop — settle the line, no TTS fallback
}

async function playAudioBuffer(url, text) {
  // WebAudio path. Resolves true/false like playAudioElement; resolves null
  // when this path is unavailable and the caller should try the element path.
  const ctx = audioCtx;
  if (!ctx || ctx.state === 'closed') return null;
  try { if (ctx.state === 'suspended') await ctx.resume(); } catch {}
  if (ctx.state !== 'running') return null;
  const gen = lineAudioGen;
  const cap = Math.max(8000, String(text || '').length * 130);
  let buf = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), cap);
    let raw = null;
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) return false;
      raw = await res.arrayBuffer();
    } finally {
      clearTimeout(t);
    }
    buf = await new Promise((resolve, reject) => ctx.decodeAudioData(raw, resolve, reject));
  } catch {
    return false; // missing/broken file — caller falls back to TTS
  }
  // A skip or mute landed while we were fetching/decoding — settle as a
  // deliberate stop (true) so the caller never falls back to TTS for it.
  if (gen !== lineAudioGen) return true;
  return new Promise((resolve) => {
    let done = false;
    let guard = null;
    const src = ctx.createBufferSource();
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      if (currentSource && currentSource.src === src) currentSource = null;
      try { src.stop(); } catch {}
      resolve(ok);
    };
    currentSource = { src, finish };
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => finish(true);
    guard = setTimeout(() => finish(true), Math.max(8000, buf.duration * 2000));
    try { src.start(); } catch { finish(false); }
  });
}

async function playAudioFile(url, text) {
  const viaCtx = await playAudioBuffer(url, text);
  if (viaCtx !== null) return viaCtx;
  return playAudioElement(url, text);
}

function playAudioElement(url, text) {
  // Resolves true when playback completed (or was deliberately stopped, or
  // the guard cap expired), false when the file failed to load or play —
  // the caller falls back to TTS only on false.
  return new Promise((resolve) => {
    let done = false;
    let guard = null;
    let el = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      if (currentAudio && currentAudio.el === el) currentAudio = null;
      if (el) { try { el.pause(); } catch {} }
      resolve(ok);
    };
    try {
      if (document.documentElement.classList.contains('embed')) { finish(false); return; }
      el = new Audio();
      currentAudio = { el, finish };
      el.preload = 'auto';
      el.addEventListener('ended', () => finish(true));
      el.addEventListener('error', () => finish(false));
      el.addEventListener('loadedmetadata', () => {
        // Real duration known — tighten the guard to max(8s, duration × 2).
        if (done || !Number.isFinite(el.duration) || el.duration <= 0) return;
        clearTimeout(guard);
        guard = setTimeout(() => finish(true), Math.max(8000, el.duration * 2000));
      });
      guard = setTimeout(() => finish(true), Math.max(8000, String(text || '').length * 130));
      el.src = url;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function playLineAudio(url, text, token = null) {
  if (text == null) return;
  const clean = String(text).trim();
  if (!clean) return;
  // Muted → the same silently-timed path the TTS route takes.
  if (!state.voiceOn) return speakLine(clean, token);
  typeOn(clean);
  N.setTalking(true);
  let ok = false;
  try {
    ok = await playAudioFile(url, clean);
  } finally {
    // Same guard as speakLine: a superseded playback's line must not shut
    // the mouth of the one that replaced it.
    if (token == null || token === state.playToken) N.setTalking(false);
  }
  if (!ok) {
    // Missing or broken file. Fall back to TTS for this line — unless this
    // playback was superseded, where speaking would talk over its successor.
    if (token != null && token !== state.playToken) return;
    await speakLine(clean, token);
    return;
  }
  await sleep(180);
}

/* ---------- player ---------- */

function setPill(kind) {
  els.livePill.classList.toggle('live', kind === 'live');
  els.livePill.classList.toggle('replay', kind !== 'live');
  els.pillText.textContent = kind === 'live' ? 'LIVE' : 'REPLAY';
}

function enqueue(b) {
  if (!b || !b.id || !Array.isArray(b.segments)) return;
  if (state.queue.some((x) => x.id === b.id)) return;
  state.queue.push(b);
  while (state.queue.length > 3) state.queue.shift();
  maybePlay();
}

function maybePlay() {
  if (!state.unlocked || state.playing) return false;
  const next = state.queue.shift();
  if (!next) return false;
  playBulletin(next, { replay: state.mode === 'broadcast' });
  return true;
}

function playNow(b, opts = {}) {
  clearIdle();
  state.queue.length = 0;
  try { window.speechSynthesis && speechSynthesis.cancel(); } catch {}
  stopLineAudio();
  playBulletin(b, { replay: true, ...opts });
}

// Deliberate skip (the ⏭ next to the bug): supersede the running playback,
// settle the stage, and let afterPlayback pick up the queue or the idle desk.
function skipPlayback() {
  if (!state.playing) return;
  state.playToken += 1;
  try { window.speechSynthesis && speechSynthesis.cancel(); } catch {}
  stopLineAudio();
  state.playing = false;
  N.setTalking(false);
  N.setOnAir(false);
  hideChyron();
  afterPlayback();
}

const SHOTS = ['med', 'close', 'screen', 'close'];

async function playBulletin(b, { replay = false } = {}) {
  if (!b || !Array.isArray(b.segments)) return;
  updateVoicePanel(b);
  const my = ++state.playToken;
  clearIdle();
  state.playing = true;
  if (b.id) state.lastPlayedId = b.id;
  if (els.skipBtn) els.skipBtn.hidden = false;
  setPill(replay || state.mode === 'broadcast' ? 'replay' : 'live');
  // Rendered-voice bulletins (audio: true) prefer their per-line WAVs; every
  // other bulletin — and every line whose file fails — uses browser TTS.
  const hasAudio = b.audio === true && b.id;
  const say = (text, name) => (hasAudio
    ? playLineAudio('./audio/' + encodeURIComponent(b.id) + '/' + name + '.wav', text, my)
    : speakLine(text, my));
  try {
    N.setMood('steady');
    N.setOnAir(true);
    N.cut('wide');
    N.showOpen({ title: state.site.title });
    setChyron({
      kicker: replay ? 'REPLAY · recorded ' + stamp(b.at) : 'MNN LIVE',
      headline: state.site.title,
    });
    await say(b.open, 'open');
    if (my !== state.playToken) return;

    for (let i = 0; i < b.segments.length; i++) {
      const seg = b.segments[i];
      if (my !== state.playToken) return;
      if (seg.handoff) {
        await say(seg.handoff, 'handoff-' + i);
        if (my !== state.playToken) return;
      }
      N.setMood(seg.mood);
      if (seg.mood === 'breaking') N.pulseBreaking();
      N.cut('med');
      N.showSegment({
        topic: seg.topic,
        headline: seg.headline,
        mood: seg.mood,
        sources: seg.sources || [],
      });
      const breaking = seg.mood === 'breaking';
      setChyron({
        kicker: breaking ? 'BREAKING · ' + seg.topic : seg.topic,
        headline: seg.headline,
        breaking,
        sources: seg.sources || [],
      });
      const script = Array.isArray(seg.script) ? seg.script : [];
      for (let j = 0; j < script.length; j++) {
        if (my !== state.playToken) return;
        if (j > 0) N.cut(SHOTS[j % SHOTS.length]);
        await say(script[j], i + '-' + j);
      }
    }

    if (my !== state.playToken) return;
    N.setMood('steady');
    N.cut('med');
    setChyron({ kicker: 'MNN', headline: state.site.tagline || 'All your models. All the time.' });
    await say(b.signoff, 'signoff');
    if (my !== state.playToken) return;
    N.gesture('shuffle');
    await sleep(700);
  } catch (e) {
    console.warn('[ui] playback error:', e);
  } finally {
    if (my === state.playToken) {
      state.playing = false;
      N.setOnAir(false);
      hideChyron();
      afterPlayback();
    }
  }
}

function afterPlayback() {
  // History replays flip the bug to REPLAY; put the station back on its
  // real footing once playback ends.
  setPill(state.mode === 'broadcast' ? 'replay' : 'live');
  if (els.skipBtn) els.skipBtn.hidden = true;
  updateVoicePanel(null); // re-arm the rate slider once her rendered voice stops
  if (state.queue.length && state.unlocked) {
    maybePlay();
    return;
  }
  startIdle();
  if (state.mode === 'broadcast') scheduleReplayLoop();
}

/* ---------- idle desk ---------- */

function startIdle() {
  N.setMood('idle');
  N.cut('wide');
  N.showIdle({ topics: state.topics.filter((t) => !t.muted).map((t) => t.name) });
  setChyron({ kicker: 'ON THE DESK', headline: 'PEPPER · MNN RESEARCH DESK', nameplate: true });
  clearLine();
  const sip = setInterval(() => {
    if (!state.playing) N.gesture(Math.random() < 0.72 ? 'sip' : 'shuffle');
  }, 28000 + Math.random() * 18000);
  state.idleTimers.push(sip);
}

function clearIdle() {
  for (const t of state.idleTimers) { clearTimeout(t); clearInterval(t); }
  state.idleTimers = [];
}

function scheduleReplayLoop() {
  const gap = 20000 + Math.random() * 5000;
  const t = setTimeout(() => {
    // Rotate through the whole exported archive, newest first — a lingering
    // visitor gets a channel, not the newest show on an endless loop.
    const list = ((state.broadcast || {}).bulletins || []);
    if (!list.length || state.playing || !state.unlocked) return;
    const at = list.findIndex((b) => b && b.id === state.lastPlayedId);
    playBulletin(list[(at + 1) % list.length], { replay: true });
  }, gap);
  state.idleTimers.push(t);
}

/* ---------- status pill / countdown / clock ---------- */

function brainLabel(brain) {
  const mode = brain && brain.mode;
  if (mode === 'foundation') return '🧠 on-device';
  if (mode === 'local') return '🖥 local model';
  return '📋 headlines';
}

function applyStatus(d) {
  if (!d) return;
  if ('researching' in d) {
    state.researching = !!d.researching;
    if (!state.researching) { N.sweep(false); state.sweepText = ''; }
    setGoLiveButton();
  }
  if ('nextCycleAt' in d) state.nextCycleAt = d.nextCycleAt;
  if (d.brain) els.brainMode.textContent = brainLabel(d.brain);
  // Bulletins published while the SSE stream was down only surface here:
  // every reconnect's status push carries latestBulletinId.
  if (state.mode === 'studio' && d.latestBulletinId
    && d.latestBulletinId !== state.lastSeenBulletinId) {
    state.lastSeenBulletinId = d.latestBulletinId;
    fetchJSON('./api/bulletins/' + encodeURIComponent(d.latestBulletinId))
      .then((b) => { enqueue(b); refreshHistory(); })
      .catch(() => {});
  }
}

function tickCountdown() {
  // Pre-boot the pill belongs to detectAndBoot ('tuning in…' / 'no signal —
  // retrying…') — the countdown must not overwrite it with 'standing by'.
  if (!state.booted) return;
  if (state.mode === 'broadcast') return;
  if (state.sseDown) {
    els.sweepStatus.classList.remove('shimmer');
    els.sweepStatus.textContent = 'reconnecting…';
    return;
  }
  if (state.researching) {
    els.sweepStatus.textContent = state.sweepText || 'sweeping…';
    els.sweepStatus.classList.add('shimmer');
    return;
  }
  els.sweepStatus.classList.remove('shimmer');
  if (!state.nextCycleAt) {
    els.sweepStatus.textContent = 'standing by';
    return;
  }
  const ms = new Date(state.nextCycleAt).getTime() - Date.now();
  els.sweepStatus.textContent = ms <= 0 ? 'any second…' : 'next sweep in ' + fmtMSS(ms);
}

function tickClock() {
  els.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------- ticker ---------- */

function renderTicker(items) {
  let list = (Array.isArray(items) ? items : [])
    .map((i) => ({ title: i && i.title, source: i && i.source }))
    .filter((i) => i.title);
  if (!list.length) {
    list = [{ title: 'MNN — all your models, all the time.', source: 'MNN' }];
  }
  while (list.length < 10) list = list.concat(list);
  const half = document.createElement('div');
  half.className = 'ticker-half';
  for (const it of list) {
    const s = document.createElement('span');
    s.className = 'tick';
    const b = document.createElement('b');
    b.textContent = it.title;
    s.append(b);
    if (it.source) {
      const src = document.createElement('span');
      src.className = 'src';
      src.textContent = ' — ' + it.source;
      s.append(src);
    }
    half.append(s);
  }
  els.tickerTrack.textContent = '';
  els.tickerTrack.append(half, half.cloneNode(true));
  els.tickerTrack.style.animationDuration = Math.max(30, list.length * 5) + 's';
}

async function refreshTicker() {
  try {
    const r = await fetchJSON('./api/ticker');
    renderTicker(r.items || []);
  } catch (e) {
    console.warn('[ui] ticker fetch failed:', e);
  }
}

/* ---------- topics ---------- */

function renderTopics(topics) {
  if (Array.isArray(topics)) state.topics = topics;
  const ul = els.topicList;
  if (!ul) return;
  ul.textContent = '';
  if (!state.topics.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No beats yet — add one below.';
    ul.append(li);
    return;
  }
  for (const t of state.topics) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 't-name';
    name.textContent = t.name;
    li.append(name);
    const fresh = state.freshBySlug.get(t.slug) || 0;
    if (fresh > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '+' + fresh + ' fresh';
      li.append(badge);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 't-del';
    del.dataset.slug = t.slug;
    del.textContent = '✕';
    del.title = 'Drop “' + t.name + '”';
    li.append(del);
    ul.append(li);
  }
}

/* ---------- history ---------- */

function bulletinMeta(b) {
  return {
    id: b.id,
    at: b.at,
    brain: b.brain,
    segments: (b.segments || []).map((s) => ({ topic: s.topic, headline: s.headline, mood: s.mood })),
  };
}

function renderHistory(list) {
  const ul = els.historyList;
  ul.textContent = '';
  if (!Array.isArray(list) || !list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No bulletins yet.';
    ul.append(li);
    return;
  }
  for (const m of list) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'h-item';
    btn.dataset.id = m.id;
    const time = document.createElement('span');
    time.className = 'h-time';
    time.textContent = shortDate(m.at);
    const head = document.createElement('span');
    head.className = 'h-head';
    const first = (m.segments && m.segments[0]) || {};
    head.textContent = first.headline || 'Bulletin';
    const count = document.createElement('span');
    count.className = 'h-count';
    count.textContent = (m.segments ? m.segments.length : 0) + ' seg';
    btn.append(time, head, count);
    li.append(btn);
    ul.append(li);
  }
}

async function refreshHistory() {
  try {
    const list = await fetchJSON('./api/bulletins?limit=20');
    renderHistory(list);
  } catch (e) {
    console.warn('[ui] history fetch failed:', e);
  }
}

/* ---------- SSE (studio) ---------- */

function closeSSE() {
  if (state.es) {
    try { state.es.close(); } catch {}
    state.es = null;
  }
  clearTimeout(state.esTimer);
}

function scheduleReconnect() {
  clearTimeout(state.esTimer);
  state.esTimer = setTimeout(connectSSE, state.esBackoff);
  state.esBackoff = Math.min(state.esBackoff * 2, 30000);
}

function connectSSE() {
  closeSSE();
  let es;
  try {
    es = new EventSource('./api/events');
  } catch (e) {
    console.warn('[ui] SSE failed to open:', e);
    return scheduleReconnect();
  }
  state.es = es;
  es.onopen = () => { state.esBackoff = 1000; state.sseDown = false; };
  es.onerror = () => {
    closeSSE();
    // A mid-cycle disconnect would otherwise leave researching=true forever
    // (cycle-end can never arrive), freezing "sweeping…" and GO LIVE.
    state.sseDown = true;
    state.researching = false;
    state.sweepText = '';
    N.sweep(false);
    setGoLiveButton();
    els.sweepStatus.classList.remove('shimmer');
    els.sweepStatus.textContent = 'reconnecting…';
    scheduleReconnect();
  };
  const on = (type, fn) => es.addEventListener(type, (ev) => {
    let data = null;
    try { data = ev.data ? JSON.parse(ev.data) : null; } catch {}
    try { fn(data); } catch (e) { console.warn('[ui] SSE ' + type + ' handler:', e); }
  });

  on('status', (d) => applyStatus(d));

  on('cycle-start', () => {
    state.researching = true;
    state.sweepText = 'sweeping…';
    N.sweep(true);
    setGoLiveButton();
  });

  on('sweep', (d) => {
    state.sweepText = 'sweeping: ' + ((d && (d.topic || d.slug)) || '…');
    if (d && d.slug != null) state.freshBySlug.set(d.slug, d.fresh || 0);
    renderTopics();
    pushWireStats();
  });

  on('ticker', (d) => renderTicker((d && d.items) || []));

  on('segment', (d) => {
    const slug = d && d.slug;
    state.sweepText = 'writing: ' + (topicName(slug) || slug || 'segment');
  });

  on('bulletin', async (d) => {
    if (!d || !d.id) return;
    state.lastSeenBulletinId = d.id;
    try {
      const b = await fetchJSON('./api/bulletins/' + encodeURIComponent(d.id));
      enqueue(b);
      refreshHistory();
    } catch (e) {
      toast('Could not fetch the new bulletin: ' + e.message);
    }
  });

  // The voice worker finished rendering a bulletin's WAVs after we queued it.
  // If it is still waiting its turn, swap in the voiced copy so it plays with
  // her real voice instead of browser TTS. Already-playing bulletins are left
  // alone — restarting mid-show would be worse than finishing unvoiced.
  on('audio-ready', async (d) => {
    if (!d || !d.id) return;
    if (!state.queue.some((x) => x.id === d.id)) return;
    try {
      const b = await fetchJSON('./api/bulletins/' + encodeURIComponent(d.id));
      // Re-find after the await — the queue may have shifted meanwhile.
      const at = state.queue.findIndex((x) => x.id === d.id);
      if (at !== -1) state.queue[at] = b;
    } catch (e) {
      console.warn('[ui] audio-ready refetch failed:', e);
    }
  });

  on('cycle-end', (d) => {
    state.researching = false;
    state.sweepText = '';
    N.sweep(false);
    setGoLiveButton();
    // A sweep that died must not look identical to a quiet news day.
    if (d && d.error) toast('Sweep failed: ' + d.error);
  });

  on('research-sweep', (d) => {
    if (state.researchBubble && d && d.query) {
      state.researchBubble.textContent = 'Deep dive — sweeping: ' + d.query;
    }
  });
  on('research-done', () => {
    if (state.researchBubble) {
      state.researchBubble.classList.remove('thinking');
      state.researchBubble.textContent = 'Filed. Watch the desk — I\'ll present it in a moment.';
      state.researchBubble = null;
    }
  });

  on('topics', (d) => {
    renderTopics((d && d.topics) || []);
    if (!state.playing) {
      N.showIdle({ topics: state.topics.filter((t) => !t.muted).map((t) => t.name) });
    }
  });
}

/* ---------- actions ---------- */

function setGoLiveButton() {
  if (!els.goLive) return;
  els.goLive.disabled = state.researching;
  els.goLive.textContent = state.researching ? 'SWEEPING…' : 'GO LIVE NOW';
}

async function goLive() {
  if (state.mode !== 'studio') {
    toast('Replay mode — the live desk is closed here.');
    return;
  }
  if (!state.topics.length) {
    // A sweep with no beats ends in silence — say so and put the cursor
    // where the fix is.
    toast('She needs a beat first — add a topic and she\'ll sweep it.');
    togglePanel(true);
    if (els.topicInput) els.topicInput.focus();
    return;
  }
  if (state.researching) {
    toast('Already sweeping the wire.');
    return;
  }
  try {
    await fetchJSON('./api/cycle', { method: 'POST' });
    toast('Sweeping the wire…');
  } catch (e) {
    toast(e.status === 409 ? 'Already sweeping the wire.' : 'Could not start a sweep: ' + e.message);
  }
}

function togglePanel(force) {
  const open = els.panel.classList.toggle('open', force);
  if (els.panelScrim) els.panelScrim.classList.toggle('open', open);
}

function bubble(kind, text) {
  const d = document.createElement('div');
  d.className = 'bubble ' + kind;
  d.textContent = text;
  els.askLog.append(d);
  els.askLog.scrollTop = els.askLog.scrollHeight;
  return d;
}

/* ---------- boot: studio ---------- */

async function bootStudio(st) {
  state.mode = 'studio';
  document.body.classList.add('mode-studio');
  state.intervalMinutes = st.intervalMinutes || 15;
  state.voiceIdentity = (st.voice && st.voice.identity) || 'bright-anchor';
  if (st.site) state.site = { ...state.site, ...st.site };
  document.title = state.site.title;
  setPill('live');
  applyVoiceConfig(st.voice);
  applyStatus(st);
  renderTopics(st.topics || []);
  // Populate the TOPIC WATCH wall immediately — playback can start before
  // the first idle period, and the wall must never show the boot placeholder.
  N.showIdle({ topics: (st.topics || []).filter((t) => !t.muted).map((t) => t.name) });
  setGoLiveButton();
  refreshHistory();
  refreshTicker();
  connectSSE();
  if (st.latestBulletinId) {
    state.lastSeenBulletinId = st.latestBulletinId;
    try {
      const b = await fetchJSON('./api/bulletins/' + encodeURIComponent(st.latestBulletinId));
      enqueue(b);
    } catch (e) {
      console.warn('[ui] latest bulletin fetch failed:', e);
    }
  }
  state.booted = 'studio';
  // First-day onboarding: no beats yet → she introduces herself and asks.
  if (!state.topics.length) {
    togglePanel(true);
    if (els.askInput) els.askInput.placeholder = 'e.g. "local AI, robotics, weird internet stuff"';
    bubble('pepper', 'First day on the desk! Tell me what you care about — plain words are fine — and I\'ll set up my beats and get to work.');
  }
  // If JOIN was clicked while we were still booting, start now.
  if (state.unlocked && !state.playing && !maybePlay()) startIdle();
}

/* ---------- boot: broadcast ---------- */

async function bootBroadcast(data) {
  state.mode = 'broadcast';
  document.body.classList.add('mode-broadcast');
  state.broadcast = data;
  if (data.site) state.site = { ...state.site, ...data.site };
  document.title = state.site.title;
  state.topics = (data.topics || []).map((name) => ({ slug: String(name), name: String(name), muted: false }));
  applyVoiceConfig(null);
  setPill('replay');
  const bulletins = Array.isArray(data.bulletins) ? data.bulletins : [];
  const newest = bulletins[0] || null;
  // Visitors don't know brain tiers — tell them what they'll actually hear.
  els.brainMode.textContent = newest
    ? (newest.audio === true ? '🎙 her own voice' : '🗣 browser voice')
    : '📼 archive';
  els.sweepStatus.textContent = newest ? 'recorded ' + stamp(newest.at) : 'no bulletins in the archive';
  const tk = data.ticker;
  renderTicker(Array.isArray(tk) ? tk : ((tk && tk.items) || []));
  renderHistory(bulletins.map(bulletinMeta));
  // Populate the TOPIC WATCH wall before anything plays — visitors should
  // never see the boot-time "no beats" placeholder on a public station.
  N.showIdle({ topics: state.topics.map((t) => t.name) });
  // Real wire numbers for the wall, derived from the exported snapshot.
  try {
    const tk = Array.isArray(data.ticker) ? data.ticker : ((data.ticker && data.ticker.items) || []);
    const counts = new Map();
    for (const it of tk) counts.set(it.topic, (counts.get(it.topic) || 0) + 1);
    const beats = state.topics.map((t) => ({ name: t.name, count: counts.get(t.name) || 0 }));
    const newestB = bulletins[0];
    const perHour = newestB && newestB.stats ? Math.round((newestB.stats.freshItems || 0) * 4) : tk.length;
    if (beats.some((b) => b.count > 0)) N.setWireStats({ beats, perHour });
  } catch { /* wall stays decorative */ }
  state.booted = 'broadcast';
  // If JOIN was clicked while broadcast.json was still downloading, the join
  // handler deferred to us — start the show now.
  if (state.unlocked && !state.playing) {
    if (newest) playBulletin(newest, { replay: true });
    else startIdle();
  }
}

/* ---------- mode detection ---------- */

async function detectAndBoot() {
  try {
    const st = await fetchJSON('./api/state', { timeoutMs: 2000 });
    await bootStudio(st);
    signalRestored();
    return;
  } catch {
    /* not a live studio — try the exported broadcast */
  }
  try {
    const data = await fetchJSON('./data/broadcast.json', { timeoutMs: 8000 });
    if (!data || !Array.isArray(data.bulletins)) throw new Error('malformed broadcast.json');
    await bootBroadcast(data);
    signalRestored();
  } catch (e) {
    // Toast once; from then on the status pill carries the state and the
    // retry loop runs silently — a blinking toast over a dead stage is noise.
    console.warn('[ui] no signal:', e);
    els.sweepStatus.textContent = 'no signal — retrying…';
    if (!state.noSignalToasted) {
      state.noSignalToasted = true;
      toast('No signal from the studio — retrying in the background.');
    }
    setTimeout(detectAndBoot, 8000);
  }
}

function signalRestored() {
  if (!state.noSignalToasted) return;
  state.noSignalToasted = false;
  toast('Signal restored.');
}

/* ---------- newsroom handshake ---------- */

async function waitForNewsroom() {
  const t0 = Date.now();
  while (!window.newsroom && Date.now() - t0 < 20000) await sleep(120);
  const nr = window.newsroom;
  if (!nr) {
    console.warn('[ui] newsroom never appeared — overlay running without the 3D scene');
    return;
  }
  try {
    await Promise.race([Promise.resolve(nr.ready), sleep(20000)]);
  } catch (e) {
    console.warn('[ui] newsroom.ready rejected:', e);
  }
}

/* ---------- wiring ---------- */

function cacheEls() {
  els.livePill = $('#live-pill');
  els.pillText = $('#live-pill .pill-text');
  els.skipBtn = $('#skip-btn');
  els.clock = $('#clock');
  els.muteChip = $('#mute-chip');
  els.brainMode = $('#brain-mode');
  els.sweepStatus = $('#sweep-status');
  els.panelToggle = $('#panel-toggle');
  els.lowerThird = $('#lower-third');
  els.kicker = $('#lower-third .kicker');
  els.headline = $('#lower-third .headline');
  els.line = $('#lower-third .line');
  els.lineText = $('#lower-third .line-text');
  els.tickerTrack = $('#ticker .ticker-track');
  els.chyronSources = $('#lower-third .sources');
  els.panel = $('#panel');
  els.panelScrim = $('#panel-scrim');
  els.panelClose = $('#panel-close');
  els.topicList = $('#topic-list');
  els.topicForm = $('#topic-form');
  els.topicInput = $('#topic-input');
  els.goLive = $('#go-live');
  els.historyList = $('#history-list');
  els.voiceEnabled = $('#voice-enabled');
  els.voiceSelect = $('#voice-select');
  els.voiceActive = $('#voice-active');
  els.voiceIdentity = $('#voice-identity');
  els.voiceSelectLabel = $('#voice-select-label');
  els.voiceRate = $('#voice-rate');
  els.rateVal = $('#rate-val');
  els.askLog = $('#ask-log');
  els.askForm = $('#ask-form');
  els.askInput = $('#ask-input');
  els.joinGate = $('#join-gate');
  els.joinBtn = $('#join-btn');
  els.toast = $('#toast');
}

function bindUI() {
  els.joinBtn.addEventListener('click', () => {
    state.unlocked = true;
    // Unlock BOTH audio paths inside this tap: the shared AudioContext for
    // her rendered voice (iOS honors resume() only in a user gesture) and
    // speechSynthesis for the TTS fallback.
    try {
      const ctx = ensureAudioCtx();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch {}
    try {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      speechSynthesis.speak(u);
      speechSynthesis.resume();
    } catch {}
    loadVoices();
    els.joinGate.classList.add('hidden');
    // Boot may still be in flight (slow scene load / broadcast.json download);
    // bootStudio/bootBroadcast check state.unlocked and start playback then.
    if (!state.booted) {
      els.sweepStatus.textContent = 'tuning in…';
      return;
    }
    if (state.mode === 'broadcast') {
      const newest = ((state.broadcast || {}).bulletins || [])[0];
      if (newest) playBulletin(newest, { replay: true });
      else startIdle();
    } else if (!maybePlay()) {
      startIdle();
      // Fresh desk: now that audio is unlocked, she says hello out loud.
      if (!state.topics.length) {
        speakLine('First day on the desk! Tell me what you care about — the box is right there in the panel — and I\'ll set up my beats and get to work.');
      }
    }
  });

  els.panelToggle.addEventListener('click', () => togglePanel());
  els.panelClose.addEventListener('click', () => togglePanel(false));
  if (els.panelScrim) els.panelScrim.addEventListener('click', () => togglePanel(false));

  if (els.muteChip) {
    els.muteChip.addEventListener('click', () => {
      setVoiceOn(true);
      toast('Sound on');
    });
  }

  if (els.skipBtn) els.skipBtn.addEventListener('click', skipPlayback);

  els.topicForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = els.topicInput.value.trim();
    if (!name) return;
    els.topicInput.value = '';
    try {
      await fetchJSON('./api/topics', { method: 'POST', body: { name } });
      toast('Tracking “' + name + '” — press GO LIVE to sweep it now.');
    } catch (err) {
      toast('Could not add beat: ' + err.message);
    }
  });

  // Belt and braces for implicit submission: Enter in the add-beat box must
  // always file the topic, on every keyboard (hardware, iOS "go", IME).
  els.topicInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (typeof els.topicForm.requestSubmit === 'function') els.topicForm.requestSubmit();
    else els.topicForm.dispatchEvent(new Event('submit', { cancelable: true }));
  });

  els.topicList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.t-del');
    if (!btn) return;
    try {
      await fetchJSON('./api/topics/' + encodeURIComponent(btn.dataset.slug), { method: 'DELETE' });
    } catch (err) {
      toast('Could not drop beat: ' + err.message);
    }
  });

  els.goLive.addEventListener('click', goLive);

  els.historyList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.h-item');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      let b = null;
      if (state.mode === 'broadcast') {
        b = (((state.broadcast || {}).bulletins) || []).find((x) => x.id === id) || null;
      } else {
        b = await fetchJSON('./api/bulletins/' + encodeURIComponent(id));
      }
      if (!b) throw new Error('bulletin not found');
      if (state.playing) {
        // Never yank a show off the air for a stray tap — queue it politely.
        enqueue(b);
        toast('Queued — plays after this bulletin (⏭ skips ahead).');
      } else {
        playNow(b);
      }
    } catch (err) {
      toast('Replay failed: ' + err.message);
    }
  });

  els.voiceEnabled.addEventListener('change', () => setVoiceOn(els.voiceEnabled.checked));

  els.voiceSelect.addEventListener('change', () => {
    state.voiceURI = els.voiceSelect.value;
    try { localStorage.setItem('pepper.voice', state.voiceURI); } catch {}
  });

  els.voiceRate.addEventListener('input', () => {
    const r = Number(els.voiceRate.value);
    if (r > 0) {
      state.rate = r;
      els.rateVal.textContent = r.toFixed(2) + '×';
      try { localStorage.setItem('pepper.rate', String(r)); } catch {}
    }
  });

  els.askForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = els.askInput.value.trim();
    if (!q) return;
    els.askInput.value = '';
    bubble('user', q);

    // First-day onboarding: no beats yet → whatever they say is interests.
    if (state.mode === 'studio' && !state.topics.length) {
      const thinking = bubble('pepper thinking', 'Setting up my desk…');
      // The very first run may compile her on-device brain behind this call
      // (up to ~3 minutes) — narrate the wait and outlast it rather than
      // reporting a failure that isn't one.
      const slowNote = setTimeout(() => {
        thinking.textContent = 'Her brain is compiling — the first run takes a minute. Hang tight…';
      }, 15000);
      try {
        const r = await fetchJSON('./api/onboard', { method: 'POST', body: { interests: q }, timeoutMs: 200000 });
        thinking.textContent = (r.added && r.added.length)
          ? `On it. My beats: ${r.added.join(' · ')}. First sweep starts now — give me a minute and I'll go on air.`
          : 'I couldn\'t turn that into beats — try naming a few topics, comma-separated.';
      } catch (err) {
        thinking.textContent = 'Desk setup hiccuped: ' + err.message;
      } finally {
        clearTimeout(slowNote);
        thinking.classList.remove('thinking');
      }
      return;
    }

    // Intent routing: track/drop/research are actions, everything else is a question.
    const mTrack = q.match(/^(?:track|watch|follow|add)\s+(.{2,60})$/i);
    const mDrop = q.match(/^(?:drop|stop watching|unfollow|untrack)\s+(.{2,60})$/i);
    const mDig = q.match(/^(?:research|dig into|deep dive(?:\s+(?:on|into))?|investigate|look into)\s+(.{4,200})$/i);

    if (mTrack) {
      try {
        const t = await fetchJSON('./api/topics', { method: 'POST', body: { name: mTrack[1].trim() } });
        bubble('pepper', `On it — "${t.name}" is on my watch list. It joins the next sweep.`);
      } catch (err) {
        bubble('pepper', 'Couldn\'t add that beat: ' + err.message);
      }
      return;
    }
    if (mDrop) {
      try {
        await fetchJSON('./api/topics/' + encodeURIComponent(mDrop[1].trim()), { method: 'DELETE' });
        bubble('pepper', `Dropped. "${mDrop[1].trim()}" is off the desk.`);
      } catch {
        bubble('pepper', 'I wasn\'t watching that one.');
      }
      return;
    }
    if (mDig) {
      const topic = mDig[1].trim();
      try {
        await fetchJSON('./api/research', { method: 'POST', body: { q: topic } });
        state.researchBubble = bubble('pepper thinking', `Deep dive on "${topic}" — sweeping the wire…`);
      } catch (err) {
        bubble('pepper', 'The deep dive didn\'t start: ' + err.message);
      }
      return;
    }

    const thinking = bubble('pepper thinking', 'Checking the wire…');
    try {
      const r = await fetchJSON('./api/ask', { method: 'POST', body: { q }, timeoutMs: 100000 });
      thinking.classList.remove('thinking');
      thinking.textContent = (r && r.answer) || 'The desk came back empty on that one.';
    } catch (err) {
      thinking.classList.remove('thinking');
      thinking.textContent = 'The desk can’t answer right now.';
      toast('Ask failed: ' + err.message);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'g') {
      goLive();
    } else if (k === 'm') {
      setVoiceOn(!state.voiceOn);
      toast(state.voiceOn ? 'Sound on' : 'Muted — lines will be timed silently');
    } else if (k === 'p') {
      togglePanel();
    } else if (k === 'escape') {
      togglePanel(false);
    }
  });

  if ('speechSynthesis' in window && typeof speechSynthesis.addEventListener === 'function') {
    speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }
}

/* ---------- init ---------- */

(async function init() {
  cacheEls();
  bindUI();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(tickCountdown, 500);
  loadVoices();
  await waitForNewsroom();
  await detectAndBoot();
})();
