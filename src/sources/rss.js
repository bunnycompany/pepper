// Tolerant, dependency-free RSS 2.0 / Atom feed parser.
// Best effort on malformed XML — never throws.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', middot: '\u00b7', bull: '\u2022',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', times: '\u00d7',
  eacute: '\u00e9', egrave: '\u00e8', agrave: '\u00e0', ccedil: '\u00e7',
  auml: '\u00e4', ouml: '\u00f6', uuml: '\u00fc', ntilde: '\u00f1',
};

function fromCodePoint(n) {
  try {
    if (!Number.isFinite(n) || n < 1 || n > 0x10ffff) return '';
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      const hit = Object.hasOwn(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : (Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()) ? NAMED_ENTITIES[name.toLowerCase()] : undefined);
      return hit !== undefined ? hit : m;
    });
}

export function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, ' ');
}

export function collapseWs(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function unwrapCdata(s) {
  return String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// Plain text field (titles, sources, dates, text links).
function textOf(raw) {
  return collapseWs(decodeEntities(unwrapCdata(raw)));
}

// Description-style field: may contain raw or entity-escaped HTML.
// Decode, strip markup, decode again (feeds double-encode a lot), collapse.
function htmlTextOf(raw) {
  return collapseWs(decodeEntities(stripTags(decodeEntities(unwrapCdata(raw)))));
}

// Inner content of the first <tag ...>...</tag> in chunk ('' when absent).
function inner(chunk, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'i');
  const m = chunk.match(re);
  return m ? m[1] : '';
}

// All <tag>...</tag> blocks in the document.
function blocks(xml, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function attrOf(tag, name) {
  const m = String(tag).match(new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : '';
}

function linkOf(chunk) {
  // RSS2 style: <link>https://...</link> (opening tag has no href attribute)
  const rss = chunk.match(/<link(?![^>]*\bhref)[^>]*>([\s\S]*?)<\/link\s*>/i);
  if (rss) {
    const u = textOf(rss[1]);
    if (u) return u;
  }
  // Atom style: <link href="..." rel="alternate"/> — prefer rel=alternate,
  // then a link with no rel, then any link with an href.
  const tags = chunk.match(/<link\b[^>]*>/gi) || [];
  let alternate = '';
  let bare = '';
  let any = '';
  for (const t of tags) {
    const href = attrOf(t, 'href');
    if (!href) continue;
    const rel = attrOf(t, 'rel').toLowerCase();
    if (rel === 'alternate' && !alternate) alternate = href;
    if (!rel && !bare) bare = href;
    if (!any) any = href;
  }
  return alternate || bare || any || '';
}

function toIso(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// parseFeed(xml) → [{ title, url, source, publishedAt, snippet }]
// Handles <item> (RSS2) and <entry> (Atom), CDATA, named + numeric entities,
// Atom <link href>, RSS <link>, pubDate/published/updated, the Google News
// <source> tag, strips tags from descriptions, collapses whitespace.
export function parseFeed(xml) {
  try {
    const src = String(xml ?? '');
    let chunks = blocks(src, 'item');
    if (!chunks.length) chunks = blocks(src, 'entry');
    const out = [];
    for (const chunk of chunks) {
      try {
        const title = textOf(inner(chunk, 'title'));
        const url = linkOf(chunk);
        if (!title && !url) continue;
        const source = textOf(inner(chunk, 'source'));
        const dateRaw = inner(chunk, 'pubDate') || inner(chunk, 'published')
          || inner(chunk, 'updated') || inner(chunk, 'dc:date');
        const publishedAt = toIso(textOf(dateRaw));
        const descRaw = inner(chunk, 'description') || inner(chunk, 'summary')
          || inner(chunk, 'content:encoded') || inner(chunk, 'content');
        const snippet = htmlTextOf(descRaw);
        out.push({ title, url, source, publishedAt, snippet });
      } catch {
        // skip malformed entry, keep the rest
      }
    }
    return out;
  } catch {
    return [];
  }
}
