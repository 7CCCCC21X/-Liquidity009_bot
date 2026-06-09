import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Point STATE_FILE at a throwaway path BEFORE importing the module —
// config.js reads env at import time. node:test runs each file in its
// own process, so this doesn't leak into other test files.
process.env.STATE_FILE = path.join(os.tmpdir(), `state-test-${process.pid}-${Date.now()}.json`);

const {
  loadState, addSubscription, getSubscription, removeSubscription,
  parseNoteText, normalizeLevels, normalizeTriggerMode, subKey,
  addSubscriptionPriceAlert, removeSubscriptionPriceAlert,
  clearSubscriptionPriceAlerts, updateSubscriptionNote,
} = await import('../src/state.js');

await loadState();

test('subKey', () => {
  assert.equal(subKey(123, '456'), '123:456');
});

test('parseNoteText pulls #tags out of free text', () => {
  assert.deepEqual(parseNoteText('#主仓 #BTC 套利目标 0.45'), { note: '套利目标 0.45', tags: ['主仓', 'BTC'] });
  assert.deepEqual(parseNoteText('plain note'), { note: 'plain note', tags: [] });
  assert.deepEqual(parseNoteText('#a #a #b'), { note: '', tags: ['a', 'b'] }); // dedup
  assert.deepEqual(parseNoteText(''), { note: '', tags: [] });
});

test('normalizeLevels filters junk and keeps canonical order', () => {
  assert.deepEqual(normalizeLevels(['ask1', 'bid1', 'nope']), ['bid1', 'ask1']);
  assert.deepEqual(normalizeLevels([]), []);
});

test('normalizeTriggerMode falls back through chat → env → both', () => {
  assert.equal(normalizeTriggerMode('size'), 'size');
  assert.equal(normalizeTriggerMode('BOGUS', 'price'), 'price');
});

test('subscription lifecycle with price alerts', () => {
  addSubscription({ chatId: 1, marketId: '999', title: 'T', slug: 's' });
  const a1 = addSubscriptionPriceAlert(1, '999', { metric: 'bid1', op: '>', price: 0.5 });
  const a2 = addSubscriptionPriceAlert(1, '999', { metric: 'mid', op: '<=', price: 0.3 });
  assert.ok(a1.id && a2.id && a1.id !== a2.id);
  assert.equal(getSubscription(1, '999').priceAlerts.length, 2);

  // Re-adding the same market preserves armed alerts.
  addSubscription({ chatId: 1, marketId: '999', title: 'T2' });
  assert.equal(getSubscription(1, '999').priceAlerts.length, 2);

  assert.equal(removeSubscriptionPriceAlert(1, '999', a1.id), true);
  assert.equal(removeSubscriptionPriceAlert(1, '999', 'nonexistent'), false);
  assert.equal(getSubscription(1, '999').priceAlerts.length, 1);

  assert.equal(clearSubscriptionPriceAlerts(1, '999'), 1);
  assert.equal(getSubscription(1, '999').priceAlerts, undefined);

  assert.equal(removeSubscription(1, '999'), true);
  assert.equal(getSubscription(1, '999'), null);
});

test('updateSubscriptionNote splits tags and caps length', () => {
  addSubscription({ chatId: 2, marketId: '111', title: 'X' });
  const s = updateSubscriptionNote(2, '111', '#tag1 hello world');
  assert.equal(s.note, 'hello world');
  assert.deepEqual(s.tags, ['tag1']);
  // Clearing.
  const cleared = updateSubscriptionNote(2, '111', '   ');
  assert.equal(cleared.note, null);
  assert.deepEqual(cleared.tags, []);
  removeSubscription(2, '111');
});
