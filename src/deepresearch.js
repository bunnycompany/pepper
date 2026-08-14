// Deep research: one question, multiple search angles, one desk report.
// Used by `pepper research`, POST /api/research, and the Siri AI bridge
// (docs/SIRI.md). Works without a running server; degrades without a brain.
import * as news from './sources/news.js';
import * as hn from './sources/hn.js';
import * as arxiv from './sources/arxiv.js';
import * as store from './store.js';
import { log } from './log.js';

const DIGEST_MAX = 2600;

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

export async function runDeepResearch(question, { emit = () => {} } = {}) {
  const q = String(question || '').trim();
  if (!q) throw new Error('research question required');
  const { getBrain } = await import('./brain/index.js');
  const brain = getBrain();
  const startedAt = new Date().toISOString();
  emit('research-start', { question: q });

  // 1. decompose into search angles
  let angles = [];
  const anglesText = await brain.generate({
    instructions: 'You decompose research questions into web search queries. Reply with one query per line, two to five words each. No numbering, no commentary.',
    prompt: `Research question: ${q}\nWrite 4 distinct search queries covering different angles of it.`,
    max: 120,
  });
  if (anglesText) {
    // Small on-device models sometimes emit tool-call syntax or snake_case
    // pseudo-queries; salvage what reads like natural search text.
    angles = anglesText.split('\n')
      .map((s) => s.trim().replace(/^[-*\d.)\s]+/, ''))
      .map((s) => s.replace(/^Tool:\s*/i, '').replace(/^search[_ ]/i, '').replace(/_/g, ' ').trim())
      .filter((s) => s && s.length <= 80 && !/[:{}[\]<>|]/.test(s) && /^[\w"'’ .,&-]+$/i.test(s))
      .slice(0, 4);
  }
  if (q.length <= 70) angles.unshift(q);
  if (!angles.length) angles = [q.slice(0, 70)];
  emit('research-angles', { angles });

  // 2. sweep every angle across all lenses
  const seen = new Set();
  const items = [];
  let angleIdx = 0;
  for (const angle of angles.slice(0, 5)) {
    emit('research-sweep', { query: angle });
    // arXiv rate-limits bursts hard — only the first two angles query it.
    const fetchers = [news.fetchTopic(angle), hn.fetchTopic(angle)];
    if (angleIdx++ < 2) fetchers.push(arxiv.fetchTopic(angle));
    const results = await Promise.allSettled(fetchers);
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const it of r.value || []) {
        if (!it || !it.title) continue;
        const key = String(it.url || it.title).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(it);
      }
    }
  }
  emit('research-swept', { items: items.length });

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
    question: q, angles, items: items.length, mode,
    notes: noteMatch ? noteMatch[1].trim() : null,
    report: onAir,
    bulletinId: bulletin.id,
    startedAt,
  };
}
