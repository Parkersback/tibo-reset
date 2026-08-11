import { canonicalizePayload, validatePayload } from './validators.js';
import {
  BUNDLE_KEY,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CACHED_SOURCE_AGE_MS,
  MAX_KV_VALUE_BYTES,
  MAX_RESPONSE_BYTES,
  PAGES_SYNC_STATUS_URL,
  UPSTREAMS,
} from './config.js';
const USER_AGENT = 'TiboResetEdgeMirror/1.0';
const PRODUCTION_ORIGIN = 'https://parkersback.github.io';

const ALLOWED_SOURCES_BY_NAME = new Map(UPSTREAMS.map((source) => [source.name, source]));
const PAGES_SYNC_STATUS_MAX_BYTES = 64 * 1024;

export function isAllowedOrigin(origin) {
  if (origin === PRODUCTION_ORIGIN) {
    return true;
  }
  if (typeof origin !== 'string' || origin === 'null') {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

function corsHeaders(origin) {
  return origin && isAllowedOrigin(origin)
    ? { 'Access-Control-Allow-Origin': origin }
    : {};
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  return new Response(JSON.stringify(payload), { status, headers });
}

function jsonTextResponse(text, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  return new Response(text, { status, headers });
}

function assertAllowedSource(source, requestedUrl = source?.url) {
  const canonicalSource = source ? ALLOWED_SOURCES_BY_NAME.get(source.name) : null;
  if (canonicalSource !== source
    || (requestedUrl !== source.url && requestedUrl !== source.fallbackUrl)) {
    throw new TypeError('upstream source is not allowlisted');
  }
  const parsed = new URL(requestedUrl);
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || (parsed.port !== '' && parsed.port !== '443')) {
    throw new TypeError(`${source.name}: upstream must be exact HTTPS`);
  }
}

function mediaType(response) {
  return (response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
}

async function readBoundedUtf8(response, maximumBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength && /^\d+$/u.test(declaredLength)
    && Number(declaredLength) > maximumBytes) {
    throw new RangeError(`response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) {
    throw new TypeError('upstream response body is empty');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('response too large');
        throw new RangeError(`response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

class RetryableUpstreamError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RetryableUpstreamError';
  }
}

async function fetchValidatedAttempt(
  source,
  {
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    url = source.url,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  } = {},
) {
  assertAllowedSource(source, url);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError(`${source.name}: timeoutMs must be within 1..30000`);
  }
  const controller = new AbortController();
  const timeout = setTimeoutImpl(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RetryableUpstreamError(
          `${source.name}: request timed out after ${timeoutMs}ms`,
          { cause: error },
        );
      }
      throw new RetryableUpstreamError(`${source.name}: network request failed`, {
        cause: error,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new TypeError(`${source.name}: redirects are not allowed`);
    }
    if (response.status >= 500 && response.status <= 599) {
      throw new RetryableUpstreamError(`${source.name}: HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new TypeError(`${source.name}: HTTP ${response.status}`);
    }
    if (response.url && response.url !== url) {
      throw new TypeError(`${source.name}: response URL changed`);
    }
    const type = mediaType(response);
    if (!source.contentTypes.includes(type)) {
      throw new TypeError(`${source.name}: unexpected Content-Type ${type || '<missing>'}`);
    }
    let text;
    try {
      text = await readBoundedUtf8(response, source.maxBytes);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RetryableUpstreamError(
          `${source.name}: request timed out after ${timeoutMs}ms`,
          { cause: error },
        );
      }
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new TypeError(`${source.name}: invalid JSON`, { cause: error });
    }
    payload = canonicalizePayload(source, payload);
    validatePayload(source, payload, now());
    return payload;
  } finally {
    clearTimeoutImpl(timeout);
  }
}

export async function fetchValidatedSource(
  source,
  options = {},
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchValidatedAttempt(source, options);
    } catch (error) {
      if (!(error instanceof RetryableUpstreamError) || attempt === 1) {
        throw error;
      }
    }
  }
  throw new Error(`${source.name}: unreachable retry state`);
}

async function fetchPagesSyncStatusAttempt(
  {
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {},
) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(PAGES_SYNC_STATUS_URL, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RetryableUpstreamError(
          `sync-status.json: request timed out after ${timeoutMs}ms`,
          { cause: error },
        );
      }
      throw new RetryableUpstreamError('sync-status.json: network request failed', {
        cause: error,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new TypeError('sync-status.json: redirects are not allowed');
    }
    if (response.status >= 500 && response.status <= 599) {
      throw new RetryableUpstreamError(`sync-status.json: HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new TypeError(`sync-status.json: HTTP ${response.status}`);
    }
    if (response.url && response.url !== PAGES_SYNC_STATUS_URL) {
      throw new TypeError('sync-status.json: response URL changed');
    }
    if (mediaType(response) !== 'application/json') {
      throw new TypeError('sync-status.json: unexpected Content-Type');
    }
    const text = await readBoundedUtf8(response, PAGES_SYNC_STATUS_MAX_BYTES);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new TypeError('sync-status.json: invalid JSON', { cause: error });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.schema !== 1
      || payload.overall_status !== 'ok'
      || !Array.isArray(payload.sources)
      || payload.sources.length !== UPSTREAMS.length) {
      throw new TypeError('sync-status.json: invalid status document');
    }
    const attemptDate = now();
    if (!(attemptDate instanceof Date) || !Number.isFinite(attemptDate.getTime())) {
      throw new TypeError('sync-status.json: now() must return a valid Date');
    }
    const syncedAtMs = Date.parse(payload.synced_at);
    const ageMs = attemptDate.getTime() - syncedAtMs;
    if (!Number.isFinite(syncedAtMs)
      || ageMs < 0
      || ageMs > MAX_CACHED_SOURCE_AGE_MS) {
      throw new TypeError('sync-status.json: mirror is stale or has an invalid timestamp');
    }
    const statuses = new Map();
    for (const source of UPSTREAMS) {
      const matches = payload.sources.filter((entry) => entry?.name === source.name);
      const entry = matches[0];
      if (matches.length !== 1 || entry.url !== source.url || entry.status !== 'fresh') {
        throw new TypeError(`sync-status.json: ${source.name} is not a fresh exact source`);
      }
      statuses.set(source.name, entry.status);
    }
    return {
      syncedAt: new Date(syncedAtMs).toISOString().replace('.000Z', 'Z'),
      statuses,
    };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function fetchPagesSyncStatus(options = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchPagesSyncStatusAttempt(options);
    } catch (error) {
      if (!(error instanceof RetryableUpstreamError) || attempt === 1) {
        throw error;
      }
    }
  }
  throw new Error('sync-status.json: unreachable retry state');
}

function isoNow(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('now() must return a valid Date');
  }
  return value.toISOString().replace('.000Z', 'Z');
}

function safeError(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 240);
}

function reusableCachedSource(oldBundle, source, attemptDate) {
  const sourceStatus = Array.isArray(oldBundle?.sources)
    ? oldBundle.sources.find((entry) => entry?.name === source.name)
    : null;
  const fetchedAt = sourceStatus?.fetched_at;
  const fetchedAtMs = typeof fetchedAt === 'string' ? Date.parse(fetchedAt) : Number.NaN;
  const ageMs = attemptDate.getTime() - fetchedAtMs;
  if (!Number.isFinite(fetchedAtMs)
    || ageMs < 0
    || ageMs > MAX_CACHED_SOURCE_AGE_MS) {
    return null;
  }
  const payload = oldBundle?.data?.[source.dataKey];
  return payload === undefined ? null : { payload, fetchedAt };
}

export async function refreshBundle(
  env,
  {
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxKvValueBytes = MAX_KV_VALUE_BYTES,
  } = {},
) {
  if (!env || !env.DATA_MIRROR) {
    throw new TypeError('DATA_MIRROR KV binding is required');
  }
  const attemptedAt = isoNow(now);
  const attemptDate = new Date(attemptedAt);
  const attemptNow = () => new Date(attemptDate.getTime());
  const oldText = await env.DATA_MIRROR.get(BUNDLE_KEY);
  let oldBundle = null;
  if (typeof oldText === 'string') {
    try {
      oldBundle = JSON.parse(oldText);
    } catch {
      oldBundle = null;
    }
  }
  const results = await Promise.allSettled(UPSTREAMS.map((source) => (
    fetchValidatedSource(source, { fetchImpl, now: attemptNow, timeoutMs })
  )));
  const data = {};
  const sourceStatuses = new Array(UPSTREAMS.length);
  const unresolved = [];

  results.forEach((result, index) => {
    const source = UPSTREAMS[index];
    if (result.status === 'fulfilled') {
      data[source.dataKey] = result.value;
      sourceStatuses[index] = {
        name: source.name,
        url: source.url,
        status: 'fresh',
        fetched_at: attemptedAt,
        error: null,
      };
      return;
    }
    const cached = reusableCachedSource(oldBundle, source, attemptDate);
    if (cached) {
      try {
        validatePayload(source, cached.payload, attemptNow());
        data[source.dataKey] = cached.payload;
        sourceStatuses[index] = {
          name: source.name,
          url: source.url,
          status: 'cached',
          fetched_at: cached.fetchedAt,
          error: safeError(result.reason),
        };
        return;
      } catch {
        // An invalid cached value is deliberately treated as missing.
      }
    }
    unresolved.push({ index, upstreamError: result.reason });
    sourceStatuses[index] = {
      name: source.name,
      url: source.url,
      status: 'failed',
      error: safeError(result.reason),
    };
  });

  if (unresolved.length) {
    let mirrorStatus = null;
    let mirrorStatusError = null;
    try {
      mirrorStatus = await fetchPagesSyncStatus({
        fetchImpl,
        now: attemptNow,
        timeoutMs,
      });
    } catch (error) {
      mirrorStatusError = error;
    }
    if (mirrorStatus) {
      const mirrorResults = await Promise.allSettled(unresolved.map(({ index }) => {
        const source = UPSTREAMS[index];
        if (mirrorStatus.statuses.get(source.name) !== 'fresh') {
          return Promise.reject(new TypeError(`${source.name}: Pages mirror is not fresh`));
        }
        return fetchValidatedSource(source, {
          fetchImpl,
          now: attemptNow,
          timeoutMs,
          url: source.fallbackUrl,
        });
      }));
      mirrorResults.forEach((result, resultIndex) => {
        const { index, upstreamError } = unresolved[resultIndex];
        const source = UPSTREAMS[index];
        if (result.status === 'fulfilled') {
          data[source.dataKey] = result.value;
          sourceStatuses[index] = {
            name: source.name,
            url: source.url,
            status: 'cached',
            fetched_at: mirrorStatus.syncedAt,
            error: safeError(upstreamError),
          };
          return;
        }
        sourceStatuses[index].error = safeError(new Error(
          `${safeError(upstreamError)}; Pages fallback: ${safeError(result.reason)}`,
        ));
      });
    } else if (mirrorStatusError) {
      unresolved.forEach(({ index, upstreamError }) => {
        sourceStatuses[index].error = safeError(new Error(
          `${safeError(upstreamError)}; Pages fallback: ${safeError(mirrorStatusError)}`,
        ));
      });
    }
  }

  const missing = sourceStatuses
    .filter((source) => source.status === 'failed')
    .map((source) => source.name);
  if (missing.length) {
    const failures = sourceStatuses
      .filter((source) => source.status === 'failed')
      .map((source) => `${source.name}: ${source.error}`)
      .join('; ');
    throw new Error(
      `refresh incomplete; no valid data for: ${missing.join(', ')}${failures ? ` (${failures})` : ''}`,
    );
  }
  const oldestFetchedAtMs = Math.min(...sourceStatuses.map((source) => (
    Date.parse(source.fetched_at)
  )));
  const syncedAt = new Date(oldestFetchedAtMs).toISOString().replace('.000Z', 'Z');
  const bundle = {
    schema: 1,
    attempted_at: attemptedAt,
    synced_at: syncedAt,
    overall_status: sourceStatuses.every((source) => source.status === 'fresh')
      ? 'ok'
      : 'degraded',
    sources: sourceStatuses,
    data,
  };
  if (!Number.isInteger(maxKvValueBytes) || maxKvValueBytes < 1
    || maxKvValueBytes > MAX_KV_VALUE_BYTES) {
    throw new TypeError(`maxKvValueBytes must be within 1..${MAX_KV_VALUE_BYTES}`);
  }
  const serializedBundle = JSON.stringify(bundle);
  const bundleBytes = new TextEncoder().encode(serializedBundle).byteLength;
  if (bundleBytes > maxKvValueBytes) {
    throw new RangeError(`serialized bundle exceeds ${maxKvValueBytes} bytes`);
  }
  await env.DATA_MIRROR.put(BUNDLE_KEY, serializedBundle, {
    metadata: {
      schema: 1,
      overall_status: bundle.overall_status,
      synced_at: bundle.synced_at,
      source_count: sourceStatuses.length,
    },
  });
  return bundle;
}

export class RefreshCoordinator {
  constructor(state, env, { refreshImpl = refreshBundle } = {}) {
    this.state = state;
    this.env = env;
    this.refreshImpl = refreshImpl;
    this.inFlight = null;
  }

  runRefresh() {
    if (this.inFlight) {
      return this.inFlight;
    }
    const task = Promise.resolve().then(() => this.refreshImpl(this.env));
    this.inFlight = task;
    task.then(
      () => {
        if (this.inFlight === task) {
          this.inFlight = null;
        }
      },
      () => {
        if (this.inFlight === task) {
          this.inFlight = null;
        }
      },
    );
    return task;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/refresh') {
      return jsonResponse({ schema: 1, status: 'not_found' }, 404);
    }
    if (request.method !== 'POST') {
      return jsonResponse({ schema: 1, status: 'method_not_allowed' }, 405, {
        Allow: 'POST',
      });
    }
    try {
      const bundle = await this.runRefresh();
      return jsonResponse({
        schema: 1,
        status: bundle.overall_status,
        attempted_at: bundle.attempted_at,
      });
    } catch (error) {
      return jsonResponse({
        schema: 1,
        status: 'failed',
        error: safeError(error),
      }, 503);
    }
  }
}

async function requestCoordinatedRefresh(env) {
  if (!env?.REFRESH_COORDINATOR) {
    throw new TypeError('REFRESH_COORDINATOR Durable Object binding is required');
  }
  const id = env.REFRESH_COORDINATOR.idFromName('global-v1');
  const stub = env.REFRESH_COORDINATOR.get(id);
  const response = await stub.fetch(new Request('https://refresh.internal/refresh', {
    method: 'POST',
  }));
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/gu, ' ').trim().slice(0, 300);
    throw new Error(
      `coordinated refresh failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
}

export function createWorker() {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const knownPath = url.pathname === '/v1/bundle.json' || url.pathname === '/health';
      const origin = request.headers.get('Origin');
      if (origin && !isAllowedOrigin(origin)) {
        return jsonResponse({ schema: 1, status: 'forbidden' }, 403);
      }
      if (!knownPath) {
        return jsonResponse({ schema: 1, status: 'not_found' }, 404, corsHeaders(origin));
      }
      if (request.method === 'OPTIONS') {
        if (!origin || request.headers.get('Access-Control-Request-Method') !== 'GET') {
          return jsonResponse({ schema: 1, status: 'method_not_allowed' }, 405, {
            Allow: 'GET, OPTIONS',
            ...corsHeaders(origin),
          });
        }
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Methods': 'GET',
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Max-Age': '600',
            'Cache-Control': 'no-store',
            Vary: 'Origin',
          },
        });
      }
      if (request.method !== 'GET') {
        return jsonResponse({ schema: 1, status: 'method_not_allowed' }, 405, {
          Allow: 'GET, OPTIONS',
          ...corsHeaders(origin),
        });
      }
      if (url.pathname === '/v1/bundle.json') {
        const value = await env.DATA_MIRROR.get(BUNDLE_KEY);
        if (value === null) {
          return jsonResponse({
            schema: 1,
            status: 'empty',
            error: 'data mirror is not initialized',
          }, 503, corsHeaders(origin));
        }
        return jsonTextResponse(value, 200, corsHeaders(origin));
      }
      const entry = typeof env.DATA_MIRROR.getWithMetadata === 'function'
        ? await env.DATA_MIRROR.getWithMetadata(BUNDLE_KEY, { type: 'text' })
        : { value: await env.DATA_MIRROR.get(BUNDLE_KEY), metadata: null };
      if (entry.value === null) {
        return jsonResponse({
          schema: 1,
          status: 'empty',
          error: 'data mirror is not initialized',
        }, 503, corsHeaders(origin));
      }
      const metadata = entry.metadata;
      const healthy = metadata
        && metadata.schema === 1
        && ['ok', 'degraded'].includes(metadata.overall_status)
        && typeof metadata.synced_at === 'string'
        && metadata.source_count === UPSTREAMS.length;
      if (!healthy) {
        return jsonResponse({
          schema: 1,
          status: 'corrupt',
          error: 'stored bundle is invalid',
        }, 503, corsHeaders(origin));
      }
      return jsonResponse({
        schema: 1,
        status: metadata.overall_status,
        overall_status: metadata.overall_status,
        synced_at: metadata.synced_at,
        source_count: metadata.source_count,
      }, 200, corsHeaders(origin));
    },
    scheduled(_controller, env, context) {
      context.waitUntil(requestCoordinatedRefresh(env));
    },
  };
}

export default createWorker();
