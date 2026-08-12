import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set BEFORE importing store/config so paths resolve into a fresh dir.
process.env.PEPPER_HOME = mkdtempSync(join(tmpdir(), 'pepper-test-'));

const { parseFeed } = await import('../src/sources/rss.js');
const store = await import('../src/store.js');
const { buildDigest, runCycle } = await import('../src/research.js');

// ---- parseFeed: RSS2 (CDATA + entities + Google News <source> tag) ----

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Search results</title>
<link>https://news.google.com</link>
<item>
  <title><![CDATA[Apple &amp; the AI race: what&#39;s next - TechCrunch]]></title>
  <link>https://news.google.com/rss/articles/abc123</link>
  <guid isPermaLink="false">abc123</guid>
  <pubDate>Tue, 11 Aug 2026 14:00:00 GMT</pubDate>
  <description>&lt;a href="https://example.com"&gt;Apple &amp;amp; the AI race&lt;/a&gt;</description>
  <source url="https://techcrunch.com">TechCrunch</source>
</item>
<item>
  <title>Model context windows &#x2019;explode&#x2019; past &quot;1M&quot; tokens - The Verge</title>
  <link>https://news.google.com/rss/articles/def456</link>
  <pubDate>not a real date</pubDate>
</item>
</channel></rss>`;

test('parseFeed: RSS2 with CDATA, entities, Google News source tag', () => {
  const out = parseFeed(RSS2);
  assert.equal(out.length, 2);

  const [a, b] = out;
  assert.equal(a.title, "Apple & the AI race: what's next - TechCrunch");
  assert.equal(a.url, 'https://news.google.com/rss/articles/abc123');
  assert.equal(a.source, 'TechCrunch');
  assert.equal(a.publishedAt, '2026-08-11T14:00:00.000Z');
  assert.equal(a.snippet, 'Apple & the AI race');

  assert.equal(b.title, 'Model context windows ’explode’ past "1M" tokens - The Verge');
  assert.equal(b.url, 'https://news.google.com/rss/articles/def456');
  assert.equal(b.source, '');
  assert.equal(b.publishedAt, null);
});

// ---- parseFeed: Atom (link href + arXiv-style multiline title) ----

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: search_query=all:"llm"</title>
  <link href="http://export.arxiv.org/api/query" rel="self"/>
  <entry>
    <id>http://arxiv.org/abs/2608.01234v1</id>
    <updated>2026-08-11T09:00:00Z</updated>
    <published>2026-08-10T17:59:59Z</published>
    <title>Chain-of-Thought Distillation for
  Small On-Device Language Models</title>
    <summary>  We study distillation of reasoning traces into small models.
  Second line of the abstract.
</summary>
    <author><name>Jane Doe</name></author>
    <link href="http://arxiv.org/abs/2608.01234v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2608.01234v1" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

test('parseFeed: Atom with link href and multiline arXiv title', () => {
  const out = parseFeed(ATOM);
  assert.equal(out.length, 1);
  const [e] = out;
  assert.equal(e.title, 'Chain-of-Thought Distillation for Small On-Device Language Models');
  assert.equal(e.url, 'http://arxiv.org/abs/2608.01234v1'); // rel=alternate preferred
  assert.equal(e.publishedAt, '2026-08-10T17:59:59.000Z');
  assert.equal(e.snippet, 'We study distillation of reasoning traces into small models. Second line of the abstract.');
});

test('parseFeed: never throws on garbage', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed(null), []);
  assert.deepEqual(parseFeed('<<<not xml at all >>> <item><title>'), []);
});

// ---- store.appendItems dedupe ----

test('appendItems: dedupes same URL and same normalized title', () => {
  const slug = 'dedupe-beat';
  const first = store.appendItems(slug, [
    { title: 'OpenAI Ships GPT-6', url: 'https://example.com/a', source: 'X', lens: 'news', publishedAt: null },
  ]);
  assert.equal(first.length, 1);
  assert.ok(first[0].id);
  assert.equal(first[0].topic, slug);
  assert.ok(first[0].seenAt);

  // Same URL again (different title) → dropped; genuinely new one kept.
  const second = store.appendItems(slug, [
    { title: 'A totally different headline', url: 'https://example.com/a', source: 'X', lens: 'news', publishedAt: null },
    { title: 'Fresh unrelated story', url: 'https://example.com/b', source: 'Y', lens: 'news', publishedAt: null },
  ]);
  assert.equal(second.length, 1);
  assert.equal(second[0].title, 'Fresh unrelated story');

  // Same normalized title (punctuation/case differ), different URL → dropped.
  const third = store.appendItems(slug, [
    { title: 'openai ships GPT 6!!!', url: 'https://example.com/c', source: 'Z', lens: 'hn', publishedAt: null },
  ]);
  assert.equal(third.length, 0);

  // Duplicate within a single call → only one survives.
  const fourth = store.appendItems(slug, [
    { title: 'Solo story', url: 'https://example.com/d', source: 'X', lens: 'news', publishedAt: null },
    { title: 'Solo story', url: 'https://example.com/d', source: 'X', lens: 'news', publishedAt: null },
  ]);
  assert.equal(fourth.length, 1);
});

// ---- buildDigest ----

test('buildDigest: line formats per lens', () => {
  const threeHoursAgo = new Date(Date.now() - 3 * 3600e3 - 30e3).toISOString();
  const d = buildDigest('AI hardware', [
    { title: 'Apple ships M5', url: 'u1', source: 'TechCrunch', lens: 'news', publishedAt: threeHoursAgo },
    { title: 'No-date story', url: 'u2', source: 'Reuters', lens: 'news', publishedAt: null },
    { title: 'Show HN: tiny LLM on a toaster', url: 'u3', source: 'Hacker News', lens: 'hn', points: 214 },
    { title: 'A Paper Title', url: 'u4', source: 'arXiv', lens: 'arxiv', snippet: 'Y'.repeat(300) },
  ]);
  const lines = d.split('\n');
  assert.equal(lines[0], 'Wire notes — AI hardware:');
  assert.ok(d.includes('- [News] Apple ships M5 (TechCrunch, 3h ago)'));
  assert.ok(d.includes('- [News] No-date story (Reuters)'));
  assert.ok(d.includes('- [HN 214pts] Show HN: tiny LLM on a toaster'));
  const arx = lines.find((l) => l.startsWith('- [arXiv]'));
  assert.ok(arx.includes('A Paper Title — ' + 'Y'.repeat(140)));
  assert.ok(!arx.includes('Y'.repeat(141))); // abstract clipped to 140 chars
});

test('buildDigest: capped at 2400 chars', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    title: `Story ${i} ` + 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(3),
    url: 'https://example.com/' + i,
    source: 'Wire',
    lens: 'news',
    publishedAt: null,
  }));
  const d = buildDigest('Firehose', many);
  assert.ok(d.length <= 2400, `digest too long: ${d.length}`);
  assert.ok(d.split('\n').length > 5, 'digest should still contain several lines');
});

// ---- runCycle: quiet path (offline, no topics) ----

test('runCycle: quiet when no topics', async () => {
  const events = [];
  const result = await runCycle({ emit: (type, data) => events.push([type, data]) });
  assert.deepEqual(result, { quiet: true, reason: 'no topics' });
  assert.deepEqual(events, []);
});
