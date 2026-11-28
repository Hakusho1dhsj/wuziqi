#!/usr/bin/env node
/**
 * 商汤（SenseNova）生图网关。
 *
 * 协议面：/v1/models、/v1/chat/completions、/v1/images/generations、/v1/images/edits。
 * 上游：https://token.sensenova.cn/v1（Bearer sk- 密钥）。
 * 生图模型走独立的 /images/generations，不认 chat 协议，这里做双向适配：
 *   - images 端点：尺寸归一化、b64_json 由网关下载转码、可选落盘；
 *   - chat 端点：model 为 U 系列时自动改走生图链路，结果包成 chat.completion，
 *     让只会调 chat 的客户端也能出图。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.4.0';
const DEFAULT_PORT = 18918;
const PEER_PORTS = [18912, 18913, 18914, 18916];
const DEFAULT_UPSTREAM = 'https://token.sensenova.cn/v1';
const CHAT_TIMEOUT_MS = 180000;
const IMAGE_TIMEOUT_MS = 300000;
const MODELS_TTL_MS = 300000;
const MAX_BODY = 40 * 1024 * 1024;
const MAX_IMAGE = 24 * 1024 * 1024;
// Key 失效/限流后的冷却时长：鉴权失败与限流分开，避免好 Key 被一个坏 Key 拖慢。
const KEY_COOLDOWN_MS = {
  unauthorized: 10 * 60 * 1000,
  rateLimit: 60 * 1000,
  payment: 30 * 60 * 1000,
  other: 30 * 1000,
};
const MAX_KEY_ATTEMPTS = 5;
const PROVIDER_KEY_DEFAULT = 'sk-sensenova-local';

const CHAT_MODELS = [
  { id: 'sensenova-6.8-flash', owned_by: 'sensenova', description: '日日新 6.8 Flash，多模态智能体模型', vision: true },
  { id: 'sensenova-6.8-flash-lite', owned_by: 'sensenova', description: '日日新 6.8 Flash Lite，轻量多模态', vision: true },
];

const IMAGE_MODELS = {
  'sensenova-u1.5-lite': { mode: 'range', defaultSize: '2048x2048', description: '日日新 U1.5 Lite，文生图与图片编辑' },
  'sensenova-u1.5-fast': { mode: 'range', defaultSize: '2048x2048', description: '日日新 U1.5 Fast，加速版图片创作' },
  'sensenova-u1-fast': {
    mode: 'fixed',
    defaultSize: '2752x1536',
    description: '日日新 U1 Fast，信息图生成',
    sizes: ['1664x2496', '2496x1664', '1760x2368', '2368x1760', '1824x2272', '2272x1824', '2048x2048', '2752x1536', '1536x2752', '3072x1376', '1344x3136'],
  },
};

class GatewayError extends Error {
  constructor(status, message, type = 'invalid_request_error', code = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--selfcheck') out.selfcheck = true;
    else if (flag === '--version') out.version = true;
    else if (flag === '--port') out.port = Number(argv[++i]);
    else if (flag === '--host') out.host = argv[++i];
    else if (flag === '--upstream') out.upstream = argv[++i];
    else if (flag === '--api-key') out.apiKey = argv[++i];
    else if (flag === '--gateway-token') out.gatewayToken = argv[++i];
    else if (flag === '--output-dir') out.outputDir = argv[++i];
    else if (flag === '--data-dir') out.dataDir = argv[++i];
    else throw new GatewayError(2, `unknown argument: ${flag}`);
  }
  return out;
}

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/** 把 apiKeys / 旧 apiKey / CLI / 环境变量归并成一个去重的 Key 池。 */
function normalizeKeys(s, cliKey, envKey) {
  const list = [];
  const push = (key, label, enabled) => {
    const value = typeof key === 'string' ? key.trim() : '';
    if (!value) return;
    const id = hashId(value);
    if (list.some((item) => item.id === id)) return;
    list.push({ id, key: value, label: typeof label === 'string' ? label : '', enabled: enabled !== false });
  };
  if (Array.isArray(s.apiKeys)) {
    for (const item of s.apiKeys) {
      if (typeof item === 'string') push(item, '', true);
      else if (item && typeof item === 'object') push(item.key, item.label, item.enabled);
    }
  }
  if (typeof s.apiKey === 'string') push(s.apiKey, '默认', true);
  push(envKey, '环境变量', true);
  push(cliKey, '命令行', true);
  return list;
}

function loadSettings(args) {
  const home =
    args.dataDir ||
    process.env.SENSENOVA_GATEWAY_HOME ||
    process.env.AICODE_PLUGIN_DATA_DIR ||
    path.join(__dirname, '.data');
  const candidates = [path.join(home, 'settings.json'), path.join(__dirname, 'settings.json')];
  let s = {};
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      s = JSON.parse(fs.readFileSync(file, 'utf8'));
      break;
    } catch (err) {
      throw new GatewayError(2, `settings.json is not valid JSON: ${err.message}`);
    }
  }
  const pick = (cli, env, fallback) => (cli !== undefined && cli !== '' ? cli : env !== undefined && env !== '' ? env : fallback);
  return {
    home,
    settingsFile: path.join(home, 'settings.json'),
    port: Number(pick(args.port, process.env.SENSENOVA_GATEWAY_PORT, s.port || DEFAULT_PORT)),
    host: pick(args.host, process.env.SENSENOVA_GATEWAY_HOST, s.host || '127.0.0.1'),
    upstream: String(pick(args.upstream, process.env.SENSENOVA_UPSTREAM, s.upstream || DEFAULT_UPSTREAM)).replace(/\/+$/, ''),
    apiKey: pick(args.apiKey, process.env.SENSENOVA_API_KEY, s.apiKey || ''),
    apiKeys: normalizeKeys(s, args.apiKey, process.env.SENSENOVA_API_KEY),
    keyStrategy: s.keyStrategy === 'priority' ? 'priority' : 'round-robin',
    providerKey: s.providerKey || PROVIDER_KEY_DEFAULT,
    gatewayToken: pick(args.gatewayToken, process.env.SENSENOVA_GATEWAY_TOKEN, s.gatewayToken || ''),
    adminKey: pick(undefined, process.env.SENSENOVA_ADMIN_KEY, s.adminKey || ''),
    defaultChatModel: s.defaultChatModel || 'sensenova-6.8-flash',
    defaultImageModel: s.defaultImageModel || 'sensenova-u1.5-lite',
    watermark: s.watermark === undefined ? false : !!s.watermark,
    storeImages: !!s.storeImages,
    // 生图模型走独立接口，默认不列进 /v1/models：客户端会把它们当对话模型做连通性测试，
    // 每次测试都会真的生成一张图（20~30 秒），看起来像网关很慢。
    exposeImageModels: s.exposeImageModels === undefined ? true : !!s.exposeImageModels,
    // 聊天内出图方式：local=网关本地短地址；inline=data URL 内嵌（不受本地 http 加载限制，但消息体积大）。
    chatImageMode: s.chatImageMode === 'inline' ? 'inline' : 'local',
    outputDir: args.outputDir || s.outputDir || path.join(home, 'output'),
    logDir: s.logDir || path.join(home, 'logs'),
  };
}

/** 只写插件数据目录，不回流安装包；apiKey 等敏感字段随配置一起落盘。 */
function saveSettings(patch) {
  const next = {
    port: settings.port,
    host: settings.host,
    upstream: settings.upstream,
    apiKey: settings.apiKey,
    apiKeys: settings.apiKeys.map((item) => ({ id: item.id, key: item.key, label: item.label, enabled: item.enabled !== false })),
    keyStrategy: settings.keyStrategy,
    providerKey: settings.providerKey,
    gatewayToken: settings.gatewayToken,
    adminKey: settings.adminKey,
    defaultChatModel: settings.defaultChatModel,
    defaultImageModel: settings.defaultImageModel,
    watermark: settings.watermark,
    storeImages: settings.storeImages,
    exposeImageModels: settings.exposeImageModels,
    chatImageMode: settings.chatImageMode,
    ...patch,
  };
  ensureDir(settings.home);
  fs.writeFileSync(settings.settingsFile, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** 端口顺延后写回实际值，插件的状态页与 runtime 都按这个地址访问。 */
function persistPort(port) {
  try {
    const onDisk = JSON.parse(fs.readFileSync(settings.settingsFile, 'utf8'));
    if (onDisk.port === port) return;
  } catch {
    /* 文件不存在时直接写 */
  }
  saveSettings({ port });
}

const args = parseArgs(process.argv);
if (args.help) {
  process.stdout.write(`商汤生图网关 v${VERSION}

用法: node gateway.mjs [选项]

  --port <端口>         监听端口，默认 18918（占用时自动顺延）
  --host <地址>         监听地址，默认 127.0.0.1
  --upstream <URL>      上游地址，默认 ${DEFAULT_UPSTREAM}
  --api-key <key>       商汤生图 API Key（也可用 SENSENOVA_API_KEY 或 settings.json）
  --gateway-token <t>   本地访问令牌，设置后客户端必须携带
  --output-dir <目录>   图片落盘目录，默认 ./output
  --selfcheck           用真实上游跑一次生图，验证通链
`);
  process.exit(0);
}
if (args.version) {
  process.stdout.write(VERSION + '\n');
  process.exit(0);
}

const settings = loadSettings(args);
const stats = { startedAt: Date.now(), requests: 0, chat: 0, images: 0, errors: 0, upstreamErrors: 0 };
const recentErrors = [];

/** 探测本机其他网关端口，确认多网关并存时互不影响。 */
async function probePeers() {
  const peers = [];
  for (const port of PEER_PORTS) {
    if (port === settings.port) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
      peers.push({ port, alive: true, status: res.status });
    } catch {
      peers.push({ port, alive: false });
    }
  }
  return peers;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  process.stdout.write(text + '\n');
  try {
    ensureDir(settings.logDir);
    fs.appendFileSync(path.join(settings.logDir, 'gateway.log'), text + '\n');
  } catch {
    /* 日志写失败不影响请求 */
  }
}

function noteError(message, extra = {}) {
  stats.errors += 1;
  const entry = { at: new Date().toISOString(), message, ...extra };
  recentErrors.push(entry);
  if (recentErrors.length > 20) recentErrors.shift();
  log(`ERROR ${message}${extra.status ? ` status=${extra.status}` : ''}`);
}

function maskKey(key) {
  if (!key) return '';
  return key.length <= 12 ? 'sk-***' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new GatewayError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isImageModel(model) {
  if (!model) return false;
  return Boolean(IMAGE_MODELS[model]) || /^sensenova-u\d/i.test(model);
}

function imageSpec(model) {
  return IMAGE_MODELS[model] || null;
}

function clampTo32(value) {
  const rounded = Math.round(value / 32) * 32;
  return Math.min(4096, Math.max(512, rounded));
}

function nearestFixedSize(sizes, width, height) {
  const target = width / height;
  let best = sizes[0];
  let bestDistance = Infinity;
  for (const size of sizes) {
    const [w, h] = size.split('x').map(Number);
    const distance = Math.abs(Math.log(w / h / target));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = size;
    }
  }
  return best;
}

function normalizeSize(model, size) {
  const spec = imageSpec(model);
  const fallback = spec?.defaultSize || '2048x2048';
  const raw = String(size || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return fallback;
  const match = raw.match(/^(\d{2,5})\s*[x*]\s*(\d{2,5})$/);
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return fallback;
  if (spec?.mode === 'fixed') return nearestFixedSize(spec.sizes, width, height);
  let w = clampTo32(width);
  let h = clampTo32(height);
  if (w / h > 3) w = clampTo32(h * 3);
  else if (w / h < 1 / 3) h = clampTo32(w * 3);
  return `${w}x${h}`;
}

const keyRuntime = new Map();
let roundRobinIndex = 0;

function keyState(id) {
  if (!keyRuntime.has(id)) {
    keyRuntime.set(id, { fails: 0, cooldownUntil: 0, lastError: '', lastErrorAt: 0, lastUsedAt: 0, calls: 0, successes: 0 });
  }
  return keyRuntime.get(id);
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return `${value.slice(0, 3)}…${value.slice(-2)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function cooldownFor(status, retryAfterSec) {
  if (status === 401 || status === 403) return KEY_COOLDOWN_MS.unauthorized;
  if (status === 429) return Math.max(retryAfterSec > 0 ? retryAfterSec * 1000 : 0, KEY_COOLDOWN_MS.rateLimit);
  if (status === 402) return KEY_COOLDOWN_MS.payment;
  return KEY_COOLDOWN_MS.other;
}

/** 参数/内容错误换 Key 也没用，直接返回给客户端。 */
function isTerminalStatus(status) {
  return status === 400 || status === 404 || status === 405 || status === 413 || status === 422;
}

function pickKey(exclude) {
  const now = Date.now();
  const enabled = settings.apiKeys.filter((item) => item.enabled !== false);
  if (!enabled.length) return null;
  const available = enabled.filter((item) => !exclude.has(item.id) && keyState(item.id).cooldownUntil <= now);
  if (!available.length) return null;
  if (settings.keyStrategy === 'priority') return available[0];
  for (let i = 0; i < enabled.length; i++) {
    const candidate = enabled[(roundRobinIndex + i) % enabled.length];
    if (available.includes(candidate)) {
      roundRobinIndex = (roundRobinIndex + i + 1) % enabled.length;
      return candidate;
    }
  }
  return available[0];
}

function markFailure(id, status, message, retryAfterSec) {
  const state = keyState(id);
  state.fails += 1;
  state.lastError = `${status} ${String(message || '').replace(/\s+/g, ' ').trim()}`.slice(0, 300);
  state.lastErrorAt = Date.now();
  state.cooldownUntil = Date.now() + cooldownFor(status, retryAfterSec);
  return state;
}

function keyStatusList() {
  const now = Date.now();
  return settings.apiKeys.map((item) => {
    const state = keyState(item.id);
    return {
      id: item.id,
      label: item.label || '',
      masked: maskSecret(item.key),
      enabled: item.enabled !== false,
      cooling: state.cooldownUntil > now,
      cooldown_seconds: state.cooldownUntil > now ? Math.ceil((state.cooldownUntil - now) / 1000) : 0,
      fails: state.fails,
      calls: state.calls,
      successes: state.successes,
      last_error: state.lastError || '',
      last_error_at: state.lastErrorAt || 0,
      last_used_at: state.lastUsedAt || 0,
    };
  });
}

function availableKeyCount() {
  const now = Date.now();
  return settings.apiKeys.filter((item) => item.enabled !== false && keyState(item.id).cooldownUntil <= now).length;
}

/**
 * 带 Key 池的上游请求：按轮换策略选 Key，鉴权失败/限流/5xx 自动切下一个，
 * 参数错误直接透传。全部失败时抛出带上游原始响应的错误。
 */
async function upstreamRequest(pathname, { method = 'POST', json, rawBody, contentType, timeoutMs = CHAT_TIMEOUT_MS } = {}) {
  const enabled = settings.apiKeys.filter((item) => item.enabled !== false);
  if (!enabled.length) {
    throw new GatewayError(
      500,
      '未配置任何 API Key：在插件面板「Key 池」里添加，或写入 settings.json 的 apiKeys',
      'configuration_error',
      'missing_api_key',
    );
  }
  const headers = { 'Content-Type': contentType || 'application/json' };
  let body;
  if (json !== undefined) body = Buffer.from(JSON.stringify(json));
  else if (rawBody !== undefined) body = rawBody;

  const exclude = new Set();
  const maxAttempts = Math.min(enabled.length, MAX_KEY_ATTEMPTS);
  let last = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = pickKey(exclude);
    if (!key) break;
    exclude.add(key.id);
    const state = keyState(key.id);
    state.calls += 1;
    state.lastUsedAt = Date.now();
    const started = Date.now();

    let response;
    try {
      response = await fetch(settings.upstream + pathname, {
        method,
        headers: { ...headers, Authorization: `Bearer ${key.key}` },
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const status = aborted ? 504 : 502;
      stats.upstreamErrors += 1;
      const message = aborted ? `上游响应超时（${Math.round(timeoutMs / 1000)}s）` : `上游连接失败：${err?.message || err}`;
      markFailure(key.id, status, message);
      last = { status, text: JSON.stringify({ error: { message, type: 'upstream_error', param: null, code: aborted ? 'upstream_timeout' : 'upstream_unreachable' } }) };
      log(`key ${key.id} ${pathname} ${aborted ? 'timeout' : 'network-error'} -> 切换下一个 ${Date.now() - started}ms`);
      continue;
    }

    if (response.ok) {
      state.successes += 1;
      state.fails = 0;
      state.cooldownUntil = 0;
      return { ok: true, response, keyId: key.id };
    }

    const text = await response.text();
    const retryAfter = Number(response.headers.get('retry-after')) || 0;
    if (isTerminalStatus(response.status)) {
      return { ok: false, status: response.status, text, keyId: key.id, terminal: true };
    }
    const after = markFailure(key.id, response.status, text, retryAfter);
    last = { status: response.status, text };
    log(
      `key ${key.id} ${pathname} -> ${response.status}，冷却 ${Math.round((after.cooldownUntil - Date.now()) / 1000)}s，切换下一个 ${Date.now() - started}ms`,
    );
  }

  if (!last) {
    const soonest = Math.min(
      ...enabled.map((item) => keyState(item.id).cooldownUntil).filter((time) => time > Date.now()),
      Number.POSITIVE_INFINITY,
    );
    const wait = Number.isFinite(soonest) ? Math.max(1, Math.ceil((soonest - Date.now()) / 1000)) : 60;
    throw new GatewayError(429, `所有 API Key 都在冷却中（最早 ${wait} 秒后恢复）`, 'rate_limit_error', 'all_keys_cooling');
  }

  stats.upstreamErrors += 1;
  noteError(`${pathname} 全部 Key 失败`, { status: last.status, body: last.text.slice(0, 300) });
  return { ok: false, status: last.status, text: last.text, exhausted: true };
}

function sniffImageType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

async function downloadImage(url) {
  const absolute = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  let upstream;
  try {
    upstream = await fetch(absolute, { signal: AbortSignal.timeout(60000) });
  } catch (err) {
    throw new GatewayError(502, `下载生成图片失败：${err?.message || err}`, 'upstream_error', 'image_download_failed');
  }
  if (!upstream.ok) {
    throw new GatewayError(502, `下载生成图片失败：HTTP ${upstream.status}`, 'upstream_error', 'image_download_failed');
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length > MAX_IMAGE) throw new GatewayError(502, '生成图片超过大小上限', 'upstream_error', 'image_too_large');
  return buffer;
}

function saveImage(buffer, ext) {
  ensureDir(settings.outputDir);
  const name = `sensenova-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const target = path.join(settings.outputDir, name);
  fs.writeFileSync(target, buffer);
  return target;
}

function publicBase() {
  const host = settings.host === '0.0.0.0' || settings.host === '::' ? '127.0.0.1' : settings.host;
  return `http://${host}:${settings.port}`;
}

/** 落盘并把文件挂到网关自己的 /files/ 路由，返回不依赖上游签名、不会过期的短地址。 */
function attachLocal(record, buffer, mediaType) {
  const saved = saveImage(buffer, extensionFor(mediaType));
  record.local_path = saved;
  record.local_url = `${publicBase()}/files/${path.basename(saved)}`;
  return saved;
}

function extensionFor(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/webp') return 'webp';
  return 'png';
}

/**
 * 生图核心：向 /images/generations 发请求，返回可直接组装的条目。
 * 无论客户端要 url 还是 b64，都先向上一游要 url，再按需由本地下载转码，
 * 这样既避开上游对 response_format 的实现差异，也不受临时链接过期影响。
 */
async function generateImages({ model, prompt, size, n = 1, watermark, outputFormat = 'png', wantB64 = false, forceSave = false }) {
  const spec = imageSpec(model);
  const payload = {
    model,
    prompt,
    size: normalizeSize(model, size),
    n: Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 1,
    watermark: watermark === undefined ? settings.watermark : Boolean(watermark),
    output_format: outputFormat,
    // 上游不带这个字段时会 200 但 data 里没有 url，必须显式声明。
    response_format: 'url',
  };
  const started = Date.now();
  const result = await upstreamRequest('/images/generations', { json: payload, timeoutMs: IMAGE_TIMEOUT_MS });
  if (!result.ok) {
    const err = new GatewayError(result.status, `上游生图失败：HTTP ${result.status}`, 'upstream_error', 'image_generation_failed');
    err.upstreamBody = result.text;
    throw err;
  }
  const text = await result.response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewayError(502, '上游生图返回非 JSON', 'upstream_error', 'bad_upstream_response');
  }
  const items = Array.isArray(parsed.data) ? parsed.data.filter((it) => it && (it.url || it.b64_json)) : [];
  if (!items.length) throw new GatewayError(502, '上游未返回图片地址', 'upstream_error', 'empty_image_result');

  const data = [];
  const shouldSave = settings.storeImages || forceSave;
  for (const item of items) {
    const record = {};
    if (wantB64) {
      const buffer = item.b64_json ? Buffer.from(item.b64_json, 'base64') : await downloadImage(item.url);
      const mediaType = sniffImageType(buffer);
      record.b64_json = buffer.toString('base64');
      if (item.url) record.url = /^https?:\/\//i.test(item.url) ? item.url : `https://${item.url}`;
      record.media_type = mediaType;
      if (shouldSave) attachLocal(record, buffer, mediaType);
    } else if (item.b64_json && !item.url) {
      const buffer = Buffer.from(item.b64_json, 'base64');
      const mediaType = sniffImageType(buffer);
      record.b64_json = item.b64_json;
      record.media_type = mediaType;
      if (shouldSave) attachLocal(record, buffer, mediaType);
    } else {
      record.url = /^https?:\/\//i.test(item.url) ? item.url : `https://${item.url}`;
      if (shouldSave) {
        const buffer = await downloadImage(item.url);
        attachLocal(record, buffer, sniffImageType(buffer));
      }
    }
    if (item.revised_prompt) record.revised_prompt = item.revised_prompt;
    data.push(record);
  }
  stats.images += data.length;
  log(`images/generations model=${model} size=${payload.size} n=${payload.n} watermark=${payload.watermark} b64=${wantB64} -> ${data.length} 张 ${Date.now() - started}ms`);
  return {
    model,
    requestedSize: String(size || ''),
    size: payload.size,
    output_format: parsed.output_format || outputFormat,
    refused: Boolean(spec === null),
    data,
    created: parsed.created || Math.floor(Date.now() / 1000),
    usage: parsed.usage,
    elapsedMs: Date.now() - started,
  };
}

function imageResultBody(result, wantB64) {
  return {
    created: result.created,
    data: result.data,
    model: result.model,
    size: result.size,
    output_format: result.output_format,
    ...(wantB64 ? { response_format: 'b64_json' } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    gateway: {
      version: VERSION,
      requested_size: result.requestedSize || null,
      applied_size: result.size,
      elapsed_ms: result.elapsedMs,
      source: 'token.sensenova.cn/v1/images/generations',
    },
  };
}

function extractChatPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

function imageChatContent(result) {
  const images = result.data.map((item, index) => `![生成结果 ${index + 1}](${item.local_url || item.url})`);
  const saved = result.data.map((item) => item.local_path).filter(Boolean);
  // 客户端不渲染正文图片时，至少留下可点击的落盘路径，不留空白消息。
  return `${images.join('\n')}${saved.length ? `\n\n已保存：${saved.join('、')}` : ''}`;
}

/** 内嵌模式：图片字节直接写进 markdown，不依赖任何网络地址。 */
function imageChatInline(result) {
  return result.data
    .map((item, index) => `![生成结果 ${index + 1}](data:${item.media_type || 'image/png'};base64,${item.b64_json})`)
    .join('\n');
}

/** chat 端点收到 U 系列模型：改走生图，把结果包成 chat.completion。 */
async function handleChatAsImage(res, body, model) {
  const prompt = extractChatPrompt(body);
  if (!prompt) throw new GatewayError(400, 'messages 中找不到可用的文本 prompt', 'invalid_request_error', 'missing_prompt');
  const inline = settings.chatImageMode === 'inline';
  const result = await generateImages({
    model,
    prompt,
    size: body.size,
    n: body.n,
    watermark: body.watermark,
    outputFormat: body.output_format || 'png',
    wantB64: inline,
    // 聊天通道需要直出的图：强制落盘，用网关自己的 /files/ 地址，避免外链与长签名 URL。
    forceSave: true,
  });
  const content = inline ? imageChatInline(result) : imageChatContent(result);
  const id = `chatcmpl-img-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    res.write(chunk({ role: 'assistant', content: '' }));
    res.write(chunk({ content }));
    res.write(chunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  sendJson(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    gateway: {
      version: VERSION,
      routed_to: 'images/generations',
      applied_size: result.size,
      elapsed_ms: result.elapsedMs,
    },
  });
}

async function handleChat(req, res, body) {
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : settings.defaultChatModel;
  if (isImageModel(model)) {
    await handleChatAsImage(res, body, model);
    return;
  }
  const payload = { ...body, model };
  if (payload.max_completion_tokens === undefined && payload.max_tokens !== undefined) {
    // 上游兼容模式认 max_completion_tokens，部分客户端只发 max_tokens。
    delete payload.max_tokens;
    payload.max_completion_tokens = body.max_tokens;
  }
  const stream = Boolean(body.stream);
  const result = await upstreamRequest('/chat/completions', { json: payload, timeoutMs: CHAT_TIMEOUT_MS });
  if (!result.ok) {
    res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(result.text);
    return;
  }
  const upstream = result.response;
  stats.chat += 1;
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const src = Readable.fromWeb(upstream.body);
    src.on('error', (err) => {
      noteError(`流式转发中断：${err.message}`);
      res.destroy();
    });
    res.on('close', () => src.destroy());
    src.pipe(res);
    log(`chat/completions stream model=${model}`);
    return;
  }
  const text = await upstream.text();
  log(`chat/completions model=${model} bytes=${text.length}`);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

async function handleImageGeneration(req, res, body) {
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : settings.defaultImageModel;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new GatewayError(400, '"prompt" 不能为空', 'invalid_request_error', 'missing_prompt');
  const wantB64 = body.response_format === 'b64_json';
  const result = await generateImages({
    model,
    prompt,
    size: body.size,
    n: body.n,
    watermark: body.watermark,
    outputFormat: body.output_format || 'png',
    wantB64,
  });
  sendJson(res, 200, imageResultBody(result, wantB64));
}

async function handleImageEdit(req, res, rawBody, contentType) {
  const isJson = (contentType || '').includes('application/json');
  let payload = rawBody;
  let model = settings.defaultImageModel;
  if (isJson) {
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      throw new GatewayError(400, '请求体不是合法 JSON', 'invalid_request_error', 'invalid_json');
    }
    model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : model;
    if (body.size !== undefined) body.size = normalizeSize(model, body.size);
    if (body.watermark === undefined) body.watermark = settings.watermark;
    payload = Buffer.from(JSON.stringify(body));
  }
  const result = await upstreamRequest('/images/edits', { rawBody: payload, contentType });
  if (!result.ok) {
    res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(result.text);
    return;
  }
  const text = await result.response.text();
  log(`images/edits model=${model} bytes=${text.length}`);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

let modelCache = { at: 0, data: null };

async function listModels(force = false) {
  const now = Date.now();
  if (!force && modelCache.data && now - modelCache.at < MODELS_TTL_MS) return modelCache.data;
  const builtin = [
    ...CHAT_MODELS.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: m.owned_by, capability: 'chat', description: m.description })),
    ...Object.entries(IMAGE_MODELS).map(([id, spec]) => ({ id, object: 'model', created: 0, owned_by: 'sensenova', capability: 'image', description: spec.description })),
  ].filter((item) => settings.exposeImageModels || item.capability !== 'image');
  const byId = new Map(builtin.map((m) => [m.id, m]));
  if (settings.apiKeys.length > 0) {
    try {
      const result = await upstreamRequest('/models', { method: 'GET', timeoutMs: 10000 });
      if (result.ok) {
        const parsed = await result.response.json();
        const list = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
        for (const item of list) {
          const id = item.id || item.model || item.name;
          if (!id || byId.has(id)) continue;
          const capability = isImageModel(id) ? 'image' : 'chat';
          if (capability === 'image' && !settings.exposeImageModels) continue;
          byId.set(id, {
            id,
            object: 'model',
            created: item.created || 0,
            owned_by: item.owned_by || 'sensenova',
            capability,
          });
        }
      } else {
        noteError(`/models 上游返回 ${result.status}，使用内置清单`, { status: result.status });
      }
    } catch (err) {
      noteError(`/models 拉取失败，使用内置清单：${err.message}`);
    }
  }
  modelCache = { at: now, data: { object: 'list', data: [...byId.values()] } };
  return modelCache.data;
}

function requestLog(label, req, status, startedAt) {
  stats.requests += 1;
  log(`${req.method} ${label} -> ${status} ${Date.now() - startedAt}ms`);
}

async function handleRequest(req, res) {
  const startedAt = Date.now();
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/health')) {
    requestLog(pathname, req, 200, startedAt);
    return sendJson(res, 200, {
      status: 'ok',
      version: VERSION,
      upstream: settings.upstream,
      data_dir: settings.home,
      api_key_configured: settings.apiKeys.length > 0,
      keys_total: settings.apiKeys.length,
      keys_available: availableKeyCount(),
      expose_image_models: settings.exposeImageModels,
      api_key_masked: maskKey(settings.apiKey || settings.apiKeys[0]?.key || ''),
    });
  }

  if (req.method === 'GET' && pathname.startsWith('/files/')) {
    const name = decodeURIComponent(pathname.slice('/files/'.length));
    if (!/^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i.test(name)) {
      requestLog(pathname, req, 400, startedAt);
      return sendError(res, 400, '非法的图片路径', 'invalid_request_error', 'invalid_path');
    }
    const file = path.join(settings.outputDir, name);
    if (!file.startsWith(settings.outputDir + path.sep) || !fs.existsSync(file)) {
      requestLog(pathname, req, 404, startedAt);
      return sendError(res, 404, '图片不存在或已被清理', 'invalid_request_error', 'not_found');
    }
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': sniffImageType(data),
      'Content-Length': String(data.length),
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(data);
  }

  if (req.method === 'GET' && (pathname === '/admin/api/status' || pathname === '/v1/status')) {
    const peers = await probePeers();
    requestLog(pathname, req, 200, startedAt);
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      uptime_seconds: Math.round((Date.now() - stats.startedAt) / 1000),
      base_url: `http://${settings.host}:${settings.port}/v1`,
      upstream: settings.upstream,
      api_key_configured: settings.apiKeys.length > 0,
      api_key_masked: maskKey(settings.apiKey || settings.apiKeys[0]?.key || ''),
      keys_total: settings.apiKeys.length,
      keys_available: availableKeyCount(),
      key_strategy: settings.keyStrategy,
      gateway_token_required: Boolean(settings.gatewayToken),
      default_chat_model: settings.defaultChatModel,
      default_image_model: settings.defaultImageModel,
      watermark_default: settings.watermark,
      store_images: settings.storeImages,
      output_dir: settings.outputDir,
      peers,
      stats,
      recent_errors: recentErrors,
    });
  }

  if (settings.gatewayToken) {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const apiKeyHeader = String(req.headers['x-api-key'] || '').trim();
    if (bearer !== settings.gatewayToken && apiKeyHeader !== settings.gatewayToken) {
      requestLog(pathname, req, 401, startedAt);
      return sendError(res, 401, '本地网关令牌无效', 'authentication_error', 'invalid_gateway_token');
    }
  }

  if (pathname.startsWith('/admin/api/') && settings.adminKey) {
    if (String(req.headers['x-admin-key'] || '') !== settings.adminKey) {
      requestLog(pathname, req, 401, startedAt);
      return sendError(res, 401, '管理密钥无效', 'authentication_error', 'invalid_admin_key');
    }
  }

  if (req.method === 'GET' && pathname === '/admin/api/config') {
    const models = await listModels(false);
    requestLog(pathname, req, 200, startedAt);
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      port: settings.port,
      host: settings.host,
      base_url: `http://${settings.host}:${settings.port}/v1`,
      upstream: settings.upstream,
      provider_key: settings.providerKey,
      api_key_configured: settings.apiKeys.length > 0,
      api_key_masked: maskKey(settings.apiKey || settings.apiKeys[0]?.key || ''),
      keys_total: settings.apiKeys.length,
      keys_available: availableKeyCount(),
      key_strategy: settings.keyStrategy,
      keys: keyStatusList(),
      default_chat_model: settings.defaultChatModel,
      default_image_model: settings.defaultImageModel,
      watermark: settings.watermark,
      store_images: settings.storeImages,
      expose_image_models: settings.exposeImageModels,
      chat_image_mode: settings.chatImageMode,
      data_dir: settings.home,
      models: models.data,
      stats,
      recent_errors: recentErrors,
    });
  }

  if (req.method === 'POST' && pathname === '/admin/api/config') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      requestLog(pathname, req, 400, startedAt);
      return sendError(res, 400, '请求体不是合法 JSON', 'invalid_request_error', 'invalid_json');
    }
    const previousPort = settings.port;
    const patch = {};
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
    if (typeof body.keyStrategy === 'string') patch.keyStrategy = body.keyStrategy === 'priority' ? 'priority' : 'round-robin';
    if (typeof body.providerKey === 'string' && body.providerKey.trim()) patch.providerKey = body.providerKey.trim();
    if (typeof body.defaultChatModel === 'string' && body.defaultChatModel.trim()) patch.defaultChatModel = body.defaultChatModel.trim();
    if (typeof body.defaultImageModel === 'string' && body.defaultImageModel.trim()) patch.defaultImageModel = body.defaultImageModel.trim();
    if (typeof body.watermark === 'boolean') patch.watermark = body.watermark;
    if (typeof body.storeImages === 'boolean') patch.storeImages = body.storeImages;
    if (typeof body.exposeImageModels === 'boolean') patch.exposeImageModels = body.exposeImageModels;
    if (body.chatImageMode === 'inline' || body.chatImageMode === 'local') patch.chatImageMode = body.chatImageMode;
    if (Number.isInteger(body.port) && body.port > 1024 && body.port < 65536) patch.port = body.port;
    saveSettings(patch);
    Object.assign(settings, patch);
    modelCache = { at: 0, data: null };
    const restartRequired = patch.port !== undefined && patch.port !== previousPort;
    requestLog(pathname, req, 200, startedAt);
    log(`admin config updated: ${Object.keys(patch).join(',') || 'noop'}${restartRequired ? '（端口变更需重启）' : ''}`);
    return sendJson(res, 200, {
      ok: true,
      restart_required: restartRequired,
      api_key_configured: settings.apiKeys.length > 0,
      api_key_masked: maskKey(settings.apiKey || settings.apiKeys[0]?.key || ''),
      keys_total: settings.apiKeys.length,
      keys_available: availableKeyCount(),
      default_image_model: settings.defaultImageModel,
      default_chat_model: settings.defaultChatModel,
      watermark: settings.watermark,
      store_images: settings.storeImages,
      expose_image_models: settings.exposeImageModels,
      port: settings.port,
    });
  }

  if (req.method === 'GET' && pathname === '/admin/api/keys') {
    requestLog(pathname, req, 200, startedAt);
    return sendJson(res, 200, {
      ok: true,
      strategy: settings.keyStrategy,
      total: settings.apiKeys.length,
      available: availableKeyCount(),
      keys: keyStatusList(),
    });
  }

  if (req.method === 'POST' && pathname === '/admin/api/keys') {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      requestLog(pathname, req, 400, startedAt);
      return sendError(res, 400, '请求体不是合法 JSON', 'invalid_request_error', 'invalid_json');
    }
    const action = typeof body.action === 'string' ? body.action : '';
    const targetId = typeof body.id === 'string' ? body.id : '';
    const findKey = () => settings.apiKeys.find((item) => item.id === targetId || item.key === targetId);
    let note = '';

    if (action === 'add') {
      const value = typeof body.key === 'string' ? body.key.trim() : '';
      if (!value) return sendError(res, 400, 'key 不能为空', 'invalid_request_error', 'missing_key');
      const id = hashId(value);
      if (settings.apiKeys.some((item) => item.id === id)) {
        return sendJson(res, 200, { ok: true, duplicate: true, strategy: settings.keyStrategy, total: settings.apiKeys.length, available: availableKeyCount(), keys: keyStatusList() });
      }
      settings.apiKeys.push({ id, key: value, label: typeof body.label === 'string' ? body.label.trim() : '', enabled: true });
      if (!settings.apiKey) settings.apiKey = value;
      note = `新增 key ${id}`;
    } else if (action === 'remove') {
      const key = findKey();
      if (!key) return sendError(res, 404, '找不到该 Key', 'invalid_request_error', 'key_not_found');
      settings.apiKeys = settings.apiKeys.filter((item) => item.id !== key.id);
      keyRuntime.delete(key.id);
      if (settings.apiKey === key.key) settings.apiKey = settings.apiKeys[0]?.key || '';
      note = `删除 key ${key.id}`;
    } else if (action === 'enable' || action === 'disable') {
      const key = findKey();
      if (!key) return sendError(res, 404, '找不到该 Key', 'invalid_request_error', 'key_not_found');
      key.enabled = action === 'enable';
      note = `${action} key ${key.id}`;
    } else if (action === 'reset') {
      const key = findKey();
      if (!key) return sendError(res, 404, '找不到该 Key', 'invalid_request_error', 'key_not_found');
      keyRuntime.set(key.id, { fails: 0, cooldownUntil: 0, lastError: '', lastErrorAt: 0, lastUsedAt: 0, calls: 0, successes: 0 });
      note = `重置 key ${key.id}`;
    } else if (action === 'clear_cooldown') {
      for (const key of settings.apiKeys) {
        const state = keyState(key.id);
        state.cooldownUntil = 0;
      }
      note = '清除全部冷却';
    } else if (action === 'reorder') {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const ordered = ids.map((id) => settings.apiKeys.find((item) => item.id === id)).filter(Boolean);
      const rest = settings.apiKeys.filter((item) => !ordered.includes(item));
      settings.apiKeys = [...ordered, ...rest];
      note = '调整顺序';
    } else {
      return sendError(res, 400, `未知操作：${action || '(empty)'}`, 'invalid_request_error', 'unknown_action');
    }

    saveSettings({});
    modelCache = { at: 0, data: null };
    log(`admin keys: ${note}`);
    requestLog(pathname, req, 200, startedAt);
    return sendJson(res, 200, {
      ok: true,
      strategy: settings.keyStrategy,
      total: settings.apiKeys.length,
      available: availableKeyCount(),
      keys: keyStatusList(),
    });
  }

  if (req.method === 'POST' && pathname === '/admin/api/selfcheck') {
    const raw = await readBody(req);
    let body = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        requestLog(pathname, req, 400, startedAt);
        return sendError(res, 400, '请求体不是合法 JSON', 'invalid_request_error', 'invalid_json');
      }
    }
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : settings.defaultImageModel;
    const result = await generateImages({
      model,
      prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : '一只白色毛绒绒的海豹宝宝漂浮在平静海面上，柔和晨光，写实摄影风格',
      size: body.size || '1024x1024',
      n: 1,
      watermark: false,
      outputFormat: 'png',
      wantB64: true,
      forceSave: true,
    });
    const item = result.data[0];
    requestLog(pathname, req, 200, startedAt);
    return sendJson(res, 200, {
      ok: true,
      model,
      size: result.size,
      bytes: Buffer.from(item.b64_json, 'base64').length,
      url: item.url,
      saved: item.local_path,
      preview_url: item.local_url,
      elapsed_ms: result.elapsedMs,
    });
  }

  if (req.method === 'GET' && /^\/v1\/models$/.test(pathname)) {
    const models = await listModels(url.searchParams.get('refresh') === '1');
    const capability = url.searchParams.get('capability');
    const payload = capability ? { object: 'list', data: models.data.filter((m) => m.capability === capability) } : models;
    requestLog(pathname, req, 200, startedAt);
    return sendJson(res, 200, payload);
  }

  if (req.method === 'POST' && /^\/v1\/chat\/completions$/.test(pathname)) {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      requestLog(pathname, req, 400, startedAt);
      return sendError(res, 400, '请求体不是合法 JSON', 'invalid_request_error', 'invalid_json');
    }
    await handleChat(req, res, body);
    requestLog(pathname, req, res.statusCode, startedAt);
    return;
  }

  if (req.method === 'POST' && /^\/v1\/images\/generations$/.test(pathname)) {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      requestLog(pathname, req, 400, startedAt);
      return sendError(res, 400, '请求体不是合法 JSON', 'invalid_request_error', 'invalid_json');
    }
    await handleImageGeneration(req, res, body);
    requestLog(pathname, req, res.statusCode, startedAt);
    return;
  }

  if (req.method === 'POST' && /^\/v1\/images\/edits$/.test(pathname)) {
    const raw = await readBody(req);
    await handleImageEdit(req, res, raw, req.headers['content-type']);
    requestLog(pathname, req, res.statusCode, startedAt);
    return;
  }

  requestLog(pathname, req, 404, startedAt);
  sendError(res, 404, `未实现的端点：${req.method} ${pathname}`, 'invalid_request_error', 'unknown_endpoint');
}

async function selfcheck() {
  const report = { upstream: settings.upstream, api_key_configured: Boolean(settings.apiKey), checks: [] };
  if (!settings.apiKey) {
    report.checks.push({ name: 'api_key', ok: false, detail: '未配置 SENSENOVA_API_KEY / settings.json apiKey / --api-key' });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(2);
  }
  try {
    const models = await listModels(true);
    const imageModels = models.data.filter((m) => m.capability === 'image').map((m) => m.id);
    report.checks.push({ name: 'models', ok: true, detail: `${models.data.length} 个模型，生图 ${imageModels.length} 个`, image_models: imageModels });
  } catch (err) {
    report.checks.push({ name: 'models', ok: false, detail: err.message });
  }
  const model = args.selfcheckModel || process.env.SENSENOVA_SELFCHECK_MODEL || settings.defaultImageModel;
  const started = Date.now();
  try {
    const result = await generateImages({
      model,
      prompt: '一只白色毛绒绒的海豹宝宝漂浮在平静海面上，柔和晨光，写实摄影风格',
      size: '1024x1024',
      n: 1,
      watermark: false,
      outputFormat: 'png',
      wantB64: true,
    });
    const buffer = Buffer.from(result.data[0].b64_json, 'base64');
    const saved = saveImage(buffer, extensionFor(result.data[0].media_type));
    report.checks.push({
      name: 'image_generation',
      ok: true,
      model,
      applied_size: result.size,
      bytes: buffer.length,
      magic: buffer.subarray(0, 4).toString('hex'),
      url: result.data[0].url,
      saved,
      elapsed_ms: Date.now() - started,
    });
  } catch (err) {
    report.checks.push({ name: 'image_generation', ok: false, model, detail: err.message, upstream_body: err.upstreamBody });
  }
  const ok = report.checks.every((c) => c.ok);
  report.ok = ok;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(ok ? 0 : 1);
}

if (args.selfcheck) {
  await selfcheck();
}

function listen(port, remaining) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const status = err instanceof GatewayError ? err.status : 500;
      noteError(`${req.method} ${req.url} ${err.message}`, {
        status,
        ...(err.upstreamBody ? { upstream_body: String(err.upstreamBody).slice(0, 400) } : {}),
      });
      if (res.headersSent) {
        res.end();
        return;
      }
      // 上游报错原样回传，客户端才能看到商汤给出的真实原因（余额、风控、参数错误等）。
      if (err.upstreamBody) {
        const body = Buffer.from(err.upstreamBody);
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(body.length),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
        return;
      }
      sendError(res, status, err.message, err.type || 'internal_error', err.code);
    });
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && remaining > 0) {
      log(`端口 ${port} 被占用，尝试 ${port + 1}`);
      listen(port + 1, remaining - 1);
      return;
    }
    log(`启动失败：${err.message}`);
    process.exit(1);
  });
  server.listen(port, settings.host, () => {
    settings.port = port;
    persistPort(port);
    log(`商汤生图网关 v${VERSION} 监听 http://${settings.host}:${port}`);
    log(`OpenAI base_url: http://${settings.host}:${port}/v1  上游: ${settings.upstream}  Key: ${settings.apiKey ? maskKey(settings.apiKey) : '未配置'}`);
    process.stdout.write(`SENSENOVA_GATEWAY_LISTENING http://${settings.host}:${port}/v1\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log(`收到 ${signal}，关闭网关`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

listen(settings.port, 20);
