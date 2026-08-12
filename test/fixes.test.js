// Regression tests for the adversarial-review fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
