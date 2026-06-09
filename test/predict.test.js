import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, slugifyWithYear, extractSlugFromUrl, extractMarketId,
  isAllowedPredictHost,
} from '../src/predict.js';

test('slugify basics', () => {
  assert.equal(slugify('BNB up or down (May 2)'), 'bnb-up-or-down-may-2');
  assert.equal(slugify("Trump's $1B bet?"), 'trumps-1b-bet');
  assert.equal(slugify('  --weird   input--  '), 'weird-input');
  assert.equal(slugify(null), '');
});

test('slugifyWithYear injects year after a month-day', () => {
  const year = new Date().getUTCFullYear();
  assert.equal(slugifyWithYear('BNB up or down (May 2)'), `bnb-up-or-down-may-2-${year}`);
  // Already has a year → unchanged.
  assert.equal(slugifyWithYear('BTC EOM 2026'), 'btc-eom-2026');
  // No month token → year appended at the end.
  assert.equal(slugifyWithYear('Spain wins'), `spain-wins-${year}`);
});

test('extractSlugFromUrl handles all URL shapes', () => {
  assert.equal(extractSlugFromUrl('https://predict.fun/event/fifa-world-cup'), 'fifa-world-cup');
  assert.equal(extractSlugFromUrl('https://predict.fun/zh-cn/market/btc-eom-2026'), 'btc-eom-2026');
  assert.equal(extractSlugFromUrl('https://predict.fun/zh-cn/event/foo?ref=X'), 'foo');
  assert.equal(extractSlugFromUrl('predict.fun/market/bar'), 'bar');
  assert.equal(extractSlugFromUrl('bare-slug-like-this'), 'bare-slug-like-this');
  assert.equal(extractSlugFromUrl('UPPER-Case-Slug'), 'upper-case-slug');
  assert.equal(extractSlugFromUrl(''), null);
  assert.equal(extractSlugFromUrl('!!!'), null);
});

test('extractMarketId only accepts bare numerics', () => {
  assert.equal(extractMarketId('257916'), '257916');
  assert.equal(extractMarketId('  42 '), '42');
  assert.equal(extractMarketId('257916x'), null);
  assert.equal(extractMarketId('https://predict.fun/market/foo'), null);
  assert.equal(extractMarketId(null), null);
});

test('isAllowedPredictHost is strict https + predict.fun', () => {
  assert.equal(isAllowedPredictHost('https://predict.fun/market/x'), true);
  assert.equal(isAllowedPredictHost('https://www.predict.fun/x'), true);
  assert.equal(isAllowedPredictHost('http://predict.fun/x'), false); // http downgrade
  assert.equal(isAllowedPredictHost('https://evil.com/predict.fun'), false);
  assert.equal(isAllowedPredictHost('https://predict.fun.evil.com/x'), false);
  assert.equal(isAllowedPredictHost('not a url'), false);
});
