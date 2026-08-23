import {
  readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, unlinkSync,
  statSync, openSync, readSync, closeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { paths, ensureHome } from './config.js';

export function slugify(name) {
  const s = String(name).toLowerCase().trim()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  if (s) return s;
  // Names with no letters/digits at all (emoji-only, punctuation) still need
  // a unique, stable slug — a shared constant would make beats collide.
  return 'topic-' + createHash('sha1').update(String(name)).digest('hex').slice(0, 8);
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
  const trimmed = String(name).trim();
  const slug = slugify(name);
  const existing = topics.find((t) => t.slug === slug);
  if (existing) {
    // Answer in the name the user typed; the slug matters only on a collision
    // between two different display names.
    throw new Error(existing.name === trimmed
      ? `already tracking "${existing.name}"`
      : `already tracking "${trimmed}" — same beat as "${existing.name}" (slug ${slug})`);
  }
  const t = {
    slug,
    name: trimmed,
    query: trimmed,
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
  return String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 80);
}

// Titles that normalize to almost nothing can't be used for title-dedupe —
// they'd collide with every other such title. URL/id dedupe still applies.
const titleKey = (t) => {
  const nt = normTitle(t);
  return nt.length >= 4 ? nt : null;
};

// If the previous append was cut short (power loss on the 24/7 daemon), the
// file ends mid-line; appending without a newline would glue two records.
function appendPrefix(file) {
  try {
    const size = statSync(file).size;
    if (!size) return '';
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    closeSync(fd);
    return buf[0] === 10 ? '' : '\n';
  } catch {
    return '';
  }
}

export function appendItems(slug, incoming) {
  ensureHome();
  const existing = readItems(slug);
  const seenIds = new Set(existing.map((i) => i.id));
  const seenTitles = new Set(existing.map((i) => titleKey(i.title)).filter(Boolean));
  const now = new Date().toISOString();
  const fresh = [];
  for (const raw of incoming || []) {
    if (!raw || !raw.title) continue;
    const id = itemId(raw);
    const nt = titleKey(raw.title);
    if (seenIds.has(id) || (nt && seenTitles.has(nt))) continue;
    seenIds.add(id);
    if (nt) seenTitles.add(nt);
    fresh.push({ ...raw, id, topic: slug, seenAt: now });
  }
  if (fresh.length) {
    appendFileSync(
      paths.items(slug),
      appendPrefix(paths.items(slug)) + fresh.map((i) => JSON.stringify(i)).join('\n') + '\n',
    );
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
