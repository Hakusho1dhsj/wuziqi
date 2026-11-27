#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const store = require('./store.js');
const catalog = require('./catalog.js');
const wb = require('./wb.js');
const cred = require('./cred.js');

const VERSION = '1.0.0';
// 构建标识：旧版本没有这个字段，插件据此判断端口上跑的是哪一代代码
const BUILD = '2026-11-19T9';
const SERVICE = 'workbuddy-gateway';
const CHAT_PATH = '/v2/chat/completions';

const REFRESH_AHEAD_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;
const ATTEMPTS_PER_ACCOUNT = 2;
const MAX_ACCOUNTS_PER_REQUEST = 5;
const LOG_LIMIT = 200;

const HOST = '127.0.0.1';
const DEFAULT_PORT = 18913;
const PORT_SCAN = 20;

let DATA_DIR = '';
let LISTEN_PORT = DEFAULT_PORT;
let settings = null;
let accounts = [];
let state = { rr: 0, cooldown: {}, requests: 0, lastProxyAt: 0, lastError: null };
let server = null;
let startedAt = 0;
let refreshTimer = null;
let catalogTimer = null;
const logs = [];

function logLine(scope, message) {
  const line = `${new Date().toISOString()} [${scope}] ${message}`;
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  return line;
}

function gatewayLogs() {
  return logs.slice();
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function maskKey(value) {
  const text = String(value || '');
  if (text.length <= 12) return text ? '***' : '';
  return `${text.slice(0, 8)}***${text.slice(-4)}`;
}

function hashText(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function settingsFile() {
  return path.join(DATA_DIR, 'settings.json');
}

function accountsFile() {
  return path.join(DATA_DIR, 'accounts.json');
}

function stateFile() {
  return path.join(DATA_DIR, 'state.json');
}

// 只由 CLI 子进程写：embedded 模式下进程就是插件宿主，pid 没有回收价值
function pidFile() {
  return path.join(DATA_DIR, 'gateway.pid');
}

function defaultSettings() {
  return {
    apiKey: `sk-wbgw-${randomHex(12)}`,
    adminKey: randomHex(24),
    requestedPort: DEFAULT_PORT,
    port: DEFAULT_PORT,
    autoRefresh: true,
    autoRefreshMinutes: 30,
    maxAccounts: MAX_ACCOUNTS_PER_REQUEST,
    activeRegion: ''
  };
}

function loadSettings() {
  const raw = readJson(settingsFile(), null);
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') {
    writeJson(settingsFile(), base);
    return base;
  }
  const merged = Object.assign(base, raw);
  if (!merged.apiKey) merged.apiKey = base.apiKey;
  if (!merged.adminKey) merged.adminKey = base.adminKey;
  if (!Number.isFinite(Number(merged.port)) || Number(merged.port) <= 0) merged.port = base.port;
  const dirty = ['apiKey', 'adminKey', 'port'].some((key) => merged[key] !== raw[key]);
  if (dirty) writeJson(settingsFile(), merged);
  return merged;
}

function saveSettings() {
  writeJson(settingsFile(), settings);
}

function loadState() {
  const raw = readJson(stateFile(), null);
  const base = { rr: 0, cooldown: {}, requests: 0, lastProxyAt: 0, lastError: null };
  if (!raw || typeof raw !== 'object') return base;
  return {
    rr: Number(raw.rr) || 0,
    cooldown: raw.cooldown && typeof raw.cooldown === 'object' ? raw.cooldown : {},
    requests: Number(raw.requests) || 0,
    lastProxyAt: Number(raw.lastProxyAt) || 0,
    lastError: raw.lastError || null
  };
}

function saveState() {
  writeJson(stateFile(), state);
}

function resolveRegion(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'domestic' || text === 'cn') return 'domestic';
  if (text === 'international' || text === 'intl') return 'international';
  if (text.includes('tencent') || text.includes('codebuddy.cn')) return 'domestic';
  return 'international';
}

function tokenRegionHint(accessToken) {
  const parts = String(accessToken || '').split('.');
  if (parts.length < 2) return '';
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').toLowerCase();
    if (payload.includes('codebuddy.cn') || payload.includes('tencent')) return 'domestic';
  } catch {
    return '';
  }
  return '';
}

function tokenExpiresAt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const exp = Number(payload && payload.exp);
    if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  } catch {
    return 0;
  }
  return 0;
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const accessToken = String(raw.accessToken || raw.access_token || '').trim();
  if (!accessToken) return null;
  const uid = String(raw.uid || raw.user_id || '').trim();
  const region = resolveRegion(raw.region || raw.domain || tokenRegionHint(accessToken));
  const regionInfo = store.REGIONS[region];
  return {
    id: String(raw.id || (uid ? `wb-${uid.slice(0, 8)}` : `wb-${hashText(accessToken).slice(0, 8)}`)),
    uid,
    nickname: String(raw.nickname || raw.name || '').trim(),
    domain: String(raw.domain || '').trim() || regionInfo.domain,
    region,
    accessToken,
    refreshToken: String(raw.refreshToken || raw.refresh_token || '').trim(),
    expiresAt: tokenExpiresAt(accessToken) || Number(raw.expiresAt || raw.expires_at) || 0,
    enabled: raw.enabled !== false,
    addedAt: Number(raw.addedAt) || Date.now(),
    lastUsedAt: Number(raw.lastUsedAt) || 0,
    lastError: String(raw.lastError || '')
  };
}

function accountFromLegacyState() {
  let legacy = null;
  try {
    legacy = store.load();
  } catch {
    return null;
  }
  if (!legacy || !legacy.account || !legacy.account.accessToken) return null;
  return normalizeAccount(
    Object.assign({}, legacy.account, {
      region: legacy.account.region || (legacy.settings && legacy.settings.region)
    })
  );
}

function loadAccounts() {
  const raw = readJson(accountsFile(), null);
  if (Array.isArray(raw) && raw.length) {
    const list = [];
    let changed = false;
    for (const item of raw) {
      const normalized = normalizeAccount(item);
      if (!normalized) continue;
      if (Number(item.expiresAt || item.expires_at) !== normalized.expiresAt) changed = true;
      list.push(normalized);
    }
    if (list.length) {
      if (changed) writeJson(accountsFile(), list);
      return list;
    }
  }
  const legacy = accountFromLegacyState();
  if (legacy) return [legacy];
  return [];
}

function saveAccounts() {
  writeJson(accountsFile(), accounts);
}

function accountBrief(account) {
  const regionInfo = store.REGIONS[account.region];
  return {
    id: account.id,
    uid: account.uid,
    nickname: account.nickname,
    domain: account.domain,
    region: account.region,
    regionName: regionInfo ? regionInfo.displayName : account.region,
    enabled: account.enabled,
    expiresAt: account.expiresAt || 0,
    expiresInSeconds: account.expiresAt ? Math.round((account.expiresAt - Date.now()) / 1000) : null,
    hasRefreshToken: Boolean(account.refreshToken),
    accessTokenMasked: store.maskToken(account.accessToken),
    cooldownUntil: state.cooldown[account.id] || 0,
    lastUsedAt: account.lastUsedAt || 0,
    lastError: account.lastError || ''
  };
}

function setCooldown(id, ms) {
  state.cooldown[id] = Date.now() + ms;
  saveState();
}

function clearCooldown(id) {
  if (state.cooldown[id]) {
    delete state.cooldown[id];
    saveState();
  }
}

function pickAccount(tried, regionFilter) {
  const now = Date.now();
  const allowed = Array.isArray(regionFilter) && regionFilter.length ? regionFilter : null;
  const usable = accounts.filter(
    (item) => item.enabled && item.accessToken && (!allowed || allowed.includes(item.region))
  );
  if (!usable.length) return null;
  const untried = usable.filter((item) => !tried.includes(item.id));
  const pool = untried.length ? untried : usable;
  const cooled = pool.filter((item) => (state.cooldown[item.id] || 0) <= now);
  const pickFrom = cooled.length ? cooled : pool;
  const index = state.rr % pickFrom.length;
  state.rr = (state.rr + 1) % 1000000;
  return pickFrom[index];
}

async function ensureToken(account, force) {
  const now = Date.now();
  const soon = account.expiresAt ? account.expiresAt - now < REFRESH_AHEAD_MS : false;
  if (!force && !soon) return account;
  if (!account.refreshToken) {
    if (!soon) return account;
    throw new Error('access_token 已过期且没有 refresh_token，请重新登录或导入凭证');
  }
  const regionInfo = store.REGIONS[account.region];
  const next = await wb.refreshToken(regionInfo, account);
  account.accessToken = next.accessToken;
  if (next.refreshToken) account.refreshToken = next.refreshToken;
  if (next.expiresAt) account.expiresAt = next.expiresAt;
  if (next.uid && !account.uid) account.uid = next.uid;
  if (next.nickname && !account.nickname) account.nickname = next.nickname;
  account.lastError = '';
  clearCooldown(account.id);
  saveAccounts();
  logLine('token', `${account.id} 刷新成功`);
  return account;
}

function readBody(req, limitBytes) {
  const limit = limitBytes || 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(body);
}

function openAiError(message, status, code) {
  return {
    error: {
      message: String(message || '未知错误'),
      type: status === 401 ? 'unauthorized' : 'gateway_error',
      code: code || null
    }
  };
}

function upstreamBaseList(region) {
  if (process.env.WORKBUDDY_UPSTREAM_BASE) return [process.env.WORKBUDDY_UPSTREAM_BASE];
  const bases = Array.isArray(region.chatBases) ? region.chatBases.filter(Boolean) : [];
  return bases.length ? bases : [region.apiBase];
}

function sendOpenAiError(res, status, message, code) {
  sendJson(res, status, openAiError(message, status, code));
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant. Respond in the user's language, follow the user's instructions, and be direct and concise.";

const THINKING_OFF = new Set(['off', 'none', 'disabled']);

const ERROR_RULES = [
  {
    kind: 'quota',
    cooldown: QUOTA_COOLDOWN_MS,
    patterns: [
      /insufficient[_ ]quota/i,
      /insufficient balance/i,
      /insufficient credit/i,
      /quota exceeded/i,
      /余额不足/,
      /额度不足/,
      /积分不足/
    ]
  },
  { kind: 'rate', cooldown: COOLDOWN_MS, patterns: [/rate.?limit/i, /too many requests/i, /限流/, /请求过于频繁/] },
  {
    kind: 'auth',
    refresh: true,
    patterns: [/12153/, /session dead/i, /token expired/i, /invalid token/i, /登录过期/]
  },
  {
    kind: 'bad_params',
    terminal: true,
    patterns: [/"code"\s*:\s*11101\b/, /11101/, /unmarshal chat params failed/i]
  },
  {
    kind: 'blocked',
    terminal: true,
    patterns: [/content policy/i, /content_filter/i, /security policy/i, /sensitive/i, /违规内容/, /风险/]
  },
  { kind: 'too_long', terminal: true, patterns: [/11115/, /prompt is too long/i, /context length/i] },
  {
    kind: 'image_invalid',
    terminal: true,
    patterns: [/11133/, /invalid image/i, /image format/i, /unsupported image/i, /图片格式/]
  },
  {
    kind: 'illegal',
    terminal: true,
    patterns: [/11140/, /request illegal/i, /14017/, /trial not activated/]
  },
  { kind: 'channel', patterns: [/11128/, /11-128/] }
];

function classifyUpstream(status, text) {
  const body = String(text || '');
  if (status === 429 && /14018/.test(body)) return { kind: 'quota', cooldown: QUOTA_COOLDOWN_MS };
  if (status === 402) return { kind: 'quota', cooldown: QUOTA_COOLDOWN_MS };
  if (status === 429) return { kind: 'rate', cooldown: COOLDOWN_MS };
  if (status === 401 || status === 403) return { kind: 'auth', refresh: true };
  for (const rule of ERROR_RULES) {
    if (rule.patterns.some((re) => re.test(body))) return rule;
  }
  return { kind: 'upstream' };
}

function upstreamMessage(text) {
  const body = String(text || '').trim();
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const msg = parsed.displayMsg || parsed.msg || parsed.message || parsed.error;
    if (typeof msg === 'string' && msg) return msg.slice(0, 500);
    if (msg && typeof msg === 'object') {
      const zh = msg.zh || msg.en;
      if (typeof zh === 'string' && zh) return `${parsed.code !== undefined ? `${parsed.code} ` : ''}${zh}`.slice(0, 500);
    }
    if (parsed.code !== undefined && parsed.msg) return `${parsed.code} ${parsed.msg}`.slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
  return body.slice(0, 500);
}

function dropReasoningParts(messages) {
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;
    message.content = message.content.filter((part) => {
      const type = part && typeof part.type === 'string' ? part.type.toLowerCase() : '';
      return type !== 'reasoning_text' && type !== 'reasoning';
    });
  }
}

function fillEmptyTextParts(messages) {
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      const type = typeof part.type === 'string' ? part.type : null;
      if (type === null || type === 'text') {
        if (typeof part.text !== 'string' || part.text.length === 0) part.text = ' ';
      }
    }
  }
}

function ensureSystemPrompt(messages) {
  const first = messages && messages[0];
  const role = first && typeof first.role === 'string' ? first.role.toLowerCase() : '';
  if (role === 'system') return;
  if (role === 'developer') {
    first.role = 'system';
    return;
  }
  messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
}

function normalizeToolChoice(body) {
  if (!body || !('tool_choice' in body)) return;
  const choice = body.tool_choice;
  if (typeof choice === 'string') {
    body.tool_choice = choice;
    return;
  }
  if (!choice || typeof choice !== 'object') {
    delete body.tool_choice;
    return;
  }
  const type = typeof choice.type === 'string' ? choice.type.toLowerCase() : '';
  if (type === 'none') {
    delete body.tool_choice;
    delete body.tools;
    delete body.functions;
    return;
  }
  if (type === 'function') {
    const fn = choice.function && typeof choice.function === 'object' ? choice.function : null;
    let name = fn && typeof fn.name === 'string' ? fn.name : '';
    if (!name && typeof choice.name === 'string') name = choice.name;
    body.tool_choice = name ? name : 'auto';
    return;
  }
  delete body.tool_choice;
}

function applyThinking(body, modelId) {
  const raw = body.reasoning_effort !== undefined ? body.reasoning_effort : body.reasoningEffort;
  if (raw === undefined || raw === null) return;
  const effort = String(raw).trim().toLowerCase();
  if (!effort) return;
  const thinking = body.thinking && typeof body.thinking === 'object' ? body.thinking : null;
  if (THINKING_OFF.has(effort)) {
    if (thinking) thinking.type = 'disabled';
    else body.thinking = { type: 'disabled' };
    delete body.reasoning_effort;
    delete body.reasoningEffort;
    return;
  }
  if (thinking) thinking.type = 'enabled';
  else body.thinking = { type: 'enabled' };
  if (!/deepseek/i.test(String(modelId || ''))) {
    body.reasoning_effort = effort;
    delete body.reasoningEffort;
  }
}

function normalizeUpstreamBody(input, modelId, conversationRequestId, cacheKeyBase) {
  const body = JSON.parse(JSON.stringify(input || {}));
  // 区域前缀只用于本地路由，上游只认裸 id
  body.model = catalog.stripRegion(modelId);
  body.stream = true;

  if (body.max_completion_tokens !== undefined && body.max_tokens === undefined) {
    body.max_tokens = body.max_completion_tokens;
  }
  delete body.max_completion_tokens;
  if (body.max_tokens === undefined && body.max_output_tokens !== undefined) {
    body.max_tokens = body.max_output_tokens;
  }
  delete body.max_output_tokens;

  if (!body.stream_options || typeof body.stream_options !== 'object') {
    body.stream_options = { include_usage: true };
  } else {
    body.stream_options.include_usage = true;
  }

  normalizeToolChoice(body);
  applyThinking(body, modelId);

  if (Array.isArray(body.messages)) {
    dropReasoningParts(body.messages);
    fillEmptyTextParts(body.messages);
    ensureSystemPrompt(body.messages);
    const messages = body.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message || typeof message !== 'object') continue;
      if (typeof message.role !== 'string' || message.role !== 'user') continue;
      if (!message.conversationRequestId) {
        message.conversationRequestId = conversationRequestId;
        message.startsNewUserRequest = true;
        if (typeof message.agent !== 'string' || !message.agent) message.agent = 'cli';
      }
      break;
    }
  }

  if (!body.prompt_cache_key && cacheKeyBase) body.prompt_cache_key = cacheKeyBase;
  return body;
}

function sseText(part) {
  if (typeof part === 'string') return part;
  if (Array.isArray(part)) {
    return part.map((item) => (item && typeof item.text === 'string' ? item.text : '')).join('');
  }
  return '';
}

function estimateTokens(text) {
  const length = String(text || '').length;
  return length ? Math.max(1, Math.ceil(length / 4)) : 0;
}

function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
}

function mergeUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return;
  target.prompt_tokens = Number(usage.prompt_tokens) || target.prompt_tokens;
  target.completion_tokens = Number(usage.completion_tokens) || target.completion_tokens;
  target.total_tokens = Number(usage.total_tokens) || target.total_tokens;
  const promptDetails = usage.prompt_tokens_details || usage.prompt_cache_hit_tokens;
  if (promptDetails && typeof promptDetails === 'object') {
    target.cached_tokens = Number(promptDetails.cached_tokens) || target.cached_tokens;
  } else if (typeof promptDetails === 'number') {
    target.cached_tokens = promptDetails;
  }
  const completionDetails = usage.completion_tokens_details;
  if (completionDetails && typeof completionDetails === 'object') {
    target.reasoning_tokens = Number(completionDetails.reasoning_tokens) || target.reasoning_tokens;
  }
}

async function aggregateSse(webStream, modelId, promptText) {
  const usage = emptyUsage();
  const toolCalls = new Map();
  let id = '';
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let sawUsage = false;
  let done = false;

  const handlePayload = (payload) => {
    if (!payload) return;
    if (payload === '[DONE]' || payload.startsWith('[DONE]')) {
      done = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (!chunk || typeof chunk !== 'object') return;
    if (typeof chunk.id === 'string' && chunk.id) id = chunk.id;
    if (chunk.usage) {
      mergeUsage(usage, chunk.usage);
      sawUsage = true;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : null;
      if (!delta) continue;
      if (typeof delta.content === 'string') content += delta.content;
      else if (Array.isArray(delta.content)) content += sseText(delta.content);
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      else if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!call || typeof call !== 'object') continue;
        const index = Number.isFinite(call.index) ? Number(call.index) : toolCalls.size;
        const entry = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (typeof call.id === 'string' && call.id) entry.id = call.id;
        if (typeof call.type === 'string' && call.type) entry.type = call.type;
        const fn = call.function && typeof call.function === 'object' ? call.function : null;
        if (fn) {
          if (typeof fn.name === 'string' && fn.name) entry.function.name = fn.name;
          if (typeof fn.arguments === 'string') entry.function.arguments += fn.arguments;
        }
        toolCalls.set(index, entry);
      }
    }
  };

  const reader = Readable.fromWeb(webStream);
  let pending = '';
  for await (const chunk of reader) {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      handlePayload(line.slice(5).trim());
      if (done) break;
    }
    if (done) break;
  }
  if (!done && pending.trim().startsWith('data:')) handlePayload(pending.trim().slice(5).trim());

  const message = { role: 'assistant' };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, entry], i) => ({
        id: entry.id || `call_${i}`,
        type: entry.type || 'function',
        function: entry.function
      }));
  }
  if (message.content === undefined) message.content = toolCalls.size ? null : '';

  if (!sawUsage) {
    usage.completion_tokens = estimateTokens(content + reasoning);
    usage.prompt_tokens = estimateTokens(promptText);
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  } else if (!usage.total_tokens) {
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  }

  return {
    id: id || 'chatcmpl-workbuddy',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      prompt_tokens_details: { cached_tokens: usage.cached_tokens },
      completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens }
    }
  };
}

function promptTextOf(body) {
  if (!body || !Array.isArray(body.messages)) return '';
  return body.messages.map((message) => sseText(message && message.content)).join('\n');
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return String(req.headers['x-api-key'] || '').trim();
}

function adminToken(req) {
  return String(req.headers['x-admin-key'] || bearerToken(req) || '').trim();
}

function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function regionPoolSize(region) {
  return accounts.filter((item) => item.enabled && item.accessToken && item.region === region).length;
}

// 刷新令牌已被上游明确拒绝（12153 等）时，即使还留着 token 也出不了量
const REFRESH_DEAD_RE = /刷新令牌|refresh[_\s]?token|12153/i;

// 能否真正出量：启用 + 有 token + 未过期；已过期时只有还留着可用的 refresh_token 才算
function accountUsable(item, now) {
  if (!item.enabled || !item.accessToken) return false;
  if (REFRESH_DEAD_RE.test(String(item.lastError || ''))) return false;
  if (!item.expiresAt || item.expiresAt > now) return true;
  return Boolean(item.refreshToken);
}

function regionUsableSize(region, now) {
  const at = now || Date.now();
  return accounts.filter((item) => item.region === region && accountUsable(item, at)).length;
}

// 默认区域：显式选择优先，否则取第一个有可用账号的区域；只用于默认模型与面板高亮
function activeRegion() {
  const want = String(settings.activeRegion || '');
  if (store.REGIONS[want] && regionUsableSize(want) > 0) return want;
  for (const region of ['international', 'domestic']) {
    if (regionUsableSize(region) > 0) return region;
  }
  return store.REGIONS[want] ? want : '';
}

// 有可用账号的区域；模型列表与调用路由都按这个集合放行
function enabledRegions() {
  const out = new Set();
  for (const code of Object.keys(store.REGIONS)) {
    if (regionUsableSize(code) > 0) out.add(code);
  }
  return out;
}

const CATALOG_RETRY_MS = 5 * 60 * 1000;
const catalogAttempt = {};
let catalogBusy = false;

function catalogAccount(region) {
  return accounts.find((item) => item.enabled && item.accessToken && item.region === region) || null;
}

async function refreshCatalog(regions) {
  const targets = regions instanceof Set ? [...regions] : Array.from(regions || []);
  await Promise.all(targets.map(async (region) => {
    const spot = store.REGIONS[region];
    const account = catalogAccount(region);
    if (!spot || !account) return;
    catalogAttempt[region] = Date.now();
    try {
      const models = await wb.fetchCatalog(spot, account);
      const snapshot = store.catalog.listFor(region);
      store.catalog.setState(region, models, 'remote');
      logLine(
        'catalog',
        `${region} 模型目录已更新：远程 ${models.length} 个（快照 ${snapshot.length} 个）`
      );
    } catch (error) {
      logLine('catalog', `${region} 模型目录刷新失败：${String((error && error.message) || error)}`);
    }
  }));
}

function catalogWanted(regions) {
  const now = Date.now();
  return Array.from(regions instanceof Set ? regions : regions || []).filter((region) => {
    if (!catalogAccount(region)) return false;
    if (now - (catalogAttempt[region] || 0) < CATALOG_RETRY_MS) return false;
    return store.catalog.stale(region, now);
  });
}

function refreshCatalogInBackground(regions) {
  if (catalogBusy) return;
  const targets = regions instanceof Set ? regions : new Set(regions || []);
  const need = catalogWanted(targets);
  if (!need.length) return;
  catalogBusy = true;
  refreshCatalog(need)
    .catch(() => {})
    .finally(() => { catalogBusy = false; });
}

// 上游用 camelCase 描述能力，客户端按 OpenAI 习惯读 snake_case；没有的字段就不输出，
// 免得凭空编造容量
const MODEL_META = [
  ['maxInputTokens', 'context_length'],
  ['maxOutputTokens', 'max_output_tokens'],
  ['maxAllowedSize', 'max_allowed_size'],
  ['credits', 'credits'],
  ['supportsToolCall', 'supports_tool_call'],
  ['supportsImages', 'supports_images'],
  ['supportsReasoning', 'supports_reasoning'],
  ['onlyReasoning', 'only_reasoning'],
  ['isDefault', 'is_default']
];

function modelMeta(item) {
  const out = {};
  for (const [from, to] of MODEL_META) {
    const value = item[from];
    if (value !== undefined && value !== null && value !== '') out[to] = value;
  }
  // 快照里的 vendor 是单字母内部代号（f/e/j），对方看到只会当成乱码，只在有真名时输出
  if (typeof item.vendor === 'string' && item.vendor.trim().length > 1) out.vendor = item.vendor;
  if (Array.isArray(item.tags) && item.tags.length) out.tags = item.tags;
  const reasoning = item.reasoning && typeof item.reasoning === 'object' ? item.reasoning : null;
  if (reasoning) {
    if (reasoning.canDisableThinking) out.can_disable_thinking = true;
    const effort = reasoning.defaultEffort || item.defaultEffort || item.effort;
    if (effort) out.reasoning_effort = effort;
  }
  return out;
}

function modelsPayload() {
  const avail = enabledRegions();
  // 只对有账号的区域刷远程目录，列表本身不受账号限制
  refreshCatalogInBackground(avail);
  const rows = [];
  const seen = new Set();
  for (const item of store.builtinModels()) {
    const declared = store.modelRegions(item.id, settings);
    if (!declared.length) continue;
    // 只列确实有可用账号的区域：某区域凭证失效（如国内令牌过期）时，
    // 该区域独有模型整体隐藏，两区共有的模型降到仍可用的那一区
    const usable = declared.filter((code) => avail.has(code));
    if (!usable.length) continue;
    const region = usable.length > 1 ? 'both' : usable[0];
    const bare = catalog.stripRegion(item.id);
    // 国际专属模型对外带上游同款 "global:" 前缀，请求侧再剥回去
    const publicId = region === 'international' ? `global:${bare}` : bare;
    if (seen.has(publicId)) continue;
    seen.add(publicId);
    rows.push({ item, declared: usable, region, publicId, name: item.name || bare });
  }
  // 国内外同名时客户端可能按名称合并成一条，同名的补区域后缀让每条独立可辨
  const nameCount = new Map();
  for (const row of rows) nameCount.set(row.name, (nameCount.get(row.name) || 0) + 1);
  const data = rows.map((row) => {
    const dup = nameCount.get(row.name) > 1;
    const suffix = row.region === 'international' ? '国际' : '国内';
    return Object.assign({
      id: row.publicId,
      name: dup ? `${row.name}（${suffix}）` : row.name,
      object: 'model',
      created: 1753600000,
      owned_by: 'workbuddy',
      region: row.region,
      region_label: store.modelRegionLabel(row.declared),
      regions: row.declared,
      // 归属区域中有启用账号的那部分：命中则直连，未命中则回退其它账号
      effective_regions: row.declared.filter((code) => avail.has(code)),
      callable: avail.size > 0
    }, modelMeta(row.item));
  });
  const labels = [...avail].map((region) => store.regionLabel([region])).join('、');
  return {
    object: 'list',
    data,
    workbuddy: {
      regions: [...avail],
      region_labels: [...avail].map((region) => ({ region, label: store.regionLabel([region]) })),
      active_region: activeRegion(),
      active_region_label: store.regionLabel([activeRegion()]),
      catalog: store.catalog.status(),
      note: avail.size
        ? `目录只列出有可用账号的区域，共 ${data.length} 个模型；账号覆盖${labels}，调用按模型归属选账号`
        : '还没有可用账号，先登录或导入凭证'
    }
  };
}

function statusPayload() {
  const cooldowns = accounts
    .map((item) => ({ id: item.id, until: state.cooldown[item.id] || 0 }))
    .filter((item) => item.until > Date.now());
  const regions = [...enabledRegions()];
  const active = activeRegion();
  return {
    ok: true,
    service: SERVICE,
    version: VERSION,
    host: HOST,
    port: LISTEN_PORT,
    baseUrl: `http://${HOST}:${LISTEN_PORT}/v1`,
    endpoint: `http://${HOST}:${LISTEN_PORT}/v1/chat/completions`,
    apiKey: settings.apiKey,
    apiKeyMasked: maskKey(settings.apiKey),
    autoRefresh: Boolean(settings.autoRefresh),
    autoRefreshMinutes: Number(settings.autoRefreshMinutes) || 0,
    accountCount: accounts.length,
    enabledCount: accounts.filter((item) => item.enabled).length,
    activeRegion: active,
    activeRegionLabel: store.regionLabel([active]),
    features: ['quota', 'region', 'models'],
    regionOptions: Object.keys(store.REGIONS).map((code) => ({
      region: code,
      label: store.regionLabel([code]),
      accounts: accounts.filter((item) => item.region === code).length,
      enabled: regionPoolSize(code),
      active: code === active
    })),
    regions,
    regionLabels: regions.map((code) => store.regionLabel([code])),
    accounts: accounts.map(accountBrief),
    cooldowns,
    requests: state.requests,
    lastProxyAt: state.lastProxyAt,
    lastError: state.lastError,
    uptimeSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    dataDir: DATA_DIR
  };
}

function applyImportedAccount(item, regionOverride) {
  const parsed = cred.parseCredentials(item);
  if (!parsed.accessToken) return null;
  if (regionOverride) parsed.region = regionOverride;
  const record = normalizeAccount(parsed);
  if (!record) return null;
  const index = accounts.findIndex((existing) => existing.id === record.id || (record.uid && existing.uid === record.uid) || existing.accessToken === record.accessToken);
  if (index >= 0) {
    record.addedAt = accounts[index].addedAt;
    record.enabled = accounts[index].enabled;
    accounts[index] = record;
    return { account: record, created: false };
  }
  accounts.push(record);
  return { account: record, created: true };
}

function importPayload(payload, regionOverride) {
  const list = cred.parseCredentialList(payload);
  const results = [];
  for (const item of list) {
    const applied = applyImportedAccount(item, regionOverride);
    if (applied) results.push(applied);
  }
  if (results.length) saveAccounts();
  return results;
}

async function proxyChat(req, res, raw) {
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    sendOpenAiError(res, 400, '请求体不是合法 JSON');
    return;
  }
  if (!body || typeof body !== 'object') {
    sendOpenAiError(res, 400, '请求体必须是 JSON 对象');
    return;
  }
  const wantStream = body.stream === true;
  const requestedModel = body.model ? String(body.model) : '';
  const modelId = requestedModel || store.catalog.defaultModel(
    activeRegion() ? [activeRegion()] : [...enabledRegions()]
  );
  body.model = modelId;
  const modelRegions = store.modelRegions(modelId, settings);
  const enabled = enabledRegions();
  if (!enabled.size) {
    sendOpenAiError(res, 400, '还没有可用账号：先在 WorkBuddy 面板登录或导入凭证');
    return;
  }
  // 优先走模型归属区域；归属区域都没有可用账号时直接拒绝，别拿其它区域的账号去打上游
  const preferred = modelRegions.filter((region) => enabled.has(region));
  if (modelRegions.length && !preferred.length) {
    const want = store.regionLabel(modelRegions);
    const message = `模型 ${modelId} 所属区域（${want}）当前没有可用账号，请重新登录该区域账号或改用其它模型`;
    logLine('proxy', message);
    sendOpenAiError(res, 400, message, 'region_unavailable');
    return;
  }
  const allowedRegions = preferred.length ? preferred : [...enabled];
  const poolAccounts = accounts.filter(
    (item) => item.enabled && item.accessToken && allowedRegions.includes(item.region)
  );
  const tried = [];
  let lastStatus = 502;
  let lastMessage = '没有可用账号：先在 WorkBuddy 面板登录或导入凭证';

  const rounds = Math.min(Math.max(poolAccounts.length, 1), settings.maxAccounts || MAX_ACCOUNTS_PER_REQUEST);

  for (let round = 0; round < rounds; round++) {
    const account = pickAccount(tried, allowedRegions);
    if (!account) break;
    if (!tried.includes(account.id)) tried.push(account.id);

    for (let attempt = 0; attempt < ATTEMPTS_PER_ACCOUNT; attempt++) {
      try {
        await ensureToken(account, attempt > 0);
      } catch (error) {
        lastStatus = 401;
        lastMessage = `账号 ${account.id} 令牌刷新失败：${error.message}`;
        account.lastError = error.message;
        saveAccounts();
        logLine('proxy', lastMessage);
        break;
      }

      const regionInfo = store.REGIONS[account.region];
      const conversationRequestId = wb.randomId(32);
      const conversationSeed = wb.conversationSeed(body.messages) || `d-${wb.randomId(32)}`;
      const cacheKey = wb.uuidFrom(`${account.uid || ''}|${conversationSeed}`);
      const upstreamBody = normalizeUpstreamBody(body, modelId, conversationRequestId, cacheKey);
      const bases = upstreamBaseList(regionInfo);
      const headersFor = () =>
        wb.ideHeaders(regionInfo, account, {
          requestId: conversationRequestId,
          conversationSeed,
          retryCount: attempt
        });

      let upstream = null;
      let text = '';
      for (let b = 0; b < bases.length; b++) {
        const headers = headersFor();
        headers.Accept = wantStream ? 'text/event-stream' : 'application/json';
        if (!wantStream) headers['Accept-Encoding'] = 'identity';

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
        let response;
        try {
          response = await fetch(`${bases[b]}${CHAT_PATH}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody),
            signal: controller.signal
          });
        } catch (error) {
          clearTimeout(timer);
          const reason = error && error.name === 'AbortError' ? '上游超时' : error.message;
          lastStatus = 504;
          lastMessage = `账号 ${account.id} 请求失败：${reason}`;
          account.lastError = reason;
          saveAccounts();
          logLine('proxy', lastMessage);
          upstream = null;
          break;
        }
        clearTimeout(timer);

        if (response.status === 404 && b + 1 < bases.length) {
          logLine('proxy', `${bases[b]} 返回 404，换 ${bases[b + 1]}`);
          await response.text().catch(() => '');
          continue;
        }
        upstream = response;
        break;
      }

      if (!upstream) {
        if (lastStatus === 504) continue;
        break;
      }

      if (!upstream.ok) {
        text = await upstream.text().catch(() => '');
        const verdict = classifyUpstream(upstream.status, text);
        lastStatus = upstream.status;
        logLine(
          'proxy',
          `${account.id} 上游 ${upstream.status} ${verdict.kind} body=${String(text).slice(0, 800)}`
        );
        lastMessage = `账号 ${account.id}：${upstreamMessage(text) || `HTTP ${upstream.status}`}`;
        account.lastError = verdict.kind === 'upstream' ? `HTTP ${upstream.status}` : verdict.kind;

        if (verdict.terminal) {
          saveAccounts();
          logLine('proxy', `${account.id} ${verdict.kind}，直接返回：${lastMessage}`);
          sendOpenAiError(res, upstream.status, lastMessage, verdict.kind);
          return;
        }

        if (verdict.cooldown) {
          setCooldown(account.id, verdict.cooldown);
          saveAccounts();
          logLine('proxy', `${account.id} ${verdict.kind}，冷却 ${Math.round(verdict.cooldown / 60000)} 分钟`);
          break;
        }

        if (verdict.refresh && attempt + 1 < ATTEMPTS_PER_ACCOUNT && account.refreshToken) {
          saveAccounts();
          logLine('proxy', `${account.id} ${verdict.kind}，刷新令牌后重试`);
          continue;
        }

        saveAccounts();
        logLine('proxy', `${account.id} 上游 HTTP ${upstream.status}`);
        if (upstream.status >= 500) continue;
        break;
      }

      account.lastUsedAt = Date.now();
      account.lastError = '';
      state.requests += 1;
      state.lastProxyAt = Date.now();
      state.lastError = null;
      saveAccounts();
      saveState();
      logLine('proxy', `${account.id} → ${modelId} (${wantStream ? 'stream' : 'json←sse'})`);

      if (wantStream) {
        res.writeHead(200, {
          'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'access-control-allow-origin': '*',
          'x-workbuddy-account': account.id,
          'x-request-id': upstream.headers.get('x-request-id') || '',
          'x-workbuddy-request-id': conversationRequestId
        });
        if (!upstream.body) {
          res.end();
          return;
        }
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }

      if (!upstream.body) {
        sendOpenAiError(res, 502, `账号 ${account.id} 上游没有返回响应体`);
        return;
      }
      let payload;
      try {
        payload = await aggregateSse(upstream.body, modelId, promptTextOf(upstreamBody));
      } catch (error) {
        lastStatus = 502;
        lastMessage = `账号 ${account.id} 聚合上游流失败：${error.message}`;
        account.lastError = '聚合失败';
        saveAccounts();
        logLine('proxy', lastMessage);
        continue;
      }
      payload.id = payload.id || 'chatcmpl-workbuddy';
      const json = JSON.stringify(payload);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        'Cache-Control': 'no-store',
        'access-control-allow-origin': '*',
        'x-workbuddy-account': account.id,
        'x-workbuddy-request-id': conversationRequestId,
        'X-Request-Id': payload.id
      });
      res.end(json);
      return;
    }
  }

  state.lastError = lastMessage;
  saveState();
  sendOpenAiError(res, lastStatus, lastMessage);
}

let quotaCache = { at: 0, data: null };
const QUOTA_CACHE_MS = 60 * 1000;
const QUOTA_ACCOUNT_MS = 10000;
const QUOTA_POOL_MS = 30000;
const QUOTA_CONCURRENCY = 6;
const quotaRows = new Map();

function withDeadline(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new wb.WorkBuddyError(`${label || '请求'}超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function quotaForAccount(account, budgetMs) {
  const regionInfo = store.resolveRegion(account.region || account.domain);
  const budget = budgetMs > 0 ? budgetMs : QUOTA_ACCOUNT_MS;
  const base = {
    id: account.id,
    uid: account.uid || '',
    nickname: account.nickname || '',
    region: regionInfo.code,
    regionName: regionInfo.displayName || regionInfo.code,
    enabled: Boolean(account.enabled)
  };
  try {
    const quota = await withDeadline(wb.refreshQuota(regionInfo, account), budget, '额度查询');
    return Object.assign(base, {
      remaining: Number(quota.remaining || 0),
      total: Number(quota.total || 0),
      expireAt: quota.expireAt || null,
      packages: (quota.packages || []).map((item) => ({
        name: item.name || '',
        remaining: Number(item.remaining || 0),
        total: Number(item.total || 0),
        expireAt: item.expireAt || null
      }))
    });
  } catch (error) {
    return Object.assign(base, { error: String((error && error.message) || error) });
  }
}

function cachedQuotaRow(account) {
  const row = quotaRows.get(account.id);
  if (!row || Date.now() - row.at > QUOTA_CACHE_MS) return null;
  return Object.assign({}, row.value, {
    uid: account.uid || row.value.uid || '',
    nickname: account.nickname || row.value.nickname || '',
    enabled: Boolean(account.enabled)
  });
}

function quotaTimeoutRow(account, message) {
  const regionInfo = store.resolveRegion(account.region || account.domain);
  return {
    id: account.id,
    uid: account.uid || '',
    nickname: account.nickname || '',
    region: regionInfo.code,
    regionName: regionInfo.displayName || regionInfo.code,
    enabled: Boolean(account.enabled),
    error: message
  };
}

async function quotaPayload(force) {
  const enabled = enabledRegions();
  const scope = [...enabled].sort().join('+');
  if (!force && quotaCache.data && quotaCache.region === scope && Date.now() - quotaCache.at < QUOTA_CACHE_MS) {
    return Object.assign({ cached: true }, quotaCache.data);
  }
  const targets = accounts.filter(
    (item) => item.enabled && (enabled.size ? enabled.has(item.region) : true)
  );
  const poolDeadline = Date.now() + QUOTA_POOL_MS;
  const rows = new Array(targets.length);
  const pending = [];
  targets.forEach((account, index) => {
    const hit = force ? null : cachedQuotaRow(account);
    if (hit) {
      rows[index] = hit;
      return;
    }
    pending.push({ index, account });
  });
  for (let i = 0; i < pending.length; i += QUOTA_CONCURRENCY) {
    const left = poolDeadline - Date.now();
    if (left <= 0) {
      pending.slice(i).forEach(({ index, account }) => {
        rows[index] = quotaTimeoutRow(account, '额度查询排队超时');
      });
      break;
    }
    const batch = pending.slice(i, i + QUOTA_CONCURRENCY);
    const done = await Promise.all(batch.map(({ account }) => quotaForAccount(account, Math.min(QUOTA_ACCOUNT_MS, left))));
    done.forEach((row, offset) => {
      rows[batch[offset].index] = row;
      if (!row.error) quotaRows.set(row.id, { at: Date.now(), value: row });
    });
  }
  const result = rows.filter(Boolean);
  const ok = result.filter((row) => !row.error);
  const data = {
    ok: true,
    accounts: result,
    remaining: ok.reduce((sum, row) => sum + row.remaining, 0),
    total: ok.reduce((sum, row) => sum + row.total, 0),
    counted: ok.length,
    failed: result.length - ok.length,
    updatedAt: Date.now()
  };
  if (ok.length) quotaCache = { at: Date.now(), region: scope, data };
  else if (!quotaCache.data || quotaCache.region !== scope) quotaCache = { at: Date.now(), region: scope, data };
  return data;
}

async function handleAdmin(req, res, url, raw) {
  const route = url.pathname.replace(/^\/admin\/api\/?/, '');
  const method = req.method || 'GET';

  if (route === 'status' && method === 'GET') {
    sendJson(res, 200, statusPayload());
    return;
  }

  if (route === 'models' && method === 'GET') {
    sendJson(res, 200, modelsPayload());
    return;
  }

  if (route === 'logs' && method === 'GET') {
    sendJson(res, 200, { logs: gatewayLogs() });
    return;
  }

  if (route === 'accounts' && method === 'GET') {
    sendJson(res, 200, { accounts: accounts.map(accountBrief) });
    return;
  }

  if (route === 'quota' && method === 'GET') {
    const force = url.searchParams.get('refresh') === '1';
    sendJson(res, 200, await quotaPayload(force));
    return;
  }

  if (route === 'accounts/import' && method === 'POST') {
    let payload = raw;
    let region = '';
    try {
      const parsed = JSON.parse(raw || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('payload' in parsed || 'region' in parsed)) {
        payload = parsed.payload !== undefined ? parsed.payload : parsed;
        region = String(parsed.region || '');
      }
    } catch {
      payload = raw;
    }
    const results = importPayload(payload, region);
    if (!results.length) {
      sendJson(res, 400, { ok: false, error: '没有解析出可用的 access_token' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      imported: results.length,
      accounts: results.map((item) => Object.assign(accountBrief(item.account), { created: item.created }))
    });
    return;
  }

  if (route === 'accounts/enable' && method === 'POST') {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    const target = accounts.find((item) => item.id === body.id);
    if (!target) {
      sendJson(res, 404, { ok: false, error: '账号不存在' });
      return;
    }
    target.enabled = body.enabled !== false;
    saveAccounts();
    sendJson(res, 200, { ok: true, account: accountBrief(target) });
    return;
  }

  if (route === 'accounts/delete' && method === 'POST') {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    const index = accounts.findIndex((item) => item.id === body.id);
    if (index < 0) {
      sendJson(res, 404, { ok: false, error: '账号不存在' });
      return;
    }
    const [removed] = accounts.splice(index, 1);
    delete state.cooldown[removed.id];
    saveAccounts();
    saveState();
    sendJson(res, 200, { ok: true, removed: removed.id });
    return;
  }

  if (route === 'accounts/refresh' && method === 'POST') {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    const targets = body.id ? accounts.filter((item) => item.id === body.id) : accounts;
    if (!targets.length) {
      sendJson(res, 404, { ok: false, error: '没有可刷新的账号' });
      return;
    }
    const results = [];
    for (const account of targets) {
      try {
        await ensureToken(account, true);
        results.push(Object.assign(accountBrief(account), { ok: true }));
      } catch (error) {
        results.push(Object.assign(accountBrief(account), { ok: false, error: error.message }));
      }
    }
    sendJson(res, 200, { ok: results.every((item) => item.ok), results });
    return;
  }

  if (route === 'region' && method === 'POST') {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    const next = String(body.region || '');
    if (next && !store.REGIONS[next]) {
      sendJson(res, 400, { ok: false, error: `未知区域：${next}` });
      return;
    }
    settings.activeRegion = next;
    saveSettings();
    logLine('region', `生效区域切换为：${next ? store.regionLabel([next]) : '自动'}`);
    refreshCatalogInBackground(enabledRegions());
    sendJson(res, 200, {
      ok: true,
      activeRegion: activeRegion(),
      activeRegionLabel: store.regionLabel([activeRegion()]),
      regionOptions: Object.keys(store.REGIONS).map((code) => ({
        region: code,
        label: store.regionLabel([code]),
        accounts: accounts.filter((item) => item.region === code).length,
        enabled: regionPoolSize(code),
        active: code === activeRegion()
      }))
    });
    return;
  }

  if (route === 'settings' && method === 'POST') {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    if (typeof body.autoRefresh === 'boolean') settings.autoRefresh = body.autoRefresh;
    if (Number.isFinite(Number(body.autoRefreshMinutes)) && Number(body.autoRefreshMinutes) >= 5) {
      settings.autoRefreshMinutes = Number(body.autoRefreshMinutes);
    }
    saveSettings();
    scheduleRefresh();
    sendJson(res, 200, { ok: true, settings: { autoRefresh: settings.autoRefresh, autoRefreshMinutes: settings.autoRefreshMinutes } });
    return;
  }

  sendJson(res, 404, { ok: false, error: `未知管理接口：${route}` });
}

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}:${LISTEN_PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-api-key, x-admin-key',
      'access-control-allow-methods': 'GET, POST, OPTIONS'
    });
    res.end();
    return;
  }

  if (pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: SERVICE,
      version: VERSION,
      build: BUILD,
      pid: process.pid,
      port: LISTEN_PORT,
      accounts: accounts.length,
      enabled: accounts.filter((item) => item.enabled).length,
      models: modelsPayload().data.length,
      uptimeSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0
    });
    return;
  }

  if (pathname === '/' || pathname === '/v1' || pathname === '/v1/') {
    sendJson(res, 200, {
      service: SERVICE,
      version: VERSION,
      baseUrl: `http://${HOST}:${LISTEN_PORT}/v1`,
      endpoints: ['/v1/models', '/v1/chat/completions'],
      accounts: accounts.length,
      enabled: accounts.filter((item) => item.enabled).length
    });
    return;
  }

  if (pathname.startsWith('/admin/')) {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: '管理接口只允许本机访问' });
      return;
    }
    if (adminToken(req) !== settings.adminKey) {
      sendJson(res, 401, { ok: false, error: 'admin key 不正确' });
      return;
    }
    const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    await handleAdmin(req, res, url, raw);
    return;
  }

  // 模型列表不含凭据，且客户端常在填 Key 之前就拉一次；这里放行避免拉取失败后
  // 客户端退回旧列表，让人误以为网关少发了模型
  if (pathname === '/v1/models') {
    sendJson(res, 200, modelsPayload());
    return;
  }
  const oneModel = /^\/v1\/models\/(.+)$/.exec(pathname);
  if (oneModel) {
    const want = decodeURIComponent(oneModel[1]);
    const found = modelsPayload().data.find((item) => item.id === want);
    if (!found) {
      sendOpenAiError(res, 404, `没有这个模型：${want}`, 'model_not_found');
      return;
    }
    sendJson(res, 200, found);
    return;
  }

  if (pathname.startsWith('/v1/')) {
    const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    if (bearerToken(req) !== settings.apiKey) {
      sendOpenAiError(res, 401, 'API key 不正确：在插件面板复制“网关 API Key”填到提供商的密钥里', 'invalid_api_key');
      return;
    }
    if (pathname === '/v1/chat/completions') {
      if (req.method !== 'POST') {
        sendOpenAiError(res, 405, '只支持 POST');
        return;
      }
      await proxyChat(req, res, raw);
      return;
    }
    sendOpenAiError(res, 404, `未知接口：${pathname}`);
    return;
  }

  sendJson(res, 404, { ok: false, error: '未知路径' });
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (!settings || !settings.autoRefresh) return;
  const minutes = Math.max(Number(settings.autoRefreshMinutes) || 30, 5);
  refreshTimer = setInterval(() => {
    const targets = accounts.filter((item) => item.enabled && item.refreshToken && item.expiresAt);
    const soon = targets.filter((item) => item.expiresAt - Date.now() < REFRESH_AHEAD_MS * 3);
    for (const account of soon) {
      ensureToken(account, false).catch((error) => {
        logLine('token', `${account.id} 后台刷新失败：${error.message}`);
      });
    }
  }, minutes * 60 * 1000);
  if (refreshTimer.unref) refreshTimer.unref();
}

function scheduleCatalog() {
  if (catalogTimer) {
    clearInterval(catalogTimer);
    catalogTimer = null;
  }
  catalogTimer = setInterval(() => {
    refreshCatalogInBackground(enabledRegions());
  }, store.catalog.REFRESH_MS);
  if (catalogTimer.unref) catalogTimer.unref();
  refreshCatalogInBackground(enabledRegions());
}

function reservedPorts() {
  const ports = new Set();
  const extra = String(process.env.WORKBUDDY_GATEWAY_RESERVED_PORTS || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  for (const item of extra) ports.add(item);

  // 其他插件的网关在同一数据根下各自登记端口，这些端口要留给它们
  const root = path.dirname(DATA_DIR);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return ports;
  }
  const ownFile = path.resolve(path.join(DATA_DIR, 'settings.json'));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.resolve(path.join(root, entry.name, 'settings.json'));
    if (file === ownFile) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const port = Number(parsed && (parsed.requestedPort || parsed.port));
      if (Number.isInteger(port) && port > 0) ports.add(port);
    } catch {
      // 没有 settings.json 或不是 JSON，跳过
    }
  }
  return ports;
}

function listen(port, remaining) {
  return new Promise((resolve, reject) => {
    if (remaining > 0 && port !== settings.requestedPort && reservedPorts().has(port)) {
      logLine('listen', `端口 ${port} 属于其他插件网关，跳过`);
      listen(port + 1, remaining - 1).then(resolve, reject);
      return;
    }
    const attempt = http.createServer((req, res) => {
      route(req, res).catch((error) => {
        logLine('http', `未捕获错误：${error && error.message}`);
        try {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
        } catch {
          // 响应已开始写入时忽略
        }
      });
    });
    attempt.once('error', (error) => {
      if (error.code === 'EADDRINUSE' && remaining > 0) {
        attempt.close(() => {});
        listen(port + 1, remaining - 1).then(resolve, reject);
        return;
      }
      reject(error);
    });
    attempt.listen(port, HOST, () => {
      server = attempt;
      resolve(port);
    });
  });
}

export async function startGateway(options) {
  const opts = options || {};
  DATA_DIR = opts.dataDir || process.env.WORKBUDDY_GATEWAY_HOME || DATA_DIR;
  if (!DATA_DIR) {
    const root = process.env.AICODE_DATA_DIR || path.join(process.env.HOME || '/root', '.aicode-plugin-data');
    DATA_DIR = path.join(root, 'workbuddy-gateway');
  }
  ensureDir(DATA_DIR);
  settings = loadSettings();
  state = loadState();
  accounts = loadAccounts();
  logs.length = 0;

  const requested = Number(opts.port) || Number(settings.requestedPort) || DEFAULT_PORT;
  const port = await listen(requested, PORT_SCAN);
  LISTEN_PORT = port;
  startedAt = Date.now();
  if (settings.port !== port || settings.requestedPort !== requested) {
    settings.port = port;
    settings.requestedPort = requested;
    saveSettings();
  }
  scheduleRefresh();
  scheduleCatalog();
  if (isCli) {
    try {
      writeJson(pidFile(), { pid: process.pid, port, requested, build: BUILD, startedAt: Date.now() });
    } catch {
      /* pid 文件写不进去不影响网关运行 */
    }
  }
  logLine('boot', `${SERVICE} ${VERSION} 监听 http://${HOST}:${port}，账号 ${accounts.length} 个，数据目录 ${DATA_DIR}`);
  return statusPayload();
}

export async function stopGateway() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (catalogTimer) {
    clearInterval(catalogTimer);
    catalogTimer = null;
  }
  if (!server) return { ok: true, stopped: false };
  const current = server;
  server = null;
  await new Promise((resolve) => {
    current.close(() => resolve());
    if (current.closeAllConnections) current.closeAllConnections();
    setTimeout(resolve, 1500).unref();
  });
  startedAt = 0;
  if (isCli) {
    try {
      fs.unlinkSync(pidFile());
    } catch {
      /* 可能已被回收 */
    }
  }
  logLine('boot', '网关已停止');
  return { ok: true, stopped: true };
}

export function gatewayStatus() {
  if (!settings) return { ok: false, service: SERVICE, running: false };
  return Object.assign({ running: Boolean(server) }, statusPayload());
}

export { gatewayLogs, SERVICE, VERSION, BUILD };

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const argv = process.argv.slice(2);
  // 父进程关掉管道时 stdout/stderr 会抛 EPIPE，这里吞掉避免整个网关进程崩。
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  let port = 0;
  let dataDir = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') port = Number(argv[index + 1]) || 0;
    if (argv[index] === '--data-dir') dataDir = argv[index + 1] || '';
  }
  startGateway({ port, dataDir })
    .then((payload) => {
      process.stdout.write(`${JSON.stringify({ ok: true, port: payload.port, baseUrl: payload.baseUrl })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`启动失败：${error && error.message}\n`);
      process.exit(1);
    });
  const shutdown = () => {
    stopGateway().then(() => process.exit(0), () => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
