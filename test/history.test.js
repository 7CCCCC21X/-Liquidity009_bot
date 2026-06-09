import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Point HISTORY_FILE at a temp path BEFORE importing the module.
const FILE = path.join(os.tmpdir(), `history-test-${process.pid}-${Date.now()}.jsonl`);
process.env.HISTORY_FILE = FILE;
process.env.HISTORY_ENABLED = 'true';

const { iterLinesBackwards, readEvents, readDigests, appendEvent } = await import('../src/history.js');

async function collect(iter) {
  const out = [];
  for await (const line of iter) out.push(line);
  return out;
}

test('iterLinesBackwards: missing file yields nothing', async () => {
  assert.deepEqual(await collect(iterLinesBackwards(FILE + '.nope')), []);
});

test('iterLinesBackwards: newest-first, skips blanks, handles no trailing newline', async () => {
  const f = FILE + '.basic';
  await fs.writeFile(f, 'one\ntwo\n\nthree'); // blank line + no trailing \n
  assert.deepEqual(await collect(iterLinesBackwards(f)), ['three', 'two', 'one']);
  await fs.rm(f);
});

test('iterLinesBackwards: lines + multibyte chars straddling chunk boundaries', async () => {
  const f = FILE + '.chunks';
  // CJK chars are 3 bytes each in UTF-8; a tiny chunk size forces both
  // line-straddle and multibyte-straddle at every boundary.
  const lines = Array.from({ length: 50 }, (_, i) => `行${i}-数据${'测'.repeat(7)}`);
  await fs.writeFile(f, lines.join('\n') + '\n');
  const got = await collect(iterLinesBackwards(f, 16));
  assert.deepEqual(got, [...lines].reverse());
  await fs.rm(f);
});

test('readEvents: filters + limit honoured, newest first', async () => {
  await appendEvent({ chatId: 1, marketId: 'A', summary: 'a1' });
  await appendEvent({ chatId: 2, marketId: 'B', summary: 'b1' });
  await appendEvent({ chatId: 1, marketId: 'A', summary: 'a2' });
  await appendEvent({ type: 'digest', chatId: 1, text: 'digest-1' });
  await appendEvent({ chatId: 1, marketId: 'C', summary: 'c1' });

  const a = await readEvents({ chatId: 1, marketId: 'A', limit: 10 });
  assert.deepEqual(a.map((e) => e.summary), ['a2', 'a1']);

  const capped = await readEvents({ chatId: 1, marketId: 'A', limit: 1 });
  assert.deepEqual(capped.map((e) => e.summary), ['a2']);

  const digests = await readDigests({ chatId: 1, limit: 5 });
  assert.equal(digests.length, 1);
  assert.equal(digests[0].text, 'digest-1');

  // Cross-chat isolation.
  const other = await readEvents({ chatId: 2, limit: 10 });
  assert.deepEqual(other.map((e) => e.summary), ['b1']);
});

test.after(async () => {
  await fs.rm(FILE, { force: true });
});
