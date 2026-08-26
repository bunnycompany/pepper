import { log } from './log.js';
import { decodeEntities, collapseWs } from './sources/rss.js';

const UA = 'pepper-mnn/0.1 (+https://github.com/bunnycompany/pepper)';
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/json, text/xml, */*';
const PAGE_ACCEPT = 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Merge caller headers over the defaults, lowercasing names so a caller can
// override `accept` without sending it twice.
function headersFor(accept, extra) {
  const out = { 'user-agent': UA, accept };
  for (const [k, v] of Object.entries(extra || {})) out[String(k).toLowerCase()] = v;
  return out;
}

// Fetch a URL as text. Returns null on ANY failure (bad status, timeout,
// network error). One retry with a short pause. Never throws.
export async function fetchText(url, { timeoutMs = 15000, headers } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: headersFor(FEED_ACCEPT, headers),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (attempt === 2) {
        log.warn('fetch failed:', String(url).slice(0, 120), '-', e?.message || String(e));
        return null;
      }
      await sleep(300);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Fetch a URL and parse it as JSON. Returns null on any failure. Never throws.
export async function fetchJSON(url, opts) {
  const text = await fetchText(url, opts);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- readable text extraction ----------------------------------------------
// A small dependency-free reader: strip the furniture, keep the article. Best
// effort on real-world markup — every helper below is total and never throws.

const MAX_BYTES = 2 * 1024 * 1024; // bail on anything bigger than ~2MB
const MIN_TEXT = 200; // shorter than this is a stub, a paywall or a redirect
const MAX_ARTICLES = 24; // hard ceiling on fetches in one batch
const MAX_CANDIDATES = 48; // blocks scored per tag when hunting for the body

// Blocks that are never the article. `head` is not in the list: the title is
// read from it before the body is isolated.
const NOISE_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe',
  'object', 'form', 'nav', 'header', 'footer', 'aside', 'button', 'select'];

// Tags that end a line of text.
const BREAK_TAGS = /<\/?(?:p|div|section|article|main|br|li|ul|ol|dl|dt|dd|tr|td|th|table|h[1-6]|blockquote|pre|figure|figcaption|hr)\b[^>]*>/gi;

// Furniture that survives tag stripping. Only ever applied to short lines —
// a long paragraph mentioning a privacy policy is prose, not a cookie banner.
const BOILERPLATE = [
  /^(accept|reject|manage|allow|decline)\b.{0,40}\bcookies?\b/i,
  /\b(we|this site|our site|they) use[sd]? cookies\b/i,
  /\bcookie (policy|notice|banner|settings|preferences|consent)\b/i,
  /^(subscribe|sign in|sign up|log ?in|register|newsletter|advertisement|advertising|sponsored|share|tweet|print|save|menu|search|home|skip to (main )?content)\b.{0,24}$/i,
  /\b(subscribe|sign up|log ?in|sign in|register)\b.{0,24}\b(to (continue|read|keep reading)|for (free|unlimited)|now|today)\b/i,
  /^(read|continue) (more|reading)\b/i,
  /^(related|more from|more on|most (popular|read)|trending|recommended|you may (also )?like|editor.s picks|follow us|connect with us)\b/i,
  /^(all rights reserved|copyright\b|\u00a9)/i,
  /\b(privacy policy|terms of (use|service|sale)|all rights reserved)\b/i,
  /\b(enable|turn on) javascript\b/i,
  /\bjavascript (is )?(disabled|required|not enabled)\b/i,
  /\bad ?block(er)?\b/i,
  /^\d+\s*(min|minute)s?\s+read$/i,
  /^(photo|image|credit|illustration)\s*[:\u2014-]/i,
];

function isBoilerplate(line) {
  if (!/[a-z0-9]/i.test(line)) return true; // rules, bullets, stray punctuation
  const words = line.split(/\s+/).length;
  // Nav chrome and buttons: one or two words, no sentence ending.
  if (words <= 2 && line.length <= 24 && !/[.!?:]$/.test(line)) return true;
  // Breadcrumbs: "Home > Markets > Insurance", "Section | Publisher".
  if (line.length <= 90 && (/[\u203a\u00bb\u2039\u00ab]/.test(line) || /\s\|\s/.test(line))) return true;
  if (line.length > 220) return false; // a real paragraph, whatever it mentions
  return BOILERPLATE.some((re) => re.test(line));
}

// Value of an attribute on a single tag ('' when absent).
function attrOf(tag, name) {
  const m = String(tag).match(new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

// Balanced <tag>…</tag> ranges, in document order. `nested` includes inner
// copies of the same tag; otherwise only outermost ones are returned. Unclosed
// tags are simply skipped — better to keep too much text than to eat the page.
function findBlocks(html, tag, { nested = false, limit = 400 } = {}) {
  const out = [];
  const stack = [];
  const re = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '\\s*>', 'gi');
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] !== '/') {
      if (m[0].endsWith('/>')) continue;
      stack.push({ start: m.index, innerStart: re.lastIndex, depth: stack.length });
    } else {
      const open = stack.pop();
      if (!open) continue;
      if (nested || open.depth === 0) {
        out.push({ start: open.start, end: re.lastIndex, innerStart: open.innerStart, innerEnd: m.index });
      }
      if (out.length >= limit) break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function inner(html, block) {
  return html.slice(block.innerStart, block.innerEnd);
}

function stripNoise(html) {
  let out = String(html).replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of NOISE_TAGS) {
    const blocks = findBlocks(out, tag);
    if (!blocks.length) continue;
    let next = '';
    let at = 0;
    for (const b of blocks) {
      next += out.slice(at, b.start) + ' ';
      at = b.end;
    }
    out = next + out.slice(at);
  }
  return out;
}

// HTML fragment → readable lines. Tags become line breaks or spaces, entities
// are decoded once the markup is gone, furniture and repeats are dropped.
function htmlToText(html) {
  const flat = String(html).replace(BREAK_TAGS, '\n').replace(/<[^>]*>/g, ' ');
  const lines = [];
  let prev = '';
  for (const raw of decodeEntities(flat).split('\n')) {
    const line = collapseWs(raw);
    if (!line || line === prev || isBoilerplate(line)) continue;
    lines.push(line);
    prev = line;
  }
  return lines.join('\n');
}

// Text that sits inside links — navigation and card decks run high, prose runs low.
function linkChars(html) {
  let n = 0;
  const re = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(html))) n += collapseWs(m[1].replace(/<[^>]*>/g, ' ')).length;
  return n;
}

function scoreBlock(html) {
  const text = htmlToText(html);
  if (text.length < 140) return { text, score: 0 };
  const density = Math.min(1, linkChars(html) / text.length);
  const paras = (html.match(/<p\b/gi) || []).length;
  return { text, score: text.length * (1 - density) + paras * 25 };
}

// Score the biggest blocks only. Scoring walks a block's markup, so a page
// with a thousand wrapper divs would otherwise cost a second of CPU — and the
// article body is always among the largest text-bearing blocks anyway.
function candidatesFor(html, tag, nested) {
  const found = findBlocks(html, tag, { nested, limit: 1500 })
    .filter((b) => b.innerEnd - b.innerStart >= 140)
    .sort((a, b) => (b.innerEnd - b.innerStart) - (a.innerEnd - a.innerStart))
    .slice(0, MAX_CANDIDATES);
  const out = [];
  for (const b of found) {
    const frag = inner(html, b);
    const { text, score } = scoreBlock(frag);
    if (score > 0) out.push({ text, score, size: frag.length });
  }
  return out;
}

// The densest readable block: highest score, and among near-ties the tightest
// markup — that is the paragraph body rather than the wrapper it sits in.
function bestBlock(html) {
  let cands = candidatesFor(html, 'article', true);
  if (!cands.length) {
    cands = candidatesFor(html, 'main', true)
      .concat(candidatesFor(html, 'div', true), candidatesFor(html, 'section', true));
  }
  if (!cands.length) return '';
  const top = Math.max(...cands.map((c) => c.score));
  const near = cands.filter((c) => c.score >= top * 0.95);
  near.sort((a, b) => a.size - b.size);
  return near[0].text;
}

function metaContent(html, key) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const name = (attrOf(m[0], 'property') || attrOf(m[0], 'name')).toLowerCase();
    if (name !== key) continue;
    const v = collapseWs(attrOf(m[0], 'content'));
    if (v) return v;
  }
  return '';
}

function firstTagText(html, tag) {
  const m = html.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '\\s*>', 'i'));
  return m ? collapseWs(decodeEntities(m[1].replace(/<[^>]*>/g, ' '))) : '';
}

function extractTitle(html) {
  const title = metaContent(html, 'og:title') || firstTagText(html, 'title') || firstTagText(html, 'h1');
  return title.slice(0, 200);
}

function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).replace(/\s+\S*$/, '');
}

// extractArticle(html) → { title, text }. Exported for tests and for callers
// that already hold a page. Never throws; returns empty strings on junk input.
export function extractArticle(html, { maxChars = 12000 } = {}) {
  try {
    const src = String(html ?? '');
    const title = extractTitle(src);
    const body = findBlocks(src, 'body')[0];
    const clean = stripNoise(body ? inner(src, body) : src);
    const text = bestBlock(clean) || htmlToText(clean);
    return { title, text: clip(text, maxChars) };
  } catch (e) {
    log.warn('extract failed:', e?.message || String(e));
    return { title: '', text: '' };
  }
}

// ---- article fetching ------------------------------------------------------

function charsetOf(contentType) {
  const m = String(contentType).match(/charset\s*=\s*"?([\w-]+)/i);
  return m ? m[1] : 'utf-8';
}

function decodeBody(bytes, charset) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function discard(res) {
  try {
    await res.body?.cancel();
  } catch {
    // body already consumed or torn down — nothing to release
  }
}

// Read a response body, giving up as soon as it passes maxBytes. Returns the
// bytes, or null when the page is too big to be worth reading.
async function readCapped(res, maxBytes) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    n += value.byteLength;
    if (n > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // stream already gone
      }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

// fetchArticle(url) → { url, title, text, ok }. `url` is the URL that was
// asked for (redirects are followed, but callers join results back to the item
// they started from). ok:false on any failure — bad URL, HTTP error, timeout,
// a non-HTML or oversized body, or a page with no readable text. Never throws.
export async function fetchArticle(url, { timeoutMs = 12000, maxChars = 12000 } = {}) {
  const target = String(url ?? '').trim();
  const fail = (why) => {
    log.warn('article skipped:', target.slice(0, 100) || '(empty)', '-', why);
    return { url: target, title: '', text: '', ok: false };
  };
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return fail('not a url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail('scheme ' + parsed.protocol);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: headersFor(PAGE_ACCEPT),
    });
    if (!res.ok) {
      await discard(res);
      return fail('HTTP ' + res.status);
    }
    const ctype = String(res.headers.get('content-type') || '').toLowerCase();
    if (ctype && !/text\/html|application\/xhtml|text\/plain/.test(ctype)) {
      await discard(res);
      return fail('content-type ' + ctype.split(';')[0].trim());
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      await discard(res);
      return fail('declared ' + Math.round(declared / 1024) + 'KB');
    }
    const bytes = await readCapped(res, MAX_BYTES);
    if (!bytes) return fail('over ' + Math.round(MAX_BYTES / 1024) + 'KB');
    const { title, text } = extractArticle(decodeBody(bytes, charsetOf(ctype)), { maxChars });
    if (text.length < MIN_TEXT) return fail('no readable text');
    return { url: target, title, text, ok: true };
  } catch (e) {
    return fail(e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)));
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

// One request at a time per host, spaced by `gap` — chaining onto the previous
// request to that host, rather than only rate-limiting starts. A URL with no
// host never reaches the network, so it never waits for one.
function queueForHost(chains, url, gap, job) {
  const host = hostOf(url);
  if (!host) return job();
  const prev = chains.get(host);
  const run = (async () => {
    if (prev) {
      await prev;
      if (gap > 0) await sleep(gap);
    }
    return job();
  })();
  chains.set(host, run.then(() => {}, () => {}));
  return run;
}

// fetchArticles(urls) → one result per URL, in the order they were asked for,
// so callers can join results back to the items they came from. Repeats share a
// single fetch, junk URLs come back ok:false, at most `max` are read, at most
// `concurrency` at a time overall and one at a time per host. Never throws.
export async function fetchArticles(urls, {
  concurrency = 4, perHostGap = 400, max = MAX_ARTICLES, timeoutMs, maxChars,
} = {}) {
  const list = (Array.isArray(urls) ? urls : [])
    .slice(0, Math.max(0, max))
    .map((u) => String(u ?? '').trim());
  if (!list.length) return [];
  const results = new Array(list.length);
  const chains = new Map();
  const jobs = new Map();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      const target = list[i];
      let job = jobs.get(target);
      if (!job) {
        job = queueForHost(chains, target, perHostGap, () => fetchArticle(target, { timeoutMs, maxChars }));
        jobs.set(target, job);
      }
      results[i] = await job;
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, list.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return results;
}
