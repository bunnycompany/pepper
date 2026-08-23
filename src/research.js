import * as store from './store.js';
import { log } from './log.js';
import { collapseWs } from './sources/rss.js';
import * as news from './sources/news.js';
import * as hn from './sources/hn.js';
import * as arxiv from './sources/arxiv.js';

const LENSES = { news, hn, arxiv };
const MOODS = new Set(['breaking', 'developing', 'steady', 'quirky']);
const MOOD_RANK = { breaking: 0, developing: 1, quirky: 2, steady: 3 };
const DIGEST_MAX = 2400;
const LINE_MAX = 320;

function ageOf(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 48) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

function lineFor(it) {
  const title = collapseWs(it.title);
  let line;
  if (it.lens === 'hn') {
    line = '- [HN ' + (Math.max(0, Number(it.points) || 0)) + 'pts] ' + title;
  } else if (it.lens === 'arxiv') {
    const abs = collapseWs(it.snippet).slice(0, 140).trim();
    line = abs ? '- [arXiv] ' + title + ' — ' + abs : '- [arXiv] ' + title;
  } else {
    const meta = [it.source, ageOf(it.publishedAt)].filter(Boolean).join(', ');
    line = meta ? '- [News] ' + title + ' (' + meta + ')' : '- [News] ' + title;
  }
  return line.length > LINE_MAX ? line.slice(0, LINE_MAX - 1) + '…' : line;
}

// buildDigest(topicName, items) → wire-notes string, ≤ 2400 chars.
export function buildDigest(topicName, items) {
  const head = 'Wire notes — ' + collapseWs(topicName).slice(0, 120) + ':';
  const lines = [head];
  let len = head.length;
  for (const it of items || []) {
    if (!it || !it.title) continue;
    const line = lineFor(it);
    if (len + 1 + line.length > DIGEST_MAX) break;
    lines.push(line);
    len += 1 + line.length;
  }
  return lines.join('\n');
}

function validSegment(seg) {
  return !!seg && typeof seg === 'object'
    && typeof seg.headline === 'string' && seg.headline.trim().length > 0
    && Array.isArray(seg.script)
    && seg.script.length >= 1 && seg.script.length <= 6
    && seg.script.every((l) => typeof l === 'string' && l.trim().length > 0)
    && MOODS.has(seg.mood);
}

function validOpenSignoff(x) {
  return !!x && typeof x === 'object'
    && typeof x.open === 'string' && x.open.trim().length > 0
    && typeof x.signoff === 'string' && x.signoff.trim().length > 0;
}

function todNow() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

// runCycle({ emit }) — one full sweep → ticker → segments → bulletin pass.
// Emits ONLY: sweep, ticker, segment, bulletin. Never throws for a failing
// source, brain, or anchor path; degrades and keeps going.
export async function runCycle({ emit } = {}) {
  const say = (type, data) => {
    if (typeof emit !== 'function') return;
    try {
      emit(type, data);
    } catch (e) {
      log.warn('emit failed:', e?.message || String(e));
    }
  };

  // 1. Topics (minus muted).
  const topics = store.listTopics().filter((t) => t && t.slug && !t.muted);
  if (!topics.length) return { quiet: true, reason: 'no topics' };

  // Lazy imports: brain and anchor are built in parallel by other modules;
  // the cycle must survive either being absent or broken.
  let brain = null;
  try {
    brain = (await import('./brain/index.js')).getBrain();
  } catch (e) {
    log.warn('brain unavailable:', e?.message || String(e));
  }
  let anchor = null;
  try {
    anchor = await import('./anchor.js');
  } catch (e) {
    log.warn('anchor unavailable:', e?.message || String(e));
  }

  const firstEver = store.listBulletins(1).length === 0;
  const freshBy = new Map();
  let itemsSeen = 0;
  let sourcesTried = 0;
  let sourceErrors = 0;

  // 2. Sweep each topic sequentially; its lenses in parallel. A source that
  // resolves null (fetch failed) is counted separately from one that resolved
  // [] (the wire is genuinely quiet) so "offline" is distinguishable from
  // "quiet news day" downstream.
  for (const t of topics) {
    const lenses = (Array.isArray(t.lenses) && t.lenses.length ? t.lenses : ['news', 'hn', 'arxiv'])
      .filter((l) => LENSES[l]);
    const query = t.query || t.name || t.slug;
    const settled = await Promise.allSettled(lenses.map((l) => LENSES[l].fetchTopic(query)));
    const found = [];
    let errs = 0;
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) found.push(...r.value);
      else errs++;
    }
    sourcesTried += lenses.length;
    sourceErrors += errs;
    itemsSeen += found.length;
    let fresh = [];
    try {
      fresh = store.appendItems(t.slug, found) || [];
    } catch (e) {
      log.warn('append failed for', t.slug + ':', e?.message || String(e));
    }
    try {
      store.touchTopic(t.slug, { lastSweepAt: new Date().toISOString() });
    } catch {}
    freshBy.set(t.slug, fresh);
    say('sweep', {
      slug: t.slug, topic: t.name, fresh: fresh.length,
      sourceErrors: errs, sourcesTried: lenses.length,
    });
  }

  // 3. Ticker.
  let tickerItems = [];
  try {
    tickerItems = store.allRecentItems(30).map((i) => ({
      title: i.title, source: i.source, topic: i.topicName, url: i.url,
    }));
  } catch (e) {
    log.warn('ticker failed:', e?.message || String(e));
  }
  say('ticker', { items: tickerItems });

  const freshTotal = [...freshBy.values()].reduce((n, a) => n + a.length, 0);

  // 4. Segments for topics with fresh items (first ever cycle: all topics).
  let usedBrain = false;
  const segments = [];
  for (const t of topics) {
    const fresh = freshBy.get(t.slug) || [];
    if (!firstEver && !fresh.length) continue;
    // Prefer this sweep's fresh items (fetch order: news, hn, arxiv — lens-diverse).
    // recentItems returns newest-appended first, which is lens-skewed; re-rank it.
    let items = fresh;
    if (!items.length && firstEver) {
      try {
        const rank = { news: 0, hn: 1, arxiv: 2 };
        items = store.recentItems(t.slug, 12)
          .sort((a, b) => (rank[a.lens] ?? 3) - (rank[b.lens] ?? 3));
      } catch {
        items = [];
      }
    }
    if (!items.length) continue;
    const digest = buildDigest(t.name, items);
    let seg = null;
    if (brain) {
      try {
        seg = await brain.segment({ topic: t.name, digest });
      } catch (e) {
        log.warn('brain.segment failed for', t.slug + ':', e?.message || String(e));
        seg = null;
      }
    }
    if (validSegment(seg)) {
      usedBrain = true;
    } else if (anchor) {
      try {
        seg = anchor.fallbackSegment(t.name, items);
      } catch (e) {
        log.warn('fallbackSegment failed for', t.slug + ':', e?.message || String(e));
        seg = null;
      }
    }
    if (!validSegment(seg)) continue;
    segments.push({
      slug: t.slug,
      topic: t.name,
      mood: seg.mood,
      headline: String(seg.headline).trim().replace(/\.+$/, ''),
      handoff: null,
      script: seg.script.map((l) => String(l).trim()),
      sources: items.slice(0, 5).map((i) => ({
        title: i.title, url: i.url, source: i.source, lens: i.lens,
      })),
      freshCount: fresh.length,
    });
    say('segment', { slug: t.slug });
  }

  // 5. Compose + save the bulletin (needs anchor for compose/fallback voice).
  let bulletinId = null;
  if (segments.length && anchor) {
    segments.sort((a, b) => ((MOOD_RANK[a.mood] ?? 9) - (MOOD_RANK[b.mood] ?? 9))
      || (b.freshCount - a.freshCount));
    for (let i = 1; i < segments.length; i++) {
      try {
        segments[i].handoff = anchor.handoffFor(i, segments[i].topic) || null;
      } catch {
        segments[i].handoff = null;
      }
    }
    const ctx = {
      tod: todNow(),
      n: segments.length,
      topics: segments.map((s) => s.topic),
      busy: freshTotal >= 12,
    };
    let openSign = null;
    if (brain) {
      try {
        openSign = await brain.anchor(ctx);
      } catch {
        openSign = null;
      }
    }
    if (validOpenSignoff(openSign)) {
      usedBrain = true;
    } else {
      try {
        openSign = anchor.pickOpenSignoff(ctx);
      } catch (e) {
        log.warn('pickOpenSignoff failed:', e?.message || String(e));
        openSign = null;
      }
    }
    const open = validOpenSignoff(openSign)
      ? openSign.open.trim()
      : "This is MNN. I'm Pepper. Here's what moved.";
    const signoff = validOpenSignoff(openSign)
      ? openSign.signoff.trim()
      : "That's the sweep. I'm Pepper — back on the hour, every hour. MNN.";
    let brainMode = 'fallback';
    if (usedBrain && brain) {
      try {
        const st = await brain.status();
        if (st && (st.mode === 'foundation' || st.mode === 'local')) brainMode = st.mode;
      } catch {}
    }
    try {
      const bulletin = anchor.composeBulletin({
        open,
        signoff,
        segments,
        brainMode,
        stats: { topicsSwept: topics.length, itemsSeen, freshItems: freshTotal },
      });
      if (bulletin && bulletin.id) {
        store.saveBulletin(bulletin);
        bulletinId = bulletin.id;
        say('bulletin', { id: bulletin.id });
      } else {
        log.warn('composeBulletin returned no id; skipping save');
      }
    } catch (e) {
      log.warn('bulletin compose/save failed:', e?.message || String(e));
    }
  }

  // 6. Summary. sourceErrors === sourcesTried means nothing was reachable
  // (offline, most likely) — callers can tell that apart from a quiet wire.
  return {
    fresh: freshTotal,
    segments: segments.length,
    bulletinId,
    quiet: false,
    sourceErrors,
    sourcesTried,
  };
}
