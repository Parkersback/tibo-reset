export const BUNDLE_KEY = 'tibo-reset:bundle:v1:current';
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_CACHED_SOURCE_AGE_MS = 2 * 60 * 60 * 1_000;
export const MAX_KV_VALUE_BYTES = 25 * 1024 * 1024;
export const PAGES_SYNC_STATUS_URL = 'https://parkersback.github.io/tibo-reset/data/sync-status.json';

const PAGES_DATA_BASE_URL = 'https://parkersback.github.io/tibo-reset/data/';

export const UPSTREAMS = Object.freeze([
  Object.freeze({
    name: 'prediction.json',
    dataKey: 'prediction',
    url: 'https://willtiboreset.xyz/data/prediction.json',
    fallbackUrl: `${PAGES_DATA_BASE_URL}prediction.json`,
    expectedType: 'object',
    maxItems: null,
    maxBytes: 256 * 1024,
    contentTypes: Object.freeze(['application/json']),
  }),
  Object.freeze({
    name: 'prediction_history.json',
    dataKey: 'predictionHistory',
    url: 'https://willtiboreset.xyz/data/prediction_history.json',
    fallbackUrl: `${PAGES_DATA_BASE_URL}prediction_history.json`,
    expectedType: 'array',
    maxItems: 10_000,
    maxBytes: 4 * 1024 * 1024,
    contentTypes: Object.freeze(['application/json']),
  }),
  Object.freeze({
    name: 'tweets.json',
    dataKey: 'tweets',
    url: 'https://willtiboreset.xyz/data/tweets.json',
    fallbackUrl: `${PAGES_DATA_BASE_URL}tweets.json`,
    expectedType: 'array',
    maxItems: 500,
    maxBytes: 1 * 1024 * 1024,
    contentTypes: Object.freeze(['application/json']),
  }),
  Object.freeze({
    name: 'model_performance.json',
    dataKey: 'performance',
    url: 'https://willtiboreset.xyz/data/model_performance.json',
    fallbackUrl: `${PAGES_DATA_BASE_URL}model_performance.json`,
    expectedType: 'object',
    maxItems: null,
    maxBytes: 512 * 1024,
    contentTypes: Object.freeze(['application/json']),
  }),
  Object.freeze({
    name: 'reset_history.json',
    dataKey: 'resetHistory',
    url: 'https://raw.githubusercontent.com/EvanProgramming/willtiboreset/main/data/reset_history.json',
    fallbackUrl: `${PAGES_DATA_BASE_URL}reset_history.json`,
    expectedType: 'array',
    maxItems: 2_000,
    maxBytes: 1 * 1024 * 1024,
    // raw.githubusercontent.com currently serves JSON files as text/plain.
    contentTypes: Object.freeze(['application/json', 'text/plain']),
  }),
]);
