import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveEventTitle, alertMetricValue, isPermanentSendError,
  marketUrl, effectiveThresholds,
} from '../src/monitor.js';

test('deriveEventTitle: shared prefix+suffix joined with …', () => {
  const t = deriveEventTitle([
    'Concrete FDV above $200M one day after launch?',
    'Concrete FDV above $50M one day after launch?',
  ]);
  assert.equal(t, 'Concrete FDV above … one day after launch?');
});

test('deriveEventTitle: degenerate inputs', () => {
  assert.equal(deriveEventTitle([]), '');
  assert.equal(deriveEventTitle(['Only one?']), 'Only one?');
  // No useful shared structure → falls back to the first question.
  assert.equal(deriveEventTitle(['abc?', 'xyz!']), 'abc?');
});

const SNAP = {
  bestBid: { price: 0.40, size: 100 },
  bestAsk: { price: 0.44, size: 50 },
  bids: [{ price: 0.40, size: 100 }, { price: 0.39, size: 10 }],
  asks: [{ price: 0.44, size: 50 }],
};

test('alertMetricValue: levels, mid, spread', () => {
  assert.equal(alertMetricValue(SNAP, 'bid1'), 0.40);
  assert.equal(alertMetricValue(SNAP, 'bid2'), 0.39);
  assert.equal(alertMetricValue(SNAP, 'ask1'), 0.44);
  assert.equal(alertMetricValue(SNAP, 'ask2'), null); // missing level
  assert.ok(Math.abs(alertMetricValue(SNAP, 'mid') - 0.42) < 1e-12);
  assert.ok(Math.abs(alertMetricValue(SNAP, 'spread') - 0.04) < 1e-12);
  assert.equal(alertMetricValue(null, 'bid1'), null);
  assert.equal(alertMetricValue({ bids: [], asks: [] }, 'mid'), null);
});

test('isPermanentSendError matches blocked/kicked/deleted, not transient', () => {
  assert.equal(isPermanentSendError(new Error('Telegram sendMessage not ok: 403 bot was blocked by the user')), true);
  assert.equal(isPermanentSendError(new Error('Bad Request: chat not found')), true);
  assert.equal(isPermanentSendError(new Error('Forbidden: bot was kicked from the group chat')), true);
  assert.equal(isPermanentSendError(new Error('Forbidden: user is deactivated')), true);
  assert.equal(isPermanentSendError(new Error('HTTP 502 bad gateway')), false);
  assert.equal(isPermanentSendError(new Error('fetch failed')), false);
  // "4030" should not match the \b403\b word boundary.
  assert.equal(isPermanentSendError(new Error('weird code 4030')), false);
});

test('marketUrl: locale + ref from config defaults', () => {
  // Defaults: locale zh-cn, ref B00EA (no env overrides in tests).
  assert.equal(marketUrl('btc-eom'), 'https://predict.fun/zh-cn/market/btc-eom?ref=B00EA');
  assert.equal(marketUrl(null), null);
});

test('effectiveThresholds: per-sub override falls back to env per-field', () => {
  const base = effectiveThresholds(null);
  assert.ok(base.priceEpsilon > 0);
  const t = effectiveThresholds({ thresholds: { priceEpsilon: 0.02 } });
  assert.equal(t.priceEpsilon, 0.02);
  assert.equal(t.sizeAbsoluteMin, base.sizeAbsoluteMin);
  // Explicit null in a field → env default.
  const t2 = effectiveThresholds({ thresholds: { priceEpsilon: null } });
  assert.equal(t2.priceEpsilon, base.priceEpsilon);
});
