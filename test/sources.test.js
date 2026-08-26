// Offline tests for the article reader (src/fetchx.js) and the web lens
// (src/sources/web.js). No network: every test either works on fixture HTML
// or drives a stubbed global fetch.
import test from 'node:test';
import assert from 'node:assert/strict';

const { extractArticle, fetchArticle, fetchArticles } = await import('../src/fetchx.js');
const web = await import('../src/sources/web.js');

// Run `fn` with global fetch replaced, restoring it afterwards.
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const html = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const page = (text) => new Response(html(`<article><p>${text}</p></article>`), {
  headers: { 'content-type': 'text/html; charset=utf-8' },
});

// ---- HTML → readable text ----

const PAGE = `<!doctype html>
<html lang="en"><head>
<title>Insurance markets in 2026 &mdash; Example Wire</title>
<meta property="og:title" content="Premiums climb again in 2026">
<style>.hide{display:none}</style>
<script>window.__DATA__ = {tracker:"should not appear"};</script>
</head>
<body>
<header><h1>Example Wire</h1><p>Sign in</p></header>
<nav><ul><li><a href="/">Home</a></li><li><a href="/markets">Markets</a></li></ul></nav>
<script>document.write('<p>injected junk</p>');</script>
<div class="page">
  <div class="rail"><ul><li><a href="/a">Most popular</a></li><li><a href="/b">Newsletters</a></li><li><a href="/c">Trending now</a></li></ul></div>
  <article class="story">
    <p>Home &#8250; Markets &#8250; Insurance</p>
    <p>We use cookies to improve your experience.</p>
    <p>Subscribe now to keep reading.</p>
    <p>Premiums rose 12&nbsp;percent in 2026, the regulator&#8217;s filing shows &amp; brokers expect another increase before the year is out.</p>
    <p>The rise concentrates in coastal states, where reinsurance costs climbed fastest after two consecutive loss years &mdash; a pattern the filing traces back to 2023.</p>
  </article>
</div>
<aside><p>Related stories you might like</p></aside>
<footer><p>&copy; 2026 Example Wire. All rights reserved.</p></footer>
</body></html>`;

test('extractArticle keeps the article and drops the furniture', () => {
  const { title, text } = extractArticle(PAGE);
  assert.equal(title, 'Premiums climb again in 2026');
  assert.match(text, /Premiums rose 12 percent in 2026/);
  assert.match(text, /coastal states/);
  for (const junk of ['should not appear', 'injected junk', 'Most popular', 'Newsletters',
    'Sign in', 'Example Wire', 'Related stories', 'All rights reserved', 'display:none']) {
    assert.ok(!text.includes(junk), `leaked ${junk}: ${text}`);
  }
  assert.ok(!/[<>]/.test(text), text);
});

test('extractArticle decodes entities in title and body', () => {
  const { text } = extractArticle(PAGE);
  assert.match(text, /regulator’s filing shows & brokers/);
  assert.match(text, /loss years — a pattern/);
  assert.ok(!/&(amp|nbsp|mdash|#\d+);/.test(text), text);
  const { title } = extractArticle(PAGE.replace(/<meta[^>]*>/, ''));
  assert.equal(title, 'Insurance markets in 2026 — Example Wire');
});

test('extractArticle filters boilerplate lines inside the article', () => {
  const sentence = 'The bill cleared committee on a 12 to 9 vote, with two members absent, and now '
    + 'moves to the floor, where leadership has promised a vote before the recess begins.';
  const { text } = extractArticle(`<article>
    <p>Accept all cookies</p>
    <p>Cookie preferences</p>
    <p>Home &#8250; Politics &#8250; Congress</p>
    <p>Subscribe today for unlimited access</p>
    <p>Advertisement</p>
    <p>5 min read</p>
    <p>Share</p>
    <p>${sentence}</p>
    <p>&copy; 2026 The Example Post. All rights reserved.</p>
  </article>`);
  assert.equal(text, sentence);
});

test('extractArticle prefers the densest block over its wrapper', () => {
  const { text } = extractArticle(`<div id="shell">
    <div class="promo"><a href="/1">Read our full guide to the 2026 open enrollment window</a>
      <a href="/2">Compare marketplace plans in every state today</a>
      <a href="/3">See how subsidies changed after the reconciliation bill</a></div>
    <div class="body">
      <p>The uninsured rate fell to 7.6 percent in 2026, the lowest on record, according to the survey the bureau published this month.</p>
      <p>Coverage gains concentrated among adults aged 26 to 34, the group most exposed to the expiry of pandemic-era continuous enrollment rules.</p>
      <p>State-level detail remains uneven, and three states did not report at all, which the bureau flags as a limit on the national estimate.</p>
    </div>
  </div>`);
  assert.match(text, /uninsured rate fell to 7\.6 percent/);
  assert.ok(!text.includes('open enrollment window'), text);
});

test('extractArticle clips to maxChars on a word boundary', () => {
  const long = 'Marketplace enrollment climbed again this year. '.repeat(60);
  const { text } = extractArticle(`<article><p>${long}</p></article>`, { maxChars: 200 });
  assert.ok(text.length <= 200, String(text.length));
  assert.ok(text.length > 150, String(text.length));
  assert.ok(!/\s$/.test(text), JSON.stringify(text.slice(-12)));
});

test('extractArticle survives junk input', () => {
  assert.deepEqual(extractArticle(''), { title: '', text: '' });
  assert.deepEqual(extractArticle(null), { title: '', text: '' });
  assert.deepEqual(extractArticle('<div><span>unclosed'), { title: '', text: '' });
});

// ---- fetchArticle ----

test('fetchArticle reads a page it can parse', async () => {
  await withFetch(async () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }), async () => {
    const r = await fetchArticle('https://example.com/story');
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://example.com/story');
    assert.equal(r.title, 'Premiums climb again in 2026');
    assert.match(r.text, /Premiums rose 12 percent/);
  });
});

test('fetchArticle bails on non-HTML, oversized and failed responses', async () => {
  const cases = [
    ['pdf', new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } })],
    ['declared size', new Response('<html><body><p>x</p></body></html>', {
      headers: { 'content-type': 'text/html', 'content-length': String(9 * 1024 * 1024) },
    })],
    ['streamed size', new Response(html('<article><p>' + 'x'.repeat(3 * 1024 * 1024) + '</p></article>'), {
      headers: { 'content-type': 'text/html' },
    })],
    ['http error', new Response('nope', { status: 503, headers: { 'content-type': 'text/html' } })],
    ['thin page', page('too short to be an article')],
  ];
  for (const [label, res] of cases) {
    await withFetch(async () => res, async () => {
      const r = await fetchArticle('https://example.com/' + label.replace(/\s/g, '-'));
      assert.equal(r.ok, false, label);
      assert.equal(r.text, '', label);
      assert.equal(typeof r.url, 'string', label);
    });
  }
});

test('fetchArticle rejects non-http URLs without touching the network', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return page('x'); }, async () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<p>hi</p>', 'not a url', '']) {
      const r = await fetchArticle(bad);
      assert.equal(r.ok, false, bad);
    }
  });
  assert.equal(calls, 0);
});

test('fetchArticle survives a network error', async () => {
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    const r = await fetchArticle('https://example.com/down');
    assert.deepEqual(r, { url: 'https://example.com/down', title: '', text: '', ok: false });
  });
});

// ---- fetchArticles ----

const BODY = 'Enrollment in the marketplace plans rose across every reporting state this year, '
  + 'with the largest gains in the south, where three states expanded eligibility for the first '
  + 'time since the program began, according to the filing published this week by the regulator.';

test('fetchArticles keeps input order, dedupes, and caps the batch', async () => {
  const seen = [];
  await withFetch(async (url) => { seen.push(url); return page(BODY); }, async () => {
    const urls = ['https://a.example/1', 'https://b.example/2', 'https://a.example/1', 'https://c.example/3'];
    const out = await fetchArticles(urls, { perHostGap: 0 });
    assert.equal(out.length, 4);
    assert.deepEqual(out.map((r) => r.url), urls);
    assert.ok(out.every((r) => r.ok));
    assert.equal(seen.length, 3, seen.join(','));

    const mixed = await fetchArticles(['https://a.example/9', 'not a url', ''], { perHostGap: 0 });
    assert.equal(mixed.length, 3, 'one result per URL, junk included');
    assert.deepEqual(mixed.map((r) => r.ok), [true, false, false]);
    assert.equal(mixed[1].url, 'not a url');

    const many = Array.from({ length: 8 }, (_, i) => `https://d.example/${i}`);
    const capped = await fetchArticles(many, { perHostGap: 0, max: 3 });
    assert.equal(capped.length, 3);
  });
  assert.deepEqual(await fetchArticles([]), []);
  assert.deepEqual(await fetchArticles(null), []);
});

test('fetchArticles never hits one host twice at a time', async () => {
  const live = new Map();
  const peak = new Map();
  const handler = async (url) => {
    const host = new URL(url).host;
    const n = (live.get(host) || 0) + 1;
    live.set(host, n);
    peak.set(host, Math.max(peak.get(host) || 0, n));
    await new Promise((r) => setTimeout(r, 5));
    live.set(host, live.get(host) - 1);
    return page(BODY);
  };
  await withFetch(handler, async () => {
    const urls = ['https://one.example/a', 'https://one.example/b', 'https://one.example/c',
      'https://two.example/a', 'https://two.example/b'];
    const out = await fetchArticles(urls, { concurrency: 5, perHostGap: 0 });
    assert.equal(out.length, 5);
    assert.equal(peak.get('one.example'), 1);
    assert.equal(peak.get('two.example'), 1);
  });
});

test('fetchArticles spaces repeat requests to the same host', async () => {
  const at = [];
  await withFetch(async () => { at.push(Date.now()); return page(BODY); }, async () => {
    await fetchArticles(['https://slow.example/1', 'https://slow.example/2'], { perHostGap: 60 });
  });
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 55, String(at[1] - at[0]));
});

// ---- the web lens ----

const DDG = `<div class="serp__results">
<div class="result result--ad result--ad--small">
  <div class="links_main"><h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=bingv7aa&amp;u3=https%3A%2F%2Fads.example%2Fbuy">Compare insurance quotes now</a></h2>
    <a class="result__snippet" href="#">Sponsored offer from an advertiser.</a></div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.census.gov%2Freports%2Fhealth%2D2026.html&amp;rut=9f1c">Health coverage &amp; the 2026 <b>census</b> report</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.census.gov%2F">The uninsured rate fell to 7.6&nbsp;percent, the <b>Census Bureau</b> said.</a>
    <div class="result__extras"><div class="result__extras__url">
      <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.census.gov%2F">census.gov</a></div></div>
  </div>
</div>
<div class="result results_links">
  <div class="links_main"><h2 class="result__title">
    <a class="result__a" href="https://www.kff.org/report/2026-employer-survey/">KFF 2026 Employer Health Benefits Survey</a></h2>
    <div class="result__snippet">Average family premium reached 26,000 dollars.</div></div>
</div>
<div class="result results_links">
  <div class="links_main"><h2 class="result__title">
    <a class="result__a" href="https://duckduckgo.com/?q=settings">DuckDuckGo settings</a></h2></div>
</div>
</div>`;

test('parseResults unwraps DDG redirects and drops ads', () => {
  const items = web.parseResults(DDG);
  assert.equal(items.length, 2);
  const [a, b] = items;
  assert.equal(a.url, 'https://www.census.gov/reports/health-2026.html');
  assert.equal(a.title, 'Health coverage & the 2026 census report');
  assert.equal(a.source, 'census.gov');
  assert.equal(a.lens, 'web');
  assert.equal(a.snippet, 'The uninsured rate fell to 7.6 percent, the Census Bureau said.');
  assert.equal(b.url, 'https://www.kff.org/report/2026-employer-survey/');
  assert.equal(b.source, 'kff.org');
  assert.equal(b.snippet, 'Average family premium reached 26,000 dollars.');
  for (const it of items) assert.ok(!/duckduckgo\.com/i.test(it.url), it.url);
});

test('parseResults caps at ten results and skips duplicates', () => {
  const one = (i) => `<div class="result results_links"><h2 class="result__title">
    <a class="result__a" href="https://site${i}.example/page">Result number ${i}</a></h2></div>`;
  const dupe = `<div class="result results_links"><h2 class="result__title">
    <a class="result__a" href="https://site1.example/page">Result number 1 again</a></h2></div>`;
  const items = web.parseResults(Array.from({ length: 14 }, (_, i) => one(i)).join('') + dupe);
  assert.equal(items.length, 10);
  assert.equal(new Set(items.map((i) => i.url)).size, 10);
});

test('parseResults returns [] on markup it cannot read', () => {
  assert.deepEqual(web.parseResults('<html><body>No results.</body></html>'), []);
  assert.deepEqual(web.parseResults(''), []);
  assert.deepEqual(web.parseResults(null), []);
});

// The lens keeps a module-level stand-down after DuckDuckGo pushes back, so
// every test below that trips it gets its own instance of the module.
let instances = 0;
const freshLens = () => import(`../src/sources/web.js?t=${++instances}`);

test('web.fetchTopic returns parsed items', async () => {
  const lens = await freshLens();
  await withFetch(async () => new Response(DDG, { headers: { 'content-type': 'text/html' } }), async () => {
    const items = await lens.fetchTopic('uninsured rate 2026');
    assert.equal(items.length, 2);
    assert.equal(items[0].lens, 'web');
    assert.equal(items[0].source, 'census.gov');
  });
  assert.deepEqual(await lens.fetchTopic(''), []);
});

test('web.fetchTopic returns [] when the wire is genuinely quiet', async () => {
  const lens = await freshLens();
  await withFetch(async () => new Response('<html><body><p>No results.</p></body></html>'), async () => {
    assert.deepEqual(await lens.fetchTopic('asdkjhasdkjhasd'), []);
  });
});

test('web.fetchTopic stands down when DuckDuckGo serves a holding page', async () => {
  const lens = await freshLens();
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response('<html><body><h1>DuckDuckGo</h1></body></html>', { status: 202 });
  }, async () => {
    assert.equal(await lens.fetchTopic('insurance markets'), null);
    assert.equal(calls, 2, 'one retry, then take the hint');
    assert.equal(await lens.fetchTopic('a second angle'), null);
    assert.equal(calls, 2, 'cooling down: no further requests');
  });
});

test('web.fetchTopic returns null on an HTTP error and when offline', async () => {
  const limited = await freshLens();
  await withFetch(async () => new Response('nope', { status: 429 }), async () => {
    assert.equal(await limited.fetchTopic('anything'), null);
  });
  const offline = await freshLens();
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.equal(await offline.fetchTopic('insurance markets'), null);
  });
});
