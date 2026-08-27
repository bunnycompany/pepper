// Pepper's LLM brain — three tiers, never throws.
//
// 1. foundation — Apple FoundationModels via the Swift sidecar
//    (src/brain/brain.swift, built lazily to ~/.pepper/brain/pepper-brain).
// 2. local — OpenAI-compatible /v1/chat/completions endpoint from
//    config.brain.local (Ollama, LM Studio, …).
// 3. fallback — segment/anchor/generate/ask return null so callers fall back
//    to the template voice in src/anchor.js.
//
// Every public method resolves to a value or null; a failing brain must never
// crash a cycle.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig, paths } from '../config.js';
import { log } from '../log.js';
import * as store from '../store.js';

const STATUS_TIMEOUT_MS = 20_000;
const GEN_TIMEOUT_MS = 90_000;
const BUILD_TIMEOUT_MS = 180_000;
const PROBE_RETRY_MS = 60_000;
const REBUILD_RETRY_MS = 10 * 60_000;
const RAPID_CRASH_WINDOW_MS = 60_000;
const MAX_RAPID_CRASHES = 3;

export const MOODS = ['breaking', 'developing', 'steady', 'quirky'];

export const PERSONA = [
  'You are Pepper, on-air anchor at MNN, the Model News Network.',
  'Early-career broadcaster energy: crisp, warm, quick, a little earnest.',
  'Broadcast register: short declarative sentences, present tense, active voice.',
  'Attribute claims to named sources ("per TechCrunch", "a paper posted to arXiv says").',
  'Never invent facts, numbers, or names that are not in the notes you are given.',
  'At most one small wink of personality. No emojis. No markdown. No stage directions.',
  'Write for the mouth, not the eye: sentences of fifteen to twenty words, spoken numbers',
  '("nearly two billion dollars", never "$1.9B"), unusual acronyms spelled as letters,',
  'and "the desk is watching" rather than "the desk watches next".',
].join(' ');

// ---- pure helpers (exported for tests) ----

// Strip a markdown code fence when the text IS a fenced block (```json … ```),
// including unterminated fences. Text with a fence buried mid-prose is
// returned untouched — extractJSON handles that case.
export function stripFences(text) {
  if (typeof text !== 'string') return '';
  const t = text.trim();
  const closed = t.match(/^```[a-zA-Z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/);
  if (closed) return closed[1].trim();
  if (t.startsWith('```')) {
    return t
      .replace(/^```[a-zA-Z0-9_+-]*[ \t]*\r?\n?/, '')
      .replace(/\r?\n?```[ \t]*$/, '')
      .trim();
  }
  return t;
}

function balancedObjectSlice(t) {
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  return null;
}

// Defensively pull a JSON object out of an LLM reply: bare JSON, JSON inside
// a markdown fence, or JSON buried in prose. → object|array|null.
export function extractJSON(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const candidates = [];
  const fence = text.match(/```[a-zA-Z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)(?:```|$)/);
  if (fence && fence[1] && fence[1].trim()) candidates.push(fence[1]);
  candidates.push(text);
  for (const c of candidates) {
    const t = c.trim();
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') return v;
    } catch {}
    const slice = balancedObjectSlice(t);
    if (slice) {
      try {
        const v = JSON.parse(slice);
        if (v && typeof v === 'object') return v;
      } catch {}
    }
  }
  return null;
}

// Sanitize a raw segment-shaped object → { headline, script, mood } | null.
export function validateSegment(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const headline = typeof obj.headline === 'string'
    ? obj.headline.trim().replace(/\.+$/, '').trim()
    : '';
  if (!headline) return null;
  let script = Array.isArray(obj.script)
    ? obj.script
    : typeof obj.script === 'string' && obj.script.trim() ? [obj.script] : [];
  script = script
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim())
    .slice(0, 6);
  if (!script.length) return null;
  const rawMood = String(obj.mood || '').toLowerCase().trim();
  const mood = MOODS.includes(rawMood) ? rawMood : 'steady';
  return { headline, script, mood };
}

export function validateAnchor(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const open = typeof obj.open === 'string' ? obj.open.trim() : '';
  const signoff = typeof obj.signoff === 'string' ? obj.signoff.trim() : '';
  if (!open || !signoff) return null;
  return { open, signoff };
}

// ctx = { tod, n, topics, busy } → "evening; 3 stories across beats: a, b; busy"
export function anchorContext(ctx = {}) {
  const tod = String(ctx.tod || 'day');
  const n = Number(ctx.n) || 0;
  const topics = Array.isArray(ctx.topics) ? ctx.topics.filter(Boolean) : [];
  const beats = topics.length ? topics.join(', ') : 'the wire';
  const noun = n === 1 ? 'story' : 'stories';
  return `${tod}; ${n} ${noun} across beats: ${beats}; ${ctx.busy ? 'busy' : 'calm'}`;
}

// Normalize a configured base URL to a full /v1/chat/completions endpoint.
export function localChatUrl(base) {
  const u = String(base || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/v1\/chat\/completions$/.test(u)) return u;
  if (/\/v1$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

export function segmentPrompt(topic, digest) {
  return `Beat: ${topic}\n\nWire notes:\n${digest}\n\n`
    + "Write Pepper's on-air segment for this beat. Pick the strongest "
    + 'through-line and lead with it. 3 to 5 sentences. Mention at least one '
    + 'source by name. If the notes are thin, say what the desk is watching '
    + 'for next.';
}

// ---- sidecar process management ----

class Sidecar {
  constructor() {
    this.proc = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 0;
    this.deaths = [];
    this.dead = false;
    this.deadReason = '';
    this.stderrTail = '';
  }

  #spawn() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return true;
    if (this.dead || !existsSync(paths.brainBin)) return false;
    let proc;
    try {
      proc = spawn(paths.brainBin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.#recordDeath('spawn failed: ' + e.message);
      return false;
    }
    this.proc = proc;
    this.buf = '';
    proc.stdout.setEncoding('utf8');
    // Identity guard: after a timeout-kill we may have respawned; a dead
    // process's late output must not touch the live one's stream state.
    proc.stdout.on('data', (chunk) => { if (this.proc === proc) this.#onData(chunk); });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2048);
    });
    proc.stdin.on('error', () => {});
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    let settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      const intentional = proc.pepperIntentionalExit === true;
      if (this.proc === proc) {
        this.proc = null;
        this.buf = '';
        // Only the live process may flush: pending requests written to a
        // respawned sidecar belong to it, not to this corpse's exit event.
        this.#flushPending();
      }
      if (!intentional) this.#recordDeath(why);
    };
    proc.on('error', (e) => finish('sidecar error: ' + e.message));
    proc.on('exit', (code, signal) => finish(`sidecar exited (${signal || code})`));
    try {
      proc.unref();
      proc.stdin.unref?.();
      proc.stdout.unref?.();
      proc.stderr.unref?.();
    } catch {}
    return true;
  }

  #flushPending() {
    for (const [, p] of this.pending) p.resolve(null);
    this.pending.clear();
  }

  #recordDeath(why) {
    const now = Date.now();
    this.deaths = this.deaths.filter((t) => now - t < RAPID_CRASH_WINDOW_MS);
    this.deaths.push(now);
    if (this.deaths.length >= MAX_RAPID_CRASHES) {
      this.dead = true;
      this.deadReason = 'sidecar crashed repeatedly';
      log.warn('brain: sidecar disabled after repeated crashes —', why,
        this.stderrTail ? '| stderr: ' + this.stderrTail.slice(-200) : '');
    }
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg?.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      } else if (msg && msg.id == null && msg.ok === false && this.pending.size) {
        // Swift rejects malformed requests with id:null. The protocol is
        // serialized (one in flight), so route it to the oldest pending
        // request instead of letting it hang into the 90s timeout-kill.
        const [firstId, fp] = this.pending.entries().next().value;
        this.pending.delete(firstId);
        fp.resolve(msg);
      }
    }
  }

  // One JSONL request → reply object | null. Caller serializes.
  request(payload, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.#spawn()) return resolve(null);
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.proc) {
          try { this.proc.kill('SIGKILL'); } catch {}
        }
        resolve(null);
      }, timeoutMs);
      // NOTE: timer stays ref'd on purpose — the child process and its stdio
      // are unref'd, so this timer is what keeps a one-shot CLI's event loop
      // alive until the sidecar answers (or the timeout fires).
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      try {
        // Truncated titles/abstracts can leave lone surrogates, which Swift's
        // JSONSerialization rejects outright — well-form before writing.
        let line = JSON.stringify({ id, ...payload });
        line = typeof line.toWellFormed === 'function'
          ? line.toWellFormed()
          : line.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
        this.proc.stdin.write(line + '\n');
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.#flushPending();
    if (proc) {
      proc.pepperIntentionalExit = true;
      try { proc.stdin.end(); } catch {}
      try { proc.kill(); } catch {}
    }
  }
}

// ---- build ----

function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let timer = null;
    const finish = (code, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, reason });
    };
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish(-1, e.message);
    }
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish(-1, 'build timed out');
    }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('error', (e) => finish(-1, `${cmd} not available (${e.message})`));
    proc.on('exit', (code) => finish(code ?? -1));
  });
}

// ---- the brain ----

const PREFER_TIERS = ['foundation', 'local', 'fallback'];

class Brain {
  #sidecar = new Sidecar();
  #queue = Promise.resolve();
  #buildPromise = null;
  #probe = null; // { ok, reason?, at }
  #warnedPrefer = ''; // last unrecognized brain.prefer value we warned about

  // Serialize sidecar requests: one in flight at a time.
  #enqueue(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(() => {}, () => {});
    return run;
  }

  #lastBuildFailAt = 0;
  #lastBuildFailReason = '';

  #ensureBuilt() {
    if (!this.#buildPromise) {
      // A failed build isn't forever: CLT may get installed, load may clear.
      // Retry on later probes, but not more often than REBUILD_RETRY_MS.
      if (Date.now() - this.#lastBuildFailAt < REBUILD_RETRY_MS) {
        return Promise.resolve({ ok: false, reason: this.#lastBuildFailReason });
      }
      this.#buildPromise = this.#build().then((r) => {
        if (!r.ok) {
          this.#lastBuildFailAt = Date.now();
          this.#lastBuildFailReason = r.reason || 'build failed';
          this.#buildPromise = null;
        }
        return r;
      });
    }
    return this.#buildPromise;
  }

  async #build() {
    try {
      if (process.platform !== 'darwin') {
        return { ok: false, reason: 'FoundationModels needs macOS' };
      }
      const src = paths.brainSrc;
      if (!existsSync(src)) return { ok: false, reason: 'brain.swift not found' };
      const fp = createHash('sha256').update(readFileSync(src)).digest('hex');
      mkdirSync(paths.brainDir, { recursive: true });
      let prev = '';
      try { prev = readFileSync(paths.brainFingerprint, 'utf8').trim(); } catch {}
      if (existsSync(paths.brainBin) && prev === fp) return { ok: true };
      // Without Command Line Tools, /usr/bin/swiftc is Apple's shim and
      // running it pops the system "Install Developer Tools?" dialog — gate
      // on xcode-select instead of surprising the user with a GUI prompt.
      const gate = spawnSync('xcode-select', ['-p'], { stdio: 'ignore' });
      if (gate.error || gate.status !== 0) {
        return { ok: false, reason: 'developer tools missing — run `xcode-select --install`' };
      }
      log.info('brain: building her on-device brain (~20s, one time)…');
      const buildStart = Date.now();
      const res = await runCmd(
        'swiftc',
        ['-parse-as-library', '-O', src, '-o', paths.brainBin],
        BUILD_TIMEOUT_MS,
      );
      try {
        writeFileSync(
          paths.brainBuildLog,
          `# swiftc build ${new Date().toISOString()}\n# exit: ${res.code}`
            + `${res.reason ? ` (${res.reason})` : ''}\n${res.out}\n`,
        );
      } catch {}
      if (res.code !== 0) {
        log.warn('brain: sidecar build failed — see', paths.brainBuildLog);
        return { ok: false, reason: res.reason || 'swiftc build failed (see brain/build.log)' };
      }
      try { writeFileSync(paths.brainFingerprint, fp + '\n'); } catch {}
      log.info(`brain: on-device brain ready (built in ${Math.round((Date.now() - buildStart) / 1000)}s)`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'build error: ' + e.message };
    }
  }

  // Runtime demotion: if a live foundation request reports the model is gone
  // (Apple Intelligence toggled off, assets updating), drop the cached probe
  // so the next call re-resolves and can fall through to local/fallback.
  #noteFoundationReply(reply) {
    if (reply && reply.ok === false
      && /unavailable|not ready|notready|assets|intelligence/i.test(String(reply.error || ''))) {
      this.#probe = { ok: false, reason: String(reply.error), at: Date.now() };
    }
    return reply;
  }

  async #tryFoundation() {
    if (this.#sidecar.dead) {
      return { ok: false, reason: this.#sidecar.deadReason || 'sidecar disabled' };
    }
    const cached = this.#probe;
    if (cached && (cached.ok || Date.now() - cached.at < PROBE_RETRY_MS)) return cached;
    const built = await this.#ensureBuilt();
    if (!built.ok) {
      this.#probe = { ok: false, reason: built.reason, at: Date.now() };
      return this.#probe;
    }
    const reply = await this.#enqueue(
      () => this.#sidecar.request({ op: 'status' }, STATUS_TIMEOUT_MS),
    );
    if (reply && reply.ok && reply.availability === 'available') {
      this.#probe = { ok: true, at: Date.now() };
    } else if (reply) {
      this.#probe = {
        ok: false,
        reason: reply.reason || reply.error || 'model unavailable',
        at: Date.now(),
      };
    } else {
      this.#probe = { ok: false, reason: 'sidecar not responding', at: Date.now() };
    }
    return this.#probe;
  }

  // → { mode, reason?, localUrl, localModel }
  async #mode() {
    let cfg = null;
    try { cfg = loadConfig(); } catch {}
    const rawPrefer = String(cfg?.brain?.prefer || 'foundation').trim();
    let prefer = rawPrefer;
    let preferNote;
    if (!PREFER_TIERS.includes(prefer)) {
      // A typo'd tier ("ollama", "Local") must not silently reroute her brain:
      // warn once per value, take the foundation path, and keep the note so
      // status() can report it.
      preferNote = `brain.prefer "${rawPrefer}" is not one of ${PREFER_TIERS.join('|')} — using foundation`;
      if (this.#warnedPrefer !== rawPrefer) {
        this.#warnedPrefer = rawPrefer;
        log.warn('brain:', preferNote);
      }
      prefer = 'foundation';
    }
    const localUrl = String(cfg?.brain?.local?.url || '').trim();
    const localModel = String(cfg?.brain?.local?.model || '').trim();
    if (prefer === 'fallback') {
      return { mode: 'fallback', reason: 'config prefers fallback', localUrl, localModel };
    }
    let reason;
    if (prefer === 'local') {
      reason = 'config prefers local';
    } else {
      const f = await this.#tryFoundation();
      if (f.ok) {
        return preferNote
          ? { mode: 'foundation', reason: preferNote, localUrl, localModel }
          : { mode: 'foundation', localUrl, localModel };
      }
      reason = f.reason;
    }
    if (localUrl) {
      return {
        mode: 'local',
        reason: preferNote ? preferNote + '; ' + reason : reason,
        localUrl,
        localModel,
      };
    }
    reason = prefer === 'local' ? 'local url not set' : reason || 'no brain configured';
    return {
      mode: 'fallback',
      reason: preferNote ? preferNote + '; ' + reason : reason,
      localUrl,
      localModel,
    };
  }

  async #localChat(m, instructions, prompt, maxTokens) {
    const url = localChatUrl(m.localUrl);
    if (!url) return null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: m.localModel || 'default',
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: prompt },
          ],
          temperature: 0.7,
          // Role tiers may point at always-thinking models (GLM-5.x) whose
          // hidden reasoning spends completion tokens before the answer
          // starts; without headroom the visible content comes back empty.
          // Headroom is deliberately modest: at single-digit tok/s a huge cap
          // means a client timeout abandons a generation the server keeps
          // computing, and abandoned generations pile up until the box dies.
          max_tokens: m.role
            ? Math.min(1200, Math.max(64, Number(maxTokens) || 450) + 700)
            : Math.min(2000, Math.max(64, Number(maxTokens) || 450)),
          // Reasoning models (Qwen3, GLM, DeepSeek…) otherwise spend the whole
          // budget thinking and return empty content. Chat templates that do
          // not use this flag simply ignore it.
          chat_template_kwargs: { enable_thinking: false },
          stream: false,
        }),
        signal: AbortSignal.timeout(m.timeoutMs || GEN_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      return typeof text === 'string' && text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  async #foundationGenerate(instructions, prompt, max) {
    const reply = this.#noteFoundationReply(await this.#enqueue(() => this.#sidecar.request(
      { op: 'generate', instructions, prompt, max },
      GEN_TIMEOUT_MS,
    )));
    return reply && reply.ok && typeof reply.text === 'string' ? reply.text : null;
  }

  // ---- public, never-throw API ----

  async status() {
    try {
      const m = await this.#mode();
      // #mode only attaches a reason to foundation when something is worth
      // surfacing (e.g. an unrecognized brain.prefer) — keep it.
      return m.reason ? { mode: m.mode, reason: m.reason } : { mode: m.mode };
    } catch (e) {
      return { mode: 'fallback', reason: 'brain error: ' + e.message };
    }
  }

  async segment({ topic, digest } = {}) {
    try {
      const m = await this.#mode();
      if (m.mode === 'foundation') {
        const reply = this.#noteFoundationReply(await this.#enqueue(() => this.#sidecar.request(
          { op: 'segment', topic: String(topic || ''), digest: String(digest || '') },
          GEN_TIMEOUT_MS,
        )));
        return reply && reply.ok ? validateSegment(reply) : null;
      }
      if (m.mode === 'local') {
        const prompt = segmentPrompt(String(topic || ''), String(digest || ''))
          + '\n\nReply with ONLY a JSON object shaped exactly like '
          + '{"headline":"...","script":["sentence one","sentence two"],'
          + '"mood":"breaking|developing|steady|quirky"} — no markdown, no commentary.';
        const text = await this.#localChat(m, PERSONA, prompt, 600);
        return validateSegment(extractJSON(text));
      }
      return null;
    } catch (e) {
      log.warn('brain.segment failed:', e.message);
      return null;
    }
  }

  async anchor(ctx) {
    try {
      const context = anchorContext(ctx);
      const m = await this.#mode();
      if (m.mode === 'foundation') {
        const reply = this.#noteFoundationReply(await this.#enqueue(
          () => this.#sidecar.request({ op: 'anchor', context }, GEN_TIMEOUT_MS),
        ));
        return reply && reply.ok ? validateAnchor(reply) : null;
      }
      if (m.mode === 'local') {
        const prompt = `Broadcast context: ${context}\n\n`
          + "Write Pepper's cold open and her sign-off for this MNN bulletin. "
          + 'The open greets viewers for this time of day, places them at the '
          + 'MNN research desk, and tees up the sweep. The sign-off wraps the '
          + 'sweep — the desk never closes, she is back on the hour. One or '
          + 'two short sentences each.\n\nReply with ONLY a JSON object shaped '
          + 'exactly like {"open":"...","signoff":"..."} — no markdown, no commentary.';
        const text = await this.#localChat(m, PERSONA, prompt, 300);
        return validateAnchor(extractJSON(text));
      }
      return null;
    } catch (e) {
      log.warn('brain.anchor failed:', e.message);
      return null;
    }
  }

  // Roles let one report be written by several models: a bigger model can
  // plan and synthesize while the fine-tuned desk model writes sections in
  // its own voice. config.brain.roles.<role> = { url, model }; anything
  // unset falls through to the ordinary tier, so single-model setups and
  // every existing config behave exactly as before.
  #roleTier(role) {
    if (!role) return null;
    let cfg = null;
    try { cfg = loadConfig(); } catch { return null; }
    const r = cfg?.brain?.roles?.[role];
    const url = String(r?.url || '').trim();
    if (!url) return null;
    return {
      mode: 'local',
      localUrl: url,
      localModel: String(r?.model || '').trim(),
      // A big model serving a role may honestly need minutes per call where
      // the default tier gets 90s; configurable per role, capped at 10 min.
      timeoutMs: Math.min(600_000, Number(r?.timeoutMs) || 300_000),
      role,
    };
  }

  async generate({ instructions, prompt, max, role } = {}) {
    try {
      const p = String(prompt || '').trim();
      if (!p) return null;
      const m = this.#roleTier(role) || await this.#mode();
      const inst = String(instructions || '').trim() || PERSONA;
      const cap = Number(max) || 450;
      let text = null;
      if (m.mode === 'foundation') text = await this.#foundationGenerate(inst, p, cap);
      else if (m.mode === 'local') text = await this.#localChat(m, inst, p, cap);
      if (typeof text !== 'string') return null;
      const cleaned = stripFences(text).trim();
      return cleaned || null;
    } catch (e) {
      log.warn('brain.generate failed:', e.message);
      return null;
    }
  }

  async ask(q) {
    try {
      const question = String(q || '').trim();
      if (!question) return null;
      const m = await this.#mode();
      if (m.mode === 'fallback') return null;
      let items = [];
      try { items = store.allRecentItems(12); } catch {}
      const context = items.length
        ? items.map((i) => {
          const tag = [i.source, i.topicName].filter(Boolean).join(', ');
          return `- ${i.title}${tag ? ` (${tag})` : ''}`;
        }).join('\n')
        : '(the wire is quiet — nothing tracked yet)';
      const prompt = `Latest headlines on the MNN desk:\n${context}\n\n`
        + `A viewer asks: ${question}\n\n`
        + 'Answer on air as Pepper: 2 to 4 short sentences, grounded in the '
        + 'headlines above when they are relevant. If the desk has nothing on '
        + "it, say so honestly and note what you'd watch for. Plain text only.";
      const text = m.mode === 'foundation'
        ? await this.#foundationGenerate(PERSONA, prompt, 300)
        : await this.#localChat(m, PERSONA, prompt, 300);
      const answer = typeof text === 'string' ? stripFences(text).trim() : '';
      return answer ? { answer, mode: m.mode } : null;
    } catch (e) {
      log.warn('brain.ask failed:', e.message);
      return null;
    }
  }

  stop() {
    try { this.#sidecar.stop(); } catch {}
  }
}

let singleton = null;

export function getBrain() {
  if (!singleton) singleton = new Brain();
  return singleton;
}
