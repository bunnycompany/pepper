// Deep research: one question, multiple search angles, one desk report.
// Used by `pepper research`, POST /api/research, and the Siri AI bridge
// (docs/SIRI.md). Works without a running server; degrades without a brain.
import * as news from './sources/news.js';
import * as hn from './sources/hn.js';
import * as arxiv from './sources/arxiv.js';
import * as store from './store.js';
import { log } from './log.js';

const DIGEST_MAX = 2600;

// Long mode budgets. The on-device brain answers inside a ~4K-token window
// shared by prompt and completion, so every prompt is measured in characters
// before it is sent (English runs ~3.5 chars per token on scraped page text).
const MAX_READS = 16; // hard cap on pages fetched per long report
const READ_CONCURRENCY = 4; // polite: a handful of hosts at a time
const READS_PER_HOST = 3; // never lean the whole report on one publisher
const READS_PER_LENS = 5; // and never let one lens eat the whole read budget
const MIN_TEXT = 240; // shorter than this is a paywall stub, not an article
const SECTION_SOURCES = 6; // full-text sources offered to one section
const SECTION_TEXT_MAX = 1200;
const SECTION_TEXT_MIN = 800;
const EXCERPT_BUDGET = 5800; // chars of page text shared across a section's sources
const NOTE_BUDGET = 7000; // hard ceiling on one section prompt's notes
const HEADLINE_EXTRAS = 4; // unread items listed as one-liners per section
const SYNTH_BUDGET = 6000; // chars of section digest fed to the synthesis
const RECAP_CHARS = 320; // section digest length for intro/outro

const REPORT_PERSONA = 'You are Pepper, MNN\'s research anchor — the singularity desk. '
  + 'You are answering a viewer\'s research question from wire notes gathered moments ago. '
  + 'Every claim is attributed to its source; confirmed facts are separated from rumor; '
  + 'vendor claims are labeled as vendor claims; what the notes cannot answer gets said '
  + 'plainly. First write "DESK NOTES:" — a 40-60 word private analysis: which items '
  + 'matter, how sources weigh, what stays unknown. Then write "ON AIR:" — a 180-260 word '
  + 'broadcast answer to the question: strongest confirmed finding first, related items '
  + 'grouped, sources named inline, closing with what the desk is watching next. Present '
  + 'tense, active voice, no emojis, no markdown. Never invent facts absent from the notes. '
  + 'Write for the mouth: spell unusual acronyms as letters with spaces (A I S I), prefer '
  + '"the desk is watching" over "the desk watches next", and round big numbers into words.';

function lineFor(it) {
  const pts = it.points ? ` ${it.points}pts` : '';
  const snip = it.snippet ? ` — ${String(it.snippet).slice(0, 120)}` : '';
  return `- [${it.lens}${pts}] ${it.title}${snip} (${it.source})`;
}

function buildDigest(items) {
  const ranked = [...items].sort((a, b) => {
    const w = (x) => (x.lens === 'news' ? 2 : x.lens === 'arxiv' ? 1 : 0) + Math.min(2, (x.points || 0) / 150);
    return w(b) - w(a);
  });
  const lines = [];
  let len = 0;
  for (const it of ranked) {
    const line = lineFor(it).slice(0, 300);
    if (len + line.length + 1 > DIGEST_MAX) break;
    lines.push(line);
    len += line.length + 1;
  }
  return { digest: lines.join('\n'), ranked };
}

function templateReport(question, ranked) {
  const top = ranked.slice(0, 5);
  if (!top.length) {
    return `ON AIR: The wire is quiet on this one. The desk swept the news, the forums, and the papers for "${question}" and came back with nothing solid enough to report. That itself is information: if this were moving, it would be leaving tracks. The desk keeps watching.`;
  }
  const lines = top.map((it) => `${it.title}, per ${it.source}.`);
  return `ON AIR: On "${question}", here is what actually crossed the wire. `
    + lines.join(' ')
    + ` The desk reports only what the wire supports — the fuller read needs an on-device brain, and this machine is running without one tonight.`;
}

// ---- optional capabilities -------------------------------------------------
// The article reader (src/fetchx.js) and the broad web lens (src/sources/web.js)
// are loaded lazily and may legitimately be absent. When either is missing the
// long path quietly falls back to headlines and snippets — it never throws.

let readerPromise = null;
function loadReader() {
  if (!readerPromise) {
    readerPromise = import('./fetchx.js')
      .then((m) => (typeof m.fetchArticles === 'function' ? m.fetchArticles : null))
      .catch((e) => {
        log.warn('deep research: article reader unavailable:', e?.message || String(e));
        return null;
      });
  }
  return readerPromise;
}

let webLensPromise = null;
function loadWebLens() {
  if (!webLensPromise) {
    webLensPromise = import('./sources/web.js')
      .then((m) => (typeof m.fetchTopic === 'function' ? m : null))
      .catch(() => {
        log.warn('deep research: web lens unavailable — sweeping news/hn/arxiv only');
        return null;
      });
  }
  return webLensPromise;
}

// Leading interrogatives and articles carry no search signal — a facet query
// built from the first words of "What is the current state of X?" searches for
// "What is the current state of latest developments", which finds nothing.
const STOPWORDS = new Set(['a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being',
  'but', 'by', 'can', 'could', 'describe', 'did', 'do', 'does', 'explain', 'for', 'from', 'give',
  'had', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'know', 'may', 'me', 'might',
  'must', 'my', 'need', 'of', 'on', 'or', 'our', 'over', 'please', 'provide', 'shall', 'should',
  'summarize', 'tell', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'to', 'us', 'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'whose', 'why', 'will', 'with', 'would', 'you', 'your']);

function questionStem(q) {
  const words = String(q).replace(/[?!.,;:"']+/g, ' ').split(/\s+/).filter(Boolean);
  const content = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  return (content.length >= 2 ? content : words).slice(0, 5).join(' ');
}

// ---- long mode -------------------------------------------------------------

const LENS_WEIGHT = { news: 2, web: 2, arxiv: 1.5, hn: 1 };

// How much a source is worth reading: lens authority first, dated items over
// undated, forum score only as a tiebreak — a hot thread must not outrank a wire
// report just for being hot.
function readWeight(it) {
  return (LENS_WEIGHT[it.lens] ?? 0.5)
    + (it.publishedAt ? 0.3 : 0)
    + (it.snippet ? 0.2 : 0)
    + Math.min(0.9, (it.points || 0) / 400);
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// Trim to `max` chars on a sentence boundary where there is one, a word
// boundary otherwise, so an excerpt never ends mid-number.
function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const dot = cut.lastIndexOf('. ');
  const body = dot > max * 0.6 ? cut.slice(0, dot + 1) : cut.replace(/\s+\S*$/, '');
  return body + ' …';
}

// Which pages are worth spending fetches on: best sources first, capped per
// host so one publisher (or one Google News redirect farm) cannot eat the
// budget, and capped per lens so the report reads more than one kind of source.
// Some URLs cannot yield article text no matter how politely we ask: Google
// News RSS links are encoded redirect wrappers that land on a JS interstitial,
// and a spent read slot is a section paragraph that never got real material.
// The headline still cites fine — only the reading budget skips them.
const UNREADABLE_HOSTS = /(^|\.)(news\.google\.com|consent\.google\.com|news\.yahoo\.com)$/i;

function readable(url) {
  const h = hostOf(url);
  return !!h && !UNREADABLE_HOSTS.test(h);
}

function pickForReading(items) {
  const ranked = items
    .filter((it) => it && typeof it.url === 'string' && /^https?:\/\//i.test(it.url))
    .filter((it) => readable(it.url))
    .sort((a, b) => readWeight(b) - readWeight(a));
  const perHost = new Map();
  const perLens = new Map();
  const picked = [];
  const taken = new Set();
  const take = (it, lensCap) => {
    if (picked.length >= MAX_READS || taken.has(it)) return;
    const h = hostOf(it.url);
    if (h && (perHost.get(h) || 0) >= READS_PER_HOST) return;
    const l = String(it.lens || '');
    if ((perLens.get(l) || 0) >= lensCap) return;
    if (h) perHost.set(h, (perHost.get(h) || 0) + 1);
    perLens.set(l, (perLens.get(l) || 0) + 1);
    taken.add(it);
    picked.push(it);
  };
  // First pass spreads the budget across lenses; the second spends whatever is
  // left over (a lens that came back empty must not cost us reads).
  for (const it of ranked) take(it, READS_PER_LENS);
  for (const it of ranked) take(it, MAX_READS);
  return picked;
}

// Fetch the real page text for the strongest items and hang it on the item as
// `.text`. Best-effort throughout: a dead reader, a failed batch or a paywalled
// page costs coverage, never the cycle. Returns how many pages were read.
async function readSources(items, emit) {
  const fetchArticles = await loadReader();
  if (typeof fetchArticles !== 'function') return 0;
  const picked = pickForReading(items);
  if (!picked.length) return 0;
  for (const it of picked) emit('research-reading', { url: it.url, title: it.title });
  let results = [];
  try {
    results = await fetchArticles(picked.map((it) => it.url), { concurrency: READ_CONCURRENCY }) || [];
  } catch (e) {
    log.warn('deep research: reading pass failed:', e?.message || String(e));
    return 0;
  }
  const byUrl = new Map();
  for (const r of results) if (r && r.url) byUrl.set(String(r.url), r);
  const aligned = results.length === picked.length;
  let read = 0;
  for (let i = 0; i < picked.length; i++) {
    const it = picked[i];
    const r = aligned ? results[i] : byUrl.get(it.url);
    if (!r || r.ok === false) continue;
    const text = String(r.text || '').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_TEXT) continue;
    it.text = text;
    if (!it.snippet) it.snippet = text.slice(0, 200);
    read++;
  }
  emit('research-read', { read, tried: picked.length });
  return read;
}

// One section's notes: up to SECTION_SOURCES pages the desk actually read,
// each with a real excerpt, plus a short headline-only tail for breadth.
// Returns the prompt block and every citation number it offered.
function sectionNotes(mine, num) {
  const ranked = [...mine].sort((a, b) => ((b.text ? 1 : 0) - (a.text ? 1 : 0)) || (readWeight(b) - readWeight(a)));
  const perHost = new Map();
  const full = [];
  for (const it of ranked) {
    if (!it.text) break; // read items sort first, so the rest are all thin
    const key = hostOf(it.url) || String(it.source || '');
    const n = perHost.get(key) || 0;
    if (n >= 2) continue; // diversity beats more text from one publisher
    perHost.set(key, n + 1);
    full.push(it);
    if (full.length >= SECTION_SOURCES) break;
  }
  const share = full.length
    ? Math.max(SECTION_TEXT_MIN, Math.min(SECTION_TEXT_MAX, Math.floor(EXCERPT_BUDGET / full.length)))
    : 0;
  const offered = [];
  const blocks = [];
  let used = 0;
  for (const it of full) {
    const head = `[${num.get(it)}] ${String(it.title).slice(0, 160)} — ${it.source} (${it.lens})`;
    const block = `${head}\n${clip(it.text, share)}`;
    if (used + block.length + 2 > NOTE_BUDGET) break;
    blocks.push(block);
    offered.push(num.get(it));
    used += block.length + 2;
  }
  const thin = [];
  for (const it of ranked) {
    if (it.text) continue;
    if (thin.length >= HEADLINE_EXTRAS) break;
    const line = `[${num.get(it)}] ${lineFor(it).slice(2, 240)}`;
    if (used + line.length + 1 > NOTE_BUDGET) break;
    thin.push(line);
    offered.push(num.get(it));
    used += line.length + 1;
  }
  if (!blocks.length && !thin.length) return null;
  const parts = [];
  if (blocks.length) {
    parts.push('SOURCE EXCERPTS — text the desk pulled from the pages themselves:\n\n' + blocks.join('\n\n'));
  }
  if (thin.length) {
    parts.push('HEADLINES ONLY — no page text was retrieved for these:\n' + thin.join('\n'));
  }
  return { notes: parts.join('\n\n'), offered, fullCount: blocks.length };
}

// Small on-device models sometimes hallucinate tool-call syntax, echo their
// notes back, or bolt on their own headers; scrub that before any text reaches
// a report. Returns null when nothing usable survives.
function scrubProse(text) {
  if (!text) return null;
  const lines = String(text).split('\n').filter((l) => {
    const t = l.trim();
    if (/^tool_call\b/i.test(t)) return false;
    if (/^\{\s*"tool_name"/.test(t)) return false;
    if (/^[a-z_]+\s*=\s*\[\{/.test(t)) return false;
    if (/^The response_format and tool calls/i.test(t)) return false;
    if (/^- \[\d+\]/.test(t) || /^\[\d+\] \[(news|hn|arxiv|web)\]/i.test(t)) return false;
    // An echoed excerpt header: "[7] Title — Publisher (news)".
    if (/^\[\d+\]\s.*\((?:news|hn|arxiv|web)\)\s*$/i.test(t)) return false;
    if (/^(SOURCE EXCERPTS|HEADLINES ONLY|Report question|Section focus|Numbered wire notes)\b/i.test(t)) return false;
    // We own the outline; a model-invented header would fight it.
    if (/^#{1,6}\s/.test(t)) return false;
    return true;
  });
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out.length >= 60 ? out : null;
}

const SECTION_INSTRUCTIONS = 'You write one section of a research desk report, working '
  + 'from excerpts of pages the desk actually read. Broadcast-clear flowing prose, present '
  + 'tense, 200 to 320 words — never list or replay the notes, never output tool calls, JSON '
  + 'or headers. Every factual claim cites its source by the bracketed number shown in the '
  + 'notes, like [3]. Prefer the specific figures, dates, names, quantities and quotations '
  + 'that appear in the excerpts over general statements — that specificity is the point of '
  + 'the section. Where two sources disagree, say so and cite both. Label vendor and company '
  + 'claims as claims. Spread your citations across the sources you were given rather than '
  + 'building the whole section on one. Never invent facts or numbers absent from the notes; '
  + 'where the notes cannot answer, say so plainly and move on.';

const SYNTH_INSTRUCTIONS = 'You are the desk editor writing the one part of the report no '
  + 'single section could write: what all of it adds up to. You are given the question and '
  + 'every section already filed. In 220 to 320 words of flowing prose, in this order: first '
  + 'the convergences — what two or more independent sources agree on, and why that agreement '
  + 'carries weight; then the tensions — where sources contradict each other, where a vendor '
  + 'claim outruns the evidence, or where a timeline has already slipped, named plainly; then '
  + 'the implication — what the weight of the evidence actually means for the question asked, '
  + 'stated as the judgement the sections only imply; and finally what would change this '
  + 'picture — the specific number, filing, shipment or event that would overturn the reading. '
  + 'Carry the bracketed citation numbers across from the sections, like [3]. Add no facts '
  + 'that are not already in the sections. No lists, no headers, no tool calls, no JSON.';

async function generateLongReport(q, angles, byAngle, items, brain, emit) {
  const num = new Map(items.map((it, i) => [it, i + 1]));
  const offered = new Set();
  const sections = [];
  for (const angle of angles) {
    const mine = byAngle.get(angle) || [];
    if (!mine.length) continue;
    const notes = sectionNotes(mine, num);
    if (!notes) continue;
    emit('research-writing', { section: angle, sources: notes.offered.length, read: notes.fullCount });
    const body = await brain.generate({
      instructions: SECTION_INSTRUCTIONS,
      prompt: `Report question: ${q}\nSection focus: ${angle}\n\n${notes.notes}`,
      max: 560,
    });
    const clean = scrubProse(body);
    if (!clean) continue;
    for (const n of notes.offered) offered.add(n);
    sections.push({ angle, body: clean });
  }
  if (!sections.length) return null;

  // Cross-section synthesis: the pass that has to see everything at once.
  const synthShare = Math.max(320, Math.min(900, Math.floor(SYNTH_BUDGET / sections.length)));
  const synthNotes = sections
    .map((s) => `SECTION — ${s.angle}\n${clip(s.body, synthShare)}`)
    .join('\n\n');
  emit('research-writing', { section: 'What this adds up to', synthesis: true });
  const synthesis = scrubProse(await brain.generate({
    instructions: SYNTH_INSTRUCTIONS,
    prompt: `Report question: ${q}\n\nSections filed:\n\n${synthNotes}`,
    max: 620,
  }));

  // The intro and the closing each get a job the synthesis is not doing, and
  // the closing never sees the synthesis — a small model shown a conclusion
  // paraphrases it rather than going past it.
  const recap = sections.map((s) => `- ${s.angle}: ${clip(s.body, RECAP_CHARS)}`).join('\n');
  const readCount = items.filter((it) => it.text).length;
  const lenses = [...new Set(items.map((it) => it.lens).filter(Boolean))].join(', ');
  const scope = `The desk swept ${items.length} items across ${lenses || 'the wire'} `
    + `and read ${readCount} of those pages in full.`;
  const intro = await brain.generate({
    instructions: 'You write the opening of a research desk report: 90 to 150 words. Open by '
      + 'stating the question and the scope line you are given, in the desk\'s own words. Then '
      + 'say what the sources could and could not establish. Close on the single strongest '
      + 'finding, in one sentence, carrying its citation number in square brackets like [3] if '
      + 'the summaries carry one. Do not summarise every section. Plain prose, no headers, no '
      + 'lists, no invented facts.',
    prompt: `Question: ${q}\n\nScope: ${scope}\n\nSection summaries:\n${recap}`,
    max: 280,
  });
  const outro = await brain.generate({
    instructions: 'You close a research desk report in 80 to 130 words, and your only subject '
      + 'is what the sources did not settle. Name three specific gaps — a number nobody '
      + 'published, a claim only one source makes, a date that has already slipped or could — '
      + 'and for each say what evidence would close it and what the desk is watching. Carry '
      + 'the bracketed citation numbers across where the summaries have them. Plain prose, no '
      + 'headers, no lists.',
    prompt: `Question: ${q}\n\nSection summaries:\n${recap}`,
    max: 260,
  });

  const parts = [`# ${q}`];
  const introClean = scrubProse(intro);
  if (introClean) parts.push(introClean);
  for (const s of sections) parts.push(`## ${s.angle}\n\n${s.body}`);
  if (synthesis) parts.push(`## What this adds up to\n\n${synthesis}`);
  const outroClean = scrubProse(outro);
  if (outroClean) parts.push(`## What the desk is watching\n\n${outroClean}`);

  // A citation may only name a source the writer was actually shown. Widening
  // this set from the prose would let an in-range hallucinated [n] promote a
  // real-but-unrelated source next to a claim it does not support — a
  // support-mismatch, which is the failure mode FACT actually measures.
  // Unoffered markers are stripped from the prose instead of legitimized.
  const cited = new Set();
  for (let i = 0; i < parts.length; i++) {
    parts[i] = parts[i].replace(/\[(\d{1,4})\]/g, (mark, n) => {
      const k = Number(n);
      if (!offered.has(k)) return '';
      cited.add(k);
      return mark;
    }).replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:])/g, '$1');
  }
  const listed = items.filter((it) => cited.has(num.get(it)));
  parts.push('## Sources\n\n' + listed
    .map((it) => `[${num.get(it)}] ${it.title} — ${it.source}${it.url ? ` — ${it.url}` : ''}`)
    .join('\n'));
  return parts.join('\n\n');
}

export async function runDeepResearch(question, { emit = () => {}, long = false } = {}) {
  const q = String(question || '').trim();
  if (!q) throw new Error('research question required');
  const { getBrain } = await import('./brain/index.js');
  const brain = getBrain();
  const startedAt = new Date().toISOString();
  emit('research-start', { question: q });

  // 1. decompose into search angles
  const wantAngles = long ? 7 : 4;
  const maxAngles = long ? 8 : 5;
  let angles = [];
  const anglesText = await brain.generate({
    instructions: 'You decompose research questions into web search queries. Reply with one query per line, two to five words each. No numbering, no commentary.',
    prompt: `Research question: ${q}\nWrite ${wantAngles} distinct search queries covering different angles of it.`,
    max: long ? 200 : 120,
  });
  if (anglesText) {
    // Small on-device models sometimes emit tool-call syntax or snake_case
    // pseudo-queries; salvage what reads like natural search text.
    angles = anglesText.split('\n')
      .map((s) => s.trim().replace(/^[-*\d.)\s]+/, ''))
      .map((s) => s.replace(/^Tool:\s*/i, '').replace(/^search[_ ]/i, '').replace(/_/g, ' ').trim())
      .filter((s) => s && s.length <= 80 && !/[:{}[\]<>|]/.test(s) && /^[\w"'’ .,&-]+$/i.test(s))
      .slice(0, wantAngles);
  }
  if (q.length <= 70) angles.unshift(q);
  if (!angles.length) angles = [q.slice(0, 70)];
  if (long && angles.length < 6) {
    // Decomposition came back thin (small models sometimes emit junk there);
    // guarantee search diversity with deterministic facets of the question.
    const stem = questionStem(q);
    for (const facet of ['latest developments', 'statistics data', 'analysis criticism',
      'market outlook', 'timeline milestones', 'risks challenges', 'cost economics']) {
      const a = `${stem} ${facet}`.slice(0, 78);
      if (!angles.some((x) => x.toLowerCase() === a.toLowerCase())) angles.push(a);
      if (angles.length >= maxAngles) break;
    }
  }
  if (long) {
    // A repeated angle would file the same section twice — dedupe before sweeping.
    // Short mode keeps its existing behaviour untouched.
    const uniq = new Map();
    for (const a of angles) if (!uniq.has(a.toLowerCase())) uniq.set(a.toLowerCase(), a);
    angles = [...uniq.values()];
  }
  angles = angles.slice(0, maxAngles);
  emit('research-angles', { angles });

  // 2. sweep every angle across all lenses
  // Long mode adds the broad web lens so questions outside tech still find
  // sources; it is optional and absent installs simply sweep the other three.
  const webLens = long ? await loadWebLens() : null;
  const seen = new Map();
  const items = [];
  const byAngle = new Map();
  let angleIdx = 0;
  for (const angle of angles) {
    emit('research-sweep', { query: angle });
    // arXiv rate-limits bursts hard — only the first two angles query it.
    const fetchers = [news.fetchTopic(angle), hn.fetchTopic(angle)];
    if (angleIdx++ < 2) fetchers.push(arxiv.fetchTopic(angle));
    if (webLens) fetchers.push(webLens.fetchTopic(angle));
    const results = await Promise.allSettled(fetchers);
    const mine = [];
    const mineSeen = new Set();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const it of r.value || []) {
        if (!it || !it.title) continue;
        const key = String(it.url || it.title).toLowerCase();
        const kept = seen.get(key);
        if (kept) {
          // Same story surfacing under another angle still belongs to this
          // section — attribute the item we already numbered, once.
          if (!mineSeen.has(kept)) { mineSeen.add(kept); mine.push(kept); }
          continue;
        }
        seen.set(key, it);
        items.push(it);
        mineSeen.add(it);
        mine.push(it);
      }
    }
    byAngle.set(angle, mine);
  }
  emit('research-swept', { items: items.length });

  // Long mode: read the strongest pages for real, then file a sectioned
  // special report with numbered, verifiable citations.
  let longArticle = null;
  let sourcesRead = 0;
  if (long && items.length) {
    try {
      sourcesRead = await readSources(items, emit);
    } catch (e) {
      log.warn('deep research: reading pass skipped:', e?.message || String(e));
    }
    longArticle = await generateLongReport(q, angles, byAngle, items, brain, emit);
  }

  // 3 + 4. digest → report
  const { digest, ranked } = buildDigest(items);
  let report = null;
  if (digest) {
    report = await brain.generate({
      instructions: REPORT_PERSONA,
      prompt: `Viewer question: ${q}\n\nWire notes (gathered just now):\n${digest}`,
      max: 560,
    });
  }
  const mode = (await brain.status()).mode;
  if (!report || !/ON AIR:/i.test(report)) report = templateReport(q, ranked);

  // 5. file it as a bulletin so the studio presents it
  const onAir = report.split(/ON AIR:/i).pop().trim();
  const noteMatch = report.match(/DESK NOTES:([\s\S]*?)(?:ON AIR:)/i);
  const paragraphs = onAir.split(/\n{2,}|(?<=\.)\s{2,}/).map((s) => s.trim()).filter(Boolean);
  const script = paragraphs.length > 1 ? paragraphs : onAir.split(/(?<=[.!?])\s+(?=[A-Z])/).reduce((acc, s) => {
    const last = acc[acc.length - 1];
    if (last && (last + ' ' + s).length < 220) acc[acc.length - 1] = last + ' ' + s;
    else acc.push(s);
    return acc;
  }, []);
  const bulletin = {
    id: store.bulletinId(),
    at: new Date().toISOString(),
    brain: report && mode !== 'fallback' ? mode : 'fallback',
    open: `Special report from the research desk. You asked — I dug. The question: ${q}`,
    signoff: 'That is what the wire supports tonight. Ask me another. MNN.',
    segments: [{
      slug: 'deep-dive',
      topic: 'DEEP DIVE',
      mood: 'developing',
      headline: q.length <= 60 ? q : q.slice(0, 57).replace(/\s+\S*$/, '') + '…',
      handoff: null,
      script,
      sources: ranked.slice(0, 8).map((it) => ({ title: it.title, url: it.url, source: it.source, lens: it.lens })),
      freshCount: items.length,
    }],
    stats: { topicsSwept: angles.length, itemsSeen: items.length, freshItems: items.length },
  };
  try {
    store.saveBulletin(bulletin);
  } catch (e) {
    log.warn('deep research: bulletin not saved:', e.message);
  }
  emit('research-done', { id: bulletin.id, items: items.length });
  return {
    question: q, angles, items: items.length, mode, article: longArticle,
    sourcesRead,
    notes: noteMatch ? noteMatch[1].trim() : null,
    report: onAir,
    bulletinId: bulletin.id,
    startedAt,
  };
}
