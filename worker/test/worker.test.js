import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RefreshCoordinator,
  createWorker,
  fetchValidatedSource,
  refreshBundle,
} from '../src/index.js';
import {
  BUNDLE_KEY,
  MAX_RESPONSE_BYTES,
  PAGES_SYNC_STATUS_URL,
  UPSTREAMS,
} from '../src/config.js';

function createKv(initialValue = null, initialMetadata = null) {
  const writes = [];
  return {
    writes,
    async get(key) {
      assert.equal(key, BUNDLE_KEY);
      return initialValue;
    },
    async getWithMetadata(key) {
      assert.equal(key, BUNDLE_KEY);
      return { value: initialValue, metadata: initialMetadata };
    },
    async put(key, value, options) {
      writes.push({ key, value, options });
    },
  };
}

test('GET /v1/bundle.json returns a safe 503 when KV is empty', async () => {
  const kv = createKv();
  const worker = createWorker();
  const response = await worker.fetch(
    new Request('https://edge.example/v1/bundle.json'),
    { DATA_MIRROR: kv },
    {},
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    schema: 1,
    status: 'empty',
    error: 'data mirror is not initialized',
  });
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(kv.writes.length, 0);
});

test('GET /v1/bundle.json streams the stored JSON text without parse-reserialize work', async () => {
  const storedText = '{\n  "schema": 1,\n  "marker": "preserve whitespace"\n}\n';
  const response = await createWorker().fetch(
    new Request('https://edge.example/v1/bundle.json'),
    { DATA_MIRROR: createKv(storedText) },
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), storedText);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('CORS reflects only the production Pages origin and HTTP loopback origins', async () => {
  const worker = createWorker();
  const env = { DATA_MIRROR: createKv(JSON.stringify({ schema: 1 })) };

  for (const origin of [
    'https://parkersback.github.io',
    'http://localhost:4178',
    'http://127.0.0.1:8787',
  ]) {
    const response = await worker.fetch(new Request('https://edge.example/v1/bundle.json', {
      headers: { Origin: origin },
    }), env, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('vary'), 'Origin');
  }

  for (const origin of [
    'null',
    'https://localhost:4178',
    'http://localhost.evil.example:4178',
    'https://parkersback.github.io.evil.example',
  ]) {
    const response = await worker.fetch(new Request('https://edge.example/v1/bundle.json', {
      headers: { Origin: origin },
    }), env, {});
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }

  const preflight = await worker.fetch(new Request('https://edge.example/v1/bundle.json', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:4178',
      'Access-Control-Request-Method': 'GET',
    },
  }), env, {});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');

  const post = await worker.fetch(new Request('https://edge.example/v1/bundle.json', {
    method: 'POST',
  }), env, {});
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, OPTIONS');
});

function validPayloads(timestamp = '2026-08-11T00:00:00Z') {
  const prediction = {
    within_5h: 0.5,
    within_24h: 0.8,
    within_48h: 0.9,
  };
  return {
    'prediction.json': {
      updated_at: timestamp,
      prediction,
      confidence: 'high',
    },
    'prediction_history.json': [{
      prediction_time: timestamp,
      prediction,
      actual_result: null,
    }],
    'tweets.json': [{
      timestamp,
      author: 'Tibo',
      text: 'A public reset signal',
      source: 'tibo_rss',
      url: 'https://x.com/thsottiaux/status/1',
      authority_score: 0.9,
      private_field: 'remove me',
    }],
    'model_performance.json': {
      total_predictions: 1,
      resolved_predictions: 1,
      overall_brier_score: 0.2,
      overall_accuracy: 1,
      updated_at: timestamp,
      horizons: [{
        horizon_hours: 24,
        total: 1,
        brier_score: 0.2,
        accuracy: 1,
      }],
    },
    'reset_history.json': [{
      reset_time: timestamp,
      source: 'verified',
      confidence: 1,
      notes: 'Global reset confirmed.',
    }],
  };
}

test('a successful refresh validates five fixed upstreams and atomically publishes one bundle', async () => {
  const payloads = validPayloads();
  const calls = [];
  const kv = createKv();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const source = UPSTREAMS.find((candidate) => candidate.url === url);
    assert.ok(source, `unexpected fetch URL ${url}`);
    return new Response(JSON.stringify(payloads[source.name]), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  };

  const bundle = await refreshBundle(
    { DATA_MIRROR: kv },
    { fetchImpl, now: () => new Date('2026-08-11T00:00:00Z') },
  );

  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.options.redirect === 'manual'));
  assert.equal(kv.writes.length, 1);
  assert.equal(kv.writes[0].key, BUNDLE_KEY);
  assert.equal(bundle.schema, 1);
  assert.equal(bundle.overall_status, 'ok');
  assert.deepEqual(bundle.sources.map((source) => source.status), Array(5).fill('fresh'));
  assert.deepEqual(
    bundle.sources.map((source) => source.fetched_at),
    Array(5).fill('2026-08-11T00:00:00Z'),
  );
  assert.deepEqual(Object.keys(bundle.data), [
    'prediction',
    'predictionHistory',
    'tweets',
    'performance',
    'resetHistory',
  ]);
  assert.equal(Object.hasOwn(bundle.data.tweets[0], 'private_field'), false);
  assert.deepEqual(JSON.parse(kv.writes[0].value), bundle);
  assert.deepEqual(kv.writes[0].options, {
    metadata: {
      schema: 1,
      overall_status: 'ok',
      synced_at: '2026-08-11T00:00:00Z',
      source_count: 5,
    },
  });
});

test('one failed source reuses only its valid prior payload and publishes a degraded bundle', async () => {
  const payloads = validPayloads();
  const seedKv = createKv();
  const successFetch = async (url) => {
    const source = UPSTREAMS.find((candidate) => candidate.url === url);
    return new Response(JSON.stringify(payloads[source.name]), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  await refreshBundle(
    { DATA_MIRROR: seedKv },
    { fetchImpl: successFetch, now: () => new Date('2026-08-11T00:00:00Z') },
  );
  const previous = JSON.parse(seedKv.writes[0].value);

  payloads['prediction.json'].prediction.within_24h = 0.61;
  const degradedKv = createKv(seedKv.writes[0].value);
  const partialFetch = async (url) => {
    const source = UPSTREAMS.find((candidate) => candidate.url === url);
    if (source.name === 'tweets.json') {
      return new Response('temporarily unavailable', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new Response(JSON.stringify(payloads[source.name]), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const bundle = await refreshBundle(
    { DATA_MIRROR: degradedKv },
    { fetchImpl: partialFetch, now: () => new Date('2026-08-11T00:05:00Z') },
  );

  assert.equal(bundle.overall_status, 'degraded');
  assert.equal(bundle.data.prediction.prediction.within_24h, 0.61);
  assert.deepEqual(bundle.data.tweets, previous.data.tweets);
  const cachedTweetSource = bundle.sources.find((source) => source.name === 'tweets.json');
  assert.equal(cachedTweetSource.status, 'cached');
  assert.equal(cachedTweetSource.fetched_at, '2026-08-11T00:00:00Z');
  assert.equal(bundle.synced_at, '2026-08-11T00:00:00Z');
  assert.match(
    cachedTweetSource.error,
    /HTTP 503/,
  );
  assert.equal(degradedKv.writes.length, 1);
});

test('a cached source older than two hours cannot be renewed into a new bundle', async () => {
  const payloads = validPayloads();
  const seedKv = createKv();
  const successFetch = async (url) => {
    const source = UPSTREAMS.find((candidate) => candidate.url === url);
    return new Response(JSON.stringify(payloads[source.name]), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  await refreshBundle(
    { DATA_MIRROR: seedKv },
    { fetchImpl: successFetch, now: () => new Date('2026-08-11T00:00:00Z') },
  );
  const staleKv = createKv(seedKv.writes[0].value);
  const oneSourceDown = async (url) => {
    const source = UPSTREAMS.find((candidate) => candidate.url === url);
    if (source.name === 'tweets.json') {
      return new Response('outage', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new Response(JSON.stringify(payloads[source.name]), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(refreshBundle(
    { DATA_MIRROR: staleKv },
    {
      fetchImpl: oneSourceDown,
      now: () => new Date('2026-08-11T02:00:01Z'),
    },
  ), /no valid data for: tweets.json/);
  assert.equal(staleKv.writes.length, 0);
});

test('an empty KV can bootstrap one failed upstream from a recent validated Pages mirror', async () => {
  const payloads = validPayloads('2026-08-11T00:05:00Z');
  const kv = createKv();
  const syncStatus = {
    schema: 1,
    synced_at: '2026-08-11T00:04:00Z',
    overall_status: 'ok',
    sources: UPSTREAMS.map((source) => ({
      name: source.name,
      url: source.url,
      status: 'fresh',
      error: null,
    })),
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === PAGES_SYNC_STATUS_URL) {
      return new Response(JSON.stringify(syncStatus), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const mirrorSource = UPSTREAMS.find((source) => source.fallbackUrl === url);
    if (mirrorSource) {
      return new Response(JSON.stringify(payloads[mirrorSource.name]), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const source = UPSTREAMS.find((candidate) => candidate.url === url);
    assert.ok(source, `unexpected URL ${url}`);
    if (source.name === 'prediction_history.json') {
      return new Response('slow upstream', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new Response(JSON.stringify(payloads[source.name]), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const bundle = await refreshBundle(
    { DATA_MIRROR: kv },
    { fetchImpl, now: () => new Date('2026-08-11T00:05:00Z') },
  );

  assert.equal(bundle.overall_status, 'degraded');
  assert.equal(bundle.synced_at, '2026-08-11T00:04:00Z');
  const historyStatus = bundle.sources.find(
    (source) => source.name === 'prediction_history.json',
  );
  assert.equal(historyStatus.status, 'cached');
  assert.equal(historyStatus.fetched_at, '2026-08-11T00:04:00Z');
  assert.match(historyStatus.error, /HTTP 503/);
  assert.equal(calls.filter((url) => url === PAGES_SYNC_STATUS_URL).length, 1);
  assert.equal(
    calls.filter((url) => url === UPSTREAMS[1].fallbackUrl).length,
    1,
  );
  assert.equal(kv.writes.length, 1);
});

test('a stale Pages mirror cannot bootstrap a missing source or write a partial bundle', async () => {
  const payloads = validPayloads('2026-08-11T03:00:01Z');
  const kv = createKv();
  const fetchImpl = async (url) => {
    if (url === PAGES_SYNC_STATUS_URL) {
      return new Response(JSON.stringify({
        schema: 1,
        synced_at: '2026-08-11T01:00:00Z',
        overall_status: 'ok',
        sources: UPSTREAMS.map((source) => ({
          name: source.name,
          url: source.url,
          status: 'fresh',
          error: null,
        })),
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    const source = UPSTREAMS.find((candidate) => candidate.url === url);
    assert.ok(source, `unexpected URL ${url}`);
    if (source.name === 'prediction_history.json') {
      return new Response('slow upstream', { status: 503 });
    }
    return new Response(JSON.stringify(payloads[source.name]), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(refreshBundle(
    { DATA_MIRROR: kv },
    { fetchImpl, now: () => new Date('2026-08-11T03:00:01Z') },
  ), /no valid data for: prediction_history.json/);
  assert.equal(kv.writes.length, 0);
});

test('the singleton refresh coordinator coalesces overlap so an older slow run cannot overwrite a newer run', async () => {
  let releaseSlow;
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  let calls = 0;
  let finalPublishedMarker = null;
  const coordinator = new RefreshCoordinator({}, {}, {
    refreshImpl: async () => {
      calls += 1;
      if (calls === 1) {
        await slowGate;
        finalPublishedMarker = 'old';
        return { schema: 1, overall_status: 'ok', attempted_at: 'old' };
      }
      finalPublishedMarker = 'new';
      return { schema: 1, overall_status: 'ok', attempted_at: 'new' };
    },
  });
  const request = new Request('https://refresh.internal/refresh', { method: 'POST' });

  const slow = coordinator.fetch(request);
  const overlapping = coordinator.fetch(request);
  await Promise.resolve();
  assert.equal(calls, 1);
  releaseSlow();
  const [slowResponse, overlappingResponse] = await Promise.all([slow, overlapping]);
  assert.equal(slowResponse.status, 200);
  assert.equal(overlappingResponse.status, 200);
  assert.equal(calls, 1);
  assert.equal(finalPublishedMarker, 'old');

  const newerResponse = await coordinator.fetch(request);
  assert.equal(newerResponse.status, 200);
  assert.equal(calls, 2);
  assert.equal(finalPublishedMarker, 'new');
});

test('GET /health reports the stored bundle state without refreshing or writing KV', async () => {
  const metadata = {
    schema: 1,
    synced_at: '2026-08-11T00:00:00Z',
    overall_status: 'degraded',
    source_count: 5,
  };
  const kv = createKv('{intentionally opaque large bundle text', metadata);
  const response = await createWorker().fetch(
    new Request('https://edge.example/health'),
    { DATA_MIRROR: kv },
    {},
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schema: 1,
    status: 'degraded',
    overall_status: 'degraded',
    synced_at: '2026-08-11T00:00:00Z',
    source_count: 5,
  });
  assert.equal(kv.writes.length, 0);
});

test('scheduled events route through the singleton Durable Object coordinator', async () => {
  const calls = [];
  const coordinatorBinding = {
    idFromName(name) {
      calls.push({ operation: 'idFromName', name });
      return 'coordinator-id';
    },
    get(id) {
      calls.push({ operation: 'get', id });
      return {
        async fetch(request) {
          calls.push({ operation: 'fetch', method: request.method, url: request.url });
          return new Response(JSON.stringify({ schema: 1, status: 'ok' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        },
      };
    },
  };
  const worker = createWorker();
  let scheduledPromise = null;
  const context = {
    waitUntil(promise) {
      scheduledPromise = promise;
    },
  };

  worker.scheduled({}, { REFRESH_COORDINATOR: coordinatorBinding }, context);
  assert.ok(scheduledPromise instanceof Promise);
  await scheduledPromise;
  assert.deepEqual(calls, [
    { operation: 'idFromName', name: 'global-v1' },
    { operation: 'get', id: 'coordinator-id' },
    {
      operation: 'fetch',
      method: 'POST',
      url: 'https://refresh.internal/refresh',
    },
  ]);
});

test('GET /v1/bundle.json treats KV text as opaque and leaves validation to the client', async () => {
  const storedText = '{ definitely not JSON';
  const response = await createWorker().fetch(
    new Request('https://edge.example/v1/bundle.json'),
    { DATA_MIRROR: createKv(storedText) },
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), storedText);
});

test('upstream fetch rejects redirects, non-JSON media, oversized bodies and URL substitution', async () => {
  const source = UPSTREAMS[0];
  const now = () => new Date('2026-08-11T00:00:00Z');

  await assert.rejects(
    fetchValidatedSource(source, {
      now,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { Location: source.url },
      }),
    }),
    /redirects are not allowed/,
  );
  await assert.rejects(
    fetchValidatedSource(source, {
      now,
      fetchImpl: async () => new Response('{}', {
        headers: { 'Content-Type': 'text/html' },
      }),
    }),
    /unexpected Content-Type text\/html/,
  );
  await assert.rejects(
    fetchValidatedSource(source, {
      now,
      fetchImpl: async () => new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(source.maxBytes + 1),
        },
      }),
    }),
    /response exceeds/,
  );
  let called = false;
  await assert.rejects(
    fetchValidatedSource({ ...source, url: 'https://evil.example/prediction.json' }, {
      now,
      fetchImpl: async () => {
        called = true;
        return new Response('{}');
      },
    }),
    /not allowlisted/,
  );
  assert.equal(called, false);
});

test('each upstream has a source-specific response ceiling below the global emergency limit', () => {
  assert.deepEqual(UPSTREAMS.map((source) => source.maxBytes), [
    256 * 1024,
    4 * 1024 * 1024,
    1 * 1024 * 1024,
    512 * 1024,
    1 * 1024 * 1024,
  ]);
  assert.ok(UPSTREAMS.every((source) => source.maxBytes <= MAX_RESPONSE_BYTES));
});

test('an incomplete refresh with no valid prior source never writes a partial bundle', async () => {
  const payloads = validPayloads();
  payloads['prediction.json'].prediction.within_24h = 2;
  const kv = createKv();
  const fetchImpl = async (url) => {
    const source = UPSTREAMS.find((candidate) => candidate.url === url);
    return new Response(JSON.stringify(payloads[source.name]), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    refreshBundle(
      { DATA_MIRROR: kv },
      { fetchImpl, now: () => new Date('2026-08-11T00:00:00Z') },
    ),
    /no valid data for: prediction.json/,
  );
  assert.equal(kv.writes.length, 0);
});

test('a serialized bundle exceeding the KV value byte limit is never written', async () => {
  const payloads = validPayloads();
  const kv = createKv();
  const fetchImpl = async (url) => {
    const source = UPSTREAMS.find((candidate) => candidate.url === url);
    return new Response(JSON.stringify(payloads[source.name]), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(refreshBundle(
    { DATA_MIRROR: kv },
    {
      fetchImpl,
      maxKvValueBytes: 128,
      now: () => new Date('2026-08-11T00:00:00Z'),
    },
  ), /serialized bundle exceeds 128 bytes/);
  assert.equal(kv.writes.length, 0);
});

test('a transient network failure is retried once and can recover', async () => {
  const source = UPSTREAMS[0];
  const payload = validPayloads()['prediction.json'];
  let attempts = 0;
  const result = await fetchValidatedSource(source, {
    now: () => new Date('2026-08-11T00:00:00Z'),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, payload);
});

test('a transient 5xx response is retried once and can recover', async () => {
  const source = UPSTREAMS[0];
  const payload = validPayloads()['prediction.json'];
  let attempts = 0;
  const result = await fetchValidatedSource(source, {
    now: () => new Date('2026-08-11T00:00:00Z'),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('temporary outage', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, payload);
});

test('each network attempt has a bounded timeout and a timeout is retried only once', async () => {
  const source = UPSTREAMS[0];
  let attempts = 0;
  await assert.rejects(
    fetchValidatedSource(source, {
      timeoutMs: 5,
      now: () => new Date('2026-08-11T00:00:00Z'),
      fetchImpl: async (_url, options) => {
        attempts += 1;
        assert.ok(options.signal, 'the upstream request must carry an AbortSignal');
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      },
    }),
    /timed out after 5ms/,
  );
  assert.equal(attempts, 2);
});

test('4xx, redirects, invalid JSON and invalid schemas are never retried', async () => {
  const source = UPSTREAMS[0];
  const valid = validPayloads()['prediction.json'];
  const cases = [
    {
      label: '4xx',
      response: () => new Response('not found', { status: 404 }),
      error: /HTTP 404/,
    },
    {
      label: 'redirect',
      response: () => new Response(null, {
        status: 302,
        headers: { Location: source.url },
      }),
      error: /redirects are not allowed/,
    },
    {
      label: 'invalid JSON',
      response: () => new Response('{broken', {
        headers: { 'Content-Type': 'application/json' },
      }),
      error: /invalid JSON/,
    },
    {
      label: 'invalid schema',
      response: () => new Response(JSON.stringify({
        ...valid,
        prediction: { ...valid.prediction, within_24h: 3 },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }),
      error: /probability/,
    },
  ];

  for (const testCase of cases) {
    let attempts = 0;
    await assert.rejects(fetchValidatedSource(source, {
      now: () => new Date('2026-08-11T00:00:00Z'),
      fetchImpl: async () => {
        attempts += 1;
        return testCase.response();
      },
    }), testCase.error, testCase.label);
    assert.equal(attempts, 1, testCase.label);
  }
});
