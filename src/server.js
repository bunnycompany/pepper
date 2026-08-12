import http from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig, paths, VERSION, ensureHome } from './config.js';
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

export function vendorRoots() {
  const threeRoot = join(require_.resolve('three/package.json'), '..');
  let vrmModule = null;
  try {
    vrmModule = join(require_.resolve('@pixiv/three-vrm/package.json'), '..', 'lib', 'three-vrm.module.js');
    if (!existsSync(vrmModule)) vrmModule = null;
  } catch { vrmModule = null; }
  return {
    threeModule: join(threeRoot, 'build', 'three.module.js'),
    jsmRoot: join(threeRoot, 'examples', 'jsm'),
    vrmModule,
  };
}

export function createPepperServer(opts = {}) {
  ensureHome();
  const cfg = loadConfig();
  const explicitPort = opts.port != null;
  let port = opts.port ?? cfg.port ?? 4747;
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

  async function brainStatus() {
    try {
      const { brain } = await mods();
      return await brain.status();
    } catch (e) {
      return { mode: 'fallback', reason: 'brain unavailable: ' + e.message };
    }
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

  async function doCycle(trigger = 'schedule') {
    if (state.researching) return false;
    state.researching = true;
    sseSend('cycle-start', { at: new Date().toISOString(), trigger });
    pushStatus();
    try {
      const { research } = await mods();
      const summary = await research.runCycle({
        emit: (type, data) => {
          if (type === 'bulletin') state.latestBulletinId = data.id;
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
    const mins = Math.max(3, Number(cfg.intervalMinutes) || 15);
    const delay = state.lastCycleAt ? mins * 60_000 : 2_500;
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
          intervalMinutes: cfg.intervalMinutes,
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

      if (p === '/api/ask' && req.method === 'POST') {
        const { q } = await readBody(req);
        if (!q || !String(q).trim()) return jsonRes(res, 400, { error: 'q required' });
        const { brain } = await mods();
        const answer = await brain.ask(String(q).trim());
        return answer
          ? jsonRes(res, 200, answer)
          : jsonRes(res, 503, { error: 'no brain available' });
      }

      if (p === '/avatar.vrm') return serveFile(res, paths.avatar);
      if (p === '/vendor/three.module.js') return serveFile(res, vendors.threeModule, 'public, max-age=86400');
      if (p === '/vendor/three-vrm.module.js') return serveFile(res, vendors.vrmModule, 'public, max-age=86400');
      if (p.startsWith('/vendor/jsm/')) {
        const rel = normalize(p.slice('/vendor/jsm/'.length));
        if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
        return serveFile(res, join(vendors.jsmRoot, rel), 'public, max-age=86400');
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

  function listen() {
    return new Promise((resolve, reject) => {
      const tryPort = (candidate, left) => {
        server.once('error', (e) => {
          if (e.code === 'EADDRINUSE' && !explicitPort && left > 0) tryPort(candidate + 1, left - 1);
          else reject(e);
        });
        server.listen(candidate, '127.0.0.1', () => {
          port = candidate;
          schedule();
          resolve({ port: candidate });
        });
      };
      tryPort(Number(port), 10);
    });
  }

  function stop() {
    clearTimeout(state.timer);
    clearInterval(ping);
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
    get port() { return port; },
  };
}
