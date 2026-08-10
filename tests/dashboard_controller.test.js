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

test('classifies signals by author or source and selects the newest real item', () => {
  assert.equal(controller.classifySignal({ author: 'Tibo' }), 'tibo');
  assert.equal(controller.classifySignal({ source: 'thsottiaux_rss' }), 'tibo');
  assert.equal(controller.classifySignal({ author: 'OpenAI Devs' }), 'openai');
  assert.equal(controller.classifySignal({ source: 'release_status' }), 'openai');
  assert.equal(controller.classifySignal({ author: 'A community user' }), 'community');
  assert.equal(
    controller.classifySignal({ source: 'community_rss', author: '/u/OpenAI' }),
    'community',
  );

  const selected = controller.selectLatestSignals([
    { timestamp: '2026-08-10T01:00:00Z', author: 'Tibo', text: 'older' },
    { timestamp: '2026-08-10T03:00:00Z', source: 'thsottiaux', text: 'newer' },
    { timestamp: '2026-08-10T02:00:00Z', source: 'openai_status', text: 'official' },
    { timestamp: '2026-08-10T04:00:00Z', author: 'Elsewhere', text: 'community' },
    { timestamp: 'not-a-date', author: 'OpenAI', text: 'invalid date' },
  ]);
  assert.equal(selected.tibo.text, 'newer');
  assert.equal(selected.openai.text, 'official');
  assert.equal(selected.community.text, 'community');

  const mirroredTweets = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'site', 'data', 'tweets.json'), 'utf8'),
  );
  assert.equal(controller.selectLatestSignals(mirroredTweets).openai, null);
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
    { reset_time: 'invalid', notes: 'Global reset', source: 'x' },
  ];
  const normalized = controller.normalizeResetHistory(records);
  assert.deepEqual(normalized.map((item) => item.notes), [
    'Tibo manual reset',
    'Global Codex quota reset',
  ]);
  assert.equal(controller.isGlobalResetRecord({ notes: 'banked reset' }), false);
  assert.equal(controller.isGlobalResetRecord({ notes: 'global hard reset' }), true);
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
  let result = controller.reconcileNotificationState(
    { enabled: false, fiveHigh: false, dayHigh: false },
    { five: 0.8, day: 0.9 },
    storage,
  );
  assert.deepEqual(result.triggers, []);
  assert.equal(result.state.fiveHigh, true);
  assert.equal(result.state.dayHigh, true);

  result = controller.reconcileNotificationState(
    result.state,
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

  result = controller.reconcileNotificationState(
    { ...result.state, enabled: true },
    { five: 0.51, day: 0.61 },
    storage,
  );
  assert.deepEqual(result.triggers, ['5h', '24h']);
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
