import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { join } from 'node:path';
import { loadConfig, paths, home, ensureHome } from './config.js';
import { c } from './log.js';

// ---------- text helpers ----------

export function wrapText(text, width = 78) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
    while (cur.length > width) { lines.push(cur.slice(0, width)); cur = cur.slice(width); }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function fmtWhen(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ---------- server discovery (shared by CLI + doctor) ----------

async function probeStudio(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(400),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (j && j.ok === true) return { port, url: `http://127.0.0.1:${port}`, version: j.version };
  } catch {}
  return null;
}

export async function discoverServer(cfg = loadConfig()) {
  // Fast path: the server records {port, pid, startedAt} in run.json once it
  // binds — so a studio on a non-default port (start --port 9000) is still
  // found. /healthz is the trust gate: a stale file after a crash is harmless.
  try {
    const run = JSON.parse(readFileSync(join(home(), 'run.json'), 'utf8'));
    const port = Number(run?.port);
    const pid = Number(run?.pid);
    let alive = true;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (e) { alive = e?.code !== 'ESRCH'; }
    }
    if (alive && Number.isInteger(port) && port > 0 && port < 65536) {
      const found = await probeStudio(port);
      if (found) return found;
    }
  } catch {}
  const base = Number(cfg.port) || 4747;
  for (let p = base; p <= base + 10; p++) {
    const found = await probeStudio(p);
    if (found) return found;
  }
  return null;
}

// ---------- brief rendering ----------

const MOOD_BADGE = {
  breaking: (s) => c.bgRed(s),
  developing: (s) => c.yellow(s),
  steady: (s) => c.cyan(s),
  quirky: (s) => c.magenta(s),
};

export function renderBrief(b) {
  const out = [];
  const segs = Array.isArray(b?.segments) ? b.segments : [];
  out.push('');
  out.push(c.bgRed('  MNN — MODEL NEWS NETWORK  ') + '  ' + c.dim(fmtWhen(b?.at)));
  out.push('');
  for (const line of wrapText(b?.open || '', 78)) out.push(c.dim(line));
  for (const s of segs) {
    out.push('');
    if (s.handoff) out.push(c.dim(s.handoff));
    const mood = String(s.mood || '').toLowerCase();
    const badge = (MOOD_BADGE[mood] || c.dim)(` ${(mood || '?').toUpperCase()} `);
    out.push(badge + ' ' + c.bold(String(s.headline || '')) + (s.topic ? c.dim('  · ' + s.topic) : ''));
    for (const line of s.script || []) {
      for (const w of wrapText(line, 76)) out.push('  ' + w);
    }
    if (Array.isArray(s.sources) && s.sources.length) {
      const src = s.sources.map((x) => `${x.title} (${x.source})`).join(' · ');
      for (const w of wrapText('sources: ' + src, 74)) out.push('  ' + c.dim(w));
    }
  }
  out.push('');
  for (const line of wrapText(b?.signoff || '', 78)) out.push(line);
  out.push('');
  out.push(c.dim(`${b?.id || '?'} · brain: ${b?.brain || '?'} · ${segs.length} segment${segs.length === 1 ? '' : 's'}`));
  out.push('');
  return out.join('\n');
}

// ---------- doctor ----------

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export async function doctor() {
  let problems = 0;
  const say = (mark, label, msg) => console.log('  ' + mark + ' ' + label.padEnd(10) + msg);
  const ok = (label, msg) => say(c.green('✓'), label, msg);
  const bad = (label, msg) => { problems++; say(c.red('✗'), label, msg); };
  const na = (label, msg) => say(c.dim('–'), label, c.dim(msg));

  console.log('');
  console.log('  🌶 ' + c.bold('pepper doctor') + c.dim(' — studio health check'));
  console.log('');

  // 1. node
  try {
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj > 18 || (maj === 18 && min >= 17)) ok('node', `v${process.versions.node}`);
    else bad('node', `v${process.versions.node} — need >= 18.17`);
  } catch (e) { bad('node', String(e?.message || e)); }

  // 2. platform + arch
  try {
    if (process.platform === 'darwin') ok('system', `${process.platform} ${process.arch}`);
    else na('system', `${process.platform} ${process.arch} — local-LLM or fallback brain only`);
  } catch (e) { bad('system', String(e?.message || e)); }

  // 3. macOS version
  try {
    if (process.platform !== 'darwin') na('macos', 'not macOS');
    else {
      const r = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout) ok('macos', 'macOS ' + r.stdout.trim());
      else na('macos', 'sw_vers unavailable');
    }
  } catch (e) { na('macos', String(e?.message || e)); }

  // 4. swiftc
  try {
    if (process.platform !== 'darwin') na('swiftc', 'not applicable off macOS');
    else {
      const sel = spawnSync('xcode-select', ['-p'], { encoding: 'utf8', timeout: 5000 });
      if (sel.status !== 0) bad('swiftc', 'no developer tools — run `xcode-select --install`');
      else {
        const r = spawnSync('swiftc', ['--version'], { encoding: 'utf8', timeout: 20000 });
        if (r.status === 0 && r.stdout) ok('swiftc', r.stdout.split('\n')[0].trim());
        else bad('swiftc', 'swiftc not runnable — run `xcode-select --install`');
      }
    }
  } catch (e) { na('swiftc', String(e?.message || e)); }

  // 5. brain binary + fingerprint
  try {
    if (!existsSync(paths.brainBin)) na('brain bin', 'not built yet — builds on first run');
    else if (!existsSync(paths.brainSrc)) na('brain bin', 'built, but brain.swift missing from package');
    else {
      const fp = createHash('sha256').update(readFileSync(paths.brainSrc)).digest('hex');
      const stored = existsSync(paths.brainFingerprint)
        ? readFileSync(paths.brainFingerprint, 'utf8').trim()
        : '';
      if (stored === fp || stored.includes(fp)) ok('brain bin', 'built, fingerprint fresh');
      else na('brain bin', 'built, source changed — will rebuild on next run');
    }
  } catch (e) { bad('brain bin', String(e?.message || e)); }

  // 6. brain live status
  try {
    const { getBrain } = await import('./brain/index.js');
    const brain = getBrain();
    const st = await Promise.race([
      Promise.resolve().then(() => brain.status()).catch(() => null),
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(undefined), 25000);
        t.unref?.();
      }),
    ]);
    if (st === undefined) na('brain', 'status timed out — still warming up?');
    else if (!st || !st.mode) na('brain', 'status unavailable');
    else if (st.mode === 'fallback') na('brain', 'fallback' + (st.reason ? ' — ' + st.reason : ''));
    else ok('brain', st.mode + (st.reason ? ' — ' + st.reason : ''));
    try { brain.stop?.(); } catch {}
  } catch (e) {
    na('brain', 'module not available yet — ' + String(e?.message || e));
  }

  // 7. PEPPER_HOME writable
  try {
    ensureHome();
    const probe = join(home(), '.doctor-' + process.pid);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    ok('home', home() + ' writable');
  } catch (e) { bad('home', home() + ' not writable — ' + String(e?.message || e)); }

  // 8. port / server
  try {
    const cfg = loadConfig();
    const found = await discoverServer(cfg);
    if (found) ok('port', `Pepper server on :${found.port} (v${found.version || '?'})`);
    else if (await portFree(Number(cfg.port) || 4747)) ok('port', `:${cfg.port} free — studio can start`);
    else bad('port', `:${cfg.port} in use by something that isn't Pepper`);
  } catch (e) { bad('port', String(e?.message || e)); }

  // 9. launchd agent
  try {
    const daemon = await import('./daemon.js');
    const s = daemon.status();
    if (!s.supported) na('launchd', s.message || 'not supported on this platform');
    else if (s.running) ok('launchd', `agent running (pid ${s.pid ?? '?'})`);
    else if (s.installed) na('launchd', s.message || 'installed, not running');
    else na('launchd', 'not installed — `pepper daemon install` for 24/7');
  } catch (e) { na('launchd', 'daemon module — ' + String(e?.message || e)); }

  // 10. avatar
  try {
    if (existsSync(paths.avatar)) ok('avatar', 'custom avatar.vrm on the desk');
    else na('avatar', 'no avatar.vrm — the built-in Pepper will present');
  } catch (e) { na('avatar', String(e?.message || e)); }

  // 11. her real voice (local TTS tier)
  try {
    const ready = join(home(), 'voice', 'ready');
    if (!existsSync(ready)) {
      na('voice', 'browser TTS only — `pepper voice install` for her real voice');
    } else {
      let marker = {};
      try { marker = JSON.parse(readFileSync(ready, 'utf8')) || {}; } catch {}
      const identity = loadConfig().voice?.identity || 'bright-anchor';
      ok('voice', identity + ' · ' + (marker.model || 'model unknown'));
    }
  } catch (e) { na('voice', String(e?.message || e)); }

  console.log('');
  if (problems === 0) console.log('  ' + c.green('all clear') + c.dim(' — the studio is in good shape.'));
  else console.log('  ' + c.yellow(`${problems} problem${problems === 1 ? '' : 's'}`) + c.dim(' — see ✗ above.'));
  console.log('');
  return { problems };
}
