// Pepper — MNN 3D newsroom.
// Sets window.newsroom synchronously at module load (CONTRACTS.md §5.4).
// VRM avatar at ./avatar.vrm when present, otherwise a built-in chibi Pepper.
// No network beyond ./avatar.vrm; no assets beyond procedural geometry/canvas.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// ---------------------------------------------------------------------------
// tiny utils + tween helper
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const damp = (cur, tgt, rate, dt) => lerp(cur, tgt, 1 - Math.exp(-rate * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const easeInOut = (k) => k * k * (3 - 2 * k);
const linear = (k) => k;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const tweens = [];
function tween(dur, update, done = null, ease = easeInOut) {
  tweens.push({ t: 0, dur: Math.max(0.01, dur), update, done, ease });
}
function stepTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t += dt;
    const k = clamp(tw.t / tw.dur, 0, 1);
    try { tw.update(tw.ease(k)); } catch { /* a broken tween must not kill the loop */ }
    if (k >= 1) {
      tweens.splice(i, 1);
      if (tw.done) { try { tw.done(); } catch { /* ignore */ } }
    }
  }
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const MNN_RED = 0xe02020;
const CYAN = 0x35d6ff;
const VOID = 0x050b14;
const SKIN = 0xffe3d0;
const HAIR = 0xe0452a;
const NAVY = 0x1b2c52;

const RISER_H = 0.12;
const DESK_H = 0.95;
const DESK_R = 1.15;
const DESK_TOP = RISER_H + DESK_H;
const DESK_ARC = 2.2;

const MOODS = {
  breaking: { accent: 0xff2a20, rim: 0xff5844, strip: 0xff2222, pulse: 3.0, accentI: 26, pace: 1.5 },
  developing: { accent: 0xffa028, rim: 0xffc27d, strip: 0xffa030, pulse: 1.7, accentI: 16, pace: 1.15 },
  steady: { accent: 0x2f6fd8, rim: 0x86b8ff, strip: 0x35d6ff, pulse: 1.0, accentI: 13, pace: 1.0 },
  quirky: { accent: 0xcf3fff, rim: 0xd08cff, strip: 0xff4fd0, pulse: 1.35, accentI: 15, pace: 1.1 },
  idle: { accent: 0x4d5c78, rim: 0x9db4d8, strip: 0xe02020, pulse: 0.65, accentI: 8, pace: 0.8 },
};
const MOOD_HEX = { breaking: '#ff3524', developing: '#ffa030', steady: '#35d6ff', quirky: '#ff4fd0' };

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const S = {
  ok: false, dead: false, first: false, errors: 0,
  time: 0, clock: null,
  renderer: null, scene: null, camera: null,
  mouse: { x: 0, y: 0 }, par: { x: 0, y: 0 },
  shot: 'med', mood: 'idle',
  onAir: false, sweepOn: false,
  talk: { active: false, level: 0, target: 0, next: 0 },
  blinkV: 0, nextBlinkAt: 1.6,
  happy: 0, brow: 0, flash: 0, spring: 0,
  gaze: { mode: 'camera', until: 0 },
  lookTarget: null, aim: { x: 0, y: 0 },
  gest: { busy: false, headX: 0, armX: 0, wave: 0, shuffling: false },
  nextIdleAt: 8,
  headY: 1.62,
  wall: { mode: 'idle', title: '', seg: null, topics: [] },
  scr: { c: null, l: null, r: null },
  acc: { right: 10, center: 10 },
  wire: { bars: [], spark: [] },
  desk: null, mug: null, papers: null, strip: null, stripColor: null,
  onAirBox: null, dust: null, dustVel: null, steam: [], steamAlpha: 1, steamBoost: 0,
  key: null, rim: null, accent: null, logoGlow: null,
  bp: null, vrm: null, vrmB: null, avatarGroup: null,
  camBase: { pos: V3(), look: V3() }, lookTmp: V3(),
  tmpA: V3(), tmpB: V3(), tmpColor: new THREE.Color(), tmpColor2: new THREE.Color(),
};

// ---------------------------------------------------------------------------
// public API — assigned synchronously; every method is safe at any time
// ---------------------------------------------------------------------------

let resolveReady;
const readyPromise = new Promise((res) => { resolveReady = res; });

const safe = (fn) => (...args) => {
  try { if (S.ok && !S.dead) return fn(...args); } catch (err) { console.warn('[newsroom]', err); }
};

window.newsroom = {
  ready: readyPromise,
  avatar: 'builtin',
  setOnAir: safe(setOnAir),
  setTalking: safe(setTalking),
  setMood: safe(setMood),
  showOpen: safe(showOpen),
  showSegment: safe(showSegment),
  showIdle: safe(showIdle),
  sweep: safe(setSweep),
  pulseBreaking: safe(pulseBreaking),
  gesture: safe(gesture),
  cut: safe(cut),
  setWireStats: safe(setWireStats),
};

// Real wire data replaces the decorative random walk the moment it arrives.
function setWireStats(stats) {
  const s = stats || {};
  if (Array.isArray(s.beats) && s.beats.length) {
    const counts = s.beats.map((b) => Math.max(0, Number(b.count) || 0));
    const max = Math.max(1, ...counts);
    S.wire.bars = counts.map((c) => 0.12 + 0.85 * (c / max));
    S.wire.beatNames = s.beats.map((b) => String(b.name || '').slice(0, 12));
  }
  if (Number.isFinite(s.perHour)) {
    S.wire.perHour = Math.max(0, Math.round(s.perHour));
    S.wire.spark.push(Math.min(1, 0.15 + (S.wire.perHour / Math.max(60, S.wire.perHour * 1.4))));
    if (S.wire.spark.length > 48) S.wire.spark.shift();
  }
  S.wire.real = true;
  drawRight();
}

function setOnAir(on) { S.onAir = !!on; }

function setTalking(on) { S.talk.active = !!on; }

function setMood(mood) { S.mood = MOODS[mood] ? mood : 'idle'; }

function showOpen(opts) {
  S.wall.mode = 'open';
  S.wall.title = String((opts && opts.title) || 'MODEL NEWS NETWORK').slice(0, 80);
  drawCenter();
}

function showSegment(opts) {
  const o = opts || {};
  S.wall.mode = 'segment';
  S.wall.seg = {
    topic: String(o.topic || '').slice(0, 48),
    headline: String(o.headline || '').slice(0, 140),
    mood: MOODS[o.mood] ? o.mood : 'steady',
    sources: Array.isArray(o.sources) ? o.sources : [],
  };
  drawCenter();
}

function showIdle(opts) {
  const o = opts || {};
  S.wall.mode = 'idle';
  if (Array.isArray(o.topics)) {
    S.wall.topics = o.topics
      .map((t) => (typeof t === 'string' ? t : (t && (t.name || t.slug)) || ''))
      .filter(Boolean).slice(0, 8);
  }
  drawCenter();
  drawLeft();
}

function setSweep(on) {
  const next = !!on;
  if (next === S.sweepOn) return;
  S.sweepOn = next;
  S.acc.center = 10;
  drawCenter();
  drawLeft();
}

function pulseBreaking() {
  S.flash = 1;
  S.spring = 1;
}

function gesture(name) {
  const map = { sip: gestureSip, shuffle: gestureShuffle, nod: gestureNod, wave: gestureWave };
  if (map[name]) map[name]();
}

function cut(shot) {
  S.shot = (shot === 'wide' || shot === 'med' || shot === 'close' || shot === 'screen') ? shot : 'med';
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function boot() {
  try {
    initRenderer();
    initSceneGraph();
    initEvents();
    startAvatar();
    S.ok = true;
    requestAnimationFrame(animate);
  } catch (err) {
    console.error('[newsroom] init failed — 3D disabled:', err);
    S.ok = false;
    showNoSceneCard();
    resolveReady();
  }
}

// Graceful degrade when WebGL is unavailable: a visible studio card instead
// of a silent black void. The overlay (chyron, ticker, voice) keeps
// broadcasting on top — styles live in style.css (#no-scene).
function showNoSceneCard() {
  try {
    if (document.getElementById('no-scene')) return;
    const wrap = document.createElement('div');
    wrap.id = 'no-scene';
    const card = document.createElement('div');
    card.className = 'ns-card';
    const mark = document.createElement('div');
    mark.className = 'ns-mark';
    mark.textContent = 'MNN';
    const msg = document.createElement('p');
    msg.className = 'ns-msg';
    msg.textContent = 'Her studio needs WebGL — this device can’t draw the 3D set.';
    const sub = document.createElement('p');
    sub.className = 'ns-sub';
    sub.textContent = 'The broadcast continues as captions.';
    card.append(mark, msg, sub);
    wrap.append(card);
    (document.body || document.documentElement).append(wrap);
  } catch { /* the overlay still runs without the card */ }
}

function ensureCanvas() {
  let cv = document.getElementById('scene');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'scene';
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;z-index:0;';
    (document.body || document.documentElement).appendChild(cv);
  }
  return cv;
}

function initRenderer() {
  const canvas = ensureCanvas();
  S.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  S.renderer.setSize(window.innerWidth, window.innerHeight);
  S.renderer.outputColorSpace = THREE.SRGBColorSpace;
  S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  S.renderer.toneMappingExposure = 1.05;
  S.renderer.shadowMap.enabled = true;
  S.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  S.scene = new THREE.Scene();
  S.scene.background = new THREE.Color(VOID);
  S.scene.fog = new THREE.FogExp2(VOID, 0.05);

  S.camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 60);
  S.camera.position.set(0, 1.26, 3.3);

  S.clock = new THREE.Clock();
  S.lookTarget = new THREE.Object3D();
  S.lookTarget.position.copy(S.camera.position);
}

function initSceneGraph() {
  buildEnvMap();
  buildStudio();
  buildDesk();
  buildScreens();
  buildOnAirBox();
  buildDust();
  S.scene.add(S.lookTarget);
  S.avatarGroup = new THREE.Group();
  S.avatarGroup.position.y = RISER_H;
  S.scene.add(S.avatarGroup);
  for (let i = 0; i < 9; i++) S.wire.bars.push(rand(0.2, 0.9));
  for (let i = 0; i < 48; i++) S.wire.spark.push(rand(0.3, 0.7));
  drawCenter();
  drawLeft();
  drawRight();
}

function initEvents() {
  window.addEventListener('resize', () => {
    if (!S.renderer) return;
    S.camera.aspect = window.innerWidth / window.innerHeight;
    S.camera.updateProjectionMatrix();
    S.renderer.setSize(window.innerWidth, window.innerHeight);
  });
  window.addEventListener('mousemove', (e) => {
    S.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    S.mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
  });
}

// A tiny procedural equirect environment gives the clearcoat floor and
// materials something to reflect — no external assets.
function buildEnvMap() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0a1322';
  ctx.fillRect(0, 0, 256, 128);
  const warm = ctx.createRadialGradient(62, 30, 4, 62, 30, 52);
  warm.addColorStop(0, 'rgba(255,196,130,0.95)');
  warm.addColorStop(1, 'rgba(255,196,130,0)');
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, 256, 128);
  const cool = ctx.createRadialGradient(198, 26, 4, 198, 26, 58);
  cool.addColorStop(0, 'rgba(96,164,255,0.85)');
  cool.addColorStop(1, 'rgba(96,164,255,0)');
  ctx.fillStyle = cool;
  ctx.fillRect(0, 0, 256, 128);
  const red = ctx.createRadialGradient(128, 100, 4, 128, 100, 40);
  red.addColorStop(0, 'rgba(224,32,32,0.7)');
  red.addColorStop(1, 'rgba(224,32,32,0)');
  ctx.fillStyle = red;
  ctx.fillRect(0, 0, 256, 128);

  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(S.renderer);
  const rt = pmrem.fromEquirectangular(tex);
  S.scene.environment = rt.texture;
  if ('environmentIntensity' in S.scene) S.scene.environmentIntensity = 0.5;
  tex.dispose();
  pmrem.dispose();
}

// ---------------------------------------------------------------------------
// studio: floor, riser, lights, spot rigs, dust
// ---------------------------------------------------------------------------

function buildStudio() {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(10, 48),
    new THREE.MeshPhysicalMaterial({
      color: 0x06090f, roughness: 0.16, metalness: 0.5,
      clearcoat: 1.0, clearcoatRoughness: 0.12,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  S.scene.add(floor);

  const riser = new THREE.Mesh(
    new THREE.CylinderGeometry(2.05, 2.15, RISER_H, 48),
    new THREE.MeshStandardMaterial({ color: 0x0a1220, roughness: 0.5, metalness: 0.3 }),
  );
  riser.position.y = RISER_H / 2;
  riser.receiveShadow = true;
  S.scene.add(riser);

  const rimGlow = new THREE.Mesh(
    new THREE.TorusGeometry(2.1, 0.012, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x1a3a55, toneMapped: false, fog: false }),
  );
  rimGlow.rotation.x = -Math.PI / 2;
  rimGlow.position.y = RISER_H;
  S.scene.add(rimGlow);

  // faked red spill from the desk logo onto the glossy floor
  const glowCv = document.createElement('canvas');
  glowCv.width = 128; glowCv.height = 128;
  const gctx = glowCv.getContext('2d');
  const gg = gctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  gg.addColorStop(0, 'rgba(224,32,32,0.55)');
  gg.addColorStop(1, 'rgba(224,32,32,0)');
  gctx.fillStyle = gg;
  gctx.fillRect(0, 0, 128, 128);
  const glowTex = new THREE.CanvasTexture(glowCv);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 1.6),
    new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(0, 0.004, 1.35);
  S.scene.add(glow);

  S.scene.add(new THREE.HemisphereLight(0x33415e, 0x05070c, 0.55));

  const deskTarget = new THREE.Object3D();
  deskTarget.position.set(0, 1.25, 0);
  S.scene.add(deskTarget);

  S.key = spotRig(-2.3, 3.5, 2.5, 0xffe0b8, 150, 0.5, deskTarget, true);
  S.rim = spotRig(2.4, 3.4, -1.5, 0x86b8ff, 90, 0.55, deskTarget, false);

  S.accent = new THREE.PointLight(0x4d5c78, 8, 0, 2);
  S.accent.position.set(0, 2.2, -1.5);
  S.scene.add(S.accent);

  S.logoGlow = new THREE.PointLight(MNN_RED, 5, 4, 2);
  S.logoGlow.position.set(0, 0.6, 1.5);
  S.scene.add(S.logoGlow);
}

function spotRig(x, y, z, color, intensity, angle, target, shadows) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const metal = new THREE.MeshStandardMaterial({ color: 0x161b26, roughness: 0.4, metalness: 0.8 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.32, 16), metal);
  body.geometry.rotateX(Math.PI / 2);
  g.add(body);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.014, 8, 24), metal);
  ring.position.z = 0.16;
  g.add(ring);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.075, 20),
    new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false }),
  );
  lens.position.z = 0.165;
  g.add(lens);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), metal);
  stem.position.y = 0.35;
  g.add(stem);
  g.lookAt(target.position);

  const light = new THREE.SpotLight(color, intensity, 0, angle, 0.55, 2);
  light.position.set(x, y, z);
  light.target = target;
  if (shadows) {
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.0004;
  }
  S.scene.add(g);
  S.scene.add(light);
  return light;
}

function buildDust() {
  const N = 220;
  const pos = new Float32Array(N * 3);
  S.dustVel = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = rand(-4.5, 4.5);
    pos[i * 3 + 1] = rand(0.1, 4);
    pos[i * 3 + 2] = rand(-3, 3.5);
    S.dustVel[i * 3] = rand(-0.02, 0.02);
    S.dustVel[i * 3 + 1] = rand(-0.015, 0.008);
    S.dustVel[i * 3 + 2] = rand(-0.02, 0.02);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  S.dust = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0x8fa4c0, size: 0.018, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  S.scene.add(S.dust);
}

// ---------------------------------------------------------------------------
// desk + props
// ---------------------------------------------------------------------------

function buildDesk() {
  const g = new THREE.Group();
  g.position.y = RISER_H;
  const navyMat = new THREE.MeshStandardMaterial({ color: 0x101c36, roughness: 0.35, metalness: 0.45 });
  const topMat = new THREE.MeshPhysicalMaterial({
    color: 0x0d1730, roughness: 0.2, metalness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.2,
  });

  // fascia: partial cylinder, arc centered on +z (toward camera)
  const fascia = new THREE.Mesh(
    new THREE.CylinderGeometry(DESK_R, DESK_R, DESK_H, 48, 1, true, -DESK_ARC / 2, DESK_ARC),
    navyMat,
  );
  fascia.material.side = THREE.DoubleSide;
  fascia.position.y = DESK_H / 2;
  fascia.castShadow = true;
  g.add(fascia);

  // ring-segment top; RingGeometry lies in XY with theta from +x, and
  // rotateX(-PI/2) maps angle phi -> (cos phi, 0, -sin phi), so an arc
  // centered on -PI/2 ends up centered on +z.
  const topGeo = new THREE.RingGeometry(0.52, 1.32, 48, 1, -Math.PI / 2 - DESK_ARC / 2, DESK_ARC);
  topGeo.rotateX(-Math.PI / 2);
  const top = new THREE.Mesh(topGeo, topMat);
  top.material.side = THREE.DoubleSide;
  top.position.y = DESK_H;
  top.castShadow = true;
  top.receiveShadow = true;
  g.add(top);

  // glowing MNN logo panel front-center
  const logoCv = document.createElement('canvas');
  logoCv.width = 384; logoCv.height = 224;
  const lc = logoCv.getContext('2d');
  const lg = lc.createLinearGradient(0, 0, 0, 224);
  lg.addColorStop(0, '#ff3524');
  lg.addColorStop(1, '#8d0f0a');
  lc.fillStyle = lg;
  lc.fillRect(0, 0, 384, 224);
  lc.fillStyle = '#ffffff';
  lc.font = '900 118px "Avenir Next", "Helvetica Neue", Arial, sans-serif';
  lc.textAlign = 'center';
  lc.textBaseline = 'middle';
  lc.fillText('MNN', 192, 100);
  lc.fillRect(64, 172, 256, 6);
  const logoTex = new THREE.CanvasTexture(logoCv);
  logoTex.colorSpace = THREE.SRGBColorSpace;
  const logo = new THREE.Mesh(
    new THREE.PlaneGeometry(0.58, 0.34),
    new THREE.MeshBasicMaterial({ map: logoTex, toneMapped: false, fog: false }),
  );
  logo.position.set(0, 0.5, DESK_R + 0.012);
  g.add(logo);

  // emissive light strip along the fascia just under the top lip
  const stripGeo = new THREE.TorusGeometry(DESK_R + 0.008, 0.014, 8, 64, DESK_ARC);
  stripGeo.rotateZ(-Math.PI / 2 - DESK_ARC / 2);
  stripGeo.rotateX(-Math.PI / 2);
  S.strip = new THREE.Mesh(stripGeo, new THREE.MeshBasicMaterial({ color: MNN_RED, toneMapped: false, fog: false }));
  S.strip.position.y = DESK_H - 0.06;
  S.stripColor = new THREE.Color(MNN_RED);
  g.add(S.strip);

  // nameplate
  const nameCv = document.createElement('canvas');
  nameCv.width = 512; nameCv.height = 92;
  const nc = nameCv.getContext('2d');
  nc.fillStyle = '#0b1526';
  nc.fillRect(0, 0, 512, 92);
  nc.fillStyle = '#e02020';
  nc.fillRect(0, 0, 14, 92);
  nc.fillStyle = '#ffffff';
  nc.font = '800 44px "Avenir Next", "Helvetica Neue", Arial, sans-serif';
  nc.textBaseline = 'middle';
  nc.fillText('PEPPER', 36, 42);
  nc.fillStyle = '#8fa4c0';
  nc.font = '500 26px "Avenir Next", "Helvetica Neue", Arial, sans-serif';
  nc.fillText('· Research Desk', 226, 46);
  const nameTex = new THREE.CanvasTexture(nameCv);
  nameTex.colorSpace = THREE.SRGBColorSpace;
  const plateMats = [];
  for (let i = 0; i < 6; i++) {
    plateMats.push(i === 4
      ? new THREE.MeshBasicMaterial({ map: nameTex, toneMapped: false, fog: false })
      : new THREE.MeshStandardMaterial({ color: 0x0b1526, roughness: 0.4, metalness: 0.5 }));
  }
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.085, 0.02), plateMats);
  plate.position.set(0, DESK_H + 0.05, 0.92);
  plate.rotation.x = -0.12;
  g.add(plate);

  buildMug(g);
  buildPapers(g);

  S.desk = g;
  S.scene.add(g);
}

function buildMug(deskGroup) {
  const mug = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: MNN_RED, roughness: 0.35, metalness: 0.1 });
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 20), mat);
  cup.castShadow = true;
  mug.add(cup);
  const coffee = new THREE.Mesh(
    new THREE.CircleGeometry(0.04, 20),
    new THREE.MeshStandardMaterial({ color: 0x2a1508, roughness: 0.25 }),
  );
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.y = 0.048;
  mug.add(coffee);
  // handle: half torus in XY bulging +x
  const handleGeo = new THREE.TorusGeometry(0.032, 0.009, 10, 20, Math.PI);
  handleGeo.rotateZ(-Math.PI / 2);
  const handle = new THREE.Mesh(handleGeo, mat);
  handle.position.set(0.045, 0, 0);
  mug.add(handle);
  mug.position.set(0.46, DESK_H + 0.05, 0.74);
  mug.userData.home = mug.position.clone();
  deskGroup.add(mug);
  S.mug = mug;
  buildSteam(mug);
}

function buildSteam(mug) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext('2d');
  const gr = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  gr.addColorStop(0, 'rgba(255,255,255,0.7)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  for (let i = 0; i < 3; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthWrite: false,
    }));
    sp.scale.setScalar(0.07);
    sp.userData = { phase: i / 3, speed: rand(0.16, 0.24) };
    mug.add(sp);
    S.steam.push(sp);
  }
}

function buildPapers(deskGroup) {
  const papers = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, roughness: 0.9 });
  for (let i = 0; i < 6; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.0035, 0.19), white);
    p.position.set(rand(-0.01, 0.01), 0.004 + i * 0.004, rand(-0.008, 0.008));
    p.rotation.y = rand(-0.12, 0.12);
    p.userData.base = { y: p.position.y, ry: p.rotation.y };
    p.castShadow = true;
    papers.add(p);
  }
  papers.position.set(-0.42, DESK_H, 0.78);
  papers.rotation.y = 0.28;
  deskGroup.add(papers);
  S.papers = papers;
}

// ---------------------------------------------------------------------------
// video wall + ON AIR box
// ---------------------------------------------------------------------------

// gently curved panel: displace plane vertices toward the camera at the
// edges (z += curve * x^2) so the wall wraps around the desk
function makeCurvedPanel(w, h, curve) {
  const geo = new THREE.PlaneGeometry(w, h, 24, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, curve * x * x);
  }
  geo.computeVertexNormals();
  return geo;
}

function makeScreen(wpx, hpx, wm, hm) {
  const canvas = document.createElement('canvas');
  canvas.width = wpx; canvas.height = hpx;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(
    makeCurvedPanel(wm, hm, 0.055),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, fog: false }),
  );
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(wm + 0.1, hm + 0.1, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x0a0f18, roughness: 0.4, metalness: 0.7 }),
  );
  frame.position.z = -0.045;
  mesh.add(frame);
  return { canvas, ctx, tex, mesh, w: wpx, h: hpx };
}

function buildScreens() {
  S.scr.c = makeScreen(1024, 576, 2.5, 1.4);
  S.scr.c.mesh.position.set(0, 1.92, -2.75);

  S.scr.l = makeScreen(768, 512, 2.15, 1.32);
  S.scr.l.mesh.position.set(-2.6, 1.9, -2.35);
  S.scr.l.mesh.rotation.y = 0.42;

  S.scr.r = makeScreen(768, 512, 2.15, 1.32);
  S.scr.r.mesh.position.set(2.6, 1.9, -2.35);
  S.scr.r.mesh.rotation.y = -0.42;

  S.scene.add(S.scr.c.mesh, S.scr.l.mesh, S.scr.r.mesh);
}

function buildOnAirBox() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 176;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#160303';
  ctx.fillRect(0, 0, 512, 176);
  ctx.strokeStyle = '#ff3524';
  ctx.lineWidth = 10;
  ctx.strokeRect(12, 12, 488, 152);
  ctx.fillStyle = '#ff3524';
  ctx.font = '900 96px "Avenir Next", "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ON AIR', 256, 94);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mats = [];
  for (let i = 0; i < 6; i++) {
    mats.push(i === 4
      ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, fog: false })
      : new THREE.MeshStandardMaterial({ color: 0x0a0f18, roughness: 0.5, metalness: 0.6 }));
  }
  S.onAirBox = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.32, 0.1), mats);
  S.onAirBox.position.set(0, 2.88, -2.72);
  S.scene.add(S.onAirBox);
}

// ---------------------------------------------------------------------------
// built-in chibi Pepper
// ---------------------------------------------------------------------------

function limb(from, to, r, mat) {
  const d = to.clone().sub(from);
  const len = d.length();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.02, len - r), 4, 12), mat);
  mesh.position.copy(from).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(V3(0, 1, 0), d.normalize());
  mesh.castShadow = true;
  return mesh;
}

function buildBuiltinPepper() {
  const root = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.6 });
  const hair = new THREE.MeshStandardMaterial({ color: HAIR, roughness: 0.5 });
  const blazer = new THREE.MeshStandardMaterial({ color: NAVY, roughness: 0.65 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f6fa, roughness: 0.6 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0e3f4a, roughness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x11151f, roughness: 0.45 });

  // torso — small navy blazer capsule; lower half hides behind the desk
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.42, 8, 20), blazer);
  torso.position.set(0, 0.86, 0);
  torso.castShadow = true;
  root.add(torso);

  for (const side of [-1, 1]) {
    const lapel = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.05, 0.02), white);
    lapel.position.set(0.07 * side, 1.35, 0.24);
    lapel.rotation.z = -0.55 * side;
    root.add(lapel);
  }
  const pin = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 10, 10),
    new THREE.MeshStandardMaterial({ color: MNN_RED, emissive: MNN_RED, emissiveIntensity: 0.8 }),
  );
  pin.position.set(0.15, 1.27, 0.24);
  root.add(pin);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.14, 12), skin);
  neck.position.set(0, 1.4, 0.02);
  root.add(neck);

  // head group pivots at the neck so aim/nod rotations look natural
  const headGrp = new THREE.Group();
  headGrp.position.set(0, 1.45, 0.02);
  root.add(headGrp);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), skin);
  head.position.set(0, 0.17, 0);
  head.castShadow = true;
  headGrp.add(head);

  // pepper-red bob: cap + back curtain + fringe + side locks
  const hairGrp = new THREE.Group();
  hairGrp.position.set(0, 0.17, 0);
  headGrp.add(hairGrp);
  // Cap stops well above eye level (phi 0.45π): the forehead and eyes must
  // stay clear; the curtain covers the back down to the nape.
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.46, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.45), hair);
  cap.rotation.x = -0.08;
  cap.castShadow = true;
  hairGrp.add(cap);
  // SphereGeometry z = sin(phi)·sin(theta): phi in (PI, 2PI) is the back half
  const curtain = new THREE.Mesh(new THREE.SphereGeometry(0.455, 32, 14, Math.PI, Math.PI, 0, Math.PI * 0.85), hair);
  hairGrp.add(curtain);
  // Bangs: small puffs tucked against the cap rim — texture, not curlers.
  const fringeXs = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3];
  for (let i = 0; i < fringeXs.length; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(i % 2 ? 0.07 : 0.062, 14, 12), hair);
    f.position.set(fringeXs[i], 0.3, 0.33 - Math.abs(fringeXs[i]) * 0.28);
    hairGrp.add(f);
  }
  // Chin-length locks hanging close along the cheeks.
  for (const side of [-1, 1]) {
    const lock = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.34, 4, 12), hair);
    lock.position.set(0.4 * side, -0.16, 0.05);
    lock.rotation.z = 0.05 * side;
    hairGrp.add(lock);
  }

  // ahoge antenna — thin curved tube + ball tip, springs on pulseBreaking();
  // rooted in the cap shell (hair top ≈ 0.46) so it visibly grows from her.
  const ahoge = new THREE.Group();
  ahoge.position.set(0, 0.43, -0.02);
  const curve = new THREE.CatmullRomCurve3([
    V3(0, 0, 0), V3(0.05, 0.09, -0.015), V3(-0.015, 0.16, 0.015), V3(0.02, 0.22, 0),
  ]);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.01, 6), hair);
  ahoge.add(tube);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 10), hair);
  tip.position.copy(curve.getPoint(1));
  ahoge.add(tip);
  hairGrp.add(ahoge);

  // eyes: dark-teal flattened spheres + white specular dots; blink = scaleY
  // Face features sit proud of the head surface (r=0.42 at the head center,
  // which lives at headGrp y=0.17) — anything under z≈0.40 is buried skin.
  const eyes = {};
  for (const side of [-1, 1]) {
    const grp = new THREE.Group();
    grp.position.set(0.155 * side, 0.2, 0.4);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.095, 18, 14), eyeMat);
    ball.scale.z = 0.45;
    grp.add(ball);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 8), white);
    dot.position.set(0.028 * side, 0.035, 0.048);
    grp.add(dot);
    headGrp.add(grp);
    eyes[side === -1 ? 'r' : 'l'] = grp;
  }

  const brows = {};
  for (const side of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.022, 0.02), hair);
    brow.position.set(0.155 * side, 0.34, 0.34);
    brow.rotation.z = -0.08 * side;
    headGrp.add(brow);
    brows[side === -1 ? 'r' : 'l'] = brow;
  }

  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0x8a3a34, roughness: 0.4 }));
  mouth.position.set(0, 0.02, 0.415);
  mouth.scale.set(1.1, 0.45, 0.4);
  headGrp.add(mouth);

  const blushes = [];
  for (const side of [-1, 1]) {
    const blush = new THREE.Mesh(
      new THREE.CircleGeometry(0.05, 16),
      new THREE.MeshBasicMaterial({
        color: 0xff9d8a, transparent: true, opacity: 0.55, depthWrite: false, fog: false,
      }),
    );
    blush.position.set(0.26 * side, 0.06, 0.345);
    blush.rotation.y = 0.55 * side;
    headGrp.add(blush);
    blushes.push(blush);
  }

  // Soft warm fill so her face reads under the studio key.
  const faceFill = new THREE.PointLight(0xfff1e0, 2.2, 4, 2);
  faceFill.position.set(0, 1.95, 1.5);
  root.add(faceFill);

  // broadcaster earpiece with a thin mic boom to the cheek
  const ear = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), dark);
  ear.position.set(0.4, 0.2, 0.08);
  headGrp.add(ear);
  const boomCurve = new THREE.CatmullRomCurve3([
    V3(0.4, 0.14, 0.12), V3(0.37, 0.03, 0.3), V3(0.26, 0, 0.38),
  ]);
  const boom = new THREE.Mesh(new THREE.TubeGeometry(boomCurve, 10, 0.008, 6), dark);
  headGrp.add(boom);
  const mic = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), dark);
  mic.position.copy(boomCurve.getPoint(1));
  headGrp.add(mic);

  // arms: pivot groups at the shoulders, hands resting on the desk top
  const arms = {};
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(0.3 * side, 1.16, 0.06);
    const handLocal = V3(-0.04 * side, -0.16, 0.56);
    arm.add(limb(V3(0, 0, 0), handLocal, 0.055, blazer));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 12), skin);
    hand.position.copy(handLocal);
    hand.castShadow = true;
    arm.add(hand);
    root.add(arm);
    arms[side === -1 ? 'r' : 'l'] = arm;
  }

  S.bp = { root, torso, headGrp, eyes, brows, mouth, blushes, ahoge, arms };
  S.headY = RISER_H + 1.62;
  S.avatarGroup.add(root);
}

// ---------------------------------------------------------------------------
// VRM avatar
// ---------------------------------------------------------------------------

function startAvatar() {
  loadVRMAvatar().then(() => {
    window.newsroom.avatar = 'vrm';
  }).catch((err) => {
    console.info('[newsroom] no VRM avatar (' + (err && err.message) + ') — using built-in Pepper');
    try {
      buildBuiltinPepper();
    } catch (e) {
      console.error('[newsroom] builtin avatar failed:', e);
    }
    window.newsroom.avatar = 'builtin';
  });
}

async function loadVRMAvatar() {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync('./avatar.vrm');
  const vrm = gltf.userData && gltf.userData.vrm;
  if (!vrm || !vrm.scene) throw new Error('file is not a VRM');

  try { if (typeof VRMUtils.removeUnnecessaryVertices === 'function') VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch { /* optional */ }
  try {
    if (typeof VRMUtils.combineSkeletons === 'function') VRMUtils.combineSkeletons(gltf.scene);
    else if (typeof VRMUtils.removeUnnecessaryJoints === 'function') VRMUtils.removeUnnecessaryJoints(gltf.scene);
  } catch { /* optional */ }
  try { if (typeof VRMUtils.rotateVRM0 === 'function') VRMUtils.rotateVRM0(vrm); } catch { /* optional */ }

  // She signs on, she doesn't pop in: collect materials and fade her up
  // over ~0.9s once she's seated (ramp driven from the animate loop).
  const fadeMats = [];
  vrm.scene.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.frustumCulled = false;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        fadeMats.push({ m, opacity: m.opacity != null ? m.opacity : 1, transparent: !!m.transparent });
        m.transparent = true;
        m.opacity = 0;
        m.depthWrite = true;
      }
    }
  });
  S.avatarFade = { t: 0, dur: 0.9, mats: fadeMats };

  S.vrm = vrm;
  S.vrmB = poseVRMSeated(vrm);
  S.avatarGroup.add(vrm.scene);

  // sink her so the desk cuts at the waist, then measure head height
  // (force-update from the group so parent matrices are valid pre-first-frame)
  S.avatarGroup.updateMatrixWorld(true);
  if (S.vrmB.hips) {
    const hy = S.vrmB.hips.getWorldPosition(S.tmpA).y;
    vrm.scene.position.y -= (hy - (DESK_TOP - 0.02));
  }
  vrm.scene.position.z = 0.1;
  S.avatarGroup.updateMatrixWorld(true);
  if (S.vrmB.head) S.headY = S.vrmB.head.getWorldPosition(S.tmpA).y + 0.07;

  // MToon expects exactly ONE directional light at PI intensity; the studio's
  // spot rig (intensity 150+), hemisphere fill, and accent lights all stack on
  // the toon ramp and blow her out. Isolate the VRM on render layer 1 with a
  // single broadcast-neutral key, exempt from the ACES exposure ramp. The
  // builtin avatar keeps the studio rig — it was tuned under it.
  vrm.scene.traverse((obj) => {
    if (obj.isMesh) {
      obj.layers.set(1);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) if (m) m.toneMapped = false;
    }
  });
  const key = new THREE.DirectionalLight(0xffffff, Math.PI);
  key.position.set(1.3, S.headY + 0.8, 2.4);
  key.target.position.set(0, S.headY - 0.3, 0);
  key.layers.set(1);
  S.scene.add(key, key.target);
  S.avatarKey = key;
  S.camera.layers.enable(1);

  try { if (vrm.lookAt) vrm.lookAt.target = S.lookTarget; } catch { /* optional */ }
}

function poseVRMSeated(vrm) {
  const bone = (n) => {
    try { return (vrm.humanoid && vrm.humanoid.getNormalizedBoneNode(n)) || null; } catch { return null; }
  };
  const B = {
    hips: bone('hips'), spine: bone('spine'), chest: bone('chest'),
    neck: bone('neck'), head: bone('head'),
    lUp: bone('leftUpperArm'), rUp: bone('rightUpperArm'),
    lLow: bone('leftLowerArm'), rLow: bone('rightLowerArm'),
    lHand: bone('leftHand'), rHand: bone('rightHand'),
    lUpLeg: bone('leftUpperLeg'), rUpLeg: bone('rightUpperLeg'),
    lLowLeg: bone('leftLowerLeg'), rLowLeg: bone('rightLowerLeg'),
  };
  // seated: thighs forward, shins down; hidden by the desk but keeps
  // silhouette/shadows honest at wide shots
  if (B.lUpLeg) B.lUpLeg.rotation.x = -1.45;
  if (B.rUpLeg) B.rUpLeg.rotation.x = -1.45;
  if (B.lLowLeg) B.lLowLeg.rotation.x = 1.35;
  if (B.rLowLeg) B.rLowLeg.rotation.x = 1.35;
  if (B.hips) B.hips.rotation.x = 0.05;
  if (B.spine) B.spine.rotation.x = 0.07;   // slight anchor lean-in
  if (B.chest) B.chest.rotation.x = 0.05;
  // arms down from the normalized T-pose, elbows bent toward the desk
  if (B.lUp) { B.lUp.rotation.z = -1.15; B.lUp.rotation.x = 0.22; }
  if (B.rUp) { B.rUp.rotation.z = 1.15; B.rUp.rotation.x = 0.22; }
  if (B.lLow) { B.lLow.rotation.y = -0.85; }
  if (B.rLow) { B.rLow.rotation.y = 0.85; }
  return B;
}

// per-frame VRM pose: base seated arms + breathing + wave offsets + head aim
function applyVRMPose(dt) {
  const B = S.vrmB;
  if (!B) return;
  const t = S.time;
  const breath = Math.sin(t * 1.5) * 0.012;
  const w = S.gest.wave;
  const osc = Math.sin(t * 9) * 0.5 * w;

  if (B.spine) B.spine.rotation.x = 0.07 + breath * 0.5;
  if (B.chest) B.chest.rotation.x = 0.05 + breath;

  // upper arms rotated down/in from T-pose so hands rest near the desk
  if (B.lUp) B.lUp.rotation.set(-0.42, 0.1, -1.12);
  if (B.rUp) B.rUp.rotation.set(-0.42 - 0.45 * w, -0.1, 1.12 - 1.3 * w);
  if (B.lLow) B.lLow.rotation.set(0, -0.5, -0.1);
  if (B.rLow) B.rLow.rotation.set(0, 0.5 - 0.4 * w, 0.1 + osc);
  if (B.lHand) B.lHand.rotation.set(-0.15, 0, -0.1);
  if (B.rHand) B.rHand.rotation.set(-0.15, 0, 0.1 + osc * 0.6);

  const shake = Math.sin(t * 30) * 0.03 * S.spring;
  const hx = S.aim.x * 0.55 + S.gest.headX + breath * 0.6 + shake;
  const hy = S.aim.y * 0.55;
  if (B.neck) B.neck.rotation.set(hx * 0.45, hy * 0.45, 0);
  if (B.head) B.head.rotation.set(hx, hy, Math.sin(t * 0.9) * 0.012);
}

// ---------------------------------------------------------------------------
// screen painting (canvas textures)
// ---------------------------------------------------------------------------

const F = (weight, size) => `${weight} ${size}px "Avenir Next", "Helvetica Neue", Arial, sans-serif`;

function panelBase(sc, top = '#08111f') {
  const { ctx, w, h } = sc;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(1, '#02060c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(53,214,255,0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 64) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(53,214,255,0.14)';
  ctx.strokeRect(2, 2, w - 4, h - 4);
}

function wrapLines(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? cur + ' ' + word : word;
    if (ctx.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = word;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (lines.length === maxLines && cur) lines[maxLines - 1] += '…';
  return lines;
}

function drawCenter() {
  const sc = S.scr.c;
  if (!sc) return;
  if (S.sweepOn) drawCenterSweep(sc);
  else if (S.wall.mode === 'open') drawCenterOpen(sc);
  else if (S.wall.mode === 'segment' && S.wall.seg) drawCenterSegment(sc);
  else drawCenterIdle(sc);
  sc.tex.needsUpdate = true;
}

function drawCenterOpen(sc) {
  const { ctx, w, h } = sc;
  panelBase(sc, '#0a1424');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = F(900, 190);
  ctx.fillText('MNN', w / 2, 268);
  ctx.fillStyle = '#e02020';
  ctx.fillRect(w / 2 - 230, 300, 460, 10);
  ctx.fillStyle = '#dfe8f5';
  ctx.font = F(700, 42);
  ctx.fillText(S.wall.title.toUpperCase(), w / 2, 390);
  ctx.fillStyle = '#35d6ff';
  ctx.font = F(500, 26);
  ctx.fillText('ALL YOUR MODELS · ALL THE TIME', w / 2, 448);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ff3524';
  ctx.beginPath();
  ctx.arc(44, h - 44, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8fa4c0';
  ctx.font = F(600, 22);
  ctx.fillText('LIVE FROM THE RESEARCH DESK', 64, h - 36);
}

function drawCenterSegment(sc) {
  const { ctx, w, h } = sc;
  const seg = S.wall.seg;
  panelBase(sc);
  // skewed red kicker tag
  ctx.save();
  ctx.transform(1, 0, -0.18, 1, 0, 0);
  ctx.fillStyle = '#e02020';
  ctx.font = F(800, 30);
  const kicker = (seg.topic || 'THE WIRE').toUpperCase();
  const kw = ctx.measureText(kicker).width;
  ctx.fillRect(74, 62, kw + 44, 52);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(kicker, 96, 99);
  ctx.restore();
  // mood chip
  const chip = (seg.mood || '').toUpperCase();
  ctx.font = F(800, 24);
  ctx.fillStyle = MOOD_HEX[seg.mood] || '#35d6ff';
  ctx.textAlign = 'right';
  ctx.fillText(chip, w - 52, 96);
  ctx.textAlign = 'left';
  // headline
  ctx.fillStyle = '#ffffff';
  ctx.font = F(800, 62);
  const lines = wrapLines(ctx, seg.headline, w - 128, 3);
  lines.forEach((line, i) => ctx.fillText(line, 60, 210 + i * 78));
  // sources
  const names = [...new Set(seg.sources.map((s) => (s && s.source) || '').filter(Boolean))].slice(0, 3);
  if (names.length) {
    ctx.fillStyle = '#35d6ff';
    ctx.font = F(600, 26);
    ctx.fillText('SOURCES  ·  ' + names.join('  ·  '), 60, h - 52);
  }
  ctx.fillStyle = '#e02020';
  ctx.fillRect(0, h - 10, w, 10);
}

function drawCenterIdle(sc) {
  const { ctx, w, h } = sc;
  panelBase(sc);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e02020';
  ctx.font = F(900, 64);
  ctx.fillText('MNN', w / 2, 150);
  ctx.fillStyle = '#ffffff';
  ctx.font = F(200, 170);
  ctx.fillText(hh + ':' + mm, w / 2, 340);
  ctx.fillStyle = '#8fa4c0';
  ctx.font = F(600, 30);
  ctx.fillText('MODEL NEWS NETWORK · RESEARCH DESK · 24/7', w / 2, 430);
  ctx.fillStyle = '#e02020';
  ctx.fillRect(w / 2 - 150, 470, 300, 6);
  ctx.textAlign = 'left';
}

function drawCenterSweep(sc) {
  const { ctx, w, h } = sc;
  panelBase(sc, '#050b17');
  const t = S.time;
  // scanning line
  const y = ((t * 0.35) % 1) * h;
  const grad = ctx.createLinearGradient(0, y - 40, 0, y + 40);
  grad.addColorStop(0, 'rgba(53,214,255,0)');
  grad.addColorStop(0.5, 'rgba(53,214,255,0.22)');
  grad.addColorStop(1, 'rgba(53,214,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, y - 40, w, 80);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = F(900, 84);
  ctx.fillText('SWEEPING', w / 2, 250);
  ctx.fillStyle = '#e02020';
  ctx.fillText('THE WIRE', w / 2, 350);
  // activity ticks
  ctx.fillStyle = '#35d6ff';
  for (let i = 0; i < 24; i++) {
    const on = Math.sin(t * 7 + i * 1.31) > 0.2;
    ctx.globalAlpha = on ? 0.9 : 0.15;
    ctx.fillRect(w / 2 - 288 + i * 24, 402, 14, 8);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#8fa4c0';
  ctx.font = F(600, 24);
  ctx.fillText('MNN RESEARCH DESK — LIVE WIRE SCAN', w / 2, h - 48);
  ctx.textAlign = 'left';
}

function drawLeft() {
  const sc = S.scr.l;
  if (!sc) return;
  const { ctx, w, h } = sc;
  panelBase(sc);
  ctx.fillStyle = '#e02020';
  ctx.fillRect(0, 0, w, 62);
  ctx.fillStyle = '#ffffff';
  ctx.font = F(800, 32);
  ctx.fillText('TOPIC WATCH', 28, 44);
  const topics = S.wall.topics;
  if (!topics.length) {
    ctx.fillStyle = '#8fa4c0';
    ctx.font = F(500, 26);
    ctx.fillText('No beats assigned.', 28, 130);
    ctx.fillText('pepper add <topic>', 28, 170);
  } else {
    topics.forEach((name, i) => {
      const y = 118 + i * 48;
      ctx.fillStyle = '#4d5c78';
      ctx.font = F(700, 22);
      ctx.fillText(String(i + 1).padStart(2, '0'), 28, y);
      ctx.fillStyle = '#e8eef8';
      ctx.font = F(600, 27);
      ctx.fillText(String(name).toUpperCase().slice(0, 24), 76, y);
      if (S.sweepOn && Math.sin(S.time * 9 + i * 2.1) > 0) {
        ctx.fillStyle = '#ff3524';
        ctx.font = F(700, 20);
        ctx.fillText('▸ SCANNING', w - 158, y);
      } else {
        ctx.fillStyle = '#35d6ff';
        ctx.beginPath();
        ctx.arc(w - 44, y - 8, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  ctx.fillStyle = '#4d5c78';
  ctx.font = F(600, 20);
  ctx.fillText('MNN · RESEARCH DESK', 28, h - 28);
  sc.tex.needsUpdate = true;
}

function stepWire() {
  const wr = S.wire;
  // Once real sweep data arrives (setWireStats), the decorative random walk
  // stands down — the wall shows actual signal, held steady between sweeps.
  if (wr.real) return;
  for (let i = 0; i < wr.bars.length; i++) {
    wr.bars[i] = clamp(wr.bars[i] + rand(-0.16, 0.16), 0.08, 1);
  }
  wr.spark.shift();
  wr.spark.push(clamp(wr.spark[wr.spark.length - 1] + rand(-0.14, 0.14), 0.08, 0.95));
}

function drawRight() {
  const sc = S.scr.r;
  if (!sc) return;
  const { ctx, w, h } = sc;
  panelBase(sc);
  ctx.fillStyle = '#ffffff';
  ctx.font = F(800, 30);
  ctx.fillText('WIRE ACTIVITY', 28, 52);
  ctx.fillStyle = '#e02020';
  ctx.fillRect(258, 28, 68, 30);
  ctx.fillStyle = '#ffffff';
  ctx.font = F(800, 20);
  ctx.fillText('LIVE', 270, 50);
  const total = S.wire.real && Number.isFinite(S.wire.perHour)
    ? S.wire.perHour
    : Math.round(S.wire.bars.reduce((a, b) => a + b, 0) * 137);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#35d6ff';
  ctx.font = F(300, 54);
  ctx.fillText(String(total), w - 28, 60);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#4d5c78';
  ctx.font = F(600, 18);
  ctx.fillText('SIGNALS / HR', w - 148, 86);

  // sparkline
  ctx.strokeStyle = '#35d6ff';
  ctx.lineWidth = 3;
  ctx.shadowColor = 'rgba(53,214,255,0.7)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  S.wire.spark.forEach((v, i) => {
    const x = 28 + (i / (S.wire.spark.length - 1)) * (w - 56);
    const y = 210 - v * 110;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;

  // bars
  const bw = (w - 56) / S.wire.bars.length;
  S.wire.bars.forEach((v, i) => {
    const bh = v * 190;
    const grad = ctx.createLinearGradient(0, h - 60 - bh, 0, h - 60);
    grad.addColorStop(0, '#ff3524');
    grad.addColorStop(1, '#5a0d08');
    ctx.fillStyle = grad;
    ctx.fillRect(28 + i * bw, h - 60 - bh, bw - 10, bh);
  });
  ctx.fillStyle = '#4d5c78';
  ctx.font = F(600, 20);
  ctx.fillText('SIGNAL DENSITY BY BEAT', 28, h - 24);
  sc.tex.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// gestures
// ---------------------------------------------------------------------------

function gestureSip() {
  if (S.gest.busy || !S.mug) return;
  S.gest.busy = true;
  const mug = S.mug;
  const home = mug.userData.home;
  // world face position -> desk-group local (desk group sits at y = RISER_H)
  const face = V3(0.16, S.headY - 0.14 - RISER_H, 0.44);
  const mid = V3(lerp(home.x, face.x, 0.5) + 0.12, Math.max(home.y, face.y) + 0.18, lerp(home.z, face.z, 0.5));
  const setAt = (k) => {
    const a = 1 - k;
    mug.position.set(
      a * a * home.x + 2 * a * k * mid.x + k * k * face.x,
      a * a * home.y + 2 * a * k * mid.y + k * k * face.y,
      a * a * home.z + 2 * a * k * mid.z + k * k * face.z,
    );
    mug.rotation.x = -0.5 * k;
  };
  tween(0.7, (k) => {
    setAt(k);
    S.gest.headX = -0.08 * k;
    S.gest.armX = -0.5 * k;
  }, () => {
    S.steamBoost = 1;
    tween(0.6, (k) => {
      const s = Math.sin(k * Math.PI);
      mug.rotation.x = -0.5 - s * 0.45;
      S.gest.headX = -0.08 - s * 0.14;   // head tilts back for the sip
    }, () => {
      tween(0.7, (k) => {
        setAt(1 - k);
        S.gest.headX = -0.08 * (1 - k);
        S.gest.armX = -0.5 * (1 - k);
      }, () => {
        mug.position.copy(home);
        mug.rotation.set(0, 0, 0);
        S.gest.headX = 0;
        S.gest.armX = 0;
        S.gest.busy = false;
      });
    }, linear);
  });
}

function gestureShuffle() {
  if (S.gest.busy || !S.papers) return;
  S.gest.busy = true;
  S.gest.shuffling = true;
  tween(1.1, (k) => {
    const a = Math.sin(k * Math.PI);   // ramp in and out
    S.papers.children.forEach((p, i) => {
      const b = p.userData.base;
      p.rotation.y = b.ry + Math.sin(S.time * 34 + i * 1.7) * 0.09 * a;
      p.position.y = b.y + Math.max(0, Math.sin(S.time * 26 + i * 2.3)) * 0.014 * a;
    });
  }, () => {
    S.papers.children.forEach((p) => {
      p.rotation.y = p.userData.base.ry;
      p.position.y = p.userData.base.y;
    });
    S.gest.shuffling = false;
    S.gest.busy = false;
  }, linear);
}

function gestureNod() {
  if (S.gest.busy) return;
  S.gest.busy = true;
  tween(0.9, (k) => {
    S.gest.headX = Math.sin(k * Math.PI) * 0.26 - Math.sin(k * Math.PI * 2) * 0.05;
  }, () => {
    S.gest.headX = 0;
    S.gest.busy = false;
  }, linear);
}

function gestureWave() {
  if (S.gest.busy) return;
  S.gest.busy = true;
  tween(0.35, (k) => { S.gest.wave = k; }, () => {
    tween(1.3, () => { /* oscillation reads S.gest.wave + time */ }, () => {
      tween(0.4, (k) => { S.gest.wave = 1 - k; }, () => {
        S.gest.wave = 0;
        S.gest.busy = false;
      });
    }, linear);
  });
}

// ---------------------------------------------------------------------------
// per-frame behavior
// ---------------------------------------------------------------------------

function updateTalk(dt) {
  const tk = S.talk;
  if (tk.active) {
    if (S.time > tk.next) {
      tk.target = rand(0.2, 1);
      tk.next = S.time + rand(0.06, 0.15);
    }
  } else {
    tk.target = 0;
  }
  tk.level += (tk.target - tk.level) * Math.min(1, dt * 14);
}

function updateBlink(dt) {
  if (S.time > S.nextBlinkAt) {
    S.nextBlinkAt = S.time + rand(2, 6);
    tween(0.16, (k) => { S.blinkV = Math.sin(k * Math.PI); }, () => { S.blinkV = 0; }, linear);
  }
}

function updateGaze(dt) {
  const g = S.gaze;
  if (S.sweepOn || S.gest.shuffling) {
    g.mode = 'papers';
    g.until = S.time + 0.5;
  } else if (S.time > g.until) {
    const r = Math.random();
    if (r < 0.72) { g.mode = 'camera'; g.until = S.time + rand(4, 9); }
    else if (r < 0.86) { g.mode = 'screenL'; g.until = S.time + rand(1.2, 2.6); }
    else { g.mode = 'screenR'; g.until = S.time + rand(1.2, 2.6); }
  }
  const p = S.tmpB;
  if (g.mode === 'camera') p.copy(S.camera.position);
  else if (g.mode === 'screenL') p.set(-2.6, 1.9, -2.35);
  else if (g.mode === 'screenR') p.set(2.6, 1.9, -2.35);
  else p.set(-0.42, DESK_TOP + 0.05, 0.78);   // papers
  S.lookTarget.position.lerp(p, 1 - Math.exp(-3.5 * dt));
}

function updateIdleGestures() {
  if (S.time < S.nextIdleAt) return;
  S.nextIdleAt = S.time + rand(9, 20);
  if (S.onAir || S.talk.active || S.sweepOn || S.gest.busy) return;
  const r = Math.random();
  if (r < 0.45) gestureSip();
  else if (r < 0.8) gestureShuffle();
  else gestureNod();
}

// smoothed head-aim angles from the current look target
function updateAim(headWorld, dt) {
  const d = S.tmpA.copy(S.lookTarget.position).sub(headWorld);
  const yaw = clamp(Math.atan2(d.x, d.z), -0.55, 0.55);
  const pitch = clamp(-Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.4, 0.45);
  S.aim.x = damp(S.aim.x, pitch, 4, dt);
  S.aim.y = damp(S.aim.y, yaw, 4, dt);
}

function updateAvatar(dt) {
  const t = S.time;
  if (S.vrm) {
    const B = S.vrmB;
    if (B && B.head) updateAim(B.head.getWorldPosition(S.tmpB), dt);
    applyVRMPose(dt);
    try {
      const em = S.vrm.expressionManager;
      if (em) {
        em.setValue('aa', clamp(S.talk.level, 0, 1));
        em.setValue('blink', clamp(S.blinkV, 0, 1));
        em.setValue('happy', clamp(S.happy, 0, 1));
      }
    } catch { /* expressions vary per model */ }
    try { S.vrm.update(dt); } catch { /* never let a bad frame crash the loop */ }
  } else if (S.bp) {
    const bp = S.bp;
    updateAim(bp.headGrp.getWorldPosition(S.tmpB), dt);
    const breath = Math.sin(t * 1.5);
    bp.root.rotation.z = Math.sin(t * 0.9) * 0.012;
    bp.torso.scale.y = 1 + breath * 0.012;
    bp.headGrp.position.y = 1.45 + breath * 0.006;
    bp.headGrp.rotation.set(
      S.aim.x * 0.8 + S.gest.headX + breath * 0.008,
      S.aim.y * 0.8,
      Math.sin(t * 0.7) * 0.015,
    );
    const lidScale = Math.max(0.06, 1 - S.blinkV);
    bp.eyes.l.scale.y = lidScale;
    bp.eyes.r.scale.y = lidScale;
    bp.mouth.scale.y = 0.3 + S.talk.level * 1.5;
    bp.mouth.scale.x = 1.3 - S.talk.level * 0.3;
    // brows + blush track mood
    const browTarget = S.mood === 'breaking' ? -0.22 : (S.mood === 'quirky' ? 0.18 : 0);
    S.brow = damp(S.brow, browTarget, 4, dt);
    bp.brows.l.rotation.z = -0.08 - S.brow;
    bp.brows.r.rotation.z = 0.08 + S.brow;
    bp.brows.l.position.y = 0.33 + Math.max(0, S.brow) * 0.06;
    bp.brows.r.position.y = 0.33 + Math.max(0, S.brow) * 0.06;
    const blushScale = 1 + S.happy * 0.4;
    bp.blushes.forEach((b) => b.scale.setScalar(blushScale));
    // ahoge spring on pulseBreaking()
    bp.ahoge.rotation.z = Math.sin(t * 26) * 0.5 * S.spring;
    bp.ahoge.rotation.x = Math.sin(t * 21) * 0.3 * S.spring;
    // right arm: sip raise (armX) or wave raise, never both (gestures gate on busy)
    bp.arms.r.rotation.x = S.gest.armX - 1.7 * S.gest.wave;
    bp.arms.r.rotation.z = Math.sin(t * 9) * 0.45 * S.gest.wave;
  }
  S.happy = damp(S.happy, (S.mood === 'quirky' || S.mood === 'idle') ? 0.32 : 0, 3, dt);
}

function updateProps(dt) {
  const t = S.time;
  // steam rises while she's idle
  S.steamAlpha = damp(S.steamAlpha, (S.talk.active || S.sweepOn) ? 0 : 1, 2, dt);
  S.steamBoost = Math.max(0, S.steamBoost - dt * 0.8);
  for (const sp of S.steam) {
    const u = sp.userData;
    const k = (t * u.speed + u.phase) % 1;
    sp.position.set(Math.sin(t * 2 + u.phase * 12) * 0.03 * k, 0.06 + k * 0.34, 0);
    sp.material.opacity = (1 - k) * 0.4 * S.steamAlpha * (1 + S.steamBoost * 1.6);
    sp.scale.setScalar(0.05 + k * 0.09 * (1 + S.steamBoost * 0.5));
  }
  // dust motes drift and wrap
  if (S.dust) {
    const pos = S.dust.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += S.dustVel[i] * dt * 10;
      arr[i + 1] += S.dustVel[i + 1] * dt * 10;
      arr[i + 2] += S.dustVel[i + 2] * dt * 10;
      if (arr[i + 1] < 0.05) arr[i + 1] = 4;
      if (arr[i + 1] > 4.1) arr[i + 1] = 0.1;
      if (arr[i] > 4.6) arr[i] = -4.5;
      if (arr[i] < -4.6) arr[i] = 4.5;
      if (arr[i + 2] > 3.6) arr[i + 2] = -3;
      if (arr[i + 2] < -3.1) arr[i + 2] = 3.5;
    }
    pos.needsUpdate = true;
  }
  S.spring = Math.max(0, S.spring - dt * 1.1);
}

function updateScreens(dt) {
  S.acc.right += dt;
  if (S.acc.right >= 0.5) {
    S.acc.right = 0;
    stepWire();
    drawRight();
  }
  S.acc.center += dt;
  if (S.sweepOn) {
    if (S.acc.center >= 0.22) {
      S.acc.center = 0;
      drawCenter();
      drawLeft();
    }
  } else if (S.wall.mode === 'idle' && S.acc.center >= 1) {
    S.acc.center = 0;
    drawCenter();
  }
  // subtle brightness flicker across the wall while sweeping
  const flick = S.sweepOn ? 0.86 + Math.random() * 0.14 : 1;
  for (const key of ['c', 'l', 'r']) {
    const sc = S.scr[key];
    if (sc) sc.mesh.material.color.setScalar(flick);
  }
}

function updateLights(dt) {
  const t = S.time;
  const M = MOODS[S.mood];
  const k = 1 - Math.exp(-3 * dt);

  S.accent.color.lerp(S.tmpColor.setHex(M.accent), k);
  if (S.flash > 0) S.accent.color.lerp(S.tmpColor2.setHex(0xff2013), clamp(S.flash, 0, 1) * 0.8);
  S.accent.intensity = damp(S.accent.intensity, M.accentI, 3, dt) + S.flash * 55;

  S.rim.color.lerp(S.tmpColor.setHex(M.rim), k * 0.8);
  S.key.intensity = damp(S.key.intensity, S.onAir ? 175 : 150, 2, dt);

  S.stripColor.lerp(S.tmpColor.setHex(M.strip), k);
  const pulse = 0.72 + 0.28 * Math.sin(t * M.pulse * (S.onAir ? 1.35 : 1) * Math.PI * 2) + S.flash * 0.8;
  S.strip.material.color.copy(S.stripColor).multiplyScalar(clamp(pulse, 0, 2));
  S.logoGlow.intensity = 4 + Math.sin(t * 1.2) * 0.8 + S.flash * 14;

  S.renderer.toneMappingExposure = damp(S.renderer.toneMappingExposure, S.onAir ? 1.16 : 1.05, 2, dt);

  const boxMat = S.onAirBox.material[4];
  boxMat.color.setScalar(S.onAir ? 0.72 + 0.28 * Math.sin(t * 3.4) : 0.14);

  S.flash = Math.max(0, S.flash - dt * 1.5);
}

function updateCamera(dt) {
  shotBase(S.shot, S.camBase);
  const pace = MOODS[S.mood].pace;
  const t = S.time * pace;
  S.par.x = damp(S.par.x, S.mouse.x, 3, dt);
  S.par.y = damp(S.par.y, S.mouse.y, 3, dt);
  S.camera.position.set(
    S.camBase.pos.x + Math.sin(t * 0.31) * 0.1 + S.par.x * 0.24,
    S.camBase.pos.y + Math.sin(t * 0.23) * 0.04 - S.par.y * 0.12,
    S.camBase.pos.z + Math.sin(t * 0.19) * 0.14,
  );
  S.lookTmp.set(
    S.camBase.look.x + S.par.x * 0.06,
    S.camBase.look.y - S.par.y * 0.04,
    S.camBase.look.z,
  );
  S.camera.lookAt(S.lookTmp);
}

function shotBase(name, out) {
  const hy = S.headY;
  switch (name) {
    case 'wide':
      out.pos.set(0, 1.85, 5.7);
      out.look.set(0, 1.35, -0.7);
      break;
    case 'close':
      out.pos.set(0.32, hy + 0.02, 1.72);
      out.look.set(0, hy - 0.02, 0.1);
      break;
    case 'screen':
      out.pos.set(1.4, 1.62, 1.15);
      out.look.set(0, 1.95, -2.7);
      break;
    default:   // 'med' — over-the-desk, slightly low, flattering
      out.pos.set(0, 1.26, 3.3);
      out.look.set(0, 1.38, 0);
      break;
  }
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

function animate() {
  if (S.dead) return;
  requestAnimationFrame(animate);
  const dt = Math.min(S.clock.getDelta(), 0.05);
  S.time += dt;
  try {
    if (S.avatarFade) {
      const f = S.avatarFade;
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      const ease = k * k * (3 - 2 * k);
      for (const { m, opacity } of f.mats) m.opacity = opacity * ease;
      if (k >= 1) {
        // Restore original material transparency so MToon sorting is clean.
        for (const { m, opacity, transparent } of f.mats) {
          m.opacity = opacity;
          m.transparent = transparent;
        }
        S.avatarFade = null;
      }
    }
    stepTweens(dt);
    updateTalk(dt);
    updateBlink(dt);
    updateGaze(dt);
    updateIdleGestures();
    updateAvatar(dt);
    updateProps(dt);
    updateScreens(dt);
    updateLights(dt);
    updateCamera(dt);
    S.renderer.render(S.scene, S.camera);
    S.errors = 0;
    if (!S.first) {
      S.first = true;
      resolveReady();
    }
  } catch (err) {
    if (++S.errors > 8) {
      S.dead = true;
      console.error('[newsroom] render loop stopped:', err);
      resolveReady();
    }
  }
}

boot();
