import {
  readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { paths, ensureHome } from './config.js';

export function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'topic';
}

export function itemId(x) {
  return createHash('sha1').update(x.url || x.title).digest('hex').slice(0, 12);
}

function readJSON(f, fallback) {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; }
}

function atomic(f, data) {
  const t = f + '.tmp';
  writeFileSync(t, data);
  renameSync(t, f);
}

// ---- topics ----

export function listTopics() {
  ensureHome();
  return readJSON(paths.topics, []);
}

export function saveTopics(topics) {
  ensureHome();
  atomic(paths.topics, JSON.stringify(topics, null, 2) + '\n');
}

export function getTopic(slug) {
  return listTopics().find((t) => t.slug === slug);
}

export function addTopic(name, lenses = ['news', 'hn', 'arxiv']) {
  const topics = listTopics();
  const slug = slugify(name);
  if (topics.some((t) => t.slug === slug)) throw new Error(`already tracking "${slug}"`);
  const t = {
    slug,
    name: String(name).trim(),
    query: String(name).trim(),
    lenses,
    addedAt: new Date().toISOString(),
    lastSweepAt: null,
    muted: false,
  };
  topics.push(t);
  saveTopics(topics);
  return t;
}

export function dropTopic(nameOrSlug) {
  const topics = listTopics();
  const slug = slugify(nameOrSlug);
  const i = topics.findIndex((t) => t.slug === slug);
  if (i < 0) return false;
  topics.splice(i, 1);
  saveTopics(topics);
  try { unlinkSync(paths.items(slug)); } catch {}
  return true;
}

export function touchTopic(slug, patch) {
  const topics = listTopics();
  const t = topics.find((x) => x.slug === slug);
  if (t) { Object.assign(t, patch); saveTopics(topics); }
}

// ---- items (JSONL per topic) ----

function readItems(slug) {
  if (!existsSync(paths.items(slug))) return [];
  return readFileSync(paths.items(slug), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function normTitle(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

export function appendItems(slug, incoming) {
  ensureHome();
  const existing = readItems(slug);
  const seenIds = new Set(existing.map((i) => i.id));
  const seenTitles = new Set(existing.map((i) => normTitle(i.title)));
  const now = new Date().toISOString();
  const fresh = [];
  for (const raw of incoming || []) {
    if (!raw || !raw.title) continue;
    const id = itemId(raw);
    const nt = normTitle(raw.title);
    if (seenIds.has(id) || seenTitles.has(nt)) continue;
    seenIds.add(id);
    seenTitles.add(nt);
    fresh.push({ ...raw, id, topic: slug, seenAt: now });
  }
  if (fresh.length) {
    appendFileSync(paths.items(slug), fresh.map((i) => JSON.stringify(i)).join('\n') + '\n');
    if (existing.length + fresh.length > 900) {
      const all = readItems(slug).slice(-600);
      atomic(paths.items(slug), all.map((i) => JSON.stringify(i)).join('\n') + '\n');
    }
  }
  return fresh;
}

export function recentItems(slug, n = 30) {
  return readItems(slug).slice(-n).reverse();
}

export function allRecentItems(n = 30) {
  const out = [];
  for (const t of listTopics()) {
    out.push(...recentItems(t.slug, 12).map((i) => ({ ...i, topicName: t.name })));
  }
  return out
    .sort((a, b) => String(b.seenAt || '').localeCompare(String(a.seenAt || '')))
    .slice(0, n);
}

// ---- bulletins ----

export function bulletinId(d = new Date()) {
  return 'b-' + d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

export function saveBulletin(b) {
  ensureHome();
  atomic(paths.bulletin(b.id), JSON.stringify(b, null, 2) + '\n');
  const idx = readJSON(paths.bulletinIndex, []);
  idx.unshift({
    id: b.id,
    at: b.at,
    brain: b.brain,
    segments: b.segments.map((s) => ({ topic: s.topic, headline: s.headline, mood: s.mood })),
  });
  atomic(paths.bulletinIndex, JSON.stringify(idx.slice(0, 200), null, 2) + '\n');
}

export function listBulletins(n = 20) {
  return readJSON(paths.bulletinIndex, []).slice(0, n);
}

export function getBulletin(id) {
  if (!/^b-[0-9-]+$/.test(String(id))) return null;
  return readJSON(paths.bulletin(id), null);
}

export function latestBulletin() {
  const [m] = listBulletins(1);
  return m ? getBulletin(m.id) : null;
}
