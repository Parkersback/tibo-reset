export const TWEET_PUBLIC_FIELDS = Object.freeze([
  'timestamp',
  'author',
  'text',
  'source',
  'url',
  'authority_score',
]);

const TIBO_AUTHORS = new Set(['Tibo', 'thsottiaux']);
const OFFICIAL_TWEET_SOURCES = new Set([
  'openai_rss',
  'openai_status',
  'status_rss',
  'release_rss',
]);
const OFFICIAL_AUTHORS = new Set([
  'OpenAI',
  'OpenAI Status',
  'OpenAI News',
  'OpenAI Developers',
  'ChatGPT',
  '@OpenAI',
  '@OpenAIDevs',
  '@ChatGPTapp',
]);
const OFFICIAL_X_HANDLES_BY_AUTHOR = new Map([
  ['OpenAI', new Set(['openai'])],
  ['OpenAI Status', new Set(['openai'])],
  ['OpenAI News', new Set(['openai'])],
  ['@OpenAI', new Set(['openai'])],
  ['OpenAI Developers', new Set(['openaidevs'])],
  ['@OpenAIDevs', new Set(['openaidevs'])],
  ['ChatGPT', new Set(['chatgptapp'])],
  ['@ChatGPTapp', new Set(['chatgptapp'])],
]);

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

function requireString(value, label, maximum, minimum = 1) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label}: expected string length ${minimum}..${maximum}`);
  }
  return value;
}

function requireProbability(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label}: expected probability in range 0..1`);
  }
  return value;
}

function requireInteger(value, label, minimum = 0, maximum = 10_000_000) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label}: expected integer ${minimum}..${maximum}`);
  }
  return value;
}

function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label}: expected object`);
  }
  return value;
}

function requireKeys(value, keys, label) {
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) {
    throw new TypeError(`${label}: missing required keys: ${missing.join(', ')}`);
  }
}

function parseIsoTimestamp(value, label) {
  const text = requireString(value, label, 64);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) {
    throw new TypeError(`${label}: timestamp must include a timezone`);
  }
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${label}: invalid ISO timestamp`);
  }
  return milliseconds;
}

function hostIs(hostname, allowedDomain) {
  return hostname === allowedDomain || hostname.endsWith(`.${allowedDomain}`);
}

function validateHttpsUrl(value, label) {
  const text = requireString(value, label, 2_048);
  if (/\s/u.test(text)) {
    throw new TypeError(`${label}: whitespace is not allowed`);
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError(`${label}: invalid URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || (parsed.port !== '' && parsed.port !== '443')
  ) {
    throw new TypeError(`${label}: expected a public HTTPS URL`);
  }
  return parsed;
}

function xStatusHandle(parsed) {
  const hostname = parsed.hostname.toLowerCase();
  if (!['x.com', 'twitter.com'].some((domain) => hostIs(hostname, domain))) {
    return null;
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/status\/([0-9]+)\/?$/u);
  return match ? match[1].toLowerCase() : null;
}

export function canonicalizePayload(source, payload) {
  if (source.name !== 'tweets.json' || !Array.isArray(payload)) {
    return payload;
  }
  return payload.map((item) => {
    if (!isPlainObject(item)) {
      return item;
    }
    const excerpt = {};
    for (const field of TWEET_PUBLIC_FIELDS) {
      let value = item[field];
      if (typeof value === 'string') {
        value = normalizeWhitespace(value);
      }
      if (field === 'text' && typeof value === 'string' && value.length > 360) {
        value = `${value.slice(0, 360).trimEnd()}…`;
      }
      excerpt[field] = value;
    }
    return excerpt;
  });
}

function validateTweets(payload, now) {
  const expectedFields = new Set(TWEET_PUBLIC_FIELDS);
  const futureLimit = now.getTime() + 24 * 60 * 60 * 1_000;
  payload.forEach((item, index) => {
    const label = `tweets.json item ${index}`;
    if (!isPlainObject(item) || Object.keys(item).length !== expectedFields.size
      || Object.keys(item).some((key) => !expectedFields.has(key))) {
      throw new TypeError(`${label}: unexpected public fields`);
    }
    const timestamp = parseIsoTimestamp(item.timestamp, `${label}.timestamp`);
    if (timestamp > futureLimit) {
      throw new TypeError(`${label}.timestamp: more than 24 hours in future`);
    }
    const author = requireString(item.author, `${label}.author`, 100);
    const text = requireString(item.text, `${label}.text`, 361);
    const sourceName = requireString(item.source, `${label}.source`, 32);
    const url = requireString(item.url, `${label}.url`, 2_048);
    for (const [field, value] of Object.entries({
      timestamp: item.timestamp,
      author,
      text,
      source: sourceName,
      url,
    })) {
      if (value !== normalizeWhitespace(value)) {
        throw new TypeError(`${label}.${field}: whitespace is not normalized`);
      }
    }
    if (text.length === 361 && !text.endsWith('…')) {
      throw new TypeError(`${label}.text: oversized excerpt`);
    }
    const parsedUrl = validateHttpsUrl(url, `${label}.url`);
    const hostname = parsedUrl.hostname.toLowerCase();
    const statusHandle = xStatusHandle(parsedUrl);
    requireProbability(item.authority_score, `${label}.authority_score`);
    if (sourceName === 'tibo_rss') {
      if (!TIBO_AUTHORS.has(author)
        || statusHandle !== 'thsottiaux') {
        throw new TypeError(`${label}: invalid tibo_rss author or url`);
      }
    } else if (sourceName === 'community_rss') {
      if (!hostIs(hostname, 'reddit.com')) {
        throw new TypeError(`${label}.url: community_rss requires reddit.com`);
      }
    } else if (OFFICIAL_TWEET_SOURCES.has(sourceName)) {
      const isOpenAiHost = hostIs(hostname, 'openai.com');
      const allowedHandles = OFFICIAL_X_HANDLES_BY_AUTHOR.get(author);
      const isKnownXStatus = statusHandle !== null && allowedHandles?.has(statusHandle);
      if (!OFFICIAL_AUTHORS.has(author) || (!isOpenAiHost && !isKnownXStatus)) {
        throw new TypeError(`${label}: invalid official author or url`);
      }
    } else {
      throw new TypeError(`${label}.source: source is not allowlisted`);
    }
  });
}

function validatePrediction(value, label) {
  const prediction = requireObject(value, label);
  const horizons = ['within_5h', 'within_24h', 'within_48h'];
  requireKeys(prediction, horizons, label);
  for (const horizon of horizons) {
    requireProbability(prediction[horizon], `${label}.${horizon}`);
  }
}

function validatePredictionDocument(payload) {
  requireKeys(payload, ['updated_at', 'prediction'], 'prediction.json');
  parseIsoTimestamp(payload.updated_at, 'prediction.json.updated_at');
  validatePrediction(payload.prediction, 'prediction.json.prediction');
  if (Object.hasOwn(payload, 'confidence')
    && !['low', 'medium', 'high'].includes(payload.confidence)) {
    throw new TypeError('prediction.json.confidence: unexpected value');
  }
  if (Object.hasOwn(payload, 'signals')) {
    requireObject(payload.signals, 'prediction.json.signals');
    if (Object.keys(payload.signals).length > 200) {
      throw new TypeError('prediction.json.signals: expected a bounded object');
    }
  }
  if (Object.hasOwn(payload, 'main_factors')) {
    if (!Array.isArray(payload.main_factors) || payload.main_factors.length > 100) {
      throw new TypeError('prediction.json.main_factors: expected bounded array');
    }
    payload.main_factors.forEach((factor, index) => {
      requireObject(factor, `prediction.json.main_factors item ${index}`);
      if (Object.hasOwn(factor, 'factor')) {
        requireString(factor.factor, `prediction.json.main_factors item ${index}.factor`, 500);
      }
    });
  }
  if (Object.hasOwn(payload, 'reasons')) {
    if (!Array.isArray(payload.reasons) || payload.reasons.length > 100) {
      throw new TypeError('prediction.json.reasons: expected bounded array');
    }
    payload.reasons.forEach((reason, index) => {
      requireString(reason, `prediction.json.reasons item ${index}`, 1_000);
    });
  }
}

function validatePredictionHistory(payload) {
  payload.forEach((item, index) => {
    const label = `prediction_history.json item ${index}`;
    requireObject(item, label);
    requireKeys(item, ['prediction_time', 'prediction'], label);
    parseIsoTimestamp(item.prediction_time, `${label}.prediction_time`);
    validatePrediction(item.prediction, `${label}.prediction`);
    if (Object.hasOwn(item, 'signals')) {
      requireObject(item.signals, `${label}.signals`);
      if (Object.keys(item.signals).length > 200) {
        throw new TypeError(`${label}.signals: expected a bounded object`);
      }
    }
    if (Object.hasOwn(item, 'actual_result')
      && item.actual_result !== null
      && typeof item.actual_result !== 'boolean') {
      throw new TypeError(`${label}.actual_result: expected boolean or null`);
    }
    if (Object.hasOwn(item, 'resolved_at') && item.resolved_at !== null) {
      parseIsoTimestamp(item.resolved_at, `${label}.resolved_at`);
    }
  });
}

function validatePerformance(payload) {
  const required = [
    'total_predictions',
    'resolved_predictions',
    'overall_brier_score',
    'overall_accuracy',
    'horizons',
    'updated_at',
  ];
  requireKeys(payload, required, 'model_performance.json');
  const total = requireInteger(
    payload.total_predictions,
    'model_performance.json.total_predictions',
  );
  const resolved = requireInteger(
    payload.resolved_predictions,
    'model_performance.json.resolved_predictions',
  );
  if (resolved > total) {
    throw new TypeError('model_performance.json.resolved_predictions: exceeds total_predictions');
  }
  requireProbability(payload.overall_brier_score, 'model_performance.json.overall_brier_score');
  requireProbability(payload.overall_accuracy, 'model_performance.json.overall_accuracy');
  parseIsoTimestamp(payload.updated_at, 'model_performance.json.updated_at');
  if (!Array.isArray(payload.horizons)
    || payload.horizons.length < 1
    || payload.horizons.length > 24) {
    throw new TypeError('model_performance.json.horizons: expected array length 1..24');
  }
  const seenHours = new Set();
  payload.horizons.forEach((horizon, index) => {
    const label = `model_performance.json.horizons item ${index}`;
    requireObject(horizon, label);
    requireKeys(horizon, ['horizon_hours', 'total', 'brier_score', 'accuracy'], label);
    const hours = requireInteger(horizon.horizon_hours, `${label}.horizon_hours`, 1, 8_760);
    if (seenHours.has(hours)) {
      throw new TypeError(`${label}.horizon_hours: duplicate value`);
    }
    seenHours.add(hours);
    const horizonTotal = requireInteger(horizon.total, `${label}.total`);
    if (horizonTotal > total) {
      throw new TypeError(`${label}.total: exceeds total_predictions`);
    }
    requireProbability(horizon.brier_score, `${label}.brier_score`);
    requireProbability(horizon.accuracy, `${label}.accuracy`);
    if (Object.hasOwn(horizon, 'calibration_error')) {
      requireProbability(horizon.calibration_error, `${label}.calibration_error`);
    }
    if (Object.hasOwn(horizon, 'bins')) {
      if (!Array.isArray(horizon.bins) || horizon.bins.length > 100) {
        throw new TypeError(`${label}.bins: expected bounded array`);
      }
      horizon.bins.forEach((bin, binIndex) => {
        const binLabel = `${label}.bins item ${binIndex}`;
        requireObject(bin, binLabel);
        requireKeys(bin, [
          'bin_start',
          'bin_end',
          'predicted_mean',
          'actual_frequency',
          'count',
        ], binLabel);
        const start = requireProbability(bin.bin_start, `${binLabel}.bin_start`);
        const end = requireProbability(bin.bin_end, `${binLabel}.bin_end`);
        if (end < start) {
          throw new TypeError(`${binLabel}: bin_end precedes bin_start`);
        }
        requireProbability(bin.predicted_mean, `${binLabel}.predicted_mean`);
        if (bin.actual_frequency !== null) {
          requireProbability(bin.actual_frequency, `${binLabel}.actual_frequency`);
        }
        requireInteger(bin.count, `${binLabel}.count`);
      });
    }
  });
}

function validateResetHistory(payload) {
  payload.forEach((item, index) => {
    const label = `reset_history.json item ${index}`;
    requireObject(item, label);
    requireKeys(item, ['reset_time', 'source', 'confidence', 'notes'], label);
    parseIsoTimestamp(item.reset_time, `${label}.reset_time`);
    requireString(item.source, `${label}.source`, 64);
    requireProbability(item.confidence, `${label}.confidence`);
    requireString(item.notes, `${label}.notes`, 500);
  });
}

export function validatePayload(source, payload, now = new Date()) {
  const expectedArray = source.expectedType === 'array';
  if ((expectedArray && !Array.isArray(payload)) || (!expectedArray && !isPlainObject(payload))) {
    throw new TypeError(`${source.name}: unexpected top-level type`);
  }
  if (expectedArray && Number.isInteger(source.maxItems) && payload.length > source.maxItems) {
    throw new TypeError(`${source.name}: expected at most ${source.maxItems} items`);
  }
  switch (source.name) {
    case 'prediction.json':
      validatePredictionDocument(payload);
      break;
    case 'prediction_history.json':
      validatePredictionHistory(payload);
      break;
    case 'tweets.json':
      validateTweets(payload, now);
      break;
    case 'model_performance.json':
      validatePerformance(payload);
      break;
    case 'reset_history.json':
      validateResetHistory(payload);
      break;
    default:
      throw new TypeError(`${source.name}: source is not allowlisted`);
  }
  return payload;
}
