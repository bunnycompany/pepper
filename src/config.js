import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(__dirname, '..');
export const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;

export function home() {
  return process.env.PEPPER_HOME || join(homedir(), '.pepper');
}

export const paths = {
  get home() { return home(); },
  get config() { return join(home(), 'config.json'); },
  get topics() { return join(home(), 'topics.json'); },
  get itemsDir() { return join(home(), 'items'); },
  items(slug) { return join(home(), 'items', slug + '.jsonl'); },
  get bulletinsDir() { return join(home(), 'bulletins'); },
  bulletin(id) { return join(home(), 'bulletins', id + '.json'); },
  get bulletinIndex() { return join(home(), 'bulletins', 'index.json'); },
  get brainDir() { return join(home(), 'brain'); },
  get brainBin() { return join(home(), 'brain', 'pepper-brain'); },
  get brainFingerprint() { return join(home(), 'brain', 'source.fingerprint'); },
  get brainBuildLog() { return join(home(), 'brain', 'build.log'); },
  get logsDir() { return join(home(), 'logs'); },
  get avatar() { return join(home(), 'avatar.vrm'); },
  get web() { return join(PKG_ROOT, 'web'); },
  get brainSrc() { return join(PKG_ROOT, 'src', 'brain', 'brain.swift'); },
};

export const DEFAULTS = {
  port: 4747,
  intervalMinutes: 15,
  voice: { enabled: true, rate: 1.02 },
  brain: { prefer: 'foundation', local: { url: '', model: '' } },
  site: { title: 'MNN — Model News Network', tagline: 'All your models. All the time.' },
};

export function ensureHome() {
  for (const d of [home(), paths.itemsDir, paths.bulletinsDir, paths.brainDir, paths.logsDir]) {
    mkdirSync(d, { recursive: true });
  }
}

function merge(base, over) {
  if (over == null || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  ensureHome();
  if (!existsSync(paths.config)) return structuredClone(DEFAULTS);
  try {
    return merge(structuredClone(DEFAULTS), JSON.parse(readFileSync(paths.config, 'utf8')));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg) {
  ensureHome();
  writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n');
}
