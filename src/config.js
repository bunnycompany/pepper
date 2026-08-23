import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(__dirname, '..');
export const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;

export function home() {
  return process.env.PEPPER_HOME || join(homedir(), '.pepper');
}

export const paths = {
  get home() { return home(); },
  get config() { return join(home(), 'config.json'); },
  get run() { return join(home(), 'run.json'); },
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
  get audioDir() { return join(home(), 'audio'); },
  audio(bulletinId) { return join(home(), 'audio', bulletinId); },
  get voiceDir() { return join(home(), 'voice'); },
  get voiceReady() { return join(home(), 'voice', 'ready'); },
  get voiceVenv() { return join(home(), 'voice', 'venv'); },
  get web() { return join(PKG_ROOT, 'web'); },
  get brainSrc() { return join(PKG_ROOT, 'src', 'brain', 'brain.swift'); },
};

export const DEFAULTS = {
  port: 4747,
  intervalMinutes: 15,
  voice: { enabled: true, rate: 1.02, identity: 'bright-anchor' },
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

// Issues from the most recent loadConfig() — [{ severity, message }].
// A broken config.json must never crash Pepper, but it must never be silent
// either: the server puts these in /api/state and the CLI can print them.
let lastLoadIssues = [];

export function configIssues() {
  return lastLoadIssues.map((i) => ({ ...i }));
}

export function loadConfig() {
  ensureHome();
  if (!existsSync(paths.config)) {
    lastLoadIssues = [];
    return structuredClone(DEFAULTS);
  }
  try {
    const cfg = merge(structuredClone(DEFAULTS), JSON.parse(readFileSync(paths.config, 'utf8')));
    lastLoadIssues = [];
    return cfg;
  } catch (e) {
    lastLoadIssues = [{
      severity: 'error',
      message: paths.config + ' is invalid JSON (' + (e?.message || String(e))
        + ') — ignoring it and using defaults',
    }];
    log.warn(lastLoadIssues[0].message);
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg) {
  ensureHome();
  writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n');
}

// ---- typed config writes (pepper config set) ------------------------------

const vInt = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { error: `must be an integer ${min}-${max}` };
  }
  return { value: n };
};
const vBool = (v) => {
  if (typeof v === 'boolean') return { value: v };
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return { value: true };
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return { value: false };
  return { error: 'must be true or false' };
};
const vString = (v) => ({ value: String(v ?? '') });
const vEnum = (...allowed) => (v) => {
  const s = String(v ?? '').trim();
  return allowed.includes(s) ? { value: s } : { error: 'must be one of ' + allowed.join('|') };
};
const vUrlOrEmpty = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return { value: '' };
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http');
    return { value: s };
  } catch {
    return { error: 'must be an http(s) URL, or empty to unset' };
  }
};

const CONFIG_VALIDATORS = {
  'port': vInt(1, 65535),
  'intervalMinutes': vInt(3, 1440),
  'voice.identity': vString,
  'voice.enabled': vBool,
  'brain.prefer': vEnum('foundation', 'local', 'fallback'),
  'brain.local.url': vUrlOrEmpty,
  'brain.local.model': vString,
  'site.title': vString,
  'site.tagline': vString,
};

// setConfigValue('brain.prefer', 'local') → { ok, path, value, error?, warning? }.
// Known keys are validated and coerced (numbers, booleans); unknown keys are
// written as-is with a warning in the result. Writes only what the user's file
// already holds plus this key — never bakes DEFAULTS into config.json.
export function setConfigValue(dotPath, value) {
  const path = String(dotPath ?? '').trim();
  if (!path || path.split('.').some((k) => !k)) {
    return { ok: false, path, value, error: 'empty config key' };
  }
  let out = value;
  let warning;
  const validate = CONFIG_VALIDATORS[path];
  if (validate) {
    const r = validate(value);
    if (r.error) return { ok: false, path, value, error: path + ' ' + r.error };
    out = r.value;
  } else {
    warning = 'unknown key "' + path + '" — written, but nothing in Pepper reads it';
  }
  ensureHome();
  let raw = {};
  if (existsSync(paths.config)) {
    try {
      raw = JSON.parse(readFileSync(paths.config, 'utf8'));
    } catch (e) {
      return {
        ok: false,
        path,
        value,
        error: paths.config + ' is invalid JSON (' + (e?.message || String(e))
          + ') — fix or remove it first so your other settings are not lost',
      };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  }
  const parts = path.split('.');
  let node = raw;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (node[k] == null || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {};
    node = node[k];
  }
  node[parts[parts.length - 1]] = out;
  try {
    saveConfig(raw);
  } catch (e) {
    return { ok: false, path, value, error: 'could not write config: ' + (e?.message || String(e)) };
  }
  const result = { ok: true, path, value: out };
  if (warning) result.warning = warning;
  return result;
}
