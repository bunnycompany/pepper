import http from 'node:http';
import {
  existsSync, statSync, createReadStream, readFileSync, writeFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig, configIssues, paths, VERSION, ensureHome, PKG_ROOT } from './config.js';
import { log } from './log.js';
import * as store from './store.js';

const require_ = createRequire(import.meta.url);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Exports maps in three/@pixiv/three-vrm block require.resolve('<pkg>/package.json'),
// so locate package roots by directory instead: the normal install layout first,
// then a walk up from the resolved entry file (hoisted/npx layouts).
function findPkgRoot(name) {
  const local = join(PKG_ROOT, 'node_modules', name);
  if (existsSync(join(local, 'package.json'))) return local;
  try {
    let dir = dirname(require_.resolve(name));
    while (dir !== dirname(dir)) {
      const pj = join(dir, 'package.json');
      if (existsSync(pj)) {
        try {
          if (JSON.parse(readFileSync(pj, 'utf8')).name === name) return dir;
        } catch {}
      }
      dir = dirname(dir);
    }
  } catch {}
  return null;
}

export function vendorRoots() {
  const threeRoot = findPkgRoot('three');
  const vrmRoot = findPkgRoot('@pixiv/three-vrm');
  const vrmModule = vrmRoot ? join(vrmRoot, 'lib', 'three-vrm.module.js') : null;
  return {
    threeModule: threeRoot ? join(threeRoot, 'build', 'three.module.js') : null,
    jsmRoot: threeRoot ? join(threeRoot, 'examples', 'jsm') : null,
    vrmModule: vrmModule && existsSync(vrmModule) ? vrmModule : null,
  };
}

export function createPepperServer(opts = {}) {
  ensureHome();
  const cfg = loadConfig();
  const explicitPort = opts.port != null;
  let port = opts.port ?? cfg.port ?? 4747;
  // Effective sweep interval: same clamp schedule() always applied, computed
  // once so the banner and /api/state can report reality, not the raw config.
  const intervalMins = Math.max(3, Number(cfg.intervalMinutes) || 15);
  if (intervalMins !== Number(cfg.intervalMinutes)) {
    log.warn(`intervalMinutes ${JSON.stringify(cfg.intervalMinutes)} is invalid or below the 3-minute minimum — sweeping every ${intervalMins} minutes instead`);
  }
  const vendors = vendorRoots();
  const sse = new Set();
  const state = {
    researching: false,
    lastCycleAt: null,
    nextCycleAt: null,
    timer: null,
    latestBulletinId: store.listBulletins(1)[0]?.id || null,
  };

  // research/brain are built by other modules; import lazily so the server
  // can boot (and serve the studio) even if a cycle can't run yet.
  let researchMod = null;
  let brainInst = null;
  async function mods() {
    if (!researchMod) researchMod = await import('./research.js');
    if (!brainInst) brainInst = (await import('./brain/index.js')).getBrain();
    return { research: researchMod, brain: brainInst };
  }

  function sseSend(type, data) {
    const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(chunk);
  }

  // Brain warm-up can take minutes (first-run swiftc build), and ui.js gives
  // /api/state a 2s budget to decide studio vs broadcast mode — so status
  // reads answer from a cache while the real probe refreshes in background.
  let lastBrain = { mode: 'fallback', reason: 'warming up' };
  let brainRefresh = null;
  function refreshBrain() {
    if (!brainRefresh) {
      brainRefresh = (async () => {
        const prev = JSON.stringify(lastBrain);
        try {
          const { brain } = await mods();
          lastBrain = await brain.status();
        } catch (e) {
          lastBrain = { mode: 'fallback', reason: 'brain unavailable: ' + e.message };
        } finally {
          brainRefresh = null;
        }
        if (JSON.stringify(lastBrain) !== prev) {
          sseSend('status', {
            researching: state.researching,
            nextCycleAt: state.nextCycleAt,
            lastCycleAt: state.lastCycleAt,
            latestBulletinId: state.latestBulletinId,
            brain: lastBrain,
          });
        }
      })();
    }
    return brainRefresh;
  }

  async function brainStatus() {
    const refresh = refreshBrain();
    await Promise.race([
      refresh,
      new Promise((res) => { const t = setTimeout(res, 1200); t.unref?.(); }),
    ]);
    return lastBrain;
  }

  async function pushStatus() {
    sseSend('status', {
      researching: state.researching,
      nextCycleAt: state.nextCycleAt,
      lastCycleAt: state.lastCycleAt,
      latestBulletinId: state.latestBulletinId,
      brain: await brainStatus(),
    });
  }

  // Her real voice: render a filed bulletin's lines to WAVs in background,
  // then tell clients. No-ops harmlessly when the voice tier isn't installed.
  async function renderVoice(bulletinId) {
    try {
      const { getVoicebox } = await import('./voicebox.js');
      const vb = getVoicebox();
      if (!vb.available()) return;
      const b = store.getBulletin(bulletinId);
      if (!b || b.audio) return;
      const ok = await vb.renderBulletin(b, { emit: sseSend });
      if (ok) sseSend('audio-ready', { id: bulletinId });
    } catch (e) {
      log.warn('voice render skipped:', e.message);
    }
  }

  async function doCycle(trigger = 'schedule') {
    if (state.researching) return false;
    state.researching = true;
    sseSend('cycle-start', { at: new Date().toISOString(), trigger });
    pushStatus();
    try {
      const { research } = await mods();
      const summary = await research.runCycle({
        emit: (type, data) => {
          if (type === 'bulletin') {
            state.latestBulletinId = data.id;
            renderVoice(data.id);
          }
          sseSend(type, data);
        },
      });
      state.lastCycleAt = new Date().toISOString();
      sseSend('cycle-end', summary ?? {});
    } catch (e) {
      log.err('cycle failed:', e.message);
      sseSend('cycle-end', { error: e.message });
    } finally {
      state.researching = false;
      schedule();
      pushStatus();
    }
    return true;
  }

  function schedule() {
    clearTimeout(state.timer);
    const delay = state.lastCycleAt ? intervalMins * 60_000 : 2_500;
    state.nextCycleAt = new Date(Date.now() + delay).toISOString();
    state.timer = setTimeout(() => doCycle(), delay);
    state.timer.unref?.();
  }

  const jsonRes = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let b = '';
    req.setEncoding('utf8'); // StringDecoder keeps multibyte chars split across chunks intact
    req.on('data', (chk) => {
      b += chk;
      if (b.length > 65536) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });

  function serveFile(res, file, cache = 'no-cache') {
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': cache,
    });
    createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/healthz') return jsonRes(res, 200, { ok: true, version: VERSION });

      if (p === '/api/state') {
        return jsonRes(res, 200, {
          version: VERSION,
          site: cfg.site,
          voice: cfg.voice,
          intervalMinutes: intervalMins,
          configIssues: configIssues(),
          topics: store.listTopics(),
          brain: await brainStatus(),
          researching: state.researching,
          lastCycleAt: state.lastCycleAt,
          nextCycleAt: state.nextCycleAt,
          latestBulletinId: state.latestBulletinId,
          avatar: existsSync(paths.avatar),
        });
      }

      if (p === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        sse.add(res);
        req.on('close', () => sse.delete(res));
        pushStatus();
        return;
      }

      if (p === '/api/latest') {
        const b = store.latestBulletin();
        return b ? jsonRes(res, 200, b) : jsonRes(res, 404, { error: 'no bulletins yet' });
      }

      if (p.startsWith('/api/bulletins')) {
        const id = decodeURIComponent(p.split('/')[3] || '');
        if (id) {
          const b = store.getBulletin(id);
          return b ? jsonRes(res, 200, b) : jsonRes(res, 404, { error: 'not found' });
        }
        return jsonRes(res, 200, store.listBulletins(Number(url.searchParams.get('limit')) || 20));
      }

      if (p === '/api/ticker') {
        return jsonRes(res, 200, {
          items: store.allRecentItems(30).map((i) => ({
            title: i.title, source: i.source, topic: i.topicName, url: i.url,
          })),
        });
      }

      if (p === '/api/topics' && req.method === 'POST') {
        const { name, lenses } = await readBody(req);
        if (!name || !String(name).trim()) return jsonRes(res, 400, { error: 'name required' });
        try {
          const t = store.addTopic(name, Array.isArray(lenses) && lenses.length ? lenses : undefined);
          sseSend('topics', { topics: store.listTopics() });
          return jsonRes(res, 201, t);
        } catch (e) {
          return jsonRes(res, 400, { error: e.message });
        }
      }

      if (p.startsWith('/api/topics/') && req.method === 'DELETE') {
        const ok = store.dropTopic(decodeURIComponent(p.slice('/api/topics/'.length)));
        sseSend('topics', { topics: store.listTopics() });
        return jsonRes(res, ok ? 200 : 404, { ok });
      }

      if (p === '/api/topics') return jsonRes(res, 200, store.listTopics());

      if (p === '/api/cycle' && req.method === 'POST') {
        if (state.researching) return jsonRes(res, 409, { error: 'already sweeping' });
        doCycle('manual');
        return jsonRes(res, 202, { started: true });
      }

      if (p === '/api/onboard' && req.method === 'POST') {
        const { interests } = await readBody(req);
        if (!interests || !String(interests).trim()) return jsonRes(res, 400, { error: 'interests required' });
        const { brain } = await mods();
        let beats = [];
        const text = await brain.generate({
          instructions: 'You turn a person\'s stated interests into 3 to 6 short news-beat names, one per line, each one to four words, concrete and searchable. No numbering, no commentary.',
          prompt: `Interests: ${String(interests).slice(0, 600)}`,
          max: 90,
        });
        if (text) {
          beats = text.split('\n')
            .map((s) => s.trim().replace(/^[-*\d.)\s]+/, ''))
            .filter((s) => s && s.length <= 40 && /^[\w"'’ .&-]+$/.test(s))
            .slice(0, 6);
        }
        if (!beats.length) {
          beats = String(interests).split(/,|\band\b|;|\n/)
            .map((s) => s.trim()).filter((s) => s && s.length <= 40).slice(0, 6);
        }
        if (!beats.length) {
          // No brain and no list punctuation: a plain sentence must still
          // produce a beat — she invited "plain words are fine".
          const bare = String(interests).trim()
            .replace(/^(i\s+(want|would like|'d like)\s+to\s+(follow|track|watch|see)|follow|track|watch|news\s+(about|on)|keep\s+(an\s+)?eye\s+on)\s+/i, '')
            .replace(/[.!?]+$/, '').trim();
          const clamped = bare.length <= 40 ? bare : bare.slice(0, 40).replace(/\s+\S*$/, '');
          if (clamped) beats = [clamped];
        }
        const added = [];
        for (const b of beats) {
          try { added.push(store.addTopic(b).name); } catch { /* dup — fine */ }
        }
        sseSend('topics', { topics: store.listTopics() });
        if (added.length && !state.researching) doCycle('onboard');
        return jsonRes(res, 200, { added });
      }

      if (p === '/api/research' && req.method === 'POST') {
        const { q } = await readBody(req);
        if (!q || !String(q).trim()) return jsonRes(res, 400, { error: 'q required' });
        const { runDeepResearch } = await import('./deepresearch.js');
        // Long-running; fire it and let SSE narrate. The bulletin event
        // arrives through the same channel the studio already listens to.
        runDeepResearch(String(q).trim(), {
          emit: (type, data) => {
            sseSend(type, data);
            if (type === 'research-done') {
              state.latestBulletinId = data.id;
              renderVoice(data.id);
              sseSend('bulletin', { id: data.id });
            }
          },
        }).catch((e) => log.err('deep research failed:', e.message));
        return jsonRes(res, 202, { started: true });
      }

      if (p === '/api/ask' && req.method === 'POST') {
        const { q } = await readBody(req);
        if (!q || !String(q).trim()) return jsonRes(res, 400, { error: 'q required' });
        const { brain } = await mods();
        const answer = await brain.ask(String(q).trim());
        return answer
          ? jsonRes(res, 200, answer)
          : jsonRes(res, 503, { error: 'no brain available' });
      }

      if (p.startsWith('/audio/')) {
        const rel = normalize(decodeURIComponent(p.slice('/audio/'.length)));
        if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
        return serveFile(res, join(paths.audioDir, rel), 'public, max-age=3600');
      }

      if (p === '/avatar.vrm') return serveFile(res, paths.avatar);
      if (p === '/vendor/three.module.js') return serveFile(res, vendors.threeModule, 'public, max-age=86400');
      if (p === '/vendor/three-vrm.module.js') return serveFile(res, vendors.vrmModule, 'public, max-age=86400');
      if (p.startsWith('/vendor/jsm/')) {
        const rel = normalize(p.slice('/vendor/jsm/'.length));
        if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
        return serveFile(res, vendors.jsmRoot ? join(vendors.jsmRoot, rel) : null, 'public, max-age=86400');
      }

      let rel = p === '/' ? 'index.html' : normalize(decodeURIComponent(p).slice(1));
      if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
      return serveFile(res, join(paths.web, rel));
    } catch (e) {
      log.err(req.method, p, e.message);
      if (!res.headersSent) jsonRes(res, 500, { error: e.message });
    }
  });

  const ping = setInterval(() => { for (const res of sse) res.write(':ping\n\n'); }, 25_000);
  ping.unref?.();

  // ~/.pepper/run.json lets the CLI find a server bound off cfg.port (e.g.
  // `pepper start --port 9000`). Written atomically; a stale file is harmless
  // because discoverServer verifies /healthz before trusting it.
  function writeRunFile() {
    try {
      const tmp = paths.run + '.tmp';
      writeFileSync(tmp, JSON.stringify({
        port, pid: process.pid, startedAt: new Date().toISOString(),
      }, null, 2) + '\n');
      renameSync(tmp, paths.run);
    } catch {}
  }

  function removeRunFile() {
    try {
      // Leave the file alone if another live instance owns it.
      const info = JSON.parse(readFileSync(paths.run, 'utf8'));
      if (info && typeof info === 'object' && info.pid !== process.pid) return;
    } catch {}
    try { unlinkSync(paths.run); } catch {}
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const tryPort = (candidate, left) => {
        // A failed attempt leaves its listen() callback registered as a stale
        // once('listening') listener that would resolve with the busy port.
        server.removeAllListeners('listening');
        server.once('error', (e) => {
          if (e.code === 'EADDRINUSE' && !explicitPort && left > 0) tryPort(candidate + 1, left - 1);
          else reject(e);
        });
        server.listen(candidate, '127.0.0.1', () => {
          port = server.address().port;
          writeRunFile();
          schedule();
          resolve({ port });
        });
      };
      tryPort(Number(port), 10);
    });
  }

  function stop() {
    clearTimeout(state.timer);
    clearInterval(ping);
    removeRunFile();
    for (const res of sse) { try { res.end(); } catch {} }
    server.close();
  }

  return {
    server,
    listen,
    stop,
    doCycle,
    state,
    cfg,
    effectiveIntervalMinutes: intervalMins,
    get port() { return port; },
  };
}
