#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, home, paths, DEFAULTS, PKG_ROOT, VERSION } from '../src/config.js';
import * as store from '../src/store.js';
import { c } from '../src/log.js';
import { renderBrief, doctor, discoverServer, wrapText } from '../src/terminal.js';

// ---------- argv ----------

const VALUE_FLAGS = new Set(['port', 'lens', 'out']);

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { args.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(a.slice(2)) && argv[i + 1] != null && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[++i];
      } else flags[a.slice(2)] = true;
    } else args.push(a);
  }
  return { args, flags };
}

const { args, flags } = parseArgs(process.argv.slice(2));
let cmd = args[0] || '';
// `-h` anywhere means help — `pepper add -h` must never create a beat named "-h".
if (flags.help || args.includes('-h')) cmd = 'help';
if (flags.version || cmd === '-v') cmd = 'version';

// ---------- small helpers ----------

function fmtWhen(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function exitSoon(code = 0) {
  // If a brain sidecar (or anything else) is holding the event loop, force
  // the exit shortly after output has flushed; otherwise exit naturally.
  process.exitCode = code;
  const t = setTimeout(() => process.exit(code), 300);
  t.unref?.();
}

function openUrl(url) {
  const bin = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(bin, a, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

function speak(text) {
  return new Promise((resolve) => {
    try {
      const p = spawn('say', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => resolve());
      p.on('close', () => resolve());
      p.stdin.on('error', () => {});
      p.stdin.end(text);
    } catch { resolve(); }
  });
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtBrain(st) {
  if (!st || !st.mode) return c.dim('unknown');
  const color = st.mode === 'foundation' ? c.green : st.mode === 'local' ? c.cyan : c.yellow;
  return color(st.mode) + (st.reason ? c.dim(' — ' + st.reason) : '');
}

function pepperSays(answer, mode) {
  const lines = wrapText(answer, 72);
  const width = Math.max(24, ...lines.map((l) => l.length));
  console.log('');
  console.log('  ' + c.red('┌─ ') + c.bold('Pepper') + ' ' + c.red('─'.repeat(Math.max(2, width - 7))));
  for (const l of lines) console.log('  ' + c.red('│') + ' ' + l);
  console.log('  ' + c.red('└─') + ' ' + c.dim('brain: ' + (mode || 'unknown')));
  console.log('');
}

function helpText() {
  const d = c.dim;
  return [
    '',
    '  🌶 ' + c.bold('pepper') + d(' — MNN\'s 24/7 research anchor'),
    '',
    '  ' + c.bold('usage:') + ' pepper <command> [options]',
    '',
    '    start ' + d('[--port N] [--open|--no-open]') + '',
    '                                  go on air — studio server + newsroom',
    '    open                          open the studio in your browser',
    '    status                        is she on the desk?',
    '    add <topic…> ' + d('[--lens news,hn,arxiv]') + '',
    '                                  put a beat on her desk',
    '    drop <topic>                  take a beat off her desk',
    '    topics                        list the beats',
    '    now                           sweep the wire right now',
    '    brief ' + d('[--json|--speak]') + '        latest bulletin, right in the terminal',
    '    ask <question…>               ask Pepper about her beats',
    '    research <question…> ' + d('[--json]') + ' deep dive: multi-angle sweep → desk report',
    '    export ' + d('[--out dir]') + '            static broadcast site (Cloudflare Pages ready)',
    '    config ' + d('[get <path> | set <path> <value>]'),
    '                                  her settings — list, read, or change',
    '    doctor                        studio health check',
    '    daemon install|uninstall|status',
    '                                  keep her on air 24/7 (macOS launchd)',
    '    voice install|status|uninstall',
    '                                  her real voice — on-device TTS (Apple Silicon)',
    '    voice use <identity>          switch her voice — bright-anchor, calm-pro, …',
    '    version · help',
    '',
    '  ' + d('MNN — all your models, all the time.'),
    '',
  ].join('\n');
}

// ---------- sweep event printing (shared by server + inline `now`) ----------

function printEvent(type, data = {}) {
  if (type === 'cycle-start') {
    console.log(c.bold('  ⏱ sweeping the wire') + c.dim(' — news · hn · arxiv'));
  } else if (type === 'sweep') {
    const n = data.fresh ?? 0;
    const mark = n > 0 ? c.green('✓') : c.dim('·');
    console.log(`    ${mark} ${data.topic || data.slug || '?'} ${c.dim('— ' + n + ' fresh')}`);
  } else if (type === 'segment') {
    console.log(c.dim('      ✎ segment written: ' + (data.slug || '?')));
  } else if (type === 'bulletin') {
    console.log('    ' + c.bgRed(' BULLETIN ') + ' ' + (data.id || ''));
  } else if (type === 'cycle-end') {
    if (data.error) {
      console.log('  ' + c.red('✗ sweep failed: ') + data.error);
    } else if (data.quiet) {
      console.log('  ' + c.dim('— quiet cycle (' + (data.reason || 'nothing new') + ')'));
    } else {
      console.log(
        '  ' + c.bold('— sweep complete: ')
        + `${data.fresh ?? 0} fresh, ${data.segments ?? 0} segment${(data.segments ?? 0) === 1 ? '' : 's'}`
        + (data.bulletinId ? c.dim('  → pepper brief') : ''),
      );
    }
  }
}

function parseSSEBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  let data = {};
  try { data = JSON.parse(dataLines.join('\n')); } catch {}
  return { event, data };
}

async function followServerCycle(base) {
  const ac = new AbortController();
  const res = await fetch(base + '/api/events', {
    signal: ac.signal,
    headers: { accept: 'text/event-stream' },
  });
  if (!res.ok || !res.body) throw new Error('could not join the studio event feed');
  const kicked = await fetch(base + '/api/cycle', { method: 'POST' }).catch(() => null);
  if (kicked && kicked.status === 409) console.log(c.dim('  already sweeping — tuning in…'));
  let buf = '';
  const dec = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = parseSSEBlock(block);
        if (!ev || ev.event === 'status' || ev.event === 'ticker' || ev.event === 'topics') continue;
        printEvent(ev.event, ev.data);
        if (ev.event === 'cycle-end') {
          try { ac.abort(); } catch {}
          return;
        }
      }
    }
  } catch (e) {
    if (!ac.signal.aborted) throw e;
  }
}

// ---------- commands ----------

async function brainLine() {
  try {
    const { getBrain } = await import('../src/brain/index.js');
    const st = await Promise.race([
      Promise.resolve().then(() => getBrain().status()).catch(() => null),
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(undefined), 3000);
        t.unref?.();
      }),
    ]);
    if (st === undefined) return c.yellow('warming up…');
    return fmtBrain(st);
  } catch {
    return c.yellow('warming up…') + c.dim(' (brain module still loading)');
  }
}

async function cmdStart() {
  if (flags.port != null) {
    const p = Number(flags.port);
    if (typeof flags.port === 'boolean' || !Number.isInteger(p) || p < 1 || p > 65535) {
      console.log('  ' + c.red('✗') + ' --port must be a number 1-65535'
        + (typeof flags.port === 'boolean' ? ' — none given' : ` (got "${flags.port}")`));
      process.exitCode = 1;
      return;
    }
  }
  // She may already be on the desk — don't quietly start a second studio.
  const running = await discoverServer(loadConfig());
  if (running && (flags.port == null || Number(flags.port) === running.port)) {
    console.log('  🌶 ' + c.bold('already on air') + ' — ' + c.cyan(running.url));
    console.log('  ' + c.dim('`pepper open` to watch, or `pepper start --port N` for a second studio.'));
    return;
  }
  const { createPepperServer } = await import('../src/server.js');
  const srv = createPepperServer(flags.port != null ? { port: Number(flags.port) } : {});
  let port;
  try {
    ({ port } = await srv.listen());
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      const p = e.port || (flags.port != null ? Number(flags.port) : Number(srv.cfg.port) || 4747);
      console.log('  ' + c.red('✗') + ` port ${p} is taken — is another Pepper on air? try \`pepper status\`, or pick a free one with --port.`);
      try { srv.stop(); } catch {}
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  const url = `http://127.0.0.1:${port}`;
  const topics = store.listTopics();
  const brain = await brainLine();

  const W = 42;
  const center = (s) => {
    const pad = Math.max(0, W - s.length);
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + s + ' '.repeat(pad - l);
  };
  console.log('');
  console.log('   🌶  ' + c.red('┌' + '─'.repeat(W) + '┐'));
  console.log('       ' + c.red('│') + c.bold(center('M N N — MODEL NEWS NETWORK')) + c.red('│'));
  console.log('       ' + c.red('│') + c.dim(center('all your models, all the time')) + c.red('│'));
  console.log('       ' + c.red('└' + '─'.repeat(W) + '┘'));
  console.log('');
  console.log('   studio  ' + c.cyan(url));
  console.log('   beats   ' + (topics.length
    ? `${topics.length} on the desk ` + c.dim('— ' + truncate(topics.map((t) => t.name).join(', '), 56))
    : c.dim('none yet — she\'ll ask you in the studio')));
  console.log('   sweep   every ' + (srv.cfg.intervalMinutes || 15) + ' minutes');
  console.log('   brain   ' + brain);
  console.log('');
  if (!topics.length) {
    console.log('   ' + c.bold('first day on the desk!') + ' opening her studio — she\'ll introduce');
    console.log('   herself and set up her beats from a sentence about your interests.');
    console.log('   ' + c.dim('(--no-open to skip the browser)'));
  } else {
    console.log('   ' + c.bold('she\'s on the desk') + c.dim(' — ctrl-c to go off air'));
  }
  console.log('');

  // Fresh desk: bring the human to her, don't make them find the URL.
  if (flags.open || (!topics.length && !flags['no-open'])) openUrl(url);

  process.on('SIGINT', () => {
    console.log('\n   ' + c.dim('that\'s the sweep — Pepper is off the air. MNN.'));
    try { srv.stop(); } catch {}
    process.exit(0);
  });
}

async function shortStatus() {
  const found = await discoverServer(loadConfig());
  const topics = store.listTopics();
  if (!found && !topics.length) {
    console.log('');
    console.log('  🌶 ' + c.bold('Hi, I\'m Pepper — your research anchor.') + ' I\'m not on the desk yet.');
    console.log('     Run ' + c.cyan('pepper start') + ' — my studio opens, I introduce myself, and you');
    console.log('     tell me what to watch in plain words. That\'s the whole setup.');
    console.log('');
    return;
  }
  const beats = `${topics.length} beat${topics.length === 1 ? '' : 's'}`;
  if (found) console.log('  🌶 ' + c.green(c.bold('ON AIR')) + c.dim(' — ') + c.cyan(found.url) + c.dim(' · ' + beats));
  else console.log('  🌶 ' + c.dim('off the air · ' + beats + ' on file'));
}

async function cmdStatus() {
  const found = await discoverServer(loadConfig());
  if (!found) {
    console.log('');
    console.log('  🌶 ' + c.bold('Pepper is off the air.'));
    const topics = store.listTopics();
    console.log('     brain     ' + await brainLine());
    console.log('     beats     ' + (topics.length
      ? truncate(topics.map((t) => t.name).join(', '), 60)
      : c.dim('none — pepper add "quantum computing"')));
    const b = store.latestBulletin();
    console.log('     bulletin  ' + (b ? b.id + ' ' + c.dim('(' + fmtWhen(b.at) + ')') : c.dim('none yet')));
    console.log('     ' + c.dim('start the studio with `pepper start`'));
    console.log('');
    // The brain probe may have spawned the sidecar — don't let it hold the exit.
    try { (await import('../src/brain/index.js')).getBrain().stop(); } catch {}
    exitSoon(0);
    return;
  }
  let st = null;
  try {
    st = await (await fetch(found.url + '/api/state', { signal: AbortSignal.timeout(3000) })).json();
  } catch {}
  console.log('');
  if (!st) {
    console.log('  🌶 on air at ' + c.cyan(found.url) + c.dim(' (state unavailable)'));
    console.log('');
    return;
  }
  console.log('  🌶 ' + c.green(c.bold('ON AIR')) + ' — ' + c.cyan(found.url) + c.dim('  v' + (st.version || '?')));
  console.log('     brain     ' + fmtBrain(st.brain));
  console.log('     beats     ' + (st.topics?.length
    ? truncate(st.topics.map((t) => t.name).join(', '), 60)
    : c.dim('none — pepper add "quantum computing"')));
  console.log('     sweep     ' + (st.researching
    ? c.yellow('sweeping right now')
    : `every ${st.intervalMinutes} min` + (st.nextCycleAt ? c.dim(' · next ' + fmtWhen(st.nextCycleAt)) : '')));
  console.log('     bulletin  ' + (st.latestBulletinId || c.dim('none yet')));
  console.log('     avatar    ' + (st.avatar ? 'custom VRM' : c.dim('built-in Pepper')));
  console.log('');
}

async function cmdOpen() {
  const found = await discoverServer(loadConfig());
  if (!found) {
    console.log(c.dim('  the studio is dark — `pepper start` first.'));
    process.exitCode = 1;
    return;
  }
  openUrl(found.url);
  console.log('  🌶 opening the studio — ' + c.cyan(found.url));
}

function cmdAdd() {
  const name = args.slice(1).join(' ').trim();
  if (!name) {
    console.log('  usage: pepper add <topic…> [--lens news,hn,arxiv]');
    process.exitCode = 1;
    return;
  }
  if (name.startsWith('-')) {
    console.log('  ' + c.red('✗') + ` a topic can't start with "-" — that looks like a flag. see \`pepper help\`.`);
    process.exitCode = 1;
    return;
  }
  let lenses;
  if (flags.lens != null) {
    const VALID = ['news', 'hn', 'arxiv'];
    lenses = String(flags.lens).split(',').map((s) => s.trim()).filter(Boolean);
    const badLens = lenses.filter((l) => !VALID.includes(l));
    if (!lenses.length || badLens.length) {
      console.log('  ' + c.red('✗') + ` bad --lens ${c.bold(badLens.join(', ') || '(empty)')} — valid: news, hn, arxiv`);
      process.exitCode = 1;
      return;
    }
  }
  try {
    const t = store.addTopic(name, lenses);
    console.log('  ' + c.green('✓') + ' on it — ' + c.bold(`"${t.name}"`) + ' is on the desk ' + c.dim(`(${t.lenses.join(', ')} · slug ${t.slug})`));
    console.log('  ' + c.dim('she\'ll pick it up on the next sweep — or `pepper now` to sweep immediately.'));
  } catch (e) {
    console.log('  ' + c.yellow('!') + ' ' + String(e?.message || e));
    process.exitCode = 1;
  }
}

function cmdDrop() {
  const name = args.slice(1).join(' ').trim();
  if (!name) {
    console.log('  usage: pepper drop <topic>');
    process.exitCode = 1;
    return;
  }
  if (name.startsWith('-')) {
    console.log('  ' + c.red('✗') + ` a topic can't start with "-" — that looks like a flag. see \`pepper topics\` for what's on the desk.`);
    process.exitCode = 1;
    return;
  }
  if (store.dropTopic(name)) {
    console.log('  ' + c.green('✓') + ' dropped ' + c.bold(`"${name}"`) + c.dim(' — off the desk, wire notes cleared.'));
  } else {
    console.log('  ' + c.yellow('!') + ` she wasn't tracking "${name}" — see \`pepper topics\`.`);
    process.exitCode = 1;
  }
}

function cmdTopics() {
  const topics = store.listTopics();
  if (!topics.length) {
    console.log('  ' + c.dim('no beats on the desk — try `pepper add "quantum computing"`.'));
    return;
  }
  console.log('');
  console.log('  ' + c.bold(`${topics.length} beat${topics.length === 1 ? '' : 's'} on the desk:`));
  for (const t of topics) {
    const dot = t.muted ? c.dim('○') : c.red('●');
    const swept = t.lastSweepAt ? 'swept ' + fmtWhen(t.lastSweepAt) : 'not swept yet';
    console.log(`    ${dot} ${c.bold(t.name)} ${c.dim(`(${(t.lenses || []).join('+')} · ${swept}${t.muted ? ' · muted' : ''})`)}`);
  }
  console.log('');
}

async function cmdNow() {
  const found = await discoverServer(loadConfig());
  console.log('');
  if (found) {
    console.log(c.dim(`  studio is live on :${found.port} — asking her to sweep now…`));
    await followServerCycle(found.url);
    console.log('');
    exitSoon(0);
    return;
  }
  console.log(c.dim('  no studio running — sweeping inline…'));
  let research;
  try {
    research = await import('../src/research.js');
  } catch (e) {
    throw new Error('the research module isn\'t available: ' + String(e?.message || e));
  }
  printEvent('cycle-start', {});
  try {
    const summary = await research.runCycle({ emit: printEvent });
    printEvent('cycle-end', summary || {});
  } catch (e) {
    printEvent('cycle-end', { error: String(e?.message || e) });
    process.exitCode = 1;
  }
  try { (await import('../src/brain/index.js')).getBrain().stop(); } catch {}
  console.log('');
  exitSoon(process.exitCode || 0);
}

async function cmdBrief() {
  const b = store.latestBulletin();
  if (!b) {
    if (flags.json) {
      // Machine consumers get parseable stdout and a real failure code;
      // the human hint goes to stderr so `| jq` stays clean.
      console.log('null');
      console.error('  no bulletins yet — try `pepper now` or `pepper start`.');
      process.exitCode = 1;
    } else {
      console.log('  ' + c.dim('no bulletins yet — she hasn\'t gone to air. Try `pepper now` or `pepper start`.'));
    }
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify(b, null, 2));
    return;
  }
  console.log(renderBrief(b));
  if (flags.speak) {
    const parts = [b.open];
    for (const s of b.segments || []) {
      if (s.handoff) parts.push(s.handoff);
      parts.push(...(s.script || []));
    }
    parts.push(b.signoff);
    await speak(parts.filter(Boolean).join('\n'));
  }
}

async function cmdResearch() {
  const q = args.slice(1).join(' ').trim();
  if (!q) {
    console.log('  usage: pepper research <question…>');
    process.exitCode = 1;
    return;
  }
  const { runDeepResearch } = await import('../src/deepresearch.js');
  console.log('');
  console.log('  🌶 ' + c.bold('deep dive') + c.dim(' — ' + q));
  const t0 = Date.now();
  const r = await runDeepResearch(q, {
    emit: (type, d) => {
      if (type === 'research-angles') console.log(c.dim('  angles: ' + d.angles.join(' · ')));
      if (type === 'research-sweep') console.log(c.dim('  sweeping: ' + d.query));
      if (type === 'research-swept') console.log(c.dim(`  ${d.items} items on the wire`));
    },
  });
  console.log('');
  if (flags.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    if (r.notes) console.log(c.dim('  DESK NOTES: ' + r.notes) + '\n');
    for (const line of wrapText(r.report, 78)) console.log('  ' + line);
    console.log('');
    console.log(c.dim(`  ${r.items} sources · ${((Date.now() - t0) / 1000).toFixed(0)}s · filed as ${r.bulletinId} — she'll present it in the studio`));
  }
  console.log('');
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
}

async function cmdAsk() {
  const q = args.slice(1).join(' ').trim();
  if (!q) {
    console.log('  usage: pepper ask <question…>');
    process.exitCode = 1;
    return;
  }
  const found = await discoverServer(loadConfig());
  let result = null;
  let failure = null;
  let brainProblem = !found; // inline asks fail for brain reasons; server asks may not
  if (found) {
    try {
      const res = await fetch(found.url + '/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q }),
      });
      if (res.ok) result = await res.json();
      else if (res.status === 503) {
        failure = `the studio at ${found.url} is on air, but her brain is off there (HTTP 503).`;
        brainProblem = true;
      } else {
        failure = `the studio at ${found.url} answered HTTP ${res.status} — try \`pepper status\`.`;
      }
    } catch (e) {
      failure = `could not reach the studio at ${found.url} (${String(e?.cause?.message || e?.message || e)}) — mid-restart? try \`pepper status\`.`;
    }
  } else {
    try {
      const { getBrain } = await import('../src/brain/index.js');
      const brain = getBrain();
      result = await brain.ask(q);
      try { brain.stop?.(); } catch {}
    } catch (e) {
      failure = 'her brain errored: ' + String(e?.message || e);
    }
  }
  if (result && result.answer) {
    pepperSays(result.answer, result.mode);
  } else {
    console.log('  ' + c.red('✗') + ' ' + (failure || 'no answer — her brain is off.'));
    if (brainProblem) {
      console.log('  ' + c.dim('brain: ') + await brainLine());
      console.log('  ' + c.dim('for a local LLM, set `brain.local.url` in ' + paths.config
        + ' — or run on Apple Silicon with Apple Intelligence.'));
    }
    process.exitCode = 1;
  }
  exitSoon(process.exitCode || 0);
}

async function cmdExport() {
  const { exportSite } = await import('../src/export.js');
  const r = await exportSite({ outDir: typeof flags.out === 'string' ? flags.out : './pepper-site' });
  if (r?.errors?.length) process.exitCode = 1;
}

// ---------- config (dot-path settings, no hand-authored JSON) ----------

function flattenConfig(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenConfig(v, p));
    else out[p] = v;
  }
  return out;
}

function configValueAt(obj, dotPath) {
  let cur = obj;
  for (const k of String(dotPath).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function fmtConfigValue(v) {
  if (typeof v === 'string') return v === '' ? c.dim('(empty)') : v;
  return JSON.stringify(v);
}

async function cmdConfig() {
  const sub = args[1];
  // Lazy import: setConfigValue/configIssues live next to loadConfig.
  const { setConfigValue, configIssues } = await import('../src/config.js');
  const knownPaths = Object.keys(flattenConfig(DEFAULTS));

  if (!sub) {
    const eff = flattenConfig(loadConfig());
    let fileCfg = null;
    try { fileCfg = JSON.parse(readFileSync(paths.config, 'utf8')); } catch {}
    const fromFile = flattenConfig(fileCfg || {});
    console.log('');
    console.log('  🌶 ' + c.bold('her settings') + c.dim(' — ' + paths.config
      + (existsSync(paths.config) ? '' : ' (not written yet — all defaults)')));
    console.log('');
    const width = Math.max(...Object.keys(eff).map((k) => k.length));
    for (const [k, v] of Object.entries(eff)) {
      const src = k in fromFile ? 'config.json' : 'default';
      console.log('     ' + k.padEnd(width + 2) + fmtConfigValue(v) + '  ' + c.dim('(' + src + ')'));
    }
    for (const issue of (await configIssues()) || []) {
      console.log('     ' + (issue.severity === 'error' ? c.red('✗') : c.yellow('!')) + ' ' + issue.message);
    }
    console.log('');
    console.log('  ' + c.dim('change one: `pepper config set <path> <value>` — e.g. `pepper config set intervalMinutes 30`'));
    console.log('');
    return;
  }

  if (sub === 'get') {
    const path = String(args[2] || '').trim();
    if (!path) {
      console.log('  usage: pepper config get <path>   ' + c.dim('(e.g. intervalMinutes, voice.identity)'));
      process.exitCode = 1;
      return;
    }
    const v = configValueAt(loadConfig(), path);
    if (v === undefined) {
      console.log('  ' + c.red('✗') + ` no setting "${path}" — known: ` + knownPaths.join(', '));
      process.exitCode = 1;
      return;
    }
    console.log(typeof v === 'string' ? v : JSON.stringify(v));
    return;
  }

  if (sub === 'set') {
    const path = String(args[2] || '').trim();
    const rawParts = args.slice(3);
    if (!path || !rawParts.length) {
      console.log('  usage: pepper config set <path> <value>   ' + c.dim('(e.g. pepper config set voice.identity calm-pro)'));
      process.exitCode = 1;
      return;
    }
    const raw = rawParts.join(' ');
    // JSON when it parses (numbers, booleans, nulls), plain string otherwise.
    let value = raw;
    try { value = JSON.parse(raw); } catch {}
    const r = await setConfigValue(path, value);
    if (!r || !r.ok) {
      console.log('  ' + c.red('✗') + ' ' + String(r?.error || 'could not save that setting'));
      process.exitCode = 1;
      return;
    }
    if (r.warning && !knownPaths.includes(r.path)) {
      console.log('  ' + c.yellow('!') + ' ' + r.warning + c.dim(' — known: ' + knownPaths.join(', ')));
    }
    console.log('  ' + c.green('✓') + ' ' + r.path + ' = ' + fmtConfigValue(r.value));
    if (await discoverServer(loadConfig())) {
      console.log('  ' + c.dim('the studio is on air — restart `pepper start` to apply.'));
    }
    return;
  }

  console.log('  usage: pepper config [get <path> | set <path> <value>]');
  process.exitCode = 1;
}

async function cmdDaemon() {
  const sub = args[1];
  const daemon = await import('../src/daemon.js');
  if (sub === 'install') {
    const r = daemon.install();
    console.log('  ' + (r.ok ? c.green('✓') : c.red('✗')) + ' ' + r.message);
    if (!r.ok) process.exitCode = 1;
  } else if (sub === 'uninstall') {
    const r = daemon.uninstall();
    console.log('  ' + (r.ok ? c.green('✓') : c.red('✗')) + ' ' + r.message);
    if (!r.ok) process.exitCode = 1;
  } else if (sub === 'status') {
    const s = daemon.status();
    if (!s.supported) console.log('  ' + c.dim('– ' + s.message));
    else if (s.running) console.log('  ' + c.green('✓') + ' on the desk 24/7 — ' + s.message);
    else console.log('  ' + c.dim('– ' + s.message));
  } else {
    console.log('  usage: pepper daemon install|uninstall|status');
    process.exitCode = 1;
  }
}

// ---------- voice (her real voice — local TTS tier) ----------

const VOICE_MODEL = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit';

function voicePaths() {
  const dir = join(home(), 'voice');
  return {
    dir,
    venv: join(dir, 'venv'),
    venvPython: join(dir, 'venv', 'bin', 'python3'),
    ready: join(dir, 'ready'),
    worker: join(PKG_ROOT, 'src', 'voice', 'worker.py'),
  };
}

function readVoiceMarker() {
  try {
    const m = JSON.parse(readFileSync(voicePaths().ready, 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

function pythonVersionOf(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return null;
    const m = ((r.stdout || '') + (r.stderr || '')).match(/Python (\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), version: `${m[1]}.${m[2]}.${m[3]}` };
  } catch {
    return null;
  }
}

// Prefer explicit Homebrew python3.x binaries (newest first), then whatever
// `python3` is on PATH. mlx-audio needs >= 3.10 — 3.9 is honestly rejected.
function findPython() {
  const candidates = [];
  try {
    for (const name of readdirSync('/opt/homebrew/bin')) {
      const m = name.match(/^python3\.(\d+)$/);
      if (m) candidates.push({ bin: '/opt/homebrew/bin/' + name, minor: Number(m[1]) });
    }
  } catch {}
  candidates.sort((a, b) => b.minor - a.minor);
  candidates.push({ bin: 'python3', minor: -1 });
  for (const cand of candidates) {
    const v = pythonVersionOf(cand.bin);
    if (v && v.major === 3 && v.minor >= 10) return { bin: cand.bin, version: v.version };
  }
  return null;
}

// Long installer steps: stream output live so downloads aren't a silent hang,
// and report the exit honestly.
function runStep(bin, args, { timeoutMs = 600000 } = {}) {
  try {
    const r = spawnSync(bin, args, { stdio: ['ignore', 'inherit', 'inherit'], timeout: timeoutMs });
    if (r.error) return { ok: false, why: String(r.error.message || r.error) };
    if (r.signal) return { ok: false, why: 'stopped by signal ' + r.signal };
    if (r.status !== 0) return { ok: false, why: 'exit code ' + r.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(e?.message || e) };
  }
}

async function cmdVoiceInstall() {
  const vp = voicePaths();
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.log('  ' + c.red('✗') + ' her real voice needs an Apple Silicon Mac — mlx-audio runs on Metal.');
    console.log('  ' + c.dim('  everywhere else, the newsroom keeps speaking with browser TTS.'));
    process.exitCode = 1;
    return;
  }
  if (readVoiceMarker()) {
    console.log('  ' + c.green('✓') + ' her voice is already installed — see ' + c.cyan('pepper voice status') + '.');
    console.log('  ' + c.dim('  to reinstall from scratch: `pepper voice uninstall` first.'));
    return;
  }
  console.log('');
  console.log('  🌶 ' + c.bold('pepper voice install') + c.dim(' — her real voice, rendered on this machine'));
  console.log('');

  const py = findPython();
  if (!py) {
    console.log('  ' + c.red('✗') + ' no Python 3.10+ found — mlx-audio needs it (3.9 is too old).');
    console.log('  ' + c.dim('  `brew install python`, then rerun `pepper voice install`.'));
    process.exitCode = 1;
    return;
  }
  console.log('  ' + c.green('✓') + ' python ' + py.version + c.dim(' — ' + py.bin));

  try {
    mkdirSync(vp.dir, { recursive: true });
  } catch (e) {
    console.log('  ' + c.red('✗') + ' cannot create ' + vp.dir + ' — ' + String(e?.message || e));
    process.exitCode = 1;
    return;
  }

  if (!existsSync(vp.venvPython)) {
    console.log('  ' + c.dim('… creating venv at ' + vp.venv));
    const r = runStep(py.bin, ['-m', 'venv', vp.venv], { timeoutMs: 120000 });
    if (!r.ok) {
      console.log('  ' + c.red('✗') + ' venv creation failed (' + r.why + ') — nothing was installed.');
      process.exitCode = 1;
      return;
    }
  }
  console.log('  ' + c.green('✓') + ' venv ready');

  console.log('  ' + c.dim('… pip install mlx-audio — a few minutes on first run'));
  const pip = runStep(vp.venvPython, ['-m', 'pip', 'install', '-q', 'mlx-audio'], { timeoutMs: 600000 });
  if (!pip.ok) {
    console.log('  ' + c.red('✗') + ' pip install mlx-audio failed (' + pip.why + ') — voice is NOT ready.');
    console.log('  ' + c.dim('  fix the pip error above and rerun `pepper voice install`.'));
    process.exitCode = 1;
    return;
  }
  console.log('  ' + c.green('✓') + ' mlx-audio installed');

  if (existsSync(vp.worker)) {
    console.log('  ' + c.dim('… warming up ' + VOICE_MODEL + ' — first run downloads the weights'));
    const warm = runStep(vp.venvPython, [vp.worker, '--model', VOICE_MODEL, '--warmup'], { timeoutMs: 600000 });
    if (!warm.ok) {
      console.log('  ' + c.red('✗') + ' model warmup failed (' + warm.why + ') — voice is NOT ready.');
      console.log('  ' + c.dim('  check the error above (network? disk?), then rerun `pepper voice install`.'));
      process.exitCode = 1;
      return;
    }
    console.log('  ' + c.green('✓') + ' model warmed up');
  } else {
    console.log('  ' + c.yellow('!') + ' voice worker script missing from this package — skipping the warmup.');
    console.log('  ' + c.dim('  the model will download on her first render instead.'));
  }

  try {
    // Record the VENV interpreter (the one that has mlx_audio), not the
    // system python that created the venv.
    writeFileSync(vp.ready, JSON.stringify({
      installedAt: new Date().toISOString(),
      python: join(vp.venv, 'bin', 'python3'),
      pythonVersion: py.version,
      model: VOICE_MODEL,
    }, null, 2) + '\n');
  } catch (e) {
    console.log('  ' + c.red('✗') + ' could not write the ready marker — ' + String(e?.message || e));
    process.exitCode = 1;
    return;
  }

  const identity = loadConfig().voice?.identity || 'bright-anchor';
  console.log('');
  console.log('  ' + c.green('✓') + ' ' + c.bold('her voice is ready') + ' — identity ' + c.bold(identity) + c.dim(' (config voice.identity)'));
  console.log('  ' + c.dim('restart the studio (`pepper start`) — new bulletins render in her own voice.'));
  console.log('');
}

function cmdVoiceStatus() {
  const vp = voicePaths();
  const marker = readVoiceMarker();
  const identity = loadConfig().voice?.identity || 'bright-anchor';
  const refClip = join(PKG_ROOT, 'voices', identity + '.wav');
  console.log('');
  if (!marker) {
    console.log('  🌶 ' + c.dim('her real voice is not installed — browser TTS carries the desk.'));
    console.log('     ' + c.dim('install it with `pepper voice install` (Apple Silicon).'));
    console.log('');
    return;
  }
  console.log('  🌶 ' + c.green(c.bold('VOICE READY')) + c.dim(' — she reads the news in her own voice'));
  console.log('     model     ' + (marker.model || VOICE_MODEL));
  console.log('     python    ' + (marker.python || '?')
    + (marker.pythonVersion ? c.dim(' (v' + marker.pythonVersion + ')') : ''));
  console.log('     identity  ' + identity + ' '
    + (existsSync(refClip) ? c.dim('— golden clip on file') : c.yellow('(golden clip missing: voices/' + identity + '.wav)')));
  console.log('     installed ' + fmtWhen(marker.installedAt));
  console.log('     venv      ' + c.dim(vp.venv));
  console.log('');
}

function cmdVoiceUninstall() {
  const vp = voicePaths();
  const wasThere = existsSync(vp.dir);
  try {
    rmSync(vp.dir, { recursive: true, force: true });
  } catch (e) {
    console.log('  ' + c.red('✗') + ' could not remove ' + vp.dir + ' — ' + String(e?.message || e));
    process.exitCode = 1;
    return;
  }
  if (!wasThere) {
    console.log('  ' + c.dim('– her voice was never installed — nothing to remove.'));
    return;
  }
  console.log('  ' + c.green('✓') + ' voice tier removed — venv and ready marker are gone from ' + vp.dir + '.');
  console.log('  ' + c.dim('  rendered audio stays in ' + join(home(), 'audio') + ' — delete that folder to reclaim space.'));
  console.log('  ' + c.dim('  the newsroom falls back to browser TTS.'));
}

// The identities she ships with — one golden clip per voice in voices/.
function shippedIdentities() {
  try {
    return readdirSync(join(PKG_ROOT, 'voices'))
      .filter((f) => f.endsWith('.wav'))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

async function cmdVoiceUse() {
  const identity = String(args[2] || '').trim();
  const avail = shippedIdentities();
  const current = loadConfig().voice?.identity || 'bright-anchor';
  if (!identity) {
    console.log('  usage: pepper voice use <identity>');
    if (avail.length) {
      console.log('  ' + c.dim('identities: ' + avail.map((v) => (v === current ? v + ' (current)' : v)).join(', ')));
    }
    process.exitCode = 1;
    return;
  }
  if (!avail.includes(identity)) {
    console.log('  ' + c.red('✗') + ` no golden clip for "${identity}" (voices/${identity}.wav)`
      + ' — identities: ' + (avail.join(', ') || 'none shipped'));
    process.exitCode = 1;
    return;
  }
  const { setConfigValue } = await import('../src/config.js');
  const r = await setConfigValue('voice.identity', identity);
  if (!r || !r.ok) {
    console.log('  ' + c.red('✗') + ' ' + String(r?.error || 'could not save voice.identity'));
    process.exitCode = 1;
    return;
  }
  console.log('  ' + c.green('✓') + ' she reads as ' + c.bold(identity) + ' now'
    + c.dim(' — new bulletins render with it (identity is read per render, no restart needed).'));
}

async function cmdVoice() {
  const sub = args[1];
  if (sub === 'install') await cmdVoiceInstall();
  else if (sub === 'status') cmdVoiceStatus();
  else if (sub === 'uninstall') cmdVoiceUninstall();
  else if (sub === 'use') await cmdVoiceUse();
  else {
    console.log('  usage: pepper voice install|status|uninstall|use <identity>');
    process.exitCode = 1;
  }
}

// ---------- dispatch ----------

async function main() {
  switch (cmd) {
    case '':
      await shortStatus();
      console.log(helpText());
      break;
    case 'start': await cmdStart(); break;
    case 'open': await cmdOpen(); break;
    case 'status': await cmdStatus(); break;
    case 'add': cmdAdd(); break;
    case 'drop': cmdDrop(); break;
    case 'topics': cmdTopics(); break;
    case 'now': await cmdNow(); break;
    case 'brief': await cmdBrief(); break;
    case 'ask': await cmdAsk(); break;
    case 'research': await cmdResearch(); break;
    case 'export': await cmdExport(); break;
    case 'config': await cmdConfig(); break;
    case 'doctor':
      await doctor();
      exitSoon(0);
      break;
    case 'daemon': await cmdDaemon(); break;
    case 'voice': await cmdVoice(); break;
    case 'version': console.log('pepper v' + VERSION); break;
    case 'help': console.log(helpText()); break;
    default:
      console.log('  ' + c.red('✗') + ` unknown command "${cmd}"`);
      console.log(helpText());
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('  ' + c.red('✗') + ' ' + String(e?.message || e));
  process.exit(1);
});
