import test from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlEscape, redactTokens, splitHtmlByLines, rebalanceHtmlChunks,
} from '../src/telegram.js';

test('htmlEscape escapes &, <, >', () => {
  assert.equal(htmlEscape('a<b> & c'), 'a&lt;b&gt; &amp; c');
  assert.equal(htmlEscape(42), '42');
});

test('redactTokens strips bot tokens from URLs', () => {
  const msg = 'HTTP 502 https://api.telegram.org/bot12345:ABC-def/sendMessage failed';
  assert.equal(redactTokens(msg), 'HTTP 502 https://api.telegram.org/bot<redacted>/sendMessage failed');
  assert.equal(redactTokens(null), '');
});

test('splitHtmlByLines: short text passes through unchanged', () => {
  assert.deepEqual(splitHtmlByLines('hello\nworld'), ['hello\nworld']);
});

test('splitHtmlByLines: splits on line boundaries, never mid-line', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${'x'.repeat(20)}`);
  const text = lines.join('\n');
  const parts = splitHtmlByLines(text, 200);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 200);
  // Re-joining recovers every original line.
  assert.deepEqual(parts.join('\n').split('\n'), lines);
});

test('splitHtmlByLines: hard-slices a single over-long line', () => {
  const long = 'y'.repeat(500);
  const parts = splitHtmlByLines(long, 100);
  assert.ok(parts.length >= 5);
  for (const p of parts) assert.ok(p.length <= 100);
  assert.ok(parts[0].endsWith('…'));
});

test('rebalanceHtmlChunks closes and reopens tags across boundaries', () => {
  const chunks = ['<pre>row1\nrow2', 'row3\nrow4</pre>'];
  const fixed = rebalanceHtmlChunks(chunks);
  assert.equal(fixed[0], '<pre>row1\nrow2</pre>');
  assert.equal(fixed[1], '<pre>row3\nrow4</pre>');
});

test('rebalanceHtmlChunks leaves balanced chunks alone', () => {
  const chunks = ['<b>x</b>', '<i>y</i>'];
  assert.deepEqual(rebalanceHtmlChunks([...chunks]), chunks);
});
