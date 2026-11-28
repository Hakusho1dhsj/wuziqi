'use strict';

/**
 * 商汤生图插件运行时。
 *
 * 宿主通过 stdio JSON-RPC 调用这里的 handler：hooks.boot 拉起网关子进程，
 * tools.* 给 AI 调用，ui.* 给插件配置页调用。网关本体在 dist/gateway.mjs。
 * 密钥与运行数据只写插件数据目录，不回写安装包。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HOST = '127.0.0.1';
const PORT = 18918;
const ENTRY = path.join(__dirname, 'gateway.mjs');
const DATA_DIR = path.join(
  process.env.AICODE_DATA_DIR || path.join(process.env.HOME || '/root', '.aicode-plugin-data'),
  'sensenova-gateway',
);
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const DEFAULTS = {
  host: HOST,
  upstream: 'https://token.sensenova.cn/v1',
  apiKey: '',
  apiKeys: [],
  keyStrategy: 'round-robin',
  providerKey: 'sk-sensenova-local',
  adminKey: '',
  defaultChatModel: 'sensenova-6.8-flash',
  defaultImageModel: 'sensenova-u1.5-lite',
  watermark: false,
  storeImages: false,
};

let child = null;
let reused = false;
let lastError = null;
let lastExit = null;

function settingsFile() {
  return path.join(DATA_DIR, 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return null;
  }
}

function writeSettings(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2) + '\n');
}

function ensureSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const current = readSettings();
  if (!current) {
    writeSettings({ ...DEFAULTS, port: PORT });
    return;
  }
  // 旧版配置只有单个 apiKey，迁移到 Key 池但保留原字段。
  if (!Array.isArray(current.apiKeys)) {
    const migrated = current.apiKey ? [{ key: current.apiKey, label: '默认', enabled: true }] : [];
    writeSettings({ ...current, apiKeys: migrated });
  }
}

function actualPort() {
  const settings = readSettings();
  if (settings && Number.isInteger(settings.port) && settings.port > 0) return settings.port;
  return PORT;
}

async function probeExisting() {
  const port = actualPort();
  try {
    const response = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const body = await response.json();
    if (body && typeof body.upstream === 'string' && body.upstream.includes('sensenova')) return body;
    return null;
  } catch {
    return null;
  }
}

async function startService() {
  if (child && child.exitCode === null) return child;
  ensureSettings();
  // 同一端口已有同源网关（手动启动或上一个 runtime 实例）时直接复用，
  // 否则新实例会顺延端口，让 provider 里写死的地址失效。
  const existing = await probeExisting();
  if (existing) {
    reused = true;
    return null;
  }
  reused = false;
  const port = actualPort();
  const spawned = spawn(process.execPath, [ENTRY, '--port', String(port), '--data-dir', DATA_DIR], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: __dirname,
    env: { ...process.env, SENSENOVA_GATEWAY_HOME: DATA_DIR },
  });
  child = spawned;
  spawned.stdout.on('data', () => {});
  spawned.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text.length > 0) lastError = text;
  });
  spawned.on('exit', (code, signal) => {
    lastExit = { code, signal };
    lastError = `gateway exited: code=${String(code)} signal=${String(signal)}`;
    if (child === spawned) child = null;
  });
  lastExit = null;
  return spawned;
}

async function stopService() {
  if (reused) {
    reused = false;
    return;
  }
  if (!child) return;
  const current = child;
  child = null;
  current.removeAllListeners('exit');
  current.on('exit', () => {});
  try {
    current.kill('SIGTERM');
  } catch {
    /* 进程可能已退出 */
  }
}

async function callGateway(pathname, method = 'GET', body) {
  ensureSettings();
  const settings = readSettings();
  const port = actualPort();
  const headers = { 'x-admin-key': (settings && settings.adminKey) || '' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(`http://${HOST}:${port}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
  } catch (error) {
    return { ok: false, message: `无法连接网关：${error && error.message ? error.message : String(error)}` };
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, message: text.slice(0, 500) || `HTTP ${response.status}` };
  }
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = actualPort();
    try {
      const response = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function tailLog(lines = 20) {
  const file = path.join(DATA_DIR, 'logs', 'gateway.log');
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    return text.slice(-lines);
  } catch {
    return [];
  }
}

async function statusPayload() {
  const settings = readSettings();
  const port = actualPort();
  const running = (child !== null && child.exitCode === null) || reused;
  let health = null;
  let config = null;
  if (running) {
    try {
      const response = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) health = await response.json();
    } catch {
      health = null;
    }
    config = await callGateway('/admin/api/config', 'GET');
    if (config && config.ok === false) config = null;
  }
  return {
    running,
    responsive: health !== null,
    reusedExisting: reused,
    requestedPort: PORT,
    actualPort: port,
    baseUrl: `http://${HOST}:${port}/v1`,
    providerKey: (settings && settings.providerKey) || DEFAULTS.providerKey,
    apiKeyConfigured: Boolean(settings && ((settings.apiKeys && settings.apiKeys.length) || settings.apiKey)),
    apiKeyMasked: settings && settings.apiKey ? `${settings.apiKey.slice(0, 6)}…${settings.apiKey.slice(-4)}` : '',
    keyStrategy: (config && config.key_strategy) || (settings && settings.keyStrategy) || DEFAULTS.keyStrategy,
    keysTotal: (config && config.keys_total) || (settings && Array.isArray(settings.apiKeys) ? settings.apiKeys.length : 0),
    keysAvailable: (config && config.keys_available) || 0,
    keys: (config && Array.isArray(config.keys) && config.keys) || [],
    defaultChatModel: (settings && settings.defaultChatModel) || DEFAULTS.defaultChatModel,
    defaultImageModel: (settings && settings.defaultImageModel) || DEFAULTS.defaultImageModel,
    watermark: Boolean(settings && settings.watermark),
    storeImages: Boolean(settings && settings.storeImages),
    dataDir: DATA_DIR,
    imageDir: IMAGE_DIR,
    health,
    lastExit,
    note:
      port === PORT
        ? '在「设置 → 提供商」中选择「商汤生图」，API Key 随便填，地址已是本地网关。'
        : `网关实际监听 ${port}（${PORT} 被占用），请在「商汤生图」提供商条目把地址改为 http://${HOST}:${port}/v1。`,
    logs: [...(lastError ? [`last: ${lastError}`] : []), ...tailLog(20)].slice(-40),
  };
}

async function generateImage(args) {
  const prompt = args && typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'prompt 不能为空' };
  const settings = readSettings() || {};
  const model = (args && args.model) || settings.defaultImageModel || DEFAULTS.defaultImageModel;
  const size = (args && args.size) || '1024x1024';
  const port = actualPort();
  let response;
  try {
    response = await fetch(`http://${HOST}:${port}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, size, n: 1, response_format: 'b64_json' }),
      signal: AbortSignal.timeout(300000),
    });
  } catch (error) {
    return { ok: false, error: `无法连接网关：${error && error.message ? error.message : String(error)}` };
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: text.slice(0, 500) || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    return { ok: false, error: (body && body.error && body.error.message) || `HTTP ${response.status}`, upstream: body };
  }
  const item = body.data && body.data[0];
  if (!item || !item.b64_json) return { ok: false, error: '上游未返回图片数据', upstream: body };
  const buffer = Buffer.from(item.b64_json, 'base64');
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const file = path.join(IMAGE_DIR, `sensenova-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
  fs.writeFileSync(file, buffer);
  return {
    ok: true,
    model,
    size: (body.gateway && body.gateway.applied_size) || size,
    bytes: buffer.length,
    path: file,
    url: item.url || null,
    elapsed_ms: (body.gateway && body.gateway.elapsed_ms) || null,
  };
}

const handlers = {
  'hooks.boot': async () => {
    try {
      await startService();
      const ready = await waitReady(8000);
      return { ok: true, ready, note: ready ? 'gateway ready' : 'gateway starting; 用 status 工具确认' };
    } catch (error) {
      lastError = String((error && error.message) || error);
      return { ok: false, error: lastError };
    }
  },
  'tools.status': () => statusPayload(),
  'tools.restart': async () => {
    await stopService();
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await startService();
      const ready = await waitReady(10000);
      return { ok: ready, note: ready ? 'gateway restarted' : 'gateway restarting' };
    } catch (error) {
      lastError = String((error && error.message) || error);
      return { ok: false, error: lastError };
    }
  },
  'tools.image': (args) => generateImage(args || {}),
  'ui.status': () => statusPayload(),
  'ui.restart': async () => {
    await stopService();
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await startService();
      const ready = await waitReady(10000);
      return { ok: ready, note: ready ? 'gateway restarted' : 'gateway restarting' };
    } catch (error) {
      lastError = String((error && error.message) || error);
      return { ok: false, error: lastError };
    }
  },
  'ui.config': async (args) => {
    const method = args && typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    if (method === 'GET') return callGateway('/admin/api/config', 'GET');
    const body = (args && args.body) || {};
    return callGateway('/admin/api/config', 'POST', body);
  },
  'ui.selfcheck': async (args) => {
    const body = (args && args.body) || {};
    return callGateway('/admin/api/selfcheck', 'POST', body);
  },
  'ui.keys': async (args) => {
    const method = args && typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    if (method === 'GET') return callGateway('/admin/api/keys', 'GET');
    return callGateway('/admin/api/keys', 'POST', (args && args.body) || {});
  },
  'ui.api': async (args) => {
    const pathname = args && typeof args.path === 'string' ? args.path : '';
    if (!pathname.startsWith('/admin/api/')) {
      return { ok: false, message: '只允许访问 /admin/api 下的接口' };
    }
    const method = args && typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    return callGateway(pathname, method, args && args.body);
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleRequest(id, method, params) {
  if (method !== 'tool.invoke' && method !== 'hook.invoke' && method !== 'ui.invoke') {
    send({ jsonrpc: '2.0', id, error: { code: 'METHOD_UNKNOWN', message: method } });
    return;
  }
  const handler = handlers[params.handler];
  if (typeof handler !== 'function') {
    send({ jsonrpc: '2.0', id, error: { code: 'HANDLER_NOT_FOUND', message: params.handler } });
    return;
  }
  Promise.resolve()
    .then(() => handler(params.args || {}))
    .then((result) => send({ jsonrpc: '2.0', id, result: result === undefined ? null : result }))
    .catch((error) =>
      send({
        jsonrpc: '2.0',
        id,
        error: { code: 'PLUGIN_ERROR', message: String((error && error.message) || error) },
      }),
    );
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method && message.id !== undefined) {
    handleRequest(message.id, message.method, message.params || {});
  }
});

process.on('SIGTERM', () => {
  stopService().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
process.on('SIGINT', () => {
  stopService().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
