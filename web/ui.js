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

/* ---------- chyron ---------- */

let typeToken = 0;

function setChyron({ kicker, headline, nameplate = false, breaking = false }) {
  els.lowerThird.classList.remove('hidden');
  els.lowerThird.classList.toggle('nameplate', !!nameplate);
  els.kicker.classList.toggle('breaking', !!breaking);
  if (kicker != null) els.kicker.textContent = kicker;
  if (headline != null) els.headline.textContent = headline;
}

function clearLine() {
  typeToken += 1;
  els.line.classList.remove('typing');
  els.lineText.textContent = '';
}

function hideChyron() {
  els.lowerThird.classList.add('hidden');
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

function pickVoice() {
  const vs = state.voices;
  if (!vs.length) return null;
  if (state.voiceURI) {
    const chosen = vs.find((v) => v.voiceURI === state.voiceURI);
    if (chosen) return chosen;
  }
  const en = vs.filter((v) => /^en/i.test(v.lang));
  return en.find((v) => /siri/i.test(v.name))
    || en.find((v) => /\b(ava|zoe|samantha)\b/i.test(v.name) && /premium|enhanced/i.test(v.name))
    || en.find((v) => /premium|enhanced|natural/i.test(v.name))
    || en.find((v) => /\b(ava|zoe|samantha|allison|susan|karen|moira)\b/i.test(v.name))
    || en[0]
    || vs[0];
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
  const en = state.voices.filter((v) => /^en/i.test(v.lang));
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
}

function setVoiceOn(on) {
  state.voiceOn = !!on;
  try { localStorage.setItem('pepper.voiceOn', on ? '1' : '0'); } catch {}
  els.voiceEnabled.checked = state.voiceOn;
  if (!on) {
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch {}
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
  const voiced = state.voiceOn && 'speechSynthesis' in window;
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
  playBulletin(b, { replay: true, ...opts });
}

const SHOTS = ['med', 'close', 'screen', 'close'];

async function playBulletin(b, { replay = false } = {}) {
  if (!b || !Array.isArray(b.segments)) return;
  const my = ++state.playToken;
  clearIdle();
  state.playing = true;
  setPill(replay || state.mode === 'broadcast' ? 'replay' : 'live');
  try {
    N.setMood('steady');
    N.setOnAir(true);
    N.cut('wide');
    N.showOpen({ title: state.site.title });
    setChyron({
      kicker: replay ? 'REPLAY · recorded ' + hhmm(b.at) : 'MNN LIVE',
      headline: state.site.title,
    });
    await speakLine(b.open, my);
    if (my !== state.playToken) return;

    for (const seg of b.segments) {
      if (my !== state.playToken) return;
      if (seg.handoff) {
        await speakLine(seg.handoff, my);
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
      });
      const script = Array.isArray(seg.script) ? seg.script : [];
      for (let j = 0; j < script.length; j++) {
        if (my !== state.playToken) return;
        if (j > 0) N.cut(SHOTS[j % SHOTS.length]);
        await speakLine(script[j], my);
      }
    }

    if (my !== state.playToken) return;
    N.setMood('steady');
    N.cut('med');
    setChyron({ kicker: 'MNN', headline: state.site.tagline || 'All your models. All the time.' });
    await speakLine(b.signoff, my);
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
    const newest = ((state.broadcast || {}).bulletins || [])[0];
    if (newest && !state.playing && state.unlocked) playBulletin(newest, { replay: true });
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

  on('cycle-end', () => {
    state.researching = false;
    state.sweepText = '';
    N.sweep(false);
    setGoLiveButton();
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
  els.panel.classList.toggle('open', force);
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
  if (st.site) state.site = { ...state.site, ...st.site };
  document.title = state.site.title;
  setPill('live');
  applyVoiceConfig(st.voice);
  applyStatus(st);
  renderTopics(st.topics || []);
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
  els.brainMode.textContent = newest ? brainLabel({ mode: newest.brain }) : '📼 archive';
  els.sweepStatus.textContent = newest ? 'recorded ' + hhmm(newest.at) : 'no bulletins in the archive';
  const tk = data.ticker;
  renderTicker(Array.isArray(tk) ? tk : ((tk && tk.items) || []));
  renderHistory(bulletins.map(bulletinMeta));
  // Populate the TOPIC WATCH wall before anything plays — visitors should
  // never see the boot-time "no beats" placeholder on a public station.
  N.showIdle({ topics: state.topics.map((t) => t.name) });
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
    return;
  } catch {
    /* not a live studio — try the exported broadcast */
  }
  try {
    const data = await fetchJSON('./data/broadcast.json', { timeoutMs: 8000 });
    if (!data || !Array.isArray(data.bulletins)) throw new Error('malformed broadcast.json');
    await bootBroadcast(data);
  } catch (e) {
    console.warn('[ui] no signal:', e);
    els.sweepStatus.textContent = 'no signal';
    toast('No signal from the studio — retrying shortly.');
    setTimeout(detectAndBoot, 8000);
  }
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
  els.clock = $('#clock');
  els.brainMode = $('#brain-mode');
  els.sweepStatus = $('#sweep-status');
  els.panelToggle = $('#panel-toggle');
  els.lowerThird = $('#lower-third');
  els.kicker = $('#lower-third .kicker');
  els.headline = $('#lower-third .headline');
  els.line = $('#lower-third .line');
  els.lineText = $('#lower-third .line-text');
  els.tickerTrack = $('#ticker .ticker-track');
  els.panel = $('#panel');
  els.panelClose = $('#panel-close');
  els.topicList = $('#topic-list');
  els.topicForm = $('#topic-form');
  els.topicInput = $('#topic-input');
  els.goLive = $('#go-live');
  els.historyList = $('#history-list');
  els.voiceEnabled = $('#voice-enabled');
  els.voiceSelect = $('#voice-select');
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
    }
  });

  els.panelToggle.addEventListener('click', () => togglePanel());
  els.panelClose.addEventListener('click', () => togglePanel(false));

  els.topicForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = els.topicInput.value.trim();
    if (!name) return;
    els.topicInput.value = '';
    try {
      await fetchJSON('./api/topics', { method: 'POST', body: { name } });
      toast('Tracking “' + name + '” — next sweep will cover it.');
    } catch (err) {
      toast('Could not add beat: ' + err.message);
    }
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
      playNow(b);
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
