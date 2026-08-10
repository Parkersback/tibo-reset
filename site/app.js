(function (root, factory) {
  'use strict';

  var controller = factory(root);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = controller;
  }

  if (root) {
    root.TiboResetController = controller;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', controller.init, { once: true });
    } else {
      controller.init();
    }
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var LANGUAGE_KEY = 'tibo-reset-language';
  var NOTIFICATION_KEY = 'tibo-reset-notifications';
  var REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  var STALE_AFTER_MS = 90 * 60 * 1000;
  var MAX_HISTORY_POINTS = 160;

  var DATA_SOURCES = Object.freeze([
    './data/prediction.json',
    './data/prediction_history.json',
    './data/tweets.json',
    './data/model_performance.json',
    './data/reset_history.json',
    './data/sync-status.json'
  ]);

  var DATA_KEYS = Object.freeze([
    'prediction',
    'predictionHistory',
    'tweets',
    'performance',
    'resetHistory',
    'syncStatus'
  ]);

  var SIGNAL_POLICIES = Object.freeze({
    tibo: Object.freeze({
      sources: Object.freeze(['tibo_rss']),
      authors: Object.freeze(['tibo', 'thsottiaux']),
      hosts: Object.freeze(['x.com', 'twitter.com'])
    }),
    community: Object.freeze({
      sources: Object.freeze(['community_rss']),
      authors: null,
      hosts: Object.freeze(['reddit.com'])
    }),
    openai: Object.freeze({
      sources: Object.freeze(['openai_rss', 'openai_status', 'status_rss', 'release_rss']),
      authors: Object.freeze([
        'openai',
        '@openai',
        'openai devs',
        'openaidevs',
        '@openaidevs',
        'openai developers',
        'openai status'
      ]),
      hosts: Object.freeze(['x.com', 'twitter.com', 'openai.com'])
    })
  });

  var I18N = Object.freeze({
    'zh-CN': Object.freeze({
      'meta.title': 'Tibo Reset · 深夜重置气象台',
      'meta.description': 'Tibo Reset 是一个非官方的 ChatGPT 与 Codex 额度重置概率观测站。',
      'skip.toContent': '跳到主要内容',
      'brand.homeLabel': 'Tibo Reset 首页',
      'brand.tagline': '深夜重置气象台',
      'status.groupLabel': '数据观测状态',
      'status.detailsLabel': '同步来源错误详情',
      'status.unofficial': '非官方观测',
      'status.loading': '正在读取镜像数据',
      'status.ok': '镜像数据在线',
      'status.stale': '数据可能已过期',
      'status.degraded': '同步降级，部分来源不可用',
      'status.degradedCached': '同步降级，{count} 个来源使用缓存',
      'status.cached': '正在显示缓存数据',
      'status.failed': '同步失败，暂无可用预测',
      'status.failedWithCache': '同步失败，继续显示已有缓存',
      'header.updated': '最近更新',
      'nav.label': '页内导航',
      'nav.forecast': '预报',
      'nav.signals': '信号',
      'nav.history': '轨迹',
      'nav.methodology': '方法',
      'actions.refreshLabel': '刷新本地镜像数据',
      'actions.refresh': '刷新',
      'actions.languageLabel': '切换为英文',
      'actions.language': 'EN',
      'actions.notifyLabel': '开启高概率浏览器提醒',
      'actions.notify': '开启提醒',
      'actions.notifyEnabled': '提醒已开启',
      'actions.shareLabel': '分享当前重置预报',
      'actions.share': '分享预报',
      'common.waiting': '等待数据',
      'common.pending': '待载入',
      'common.unavailable': '暂无数据',
      'common.overdue': '已到预计时间，待更新',
      'forecast.eyebrow': 'RESET WEATHER / 001',
      'forecast.title': '今夜，额度会重置吗？',
      'forecast.subtitle': '综合公开信号与历史间隔，观测额外全局 hard reset 的可能性。',
      'forecast.horizon24': '24 小时概率',
      'forecast.confidence': '信心',
      'forecast.confidencePending': '待校准',
      'forecast.confidenceHigh': '高 / high',
      'forecast.confidenceMedium': '中等 / medium',
      'forecast.confidenceLow': '低 / low',
      'forecast.otherHorizonsLabel': '其他时间窗口',
      'forecast.horizon5': '5 小时',
      'forecast.horizon48': '48 小时',
      'forecast.actionLabel': 'ACTION WINDOW',
      'forecast.actionTitle': '今夜的行动建议',
      'forecast.actionFallback': '正在读取本地镜像，稍后给出行动建议。',
      'forecast.actionCalm': '当前概率较低，可以安心继续使用；仍请留意更新时间。',
      'forecast.actionWatch': '概率进入关注区间，建议留意新的公开信号。',
      'forecast.actionWarning': '概率较高，建议优先使用剩余额度，并关注后续更新。',
      'forecast.actionUnknown': '预测数据暂不可用，请稍后刷新。',
      'forecast.resetLabel': '下次预计重置',
      'forecast.countdownLabel': '距离预计时间',
      'factors.eyebrow': 'PRESSURE MAP / 002',
      'factors.title': '主要影响因素',
      'factors.note': '正向信号抬高预报，负向信号则将其压低。因素正文保留上游原文。',
      'factors.timePressure': '时间周期压力',
      'factors.officialSignal': '官方变更信号',
      'factors.communitySignal': '社区讨论强度',
      'factors.upstreamReason': '上游原因',
      'factors.empty': '上游暂未提供可用因素。',
      'signals.eyebrow': 'SIGNAL ARRAY / 003',
      'signals.title': '当前信号',
      'signals.note': '从本地镜像中分别选取三类来源的最新观测。正文保留上游原文。',
      'signals.community': '社区',
      'signals.tiboFallback': '暂无可用的 Tibo 公开信号。',
      'signals.openaiFallback': '暂无可用的 OpenAI 公开信号。',
      'signals.communityFallback': '暂无可用的社区讨论信号。',
      'signals.scanning': '扫描中',
      'signals.source': '来源',
      'signals.openSource': '查看原始信号 ↗',
      'signals.noLink': '无可验证链接',
      'history.eyebrow': 'PRESSURE TRACE / 004',
      'history.title': '24 小时概率轨迹',
      'history.legendLabel': '图表图例',
      'history.probability': '24h 概率',
      'history.watchLine': '关注线 60%',
      'history.chartTitle': '24 小时重置概率折线图',
      'history.chartSummary': '正在读取概率历史；当前显示为等待数据的示意轨迹。',
      'history.summary': '最近窗口共 {count} 个采样点，当前 {current}，最高 {high}，最低 {low}。',
      'history.emptySummary': '上游暂未提供可绘制的 24 小时概率历史。',
      'history.current': '当前',
      'history.high': '区间高点',
      'history.low': '区间低点',
      'performance.eyebrow': 'MODEL LOG / 005',
      'performance.title': '模型表现',
      'performance.caution': '以下是上游项目报告值，本站未独立验证。',
      'performance.total': '预测总数',
      'performance.accuracy': '整体准确率',
      'performance.brier': 'Brier 分数',
      'performance.resolved': '已结算预测',
      'performance.upstream': '上游报告值，本站未独立验证',
      'performance.lowerBetter': '上游报告值；越低越好，本站未独立验证',
      'resets.eyebrow': 'EVENT ARCHIVE / 006',
      'resets.title': '历史重置记录',
      'resets.note': '展示可识别的 global hard reset 历史记录；不把普通 banked reset、boost 或 unlock 混称为全局重置。',
      'resets.globalEvent': '全局重置事件',
      'resets.globalRecord': 'global hard reset 历史记录',
      'resets.fallback': '正在校准并去重历史记录。',
      'resets.sourcePending': '来源待核对',
      'resets.empty': '上游暂未提供可识别的 global hard reset 历史记录。',
      'methodology.eyebrow': 'FIELD NOTES / 007',
      'methodology.title': '数据方法与边界',
      'methodology.mirrorTitle': '本地镜像，不直连社交平台',
      'methodology.body': '本站定时镜像第三方项目已公开的预测、信号、表现与历史 JSON，访客只会读取本站的相对路径数据。',
      'methodology.scopeTitle': '预测对象',
      'methodology.scope': '观测对象是额外全局 hard reset；普通周刷新、banked reset 与 boost / unlock 不应被视为同一事件。',
      'methodology.readingTitle': '如何阅读',
      'methodology.reading': '概率是不确定性的温度计，不是承诺。请结合更新时间、原始信号与自己的剩余额度判断。',
      'methodology.disclaimerLabel': '非官方免责声明',
      'methodology.disclaimer': 'Tibo Reset 是非官方、仅供娱乐与信息参考的观测工具，与 OpenAI、Thibault Sottiaux 及上游参考站均无隶属、授权或背书关系。',
      'footer.note': '— 在深夜里，把不确定性看得更清楚。',
      'footer.localData': '仅读取本站镜像数据',
      'noscript.message': 'JavaScript 未启用：页面骨架仍可阅读，但实时概率、倒计时和信号不会更新。',
      'feedback.ready': '操作台已就绪',
      'feedback.refreshing': '正在刷新六个本地镜像数据源…',
      'feedback.refreshed': '镜像数据已刷新。',
      'feedback.partial': '部分来源读取失败，已保留其余可用数据。',
      'feedback.notifyUnsupported': '此浏览器不支持系统通知。',
      'feedback.notifyDenied': '通知权限未获授权；可在浏览器设置中修改。',
      'feedback.notifyEnabled': '高概率提醒已开启。',
      'feedback.notifyDisabled': '高概率提醒已关闭。',
      'feedback.notifyError': '通知设置失败，请稍后重试。',
      'feedback.shared': '系统分享面板已打开。',
      'feedback.copied': '预报摘要已复制。',
      'feedback.shareCancelled': '已取消分享。',
      'feedback.shareError': '无法分享或复制，请稍后重试。',
      'notification.title': 'Tibo Reset 高概率提醒',
      'notification.body5': '5 小时内额外全局 hard reset 概率已超过 50%。',
      'notification.body24': '24 小时内额外全局 hard reset 概率已超过 60%。',
      'share.title': 'Tibo Reset 非官方重置预报',
      'share.probabilities': '5h {five} · 24h {day} · 48h {twoDay}',
      'share.factors': '上游因素原文：',
      'share.updated': '更新时间：{time}',
      'share.disclaimer': '非官方信息参考；与 OpenAI、Thibault Sottiaux 及上游参考站无隶属或背书关系。'
    }),
    'en': Object.freeze({
      'meta.title': 'Tibo Reset · Midnight Reset Observatory',
      'meta.description': 'Tibo Reset is an unofficial ChatGPT and Codex quota-reset probability observatory.',
      'skip.toContent': 'Skip to main content',
      'brand.homeLabel': 'Tibo Reset home',
      'brand.tagline': 'Midnight reset observatory',
      'status.groupLabel': 'Data observation status',
      'status.detailsLabel': 'Sync source error details',
      'status.unofficial': 'Unofficial observation',
      'status.loading': 'Reading mirrored data',
      'status.ok': 'Mirror data online',
      'status.stale': 'Data may be stale',
      'status.degraded': 'Sync degraded; some sources are unavailable',
      'status.degradedCached': 'Sync degraded; {count} source(s) use cached data',
      'status.cached': 'Showing cached data',
      'status.failed': 'Sync failed; no forecast is available',
      'status.failedWithCache': 'Sync failed; continuing with cached data',
      'header.updated': 'Last updated',
      'nav.label': 'Page navigation',
      'nav.forecast': 'Forecast',
      'nav.signals': 'Signals',
      'nav.history': 'History',
      'nav.methodology': 'Method',
      'actions.refreshLabel': 'Refresh local mirror data',
      'actions.refresh': 'Refresh',
      'actions.languageLabel': 'Switch to Chinese',
      'actions.language': 'EN',
      'actions.notifyLabel': 'Enable high-probability browser alerts',
      'actions.notify': 'Enable alerts',
      'actions.notifyEnabled': 'Alerts enabled',
      'actions.shareLabel': 'Share the current reset forecast',
      'actions.share': 'Share forecast',
      'common.waiting': 'Waiting for data',
      'common.pending': 'Pending',
      'common.unavailable': 'Unavailable',
      'common.overdue': 'Overdue · awaiting update',
      'forecast.eyebrow': 'RESET WEATHER / 001',
      'forecast.title': 'Will the quota reset tonight?',
      'forecast.subtitle': 'Public signals and historical intervals estimate the chance of an extra global hard reset.',
      'forecast.horizon24': '24-hour probability',
      'forecast.confidence': 'Confidence',
      'forecast.confidencePending': 'Pending calibration',
      'forecast.confidenceHigh': 'High',
      'forecast.confidenceMedium': 'Medium',
      'forecast.confidenceLow': 'Low',
      'forecast.otherHorizonsLabel': 'Other forecast horizons',
      'forecast.horizon5': '5 hours',
      'forecast.horizon48': '48 hours',
      'forecast.actionLabel': 'ACTION WINDOW',
      'forecast.actionTitle': 'Tonight’s action guidance',
      'forecast.actionFallback': 'Reading the local mirror before giving guidance.',
      'forecast.actionCalm': 'Probability is low. Continue normally, while keeping an eye on the update time.',
      'forecast.actionWatch': 'Probability is in the watch range. Look out for new public signals.',
      'forecast.actionWarning': 'Probability is high. Consider using remaining quota first and watch for updates.',
      'forecast.actionUnknown': 'Forecast data is unavailable. Please refresh later.',
      'forecast.resetLabel': 'Next expected reset',
      'forecast.countdownLabel': 'Time to estimate',
      'factors.eyebrow': 'PRESSURE MAP / 002',
      'factors.title': 'Main factors',
      'factors.note': 'Positive signals lift the forecast; negative signals lower it. Factor text remains in the upstream language.',
      'factors.timePressure': 'Cycle pressure',
      'factors.officialSignal': 'Official change signal',
      'factors.communitySignal': 'Community discussion',
      'factors.upstreamReason': 'Upstream reason',
      'factors.empty': 'No usable upstream factors are available.',
      'signals.eyebrow': 'SIGNAL ARRAY / 003',
      'signals.title': 'Current signals',
      'signals.note': 'The newest observation in each source category. Body text remains in the upstream language.',
      'signals.community': 'Community',
      'signals.tiboFallback': 'No usable public Tibo signal is available.',
      'signals.openaiFallback': 'No usable public OpenAI signal is available.',
      'signals.communityFallback': 'No usable community signal is available.',
      'signals.scanning': 'Scanning',
      'signals.source': 'Source',
      'signals.openSource': 'Open original signal ↗',
      'signals.noLink': 'No verifiable link',
      'history.eyebrow': 'PRESSURE TRACE / 004',
      'history.title': '24-hour probability trace',
      'history.legendLabel': 'Chart legend',
      'history.probability': '24h probability',
      'history.watchLine': 'Watch line 60%',
      'history.chartTitle': '24-hour reset-probability line chart',
      'history.chartSummary': 'Reading probability history; the chart is showing a loading trace.',
      'history.summary': '{count} sampled point(s) in the latest window; current {current}, high {high}, low {low}.',
      'history.emptySummary': 'No drawable 24-hour probability history is available upstream.',
      'history.current': 'Current',
      'history.high': 'Window high',
      'history.low': 'Window low',
      'performance.eyebrow': 'MODEL LOG / 005',
      'performance.title': 'Model performance',
      'performance.caution': 'These are upstream-reported values; this site has not independently verified them.',
      'performance.total': 'Total predictions',
      'performance.accuracy': 'Overall accuracy',
      'performance.brier': 'Brier score',
      'performance.resolved': 'Resolved predictions',
      'performance.upstream': 'Upstream-reported; not independently verified',
      'performance.lowerBetter': 'Upstream-reported; lower is better; not independently verified',
      'resets.eyebrow': 'EVENT ARCHIVE / 006',
      'resets.title': 'Reset history',
      'resets.note': 'Recognizable global hard reset records only; ordinary banked resets, boosts, and unlocks are not mislabeled as global events.',
      'resets.globalEvent': 'Global reset event',
      'resets.globalRecord': 'Global hard reset record',
      'resets.fallback': 'Calibrating and deduplicating reset history.',
      'resets.sourcePending': 'Source pending review',
      'resets.empty': 'No recognizable global hard reset history is available upstream.',
      'methodology.eyebrow': 'FIELD NOTES / 007',
      'methodology.title': 'Data method and boundaries',
      'methodology.mirrorTitle': 'Local mirror, no direct social-platform connection',
      'methodology.body': 'The site periodically mirrors public prediction, signal, performance, and history JSON from a third-party project. Visitors read only this site’s relative data paths.',
      'methodology.scopeTitle': 'Forecast scope',
      'methodology.scope': 'The target is an extra global hard reset. Weekly refreshes, banked resets, boosts, and unlocks are not the same event.',
      'methodology.readingTitle': 'How to read it',
      'methodology.reading': 'Probability is a measure of uncertainty, not a promise. Consider the update time, original signals, and your own remaining quota.',
      'methodology.disclaimerLabel': 'Unofficial disclaimer',
      'methodology.disclaimer': 'Tibo Reset is an unofficial tool for entertainment and information only. It is not affiliated with, authorized by, or endorsed by OpenAI, Thibault Sottiaux, or the upstream reference site.',
      'footer.note': '— Seeing uncertainty more clearly after dark.',
      'footer.localData': 'Reads only this site’s mirrored data',
      'noscript.message': 'JavaScript is disabled: the page structure remains readable, but live probability, countdown, and signals will not update.',
      'feedback.ready': 'Action station ready',
      'feedback.refreshing': 'Refreshing six local mirror sources…',
      'feedback.refreshed': 'Mirror data refreshed.',
      'feedback.partial': 'Some sources failed; other usable data remains visible.',
      'feedback.notifyUnsupported': 'This browser does not support system notifications.',
      'feedback.notifyDenied': 'Notification permission was not granted. You can change it in browser settings.',
      'feedback.notifyEnabled': 'High-probability alerts are enabled.',
      'feedback.notifyDisabled': 'High-probability alerts are disabled.',
      'feedback.notifyError': 'Could not update notification settings. Please try again.',
      'feedback.shared': 'The system share panel opened.',
      'feedback.copied': 'Forecast summary copied.',
      'feedback.shareCancelled': 'Share cancelled.',
      'feedback.shareError': 'Could not share or copy. Please try again.',
      'notification.title': 'Tibo Reset probability alert',
      'notification.body5': 'The chance of an extra global hard reset within 5 hours is above 50%.',
      'notification.body24': 'The chance of an extra global hard reset within 24 hours is above 60%.',
      'share.title': 'Tibo Reset unofficial reset forecast',
      'share.probabilities': '5h {five} · 24h {day} · 48h {twoDay}',
      'share.factors': 'Upstream factor text:',
      'share.updated': 'Updated: {time}',
      'share.disclaimer': 'Unofficial information only; no affiliation with or endorsement by OpenAI, Thibault Sottiaux, or the upstream reference site.'
    })
  });

  var state = {
    initialized: false,
    listenersBound: false,
    language: 'zh-CN',
    raw: {
      prediction: null,
      predictionHistory: [],
      tweets: [],
      performance: null,
      resetHistory: [],
      syncStatus: null
    },
    model: null,
    loadFailures: [],
    loadingPromise: null,
    refreshTimer: null,
    countdownTimer: null,
    lastLoadAt: 0,
    notificationState: {
      enabled: false,
      fiveHigh: false,
      dayHigh: false
    }
  };

  function chooseLanguage(value) {
    return value === 'en' ? 'en' : 'zh-CN';
  }

  function readStoredLanguage(storage) {
    try {
      return chooseLanguage(storage && storage.getItem(LANGUAGE_KEY));
    } catch (error) {
      return 'zh-CN';
    }
  }

  function persistLanguage(storage, language) {
    try {
      if (!storage || typeof storage.setItem !== 'function') {
        return false;
      }
      storage.setItem(LANGUAGE_KEY, chooseLanguage(language));
      return true;
    } catch (error) {
      return false;
    }
  }

  function interpolate(template, values) {
    var output = String(template);
    var variables = values || {};
    Object.keys(variables).forEach(function (key) {
      output = output.split('{' + key + '}').join(String(variables[key]));
    });
    return output;
  }

  function translate(key, language, values) {
    var selected = chooseLanguage(language || state.language);
    var dictionary = I18N[selected];
    var fallback = I18N['zh-CN'];
    var template = Object.prototype.hasOwnProperty.call(dictionary, key)
      ? dictionary[key]
      : fallback[key] || key;
    return interpolate(template, values);
  }

  function normalizeProbability(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
      return null;
    }
    var numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
      return null;
    }
    return numeric;
  }

  function formatProbability(value) {
    var probability = normalizeProbability(value);
    return probability === null ? '--' : Math.round(probability * 100) + '%';
  }

  function getActionLevel(value) {
    var probability = normalizeProbability(value);
    if (probability === null) {
      return 'unknown';
    }
    if (probability < 0.35) {
      return 'calm';
    }
    if (probability <= 0.60) {
      return 'watch';
    }
    return 'warning';
  }

  function safeString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function truncateText(value, maximumLength) {
    if (typeof value !== 'string') {
      return '';
    }
    var limit = Number.isFinite(maximumLength) && maximumLength > 1
      ? Math.floor(maximumLength)
      : 280;
    var characters = Array.from(value);
    if (characters.length <= limit) {
      return value;
    }
    return characters.slice(0, limit - 1).join('') + '…';
  }

  function toTimestamp(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    var timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function classifySignal(item) {
    var signal = isPlainObject(item) ? item : {};
    var author = safeString(signal.author).toLowerCase();
    var source = safeString(signal.source).toLowerCase();
    var categories = ['tibo', 'community', 'openai'];
    for (var index = 0; index < categories.length; index += 1) {
      var category = categories[index];
      var policy = SIGNAL_POLICIES[category];
      if (policy.sources.indexOf(source) === -1) {
        continue;
      }
      if (policy.authors && policy.authors.indexOf(author) === -1) {
        return null;
      }
      return trustedUrlForHosts(signal.url, policy.hosts) ? category : null;
    }
    return null;
  }

  function selectLatestSignals(items, nowValue) {
    var selected = { tibo: null, openai: null, community: null };
    if (!Array.isArray(items)) {
      return selected;
    }
    var now = Number.isFinite(nowValue) ? nowValue : Date.now();
    var maximumFutureTime = now + 24 * 60 * 60 * 1000;
    items.forEach(function (item) {
      if (!isPlainObject(item) || !safeString(item.text)) {
        return;
      }
      var timestamp = toTimestamp(item.timestamp);
      if (timestamp === null || timestamp > maximumFutureTime) {
        return;
      }
      var category = classifySignal(item);
      if (!category) {
        return;
      }
      var current = selected[category];
      if (!current || timestamp > toTimestamp(current.timestamp)) {
        selected[category] = item;
      }
    });
    return selected;
  }

  function evenlySample(points, maximum) {
    var limit = Math.max(1, Math.floor(maximum || MAX_HISTORY_POINTS));
    if (points.length <= limit) {
      return points.slice();
    }
    if (limit === 1) {
      return [points[points.length - 1]];
    }
    var sampled = [];
    for (var index = 0; index < limit; index += 1) {
      var sourceIndex = Math.round(index * (points.length - 1) / (limit - 1));
      sampled.push(points[sourceIndex]);
    }
    return sampled;
  }

  function prepareHistory(items, nowValue) {
    if (!Array.isArray(items)) {
      return [];
    }
    var valid = [];
    items.forEach(function (item) {
      if (!isPlainObject(item) || !isPlainObject(item.prediction)) {
        return;
      }
      var time = toTimestamp(item.prediction_time);
      var value = normalizeProbability(item.prediction.within_24h);
      if (time !== null && value !== null) {
        valid.push({ time: time, value: value });
      }
    });
    valid.sort(function (left, right) { return left.time - right.time; });
    if (!valid.length) {
      return [];
    }

    var now = Number.isFinite(nowValue) ? nowValue : Date.now();
    var windowStart = now - 24 * 60 * 60 * 1000;
    var windowPoints = valid.filter(function (point) {
      return point.time >= windowStart && point.time <= now;
    });

    if (!windowPoints.length) {
      var latest = valid[valid.length - 1].time;
      var fallbackStart = latest - 24 * 60 * 60 * 1000;
      windowPoints = valid.filter(function (point) {
        return point.time >= fallbackStart && point.time <= latest;
      });
    }
    return evenlySample(windowPoints, MAX_HISTORY_POINTS);
  }

  function cleanCoordinate(value) {
    return Number(value.toFixed(2)).toString();
  }

  function buildHistoryGeometry(points) {
    if (!Array.isArray(points) || !points.length) {
      return { path: '', area: '', current: null, high: null, low: null };
    }
    var valid = points.filter(function (point) {
      return point && Number.isFinite(point.time) && normalizeProbability(point.value) !== null;
    });
    if (!valid.length) {
      return { path: '', area: '', current: null, high: null, low: null };
    }
    var left = 64;
    var right = 928;
    var top = 40;
    var bottom = 320;
    var firstTime = valid[0].time;
    var lastTime = valid[valid.length - 1].time;
    var timeSpan = lastTime - firstTime;
    var coordinates = valid.map(function (point, index) {
      var x;
      if (valid.length === 1) {
        x = (left + right) / 2;
      } else if (timeSpan > 0) {
        x = left + ((point.time - firstTime) / timeSpan) * (right - left);
      } else {
        x = left + (index / (valid.length - 1)) * (right - left);
      }
      var y = bottom - point.value * (bottom - top);
      return { x: x, y: y, value: point.value };
    });
    var path = coordinates.map(function (point, index) {
      return (index === 0 ? 'M' : 'L') + cleanCoordinate(point.x) + ' ' + cleanCoordinate(point.y);
    }).join(' ');
    var first = coordinates[0];
    var last = coordinates[coordinates.length - 1];
    var area = path + ' L' + cleanCoordinate(last.x) + ' ' + bottom +
      ' L' + cleanCoordinate(first.x) + ' ' + bottom + ' Z';
    var values = coordinates.map(function (point) { return point.value; });
    return {
      path: path,
      area: area,
      current: values[values.length - 1],
      high: Math.max.apply(Math, values),
      low: Math.min.apply(Math, values)
    };
  }

  function isGlobalResetRecord(item) {
    if (!isPlainObject(item)) {
      return false;
    }
    var notes = safeString(item.notes).toLowerCase();
    var source = safeString(item.source).toLowerCase();
    if (!notes) {
      return false;
    }
    if (/(?:banked|boost|unlock)/i.test(notes + ' ' + source)) {
      return false;
    }
    if (/\bglobal\b.*\breset\b/i.test(notes)) {
      return true;
    }
    return !/(?:^|[\s_-])(?:regular[\s_-]+)?weekly[\s_-]+(?:refresh(?:\s*\/\s*reset)?|reset)(?:$|[\s_-])/i
      .test(notes + ' ' + source);
  }

  function normalizeResetHistory(items) {
    if (!Array.isArray(items)) {
      return [];
    }
    var seen = new Set();
    var normalized = [];
    items.forEach(function (item) {
      if (!isGlobalResetRecord(item)) {
        return;
      }
      var time = toTimestamp(item.reset_time);
      var notes = safeString(item.notes);
      if (time === null || !notes) {
        return;
      }
      var key = String(item.reset_time) + '\u0000' + notes;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      normalized.push({
        time: time,
        resetTime: String(item.reset_time),
        notes: notes,
        source: safeString(item.source),
        confidence: normalizeProbability(item.confidence)
      });
    });
    normalized.sort(function (left, right) { return right.time - left.time; });
    return normalized.slice(0, 12);
  }

  function parseImpact(impact) {
    var match = safeString(impact).match(/[-+]?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function normalizeFactors(prediction) {
    var source = isPlainObject(prediction) ? prediction : {};
    var factors = [];
    if (Array.isArray(source.main_factors)) {
      source.main_factors.forEach(function (item, index) {
        if (!isPlainObject(item)) {
          return;
        }
        var text = safeString(item.factor);
        if (!text) {
          return;
        }
        var score = Number(item.score);
        var numericImpact = parseImpact(item.impact);
        var strength = Number.isFinite(score)
          ? Math.abs(score)
          : (numericImpact === null ? 0 : Math.abs(numericImpact) / 100);
        var impactClass = numericImpact > 0
          ? 'positive'
          : (numericImpact < 0 ? 'negative' : 'neutral');
        factors.push({
          text: text,
          impact: safeString(item.impact),
          score: Number.isFinite(score) ? score : null,
          strength: Math.max(0, Math.min(1, strength)),
          impactClass: impactClass,
          originalIndex: index,
          fromReason: false
        });
      });
      factors.sort(function (left, right) {
        return right.strength - left.strength || left.originalIndex - right.originalIndex;
      });
    }
    if (!factors.length && Array.isArray(source.reasons)) {
      source.reasons.forEach(function (reason, index) {
        var text = safeString(reason);
        if (text) {
          factors.push({
            text: text,
            impact: '',
            score: null,
            strength: 0,
            impactClass: 'neutral',
            originalIndex: index,
            fromReason: true
          });
        }
      });
    }
    return factors.slice(0, 4);
  }

  function normalizePerformance(value) {
    var source = isPlainObject(value) ? value : {};
    function nonNegativeNumber(candidate) {
      var number = Number(candidate);
      return Number.isFinite(number) && number >= 0 ? number : null;
    }
    return {
      total: nonNegativeNumber(source.total_predictions),
      resolved: nonNegativeNumber(source.resolved_predictions),
      accuracy: normalizeProbability(source.overall_accuracy),
      brier: nonNegativeNumber(source.overall_brier_score)
    };
  }

  function normalizeSyncStatus(value) {
    var source = isPlainObject(value) ? value : {};
    var allowed = ['ok', 'degraded', 'failed', 'cached'];
    var status = allowed.indexOf(source.overall_status) !== -1
      ? source.overall_status
      : 'failed';
    var sources = Array.isArray(source.sources) ? source.sources.filter(isPlainObject) : [];
    return {
      overall: status,
      syncedAt: toTimestamp(source.synced_at),
      sources: sources,
      issues: normalizeSyncIssues(source)
    };
  }

  function normalizeSyncIssues(value) {
    var source = isPlainObject(value) ? value : {};
    var sources = Array.isArray(source.sources) ? source.sources : [];
    return sources.reduce(function (issues, item) {
      if (!isPlainObject(item)) {
        return issues;
      }
      var name = safeString(item.name);
      var status = safeString(item.status).toLowerCase();
      var error = safeString(item.error);
      if (name && (error || status === 'cached' || status === 'failed')) {
        issues.push({ name: name, status: status, error: error });
      }
      return issues;
    }, []);
  }

  function normalizeViewModel(raw, nowValue) {
    var source = isPlainObject(raw) ? raw : {};
    var prediction = isPlainObject(source.prediction) ? source.prediction : {};
    var probabilitySource = isPlainObject(prediction.prediction) ? prediction.prediction : {};
    var nextReset = isPlainObject(prediction.next_reset) ? prediction.next_reset : {};
    var sync = normalizeSyncStatus(source.syncStatus);
    var predictionUpdatedAt = toTimestamp(prediction.updated_at);
    var updatedAt = predictionUpdatedAt === null ? sync.syncedAt : predictionUpdatedAt;
    var now = Number.isFinite(nowValue) ? nowValue : Date.now();
    return {
      probabilities: {
        five: normalizeProbability(probabilitySource.within_5h),
        day: normalizeProbability(probabilitySource.within_24h),
        twoDay: normalizeProbability(probabilitySource.within_48h)
      },
      confidence: safeString(prediction.confidence),
      expectedTime: toTimestamp(nextReset.expected_time),
      factors: normalizeFactors(prediction),
      signals: selectLatestSignals(source.tweets, now),
      history: prepareHistory(source.predictionHistory, now),
      performance: normalizePerformance(source.performance),
      resets: normalizeResetHistory(source.resetHistory),
      sync: sync,
      updatedAt: updatedAt,
      stale: isStale(updatedAt, now)
    };
  }

  function isStale(timestamp, nowValue) {
    if (!Number.isFinite(timestamp)) {
      return true;
    }
    var now = Number.isFinite(nowValue) ? nowValue : Date.now();
    return now - timestamp > STALE_AFTER_MS;
  }

  function formatTimestampForLanguage(timestamp, language) {
    if (!Number.isFinite(timestamp)) {
      return '--';
    }
    try {
      return new Intl.DateTimeFormat(language === 'en' ? 'en' : 'zh-CN', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'short'
      }).format(new Date(timestamp));
    } catch (error) {
      return new Date(timestamp).toISOString();
    }
  }

  function buildShareText(model, language, url) {
    var selected = chooseLanguage(language);
    var view = isPlainObject(model) ? model : {};
    var probabilities = isPlainObject(view.probabilities) ? view.probabilities : {};
    var lines = [
      translate('share.title', selected),
      translate('share.probabilities', selected, {
        five: formatProbability(probabilities.five),
        day: formatProbability(probabilities.day),
        twoDay: formatProbability(probabilities.twoDay)
      })
    ];
    var factors = Array.isArray(view.factors) ? view.factors.slice(0, 2) : [];
    if (factors.length) {
      lines.push(translate('share.factors', selected));
      factors.forEach(function (factor) {
        var text = isPlainObject(factor) ? safeString(factor.text) : safeString(factor);
        if (text) {
          lines.push('- ' + text);
        }
      });
    }
    lines.push(translate('share.updated', selected, {
      time: formatTimestampForLanguage(view.updatedAt, selected)
    }));
    lines.push(translate('share.disclaimer', selected));
    if (safeString(url)) {
      lines.push(safeString(url));
    }
    return lines.join('\n');
  }

  function notificationTransition(previous, probabilities) {
    var before = isPlainObject(previous) ? previous : {};
    var values = isPlainObject(probabilities) ? probabilities : {};
    var next = {
      enabled: before.enabled === true,
      fiveHigh: before.fiveHigh === true,
      dayHigh: before.dayHigh === true
    };
    var triggers = [];
    var five = normalizeProbability(values.five);
    var day = normalizeProbability(values.day);
    if (five !== null) {
      var fiveHigh = five > 0.50;
      if (next.enabled && fiveHigh && !next.fiveHigh) {
        triggers.push('5h');
      }
      next.fiveHigh = fiveHigh;
    }
    if (day !== null) {
      var dayHigh = day > 0.60;
      if (next.enabled && dayHigh && !next.dayHigh) {
        triggers.push('24h');
      }
      next.dayHigh = dayHigh;
    }
    return { state: next, triggers: triggers };
  }

  function readNotificationState(storage) {
    try {
      var parsed = JSON.parse(storage && storage.getItem(NOTIFICATION_KEY));
      if (!isPlainObject(parsed)) {
        throw new Error('invalid notification state');
      }
      return {
        enabled: parsed.enabled === true,
        fiveHigh: parsed.fiveHigh === true,
        dayHigh: parsed.dayHigh === true
      };
    } catch (error) {
      return { enabled: false, fiveHigh: false, dayHigh: false };
    }
  }

  function persistNotificationState(storage, value) {
    try {
      if (!storage || typeof storage.setItem !== 'function') {
        return false;
      }
      storage.setItem(NOTIFICATION_KEY, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  function reconcileNotificationState(previous, probabilities, storage) {
    var result = deliverNotificationCrossings(previous, probabilities, {
      permission: 'default',
      storage: storage
    });
    result.triggers = result.delivered.slice();
    return result;
  }

  function deliverNotificationCrossings(previous, probabilities, options) {
    var before = isPlainObject(previous) ? previous : {};
    var values = isPlainObject(probabilities) ? probabilities : {};
    var configuration = isPlainObject(options) ? options : {};
    var next = {
      enabled: before.enabled === true,
      fiveHigh: before.fiveHigh === true,
      dayHigh: before.dayHigh === true
    };
    var pending = [];
    var specifications = [
      { trigger: '5h', field: 'fiveHigh', value: values.five, threshold: 0.50 },
      { trigger: '24h', field: 'dayHigh', value: values.day, threshold: 0.60 }
    ];

    specifications.forEach(function (specification) {
      var probability = normalizeProbability(specification.value);
      if (probability === null) {
        return;
      }
      if (probability <= specification.threshold) {
        next[specification.field] = false;
      } else if (next.enabled && !next[specification.field]) {
        pending.push(specification);
      }
    });

    var delivered = [];
    var failed = [];
    var Constructor = configuration.NotificationConstructor;
    if (configuration.permission === 'granted' && typeof Constructor === 'function') {
      pending.forEach(function (specification) {
        try {
          new Constructor(translate('notification.title', configuration.language), {
            body: translate(
              specification.trigger === '5h' ? 'notification.body5' : 'notification.body24',
              configuration.language
            ),
            tag: 'tibo-reset-' + specification.trigger
          });
          next[specification.field] = true;
          delivered.push(specification.trigger);
        } catch (error) {
          failed.push(specification.trigger);
          if (typeof configuration.onError === 'function') {
            try {
              configuration.onError(error, specification.trigger);
            } catch (feedbackError) {
              // Feedback failures must not consume or surface the pending crossing.
            }
          }
        }
      });
    }

    persistNotificationState(configuration.storage, next);
    return {
      state: next,
      delivered: delivered,
      failed: failed,
      pending: pending.map(function (specification) {
        return specification.trigger;
      }).filter(function (trigger) {
        return delivered.indexOf(trigger) === -1;
      })
    };
  }

  function byId(identifier) {
    return typeof document === 'undefined' ? null : document.getElementById(identifier);
  }

  function setText(identifier, value) {
    var element = byId(identifier);
    if (element) {
      element.textContent = String(value);
    }
  }

  function clearElement(element) {
    while (element && element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function createElement(tagName, className, text) {
    var element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    if (text !== undefined && text !== null) {
      element.textContent = String(text);
    }
    return element;
  }

  function applyTranslations() {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.lang = state.language;
    document.querySelectorAll('[data-i18n]').forEach(function (element) {
      element.textContent = translate(element.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(function (element) {
      element.setAttribute('aria-label', translate(element.getAttribute('data-i18n-aria-label')));
    });
    document.querySelectorAll('[data-i18n-content]').forEach(function (element) {
      element.setAttribute('content', translate(element.getAttribute('data-i18n-content')));
    });
    var toggle = byId('language-toggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', state.language === 'en' ? 'true' : 'false');
      toggle.setAttribute('aria-label', translate('actions.languageLabel'));
      var choices = toggle.querySelectorAll('span[lang]');
      choices.forEach(function (choice) {
        choice.classList.toggle('language-button__active', choice.getAttribute('lang') === state.language);
      });
    }
  }

  function setFeedback(key) {
    var feedback = byId('action-feedback');
    if (!feedback) {
      return;
    }
    clearElement(feedback);
    feedback.appendChild(createElement('span', '', translate(key)));
  }

  function statusPresentation(model) {
    var hasPrediction = model && model.probabilities && (
      model.probabilities.five !== null ||
      model.probabilities.day !== null ||
      model.probabilities.twoDay !== null
    );
    var sync = model ? model.sync : { overall: 'failed', sources: [] };
    var cachedCount = sync.sources.filter(function (source) { return source.status === 'cached'; }).length;
    var failedCount = sync.sources.filter(function (source) { return source.status === 'failed'; }).length;
    if (!hasPrediction) {
      return { state: 'error', classes: ['status-failed'], key: 'status.failed', values: {} };
    }
    if (sync.overall === 'failed') {
      return { state: 'error', classes: ['status-failed', 'status-cached'], key: 'status.failedWithCache', values: {} };
    }
    if (sync.overall === 'cached') {
      return { state: 'cached', classes: ['status-cached'], key: 'status.cached', values: {} };
    }
    if (sync.overall === 'degraded' || state.loadFailures.length || failedCount) {
      return {
        state: cachedCount ? 'cached' : 'stale',
        classes: cachedCount ? ['status-degraded', 'status-cached'] : ['status-degraded'],
        key: cachedCount ? 'status.degradedCached' : 'status.degraded',
        values: { count: cachedCount }
      };
    }
    if (model.stale) {
      return { state: 'stale', classes: ['status-stale', 'status-ok'], key: 'status.stale', values: {} };
    }
    return { state: 'ok', classes: ['status-ok'], key: 'status.ok', values: {} };
  }

  function renderStatus() {
    var element = byId('data-status');
    if (!element || !state.model) {
      return;
    }
    var presentation = statusPresentation(state.model);
    element.className = 'data-status ' + presentation.classes.join(' ');
    element.setAttribute('data-state', presentation.state);
    clearElement(element);
    var pulse = createElement('span', 'status-pulse');
    pulse.setAttribute('aria-hidden', 'true');
    element.appendChild(pulse);
    element.appendChild(createElement('span', '', translate(presentation.key, state.language, presentation.values)));

    var details = byId('sync-status-details');
    if (details) {
      clearElement(details);
      var issues = state.model.sync && Array.isArray(state.model.sync.issues)
        ? state.model.sync.issues
        : [];
      issues.forEach(function (issue) {
        var detail = issue.error || issue.status;
        details.appendChild(createElement('li', '', issue.name + ': ' + detail));
      });
      details.hidden = issues.length === 0;
    }

    var updated = byId('last-updated');
    if (updated) {
      if (Number.isFinite(state.model.updatedAt)) {
        updated.dateTime = new Date(state.model.updatedAt).toISOString();
        updated.textContent = formatTimestampForLanguage(state.model.updatedAt, state.language);
      } else {
        updated.removeAttribute('datetime');
        updated.textContent = '--';
      }
    }
  }

  function setGauge(identifier, value, variableName) {
    var card = byId('forecast-' + identifier);
    var display = byId('probability-' + identifier);
    var probability = normalizeProbability(value);
    if (display) {
      display.textContent = formatProbability(probability);
    }
    if (card) {
      card.classList.toggle('is-loading', probability === null);
      card.style.setProperty(variableName, probability === null ? '0' : String(probability * 100));
    }
  }

  function confidenceText(value) {
    var confidence = safeString(value).toLowerCase();
    if (confidence === 'high') {
      return translate('forecast.confidenceHigh');
    }
    if (confidence === 'medium') {
      return translate('forecast.confidenceMedium');
    }
    if (confidence === 'low') {
      return translate('forecast.confidenceLow');
    }
    return confidence ? safeString(value) : translate('forecast.confidencePending');
  }

  function renderForecast() {
    if (!state.model) {
      return;
    }
    setGauge('5h', state.model.probabilities.five, '--reading-value');
    setGauge('24h', state.model.probabilities.day, '--gauge-value');
    setGauge('48h', state.model.probabilities.twoDay, '--reading-value');
    setText('confidence-value', confidenceText(state.model.confidence));
    var level = getActionLevel(state.model.probabilities.day);
    var keys = {
      calm: 'forecast.actionCalm',
      watch: 'forecast.actionWatch',
      warning: 'forecast.actionWarning',
      unknown: 'forecast.actionUnknown'
    };
    setText('action-recommendation', translate(keys[level]));
    var recommendation = byId('action-recommendation');
    if (recommendation) {
      recommendation.setAttribute('data-action-level', level);
    }
    var expected = byId('next-reset-time');
    if (expected) {
      if (Number.isFinite(state.model.expectedTime)) {
        expected.dateTime = new Date(state.model.expectedTime).toISOString();
        expected.textContent = formatTimestampForLanguage(state.model.expectedTime, state.language);
      } else {
        expected.removeAttribute('datetime');
        expected.textContent = translate('common.pending');
      }
    }
    renderCountdown();
  }

  function renderCountdown() {
    var output = byId('countdown');
    if (!output || !state.model || !Number.isFinite(state.model.expectedTime)) {
      if (output) {
        output.textContent = '--';
      }
      return;
    }
    var remaining = state.model.expectedTime - Date.now();
    if (remaining <= 0) {
      output.textContent = translate('common.overdue');
      output.setAttribute('data-state', 'overdue');
      return;
    }
    output.setAttribute('data-state', 'counting');
    var totalSeconds = Math.floor(remaining / 1000);
    var days = Math.floor(totalSeconds / 86400);
    var hours = Math.floor((totalSeconds % 86400) / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    function pad(number) { return String(number).padStart(2, '0'); }
    output.textContent = state.language === 'en'
      ? days + 'd ' + pad(hours) + ':' + pad(minutes) + ':' + pad(seconds)
      : days + '天 ' + pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
  }

  function renderFactors() {
    var list = byId('factors-list');
    if (!list || !state.model) {
      return;
    }
    clearElement(list);
    list.setAttribute('aria-busy', 'false');
    if (!state.model.factors.length) {
      var empty = createElement('li', 'factor-row factor-row--empty');
      empty.appendChild(createElement('span', 'factor-index', '--'));
      empty.appendChild(createElement('strong', 'factor-copy', translate('factors.empty')));
      list.appendChild(empty);
      return;
    }
    state.model.factors.forEach(function (factor, index) {
      var row = createElement('li', 'factor-row');
      row.appendChild(createElement('span', 'factor-index', String(index + 1).padStart(2, '0')));
      var copy = createElement('div', 'factor-copy');
      copy.appendChild(createElement('strong', '', truncateText(factor.text, 320)));
      var track = createElement('span', 'factor-track');
      track.setAttribute('aria-hidden', 'true');
      var fill = createElement('span');
      var width = factor.strength > 0 ? Math.max(5, factor.strength * 100) : 5;
      fill.style.setProperty('--factor-width', Math.min(100, width) + '%');
      track.appendChild(fill);
      copy.appendChild(track);
      row.appendChild(copy);
      var impact = createElement(
        'span',
        'factor-impact factor-impact--' + factor.impactClass,
        factor.impact || translate('factors.upstreamReason')
      );
      row.appendChild(impact);
      list.appendChild(row);
    });
  }

  function safeHttpsUrl(value) {
    var text = safeString(value);
    if (!/^https:\/\//i.test(text)) {
      return null;
    }
    try {
      var parsed = new URL(text);
      return parsed.protocol === 'https:' ? parsed.href : null;
    } catch (error) {
      return null;
    }
  }

  function hostMatchesPolicy(hostname, allowedRoot) {
    return hostname === allowedRoot || hostname.endsWith('.' + allowedRoot);
  }

  function trustedUrlForHosts(value, allowedHosts) {
    var url = safeHttpsUrl(value);
    if (!url || !Array.isArray(allowedHosts)) {
      return null;
    }
    try {
      var hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
      return allowedHosts.some(function (allowedRoot) {
        return hostMatchesPolicy(hostname, allowedRoot);
      }) ? url : null;
    } catch (error) {
      return null;
    }
  }

  function trustedSignalUrl(item, expectedCategory) {
    var category = classifySignal(item);
    if (!category || category !== expectedCategory) {
      return null;
    }
    return trustedUrlForHosts(item.url, SIGNAL_POLICIES[category].hosts);
  }

  function signalLabel(category) {
    if (category === 'community') {
      return translate('signals.community');
    }
    return category === 'openai' ? 'OpenAI' : 'Tibo';
  }

  function renderSignal(category, item) {
    var card = byId('signal-' + category);
    if (!card) {
      return;
    }
    clearElement(card);
    var header = createElement('header', 'signal-card__header');
    var sourceName = item
      ? safeString(item.source) || safeString(item.author)
      : '';
    var sourceText = signalLabel(category) + (sourceName ? ' · ' + truncateText(sourceName, 38) : '');
    header.appendChild(createElement('span', 'signal-source signal-source--' + category, sourceText));
    var time = createElement('time', '', translate('common.pending'));
    if (item) {
      var timestamp = toTimestamp(item.timestamp);
      if (timestamp !== null) {
        time.dateTime = new Date(timestamp).toISOString();
        time.textContent = formatTimestampForLanguage(timestamp, state.language);
      }
    }
    header.appendChild(time);
    card.appendChild(header);

    var fallbackKeys = {
      tibo: 'signals.tiboFallback',
      openai: 'signals.openaiFallback',
      community: 'signals.communityFallback'
    };
    card.appendChild(createElement(
      'p',
      '',
      item ? truncateText(safeString(item.text), 320) : translate(fallbackKeys[category])
    ));

    var url = item ? trustedSignalUrl(item, category) : null;
    if (url) {
      var link = createElement('a', 'signal-strength', translate('signals.openSource'));
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      card.appendChild(link);
    } else {
      card.appendChild(createElement('span', 'signal-strength', translate('signals.noLink')));
    }
    card.setAttribute('aria-busy', 'false');
  }

  function renderSignals() {
    if (!state.model) {
      return;
    }
    ['tibo', 'openai', 'community'].forEach(function (category) {
      renderSignal(category, state.model.signals[category]);
    });
    var list = byId('signals-list');
    if (list) {
      list.setAttribute('aria-busy', 'false');
    }
  }

  function renderHistory() {
    if (!state.model) {
      return;
    }
    var geometry = buildHistoryGeometry(state.model.history);
    var path = byId('history-path');
    var area = byId('history-area');
    if (path) {
      path.setAttribute('d', geometry.path);
      path.classList.remove('chart-placeholder');
    }
    if (area) {
      area.setAttribute('d', geometry.area);
      area.classList.remove('chart-placeholder');
    }
    setText('history-current', formatProbability(geometry.current));
    setText('history-high', formatProbability(geometry.high));
    setText('history-low', formatProbability(geometry.low));
    var summary = byId('history-chart-summary');
    if (summary) {
      summary.textContent = state.model.history.length
        ? translate('history.summary', state.language, {
          count: state.model.history.length,
          current: formatProbability(geometry.current),
          high: formatProbability(geometry.high),
          low: formatProbability(geometry.low)
        })
        : translate('history.emptySummary');
    }
  }

  function formatCount(value) {
    if (!Number.isFinite(value) || value < 0) {
      return '—';
    }
    return Math.round(value).toLocaleString(state.language === 'en' ? 'en' : 'zh-CN');
  }

  function renderPerformance() {
    if (!state.model) {
      return;
    }
    var performance = state.model.performance;
    setText('metric-total', formatCount(performance.total));
    setText('metric-resolved', formatCount(performance.resolved));
    setText('metric-accuracy', formatProbability(performance.accuracy));
    setText('metric-brier', Number.isFinite(performance.brier) ? performance.brier.toFixed(3) : '--');
    var metrics = byId('performance-metrics');
    if (metrics) {
      metrics.setAttribute('aria-busy', 'false');
    }
  }

  function renderResets() {
    var list = byId('reset-timeline');
    if (!list || !state.model) {
      return;
    }
    clearElement(list);
    list.setAttribute('aria-busy', 'false');
    if (!state.model.resets.length) {
      var empty = createElement('li', 'reset-event reset-event--empty');
      empty.appendChild(createElement('span', 'reset-event__marker'));
      empty.appendChild(createElement('p', '', translate('resets.empty')));
      list.appendChild(empty);
      return;
    }
    state.model.resets.forEach(function (event) {
      var row = createElement('li', 'reset-event');
      var marker = createElement('span', 'reset-event__marker');
      marker.setAttribute('aria-hidden', 'true');
      row.appendChild(marker);
      var date = createElement('div', 'reset-event__date');
      var time = createElement('time', '', formatTimestampForLanguage(event.time, state.language));
      time.dateTime = new Date(event.time).toISOString();
      date.appendChild(time);
      date.appendChild(createElement('span', '', translate('resets.globalRecord')));
      row.appendChild(date);
      row.appendChild(createElement('p', '', truncateText(event.notes, 320)));
      row.appendChild(createElement(
        'span',
        'reset-event__source',
        event.source || translate('resets.sourcePending')
      ));
      list.appendChild(row);
    });
  }

  function renderNotificationButton() {
    var button = byId('notification-button');
    if (!button) {
      return;
    }
    button.setAttribute('aria-pressed', state.notificationState.enabled ? 'true' : 'false');
    var label = button.querySelector('[data-i18n="actions.notify"]');
    if (label) {
      label.textContent = state.notificationState.enabled
        ? translate('actions.notifyEnabled')
        : translate('actions.notify');
    }
  }

  function renderAll() {
    if (typeof document === 'undefined' || !state.model) {
      return;
    }
    renderStatus();
    renderForecast();
    renderFactors();
    renderSignals();
    renderHistory();
    renderPerformance();
    renderResets();
    renderNotificationButton();
  }

  function setLanguage(language, shouldPersist) {
    state.language = chooseLanguage(language);
    if (shouldPersist !== false && root && root.localStorage) {
      persistLanguage(root.localStorage, state.language);
    }
    applyTranslations();
    renderAll();
    return state.language;
  }

  function fetchJson(relativePath) {
    if (!root || typeof root.fetch !== 'function') {
      return Promise.reject(new Error('Fetch API unavailable'));
    }
    return root.fetch(relativePath, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ' for ' + relativePath);
      }
      return response.json();
    });
  }

  function processNotificationCrossings() {
    if (!state.model) {
      return;
    }
    var storage = root && root.localStorage ? root.localStorage : null;
    var NotificationConstructor = root && typeof root.Notification === 'function'
      ? root.Notification
      : null;
    var transition = deliverNotificationCrossings(
      state.notificationState,
      state.model.probabilities,
      {
        permission: NotificationConstructor ? root.Notification.permission : 'unsupported',
        NotificationConstructor: NotificationConstructor,
        storage: storage,
        language: state.language,
        onError: function () {
          setFeedback('feedback.notifyError');
        }
      }
    );
    state.notificationState = transition.state;
    return transition;
  }

  function updateRefreshButton(isRefreshing) {
    var button = byId('refresh-button');
    if (!button) {
      return;
    }
    button.disabled = isRefreshing;
    button.classList.toggle('is-refreshing', isRefreshing);
    button.setAttribute('aria-busy', isRefreshing ? 'true' : 'false');
  }

  function refreshData() {
    if (state.loadingPromise) {
      return state.loadingPromise;
    }
    updateRefreshButton(true);
    setFeedback('feedback.refreshing');
    var requests = DATA_SOURCES.map(fetchJson);
    state.loadingPromise = Promise.allSettled(requests).then(function (results) {
      var failures = [];
      results.forEach(function (result, index) {
        if (result.status === 'fulfilled') {
          state.raw[DATA_KEYS[index]] = result.value;
        } else {
          failures.push(DATA_SOURCES[index]);
        }
      });
      state.loadFailures = failures;
      state.lastLoadAt = Date.now();
      state.model = normalizeViewModel(state.raw, state.lastLoadAt);
      renderAll();
      var notificationResult = processNotificationCrossings();
      setFeedback(
        notificationResult && notificationResult.failed.length
          ? 'feedback.notifyError'
          : (failures.length ? 'feedback.partial' : 'feedback.refreshed')
      );
      return state.model;
    }).catch(function () {
      state.loadFailures = DATA_SOURCES.slice();
      state.lastLoadAt = Date.now();
      state.model = normalizeViewModel(state.raw, state.lastLoadAt);
      renderAll();
      setFeedback('feedback.partial');
      return state.model;
    }).finally(function () {
      state.loadingPromise = null;
      updateRefreshButton(false);
    });
    return state.loadingPromise;
  }

  async function handleNotificationClick() {
    if (!root || typeof root.Notification !== 'function') {
      setFeedback('feedback.notifyUnsupported');
      return;
    }
    if (state.notificationState.enabled) {
      state.notificationState.enabled = false;
      if (root.localStorage) {
        persistNotificationState(root.localStorage, state.notificationState);
      }
      renderNotificationButton();
      setFeedback('feedback.notifyDisabled');
      return;
    }
    try {
      var permission = root.Notification.permission;
      if (permission !== 'granted') {
        permission = await root.Notification.requestPermission();
      }
      if (permission !== 'granted') {
        setFeedback('feedback.notifyDenied');
        return;
      }
      state.notificationState.enabled = true;
      if (root.localStorage) {
        persistNotificationState(root.localStorage, state.notificationState);
      }
      renderNotificationButton();
      var notificationResult = processNotificationCrossings();
      setFeedback(
        notificationResult && notificationResult.failed.length
          ? 'feedback.notifyError'
          : 'feedback.notifyEnabled'
      );
    } catch (error) {
      setFeedback('feedback.notifyError');
    }
  }

  function legacyCopy(text, targetDocument) {
    if (!targetDocument || !targetDocument.body || typeof targetDocument.execCommand !== 'function') {
      return false;
    }
    var textarea = targetDocument.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    targetDocument.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    var copied = false;
    try {
      copied = targetDocument.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    targetDocument.body.removeChild(textarea);
    return copied;
  }

  async function copyText(text, browserNavigator, targetDocument) {
    if (
      browserNavigator &&
      browserNavigator.clipboard &&
      typeof browserNavigator.clipboard.writeText === 'function'
    ) {
      try {
        await browserNavigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        return legacyCopy(text, targetDocument);
      }
    }
    return legacyCopy(text, targetDocument);
  }

  async function handleShareClick() {
    if (!state.model || !root) {
      setFeedback('feedback.shareError');
      return;
    }
    var currentUrl = root.location ? root.location.href : '';
    var text = buildShareText(state.model, state.language, currentUrl);
    var browserNavigator = root.navigator || {};
    if (typeof browserNavigator.share === 'function') {
      try {
        await browserNavigator.share({ title: translate('share.title'), text: text });
        setFeedback('feedback.shared');
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') {
          setFeedback('feedback.shareCancelled');
          return;
        }
      }
    }
    var copied = await copyText(text, browserNavigator, document);
    setFeedback(copied ? 'feedback.copied' : 'feedback.shareError');
  }

  function bindEvents() {
    if (state.listenersBound || typeof document === 'undefined') {
      return;
    }
    state.listenersBound = true;
    var languageButton = byId('language-toggle');
    var refreshButton = byId('refresh-button');
    var notificationButton = byId('notification-button');
    var shareButton = byId('share-button');
    if (languageButton) {
      languageButton.addEventListener('click', function () {
        setLanguage(state.language === 'en' ? 'zh-CN' : 'en', true);
      });
    }
    if (refreshButton) {
      refreshButton.addEventListener('click', function () { refreshData(); });
    }
    if (notificationButton) {
      notificationButton.addEventListener('click', function () { handleNotificationClick(); });
    }
    if (shareButton) {
      shareButton.addEventListener('click', function () { handleShareClick(); });
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - state.lastLoadAt >= REFRESH_INTERVAL_MS) {
        refreshData();
      }
    });
  }

  function startIntervals() {
    if (!state.countdownTimer && root && typeof root.setInterval === 'function') {
      state.countdownTimer = root.setInterval(renderCountdown, 1000);
    }
    if (!state.refreshTimer && root && typeof root.setInterval === 'function') {
      state.refreshTimer = root.setInterval(refreshData, REFRESH_INTERVAL_MS);
    }
  }

  function init() {
    if (state.initialized || typeof document === 'undefined') {
      return;
    }
    state.initialized = true;
    state.language = readStoredLanguage(root && root.localStorage);
    state.notificationState = readNotificationState(root && root.localStorage);
    state.model = normalizeViewModel(state.raw, Date.now());
    applyTranslations();
    renderAll();
    bindEvents();
    startIntervals();
    refreshData();
  }

  return Object.freeze({
    I18N: I18N,
    DATA_SOURCES: DATA_SOURCES,
    chooseLanguage: chooseLanguage,
    readStoredLanguage: readStoredLanguage,
    persistLanguage: persistLanguage,
    normalizeProbability: normalizeProbability,
    formatProbability: formatProbability,
    getActionLevel: getActionLevel,
    classifySignal: classifySignal,
    selectLatestSignals: selectLatestSignals,
    prepareHistory: prepareHistory,
    buildHistoryGeometry: buildHistoryGeometry,
    isGlobalResetRecord: isGlobalResetRecord,
    normalizeResetHistory: normalizeResetHistory,
    normalizeSyncIssues: normalizeSyncIssues,
    normalizeFactors: normalizeFactors,
    normalizeViewModel: normalizeViewModel,
    buildShareText: buildShareText,
    notificationTransition: notificationTransition,
    reconcileNotificationState: reconcileNotificationState,
    deliverNotificationCrossings: deliverNotificationCrossings,
    truncateText: truncateText,
    safeHttpsUrl: safeHttpsUrl,
    trustedSignalUrl: trustedSignalUrl,
    legacyCopy: legacyCopy,
    copyText: copyText,
    isStale: isStale,
    setLanguage: setLanguage,
    refreshData: refreshData,
    init: init
  });
}));
