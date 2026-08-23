// src/voicebox.js — Pepper's real voice: a Python TTS worker over JSONL.
//
// Renders a bulletin's lines to WAV files with her cloned voice
// (Qwen3-TTS via mlx-audio, conditioned on voices/<identity>.wav), so the
// webapp can play files instead of browser TTS. Process management mirrors
// the brain sidecar (src/brain/index.js): spawn once, serialize requests,
// kill + respawn on hang, rapid-crash breaker, and never throw — when
// anything here says no, callers fall back to browser TTS.
//
// Layout:
//   ~/.pepper/voice/ready         install marker {installedAt, python, model}
//   ~/.pepper/voice/venv          Python venv with mlx-audio
//   ~/.pepper/audio/<id>/         open.wav, handoff-<i>.wav, <i>-<j>.wav,
//                                 signoff.wav — one file per spoken line
//   <pkg>/voices/<identity>.wav   golden reference clip
//   <pkg>/voices/transcripts.json reference transcripts per identity

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, loadConfig, paths, PKG_ROOT } from './config.js';
import { log } from './log.js';

const DEFAULT_MODEL = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit';
const DEFAULT_IDENTITY = 'bright-anchor';

// All three shipped clips share this transcript (docs/VOICE.md provenance);
// used when voices/transcripts.json is missing or unreadable.
const FALLBACK_REF_TEXT = "Good evening. You're at the MNN research desk — I'm Pepper, "
  + "and here's what moved. Three stories crossed the wire this hour, and one of them "
  + 'is not what it claims to be. The desk never closes. This has been MNN — all your '
  + 'models, all the time.';

// The first status reply waits behind the model load (~2.4s warm, longer on a
// cold cache), and RTF ≈ 1.25 means a long line can take tens of seconds.
const STATUS_TIMEOUT_MS = 120_000;
const LINE_TIMEOUT_MS = 120_000;

// Acronyms she reads as words (or brand-reads) — everything else in caps
// gets letter-spaced so "AISI" can't come out "AIIC". Tuned from the
// Whisper round-trip audit of her real renders (digits bucket 2.1× worse).
const SPEAKABLE_ACRONYMS = new Set([
  'MNN', 'NASA', 'AI', 'US', 'UK', 'EU', 'CEO', 'GPU', 'CPU', 'API', 'LLM',
  'RAM', 'SSD', 'USB', 'FAQ', 'ROI', 'IPO', 'WWDC', 'RSS', 'PDF', 'LIVE',
]);

// Final gate before her mouth: markdown debris, handle names, hour
// abbreviations, and letter-acronyms are rewritten as they should SOUND.
export function speechNormalize(text) {
  let t = String(text ?? '');
  t = t.replace(/[*_`#]+/g, ' ');
  t = t.replace(/\bhttps?:\/\/\S+/gi, 'the link on screen');
  t = t.replace(/(\d+)\s*h ago\b/gi, (_, n) => `${n} hour${n === '1' ? '' : 's'} ago`);
  t = t.replace(/&/g, ' and ');
  t = t.replace(/\b([A-Z]{3,6})\b/g, (m) => {
    if (SPEAKABLE_ACRONYMS.has(m)) return m;
    return m.split('').join(' ');
  });
  return t.replace(/\s+/g, ' ').trim();
}
const RAPID_CRASH_WINDOW_MS = 60_000;
const MAX_RAPID_CRASHES = 3;

const BULLETIN_ID_RE = /^b-[0-9-]+$/; // same shape store.getBulletin accepts

// ---- layout helpers -------------------------------------------------------

function voiceDir() {
  return typeof paths.voiceDir === 'string' ? paths.voiceDir : join(home(), 'voice');
}

function markerPath() {
  return join(voiceDir(), 'ready');
}

// Integrator adds paths.audio(id); until then compute the same layout here.
function audioDirFor(id) {
  if (typeof paths.audio === 'function') {
    try {
      const p = paths.audio(id);
      if (typeof p === 'string' && p) return p;
    } catch {}
  }
  return join(home(), 'audio', id);
}

function readMarker() {
  try {
    const m = JSON.parse(readFileSync(markerPath(), 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

// The venv's own interpreter first — it is the one with mlx_audio installed.
// The marker's python is only an override for relocated/custom venvs, and is
// ignored when it points outside a venv layout (the installer once recorded
// the system python that *created* the venv, which broke every render).
function pythonBin() {
  const m = readMarker();
  const candidates = [
    join(voiceDir(), 'venv', 'bin', 'python3'),
    join(voiceDir(), 'venv', 'bin', 'python'),
  ];
  if (m && typeof m.python === 'string' && /\/venv\//.test(m.python)) {
    candidates.push(m.python.trim());
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function modelId() {
  const m = readMarker();
  return m && typeof m.model === 'string' && m.model.trim() ? m.model.trim() : DEFAULT_MODEL;
}

// The identities that actually shipped: one golden clip per <name>.wav.
function shippedIdentities() {
  try {
    const names = readdirSync(join(PKG_ROOT, 'voices'))
      .filter((f) => f.endsWith('.wav'))
      .map((f) => f.slice(0, -4))
      .sort();
    if (names.length) return names;
  } catch {}
  return [DEFAULT_IDENTITY];
}

let warnedIdentity = ''; // last unknown voice.identity we warned about

// Configured identity, path-safe, with a shipped golden clip — else default.
// An unknown value falls back like before, but says so once instead of
// silently rendering every bulletin in the default voice.
function identityName() {
  let id = '';
  try {
    id = String(loadConfig()?.voice?.identity || '').trim();
  } catch {}
  if (!id || id === DEFAULT_IDENTITY) return DEFAULT_IDENTITY;
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(id) && existsSync(refClip(id))) return id;
  if (warnedIdentity !== id) {
    warnedIdentity = id;
    log.warn(`voicebox: voice.identity "${id}" has no golden clip — using ${DEFAULT_IDENTITY};`
      + ' valid: ' + shippedIdentities().join(', '));
  }
  return DEFAULT_IDENTITY;
}

function refClip(identity) {
  return join(PKG_ROOT, 'voices', identity + '.wav');
}

function refTranscript(identity) {
  try {
    const data = JSON.parse(readFileSync(join(PKG_ROOT, 'voices', 'transcripts.json'), 'utf8'));
    const v = data && typeof data === 'object' && !Array.isArray(data)
      ? (data[identity] ?? data.default)
      : data;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object' && typeof v.text === 'string' && v.text.trim()) {
      return v.text.trim();
    }
  } catch {}
  return FALLBACK_REF_TEXT;
}

// ---- the voicebox ---------------------------------------------------------

class Voicebox {
  #proc = null;
  #buf = '';
  #pending = new Map();
  #nextId = 0;
  #deaths = [];
  #dead = false;
  #deadReason = '';
  #stderrTail = '';
  #readyProc = null; // the spawned worker that has answered status ok
  #queue = Promise.resolve();
  #ensurePromise = null;

  // Marker file + venv python: the install step has run and left a usable tier.
  available() {
    try {
      return existsSync(markerPath()) && pythonBin() !== null;
    } catch {
      return false;
    }
  }

  #spawn() {
    if (this.#proc && this.#proc.exitCode === null && !this.#proc.killed) return true;
    if (this.#dead) return false;
    const python = pythonBin();
    const workerSrc = join(PKG_ROOT, 'src', 'voice', 'worker.py');
    if (!python || !existsSync(workerSrc)) return false;
    const identity = identityName();
    const ref = refClip(identity);
    if (!existsSync(ref)) return false;
    let proc;
    try {
      proc = spawn(python, [
        workerSrc,
        '--model', modelId(),
        '--ref', ref,
        '--ref-text', refTranscript(identity),
        '--identity', identity,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.#recordDeath('spawn failed: ' + e.message);
      return false;
    }
    this.#proc = proc;
    this.#buf = '';
    proc.stdout.setEncoding('utf8');
    // Identity guard: after a timeout-kill we may have respawned; a dead
    // process's late output must not touch the live one's stream state.
    proc.stdout.on('data', (chunk) => { if (this.#proc === proc) this.#onData(chunk); });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-2048);
    });
    proc.stdin.on('error', () => {});
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    let settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      const intentional = proc.pepperIntentionalExit === true;
      if (this.#proc === proc) {
        this.#proc = null;
        this.#buf = '';
        // Only the live process may flush: pending requests written to a
        // respawned worker belong to it, not to this corpse's exit event.
        this.#flushPending();
      }
      if (this.#readyProc === proc) this.#readyProc = null;
      if (!intentional) this.#recordDeath(why);
    };
    proc.on('error', (e) => finish('worker error: ' + e.message));
    proc.on('exit', (code, signal) => finish(`worker exited (${signal || code})`));
    try {
      proc.unref();
      proc.stdin.unref?.();
      proc.stdout.unref?.();
      proc.stderr.unref?.();
    } catch {}
    return true;
  }

  #flushPending() {
    for (const [, p] of this.#pending) p.resolve(null);
    this.#pending.clear();
  }

  #recordDeath(why) {
    const now = Date.now();
    this.#deaths = this.#deaths.filter((t) => now - t < RAPID_CRASH_WINDOW_MS);
    this.#deaths.push(now);
    if (this.#deaths.length >= MAX_RAPID_CRASHES) {
      this.#dead = true;
      this.#deadReason = 'voice worker crashed repeatedly';
      log.warn('voicebox: worker disabled after repeated crashes —', why,
        this.#stderrTail ? '| stderr: ' + this.#stderrTail.slice(-200) : '');
    }
  }

  #onData(chunk) {
    this.#buf += chunk;
    let i;
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // dep noise on stdout
      const p = this.#pending.get(msg?.id);
      if (p) {
        this.#pending.delete(msg.id);
        p.resolve(msg);
      } else if (msg && msg.id == null && msg.ok === false && this.#pending.size) {
        // The worker rejects malformed input (and startup failures) with
        // id:null. The protocol is serialized (one in flight), so route it to
        // the oldest pending request instead of hanging into the timeout-kill.
        const [firstId, fp] = this.#pending.entries().next().value;
        this.#pending.delete(firstId);
        fp.resolve(msg);
      }
    }
  }

  // One JSONL request → reply object | null. Caller serializes via #enqueue.
  #request(payload, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.#spawn()) return resolve(null);
      const id = ++this.#nextId;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        if (this.#proc) {
          try { this.#proc.kill('SIGKILL'); } catch {} // hung render → respawn next call
        }
        resolve(null);
      }, timeoutMs);
      // NOTE: timer stays ref'd on purpose — the child process and its stdio
      // are unref'd, so this timer is what keeps a one-shot CLI's event loop
      // alive until the worker answers (or the timeout fires).
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      try {
        let line = JSON.stringify({ id, ...payload });
        line = typeof line.toWellFormed === 'function'
          ? line.toWellFormed()
          : line.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
        this.#proc.stdin.write(line + '\n');
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(null);
      }
    });
  }

  // Serialize worker requests: one in flight at a time.
  #enqueue(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(() => {}, () => {});
    return run;
  }

  // Worker up and answering: spawn if needed, one status round-trip. → bool
  async ensure() {
    try {
      if (this.#dead || !this.available()) return false;
      if (this.#proc && this.#proc.exitCode === null && !this.#proc.killed
        && this.#readyProc === this.#proc) {
        return true;
      }
      if (!this.#ensurePromise) {
        this.#ensurePromise = (async () => {
          const reply = await this.#enqueue(
            () => this.#request({ op: 'status' }, STATUS_TIMEOUT_MS),
          );
          const ok = !!(reply && reply.ok === true);
          if (ok) {
            this.#readyProc = this.#proc;
          } else {
            log.warn('voicebox: worker status failed —',
              String(reply?.error || 'no reply').slice(0, 200),
              this.#stderrTail ? '| stderr: ' + this.#stderrTail.slice(-200) : '');
          }
          return ok;
        })().finally(() => { this.#ensurePromise = null; });
      }
      return await this.#ensurePromise;
    } catch {
      return false;
    }
  }

  // Render one spoken line to a WAV at outPath. → bool, never throws.
  async renderLine(text, outPath) {
    try {
      const line = speechNormalize(text);
      const out = String(outPath || '');
      if (!line || !out) return false;
      if (!(await this.ensure())) return false;
      const reply = await this.#enqueue(
        () => this.#request({ op: 'tts', text: line, out }, LINE_TIMEOUT_MS),
      );
      if (!reply || reply.ok !== true) {
        if (reply?.error) log.warn('voicebox: line failed —', String(reply.error).slice(0, 200));
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // Render every line of a bulletin to ~/.pepper/audio/<id>/, skipping files
  // that already exist (idempotent — a crashed run resumes where it stopped),
  // then atomically set audio:true in the bulletin JSON. → bool, never throws.
  // The caller (server) emits the SSE 'audio-ready' event on true.
  async renderBulletin(bulletin, { emit } = {}) {
    try {
      const b = bulletin && typeof bulletin === 'object' ? bulletin : {};
      const id = typeof b.id === 'string' ? b.id : '';
      if (!BULLETIN_ID_RE.test(id)) return false;
      if (!this.available()) return false;
      const jobs = [];
      if (typeof b.open === 'string' && b.open.trim()) {
        jobs.push({ name: 'open.wav', text: b.open });
      }
      const segments = Array.isArray(b.segments) ? b.segments : [];
      segments.forEach((seg, i) => {
        if (!seg || typeof seg !== 'object') return;
        if (typeof seg.handoff === 'string' && seg.handoff.trim()) {
          jobs.push({ name: `handoff-${i}.wav`, text: seg.handoff });
        }
        const script = Array.isArray(seg.script) ? seg.script : [];
        script.forEach((lineText, j) => {
          if (typeof lineText === 'string' && lineText.trim()) {
            jobs.push({ name: `${i}-${j}.wav`, text: lineText });
          }
        });
      });
      if (typeof b.signoff === 'string' && b.signoff.trim()) {
        jobs.push({ name: 'signoff.wav', text: b.signoff });
      }
      if (!jobs.length) return false;
      const dir = audioDirFor(id);
      mkdirSync(dir, { recursive: true });
      let done = 0;
      for (const job of jobs) {
        const out = join(dir, job.name);
        if (!existsSync(out) && !(await this.renderLine(job.text, out))) {
          log.warn(`voicebox: bulletin ${id} stopped at ${job.name} (${done}/${jobs.length} done)`);
          return false;
        }
        done += 1;
        try { emit?.('audio-progress', { id, done, total: jobs.length }); } catch {}
      }
      return this.#flagAudio(id);
    } catch (e) {
      log.warn('voicebox.renderBulletin failed:', e.message);
      return false;
    }
  }

  // Rewrite ~/.pepper/bulletins/<id>.json with audio:true, atomically,
  // preserving every other field (re-read from disk — the in-memory copy may
  // be stale).
  #flagAudio(id) {
    try {
      const file = paths.bulletin(id);
      const b = JSON.parse(readFileSync(file, 'utf8'));
      if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
      if (b.audio === true) return true;
      b.audio = true;
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(b, null, 2) + '\n');
      renameSync(tmp, file);
      return true;
    } catch (e) {
      log.warn('voicebox: could not flag audio on', id, '—', e.message);
      return false;
    }
  }

  stop() {
    const proc = this.#proc;
    this.#proc = null;
    this.#readyProc = null;
    this.#flushPending();
    if (proc) {
      proc.pepperIntentionalExit = true;
      try { proc.stdin.end(); } catch {}
      try { proc.kill(); } catch {}
    }
  }
}

// ---- exports --------------------------------------------------------------

let singleton = null;

export function getVoicebox() {
  if (!singleton) singleton = new Voicebox();
  return singleton;
}

// For doctor / CLI status lines. Never throws.
export function voiceStatus() {
  try {
    return {
      installed: getVoicebox().available(),
      identity: identityName(),
      model: modelId(),
    };
  } catch {
    return { installed: false, identity: DEFAULT_IDENTITY, model: DEFAULT_MODEL };
  }
}
