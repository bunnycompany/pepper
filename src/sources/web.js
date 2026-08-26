// The general web lens. The other lenses are wires — a tech news feed, a
// forum, a paper index — and they come back empty on demography, insurance
// markets or public policy. This one asks the open web, keylessly, through
// DuckDuckGo's no-account HTML endpoint.
import { fetchText } from '../fetchx.js';
import { decodeEntities, collapseWs } from './rss.js';

const ENDPOINT = 'https://html.duckduckgo.com/html/';
const MAX_ITEMS = 10;
const MIN_GAP = 800; // never two searches back to back
const COOLDOWN_MS = 5 * 60_000; // stand-down after DuckDuckGo pushes back

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Paid placements and click trackers, never results.
const AD_MARKS = /\bresult--ad\b|badge--ad|ad_provider=|ad_domain=|\/y\.js\b/i;

function attrOf(tag, name) {
  const m = String(tag).match(new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : '';
}

function textOf(html) {
  return collapseWs(decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')));
}

// DuckDuckGo hands results back wrapped in its own redirector:
// //duckduckgo.com/l/?uddg=<encoded real url>&rut=<hash>. Unwrap it, keep
// only http(s), and drop anything still pointing back at DuckDuckGo.
function realUrl(href) {
  let raw = decodeEntities(String(href ?? '')).trim();
  if (!raw) return '';
  if (raw.startsWith('//')) raw = 'https:' + raw;
  try {
    const wrapper = new URL(raw, ENDPOINT);
    const wrapped = wrapper.searchParams.get('uddg');
    const out = wrapped ? new URL(wrapped) : wrapper;
    if (out.protocol !== 'http:' && out.protocol !== 'https:') return '';
    if (/(^|\.)duckduckgo\.com$/i.test(out.hostname)) return '';
    return out.toString();
  } catch {
    return '';
  }
}

// The first <a> in `block` whose attributes carry `cls` → { attrs, inner }.
function anchorWith(block, cls) {
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(block))) {
    if (m[1].includes(cls)) return { attrs: m[1], inner: m[2] };
  }
  return null;
}

function snippetOf(block) {
  const tagged = block.match(/<(a|div|td)\b[^>]*result__snippet[^>]*>([\s\S]*?)<\/\1\s*>/i);
  return tagged ? textOf(tagged[2]).slice(0, 300) : '';
}

// parseResults(html) → Item[]. Exported for tests. Splits the page on result
// containers (class="result …", which does not match result__body and friends)
// and reads title, link and snippet out of each. Never throws.
export function parseResults(html) {
  try {
    const src = String(html ?? '');
    const starts = [];
    const re = /<(?:div|tr|td)\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>/gi;
    let m;
    while ((m = re.exec(src))) starts.push(m.index);
    const items = [];
    const seen = new Set();
    for (let i = 0; i < starts.length; i++) {
      const block = src.slice(starts[i], starts[i + 1] ?? src.length);
      if (AD_MARKS.test(block)) continue;
      const anchor = anchorWith(block, 'result__a');
      if (!anchor) continue;
      const url = realUrl(attrOf(anchor.attrs, 'href'));
      const title = textOf(anchor.inner);
      if (!url || !title) continue;
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const item = {
        title: title.slice(0, 300),
        url,
        source: new URL(url).hostname.replace(/^www\./i, ''),
        lens: 'web',
      };
      const snippet = snippetOf(block);
      if (snippet && snippet !== item.title) item.snippet = snippet;
      items.push(item);
      if (items.length >= MAX_ITEMS) break;
    }
    return items;
  } catch {
    return [];
  }
}

// fetchTopic(query) → Item[] (without id/topic/seenAt); [] when the search is
// genuinely empty, null when the fetch itself failed (offline, HTTP error, or
// markup that no longer parses — all of which mean "no answer", not "silence").
//
// Under load DuckDuckGo answers 200-range with a JavaScript holding page and
// no results in it. That is a rate limit wearing a hat: retry once, then stop
// asking for a while rather than spending the rest of the sweep on it.
let nextSlot = 0;
let cooldownUntil = 0;

// Claim the next slot before yielding, so two angles sweeping at once queue up
// behind each other instead of both deciding the coast is clear.
async function search(url) {
  const at = Math.max(Date.now(), nextSlot);
  nextSlot = at + MIN_GAP;
  const wait = at - Date.now();
  if (wait > 0) await sleep(wait);
  return fetchText(url, {
    timeoutMs: 12000,
    headers: { accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5' },
  });
}

export async function fetchTopic(query) {
  try {
    const q = String(query ?? '').trim();
    if (!q) return [];
    if (Date.now() < cooldownUntil) return null;
    const url = ENDPOINT + '?q=' + encodeURIComponent(q) + '&kl=us-en';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const html = await search(url);
      if (!html) break; // transport already retried; take the hint
      const items = parseResults(html);
      if (items.length) return items;
      if (/\bno results\b|not many great matches/i.test(html)) return [];
    }
    cooldownUntil = Date.now() + COOLDOWN_MS;
    return null;
  } catch {
    return null;
  }
}
