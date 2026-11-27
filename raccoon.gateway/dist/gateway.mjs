#!/usr/bin/env node
/**
 * 小浣熊（商汤 Raccoon Work）OpenAI 兼容网关。
 *
 * 只监听回环地址：/v1 给 AiCode 提供商使用，/admin/api 给插件配置页使用。
 * 账号池、令牌续期、扫码/短信登录全部在本进程内完成。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { renderQrSvg } from './qr.mjs';
import { proxy as proxyUpstream } from './webproxy.mjs';

const VERSION = '1.0.3';
const UPSTREAM = 'https://xiaohuanxiong.com';
const AUTH_PREFIX = '/api/web/auth/v1';
const LLM_PREFIX = '/api/web/llm/v2';
const POINTS_PREFIX = '/api/web/points/v1';
const CLIENT = {
  platform: 'desktop-windows',
  version: 'v1.0.35',
  userAgent: 'Raccoon Work/1.0.35 (Windows)',
};
const PHONE_CIPHER_SECRET = 'senseraccoon2023';
const ALIYUN_CAPTCHA = { sceneId: '1pkmy0x3', prefix: 'hk1r5l' };
const REFRESH_AHEAD_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

const CHECKIN_CLIENTS = {
  desktop: {
    path: '/api/web/desktop/v1/login/points/grant',
    platform: 'desktop-windows',
    version: 'v1.0.0',
  },
  mobile: {
    path: '/api/web/mobile/v1/login/points/grant',
    platform: 'app-android',
    version: 'v1.0.4',
    extra: { 'x-raccoon-language': 'zh', 'x-requested-with': 'com.xiaohuanxiong.office' },
  },
};

const FALLBACK_MODELS = [
  { id: 'sn-sensenova-6-8-flash', name: 'SenseNova-6.8-Flash · 免费', description: '适合简单问答、内容改写和摘要等轻量任务', contextWindow: 256000, maxTokens: 63999, supportsImage: true, multiplier: 0, baseMultiplier: 0.5, status: 'limited_free', statusNote: '', visible: true },
  { id: 'sn-sensenova-6-8-flash-lite', name: 'SenseNova-6.8-Flash-Lite · 免费', description: '适合简单问答、内容改写和摘要等轻量任务', contextWindow: 256000, maxTokens: 63999, supportsImage: true, multiplier: 0, baseMultiplier: 0.5, status: 'limited_free', statusNote: '', visible: true },
  { id: 'sn-glm-5-3', name: 'GLM-5-3 · x0.75', description: '适合复杂办公任务、代码开发和调试等任务', contextWindow: 1000000, maxTokens: 100000, supportsImage: true, multiplier: 0.75, baseMultiplier: 0.75, status: 'normal', statusNote: '', visible: true },
  { id: 'sn-kimi-k3', name: 'Kimi-K3 · x1', description: '适合复杂办公任务、代码开发、调试和图像识别等任务', contextWindow: 1000000, maxTokens: 100000, supportsImage: true, multiplier: 1, baseMultiplier: 1, status: 'normal', statusNote: '', visible: true },
  { id: 'sn-glm-5-3-flash', name: 'GLM-5-3-Flash · x0.2', description: '适合通用对话、轻量代码和内容处理等任务', contextWindow: 1000000, maxTokens: 100000, supportsImage: true, multiplier: 0.2, baseMultiplier: 0.2, status: 'normal', statusNote: '', visible: true },
  { id: 'sn-deepseek-v4-1-flash', name: 'DeepSeek-V4.1-Flash · x0.25', description: '适合通用对话、代码开发、复杂分析和推理任务', contextWindow: 1000000, maxTokens: 100000, supportsImage: true, multiplier: 0.25, baseMultiplier: 0.25, status: 'normal', statusNote: '', visible: true },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--port') out.port = Number(argv[++i]);
    else if (flag === '--data-dir') out.dataDir = path.resolve(argv[++i]);
    else if (flag === '--host') out.host = argv[++i];
    else if (isCliEntry()) throw new Error(`未知参数：${flag}`);
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.port && process.env.RACCOON_GATEWAY_PORT) {
  const envPort = Number(process.env.RACCOON_GATEWAY_PORT);
  if (Number.isInteger(envPort) && envPort > 0) args.port = envPort;
}
if (args.help) {
  process.stdout.write(`小浣熊网关 ${VERSION}
用法：node gateway.mjs [选项]
  --port <端口>       监听端口，默认取 settings.json 的 requestedPort（18912）
  --data-dir <目录>   数据目录，默认 RACCOON_GATEWAY_HOME 或 ~/.raccoon-gateway
  --host <地址>       监听地址，默认 127.0.0.1（管理接口始终只允许回环）
`);
  process.exit(0);
}

const DATA_DIR = args.dataDir
  || process.env.RACCOON_GATEWAY_HOME
  || path.join(os.homedir(), '.raccoon-gateway');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CHECKIN_FILE = path.join(DATA_DIR, 'checkin.json');

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function loadSettings() {
  const settings = readJson(SETTINGS_FILE, {});
  let changed = false;
  if (typeof settings.apiKey !== 'string' || settings.apiKey.length === 0) {
    settings.apiKey = `sk-rcgw-${crypto.randomBytes(12).toString('hex')}`;
    changed = true;
  }
  if (typeof settings.adminKey !== 'string' || settings.adminKey.length === 0) {
    settings.adminKey = crypto.randomBytes(24).toString('hex');
    changed = true;
  }
  if (!Number.isInteger(settings.requestedPort) || settings.requestedPort <= 0) {
    settings.requestedPort = 18912;
    changed = true;
  }
  if (typeof settings.autoCheckin !== 'boolean') {
    settings.autoCheckin = true;
    changed = true;
  }
  if (changed) writeJson(SETTINGS_FILE, settings);
  return settings;
}

const settings = loadSettings();
if (Number.isInteger(args.port) && args.port > 0) settings.requestedPort = args.port;

const state = readJson(STATE_FILE, { cooldown: {}, catalog: null, rr: 0, lastError: {} });
if (typeof state.cooldown !== 'object' || state.cooldown === null) state.cooldown = {};
if (typeof state.lastError !== 'object' || state.lastError === null) state.lastError = {};
if (!Number.isFinite(state.rr)) state.rr = 0;
function saveState() {
  try {
    writeJson(STATE_FILE, state);
  } catch {
    /* 状态缓存写失败不影响推理 */
  }
}

function isCliEntry() {
  const entry = process.argv[1];
  return typeof entry === 'string' && entry.endsWith('gateway.mjs');
}

const logLines = [];
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  logLines.push(line);
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  if (isCliEntry()) process.stdout.write(`${line}\n`);
}

function readAccounts() {
  const list = readJson(ACCOUNTS_FILE, []);
  if (Array.isArray(list)) return list;
  if (list && Array.isArray(list.accounts)) return list.accounts;
  return [];
}

function saveAccounts(list) {
  writeJson(ACCOUNTS_FILE, list);
}

function jwtClaims(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function accountExpiry(account) {
  const raw = account.expiresAt ?? account.expires_at;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const claims = jwtClaims(account.accessToken || account.access_token || '');
  return claims && typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
}

function encryptPhone(phone) {
  const key = Buffer.from(PHONE_CIPHER_SECRET, 'utf8');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cfb', key, iv);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(phone, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, ciphertext]).toString('base64');
}

function raccoonHeaders(token, orgCode, extra = {}) {
  return {
    'user-agent': CLIENT.userAgent,
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-org-code': orgCode || '',
    'x-raccoon-language': 'zh',
    'x-client-platform': CLIENT.platform,
    'x-client-version': CLIENT.version,
    ...extra,
  };
}

async function postEnvelope(pathname, body, headers = {}) {
  let response;
  try {
    response = await fetch(`${UPSTREAM}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`请求上游失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`上游响应不是 JSON（HTTP ${response.status}）`);
  }
  const envelope = payload && typeof payload === 'object' ? payload : {};
  const code = typeof envelope.code === 'number' ? envelope.code : (response.status >= 400 ? response.status : 0);
  return {
    status: response.status,
    code,
    message: typeof envelope.message === 'string' ? envelope.message : '',
    details: typeof envelope.details === 'string' ? envelope.details : '',
    data: envelope.data && typeof envelope.data === 'object' ? envelope.data : {},
  };
}

function envelopeError(result, fallback) {
  const text = [result.message, result.details].filter((s) => s && s.length > 0).join(': ');
  return new Error(text || fallback);
}

function maskAccount(account) {
  const expiry = accountExpiry(account);
  return {
    id: account.id,
    name: account.name || '小浣熊账号',
    userId: account.userId || '',
    phone: account.phone || '',
    orgCode: account.orgCode || '',
    enabled: account.enabled !== false,
    expiresAt: expiry,
    expired: expiry > 0 && expiry <= Date.now(),
    refreshable: typeof account.refreshToken === 'string' && account.refreshToken.length > 0,
    cooldownUntil: state.cooldown[account.id] || 0,
    lastError: state.lastError[account.id] || '',
    tokenPreview: previewToken(account.accessToken),
  };
}

function previewToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  if (token.length <= 16) return `${token.slice(0, 4)}…`;
  return `${token.slice(0, 10)}…${token.slice(-6)}`;
}

async function refreshAccount(account) {
  if (typeof account.refreshToken !== 'string' || account.refreshToken.length === 0) {
    throw new Error('账号没有 refresh_token，无法续期');
  }
  const result = await postEnvelope(`${AUTH_PREFIX}/refresh`, { refresh_token: account.refreshToken });
  if (result.status === 401 || result.code === 200003) {
    throw new Error('登录态已过期，请重新登录');
  }
  if (result.code !== 0) throw envelopeError(result, '续期失败');
  const accessToken = typeof result.data.access_token === 'string' ? result.data.access_token : '';
  if (accessToken.length === 0) throw new Error('续期响应缺少 access_token');

  const list = readAccounts();
  const index = list.findIndex((item) => item.id === account.id);
  if (index < 0) throw new Error('账号已被删除');
  const current = list[index];
  const nextRefresh = typeof result.data.refresh_token === 'string' && result.data.refresh_token.length > 0
    ? result.data.refresh_token
    : current.refreshToken;
  const claims = jwtClaims(accessToken);
  current.accessToken = accessToken;
  current.refreshToken = nextRefresh;
  current.expiresAt = claims && typeof claims.exp === 'number' ? claims.exp * 1000 : Date.now() + 3 * 3600 * 1000;
  delete state.lastError[account.id];
  saveAccounts(list);
  saveState();
  log(`续期成功 ${account.id} 至 ${new Date(current.expiresAt).toISOString()}`);
  return current;
}

async function ensureToken(account, force) {
  const expiry = accountExpiry(account);
  const stillFresh = typeof account.accessToken === 'string' && account.accessToken.length > 0
    && (expiry === 0 || expiry - Date.now() > REFRESH_AHEAD_MS);
  if (!force && stillFresh) return account.accessToken;
  if (typeof account.refreshToken === 'string' && account.refreshToken.length > 0) {
    try {
      const next = await refreshAccount(account);
      return next.accessToken;
    } catch (error) {
      state.lastError[account.id] = error.message;
      saveState();
      log(`续期失败 ${account.id}: ${error.message}`);
      if (force || !account.accessToken) throw error;
    }
  }
  if (force && account.accessToken) throw new Error('令牌已失效且无法续期');
  return account.accessToken || null;
}

function pickAccount(tried) {
  const all = readAccounts().filter((a) => a.enabled !== false && typeof a.accessToken === 'string' && a.accessToken.length > 0);
  if (all.length === 0) return null;
  const now = Date.now();
  const isCooling = (a) => (state.cooldown[a.id] || 0) > now;
  let pool = all.filter((a) => !isCooling(a) && !tried.has(a.id));
  if (pool.length === 0) pool = all.filter((a) => !tried.has(a.id));
  if (pool.length === 0) pool = all.filter((a) => !isCooling(a));
  if (pool.length === 0) pool = all;
  const account = pool[state.rr % pool.length];
  state.rr = (state.rr + 1) % 1_000_000_000;
  return account;
}

function setCooldown(id, ms) {
  state.cooldown[id] = Date.now() + Math.max(1000, ms);
  saveState();
}

function untilNextUtc8Midnight() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600 * 1000);
  const next = Date.UTC(utc8.getUTCFullYear(), utc8.getUTCMonth(), utc8.getUTCDate() + 1) - 8 * 3600 * 1000;
  return next;
}

function isQuotaError(text) {
  return /积分不足|余额不足|insufficient[\s_-]*(points|balance|credits)|HTTP\s*402/i.test(text);
}

function formatMultiplier(value) {
  return String(Number(value.toFixed(4)));
}

function displayName(model) {
  const base = model.description || model.id;
  const effective = model.multiplier;
  if (typeof effective !== 'number' || !Number.isFinite(effective) || effective < 0) return base;
  if (effective === 0) return `${base} · 免费`;
  if (typeof model.baseMultiplier === 'number' && model.baseMultiplier > effective) {
    return `${base} · x${formatMultiplier(model.baseMultiplier)}→x${formatMultiplier(effective)}`;
  }
  return `${base} · x${formatMultiplier(effective)}`;
}

function normalizeModel(entry) {
  const id = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (id.length === 0) return null;
  const params = entry.params && typeof entry.params === 'object' ? entry.params : {};
  const tags = Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag).toLowerCase()) : [];
  const multiplier = typeof entry.billing_effective_multiplier === 'number' ? entry.billing_effective_multiplier : Number.NaN;
  const baseMultiplier = typeof entry.billing_multiplier === 'number' ? entry.billing_multiplier : Number.NaN;
  const status = entry.billing_status === 'discount' || entry.billing_status === 'limited_free'
    ? entry.billing_status
    : 'normal';
  const model = {
    id,
    description: typeof entry.display_description === 'string' && entry.display_description.length > 0
      ? entry.display_description
      : (typeof entry.description === 'string' ? entry.description : id),
    contextWindow: Number(params.context_window ?? entry.context_window) || 0,
    maxTokens: Number(params.max_tokens ?? entry.max_tokens) || 0,
    supportsImage: tags.includes('vision') || tags.includes('image') || ['sn-deepseek-v4-1-flash', 'sn-glm-5-3-flash'].includes(id),
    multiplier,
    baseMultiplier,
    status,
    statusNote: typeof entry.billing_status_note === 'string' ? entry.billing_status_note : '',
    visible: entry.visible !== false,
    tags,
  };
  model.name = displayName(model);
  return model;
}

async function getCatalog(force = false) {
  if (!force && state.catalog && Array.isArray(state.catalog.models) && Date.now() - state.catalog.at < CATALOG_TTL_MS) {
    return state.catalog.models;
  }
  const account = pickAccount(new Set());
  if (account) {
    try {
      const token = await ensureToken(account, false);
      const response = await fetch(`${UPSTREAM}${LLM_PREFIX}/model_catalog`, {
        headers: raccoonHeaders(token, account.orgCode, { accept: 'application/json' }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = await response.json();
        const models = [];
        for (const category of payload?.data?.categories ?? []) {
          for (const entry of category.models ?? []) {
            const model = normalizeModel(entry);
            if (model) models.push(model);
          }
        }
        if (models.length > 0) {
          state.catalog = { at: Date.now(), models };
          saveState();
          return models;
        }
      } else {
        log(`模型目录 HTTP ${response.status}`);
      }
    } catch (error) {
      log(`模型目录获取失败：${error.message}`);
    }
  }
  return state.catalog && Array.isArray(state.catalog.models) ? state.catalog.models : FALLBACK_MODELS;
}

function upsertAccount(record) {
  const list = readAccounts();
  const byId = list.findIndex((item) => item.id === record.id);
  const byUser = record.userId ? list.findIndex((item) => item.userId === record.userId) : -1;
  const index = byId >= 0 ? byId : byUser;
  if (index >= 0) {
    const current = list[index];
    list[index] = {
      ...current,
      ...record,
      name: record.name || current.name,
      enabled: current.enabled !== false,
      createdAt: current.createdAt || record.createdAt,
    };
  } else {
    list.push(record);
  }
  saveAccounts(list);
  return index >= 0 ? 'updated' : 'added';
}

function accountFromCredential(data, extra = {}) {
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  if (accessToken.length === 0) throw new Error('登录响应缺少 access_token');
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
  const claims = jwtClaims(accessToken) || {};
  const userId = typeof data.user_id === 'string' ? data.user_id
    : (typeof claims.sub === 'string' ? claims.sub : '');
  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : Date.now() + 3 * 3600 * 1000;
  const id = extra.id || (userId ? `user-${userId}` : `acc-${crypto.randomBytes(6).toString('hex')}`);
  return {
    id,
    name: extra.name || '小浣熊账号',
    accessToken,
    refreshToken,
    expiresAt,
    userId,
    enabled: true,
    orgCode: typeof data.office_identity === 'string' ? data.office_identity : '',
    phone: extra.phone || '',
    createdAt: Date.now(),
  };
}

async function fetchUserInfo(account) {
  try {
    const token = await ensureToken(account, false);
    const response = await fetch(`${UPSTREAM}${AUTH_PREFIX}/user_info`, {
      headers: raccoonHeaders(token, account.orgCode, { accept: 'application/json' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return {};
    const payload = await response.json();
    if (payload?.code !== 0 || !payload.data) return {};
    return {
      userId: typeof payload.data.id === 'string' ? payload.data.id : '',
      name: typeof payload.data.name === 'string' ? payload.data.name : '',
      phone: typeof payload.data.phone === 'string' ? payload.data.phone : '',
      orgCode: typeof payload.data.office_identity === 'string' ? payload.data.office_identity : '',
    };
  } catch {
    return {};
  }
}

function friendlyName(phone) {
  if (typeof phone !== 'string' || phone.length < 7) return '';
  return `小浣熊 ${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function normalizeImportItem(item) {
  if (typeof item === 'string') {
    const token = item.trim();
    if (!token) return null;
    return { accessToken: token, refreshToken: '' };
  }
  if (!item || typeof item !== 'object') return null;
  const accessToken = item.accessToken || item.access_token || item.access || '';
  const refreshToken = item.refreshToken || item.refresh_token || item.refresh || '';
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  const claims = jwtClaims(accessToken) || {};
  const userId = item.userId || item.user_id || (typeof claims.sub === 'string' ? claims.sub : '');
  const rawExpiry = item.expiresAt ?? item.expires_at ?? item.expires;
  const numeric = typeof rawExpiry === 'number' ? rawExpiry : Number(rawExpiry);
  const expiresAt = Number.isFinite(numeric) && numeric > 0
    ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : (typeof claims.exp === 'number' ? claims.exp * 1000 : 0);
  return {
    id: typeof item.id === 'string' && item.id.length > 0
      ? item.id
      : (userId ? `user-${userId}` : `acc-${crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 12)}`),
    name: typeof item.name === 'string' && item.name.length > 0
      ? item.name
      : (typeof item.nickname === 'string' && item.nickname.length > 0 ? item.nickname : '小浣熊账号'),
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    expiresAt,
    userId,
    phone: typeof item.phone === 'string' ? item.phone : '',
    orgCode: item.orgCode || item.office_identity || '',
    deviceId: item.deviceId || item.device_id || '',
    enabled: item.enabled !== false,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
  };
}

function importAccounts(payload, mode) {
  let parsed = payload;
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (!text) throw new Error('导入内容为空');
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('导入内容不是合法 JSON');
    }
  }
  let items = parsed;
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    items = parsed.accounts || parsed.data || parsed.list || [parsed];
  }
  if (!Array.isArray(items)) throw new Error('导入内容需要是账号数组或 {accounts:[…]}');

  const incoming = [];
  for (const item of items) {
    const record = normalizeImportItem(item);
    if (record) incoming.push(record);
  }
  if (incoming.length === 0) throw new Error('没有解析到任何含 accessToken 的账号');

  const current = mode === 'replace' ? [] : readAccounts();
  let added = 0;
  let updated = 0;
  for (const record of incoming) {
    const index = current.findIndex((item) => item.id === record.id
      || (record.userId && item.userId === record.userId)
      || (record.refreshToken && item.refreshToken === record.refreshToken));
    if (index >= 0) {
      const previous = current[index];
      current[index] = {
        ...previous,
        ...record,
        name: record.name || previous.name,
        enabled: previous.enabled !== false && record.enabled !== false,
        createdAt: previous.createdAt || record.createdAt,
      };
      updated++;
    } else {
      current.push(record);
      added++;
    }
  }
  saveAccounts(current);
  log(`导入账号：新增 ${added}，更新 ${updated}，总计 ${current.length}`);
  backfillAccounts(incoming.filter((record) => !record.phone).map((record) => record.id));
  return { added, updated, total: current.length, skipped: items.length - incoming.length };
}

/**
 * 后台补全手机号与名称。
 *
 * 导入的 JSON 往往只有令牌，账号名全一样，无法区分；逐个查 user_info
 * 把手机号回填，列表里就能看到「小浣熊 180****5424」。
 */
function backfillAccounts(ids) {
  const targets = [...new Set(ids)];
  if (targets.length === 0) return;
  setImmediate(async () => {
    for (const id of targets) {
      const account = readAccounts().find((item) => item.id === id);
      if (!account || account.phone) continue;
      const info = await fetchUserInfo(account);
      if (!info.phone && !info.orgCode) continue;
      const list = readAccounts();
      const target = list.find((item) => item.id === id);
      if (!target) continue;
      if (info.phone) {
        target.phone = info.phone;
        target.name = friendlyName(info.phone) || target.name;
      }
      if (info.orgCode) target.orgCode = info.orgCode;
      saveAccounts(list);
    }
  });
}

const loginSessions = new Map();

function loginStart() {
  const code = crypto.randomBytes(16).toString('hex');
  const url = `${UPSTREAM}/login/mp?code=${code}&appname=${encodeURIComponent('商汤小浣熊官网')}`;
  loginSessions.set(code, Date.now());
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, at] of loginSessions) if (at < cutoff) loginSessions.delete(key);
  return { code, url, qrSvg: renderQrSvg(url, { size: 220 }), expiresIn: 300 };
}

async function loginPoll(code) {
  if (!code || !loginSessions.has(code)) return { status: 'unknown', message: '登录会话已失效，请刷新二维码' };
  let result;
  try {
    result = await postEnvelope(`${AUTH_PREFIX}/login_with_qrcode_code`, { qrcode_code: code });
  } catch {
    return { status: 'pending' };
  }
  if (result.code !== 0) return { status: 'pending' };
  const status = typeof result.data.status === 'string' ? result.data.status : '';
  if (status === 'canceled') {
    loginSessions.delete(code);
    return { status: 'canceled', message: '二维码已取消，请刷新' };
  }
  if (status !== 'success') return { status: status || 'pending' };
  const accessToken = typeof result.data.access_token === 'string' ? result.data.access_token : '';
  if (accessToken.length === 0) return { status: 'pending' };
  const account = accountFromCredential(result.data);
  const info = await fetchUserInfo(account);
  if (info.phone) {
    account.phone = info.phone;
    account.name = friendlyName(info.phone);
  }
  if (info.orgCode) account.orgCode = info.orgCode;
  const outcome = upsertAccount(account);
  loginSessions.delete(code);
  log(`扫码登录成功 ${account.id}（${outcome}）`);
  return { status: 'success', outcome, account: maskAccount(account) };
}

async function smsSend(phone, captchaParam) {
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) throw new Error('请输入有效的 11 位手机号');
  const result = await postEnvelope(`${AUTH_PREFIX}/send_sms`, {
    captcha_param: String(captchaParam || ''),
    nation_code: '86',
    phone: encryptPhone(phone),
  });
  if (result.code !== 0) {
    if (result.code === 100006) throw new Error('图形验证码校验失败，请重新完成滑块验证');
    throw envelopeError(result, '下发短信验证码失败');
  }
  return { ok: true };
}

async function smsVerify(phone, smsCode) {
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) throw new Error('请输入有效的 11 位手机号');
  if (!/^\d{4,8}$/.test(String(smsCode || ''))) throw new Error('请输入短信验证码');
  const result = await postEnvelope(`${AUTH_PREFIX}/login_with_sms`, {
    nation_code: '86',
    phone: encryptPhone(phone),
    sms_code: String(smsCode),
  });
  if (result.code !== 0) throw envelopeError(result, '短信登录失败');
  const account = accountFromCredential(result.data, { phone });
  account.name = friendlyName(phone) || account.name;
  const info = await fetchUserInfo(account);
  if (info.orgCode) account.orgCode = info.orgCode;
  if (info.phone) account.phone = info.phone;
  const outcome = upsertAccount(account);
  log(`短信登录成功 ${account.id}（${outcome}）`);
  return { ok: true, outcome, account: maskAccount(account) };
}

/**
 * 网页登录。
 *
 * 官方登录页只能通过浏览器打开：`/work/api/web/auth/v1/code/authorize` 未登录时
 * 302 到 /login，登录完成后才跳 `office-raccoon://auth/callback?code=…`。
 * 这里把 state 与回调地址都指向网关自己，浏览器一跳回本机就拿到 code；
 * 若上游把回调固定成 office-raccoon:// 协议（浏览器无法打开），用户可直接
 * 粘贴地址栏里的整段链接，parseAuthorizationCode 兼容两种输入。
 */
const WEB_APPNAME = '办公小浣熊客户端';
const WEB_CALLBACK_SCHEME = 'office-raccoon://auth/callback';
const WEB_LOGIN_TTL_MS = 15 * 60 * 1000;

const webLoginSessions = new Map();

function pruneWebSessions() {
  const cutoff = Date.now() - WEB_LOGIN_TTL_MS;
  for (const [key, session] of webLoginSessions) {
    if (session.at < cutoff) webLoginSessions.delete(key);
  }
}

function webLoginStart() {
  pruneWebSessions();
  const state = crypto.randomBytes(12).toString('hex');
  // 不带 redirect_uri：dex 里只有 '&state='，原版客户端全靠 login_source=desktop
  // 让服务端自己回跳 office-raccoon://auth/callback。多传一个未注册的
  // redirect_uri，登录态下会被拒成站点 404。
  const query = new URLSearchParams({
    login_source: 'desktop',
    appname: WEB_APPNAME,
    state,
  });
  webLoginSessions.set(state, { at: Date.now(), code: '', busy: false });
  return {
    state,
    url: `${UPSTREAM}/work${AUTH_PREFIX}/code/authorize?${query.toString()}`,
    callbackScheme: WEB_CALLBACK_SCHEME,
    localCallback: `http://127.0.0.1:${settings.port || 18912}/web-callback`,
    expiresIn: Math.round(WEB_LOGIN_TTL_MS / 1000),
  };
}

function parseAuthorizationCode(raw) {
  const text = String(raw || '').trim();
  if (text.length === 0) throw new Error('请粘贴回调链接或授权码');
  const matched = text.match(/[?&]code=([^&#\s]+)/i);
  const code = matched ? decodeURIComponent(matched[1]) : text;
  if (!/^[A-Za-z0-9._~-]{6,512}$/.test(code)) throw new Error('授权码格式不正确，请重新复制');
  return code;
}

async function webLoginExchange(rawCode, state) {
  const code = parseAuthorizationCode(rawCode);
  const result = await postEnvelope(`${AUTH_PREFIX}/login_with_authorization_code`, {
    authorization_code: code,
  });
  if (result.code !== 0) {
    if (result.code === 200035) throw new Error('授权码无效或已使用，请重新点「打开授权页面」');
    throw envelopeError(result, '网页登录换取凭证失败');
  }
  const account = accountFromCredential(result.data);
  const info = await fetchUserInfo(account);
  if (info.phone) {
    account.phone = info.phone;
    account.name = friendlyName(info.phone) || account.name;
  }
  if (info.orgCode) account.orgCode = info.orgCode;
  const outcome = upsertAccount(account);
  if (state) webLoginSessions.delete(state);
  log(`网页登录成功 ${account.id}（${outcome}）`);
  return { ok: true, outcome, account: maskAccount(account) };
}

async function webLoginPoll(state) {
  const session = webLoginSessions.get(state);
  if (!session) return { status: 'unknown', message: '登录会话已失效，请重新点「打开授权页面」' };
  if (session.busy || !session.code) return { status: 'pending' };
  session.busy = true;
  try {
    return { status: 'success', ...(await webLoginExchange(session.code, state)) };
  } catch (error) {
    webLoginSessions.delete(state);
    return { status: 'failed', message: error.message };
  }
}

function webCallbackPage(ok, message) {
  const tone = ok ? '#1a7f37' : '#cf222e';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>小浣熊网页登录</title></head>`
    + `<body style="font-family:system-ui,sans-serif;padding:32px;line-height:1.7;color:#1f2328">`
    + `<h2 style="color:${tone};margin:0 0 12px">${ok ? '授权已回传' : '没有拿到授权码'}</h2>`
    + `<p>${message}</p>`
    + `<p style="color:#59636e">可以关闭此页面，回到 AiCode 的小浣熊面板查看结果。</p>`
    + `</body></html>`;
}

/**
 * 账号密码登录。
 *
 * 手机号与密码都用同一套 AES-128-CFB（随机 IV 前置、base64）加密提交，
 * 字段名固定 nation_code / phone / password。换到的令牌与扫码、短信完全一致。
 */
async function passwordLogin(phone, password) {
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('请输入有效的 11 位手机号');
  if (typeof password !== 'string' || password.length === 0) throw new Error('请输入密码');
  const result = await postEnvelope(`${AUTH_PREFIX}/login_with_password`, {
    nation_code: '86',
    phone: encryptPhone(phone),
    password: encryptPhone(password),
  });
  if (result.code !== 0) {
    if (/password invalid|password error/i.test(`${result.details} ${result.message}`)) {
      throw new Error('手机号或密码不正确');
    }
    throw envelopeError(result, '密码登录失败');
  }
  const account = accountFromCredential(result.data, { phone });
  account.name = friendlyName(phone) || account.name;
  const info = await fetchUserInfo(account);
  if (info.orgCode) account.orgCode = info.orgCode;
  if (info.phone) account.phone = info.phone;
  const outcome = upsertAccount(account);
  log(`密码登录成功 ${account.id}（${outcome}）`);
  return { ok: true, outcome, account: maskAccount(account) };
}

function applyThinking(body) {
  // 顶层 `reasoning_effort` 上游虽接受但实测无效果，且与 extra_body 同时出现会干扰，
  // 唯一有效的思考控制通道是 `extra_body.thinking`（Anthropic 风格对象）。
  const raw = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase() : '';
  delete body.reasoning_effort;
  if (raw.length === 0) return;
  const extra = body.extra_body && typeof body.extra_body === 'object' ? body.extra_body : {};
  if (extra.thinking !== undefined) {
    body.extra_body = extra;
    return;
  }
  const off = ['none', 'minimal', 'low', 'off', 'disabled'].includes(raw);
  body.extra_body = { ...extra, thinking: { type: off ? 'disabled' : 'enabled' } };
}

/**
 * 非流式响应兜底。
 *
 * 实测 `sn-sensenova-6-8-flash` 等模型在 `max_tokens` 被思考吃满时返回
 * `message.content === null`，正文全在 `reasoning_content`。客户端只认
 * `content`，会得到空回答，故在此把思考内容提升为正文并保留原字段。
 */
function normalizeCompletion(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices)) return payload;
  for (const choice of payload.choices) {
    const message = choice && choice.message;
    if (!message || typeof message !== 'object') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    if (content.length === 0 && reasoning.length > 0) message.content = reasoning;
  }
  return payload;
}

/**
 * 流式 SSE 兜底转换。
 *
 * 逐帧透传，同时累计 `reasoning_content`；若整段流从未出现 `content`，
 * 在 `[DONE]` 之前补一帧 content delta。`[DONE]` 被扣留到 flush 再发，
 * 否则补帧会落到它后面被客户端忽略。
 */
function createSseNormalizer() {
  let buffer = '';
  let sawContent = false;
  let sawDone = false;
  let reasoningText = '';
  const meta = { id: 'chatcmpl-raccoon', model: '', created: Math.floor(Date.now() / 1000) };

  const inspect = (line) => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (raw.length === 0 || raw === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof payload.id === 'string' && payload.id.length > 0) meta.id = payload.id;
    if (typeof payload.model === 'string' && payload.model.length > 0) meta.model = payload.model;
    if (typeof payload.created === 'number') meta.created = payload.created;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const delta = choice && choice.delta;
    if (delta && typeof delta.content === 'string' && delta.content.length > 0) sawContent = true;
    if (delta && typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      reasoningText += delta.reasoning_content;
    }
    const message = choice && choice.message;
    if (message && typeof message.content === 'string' && message.content.length > 0) sawContent = true;
  };

  const processFrame = (frame) => {
    const kept = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:') && line.slice(5).trim() === '[DONE]') {
        sawDone = true;
        continue;
      }
      inspect(line);
      kept.push(line);
    }
    return kept.join('\n');
  };

  const contentFrame = (text) => {
    const payload = {
      id: meta.id,
      object: 'chat.completion.chunk',
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString('utf8');
      let output = '';
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const kept = processFrame(frame);
        if (kept.trim().length > 0) output += `${kept}\n\n`;
      }
      if (output.length > 0) this.push(output);
      callback();
    },
    flush(callback) {
      let output = '';
      if (buffer.trim().length > 0) {
        const kept = processFrame(buffer);
        if (kept.trim().length > 0) output += `${kept}\n\n`;
        buffer = '';
      }
      if (!sawContent && reasoningText.length > 0) output += contentFrame(reasoningText);
      if (sawDone) output += 'data: [DONE]\n\n';
      if (output.length > 0) this.push(output);
      callback();
    },
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function openAiError(res, status, message, type = 'upstream_error') {
  sendJson(res, status, { error: { message, type, code: status } });
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function proxyChat(req, res, raw) {
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return openAiError(res, 400, '请求体不是合法 JSON', 'invalid_request_error');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return openAiError(res, 400, '请求体需要是 JSON 对象', 'invalid_request_error');
  }
  applyThinking(body);
  const wantStream = body.stream === true;
  const payload = JSON.stringify(body);
  const tried = new Set();
  let last = { status: 502, message: '没有可用账号，请先在插件配置页导入或登录' };

  for (let attempt = 0; attempt < 6; attempt++) {
    const account = pickAccount(tried);
    if (!account) break;
    tried.add(account.id);
    let token;
    try {
      token = await ensureToken(account, false);
    } catch (error) {
      last = { status: 401, message: error.message };
      continue;
    }
    if (!token) {
      last = { status: 401, message: `账号 ${account.name || account.id} 没有可用凭证` };
      continue;
    }

    for (let retry = 0; retry < 2; retry++) {
      let upstream;
      try {
        upstream = await fetch(`${UPSTREAM}${LLM_PREFIX}/chat/completions`, {
          method: 'POST',
          headers: raccoonHeaders(token, account.orgCode, {
            accept: wantStream ? 'text/event-stream' : 'application/json',
          }),
          body: payload,
          signal: wantStream ? undefined : AbortSignal.timeout(10 * 60 * 1000),
        });
      } catch (error) {
        last = { status: 502, message: `连接上游失败：${error.message}` };
        break;
      }

      if (upstream.ok) {
        log(`推理命中 ${account.id} ${body.model}${wantStream ? ' (stream)' : ''}`);
        if (!wantStream) {
          let payload;
          try {
            payload = normalizeCompletion(await upstream.json());
          } catch {
            last = { status: 502, message: '上游响应不是合法 JSON' };
            break;
          }
          return sendJson(res, 200, payload);
        }
        const contentType = upstream.headers.get('content-type') || 'text/event-stream';
        res.writeHead(200, {
          'content-type': contentType,
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
        });
        if (!upstream.body) return res.end();
        const stream = Readable.fromWeb(upstream.body);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(createSseNormalizer()).pipe(res);
        return;
      }

      const text = await upstream.text().catch(() => '');
      last = { status: upstream.status, message: text.slice(0, 800) || `上游 HTTP ${upstream.status}` };

      if ((upstream.status === 401 || upstream.status === 403) && retry === 0) {
        try {
          token = (await refreshAccount(account)).accessToken;
          continue;
        } catch (error) {
          last = { status: 401, message: error.message };
          break;
        }
      }
      if (upstream.status === 429) {
        setCooldown(account.id, COOLDOWN_MS);
        log(`账号 ${account.id} 触发限流，冷却 10 分钟`);
        break;
      }
      if (upstream.status === 402 || isQuotaError(text)) {
        const until = untilNextUtc8Midnight();
        setCooldown(account.id, until - Date.now());
        log(`账号 ${account.id} 积分不足，冷却至 ${new Date(until).toISOString()}`);
        break;
      }
      break;
    }
  }

  openAiError(res, last.status || 502, last.message);
}

function adminAuthorized(req, url) {
  const address = req.socket.remoteAddress || '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  if (!loopback) return false;
  const header = req.headers['x-admin-key'];
  const key = typeof header === 'string' ? header : (url.searchParams.get('key') || '');
  return key === settings.adminKey;
}

function apiAuthorized(req) {
  if (!settings.apiKey) return true;
  const header = req.headers.authorization || '';
  return header.replace(/^Bearer\s+/i, '').trim() === settings.apiKey;
}

function shanghaiDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function readCheckin() {
  const data = readJson(CHECKIN_FILE, {});
  if (!data || typeof data !== 'object') return {};
  const out = {};
  for (const [id, value] of Object.entries(data)) {
    if (typeof value === 'string') out[id] = { day: value };
    else if (value && typeof value === 'object') out[id] = value;
  }
  return out;
}

function saveCheckin(store) {
  writeJson(CHECKIN_FILE, store);
}

async function queryBalance(account, token) {
  const response = await fetch(`${UPSTREAM}${POINTS_PREFIX}/balance`, {
    headers: raccoonHeaders(token, account.orgCode, { accept: 'application/json' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== 0) return null;
  return payload.data && typeof payload.data === 'object' ? payload.data : null;
}

async function queryBills(account, token, limit = 20) {
  const response = await fetch(`${UPSTREAM}${POINTS_PREFIX}/bills?paging.limit=${limit}&paging.offset=0`, {
    headers: raccoonHeaders(token, account.orgCode, { accept: 'application/json' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== 0) return [];
  return payload.data && Array.isArray(payload.data.items) ? payload.data.items : [];
}

/**
 * 每日积分靠 login/points/grant 发放，桌面端与移动端共用同一份额度，
 * 所以桌面端成功就不再调移动端，桌面端报错时用移动端兜底。
 */
async function grantPoints(token, kind) {
  const client = CHECKIN_CLIENTS[kind];
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'user-agent': CLIENT.userAgent,
    'x-client-platform': client.platform,
    'x-client-version': client.version,
    ...(client.extra || {}),
  };
  if (kind === 'mobile') headers['content-type'] = 'application/json';
  const response = await fetch(`${UPSTREAM}${client.path}`, {
    method: 'POST',
    headers,
    body: kind === 'mobile' ? '{}' : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    throw new Error(`签到响应不是 JSON（HTTP ${response.status}）`);
  }
  const code = typeof payload.code === 'number' ? payload.code : 0;
  if (code !== 0) throw new Error(payload.message || payload.details || `签到失败 code=${code}`);
  return payload.data && typeof payload.data === 'object' ? payload.data : {};
}

async function todayGrantSum(account, token) {
  const day = shanghaiDay();
  const items = await queryBills(account, token, 20);
  let total = 0;
  for (const item of items) {
    const at = typeof item.created_at === 'string' ? item.created_at : '';
    const name = typeof item.event_name === 'string' ? item.event_name : '';
    if (!at.startsWith(day)) continue;
    if (!/发放|签到|奖励/.test(name)) continue;
    const value = typeof item.points === 'number' ? item.points : 0;
    total += value;
  }
  return total;
}

async function checkinAccount(account) {
  const day = shanghaiDay();
  const base = { id: account.id, name: account.name || account.id, day };
  let token;
  try {
    token = await ensureToken(account, false);
  } catch (error) {
    return { ...base, ok: false, message: `令牌不可用：${error.message}` };
  }
  if (!token) return { ...base, ok: false, message: '没有可用令牌' };

  const before = await queryBalance(account, token).catch(() => null);
  const beforePoints = before && typeof before.available_points === 'number' ? before.available_points : null;

  let data = null;
  let channel = '';
  let lastError = '';
  for (const kind of ['desktop', 'mobile']) {
    try {
      data = await grantPoints(token, kind);
      channel = kind;
      break;
    } catch (error) {
      lastError = error.message;
    }
  }
  if (!data) return { ...base, ok: false, beforePoints, message: lastError || '签到失败' };

  const after = await queryBalance(account, token).catch(() => null);
  const afterPoints = after && typeof after.available_points === 'number' ? after.available_points : null;
  const delta = beforePoints !== null && afterPoints !== null ? afterPoints - beforePoints : null;
  const granted = data.granted === true;
  const reported = typeof data.points === 'number'
    ? data.points
    : (data.popup && typeof data.popup.points === 'number' ? data.popup.points : null);
  const todayGrant = await todayGrantSum(account, token).catch(() => null);

  const store = readCheckin();
  store[account.id] = {
    day,
    at: Date.now(),
    granted,
    channel,
    delta,
    points: reported !== null ? reported : (delta !== null && delta > 0 ? delta : null),
    todayGrant,
  };
  saveCheckin(store);

  let message;
  if (granted) message = `签到成功${delta !== null && delta > 0 ? ` +${delta}` : ''}`;
  else if (delta !== null && delta > 0) message = `积分已到账 +${delta}`;
  else message = '今日已签到';
  log(`签到 ${account.id} ${day} ${channel} granted=${granted} delta=${delta}`);
  return { ...base, ok: true, granted, channel, points: reported, beforePoints, afterPoints, delta, todayGrant, message };
}

let checkinRunning = false;
let lastCheckinRun = null;
let checkinTimer = null;

async function runCheckin(options = {}) {
  if (checkinRunning) return { ok: false, message: '签到正在进行中' };
  const day = shanghaiDay();
  const store = readCheckin();
  const pool = readAccounts().filter((account) => account.enabled !== false
    && typeof account.accessToken === 'string' && account.accessToken.length > 0);
  const targets = options.ids && options.ids.length > 0
    ? pool.filter((account) => options.ids.includes(account.id))
    : pool.filter((account) => options.force || !(store[account.id] && store[account.id].day === day));
  if (targets.length === 0) {
    return { ok: true, day, checked: 0, results: [], message: '今天已全部签到' };
  }
  checkinRunning = true;
  const results = [];
  try {
    for (const account of targets) {
      try {
        results.push(await checkinAccount(account));
      } catch (error) {
        results.push({ id: account.id, name: account.name || account.id, day, ok: false, message: error.message });
      }
      if (results.length < targets.length) await new Promise((resolve) => setTimeout(resolve, 700));
    }
  } finally {
    checkinRunning = false;
  }
  lastCheckinRun = { at: Date.now(), day, count: results.length };
  return { ok: true, day, checked: results.length, results };
}

function msUntilNextCheckin() {
  const target = untilNextUtc8Midnight() + 5 * 60 * 1000;
  return Math.max(60 * 1000, target - Date.now());
}

function scheduleCheckin() {
  if (checkinTimer) {
    clearTimeout(checkinTimer);
    checkinTimer = null;
  }
  if (settings.autoCheckin === false) return;
  checkinTimer = setTimeout(async () => {
    try {
      const result = await runCheckin({});
      if (result.checked > 0) log(`自动签到完成 ${result.checked} 个账号`);
    } catch (error) {
      log(`自动签到失败：${error.message}`);
    }
    scheduleCheckin();
  }, msUntilNextCheckin());
  checkinTimer.unref?.();
}

function accountTest(account) {
  return (async () => {
    const token = await ensureToken(account, false);
    const info = await fetchUserInfo(account);
    let balance = null;
    try {
      balance = await queryBalance(account, token);
    } catch {
      balance = null;
    }
    return { ok: true, info, balance };
  })();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-admin-key');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname === '/health') {
      const accounts = readAccounts();
      const today = shanghaiDay();
      const store = readCheckin();
      return sendJson(res, 200, {
        ok: true,
        service: 'raccoon-gateway',
        version: VERSION,
        accounts: accounts.length,
        uptime: Math.round(process.uptime()),
        checkin: {
          auto: settings.autoCheckin !== false,
          day: today,
          checkedToday: accounts.filter((account) => {
            const record = store[account.id];
            return account.enabled !== false && Boolean(record && record.day === today);
          }).length,
          enabledAccounts: accounts.filter((account) => account.enabled !== false).length,
        },
      });
    }

    if (pathname === '/' || pathname === '/v1') {
      return sendJson(res, 200, {
        service: 'raccoon-gateway',
        version: VERSION,
        baseUrl: `/v1`,
        accounts: readAccounts().length,
      });
    }

    // 浏览器登录后跳回本机，不需要管理密钥：state 本身就是一次性的随机串。
    if (pathname === '/web-callback') {
      const state = url.searchParams.get('state') || '';
      const code = url.searchParams.get('code') || '';
      const session = state ? webLoginSessions.get(state) : null;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (!code) {
        res.writeHead(200);
        return res.end(webCallbackPage(false, '回调链接里没有 code 参数，请重新发起网页登录。'));
      }
      if (!session) {
        res.writeHead(200);
        return res.end(webCallbackPage(false, '登录会话已失效，请回到面板重新点「打开授权页面」。'));
      }
      session.code = code;
      res.writeHead(200);
      return res.end(webCallbackPage(true, '正在用授权码换取凭证，几秒后账号会自动加入账号池。'));
    }

    if (pathname.startsWith('/v1/')) {
      if (!apiAuthorized(req)) return openAiError(res, 401, 'API Key 不正确', 'authentication_error');

      if (pathname === '/v1/models' && req.method === 'GET') {
        const models = await getCatalog(false);
        const visible = models.filter((model) => model.visible !== false);
        const data = (visible.length > 0 ? visible : models).map((model) => ({
          id: model.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'raccoon',
          name: model.name,
          description: model.description,
          context_window: model.contextWindow,
          max_tokens: model.maxTokens,
          supports_image: model.supportsImage,
          multiplier: model.multiplier,
        }));
        return sendJson(res, 200, { object: 'list', data });
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        const raw = await readBody(req);
        return await proxyChat(req, res, raw);
      }

      return openAiError(res, 404, `未知接口 ${pathname}`, 'invalid_request_error');
    }

    if (pathname.startsWith('/admin/api/')) {
      if (!adminAuthorized(req, url)) return sendJson(res, 403, { ok: false, message: '管理密钥不正确' });

      if (pathname === '/admin/api/status' && req.method === 'GET') {
        const accounts = readAccounts();
        const today = shanghaiDay();
        const checkinStore = readCheckin();
        return sendJson(res, 200, {
          ok: true,
          version: VERSION,
          port: settings.port || settings.requestedPort,
          requestedPort: settings.requestedPort,
          baseUrl: `http://127.0.0.1:${settings.port || settings.requestedPort}/v1`,
          apiKey: settings.apiKey,
          dataDir: DATA_DIR,
          upstream: UPSTREAM,
          accounts: accounts.length,
          enabledAccounts: accounts.filter((a) => a.enabled !== false).length,
          models: state.catalog && Array.isArray(state.catalog.models) ? state.catalog.models.length : 0,
          uptime: Math.round(process.uptime()),
          captcha: ALIYUN_CAPTCHA,
          checkin: {
            auto: settings.autoCheckin !== false,
            day: today,
            checkedToday: accounts.filter((account) => {
              const record = checkinStore[account.id];
              return account.enabled !== false && Boolean(record && record.day === today);
            }).length,
            enabledAccounts: accounts.filter((a) => a.enabled !== false).length,
          },
        });
      }

      if (pathname === '/admin/api/accounts' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, accounts: readAccounts().map(maskAccount) });
      }

      if (pathname === '/admin/api/accounts/import' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const payload = body && body.payload !== undefined ? body.payload : body;
        const mode = body && body.mode === 'replace' ? 'replace' : 'merge';
        const result = importAccounts(payload, mode);
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (pathname === '/admin/api/accounts/enable' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const list = readAccounts();
        const account = list.find((item) => item.id === body.id);
        if (!account) return sendJson(res, 404, { ok: false, message: '账号不存在' });
        account.enabled = body.enabled !== false;
        saveAccounts(list);
        return sendJson(res, 200, { ok: true, account: maskAccount(account) });
      }

      if (pathname === '/admin/api/accounts/delete' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const list = readAccounts();
        const next = list.filter((item) => item.id !== body.id);
        if (next.length === list.length) return sendJson(res, 404, { ok: false, message: '账号不存在' });
        saveAccounts(next);
        delete state.cooldown[body.id];
        delete state.lastError[body.id];
        saveState();
        return sendJson(res, 200, { ok: true, total: next.length });
      }

      if (pathname === '/admin/api/accounts/refresh' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const list = readAccounts();
        const targets = body.id ? list.filter((item) => item.id === body.id) : list;
        const results = [];
        for (const account of targets) {
          if (typeof account.refreshToken !== 'string' || account.refreshToken.length === 0) {
            results.push({ id: account.id, ok: false, message: '没有 refresh_token' });
            continue;
          }
          try {
            const next = await refreshAccount(account);
            results.push({ id: next.id, ok: true, expiresAt: next.expiresAt });
          } catch (error) {
            results.push({ id: account.id, ok: false, message: error.message });
          }
        }
        return sendJson(res, 200, { ok: true, results });
      }

      if (pathname === '/admin/api/accounts/test' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const account = readAccounts().find((item) => item.id === body.id);
        if (!account) return sendJson(res, 404, { ok: false, message: '账号不存在' });
        try {
          const result = await accountTest(account);
          return sendJson(res, 200, { ok: true, ...result, account: maskAccount(account) });
        } catch (error) {
          return sendJson(res, 200, { ok: false, message: error.message });
        }
      }

      if (pathname === '/admin/api/checkin' && req.method === 'GET') {
        const day = shanghaiDay();
        const store = readCheckin();
        return sendJson(res, 200, {
          ok: true,
          day,
          auto: settings.autoCheckin !== false,
          running: checkinRunning,
          lastRun: lastCheckinRun,
          accounts: readAccounts().map((account) => {
            const record = store[account.id] || null;
            return {
              ...maskAccount(account),
              checkedInToday: Boolean(record && record.day === day),
              checkin: record,
            };
          }),
        });
      }

      if (pathname === '/admin/api/checkin' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const ids = body.id ? [body.id] : (Array.isArray(body.ids) && body.ids.length > 0 ? body.ids : null);
        const result = await runCheckin({ ids, force: body.force === true });
        return sendJson(res, 200, result);
      }

      if (pathname === '/admin/api/checkin/auto' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        settings.autoCheckin = body.enabled !== false;
        writeJson(SETTINGS_FILE, settings);
        scheduleCheckin();
        return sendJson(res, 200, { ok: true, auto: settings.autoCheckin });
      }

      if (pathname === '/admin/api/models' && req.method === 'GET') {
        const models = await getCatalog(url.searchParams.get('refresh') === '1');
        return sendJson(res, 200, { ok: true, models });
      }

      if (pathname === '/admin/api/logs' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, lines: logLines.slice(-200) });
      }

      if (pathname === '/admin/api/login/start' && req.method === 'POST') {
        return sendJson(res, 200, { ok: true, ...loginStart() });
      }

      if (pathname === '/admin/api/login/poll' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...(await loginPoll(url.searchParams.get('code') || '')) });
      }

      if (pathname === '/admin/api/login/cancel' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (body.code) loginSessions.delete(body.code);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/admin/api/login/sms/send' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        try {
          await smsSend(body.phone, body.captchaParam);
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          return sendJson(res, 200, { ok: false, message: error.message });
        }
      }

      if (pathname === '/admin/api/login/sms/verify' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        try {
          const result = await smsVerify(body.phone, body.code);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, 200, { ok: false, message: error.message });
        }
      }

      if (pathname === '/admin/api/login/password' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        try {
          const result = await passwordLogin(String(body.phone || '').trim(), String(body.password || ''));
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, 200, { ok: false, message: error.message });
        }
      }

      if (pathname === '/admin/api/login/web/start' && req.method === 'POST') {
        return sendJson(res, 200, { ok: true, ...webLoginStart() });
      }

      if (pathname === '/admin/api/login/web/poll' && req.method === 'GET') {
        const state = url.searchParams.get('state') || '';
        if (state.length === 0) return sendJson(res, 200, { ok: false, status: 'unknown', message: '缺少 state' });
        return sendJson(res, 200, { ok: true, ...(await webLoginPoll(state)) });
      }

      if (pathname === '/admin/api/login/web/code' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        try {
          const result = await webLoginExchange(body.code, body.state || '');
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, 200, { ok: false, message: error.message });
        }
      }

      return sendJson(res, 404, { ok: false, message: `未知管理接口 ${pathname}` });
    }

    // 宿主 WebView 的 CSP 不允许 iframe 加载外部源，内嵌浏览器走不通；
    // 保留 /rp 代理仅用于调试登录页，未知路径仍按 404 处理。
    if (pathname === '/rp' || pathname.startsWith('/rp/')) {
      return await handleWebProxy(req, res, url);
    }

    return sendJson(res, 404, { ok: false, message: 'not found' });
  } catch (error) {
    log(`请求异常 ${pathname}: ${error.message}`);
    if (!res.headersSent) return sendJson(res, 500, { ok: false, message: error.message });
    res.destroy();
  }
});

function webLoginResultPage(ok, message) {
  const tone = ok ? '#1a7f37' : '#cf222e';
  const payload = JSON.stringify({ type: 'raccoon-web-login', ok, message });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><title>登录结果</title></head>`
    + `<body style="font-family:system-ui,sans-serif;padding:28px;line-height:1.7;text-align:center">`
    + `<p style="font-size:32px;margin:0 0 8px">${ok ? '✅' : '⚠️'}</p>`
    + `<p style="color:${tone};font-size:16px;font-weight:600">${message}</p>`
    + `<p style="color:#59636e;font-size:13px">可以先关闭这个登录窗口。</p>`
    + `<script>try{parent.postMessage(${payload},'*')}catch(e){}</script>`
    + `</body></html>`;
}

async function handleWebProxy(req, res, url) {
  const target = url.pathname.replace(/^\/rp/, '') || '/';
  return proxyUpstream(req, res, url, {
    path: target,
    onCode: async (code) => {
      try {
        const result = await webLoginExchange(code, '');
        return webLoginResultPage(true, `登录成功：${result.account.name || result.account.id}`);
      } catch (error) {
        return webLoginResultPage(false, error.message);
      }
    },
  });
}

const host = args.host || '127.0.0.1';
const startPort = Number.isInteger(args.port) && args.port > 0 ? args.port : settings.requestedPort;
let attemptPort = startPort;

function listen(port, remaining) {
  server.removeAllListeners('error');
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && remaining > 0) {
      log(`端口 ${port} 被占用，尝试 ${port + 1}`);
      attemptPort = port + 1;
      listen(port + 1, remaining - 1);
      return;
    }
    process.stderr.write(`监听失败：${error.message}\n`);
    if (isCliEntry()) process.exit(1);
  });
  server.listen(port, host, () => {
    settings.port = port;
    settings.requestedPort = startPort;
    writeJson(SETTINGS_FILE, settings);
    log(`小浣熊网关已启动 http://${host}:${port}/v1（数据目录 ${DATA_DIR}）`);
    if (isCliEntry()) process.stdout.write(`RACCOON_GATEWAY_READY port=${port}\n`);
  });
}

/**
 * 在当前进程内启动网关。插件宿主侧的 node 不一定能 spawn 子进程，
 * 所以 main.js 优先直接 import 本模块，失败才回退到独立进程。
 */
export function startGateway() {
  listen(attemptPort, 20);
  if (settings.autoCheckin !== false) {
    setTimeout(() => {
      runCheckin({}).catch((error) => log(`启动签到失败：${error.message}`));
    }, 15000).unref?.();
  }
  scheduleCheckin();
  return server;
}

export function closeGateway() {
  if (checkinTimer) {
    clearTimeout(checkinTimer);
    checkinTimer = null;
  }
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(resolve, 1500).unref?.();
  });
}

export function gatewayLogs() {
  return logLines.slice(-200);
}

export { server };

if (isCliEntry()) {
  startGateway();
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
