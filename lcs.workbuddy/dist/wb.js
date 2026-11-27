'use strict';

const crypto = require('crypto');
const store = require('./store');

class WorkBuddyError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'WorkBuddyError';
    this.status = status || 0;
    this.code = code === undefined ? null : code;
  }
}

function timeoutMs() {
  return 25000;
}

async function rawRequest(url, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  let res;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    const reason = error && error.name === 'AbortError' ? '请求超时' : String((error && error.message) || error);
    throw new WorkBuddyError(`${reason}（${url}）`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, text, json, url };
}

function upstreamMessage(body) {
  if (!body || typeof body !== 'object') return '';
  return String(body.msg || body.message || body.error_msg || '');
}

// 解 {code, msg, data}；code 非 0 视为失败，data 内再套 data 时多拆一层
function unwrap(body, label) {
  if (body === null || body === undefined) {
    throw new WorkBuddyError(`${label || '上游'} 返回空响应`);
  }
  if (typeof body !== 'object') return body;
  if (Object.prototype.hasOwnProperty.call(body, 'code')) {
    const code = Number(body.code);
    if (Number.isFinite(code) && code !== 0) {
      const message = upstreamMessage(body) || `code ${body.code}`;
      throw new WorkBuddyError(`${label || '上游'}失败：${message}`, 0, body.code);
    }
  }
  let value = body;
  if (Object.prototype.hasOwnProperty.call(body, 'data')) value = body.data;
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'data')
    && Object.keys(value).length <= 3) {
    value = value.data;
  }
  return value;
}

function anonymousHeaders(region) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Language': region.acceptLanguage,
    'User-Agent': store.USER_AGENT,
    Origin: region.origin,
    Referer: region.referer,
    'X-No-Authorization': '1',
    'X-No-User-Id': '1',
    'X-No-Enterprise-Id': '1',
    'X-No-Department-Info': '1',
    'X-Domain': region.domain
  };
}

function authorizedHeaders(region, account) {
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    'X-Domain': account.domain || region.domain,
    'X-Product': 'SaaS',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Accept-Language': region.acceptLanguage,
    'User-Agent': region.userAgent || store.USER_AGENT,
    Origin: region.origin,
    Referer: region.referer
  };
  if (account.uid) headers['X-User-Id'] = account.uid;
  return headers;
}

function growthHeaders(region, account, options) {
  const opts = options || {};
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    'X-CodeBuddy-Request': '1',
    'X-No-Enterprise-Id': '1',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json',
    'Accept-Language': region.acceptLanguage,
    'User-Agent': opts.userAgent || store.USER_AGENT,
    Origin: opts.origin || region.origin,
    Referer: opts.referer || region.referer,
    'Content-Type': 'application/json'
  };
  if (account.uid) headers['X-User-Id'] = account.uid;
  if (account.domain || region.domain) headers['X-Domain'] = account.domain || region.domain;
  return headers;
}

function hashToken(uid, salt) {
  const seed = `wb2a:${salt}:${uid}`;
  return crypto.createHash('sha256').update(seed, 'utf8').digest().subarray(0, 18).toString('base64url').slice(0, 30);
}

function uuidFrom(seed) {
  const buf = Buffer.from(crypto.createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16));
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function randomId(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function conversationSeed(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const item of messages) {
    const role = String((item && item.role) || '').toLowerCase();
    if (role === 'system') {
      parts.push(`system:${textOf(item.content)}|`);
    } else if (role === 'user') {
      parts.push(`user:${textOf(item.content)}|`);
      break;
    }
    if (parts.join('').length > 4000) break;
  }
  const joined = parts.join('');
  if (!joined) return '';
  return `d-${crypto.createHash('sha256').update(joined, 'utf8').digest().subarray(0, 8).toString('base64url').slice(0, 30)}`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function ideHeaders(region, account, options) {
  const opts = options || {};
  const realm = region.realm || '';
  const isGlobal = realm === 'global';
  const version = region.ideVersion || (isGlobal ? '5.9.4' : '5.9.3');
  const headers = {
    'Content-Type': 'application/json',
    'X-CodeBuddy-Request': '1',
    Accept: 'application/json',
    'User-Agent': isGlobal ? store.IDE_UA_GLOBAL : store.IDE_UA_DOMESTIC
  };

  if (account) {
    if (account.accessToken) headers.Authorization = `Bearer ${account.accessToken}`;
    if (account.uid) {
      headers['X-User-Id'] = account.uid;
      headers['X-Machine-ID'] = hashToken(account.uid, 'machine');
      headers['X-Session-ID'] = hashToken(account.uid, 'session');
    }
    const enterpriseId = account.enterpriseId || account.enterprise_id;
    if (enterpriseId) {
      headers['X-Enterprise-Id'] = String(enterpriseId);
      headers['X-Tenant-Id'] = String(enterpriseId);
    } else {
      headers['X-No-Enterprise-Id'] = '1';
    }
    if (isGlobal) {
      headers['X-No-Enterprise-Id'] = '1';
      headers['X-Domain'] = 'www.workbuddy.ai';
    } else if (account.domain) {
      headers['X-Domain'] = account.domain;
    } else {
      headers['X-No-Department-Info'] = '1';
    }
    if (account.deviceToken) headers['X-Device-Token'] = account.deviceToken;
  }

  headers['X-Agent-Purpose'] = 'conversation';
  headers['X-IDE-Name'] = 'WorkBuddy';
  headers['X-IDE-Type'] = 'WorkBuddy';
  headers['X-IDE-Version'] = version;
  headers['X-Product'] = 'SaaS';
  headers['X-Private-Data'] = 'true';
  headers['X-Agent-Type'] = 'main';
  headers['X-Agent-Intent'] = 'craft';
  headers['X-Stainless-Lang'] = store.STAINLESS.lang;
  headers['X-Stainless-Package-Version'] = store.STAINLESS.packageVersion;
  headers['X-Stainless-OS'] = store.STAINLESS.os;
  headers['X-Stainless-Arch'] = store.STAINLESS.arch;
  headers['X-Stainless-Runtime'] = store.STAINLESS.runtime;
  headers['X-Stainless-Runtime-Version'] = store.STAINLESS.runtimeVersion;
  headers['X-Stainless-Retry-Count'] = String(opts.retryCount || 0);

  const uid = (account && account.uid) || '';
  const requestId = opts.requestId || randomId(32);
  const messageId = randomId(32);
  const conversationId =
    opts.conversationId || uuidFrom(`${uid}|${opts.conversationSeed || randomId(32)}`);
  const traceId = randomId(32);
  const spanId = randomId(16);
  const parentSpanId = randomId(16);
  const b3Trace = /^[0-9a-fA-F]{16,32}$/.test(traceId) ? traceId : messageId;

  headers['X-Conversation-ID'] = conversationId;
  headers['X-Conversation-Request-ID'] = requestId;
  headers['X-Conversation-Message-ID'] = messageId;
  headers['X-Request-ID'] = messageId;
  headers['X-Root-Request-ID'] = requestId;
  headers['X-Trace-ID'] = traceId;
  headers['X-B3-TraceId'] = b3Trace;
  headers['X-B3-SpanId'] = spanId;
  headers['X-B3-ParentSpanId'] = parentSpanId;
  headers['X-B3-Sampled'] = '1';
  headers.b3 = `${b3Trace}-${spanId}-1-${parentSpanId}`;
  headers.traceparent = `00-${b3Trace}-${spanId}-01`;
  headers['acp-connection-id'] = uuidFrom(`|${randomId(32)}|acp`);

  return headers;
}

function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function longOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source && source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstNumber(source, keys) {
  for (const key of keys) {
    const value = source && source[key];
    if (value !== null && value !== undefined && value !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return 0;
}

// 时间戳或 "YYYY-MM-DD HH:mm:ss"（GMT+8）统一成毫秒
function toEpochMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return 0;
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) return toEpochMs(numeric);
    const normalized = text.includes('T') ? text : text.replace(' ', 'T');
    const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`;
    const parsed = Date.parse(withZone);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1e11 ? numeric * 1000 : numeric;
}

function parseAccount(root, region) {
  if (!root || typeof root !== 'object') return null;
  const auth = root.auth && typeof root.auth === 'object' ? root.auth : root;
  const account = root.account && typeof root.account === 'object'
    ? root.account
    : (auth.account && typeof auth.account === 'object' ? auth.account : {});
  const layers = [account, auth, root];
  const pick = (keys) => {
    for (const layer of layers) {
      const value = typeof keys === 'string' ? layer[keys] : null;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const found = firstStringObject(layers, typeof keys === 'string' ? [keys] : keys);
    return found;
  };
  const accessToken = pick(['access_token', 'accessToken']);
  if (!accessToken) return null;
  const result = {
    uid: pick(['uid', 'user_id', 'userId', 'sub']),
    nickname: pick(['nickname', 'name', 'preferred_username', 'display_name']),
    region: pick(['region']) || (region && region.code) || store.DEFAULT_REGION,
    accessToken,
    refreshToken: pick(['refresh_token', 'refreshToken']),
    expiresAt: firstNumberAcross(layers, ['expires_at', 'expiresAt']),
    domain: pick(['domain']) || (region && region.domain) || '',
    creditsRemaining: firstNumberAcross(layers, ['credits_remaining', 'creditsRemaining']),
    creditsTotal: firstNumberAcross(layers, ['credits_total', 'creditsTotal']),
    creditsExpireAt: firstNumberAcross(layers, ['credits_expire_at', 'creditsExpireAt']),
    lastCheckInDate: pick(['last_check_in_date', 'lastCheckInDate'])
  };
  if (result.expiresAt && result.expiresAt < 1e11) result.expiresAt *= 1000;
  const jwtExp = tokenExpiresAt(accessToken);
  if (jwtExp) result.expiresAt = jwtExp;
  return result;
}

function tokenExpiresAt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload && payload.exp);
    if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  } catch {
    return 0;
  }
  return 0;
}

function firstStringObject(layers, keys) {
  for (const layer of layers) {
    for (const key of keys) {
      const value = layer[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

function firstNumberAcross(layers, keys) {
  for (const layer of layers) {
    for (const key of keys) {
      const value = layer[key];
      if (value !== null && value !== undefined && value !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }
  }
  return 0;
}

function findArrayByKey(node, key, depth) {
  const level = depth || 0;
  if (!node || typeof node !== 'object' || level > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findArrayByKey(item, key, level + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(node[key]) && node[key].length) return node[key];
  for (const value of Object.values(node)) {
    const found = findArrayByKey(value, key, level + 1);
    if (found) return found;
  }
  return null;
}

function collectArraysByKey(node, key, depth, out) {
  const level = depth || 0;
  const acc = out || [];
  if (!node || typeof node !== 'object' || level > 8) return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectArraysByKey(item, key, level + 1, acc);
    return acc;
  }
  if (Array.isArray(node[key]) && node[key].length) acc.push(node[key]);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) collectArraysByKey(item, key, level + 1, acc);
    } else {
      collectArraysByKey(value, key, level + 1, acc);
    }
  }
  return acc;
}

function normalizeCapacity(value) {
  const parsed = Number(value) || 0;
  return parsed > 1.0e10 ? Math.round(parsed / 1000) : parsed;
}

function parseQuota(root) {
  const accounts = findArrayByKey(root, 'Accounts', 0);
  if (!accounts || !accounts.length) {
    const summary = root || {};
    const remaining = normalizeCapacity(firstNumber(summary, ['CapacityRemain', 'capacity_remain', 'remaining']));
    const total = normalizeCapacity(firstNumber(summary, ['CycleCapacitySize', 'CapacitySize', 'total']));
    if (!remaining && !total) return null;
    return { remaining, total, expireAt: null, packages: [] };
  }
  let remaining = 0;
  let total = 0;
  let expireAt = null;
  const packages = [];
  accounts.forEach((item) => {
    const cycleSize = normalizeCapacity(item.CycleCapacitySize);
    const cycleRemain = normalizeCapacity(item.CycleCapacityRemain);
    const itemTotal = cycleSize > 0 ? cycleSize : normalizeCapacity(item.CapacitySize);
    const itemRemain = cycleSize > 0 ? cycleRemain : normalizeCapacity(item.CapacityRemain);
    if (itemTotal > 0) {
      total += itemTotal;
      if (itemRemain > 0) remaining += itemRemain;
    }
    const rawExpire = toEpochMs(
      item.ExpireTime || item.PackageEndTime || item.EndTime || item.CycleEndTime || item.DeductionEndTime
    );
    const itemExpire = rawExpire > 0 ? rawExpire : null;
    if (itemExpire && (!expireAt || itemExpire < expireAt)) expireAt = itemExpire;
    packages.push({
      name: firstString(item, ['PackageName', 'ProductName']) || '',
      remaining: itemRemain,
      total: itemTotal,
      expireAt: itemExpire
    });
  });
  return { remaining, total, expireAt, packages };
}

function toTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = firstString(raw, ['task_code', 'code', 'taskCode']);
  if (!code) return null;
  const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : null;
  const current = progress
    ? num(progress.current !== undefined ? progress.current : progress.value)
    : num(raw.current !== undefined ? raw.current : raw.progress);
  const target = progress
    ? num(progress.target !== undefined ? progress.target : progress.total)
    : num(raw.target);
  return {
    code,
    title: firstString(raw, ['title', 'name']),
    description: firstString(raw, ['description', 'desc']),
    rewardCredit: num(raw.reward_credit !== undefined ? raw.reward_credit : raw.rewardCredit),
    rewardEnergy: num(raw.reward_energy !== undefined ? raw.reward_energy : raw.rewardEnergy),
    current,
    target,
    status: firstString(raw, ['accept_status', 'status', 'acceptStatus']),
    locked: Boolean(raw.locked),
    jumpUrl: firstString(raw, ['jump_url', 'url', 'jumpUrl'])
  };
}

async function requestAuthState(region) {
  const url = `${region.apiBase}/v2/plugin/auth/state?platform=CLI`;
  const res = await rawRequest(url, {
    method: 'POST',
    headers: anonymousHeaders(region),
    body: '{}'
  });
  if (!res.ok) {
    throw new WorkBuddyError(`登录接口 HTTP ${res.status}`, res.status);
  }
  const data = unwrap(res.json, '登录接口');
  const state = firstString(data || {}, ['state', 'auth_state', 'authState']);
  const authUrl = firstString(data || {}, ['authUrl', 'auth_url', 'url']);
  if (!state || !authUrl) {
    throw new WorkBuddyError('登录接口未返回 state/authUrl');
  }
  return { state, authUrl, region: region.code };
}

async function pollAuthToken(region, state) {
  const url = `${region.apiBase}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
  const res = await rawRequest(url, { headers: anonymousHeaders(region) });
  if (!res.ok) {
    throw new WorkBuddyError(`轮询授权 HTTP ${res.status}`, res.status);
  }
  const body = res.json;
  if (!body || typeof body !== 'object') return { pending: true };
  const code = Number(body.code);
  if (code === store.PENDING_AUTH_CODE) return { pending: true };
  if (Number.isFinite(code) && code !== 0) {
    throw new WorkBuddyError(`轮询授权失败：${upstreamMessage(body) || code}`, 0, body.code);
  }
  const data = unwrap(body, '轮询授权');
  const account = parseAccount(data, region) || parseAccount(body, region);
  if (!account) return { pending: true };
  return { pending: false, account };
}

async function refreshToken(region, account) {
  const url = `${region.apiBase}/v2/plugin/auth/token/refresh`;
  const headers = anonymousHeaders(region);
  headers['X-Refresh-Token'] = account.refreshToken;
  headers['X-Auth-Refresh-Source'] = 'plugin';
  if (account.accessToken) headers.Authorization = `Bearer ${account.accessToken}`;
  const res = await rawRequest(url, { method: 'POST', headers, body: '{}' });
  if (!res.ok) {
    throw new WorkBuddyError(`刷新令牌 HTTP ${res.status}`, res.status);
  }
  const data = unwrap(res.json, '刷新令牌');
  const next = parseAccount(data, region) || parseAccount(res.json, region);
  if (!next) throw new WorkBuddyError('刷新令牌未返回账户信息');
  if (!next.refreshToken) next.refreshToken = account.refreshToken;
  if (!next.uid) next.uid = account.uid;
  if (!next.nickname) next.nickname = account.nickname;
  next.region = region.code;
  return next;
}

function quotaBody(withTimeRange) {
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: store.QUOTA_PRODUCT_CODE,
    Status: [0, 3]
  };
  if (withTimeRange) {
    body.PackageEndTimeRangeBegin = store.gmt8DayOffset(0);
    body.PackageEndTimeRangeEnd = store.gmt8DayOffset(36865);
  }
  return body;
}

async function refreshQuota(region, account) {
  const quotaBase = process.env.WORKBUDDY_UPSTREAM_BASE || '';
  const candidates = quotaBase
    ? [
      { url: `${quotaBase}/v2/billing/meter/get-user-resource`, timeRange: true },
      { url: `${quotaBase}/billing/meter/get-user-resource`, timeRange: true }
    ]
    : region.code === 'international'
      ? [
        { url: 'https://www.workbuddy.ai/v2/billing/meter/get-user-resource', timeRange: true },
        { url: 'https://www.workbuddy.ai/billing/meter/get-user-resource', timeRange: true }
      ]
      : [
        { url: `${region.apiBase}/v2/billing/meter/get-user-resource`, timeRange: false },
        { url: `${region.apiBase}/billing/meter/get-user-resource-summary`, timeRange: false }
      ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const headers = authorizedHeaders(region, account);
      headers['User-Agent'] = store.QUOTA_USER_AGENT;
      const res = await rawRequest(candidate.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(quotaBody(candidate.timeRange))
      });
      if (!res.ok) {
        errors.push(`${candidate.url} → HTTP ${res.status}`);
        continue;
      }
      const data = unwrap(res.json, '额度查询');
      const quota = parseQuota(data || res.json);
      if (quota) return quota;
      errors.push(`${candidate.url} → 无可解析额度`);
    } catch (error) {
      errors.push(`${candidate.url} → ${String((error && error.message) || error)}`);
    }
  }
  throw new WorkBuddyError(`额度查询全部失败：${errors.join('；')}`);
}

async function checkIn(region, account) {
  if (region.code === 'international') {
    const quota = await refreshQuota(region, account).catch(() => null);
    return {
      ok: true,
      already: false,
      supported: false,
      message: '国际版额度由上游自动发放，已为你刷新当前额度',
      quota
    };
  }
  const url = `${region.apiBase}/v2/billing/meter/daily-checkin`;
  const res = await rawRequest(url, {
    method: 'POST',
    headers: growthHeaders(region, account, { userAgent: store.WEB_USER_AGENT }),
    body: '{}'
  });
  if (!res.ok) {
    throw new WorkBuddyError(`签到 HTTP ${res.status}`, res.status);
  }
  const body = res.json || {};
  const message = upstreamMessage(body);
  const code = Number(body.code);
  const already = message.includes('已签到') || /already/i.test(message);
  const supported = code === 0 || already;
  let hint = message;
  if (already) hint = '今日已签到';
  else if (code === 0) hint = '签到成功';
  else if (!message) hint = '签到失败（上游未返回原因）';
  let quota = null;
  if (supported) quota = await refreshQuota(region, account).catch(() => null);
  return { ok: supported, already, supported, message: hint, code: body.code, quota };
}

async function fetchTasks(region, account) {
  const url = `${region.apiBase}/v2/activity/growth/tasks`;
  const res = await rawRequest(url, { headers: growthHeaders(region, account) });
  if (!res.ok) {
    throw new WorkBuddyError(`任务列表 HTTP ${res.status}`, res.status);
  }
  const data = unwrap(res.json, '任务列表');
  const list = findArrayByKey(data || res.json, 'tasks', 0)
    || findArrayByKey(data || res.json, 'list', 0)
    || (Array.isArray(data) ? data : []);
  return list.map(toTask).filter(Boolean);
}

async function acceptTasks(region, account, codes) {
  const url = `${region.apiBase}/v2/activity/growth/tasks/accept`;
  const res = await rawRequest(url, {
    method: 'POST',
    headers: growthHeaders(region, account),
    body: JSON.stringify({ task_codes: codes })
  });
  if (!res.ok) {
    throw new WorkBuddyError(`接受任务 HTTP ${res.status}`, res.status);
  }
  return unwrap(res.json, '接受任务');
}

async function claimTask(region, account, code) {
  const url = `${store.GROWTH_HOST}/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
  const headers = growthHeaders(region, account, {
    origin: 'https://www.workbuddy.cn',
    referer: 'https://www.workbuddy.cn/profile/growth-center'
  });
  headers.Accept = 'application/json, text/plain, */*';
  headers['x-client-platform'] = 'web';
  const res = await rawRequest(url, { method: 'POST', headers, body: '{}' });
  if (!res.ok) {
    throw new WorkBuddyError(`领取奖励 HTTP ${res.status}`, res.status);
  }
  const body = res.json;
  if (!body || typeof body !== 'object') {
    throw new WorkBuddyError('领取奖励返回空响应');
  }
  const code0 = Number(body.code);
  if (Number.isFinite(code0) && code0 !== 0) {
    throw new WorkBuddyError(`领取奖励失败：${upstreamMessage(body) || code0}`, 0, body.code);
  }
  const data = body.data && typeof body.data === 'object' ? body.data : body;
  if (data.already_claimed === true || data.alreadyClaimed === true) {
    return { credit: 0, energy: 0, already: true, message: '已领取过该任务奖励' };
  }
  const credit = longOrNull(data.credit !== undefined ? data.credit : data.credit_amount) || 0;
  const energy = longOrNull(data.energy !== undefined ? data.energy : data.energy_amount) || 0;
  return { credit, energy, already: false, message: '领取成功' };
}

// /v3/config 是官方客户端拿模型目录的接口；模型对象里没有 realm 字段，区域只能按来源 host 判定。
const CATALOG_USER_AGENT = 'WorkBuddy/5.9.4 CLI/2.165.0';

function catalogBase(region, account) {
  const domain = String((account && account.domain) || '').trim();
  if (!domain) return region.modelsBase;
  const withScheme = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  return withScheme.replace(/\/+$/, '');
}

// /v3/config 的 data.models 是按路分组的对象：{cn:{models,pick}, global:{...}, enterprise:{...}}。
// 路名即区域标记，global 路出去要补 "global:" 前缀，裸 id 一律算国内。
const ROUTE_REGION = { global: 'international', cn: 'domestic', enterprise: 'domestic' };

function routePages(data) {
  const out = [];
  const raw = data && data.models;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    const page = raw[key];
    const list = Array.isArray(page) ? page
      : Array.isArray(page && page.models) ? page.models
      : Array.isArray(page && page.a) ? page.a
      : null;
    if (list && list.length) out.push({ route: key, list });
  }
  return out;
}

function bareModelId(id) {
  const value = String(id || '').trim();
  if (value.startsWith('global:')) return value.slice(7);
  if (value.startsWith('cn:')) return value.slice(3);
  return value;
}

// agents[].models 是各 agent 实际可用的模型白名单，顶层 models 是完整目录。
// 目录里混着 completion / codewise / image / video 这类非对话条目，全量吐出
// 会让客户端的模型列表里一半是选不了的东西，所以以白名单为准。
function agentModelIds(data) {
  const ids = new Set();
  const agents = data && Array.isArray(data.agents) ? data.agents : [];
  for (const agent of agents) {
    const list = agent && Array.isArray(agent.models) ? agent.models : [];
    for (const item of list) {
      const raw = typeof item === 'string' ? item : firstString(item || {}, ['id', 'model', 'model_id']);
      const bare = bareModelId(raw);
      if (bare) ids.add(bare);
    }
  }
  return ids;
}

async function fetchCatalog(region, account) {
  const base = process.env.WORKBUDDY_UPSTREAM_BASE || catalogBase(region, account);
  const url = `${base}/v3/config`;
  const headers = authorizedHeaders(region, account);
  headers.Accept = 'application/json, text/plain, */*';
  headers['X-CodeBuddy-Request'] = '1';
  headers['User-Agent'] = CATALOG_USER_AGENT;
  const res = await rawRequest(url, { headers });
  if (!res.ok) {
    throw new WorkBuddyError(`模型目录 HTTP ${res.status}`, res.status);
  }
  const data = unwrap(res.json, '模型目录');
  let list = [];
  if (Array.isArray(data)) {
    list = data;
  } else {
    const wanted = region && region.code === 'international' ? 'international' : 'domestic';
    const pages = routePages(data).filter((page) => (ROUTE_REGION[page.route] || 'domestic') === wanted);
    if (pages.length) {
      list = [].concat(...pages.map((page) => page.list));
    } else {
      const buckets = collectArraysByKey(data || {}, 'models');
      if (buckets.length) {
        const arrays = buckets.filter((bucket) => bucket.some((item) => item && typeof item === 'object'));
        list = arrays.length ? [].concat(...arrays) : [].concat(...buckets);
      }
    }
  }
  const international = Boolean(region && region.code === 'international');
  let models = list
    .map((item) => {
      const raw = firstString(item || {}, ['id', 'model', 'model_id']);
      if (!raw) return null;
      const bare = bareModelId(raw);
      if (!bare) return null;
      // 保留上游原始对象（maxInputTokens / supportsToolCall / tags 等），
      // 只覆盖 id 与展示名，元数据供 /v1/models 映射给客户端
      return Object.assign({}, item && typeof item === 'object' ? item : {}, {
        id: international ? `global:${bare}` : bare,
        name: firstString(item || {}, ['name', 'display_name', 'label']) || bare,
        vendor: firstString(item || {}, ['vendor'])
      });
    })
    .filter(Boolean);
  const allowed = agentModelIds(data);
  if (allowed.size) {
    const kept = [];
    const seen = new Set();
    for (const item of models) {
      const bare = bareModelId(item.id);
      if (!allowed.has(bare) || seen.has(bare)) continue;
      seen.add(bare);
      kept.push(item);
    }
    for (const bare of allowed) {
      if (seen.has(bare)) continue;
      seen.add(bare);
      kept.push({ id: international ? `global:${bare}` : bare, name: bare });
    }
    models = kept;
  }
  if (!models.length) {
    throw new WorkBuddyError('模型目录为空');
  }
  return models;
}

async function fetchModels(region, account) {
  try {
    const models = await fetchCatalog(region, account);
    return { models, source: 'remote' };
  } catch (error) {
    return {
      models: store.catalog.listFor(region.code),
      source: 'snapshot',
      errors: [String((error && error.message) || error)]
    };
  }
}

module.exports = {
  hashToken,
  uuidFrom,
  randomId,
  conversationSeed,
  ideHeaders,
  WorkBuddyError,
  rawRequest,
  unwrap,
  anonymousHeaders,
  authorizedHeaders,
  growthHeaders,
  parseAccount,
  parseQuota,
  toTask,
  toEpochMs,
  quotaBody,
  requestAuthState,
  pollAuthToken,
  refreshToken,
  refreshQuota,
  checkIn,
  fetchTasks,
  acceptTasks,
  claimTask,
  fetchCatalog,
  bareModelId,
  routePages,
  agentModelIds,
  ROUTE_REGION,
  fetchModels
};