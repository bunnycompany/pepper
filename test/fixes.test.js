// Regression tests for the adversarial-review fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.PEPPER_HOME = mkdtempSync(join(tmpdir(), 'pepper-fixes-'));

const store = await import('../src/store.js');
const { buildDigest } = await import('../src/research.js');
const { parseFeed } = await import('../src/sources/rss.js');

test('slugify keeps non-Latin scripts distinct', () => {
  const jp = store.slugify('日本語');
  const kr = store.slugify('한국어');
  assert.notEqual(jp, kr);
  assert.notEqual(jp, 'topic');
});

test('slugify never leaves a trailing hyphen after the length cap', () => {
  const s = store.slugify('state space models and linear attention hybrids research');
  assert.ok(!s.endsWith('-'), s);
  assert.equal(s, store.slugify(s));
});

test('slugify gives emoji-only names a unique stable fallback', () => {
  const a = store.slugify('🌶🌶🌶');
  const b = store.slugify('!!!');
  assert.notEqual(a, b);
  assert.equal(a, store.slugify('🌶🌶🌶'));
});

test('appendItems keeps distinct CJK titles', () => {
  const fresh = store.appendItems('jp-beat', [
    { title: 'OpenAIが新型モデルを発表、推論性能が大幅向上', url: 'https://ex.jp/1', source: 'X', lens: 'news' },
    { title: 'OpenAIの利用規約変更、日本企業に波紋', url: 'https://ex.jp/2', source: 'X', lens: 'news' },
  ]);
  assert.equal(fresh.length, 2);
});

test('appendItems repairs a crash-truncated last line', () => {
  store.appendItems('trunc-beat', [
    { title: 'Complete story', url: 'https://ex.com/1', source: 'X', lens: 'news' },
  ]);
  const f = join(process.env.PEPPER_HOME, 'items', 'trunc-beat.jsonl');
  writeFileSync(f, readFileSync(f, 'utf8').trimEnd() + '\n{"id":"bbb","title":"Trunca');
  const fresh = store.appendItems('trunc-beat', [
    { title: 'Brand new story one', url: 'https://ex.com/2', source: 'X', lens: 'news' },
    { title: 'Brand new story two', url: 'https://ex.com/3', source: 'X', lens: 'news' },
  ]);
  assert.equal(fresh.length, 2);
  const titles = store.recentItems('trunc-beat', 10).map((i) => i.title);
  assert.ok(titles.includes('Brand new story one'));
  assert.ok(titles.includes('Brand new story two'));
  assert.ok(titles.includes('Complete story'));
});

test('buildDigest clamps an absurd topic name in the header', () => {
  const d = buildDigest('X'.repeat(5000), [
    { title: 'A story', url: 'https://ex.com/s', source: 'Wire', lens: 'news' },
  ]);
  assert.ok(d.length <= 2400, String(d.length));
  assert.ok(d.includes('A story'));
});

test('decodeEntities ignores Object.prototype member names', () => {
  const xml = `<rss><channel><item><title>Understanding &toString; and &hasOwnProperty; here</title>
    <link>https://ex.com/e</link></item></channel></rss>`;
  const [item] = parseFeed(xml);
  assert.ok(!item.title.includes('native code'), item.title);
  assert.ok(item.title.includes('&toString;'), item.title);
});

// ---- operability fixes (found by running her headless on Linux) ----

// Google News sometimes fills the <source> tag with the publisher's URL rather
// than its name; read aloud that was "per https://tech-insider.org/".
test('news lens reads a URL-shaped publisher as its hostname', async () => {
  const { fetchTopic } = await import('../src/sources/news.js');
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title>Vercel vs Netlify vs Cloudflare Pages - https://tech-insider.org/</title>
  <link>https://news.google.com/rss/articles/one</link>
  <source url="https://tech-insider.org">https://tech-insider.org/</source></item>
<item><title>Premiums climb again - TechCrunch</title>
  <link>https://news.google.com/rss/articles/two</link>
  <source url="https://techcrunch.com">TechCrunch</source></item>
<item><title>No source tag here - www.example.co.uk</title>
  <link>https://news.google.com/rss/articles/three</link></item>
</channel></rss>`;
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(rss, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  try {
    const items = await fetchTopic('cloudflare pages');
    assert.equal(items.length, 3);
    assert.equal(items[0].source, 'tech-insider.org');
    assert.equal(items[0].title, 'Vercel vs Netlify vs Cloudflare Pages');
    assert.equal(items[1].source, 'TechCrunch');
    assert.equal(items[2].source, 'www.example.co.uk');
  } finally {
    globalThis.fetch = real;
  }
});

// When Firecrawl rate-limits, the arXiv fallback throttles itself with a
// sleep. If that timer is unref'd and nothing else is pending, a one-shot
// `pepper now` exits 0 mid-sweep with no bulletin. The sleep must hold the
// event loop open, so this runs in a child process where nothing else does.
test('arXiv throttle keeps a one-shot process alive until the fallback answers', () => {
  const arxivUrl = new URL('../src/sources/arxiv.js', import.meta.url).href;
  const script = `
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Paper</title>'
      + '<id>http://arxiv.org/abs/1.1</id><link href="http://arxiv.org/abs/1.1"/>'
      + '<published>2026-10-20T00:00:00Z</published><summary>s</summary></entry></feed>';
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://api.firecrawl.dev/')) return new Response('rate limited', { status: 429 });
      if (u.startsWith('https://export.arxiv.org/')) return new Response(atom, { status: 200 });
      return new Response('', { status: 404 });
    };
    const { fetchTopic } = await import(${JSON.stringify(arxivUrl)});
    const a = await fetchTopic('first query');
    const b = await fetchTopic('second query'); // inside the 3.5s throttle window
    console.log(Array.isArray(a) && Array.isArray(b) ? 'BOTH ANSWERED' : 'BAD ' + a + ' ' + b);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BOTH ANSWERED/,
    `child exited before the throttled fallback resolved\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
});
