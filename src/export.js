import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig, paths, home, PKG_ROOT } from './config.js';
import { c } from './log.js';
import * as store from './store.js';
import { vendorRoots } from './server.js';

const require_ = createRequire(import.meta.url);

// Fallback vendor resolution for when server.vendorRoots() cannot resolve
// (e.g. a package's exports map hides ./package.json from require.resolve).
function findPkgRoot(name) {
  try {
    let d = dirname(require_.resolve(name));
    for (let i = 0; i < 6 && d !== dirname(d); i++) {
      const pj = join(d, 'package.json');
      if (existsSync(pj)) {
        try {
          if (JSON.parse(readFileSync(pj, 'utf8')).name === name) return d;
        } catch {}
      }
      d = dirname(d);
    }
  } catch {}
  const local = join(PKG_ROOT, 'node_modules', ...name.split('/'));
  return existsSync(local) ? local : null;
}

function fallbackVendorRoots() {
  const threeRoot = findPkgRoot('three');
  if (!threeRoot) throw new Error('cannot find the `three` package');
  const vrmRoot = findPkgRoot('@pixiv/three-vrm');
  const vrmModule = vrmRoot ? join(vrmRoot, 'lib', 'three-vrm.module.js') : null;
  return {
    threeModule: join(threeRoot, 'build', 'three.module.js'),
    jsmRoot: join(threeRoot, 'examples', 'jsm'),
    vrmModule: vrmModule && existsSync(vrmModule) ? vrmModule : null,
  };
}

function copyDir(src, dest) {
  let n = 0;
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else if (e.isFile()) { copyFileSync(s, d); n++; }
  }
  return n;
}

function put(dest, src) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

export async function exportSite({ outDir = './pepper-site' } = {}) {
  const out = resolve(outDir);
  const cfg = loadConfig();
  let files = 0;
  const errors = [];

  console.log('');
  console.log('  🌶 ' + c.bold('pepper export') + c.dim(' → ') + out);
  console.log('');

  // 1. the newsroom webapp
  try {
    const n = copyDir(paths.web, out);
    files += n;
    console.log('  ' + c.green('✓') + ' web/ — ' + n + ' file' + (n === 1 ? '' : 's'));
  } catch (e) {
    errors.push('web/');
    console.log('  ' + c.red('✗') + ' web/ — ' + String(e?.message || e));
  }

  // 2. vendor modules (same layout the live server exposes).
  // vendorRoots() reports a missing `three` as nulls, not a throw.
  let vendors = null;
  try { vendors = vendorRoots(); } catch { vendors = null; }
  if (!vendors?.threeModule) {
    try { vendors = fallbackVendorRoots(); } catch (e) {
      vendors = null;
      errors.push('vendor/');
      console.log('  ' + c.red('✗') + ' vendor/ — ' + String(e?.message || e) + c.dim(' (is `three` installed?)'));
    }
  }
  if (vendors) {
    const jobs = [
      ['vendor/three.module.js', vendors.threeModule],
      ['vendor/three-vrm.module.js', vendors.vrmModule],
      ['vendor/jsm/loaders/GLTFLoader.js', vendors.jsmRoot ? join(vendors.jsmRoot, 'loaders', 'GLTFLoader.js') : null],
      ['vendor/jsm/utils/BufferGeometryUtils.js', vendors.jsmRoot ? join(vendors.jsmRoot, 'utils', 'BufferGeometryUtils.js') : null],
    ];
    for (const [rel, src] of jobs) {
      try {
        if (!src || !existsSync(src)) throw new Error('source not found');
        put(join(out, rel), src);
        files++;
        console.log('  ' + c.green('✓') + ' ' + rel);
      } catch (e) {
        errors.push(rel);
        console.log('  ' + c.red('✗') + ' ' + rel + c.dim(' — ' + String(e?.message || e)));
      }
    }
  }

  // 3. the anchor herself, if the user dropped one in
  try {
    if (existsSync(paths.avatar)) {
      put(join(out, 'avatar.vrm'), paths.avatar);
      files++;
      console.log('  ' + c.green('✓') + ' avatar.vrm');
    } else {
      console.log('  ' + c.dim('– no avatar.vrm — the built-in Pepper will present'));
    }
  } catch (e) {
    errors.push('avatar.vrm');
    console.log('  ' + c.red('✗') + ' avatar.vrm — ' + String(e?.message || e));
  }

  // 4. the broadcast data (what replay mode plays)
  let bulletins = [];
  let ticker = [];
  let topics = [];
  try {
    topics = store.listTopics().map((t) => t.name);
    bulletins = store.listBulletins(10).map((m) => store.getBulletin(m.id)).filter(Boolean);
    ticker = store.allRecentItems(30).map((i) => ({
      title: i.title, source: i.source, topic: i.topicName, url: i.url,
    }));
    const broadcast = {
      generatedAt: new Date().toISOString(),
      site: cfg.site,
      topics,
      bulletins,
      ticker,
    };
    mkdirSync(join(out, 'data'), { recursive: true });
    writeFileSync(join(out, 'data', 'broadcast.json'), JSON.stringify(broadcast, null, 2) + '\n');
    files++;
    console.log('  ' + c.green('✓') + ' data/broadcast.json' + c.dim(
      ` — ${bulletins.length} bulletin${bulletins.length === 1 ? '' : 's'} · ${ticker.length} ticker items · ${topics.length} topic${topics.length === 1 ? '' : 's'}`,
    ));
  } catch (e) {
    errors.push('data/broadcast.json');
    console.log('  ' + c.red('✗') + ' data/broadcast.json — ' + String(e?.message || e));
  }

  // 5. her rendered voice — ship the WAVs for every exported bulletin that has them
  try {
    let audioFiles = 0;
    let withAudio = 0;
    for (const b of bulletins) {
      if (!b?.id) continue;
      const src = join(home(), 'audio', b.id);
      if (!existsSync(src)) continue;
      const n = copyDir(src, join(out, 'audio', b.id));
      if (n > 0) { audioFiles += n; withAudio++; }
    }
    if (audioFiles > 0) {
      files += audioFiles;
      console.log('  ' + c.green('✓') + ' audio/ — '
        + `${audioFiles} file${audioFiles === 1 ? '' : 's'} across ${withAudio} bulletin${withAudio === 1 ? '' : 's'}`
        + c.dim(' — visitors hear her real voice'));
    } else {
      console.log('  ' + c.dim('– no rendered audio — visitors\' browsers will speak the bulletins'));
    }
  } catch (e) {
    errors.push('audio/');
    console.log('  ' + c.red('✗') + ' audio/ — ' + String(e?.message || e));
  }

  // A station with zero bulletins is dead air — flag it as an error (non-zero
  // exit) and keep the deploy pitch off the screen until there is a show.
  const nothingToBroadcast = bulletins.length === 0;
  if (nothingToBroadcast) errors.push('no bulletins');

  console.log('');
  if (nothingToBroadcast) {
    console.log('  ' + c.bgRed(' NOTHING TO BROADCAST ') + ' '
      + c.bold('0 bulletins — she has never gone to air.'));
    console.log('  ' + c.dim('run `pepper now` (or `pepper start`) to sweep the wire, then re-export.'));
    console.log('');
  }
  if (errors.length) {
    console.log('  ' + c.red(`✗ ${errors.length} export step${errors.length === 1 ? '' : 's'} failed — do not deploy this output.`));
  }
  console.log('  ' + c.bold(`${files} files exported.`) + ' ' + c.dim('This is broadcast mode — a static MNN station.'));
  console.log('');
  if (!nothingToBroadcast) {
    console.log('  deploy it on Cloudflare Pages:');
    console.log('    ' + c.cyan(`npx wrangler pages deploy ${outDir}`));
    console.log('    ' + c.dim('— or drag the folder into the dashboard: Workers & Pages → Create → Upload assets'));
    console.log('');
  }
  console.log('  ' + c.dim('MNN — all your models, all the time.'));
  console.log('');

  return { outDir: out, files, errors };
}
