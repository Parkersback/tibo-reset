import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TWEET_PUBLIC_FIELDS,
  canonicalizePayload,
  validatePayload,
} from '../src/validators.js';

const TWEETS_SOURCE = Object.freeze({
  name: 'tweets.json',
  expectedType: 'array',
  maxItems: 500,
});

test('tweets are reduced to the public contract before strict trust validation', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  const canonical = canonicalizePayload(TWEETS_SOURCE, [{
    timestamp: '2026-08-10T23:00:00Z',
    author: '  Tibo  ',
    text: `  ${'signal '.repeat(80)}\n  `,
    source: 'tibo_rss',
    url: 'https://x.com/thsottiaux/status/1',
    authority_score: 0.95,
    private_tracking_field: 'must not leave the Worker',
  }]);

  assert.deepEqual(Object.keys(canonical[0]), [...TWEET_PUBLIC_FIELDS]);
  assert.equal(canonical[0].author, 'Tibo');
  assert.equal(canonical[0].text.includes('\n'), false);
  assert.equal(canonical[0].text.length, 361);
  assert.equal(canonical[0].text.endsWith('…'), true);
  assert.doesNotThrow(() => validatePayload(TWEETS_SOURCE, canonical, now));

  const malicious = [{
    ...canonical[0],
    url: 'https://x.com.evil.example/thsottiaux/status/1',
  }];
  assert.throws(
    () => validatePayload(TWEETS_SOURCE, malicious, now),
    /invalid tibo_rss author or url/,
  );
});

test('trusted X records require the expected account status path and numeric post id', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  const baseTibo = {
    timestamp: '2026-08-10T23:00:00Z',
    author: 'Tibo',
    text: 'signal',
    source: 'tibo_rss',
    url: 'https://x.com/thsottiaux/status/123456789',
    authority_score: 1,
  };
  assert.doesNotThrow(() => validatePayload(TWEETS_SOURCE, [baseTibo], now));
  for (const url of [
    'https://x.com/attacker/status/123456789',
    'https://x.com/thsottiaux/likes',
    'https://twitter.com/thsottiaux/status/not-digits',
  ]) {
    assert.throws(
      () => validatePayload(TWEETS_SOURCE, [{ ...baseTibo, url }], now),
      /invalid tibo_rss author or url/,
      url,
    );
  }

  const official = {
    ...baseTibo,
    author: 'OpenAI',
    source: 'openai_rss',
    url: 'https://x.com/OpenAI/status/987654321',
  };
  assert.doesNotThrow(() => validatePayload(TWEETS_SOURCE, [official], now));
  assert.throws(
    () => validatePayload(TWEETS_SOURCE, [{
      ...official,
      url: 'https://x.com/attacker/status/987654321',
    }], now),
    /invalid official author or url/,
  );
});

test('the other four source contracts reject invalid probabilities, times, totals and notes', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  const predictionSource = { name: 'prediction.json', expectedType: 'object' };
  assert.throws(() => validatePayload(predictionSource, {
    updated_at: '2026-08-11T00:00:00Z',
    prediction: { within_5h: 0.5, within_24h: Number.NaN, within_48h: 0.9 },
  }, now), /probability/);

  const historySource = {
    name: 'prediction_history.json',
    expectedType: 'array',
    maxItems: 10_000,
  };
  assert.throws(() => validatePayload(historySource, [{
    prediction_time: 'not-a-time',
    prediction: { within_5h: 0.5, within_24h: 0.8, within_48h: 0.9 },
  }], now), /timestamp/);

  const performanceSource = { name: 'model_performance.json', expectedType: 'object' };
  assert.throws(() => validatePayload(performanceSource, {
    total_predictions: 1,
    resolved_predictions: 2,
    overall_brier_score: 0.2,
    overall_accuracy: 1,
    updated_at: '2026-08-11T00:00:00Z',
    horizons: [{ horizon_hours: 24, total: 1, brier_score: 0.2, accuracy: 1 }],
  }, now), /exceeds total_predictions/);

  const resetSource = {
    name: 'reset_history.json',
    expectedType: 'array',
    maxItems: 2_000,
  };
  assert.throws(() => validatePayload(resetSource, [{
    reset_time: '2026-08-11T00:00:00Z',
    source: 'verified',
    confidence: 1,
    notes: 'x'.repeat(501),
  }], now), /string length/);
});
