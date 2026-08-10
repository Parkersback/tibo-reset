'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const controller = require(path.join(ROOT, 'site', 'app.js'));

test('normalizes and formats only finite probabilities in the closed unit interval', () => {
  assert.equal(controller.normalizeProbability(0), 0);
  assert.equal(controller.normalizeProbability(1), 1);
  assert.equal(controller.normalizeProbability('0.375'), 0.375);
  for (const value of [-0.01, 1.01, '', null, undefined, NaN, Infinity, 'wat']) {
    assert.equal(controller.normalizeProbability(value), null);
    assert.equal(controller.formatProbability(value), '--');
  }
  assert.equal(controller.formatProbability(0), '0%');
  assert.equal(controller.formatProbability(0.375), '38%');
  assert.equal(controller.formatProbability(1), '100%');
});

test('chooses Chinese unless the exact stored value is en and persists safely', () => {
  assert.equal(controller.chooseLanguage(), 'zh-CN');
  assert.equal(controller.chooseLanguage('zh-CN'), 'zh-CN');
  assert.equal(controller.chooseLanguage('EN'), 'zh-CN');
  assert.equal(controller.chooseLanguage('en'), 'en');

  const values = new Map([['tibo-reset-language', 'en']]);
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
  assert.equal(controller.readStoredLanguage(storage), 'en');
  assert.equal(controller.persistLanguage(storage, 'zh-CN'), true);
  assert.equal(values.get('tibo-reset-language'), 'zh-CN');
  assert.equal(controller.readStoredLanguage(storage), 'zh-CN');
  assert.equal(controller.readStoredLanguage({ getItem() { throw new Error('blocked'); } }), 'zh-CN');
});

test('action thresholds include the documented boundaries', () => {
  assert.equal(controller.getActionLevel(0), 'calm');
  assert.equal(controller.getActionLevel(0.349999), 'calm');
  assert.equal(controller.getActionLevel(0.35), 'watch');
  assert.equal(controller.getActionLevel(0.60), 'watch');
  assert.equal(controller.getActionLevel(0.600001), 'warning');
  assert.equal(controller.getActionLevel(null), 'unknown');
});

test('trusts signals only when source, author, host and time satisfy the category policy', () => {
  const now = Date.parse('2026-08-11T00:00:00Z');
  const validTibo = {
    timestamp: '2026-08-10T20:00:00Z',
    source: 'tibo_rss',
    author: 'Tibo',
    text: 'verified Tibo signal',
    url: 'https://x.com/thsottiaux/status/1',
  };
  const validCommunity = {
    timestamp: '2026-08-10T21:00:00Z',
    source: 'community_rss',
    author: '/u/example',
    text: 'verified community signal',
    url: 'https://www.reddit.com/r/OpenAI/comments/1/example/',
  };
  const validOpenAI = {
    timestamp: '2026-08-10T22:00:00Z',
    source: 'openai_status',
    author: 'OpenAI',
    text: 'verified official signal',
    url: 'https://status.openai.com/incidents/example',
  };
  const phishingOpenAI = {
    timestamp: '2026-08-10T23:00:00Z',
    source: 'status',
    author: 'OpenAI',
    text: 'phishing signal',
    url: 'https://evil.example/openai',
  };

  assert.equal(controller.classifySignal(validTibo), 'tibo');
  assert.equal(controller.classifySignal(validCommunity), 'community');
  assert.equal(controller.classifySignal(validOpenAI), 'openai');
  assert.equal(controller.classifySignal(phishingOpenAI), null);
  assert.equal(controller.classifySignal({
    ...validCommunity,
    source: 'unknown_rss',
  }), null);
  assert.equal(controller.classifySignal({
    ...validCommunity,
    url: 'https://reddit.com.evil.example/r/OpenAI',
  }), null);

  const selected = controller.selectLatestSignals([
    validTibo,
    validCommunity,
    validOpenAI,
    phishingOpenAI,
    {
      ...validTibo,
      timestamp: '2026-08-12T01:00:01Z',
      text: 'more than 24 hours in the future',
    },
    { ...validOpenAI, timestamp: 'not-a-date', text: 'invalid time' },
  ], now);
  assert.equal(selected.tibo.text, 'verified Tibo signal');
  assert.equal(selected.openai.text, 'verified official signal');
  assert.equal(selected.community.text, 'verified community signal');

  assert.equal(
    controller.trustedSignalUrl(validOpenAI, 'openai'),
    'https://status.openai.com/incidents/example',
  );
  assert.equal(controller.trustedSignalUrl(phishingOpenAI, 'openai'), null);
  assert.equal(controller.trustedSignalUrl(validOpenAI, 'community'), null);

  const mirroredTweets = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'site', 'data', 'tweets.json'), 'utf8'),
  );
  const mirrored = controller.selectLatestSignals(mirroredTweets, Date.now());
  assert.ok(mirrored.tibo);
  assert.ok(mirrored.community);
  assert.equal(mirrored.openai, null);

  const source = fs.readFileSync(path.join(ROOT, 'site', 'app.js'), 'utf8');
  assert.match(source, /trustedSignalUrl\(item, category\)/);
});

test('normalizes degraded sync source and error details for a safe status mount', () => {
  const issues = controller.normalizeSyncIssues({
    overall_status: 'degraded',
    sources: [
      {
        name: 'tweets.json',
        status: 'cached',
        error: '<img src=x onerror=alert(1)> upstream timeout',
      },
      { name: 'prediction.json', status: 'fresh', error: null },
      { name: 'reset_history.json', status: 'failed', error: 'HTTP 503' },
    ],
  });
  assert.deepEqual(issues, [
    {
      name: 'tweets.json',
      status: 'cached',
      error: '<img src=x onerror=alert(1)> upstream timeout',
    },
    { name: 'reset_history.json', status: 'failed', error: 'HTTP 503' },
  ]);

  const html = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
  assert.match(html, /id="sync-status-details"/);
});

test('filters history to 24 hours, falls back to the newest available window and samples to 160', () => {
  const now = Date.parse('2026-08-11T00:00:00Z');
  const records = [];
  for (let index = 0; index < 300; index += 1) {
    records.push({
      prediction_time: new Date(now - (299 - index) * 6 * 60 * 1000).toISOString(),
      prediction: { within_24h: (index % 101) / 100 },
    });
  }
  records.push({ prediction_time: 'bad', prediction: { within_24h: 0.4 } });
  records.push({ prediction_time: new Date(now).toISOString(), prediction: { within_24h: NaN } });

  const recent = controller.prepareHistory(records, now);
  assert.ok(recent.length <= 160);
  assert.ok(recent.length > 1);
  assert.ok(recent[0].time >= now - 24 * 60 * 60 * 1000);
  assert.ok(recent.every((point, index) => index === 0 || point.time >= recent[index - 1].time));

  const old = records.slice(0, 10);
  const fallback = controller.prepareHistory(old, Date.parse('2030-01-01T00:00:00Z'));
  assert.ok(fallback.length > 0);
  assert.equal(fallback.at(-1).time, Date.parse(old.at(-1).prediction_time));
});

test('history geometry remains finite for empty, single and same-time inputs', () => {
  const empty = controller.buildHistoryGeometry([]);
  assert.equal(empty.path, '');
  assert.equal(empty.area, '');

  const cases = [
    [{ time: 1, value: 0.5 }],
    [{ time: 1, value: 0.1 }, { time: 1, value: 0.9 }],
  ];
  for (const points of cases) {
    const geometry = controller.buildHistoryGeometry(points);
    assert.match(geometry.path, /^M/);
    assert.doesNotMatch(geometry.path + geometry.area, /NaN|Infinity/);
  }
});

test('deduplicates and sorts reset records while excluding banked and boost events', () => {
  const records = [
    { reset_time: '2026-08-08T00:00:00Z', notes: 'Global Codex quota reset', source: 'x' },
    { reset_time: '2026-08-08T00:00:00Z', notes: 'Global Codex quota reset', source: 'duplicate' },
    { reset_time: '2026-08-10T00:00:00Z', notes: 'Tibo manual reset', source: 'x' },
    { reset_time: '2026-08-09T00:00:00Z', notes: 'Banked reset added', source: 'x' },
    { reset_time: '2026-08-11T00:00:00Z', notes: 'Usage boost unlocked', source: 'x' },
    { reset_time: '2026-08-12T00:00:00Z', notes: 'Regular weekly reset', source: 'scheduler' },
    { reset_time: '2026-08-13T00:00:00Z', notes: 'Regular weekly refresh', source: 'scheduler' },
    { reset_time: '2026-08-14T00:00:00Z', notes: 'Routine quota maintenance', source: 'weekly_reset' },
    { reset_time: 'invalid', notes: 'Global reset', source: 'x' },
  ];
  const normalized = controller.normalizeResetHistory(records);
  assert.deepEqual(normalized.map((item) => item.notes), [
    'Tibo manual reset',
    'Global Codex quota reset',
  ]);
  assert.equal(controller.isGlobalResetRecord({ notes: 'banked reset' }), false);
  assert.equal(controller.isGlobalResetRecord({ notes: 'global hard reset' }), true);
  assert.equal(
    controller.isGlobalResetRecord({ notes: 'Routine quota maintenance', source: 'weekly reset' }),
    false,
  );
  assert.equal(
    controller.isGlobalResetRecord({ notes: 'Regular weekly refresh/reset', source: 'scheduler' }),
    false,
  );
  assert.equal(
    controller.isGlobalResetRecord({ notes: 'Global Codex quota reset', source: 'weekly_reset' }),
    true,
  );
});

test('share text contains real probabilities, at most two factors, update time, disclaimer and URL', () => {
  const model = {
    probabilities: { five: 0.1, day: 0.42, twoDay: 0.77 },
    factors: [
      { text: 'real upstream factor one' },
      { text: 'real upstream factor two' },
      { text: 'must not be included' },
    ],
    updatedAt: Date.parse('2026-08-10T12:00:00Z'),
  };
  const text = controller.buildShareText(model, 'en', 'https://example.test/tibo');
  assert.match(text, /5h 10%/);
  assert.match(text, /24h 42%/);
  assert.match(text, /48h 77%/);
  assert.match(text, /real upstream factor one/);
  assert.match(text, /real upstream factor two/);
  assert.doesNotMatch(text, /must not be included/);
  assert.match(text, /Unofficial/);
  assert.match(text, /https:\/\/example\.test\/tibo/);
});

test('notification state triggers only on crossings and rearms after a fall', () => {
  let result = controller.notificationTransition(
    { enabled: true, fiveHigh: false, dayHigh: false },
    { five: 0.51, day: 0.61 },
  );
  assert.deepEqual(result.triggers, ['5h', '24h']);

  result = controller.notificationTransition(result.state, { five: 0.9, day: 0.8 });
  assert.deepEqual(result.triggers, []);

  result = controller.notificationTransition(result.state, { five: 0.5, day: 0.6 });
  assert.deepEqual(result.triggers, []);
  assert.equal(result.state.fiveHigh, false);
  assert.equal(result.state.dayHigh, false);

  result = controller.notificationTransition(result.state, { five: 0.5001, day: 0.6001 });
  assert.deepEqual(result.triggers, ['5h', '24h']);

  const invalid = controller.notificationTransition(result.state, { five: null, day: null });
  assert.equal(invalid.state.fiveHigh, true);
  assert.equal(invalid.state.dayHigh, true);
});

test('persists probability falls while notifications are disabled without firing', () => {
  const writes = [];
  const storage = {
    setItem(key, value) { writes.push([key, JSON.parse(value)]); },
  };
  const result = controller.reconcileNotificationState(
    { enabled: false, fiveHigh: true, dayHigh: true },
    { five: 0.2, day: 0.3 },
    storage,
  );
  assert.deepEqual(result.triggers, []);
  assert.equal(result.state.enabled, false);
  assert.equal(result.state.fiveHigh, false);
  assert.equal(result.state.dayHigh, false);
  assert.deepEqual(writes.at(-1), [
    'tibo-reset-notifications',
    { enabled: false, fiveHigh: false, dayHigh: false },
  ]);
});

test('consumes rising notification crossings only after successful delivery', () => {
  const writes = [];
  const storage = {
    setItem(key, value) { writes.push([key, JSON.parse(value)]); },
  };
  const created = [];
  class WorkingNotification {
    constructor(title, options) {
      created.push({ title, options });
    }
  }

  let result = controller.deliverNotificationCrossings(
    { enabled: true, fiveHigh: false, dayHigh: false },
    { five: 0.51, day: 0.2 },
    {
      permission: 'default',
      NotificationConstructor: WorkingNotification,
      storage,
      language: 'en',
    },
  );
  assert.deepEqual(result.delivered, []);
  assert.deepEqual(result.pending, ['5h']);
  assert.equal(result.state.fiveHigh, false);
  assert.equal(created.length, 0);
  assert.equal(writes.at(-1)[1].fiveHigh, false);

  result = controller.deliverNotificationCrossings(
    result.state,
    { five: 0.51, day: 0.2 },
    {
      permission: 'granted',
      NotificationConstructor: WorkingNotification,
      storage,
      language: 'en',
    },
  );
  assert.deepEqual(result.delivered, ['5h']);
  assert.deepEqual(result.pending, []);
  assert.equal(result.state.fiveHigh, true);
  assert.equal(created.length, 1);
  assert.equal(writes.at(-1)[1].fiveHigh, true);

  class ThrowingNotification {
    constructor() {
      throw new Error('constructor blocked');
    }
  }
  let errorCount = 0;
  result = controller.deliverNotificationCrossings(
    { enabled: true, fiveHigh: false, dayHigh: false },
    { five: 0.2, day: 0.61 },
    {
      permission: 'granted',
      NotificationConstructor: ThrowingNotification,
      storage,
      onError() { errorCount += 1; },
    },
  );
  assert.deepEqual(result.delivered, []);
  assert.deepEqual(result.failed, ['24h']);
  assert.deepEqual(result.pending, ['24h']);
  assert.equal(result.state.dayHigh, false);
  assert.equal(writes.at(-1)[1].dayHigh, false);
  assert.equal(errorCount, 1);

  result = controller.deliverNotificationCrossings(
    result.state,
    { five: 0.2, day: 0.61 },
    {
      permission: 'granted',
      NotificationConstructor: WorkingNotification,
      storage,
    },
  );
  assert.deepEqual(result.delivered, ['24h']);
  assert.equal(result.state.dayHigh, true);
});

test('both translation dictionaries cover every HTML key', () => {
  const html = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-aria-label|-content)?="([^"]+)"/g)]
    .map((match) => match[1]);
  for (const language of ['zh-CN', 'en']) {
    for (const key of new Set(keys)) {
      assert.equal(
        Object.hasOwn(controller.I18N[language], key),
        true,
        `${language} is missing ${key}`,
      );
      assert.equal(typeof controller.I18N[language][key], 'string');
      assert.notEqual(controller.I18N[language][key].trim(), '');
    }
  }
});

test('controller uses all six local sources, allSettled and text-only DOM writes', () => {
  assert.deepEqual(controller.DATA_SOURCES, [
    './data/prediction.json',
    './data/prediction_history.json',
    './data/tweets.json',
    './data/model_performance.json',
    './data/reset_history.json',
    './data/sync-status.json',
  ]);
  const source = fs.readFileSync(path.join(ROOT, 'site', 'app.js'), 'utf8');
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /\.textContent\s*=/);
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML\s*\(/);
  const malicious = '<img src=x onerror=alert(1)> & <script>alert(2)</script>';
  assert.equal(controller.truncateText(malicious, 500), malicious);
});
