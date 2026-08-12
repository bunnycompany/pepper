// Offline tests for the brain module's pure JS helpers.
// No network, no sidecar, no ~/.pepper writes.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOODS,
  stripFences,
  extractJSON,
  validateSegment,
  validateAnchor,
  anchorContext,
  localChatUrl,
  segmentPrompt,
} from '../src/brain/index.js';

// ---- stripFences ----

test('stripFences passes plain text through', () => {
  assert.equal(stripFences('The wire is quiet.'), 'The wire is quiet.');
});

test('stripFences trims whitespace', () => {
  assert.equal(stripFences('  hello \n'), 'hello');
});

test('stripFences unwraps a ```json fence', () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
});

test('stripFences unwraps a bare ``` fence', () => {
  assert.equal(stripFences('```\ntext line\n```'), 'text line');
});

test('stripFences handles an unterminated fence', () => {
  assert.equal(stripFences('```json\n{"a":1}'), '{"a":1}');
});

test('stripFences leaves mid-prose fences alone', () => {
  const t = 'Here it is: ```json\n{"a":1}\n``` done';
  assert.equal(stripFences(t), t);
});

test('stripFences returns empty string for non-strings', () => {
  assert.equal(stripFences(null), '');
  assert.equal(stripFences(42), '');
  assert.equal(stripFences(undefined), '');
});

// ---- extractJSON ----

test('extractJSON parses bare JSON', () => {
  assert.deepEqual(extractJSON('{"headline":"x","mood":"steady"}'), {
    headline: 'x',
    mood: 'steady',
  });
});

test('extractJSON parses a fenced block with prose around it', () => {
  const reply = 'Sure! Here is the segment:\n```json\n'
    + '{"headline":"GPUs move","script":["Line one.","Line two."],"mood":"developing"}\n'
    + '```\nHope that helps!';
  assert.deepEqual(extractJSON(reply), {
    headline: 'GPUs move',
    script: ['Line one.', 'Line two.'],
    mood: 'developing',
  });
});

test('extractJSON parses an unterminated fence', () => {
  assert.deepEqual(extractJSON('```json\n{"open":"Hi","signoff":"Bye"}'), {
    open: 'Hi',
    signoff: 'Bye',
  });
});

test('extractJSON digs an object out of prose', () => {
  assert.deepEqual(extractJSON('The answer is {"a": 1} — enjoy.'), { a: 1 });
});

test('extractJSON survives braces inside strings', () => {
  const reply = 'ok {"headline":"The {big} story","script":["a"],"mood":"steady"} trailing';
  assert.deepEqual(extractJSON(reply), {
    headline: 'The {big} story',
    script: ['a'],
    mood: 'steady',
  });
});

test('extractJSON survives escaped quotes inside strings', () => {
  const reply = '{"headline":"She said \\"go\\"","script":["a"],"mood":"quirky"}';
  assert.equal(extractJSON(reply).headline, 'She said "go"');
});

test('extractJSON handles nested objects', () => {
  assert.deepEqual(extractJSON('x {"a":{"b":{"c":3}}} y'), { a: { b: { c: 3 } } });
});

test('extractJSON returns null on garbage', () => {
  assert.equal(extractJSON('no json here at all'), null);
  assert.equal(extractJSON('{broken: json'), null);
  assert.equal(extractJSON(''), null);
  assert.equal(extractJSON(null), null);
  assert.equal(extractJSON('   '), null);
});

// ---- validateSegment ----

test('validateSegment accepts a clean segment', () => {
  assert.deepEqual(
    validateSegment({ headline: 'Llama 4 lands', script: ['A.', 'B.', 'C.'], mood: 'developing' }),
    { headline: 'Llama 4 lands', script: ['A.', 'B.', 'C.'], mood: 'developing' },
  );
});

test('validateSegment strips trailing periods from the headline', () => {
  assert.equal(
    validateSegment({ headline: 'Big news.', script: ['A.'], mood: 'steady' }).headline,
    'Big news',
  );
});

test('validateSegment normalizes mood case and defaults bad moods to steady', () => {
  assert.equal(validateSegment({ headline: 'H', script: ['A'], mood: 'BREAKING' }).mood, 'breaking');
  assert.equal(validateSegment({ headline: 'H', script: ['A'], mood: 'excited' }).mood, 'steady');
  assert.equal(validateSegment({ headline: 'H', script: ['A'] }).mood, 'steady');
});

test('validateSegment wraps a string script into an array', () => {
  assert.deepEqual(
    validateSegment({ headline: 'H', script: 'One line.', mood: 'steady' }).script,
    ['One line.'],
  );
});

test('validateSegment filters junk lines and caps the script at 6', () => {
  const script = ['a', '', null, 'b', '  ', 'c', 'd', 'e', 'f', 'g'];
  const v = validateSegment({ headline: 'H', script, mood: 'steady' });
  assert.deepEqual(v.script, ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('validateSegment rejects missing pieces', () => {
  assert.equal(validateSegment(null), null);
  assert.equal(validateSegment('nope'), null);
  assert.equal(validateSegment(['array']), null);
  assert.equal(validateSegment({ script: ['A'], mood: 'steady' }), null);
  assert.equal(validateSegment({ headline: '  ', script: ['A'], mood: 'steady' }), null);
  assert.equal(validateSegment({ headline: 'H', script: [], mood: 'steady' }), null);
  assert.equal(validateSegment({ headline: 'H', script: [''], mood: 'steady' }), null);
});

// ---- validateAnchor ----

test('validateAnchor accepts and trims open/signoff', () => {
  assert.deepEqual(
    validateAnchor({ open: ' Good evening. ', signoff: 'That is the sweep. ' }),
    { open: 'Good evening.', signoff: 'That is the sweep.' },
  );
});

test('validateAnchor rejects incomplete anchors', () => {
  assert.equal(validateAnchor(null), null);
  assert.equal(validateAnchor({ open: 'Hi' }), null);
  assert.equal(validateAnchor({ open: '', signoff: 'Bye' }), null);
  assert.equal(validateAnchor({ open: 'Hi', signoff: 42 }), null);
});

// ---- anchorContext ----

test('anchorContext matches the contract example shape', () => {
  assert.equal(
    anchorContext({ tod: 'evening', n: 3, topics: ['a', 'b'], busy: true }),
    'evening; 3 stories across beats: a, b; busy',
  );
});

test('anchorContext singularizes one story and marks calm', () => {
  assert.equal(
    anchorContext({ tod: 'morning', n: 1, topics: ['llms'], busy: false }),
    'morning; 1 story across beats: llms; calm',
  );
});

test('anchorContext survives an empty context', () => {
  assert.equal(anchorContext(), 'day; 0 stories across beats: the wire; calm');
});

// ---- localChatUrl ----

test('localChatUrl appends the full path to a bare origin', () => {
  assert.equal(localChatUrl('http://localhost:11434'), 'http://localhost:11434/v1/chat/completions');
});

test('localChatUrl tolerates trailing slashes', () => {
  assert.equal(localChatUrl('http://localhost:1234/'), 'http://localhost:1234/v1/chat/completions');
});

test('localChatUrl completes a /v1 base', () => {
  assert.equal(localChatUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1/chat/completions');
});

test('localChatUrl leaves a full endpoint alone', () => {
  assert.equal(
    localChatUrl('http://box:8080/v1/chat/completions'),
    'http://box:8080/v1/chat/completions',
  );
});

test('localChatUrl returns empty for empty input', () => {
  assert.equal(localChatUrl(''), '');
  assert.equal(localChatUrl(null), '');
});

// ---- segmentPrompt / constants ----

test('segmentPrompt carries the beat, digest, and contract instruction', () => {
  const p = segmentPrompt('gpu supply', '- [News] Something happened (Reuters, 1h ago)');
  assert.match(p, /^Beat: gpu supply\n/);
  assert.match(p, /Wire notes:\n- \[News\] Something happened/);
  assert.match(p, /Pick the strongest through-line/);
  assert.match(p, /Mention at least one source by name/);
});

test('MOODS matches the contract exactly', () => {
  assert.deepEqual(MOODS, ['breaking', 'developing', 'steady', 'quirky']);
});
