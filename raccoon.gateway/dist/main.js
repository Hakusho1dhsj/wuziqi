'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HOST = '127.0.0.1';
const PORT = 18912;
const ENTRY = path.join(__dirname, 'gateway.mjs');
const DATA_DIR = path.join(
  process.env.AICODE_DATA_DIR || path.join(process.env.HOME || '/root', '.aicode-plugin-data'),
  'raccoon-gateway',
);

const { pathToFileURL } = require('node:url');

let child = null;
let embedded = null;
let lastError = null;
let lastExit = null;

function settingsFile() {
  return path.join(DATA_DIR, 'settings.json');
}

function readSettings() {
  try {
    const text = fs.readFileSync(settingsFile(), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function actualPort() {
  const settings = readSettings();
  if (settings && Number.isInteger(settings.port) && settings.port > 0) return settings.port;
  if (settings && Number.isInteger(settings.requestedPort) && settings.requestedPort > 0) return settings.requestedPort;
  return PORT;
}

async function startService() {
  if (embedded) return embedded;
  if (child && child.exitCode === null) return child;

  process.env.RACCOON_GATEWAY_HOME = DATA_DIR;
  process.env.RACCOON_GATEWAY_PORT = String(PORT);
  try {
    const url = pathToFileURL(ENTRY).href;
    const module = await import(url);
    embedded = module;
    module.startGateway();
    return embedded;
  } catch (error) {
    lastError = `进程内启动失败：${(error && error.message) || String(error)}`;
    embedded = null;
  }

  const spawned = spawn(process.execPath, [ENTRY, '--port', String(PORT), '--data-dir', DATA_DIR], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: __dirname,
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
  if (embedded) {
    const module = embedded;
    embedded = null;
    try {
      await module.closeGateway();
    } catch (error) {
      lastError = String((error && error.message) || error);
    }
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
  const settings = readSettings();
  if (!settings || typeof settings.adminKey !== 'string' || settings.adminKey.length === 0) {
    return { ok: false, message: '网关尚未就绪，请稍后重试或点重启' };
  }
  const port = actualPort();
  const headers = { 'x-admin-key': settings.adminKey };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(`http://${HOST}:${port}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
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
    const settings = readSettings();
    if (settings && typeof settings.adminKey === 'string') {
      const port = actualPort();
      try {
        const response = await fetch(`http://${HOST}:${port}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) return true;
      } catch {
        /* 还没起来 */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function collectLogs() {
  const out = [];
  if (lastError) out.push(`last: ${lastError}`);
  if (embedded && typeof embedded.gatewayLogs === 'function') {
    try {
      for (const line of embedded.gatewayLogs()) out.push(line);
    } catch {
      /* 日志不可用不影响状态 */
    }
  }
  return out.slice(-40);
}

async function statusPayload() {
  const settings = readSettings();
  const port = actualPort();
  const running = embedded !== null || (child !== null && child.exitCode === null);
  let health = null;
  if (settings && typeof settings.adminKey === 'string') {
    try {
      const response = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) health = await response.json();
    } catch {
      health = null;
    }
  }
  return {
    running,
    responsive: health !== null,
    requestedPort: PORT,
    actualPort: port,
    baseUrl: `http://${HOST}:${port}/v1`,
    apiKey: settings && typeof settings.apiKey === 'string' ? settings.apiKey : null,
    adminKey: settings && typeof settings.adminKey === 'string' ? settings.adminKey : null,
    mode: embedded ? 'embedded' : 'spawn',
    node: process.version,
    execPath: process.execPath,
    dataDir: DATA_DIR,
    accounts: health ? health.accounts : 0,
    checkin: health && health.checkin ? health.checkin : null,
    note: port === PORT
      ? '在「设置 → 提供商」中选择「小浣熊网关」，API Key 填上面的值即可。'
      : `网关实际监听 ${port}（${PORT} 被占用），请把「小浣熊网关」条目的地址改为 ${`http://${HOST}:${port}/v1`}。`,
    lastExit,
    logs: collectLogs(),
  };
}

const handlers = {
  'hooks.boot': async () => {
    try {
      await startService();
      const ready = await waitReady(8000);
      return { ok: true, note: ready ? 'gateway ready' : 'gateway starting; use the status tool to confirm readiness' };
    } catch (error) {
      lastError = String((error && error.message) || error);
      return { ok: false, error: lastError };
    }
  },
  'tools.status': () => statusPayload(),
  'tools.checkin': async (args) => {
    const body = {};
    if (args && Array.isArray(args.ids) && args.ids.length > 0) body.ids = args.ids;
    if (args && args.force === true) body.force = true;
    return callGateway('/admin/api/checkin', 'POST', body);
  },
  'tools.restart': async () => {
    await stopService();
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await startService();
      const ready = await waitReady(8000);
      return { ok: ready, note: ready ? 'gateway restarted' : 'gateway restarting; use the status tool to confirm readiness' };
    } catch (error) {
      lastError = String((error && error.message) || error);
      return { ok: false, error: lastError };
    }
  },
  'ui.status': () => statusPayload(),
  'ui.restart': async () => {
    await stopService();
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await startService();
      const ready = await waitReady(8000);
      return { ok: ready, note: ready ? 'gateway restarted' : 'gateway restarting' };
    } catch (error) {
      lastError = String((error && error.message) || error);
      return { ok: false, error: lastError };
    }
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
    .catch((error) => send({
      jsonrpc: '2.0',
      id,
      error: { code: 'PLUGIN_ERROR', message: String((error && error.message) || error) },
    }));
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
