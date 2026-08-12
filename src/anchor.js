// src/anchor.js — Pepper's scripted voice.
//
// Every string in this file is read on air. Broadcast register per the voice
// bible (docs/CONTRACTS.md §2): short declarative sentences, present tense,
// active voice, sources attributed by name. No emojis, no markdown, no stage
// directions, at most one wink per bulletin (the winks live in the signoff
// pool only). Nothing here invents facts — the fallback segment names only
// real titles and sources from the wire.
//
// Variety is deterministic-ish: pools rotate by hour + quarter-hour + a small
// content hash, so consecutive bulletins land on different lines even across
// process restarts. Math.random is used only as a tiebreak when a pick would
// repeat the immediately previous one.

import * as store from './store.js';

// ---- small helpers --------------------------------------------------------

const NUM_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];

function count(n) {
  return n >= 0 && n < NUM_WORDS.length ? NUM_WORDS[n] : String(n);
}

function cap(s) {
  const t = String(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function cleanTitle(t) {
  return collapse(t).replace(/[.\s]+$/, '');
}

function nameOf(topicName) {
  if (topicName && typeof topicName === 'object') {
    return collapse(topicName.name || topicName.slug || '');
  }
  return collapse(topicName);
}

function listPhrase(names) {
  const t = (names || []).filter(Boolean).map((x) => collapse(x));
  if (!t.length) return 'the wire';
  if (t.length === 1) return t[0];
  if (t.length === 2) return `${t[0]} and ${t[1]}`;
  if (t.length === 3) return `${t[0]}, ${t[1]}, and ${t[2]}`;
  return `${t[0]}, ${t[1]}, and ${count(t.length - 2)} more beats`;
}

function todNow(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function hashStr(s) {
  let h = 5381;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i += 1) {
    h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

// Hour plus quarter-hour: back-to-back bulletins on the default 15-minute
// interval get different seeds without any randomness.
function timeSeed(d = new Date()) {
  return d.getHours() * 4 + Math.floor(d.getMinutes() / 15);
}

const lastPick = Object.create(null);

function rotate(pool, seed, key) {
  let idx = Math.abs(Math.trunc(seed) || 0) % pool.length;
  if (key !== undefined && pool.length > 1 && lastPick[key] === idx) {
    // Tiebreak only: never read the same line twice in a row.
    idx = (idx + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length;
  }
  if (key !== undefined) lastPick[key] = idx;
  return pool[idx];
}

// ---- item phrasing (fallback segment) -------------------------------------

function srcName(it) {
  const s = collapse(it && it.source);
  if (s) return s;
  if (it && it.lens === 'arxiv') return 'arXiv';
  if (it && it.lens === 'hn') return 'Hacker News';
  return 'the wire';
}

function attribution(it) {
  if (it && it.lens === 'arxiv') return 'that one is a paper posted to arXiv';
  if (it && it.lens === 'hn' && Number(it.points) > 0) {
    return `that's sitting at ${Number(it.points)} points on Hacker News`;
  }
  return `that's per ${srcName(it)}`;
}

function mention(it) {
  const t = cleanTitle(it.title);
  if (it.lens === 'arxiv') return `a paper posted to arXiv, ${t}`;
  return `${t}, per ${srcName(it)}`;
}

function clampHeadline(s, max = 60) {
  let t = cleanTitle(s);
  if (t.length <= max) return t;
  t = t.slice(0, max + 1);
  const cut = t.lastIndexOf(' ');
  t = (cut > 24 ? t.slice(0, cut) : t.slice(0, max)).trim();
  return t.replace(/[\s,;:—–-]+$/, '');
}

// ---- line pools -----------------------------------------------------------

const OPENS = [
  (c) => `Good ${c.tod}. You're at the MNN research desk — I'm Pepper, and here's what moved.`,
  (c) => {
    const stories = c.n > 0
      ? `${cap(count(c.n))} ${plural(c.n, 'story', 'stories')}`
      : 'Fresh stories';
    return `This is MNN. I'm Pepper. ${stories} crossed the desk — let's get into it.`;
  },
  () => `From the MNN studio — I'm Pepper. The wire has been busy.`,
  (c) => (c.topics.length
    ? `Good ${c.tod} from the Model News Network. I'm Pepper — ${c.topics[0]} leads the sweep.`
    : `Good ${c.tod} from the Model News Network. I'm Pepper — here's the sweep.`),
  (c) => {
    const mid = c.busy ? `The wire ran hot this ${c.tod}` : `Here's what crossed this ${c.tod}`;
    return `You're live at the MNN desk. I'm Pepper. ${mid} — let's take it from the top.`;
  },
  (c) => {
    const beats = c.n === 1 ? 'is one beat' : c.n > 1 ? `are ${count(c.n)} beats` : 'are fresh beats';
    return `I'm Pepper, this is MNN, and there ${beats} on the board this ${c.tod}. Let's move.`;
  },
  (c) => `Good ${c.tod}. The desk is lit and the wire is warm. I'm Pepper, and this is MNN.`,
  () => `Welcome back to MNN. I'm Pepper. The desk swept the wire — here's what stuck.`,
  (c) => (c.topics.length
    ? `It's a full board this ${c.tod}: ${listPhrase(c.topics)}. I'm Pepper, and this is MNN.`
    : `It's a full board this ${c.tod}. I'm Pepper, and this is MNN.`),
];

const SIGNOFFS = [
  () => `That's the sweep. I'm Pepper — back on the hour, every hour. MNN.`,
  () => `The desk never closes. I'm Pepper, and this has been MNN.`,
  () => `More as it develops. For MNN, I'm Pepper. Stay curious out there.`,
  (c) => `That's what moved this ${c.tod}. The wire stays open, and so does the desk. I'm Pepper — MNN.`,
  (c) => `We keep eyes on ${listPhrase(c.topics)} so you don't have to. I'm Pepper. MNN — all your models, all the time.`,
  (c) => {
    const beats = c.n > 0 ? `${cap(count(c.n))} ${plural(c.n, 'beat', 'beats')}` : 'A full board';
    return `${beats}, one sweep, and the wire is already refilling. I'm Pepper — this has been MNN.`;
  },
  () => `The next sweep is already queued. Until then — for MNN, I'm Pepper.`,
  () => `That clears the desk for now. For the Model News Network, I'm Pepper. See you on the next pass.`,
  () => `Fresh coffee, same wire. I'm Pepper — back with more before you miss me. MNN.`,
];

const HANDOFFS = [
  () => `Meanwhile —`,
  (t) => `Turning to ${t} —`,
  (t) => `Now to the ${t} desk —`,
  () => `And this kept crossing the wire —`,
  (t) => `Next up, ${t}.`,
  (t) => `Over on the ${t} beat —`,
  (t) => `Staying on the wire — ${t} now.`,
  (t) => `If you follow ${t}, this next one is for you —`,
];

const LEADS = [
  (t, it) => `Top of the ${t} wire: ${cleanTitle(it.title)}. ${cap(attribution(it))}.`,
  (t, it) => `The ${t} beat leads with ${cleanTitle(it.title)} — ${attribution(it)}.`,
  (t, it) => `On ${t}, ${srcName(it)} has the lead: ${cleanTitle(it.title)}.`,
  (t, it) => `${srcName(it)} tops the ${t} wire: ${cleanTitle(it.title)}.`,
];

const SECONDS = [
  (it) => `Also crossing the desk: ${mention(it)}.`,
  (it) => `There's more — ${mention(it)}.`,
  (it) => `Behind it: ${mention(it)}.`,
];

const THIRDS = [
  (it) => `${srcName(it)} adds ${cleanTitle(it.title)}.`,
  (it) => `Rounding out the beat: ${mention(it)}.`,
];

const CLOSERS = [
  (t, n) => `${cap(count(n))} ${plural(n, 'item', 'items')} on this wire right now — the desk is watching where it goes.`,
  (t) => `That's the ${t} picture for now. The desk is watching for the follow-through.`,
  (t, n) => `${cap(count(n))} fresh ${plural(n, 'piece', 'pieces')} this sweep. More as it develops.`,
  (t) => `The board keeps ${t} up top — watching for the next move.`,
];

// ---- exports --------------------------------------------------------------

// ctx = { tod: 'morning'|'afternoon'|'evening', n, topics: [names], busy }
export function pickOpenSignoff(ctx = {}) {
  const c = {
    tod: ctx.tod || todNow(),
    n: Math.max(0, Number(ctx.n) || 0),
    topics: Array.isArray(ctx.topics) ? ctx.topics.filter(Boolean).map((t) => collapse(t)) : [],
    busy: !!ctx.busy,
  };
  const seed = hashStr(`${timeSeed()}|${c.tod}|${c.n}|${c.topics.join(',')}`);
  let open;
  let signoff;
  try {
    open = rotate(OPENS, seed, 'open')(c);
  } catch {
    open = `Good ${c.tod}. You're at the MNN research desk — I'm Pepper, and here's what moved.`;
  }
  try {
    signoff = rotate(SIGNOFFS, seed + 5, 'signoff')(c);
  } catch {
    signoff = `That's the sweep. I'm Pepper — back on the hour, every hour. MNN.`;
  }
  return { open, signoff };
}

export function handoffFor(i, topicName) {
  const topic = nameOf(topicName) || 'the next beat';
  const seed = hashStr(`${timeSeed()}|${Math.max(0, Number(i) || 0)}|${topic}`);
  try {
    return rotate(HANDOFFS, seed, 'handoff')(topic);
  } catch {
    return 'Meanwhile —';
  }
}

// Honest no-LLM segment built from real wire items. Names only actual titles
// and sources; the final line varies between the item count and what the desk
// is watching. mood: 'developing' when the beat is running hot, else 'steady'.
export function fallbackSegment(topicName, items) {
  const topic = nameOf(topicName) || 'this beat';
  try {
    const list = (Array.isArray(items) ? items : []).filter((x) => x && x.title);
    const fresh = list.length;
    if (!fresh) {
      return {
        headline: clampHeadline(`Quiet hour on the ${topic} beat`),
        script: [
          `The ${topic} wire is quiet right now — nothing new crossed the desk this sweep.`,
          `The desk keeps watching. More as it comes in.`,
        ],
        mood: 'steady',
      };
    }
    const mood = fresh >= 10 ? 'developing' : 'steady';
    const seed = hashStr(`${timeSeed()}|${topic}|${fresh}`);
    const [first, second, third] = list;
    const script = [rotate(LEADS, seed, 'lead')(topic, first)];
    if (second) script.push(rotate(SECONDS, seed + 1, 'second')(second));
    if (third && seed % 2 === 0) script.push(rotate(THIRDS, seed + 2, 'third')(third));
    script.push(rotate(CLOSERS, seed + 3, 'closer')(topic, fresh));
    return { headline: clampHeadline(first.title), script, mood };
  } catch {
    return {
      headline: clampHeadline(`Watching the ${topic} wire`),
      script: [
        `The desk is on the ${topic} beat, but this hour's notes did not come through clean.`,
        `We re-sweep shortly. More as it develops.`,
      ],
      mood: 'steady',
    };
  }
}

// Assembles the exact Bulletin shape from CONTRACTS.md §4. Segments arrive
// fully built (slug, topic, mood, headline, handoff, script, sources,
// freshCount) from research.js; this stamps identity and metadata.
export function composeBulletin({ open, signoff, segments, brainMode, stats } = {}) {
  const segs = Array.isArray(segments) ? segments.filter(Boolean) : [];
  let lines = null;
  if (!open || !signoff) {
    lines = pickOpenSignoff({
      tod: todNow(),
      n: segs.length,
      topics: segs.map((s) => s.topic),
      busy: segs.reduce((sum, s) => sum + (Number(s.freshCount) || 0), 0) >= 12,
    });
  }
  const brain = ['foundation', 'local', 'fallback'].includes(brainMode) ? brainMode : 'fallback';
  const st = stats && typeof stats === 'object' ? stats : {};
  return {
    id: store.bulletinId(),
    at: new Date().toISOString(),
    brain,
    open: open || lines.open,
    signoff: signoff || lines.signoff,
    segments: segs,
    stats: {
      topicsSwept: Number(st.topicsSwept) || 0,
      itemsSeen: Number(st.itemsSeen) || 0,
      freshItems: Number(st.freshItems) || 0,
    },
  };
}
