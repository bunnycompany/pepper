#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { loadConfig, VERSION } from '../src/config.js';
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
if (flags.help || cmd === '-h') cmd = 'help';
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
    '    start ' + d('[--port N] [--open]') + '      go on air — studio server + newsroom',
    '    open                          open the studio in your browser',
    '    status                        is she on the desk?',
    '    add <topic…> ' + d('[--lens news,hn,arxiv]') + '',
    '                                  put a beat on her desk',
    '    drop <topic>                  take a beat off her desk',
    '    topics                        list the beats',
    '    now                           sweep the wire right now',
    '    brief ' + d('[--json|--speak]') + '        latest bulletin, right in the terminal',
    '    ask <question…>               ask Pepper about her beats',
    '    export ' + d('[--out dir]') + '            static broadcast site (Cloudflare Pages ready)',
    '    doctor                        studio health check',
    '    daemon install|uninstall|status',
    '                                  keep her on air 24/7 (macOS launchd)',
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
  const { createPepperServer } = await import('../src/server.js');
  const srv = createPepperServer(flags.port != null ? { port: Number(flags.port) } : {});
  const { port } = await srv.listen();
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
    : c.dim('none yet — pepper add "quantum computing"')));
  console.log('   sweep   every ' + (srv.cfg.intervalMinutes || 15) + ' minutes');
  console.log('   brain   ' + brain);
  console.log('');
  console.log('   ' + c.bold('she\'s on the desk') + c.dim(' — ctrl-c to go off air'));
  console.log('');

  if (flags.open) openUrl(url);

  process.on('SIGINT', () => {
    console.log('\n   ' + c.dim('that\'s the sweep — Pepper is off the air. MNN.'));
    try { srv.stop(); } catch {}
    process.exit(0);
  });
}

async function shortStatus() {
  const found = await discoverServer(loadConfig());
  const topics = store.listTopics();
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
    console.log('     beats     ' + (topics.length
      ? truncate(topics.map((t) => t.name).join(', '), 60)
      : c.dim('none — pepper add "quantum computing"')));
    const b = store.latestBulletin();
    console.log('     bulletin  ' + (b ? b.id + ' ' + c.dim('(' + fmtWhen(b.at) + ')') : c.dim('none yet')));
    console.log('     ' + c.dim('start the studio with `pepper start`'));
    console.log('');
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
    console.log('  ' + c.dim('no bulletins yet — she hasn\'t gone to air. Try `pepper now` or `pepper start`.'));
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

async function cmdAsk() {
  const q = args.slice(1).join(' ').trim();
  if (!q) {
    console.log('  usage: pepper ask <question…>');
    process.exitCode = 1;
    return;
  }
  const found = await discoverServer(loadConfig());
  let result = null;
  if (found) {
    try {
      const res = await fetch(found.url + '/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q }),
      });
      if (res.ok) result = await res.json();
    } catch {}
  } else {
    try {
      const { getBrain } = await import('../src/brain/index.js');
      const brain = getBrain();
      result = await brain.ask(q);
      try { brain.stop?.(); } catch {}
    } catch {}
  }
  if (result && result.answer) {
    pepperSays(result.answer, result.mode);
  } else {
    console.log('  ' + c.dim('Pepper\'s brain is off — no Foundation Models, no local LLM configured.'));
    console.log('  ' + c.dim('set `brain.local.url` in ~/.pepper/config.json, or run on Apple Silicon with Apple Intelligence.'));
    process.exitCode = 1;
  }
  exitSoon(process.exitCode || 0);
}

async function cmdExport() {
  const { exportSite } = await import('../src/export.js');
  await exportSite({ outDir: typeof flags.out === 'string' ? flags.out : './pepper-site' });
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
    case 'export': await cmdExport(); break;
    case 'doctor':
      await doctor();
      exitSoon(0);
      break;
    case 'daemon': await cmdDaemon(); break;
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
