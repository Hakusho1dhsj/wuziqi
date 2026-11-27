'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns');
const { URL } = require('url');
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 600000,
  scheduling: 'lifo',
});
const readline = require('readline');

// Node 18/22 的 http.Agent 都会把已被上游关闭的空闲 socket 重新派发给下一个请求，
// TLS socket 在握手期直接抛 "Client network socket disconnected before secure TLS
// connection was established"（ECONNRESET），且 req.reusedSocket 已为 false，无法据此判断。
// 这里在 error 时清掉池内失效 socket 并用同一 agent 重发一次；此时 body 尚未写出，重发无副作用。
function isDeadSocket(sock) {
  return !sock || sock.destroyed || sock.writable === false || sock.readableEnded;
}

function purgeDeadSockets(agent) {
  const groups = [agent.freeSockets, agent.sockets];
  for (const group of groups) {
    if (!group) continue;
    for (const key of Object.keys(group)) {
      const kept = group[key].filter((s) => !isDeadSocket(s));
      for (const s of group[key]) if (kept.indexOf(s) < 0) { try { s.destroy(); } catch (e) {} }
      if (kept.length) group[key] = kept; else delete group[key];
    }
  }
}

function isStaleSocketError(e) {
  if (!e) return false;
  if (e.code === 'ECONNRESET') return true;
  return String(e.message || e).indexOf('Client network socket disconnected') >= 0;
}

// 返回值是 req，调用方负责 setTimeout/write/end。
// 重试只发生一次，且必然在 end() 之前，body 尚未写出。
function httpsRequestFresh(opts, onResponse, onError, bodyBuf) {
  let retried = false;
  let current = null;
  const attempt = () => {
    const req = https.request(opts, onResponse);
    current = req;
    req.on('error', (e) => {
      if (!retried && isStaleSocketError(e)) {
        retried = true;
        purgeDeadSockets(keepAliveAgent);
        attempt();
        return;
      }
      onError(e);
    });
    if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
    req.end();
  };
  attempt();
  return {
    setTimeout: (ms, cb) => { if (current) current.setTimeout(ms, cb); },
    destroy: (e) => { if (current) current.destroy(e); },
  };
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

function sendEvent(name, payload) {
  send({ jsonrpc: '2.0', method: 'plugin.event', params: { name, payload } });
}

let hostSeq = 0;
const hostPending = new Map();

function hostCall(method, params, timeoutMs) {
  const id = 'host-' + ++hostSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostPending.delete(id);
      reject(new Error('host call timeout: ' + method));
    }, timeoutMs || 15000);
    hostPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    send({ jsonrpc: '2.0', id, method, params: params || {} });
  });
}

function handleHostResponse(id, message) {
  const entry = hostPending.get(id);
  if (!entry) return;
  hostPending.delete(id);
  if (message.error) entry.reject(new Error(message.error.message || 'host error'));
  else entry.resolve(message.result);
}

const DATA_URL = 'data://config.json';

// 配置读写在宿主 data:// 私有目录：开发目录与已安装 zip 都能写，卸载时自动清除
let configLoaded = false;
let configLoadPromise = null;

async function configLoad() {
  if (configLoaded) return config;
  if (configLoadPromise) return configLoadPromise;
  configLoadPromise = (async () => {
    let stored = null;
    try {
      const r = await hostCall('host.fs.read', { path: DATA_URL }, 15000);
      const text = typeof r === 'string' ? r : (r && (r.content || r.text));
      if (text) stored = JSON.parse(text);
    } catch (e) {
      // 首次运行时文件不存在，属正常
    }
    if (stored && typeof stored === 'object') {
      config = Object.assign({}, DEFAULT_CONFIG, config, stored);
      if (config.token) savedToken = config.token;
      if (config.authToken) savedAuthToken = config.authToken;
      if (config.authPass) savedAuthPass = config.authPass;
    }
    configLoaded = true;
    return config;
  })();
  return configLoadPromise;
}

const DEFAULT_CONFIG = {
  upstream: '',
  token: '',
  tokenMode: 'bearer',
  profile: 'codex',
  port: 8788,
  host: '127.0.0.1',
  stripStainless: true,
  rewriteBody: false,
  extraHeaders: {},
  proxy: '',
  autoStart: false,
  // nativeMode：用宿主 agent.http.before 直连伪装，不必把供应商 baseUrl 指到 127.0.0.1
  nativeMode: false,
  // nativeHosts：只接管这些域名的请求（空数组 = 全部）。防止误改其他供应商流量。
  nativeHosts: [],
  authEnabled: false,
  authMode: 'bearer',
  authToken: '',
  authUser: 'muse',
  authPass: '',
  authHeader: 'x-api-key',
  providerApiKey: '',
  removeHeaders: ['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding'],
};

let config = Object.assign({}, DEFAULT_CONFIG);
let providerSync = { at: null, ok: null, note: null };
let savedToken = '';
let savedAuthToken = '';
let savedAuthPass = '';

const PROFILES = {
  codex: {
    label: 'Codex CLI',
    userAgent: 'codex_cli_rs/0.46.0 (Mac OS 15.0; arm64) terminal',
    headers: {
      originator: 'codex_cli_rs',
      'accept': 'text/event-stream',
      'x-stainless-lang': 'js',
      'x-stainless-arch': 'arm64',
      'x-stainless-os': 'MacOS',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.5.0',
      'x-stainless-package-version': '4.71.0',
      'session_id': '00000000-0000-0000-0000-000000000000',
    },
    rewrite: (body, url) => {
      // Codex 走 /v1/responses。若请求体是 chat 格式，原样放过；若已是 responses 格式则补齐字段
      if (url.indexOf('/responses') >= 0 && body && typeof body === 'object') {
        if (!body.instructions) {
          body.instructions = 'You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user\'s computer.';
        }
        if (body.store === undefined) body.store = false;
        if (body.stream === undefined) body.stream = true;
        if (body.include === undefined) body.include = [];
        if (body.parallel_tool_calls === undefined) body.parallel_tool_calls = false;
      }
      if (url.indexOf('/chat/completions') >= 0 && body && typeof body === 'object') {
        if (body.stream === undefined) body.stream = true;
      }
      return body;
    },
  },
  'claude-code': {
    label: 'Claude Code CLI',
    userAgent: 'claude-cli/2.0.30 (external, cli)',
    headers: {
      'accept': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking-2025-05-14,context-management-2025-06-27',
      'x-app': 'cli',
      'x-stainless-lang': 'js',
      'x-stainless-arch': 'arm64',
      'x-stainless-os': 'MacOS',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.5.0',
      'x-stainless-package-version': '0.65.0',
    },
    rewrite: (body, url) => {
      if (body && typeof body === 'object' && url.indexOf('/messages') >= 0) {
        if (body.system && typeof body.system === 'string') {
          body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }];
        }
        if (body.stream === undefined) body.stream = true;
      }
      return body;
    },
  },
  opencode: {
    label: 'OpenCode',
    userAgent: 'opencode/0.6.3 (linux; x64)',
    headers: {
      'accept': 'text/event-stream',
      'x-opencode-client': 'cli',
      'x-stainless-lang': 'js',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.5.0',
    },
    rewrite: (body) => body,
  },
  cursor: {
    label: 'Cursor',
    userAgent: 'Cursor/0.46.11 (darwin arm64)',
    headers: {
      'accept': 'application/json',
      'x-cursor-client-version': '0.46.11',
      'x-cursor-checksum': '00000000000000000000000000000000',
      'x-ghost-mode': 'true',
    },
    rewrite: (body) => body,
  },
  cline: {
    label: 'Cline (VSCode)',
    userAgent: 'vscode/1.96.2 Cline/3.2.3 (darwin arm64)',
    headers: {
      'accept': 'application/json',
      'x-vscode-client': 'cline',
      'x-cline-version': '3.2.3',
    },
    rewrite: (body) => body,
  },
  roo: {
    label: 'Roo Code (VSCode)',
    userAgent: 'vscode/1.96.2 Roo-Code/3.18.0 (darwin arm64)',
    headers: { 'accept': 'application/json', 'x-roo-version': '3.18.0' },
    rewrite: (body) => body,
  },
  kilo: {
    label: 'Kilo Code (VSCode)',
    userAgent: 'vscode/1.96.2 Kilo-Code/4.60.0 (darwin arm64)',
    headers: { 'accept': 'application/json', 'x-kilo-version': '4.60.0' },
    rewrite: (body) => body,
  },
  copilot: {
    label: 'GitHub Copilot',
    userAgent: 'GitHubCopilotChat/0.23.2',
    headers: {
      'accept': 'application/json',
      'editor-version': 'vscode/1.96.2',
      'editor-plugin-version': 'copilot-chat/0.23.2',
      'user-agent': 'GitHubCopilotChat/0.23.2',
      'copilot-integration-id': 'vscode-chat',
    },
    rewrite: (body) => body,
  },
  'grok-cli': {
    label: 'Grok CLI',
    userAgent: 'grok-cli/0.1.8 (darwin arm64)',
    headers: { 'accept': 'text/event-stream', 'x-grok-client': 'cli' },
    rewrite: (body) => body,
  },
  trae: {
    label: 'Trae',
    userAgent: 'Trae/1.2.7 (darwin arm64)',
    headers: { 'accept': 'application/json', 'x-trae-client': 'ide' },
    rewrite: (body) => body,
  },
  qoder: {
    label: 'Qoder',
    userAgent: 'Qoder/0.9.4 (darwin arm64)',
    headers: { 'accept': 'application/json', 'x-qoder-client': 'ide' },
    rewrite: (body) => body,
  },
  custom: {
    label: '自定义',
    userAgent: 'codex_cli_rs/0.46.0 (Mac OS 15.0; arm64) terminal',
    headers: {},
    rewrite: (body) => body,
  },
};

const stats = {
  startedAt: null,
  requests: 0,
  forwarded: 0,
  clientErrors: 0,
  upstreamErrors: 0,
  lastError: null,
  lastStatus: null,
  lastUpstreamStatus: null,
  recent: [],
};

function pushRecent(entry) {
  stats.recent.unshift(entry);
  if (stats.recent.length > 30) stats.recent.length = 30;
}

let server = null;
let listeningPort = null;
let startPromise = null;

async function cfgSave() {
  try {
    await hostCall('host.fs.write', {
      path: DATA_URL,
      content: JSON.stringify(config, null, 2),
    }, 15000);
    return true;
  } catch (e) {
    try { hostCall('host.log', { level: 'error', message: 'config save failed: ' + e.message }); } catch (x) {}
    return false;
  }
}

function buildUpstreamHeaders(req, profile) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (config.removeHeaders.indexOf(lower) >= 0) continue;
    if (config.stripStainless && lower.indexOf('x-stainless') === 0) continue;
    if (lower === 'authorization' || lower === 'x-api-key') continue;
    // 本地鉴权头不能泄露给上游；authorization / x-api-key 已在上一行无条件剥离
    if (config.authEnabled && config.authMode === 'header'
      && lower === String(config.authHeader || 'x-api-key').toLowerCase()) continue;
    out[lower] = v;
  }
  // 档位头：user-agent 强制覆盖；其余仅在客户端未提供时补充，避免破坏 accept 等客户端语义
  for (const [k, v] of Object.entries(profile.headers || {})) {
    if (v === null || v === undefined) continue;
    const lower = k.toLowerCase();
    if (out[lower] !== undefined && lower !== 'originator' && lower !== 'x-app') continue;
    out[lower] = v;
  }
  out['user-agent'] = profile.userAgent;
  if (!out['accept']) out['accept'] = 'application/json';
  if (config.token) {
    const mode = config.tokenMode || 'bearer';
    if (mode === 'bearer' || mode === 'both') out['authorization'] = 'Bearer ' + config.token;
    if (mode === 'x-api-key' || mode === 'both') out['x-api-key'] = config.token;
  }
  for (const [k, v] of Object.entries(config.extraHeaders || {})) {
    out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

// ── 原生接管（agent.http.before）────────────────────────────────────────────
// AiCode 宿主在每次实际发出 provider HTTP 请求前派发该事件，插件可改 url / headers / body。
// 与本地反代是两条并行通道：开 nativeMode 后不必把供应商 baseUrl 改成 127.0.0.1:8788。

// payload.headers 里的鉴权头可能是 {{Token}} 占位符：原样回传且 origin 不变时宿主才恢复真值。
// 这里把请求改到上游 origin，所以必须写入真实 token，否则会把占位符当密钥发出去。
const AUTH_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key'];

function nativeTargetUrl(rawUrl) {
  const up = String(config.upstream || '').replace(/\/+$/, '');
  if (!up) return null;
  let u;
  try { u = new URL(rawUrl); } catch (e) { return null; }
  let p = u.pathname + u.search;
  if (/\/v1$/.test(up) && p.indexOf('/v1/') === 0) p = p.slice(3);
  if (p[0] !== '/') p = '/' + p;
  return up + p;
}

// 返回 null 表示不改写。返回对象即交给宿主应用的最终请求。
function applyNativeSpoof(payload) {
  if (!config.nativeMode) return null;
  if (!config.upstream) return null;
  if (!payload || typeof payload !== 'object') return null;
  const srcUrl = String(payload.url || '');
  if (!srcUrl) return null;
  const profile = PROFILES[config.profile] || PROFILES.codex;

  // 域名白名单：留空则接管全部 provider 请求；填了则只改列表内的域名
  const allowHosts = (config.nativeHosts || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (allowHosts.length) {
    let h = '';
    try { h = new URL(srcUrl).hostname.toLowerCase(); } catch (e) { h = ''; }
    if (!h || allowHosts.indexOf(h) < 0) return null;
  }
  // 已经指向上游自身的请求不再重复改写
  try {
    if (new URL(srcUrl).host.toLowerCase() === new URL(config.upstream).host.toLowerCase()) return null;
  } catch (e) { /* ignore */ }

  const target = nativeTargetUrl(srcUrl);
  if (!target) return null;

  const headers = {};
  for (const [k, v] of Object.entries(payload.headers || {})) {
    const lower = String(k).toLowerCase();
    if (config.removeHeaders.indexOf(lower) >= 0) continue;
    if (lower === 'host') continue;                       // 换 origin 后 host 由客户端重算
    if (config.stripStainless && lower.indexOf('x-stainless') === 0) continue;
    if (AUTH_HEADERS.indexOf(lower) >= 0) continue;        // 宿主鉴权头一律丢弃，改用上游 token
    headers[lower] = v;
  }
  for (const [k, v] of Object.entries(profile.headers || {})) {
    if (v === null || v === undefined) continue;
    const lower = k.toLowerCase();
    if (headers[lower] !== undefined && lower !== 'originator' && lower !== 'x-app') continue;
    headers[lower] = v;
  }
  headers['user-agent'] = profile.userAgent;
  if (!headers['accept']) headers['accept'] = 'application/json';
  if (config.token) {
    const mode = config.tokenMode || 'bearer';
    if (mode === 'bearer' || mode === 'both') headers['authorization'] = 'Bearer ' + config.token;
    if (mode === 'x-api-key' || mode === 'both') headers['x-api-key'] = config.token;
  }
  for (const [k, v] of Object.entries(config.extraHeaders || {})) {
    headers[String(k).toLowerCase()] = String(v);
  }

  const out = { url: target, headers };
  if (config.rewriteBody && typeof payload.body === 'string' && payload.body.trim().charAt(0) === '{') {
    try {
      const parsed = JSON.parse(payload.body);
      if (parsed && typeof parsed === 'object') {
        let path = srcUrl;
        try { path = new URL(target).pathname; } catch (e) { path = srcUrl; }
        out.body = JSON.stringify(profile.rewrite(parsed, path));
      }
    } catch (e) { /* 非 JSON 不改 body */ }
  }
  return out;
}

// 把 providerApiKey 直接写进宿主供应商条目，省掉「复制 Key → 粘贴保存」这一步。
async function syncProviderCredential() {
  const key = String(config.providerApiKey || '').trim();
  if (!key) {
    providerSync = { at: new Date().toISOString(), ok: null, note: '未配置 providerApiKey，跳过供应商凭据同步' };
    return providerSync;
  }
  try {
    await hostCall('host.providers.setApiKey', { providerId: 'spoof', apiKey: key }, 10000);
    providerSync = { at: new Date().toISOString(), ok: true, note: '已把 providerApiKey 写入宿主供应商「伪装反代」' };
  } catch (e) {
    providerSync = { at: new Date().toISOString(), ok: false, note: '供应商凭据同步失败（启用插件后重试）：' + String((e && e.message) || e) };
  }
  return providerSync;
}

function buildTargetUrl(reqUrl) {
  const up = config.upstream.replace(/\/+$/, '');
  let p = reqUrl || '/';
  // 上游若是 xxx/v1 形式，避免出现 /v1/v1
  if (/\/v1$/.test(up) && p.indexOf('/v1/') === 0) p = p.slice(3);
  if (p[0] !== '/') p = '/' + p;
  return new URL(up + p);
}

function decodeBody(buf, headers) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc.indexOf('gzip') >= 0) return zlib.gunzipSync(buf);
    if (enc.indexOf('br') >= 0) return zlib.brotliDecompressSync(buf);
    if (enc.indexOf('deflate') >= 0) return zlib.inflateSync(buf);
    if (enc.indexOf('zstd') >= 0) return zlib.zstdDecompressSync ? zlib.zstdDecompressSync(buf) : buf;
  } catch (e) {
    return buf;
  }
  return buf;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function shouldRewrite(reqUrl) {
  return config.rewriteBody && /\/v1\/(chat\/completions|responses|messages|completions)/.test(reqUrl);
}

function collectStreamToBody(req, profile) {
  return readRequestBody(req).then((buf) => {
    const plain = decodeBody(buf, req.headers);
    let parsed = null;
    let isJson = false;
    try {
      parsed = JSON.parse(plain.toString('utf8'));
      isJson = true;
    } catch (e) {
      return { raw: buf, json: null };
    }
    if (isJson && parsed && typeof parsed === 'object') {
      const out = profile.rewrite(parsed, req.url || '');
      const text = JSON.stringify(out);
      return { raw: Buffer.from(text, 'utf8'), json: out };
    }
    return { raw: buf, json: null };
  });
}

function parseProxy() {
  const raw = (config.proxy || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const isHttps = u.protocol === 'https:' || u.protocol === 'wss:';
    const auth = u.username
      ? Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')).toString('base64')
      : null;
    return {
      host: u.hostname,
      port: Number(u.port) || (isHttps ? 443 : 80),
      auth,
      secure: isHttps,
    };
  } catch (e) {
    return null;
  }
}

// 与代理建立隧道：发 CONNECT，成功后拿到到目标的明文 socket（外层自行按需 TLS 升级）
function connectTunnel(target, proxy) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: target.hostname + ':' + (target.port || 443),
      headers: proxy.auth ? { 'proxy-authorization': 'Basic ' + proxy.auth } : {},
    });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Error('proxy CONNECT failed: ' + res.statusCode));
      }
      settled = true;
      resolve(socket);
    });
    req.on('error', fail);
    req.setTimeout(30000, () => {
      req.destroy(new Error('proxy connect timeout'));
    });
    req.end();
  });
}

// DNS 缓存：此环境下 dns.lookup 极慢，解析一次后按 TTL 复用，避免每请求重复解析
const dnsCache = new Map();
const dnsInflight = new Map();
const DNS_TTL = 10 * 60 * 1000;
const DNS_NEG_TTL = 30 * 1000;

function resolveHost(hostname) {
  const cached = dnsCache.get(hostname);
  const now = Date.now();
  if (cached && cached.expires > now) {
    if (cached.addr) return Promise.resolve(cached.addr);
    return Promise.reject(cached.error || new Error('dns unavailable: ' + hostname));
  }
  // 并发去重：缓存空时多个请求共用同一次解析，避免重复触发慢解析
  const pending = dnsInflight.get(hostname);
  if (pending) return pending;
  const p = new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (!err && addresses && addresses.length) {
        const addr = addresses[0];
        dnsCache.set(hostname, { addr, expires: Date.now() + DNS_TTL });
        return resolve(addr);
      }
      const error = err || new Error('no DNS answer for ' + hostname);
      dnsCache.set(hostname, { error, expires: Date.now() + DNS_NEG_TTL });
      reject(error);
    });
  });
  dnsInflight.set(hostname, p);
  const clear = () => { dnsInflight.delete(hostname); };
  p.then(clear, clear);
  return p;
}

// 统一出站：无代理走直连；HTTP 上游经代理转发；HTTPS 上游走 CONNECT 隧道
function sendRequest(target, method, headers, bodyBuf, useProxy, idleMs) {
  const proxy = useProxy ? parseProxy() : null;
  const idleTimeout = idleMs || 300000;
  const isHttps = target.protocol === 'https:';
  if (proxy && isHttps) {
    const connectTarget = new URL(target.toString());
    return resolveHost(target.hostname).then((ip) => {
      connectTarget.hostname = ip;
      return connectTunnel(connectTarget, proxy);
    }).then((socket) => new Promise((resolve, reject) => {
      const req = https.request({
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        headers,
        servername: target.hostname,
        socket,
        agent: false,
      }, resolve);
      req.on('error', reject);
      req.setTimeout(idleTimeout, () => { req.destroy(new Error('upstream timeout')); });
      if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
      req.end();
    }));
  }
  if (proxy) {
    // HTTP 上游：直接把请求发给代理，请求行用绝对 URL
    const headers2 = Object.assign({}, headers);
    if (proxy.auth) headers2['proxy-authorization'] = 'Basic ' + proxy.auth;
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: proxy.host,
        port: proxy.port,
        path: target.toString(),
        method,
        headers: headers2,
        agent: false,
      }, resolve);
      req.on('error', reject);
      req.setTimeout(idleTimeout, () => { req.destroy(new Error('upstream timeout')); });
      if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
      req.end();
    });
  }
  const lib = isHttps ? https : http;
  return resolveHost(target.hostname).then((ip) => new Promise((resolve, reject) => {
    const headers2 = Object.assign({}, headers);
    if (!headers2.host) headers2.host = target.host;
    const reqOpts = {
      protocol: target.protocol,
      hostname: ip,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers: headers2,
      servername: isHttps ? target.hostname : undefined,
      rejectUnauthorized: true,
      agent: isHttps ? keepAliveAgent : false,
    };
    // HTTPS 走带重试的封装；HTTP 上游无 TLS 握手问题，直接用原生 request
    if (isHttps) {
      const req = httpsRequestFresh(reqOpts, resolve, reject, bodyBuf);
      req.setTimeout(idleTimeout, () => { req.destroy(new Error('upstream timeout')); });
      return;
    }
    const req = lib.request(reqOpts, resolve);
    req.on('error', reject);
    req.setTimeout(idleTimeout, () => { req.destroy(new Error('upstream timeout')); });
    if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
    req.end();
  }));
}

function passthroughRequest(req, url, headers, bodyBuf, idleMs) {
  return new Promise((resolve, reject) => {
    if (bodyBuf && bodyBuf.length) headers['content-length'] = String(bodyBuf.length);
    sendRequest(url, req.method, headers, bodyBuf, !!config.proxy, idleMs).then(resolve).catch(reject);
  });
}

// 预热连接池：提前建立 TCP+TLS 连接放入 keep-alive 池，避开首个请求的握手冷启动
function warmupConnections(count) {
  if (!config.upstream || config.proxy) return Promise.resolve();
  let target;
  try { target = new URL(config.upstream); } catch (e) { return Promise.resolve(); }
  if (target.protocol !== 'https:') return Promise.resolve();
  const n = Math.max(1, Math.min(count || 8, 16));
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push(new Promise((resolve) => {
      const done = (v) => resolve(v);
      resolveHost(target.hostname).then((ip) => {
        const req = https.request({
          protocol: target.protocol,
          hostname: ip,
          port: target.port || 443,
          path: '/',
          method: 'OPTIONS',
          headers: { host: target.host, connection: 'keep-alive' },
          servername: target.hostname,
          rejectUnauthorized: true,
          agent: keepAliveAgent,
        }, (res) => { res.resume(); res.on('end', () => done('ok')); });
        req.on('error', () => done('err'));
        req.end();
      }).catch(() => done('err'));
    }));
  }
  return Promise.all(jobs).then(() => undefined);
}

async function readStreamHead(res, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    };
    res.on('data', (c) => {
      if (done) return;
      chunks.push(c);
      n += c.length;
      if (n >= (maxBytes || 4096)) finish();
    });
    res.on('end', finish);
    res.on('error', finish);
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function authExempt(url) {
  for (const p of (config.authExempt || ['/__spoof', '/__spoof/health'])) {
    if (!p) continue;
    if (url === p || (p !== '/' && url.indexOf(p + '/') === 0)) return true;
  }
  return false;
}

// 本地反代访问鉴权：bearer / basic / 自定义头三种方式，逐字节恒定时间比较
function checkAuth(req) {
  if (!config.authEnabled) return true;
  if (authExempt(req.url || '/')) return true;
  const headers = req.headers;
  const mode = config.authMode || 'bearer';
  if (mode === 'basic') {
    const m = /^Basic\s+(.+)$/i.exec(headers['authorization'] || '');
    if (!m) return false;
    let decoded = '';
    try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (e) { return false; }
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    return safeEqual(decoded.slice(0, idx), config.authUser)
      && safeEqual(decoded.slice(idx + 1), config.authPass);
  }
  if (mode === 'header') {
    const v = headers[String(config.authHeader || 'x-api-key').toLowerCase()];
    return v !== undefined && safeEqual(v, config.authToken);
  }
  const m = /^Bearer\s+(.+)$/i.exec(headers['authorization'] || '');
  return !!m && safeEqual(m[1], config.authToken);
}

const CLIENT_CHECK_HINT = /仅支持编程客户端|only supports coding clients|unsupported client|client validation|not allowed client/i;

async function handle(req, res) {
  stats.requests++;
  const startedAt = Date.now();
  const record = { method: req.method, url: req.url, ts: new Date().toISOString() };

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.url === '/__spoof/health' || req.url === '/__spoof') {
    res.setHeader('content-type', 'application/json');
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      profile: config.profile,
      port: listeningPort,
      requests: stats.requests,
      forwarded: stats.forwarded,
      startedAt: stats.startedAt,
    }));
  }

  if (!checkAuth(req)) {
    stats.clientErrors++;
    record.error = 'auth failed';
    pushRecent(record);
    res.statusCode = 401;
    res.setHeader('www-authenticate', config.authMode === 'basic'
      ? 'Basic realm="spoof-proxy"'
      : config.authMode === 'header' ? String(config.authHeader || 'x-api-key') : 'Bearer');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'spoof_proxy' } }));
  }

  if (!config.upstream) {
    stats.clientErrors++;
    record.error = 'upstream not configured';
    pushRecent(record);
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: { message: 'upstream not configured', type: 'spoof_proxy' } }));
  }

  let profile = PROFILES[config.profile] || PROFILES.codex;
  let target;
  try {
    target = buildTargetUrl(req.url);
    record.target = target.toString();
  } catch (e) {
    stats.clientErrors++;
    stats.lastError = { at: new Date().toISOString(), message: 'invalid upstream: ' + (e && e.message || e) };
    record.error = 'invalid upstream url';
    record.ms = Date.now() - startedAt;
    pushRecent(record);
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: { message: 'invalid upstream url: ' + (config.upstream || ''), type: 'spoof_proxy' } }));
  }

  try {
    let headers = buildUpstreamHeaders(req, profile);
    let bodyBuf = null;
    let parsedBody = null;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (shouldRewrite(req.url)) {
        const got = await collectStreamToBody(req, profile);
        bodyBuf = got.raw;
        parsedBody = got.json;
        headers['content-type'] = 'application/json';
      } else {
        bodyBuf = await readRequestBody(req);
        if (bodyBuf.length) headers['content-length'] = String(bodyBuf.length);
      }
    }

    const isStream = !!(parsedBody && parsedBody.stream);
    record.profile = config.profile;
    record.userAgent = headers['user-agent'];
    record.stream = isStream;

    let upstreamRes = await passthroughRequest(req, target, headers, bodyBuf, isStream ? 600000 : 0);
    record.upstreamStatus = upstreamRes.statusCode;
    stats.lastUpstreamStatus = upstreamRes.statusCode;

    // 403 时做一次「诊断采样」：把上游 body 头 4KB 读出来判断是不是客户端校验，写进 recent
    if (upstreamRes.statusCode === 403 || upstreamRes.statusCode === 401) {
      const head = await readStreamHead(upstreamRes, 4096);
      let text = '';
      try { text = head.toString('utf8'); } catch (e) { text = ''; }
      record.blocked = CLIENT_CHECK_HINT.test(text);
      record.upstreamBody = text.slice(0, 800);
      if (record.blocked) {
        stats.lastError = { at: record.ts, message: 'upstream rejects client: 403 client check', body: text.slice(0, 400) };
        sendEvent('spoof.blocked', { url: req.url, status: upstreamRes.statusCode, body: text.slice(0, 600) });
      }
      res.statusCode = upstreamRes.statusCode;
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (['transfer-encoding', 'content-length', 'content-encoding', 'connection'].indexOf(k.toLowerCase()) >= 0) continue;
        res.setHeader(k, v);
      }
      res.end(head);
      stats.upstreamErrors++;
      record.ms = Date.now() - startedAt;
      pushRecent(record);
      return;
    }

    if (upstreamRes.statusCode >= 400) stats.upstreamErrors++;
    else stats.forwarded++;

    stats.lastStatus = upstreamRes.statusCode;

    res.statusCode = upstreamRes.statusCode;
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      const lower = k.toLowerCase();
      if (['transfer-encoding', 'connection', 'keep-alive', 'content-length'].indexOf(lower) >= 0) continue;
      try { res.setHeader(k, v); } catch (e) {}
    }
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json');

    // 流式必须立即 flush，禁用 Nagle 与缓冲，否则前端第一字节很晚
    if (res.socket) res.socket.setNoDelay(true);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    res.on('drain', () => {
      try { upstreamRes.resume(); } catch (e) {}
    });
    upstreamRes.on('data', (chunk) => {
      try {
        if (!res.write(chunk)) upstreamRes.pause();
      } catch (e) { /* client gone */ }
    });
    upstreamRes.on('end', () => {
      record.ms = Date.now() - startedAt;
      pushRecent(record);
      try { res.end(); } catch (e) {}
    });
    upstreamRes.on('error', (e) => {
      record.error = 'stream error: ' + e.message;
      stats.lastError = { at: new Date().toISOString(), message: e.message };
      pushRecent(record);
      try { res.destroy(e); } catch (x) {}
    });
    res.on('close', () => {
      if (!upstreamRes.complete) {
        try { upstreamRes.destroy(); } catch (e) {}
      }
    });
  } catch (e) {
    stats.clientErrors++;
    stats.lastError = { at: new Date().toISOString(), message: String(e && e.message || e) };
    record.error = String(e && e.message || e);
    record.ms = Date.now() - startedAt;
    pushRecent(record);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'proxy error: ' + (e && e.message || e), type: 'spoof_proxy' } }));
    } else {
      try { res.destroy(); } catch (x) {}
    }
  }
}

function listenOnce(port, host) {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    const onError = (e) => { s.removeListener('listening', onListening); reject(e); };
    const onListening = () => {
      s.removeListener('error', onError);
      s.close(() => resolve(port));
    };
    s.once('error', onError);
    s.once('listening', onListening);
    s.listen(port, host);
  });
}

async function findFreePort(preferred, maxTries) {
  const host = config.host || '127.0.0.1';
  const start = Number(preferred) > 0 ? Number(preferred) : 8788;
  if (!Number.isInteger(start) || start < 1 || start > 65535) {
    throw new Error('port must be an integer between 1 and 65535');
  }
  const tries = maxTries > 0 ? maxTries : 20;
  for (let i = 0; i < tries; i++) {
    const candidate = start + i;
    if (candidate > 65535) break;
    try {
      await listenOnce(candidate, host);
      return candidate;
    } catch (e) {
      if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) continue;
      throw e;
    }
  }
  throw new Error('no free port found from ' + start + ' to ' + (start + tries - 1));
}

async function startServer(port) {
  if (server && listeningPort) {
    return { port: listeningPort, already: true };
  }
  if (startPromise) {
    return startPromise;
  }
  startPromise = (async () => {
  if (!config.upstream) {
    throw new Error('upstream not configured');
  }
  const chosenPort = await findFreePort(port);
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        try { res.statusCode = 500; res.end('proxy internal error'); } catch (x) {}
      });
    });
    s.keepAliveTimeout = 65000;
    s.headersTimeout = 66000;
    s.requestTimeout = 0;
    s.on('clientError', (err, socket) => {
      try { socket.destroy(); } catch (e) {}
    });
    s.on('error', (e) => {
      server = null;
      listeningPort = null;
      stats.startedAt = null;
      reject(e);
    });
    s.listen(chosenPort, config.host || '127.0.0.1', () => {
      server = s;
      listeningPort = chosenPort;
      config.port = chosenPort;
      stats.startedAt = new Date().toISOString();
      cfgSave().catch(() => {});
      resolve({ port: chosenPort, already: false });
    });
  });
  })().finally(() => { startPromise = null; });
  return startPromise;
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) {
      listeningPort = null;
      stats.startedAt = null;
      return resolve({ stopped: true, wasRunning: false });
    }
    const s = server;
    server = null;
    listeningPort = null;
    stats.startedAt = null;
    try {
      const fallback = setTimeout(() => resolve({ stopped: true, wasRunning: true }), 2000);
      s.close(() => { clearTimeout(fallback); resolve({ stopped: true, wasRunning: true }); });
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      if (typeof s.closeIdleConnections === 'function') s.closeIdleConnections();
    } catch (e) {
      resolve({ stopped: true, wasRunning: true });
    }
  });
}

const PROVIDER_PORT = 8788;

function displayHost() {
  const h = config.host || '127.0.0.1';
  return (h === '0.0.0.0' || h === '::') ? '127.0.0.1' : h;
}

function providerNote() {
  if (config.nativeMode) {
    return '原生接管已开启：宿主请求由 agent.http.before 直写上游，供应商地址保持原样，不需要改 baseUrl';
  }
  if (!listeningPort || listeningPort === PROVIDER_PORT) return null;
  return `反代实际监听 ${listeningPort}，请到「设置 → AI 供应商」把「伪装反代」的地址改为 http://${displayHost()}:${listeningPort}/v1`;
}

function providerCredential() {
  const key = config.providerApiKey || null;
  return {
    key,
    hint: key
      ? '点「复制 Key」，粘贴到「设置 → AI 供应商 → 伪装反代」的 API Key 栏并保存'
      : null,
  };
}

function publicConfig() {
  const copy = Object.assign({}, config);
  if (copy.token) copy.token = copy.token.slice(0, 4) + '****' + copy.token.slice(-4);
  if (copy.authToken) copy.authToken = copy.authToken.slice(0, 4) + '****' + copy.authToken.slice(-4);
  if (copy.authPass) copy.authPass = '****';
  if (copy.providerApiKey) copy.providerApiKey = copy.providerApiKey.slice(0, 4) + '****' + copy.providerApiKey.slice(-4);
  return copy;
}

// 直连一次上游，验证伪装头是否过关；不走本地监听
async function testUpstream(modelHint) {
  {
    let target;
    try {
      target = buildTargetUrl('/v1/chat/completions');
    } catch (e) {
      return { ok: false, error: 'upstream url invalid' };
    }
    const profile = PROFILES[config.profile] || PROFILES.codex;
    const headers = buildUpstreamHeaders({ headers: {} }, profile);
    headers['content-type'] = 'application/json';
    const body = JSON.stringify({
      model: modelHint || 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    });
    const buf = Buffer.from(body, 'utf8');
    headers['content-length'] = String(buf.length);
    const isHttps = target.protocol === 'https:';
    let res;
    try {
      res = await sendRequest(target, 'POST', headers, buf, !!config.proxy);
    } catch (e) {
      return { ok: false, error: e.message, sentUserAgent: headers['user-agent'], target: target.toString() };
    }
    const chunks = [];
    await new Promise((resolve) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', resolve);
      res.on('error', resolve);
      setTimeout(resolve, 30000);
    });
    const text = Buffer.concat(chunks).toString('utf8');
    return {
      ok: res.statusCode < 400,
      status: res.statusCode,
      sentUserAgent: headers['user-agent'],
      target: target.toString(),
      body: text.slice(0, 1200),
    };
  }
}

const handlers = {
  // AiCode 原生接管：宿主发往供应商的 POST 请求在发出前改写为目标上游 + 档位指纹。
  // 已开启 nativeMode 时 baseUrl 保持原样即可，不需要把供应商地址改成反代。
  'hooks.httpBefore': async (payload) => {
    await configLoad();
    const out = applyNativeSpoof(payload);
    if (!out) return {};
    const rec = {
      method: payload.method || 'POST',
      url: payload.url,
      ts: new Date().toISOString(),
      via: 'hook',
      target: out.url,
      profile: config.profile,
      userAgent: out.headers['user-agent'],
      stream: typeof out.body === 'string' && out.body.indexOf('"stream":true') >= 0,
    };
    stats.requests++;
    pushRecent(rec);
    return out;
  },
  'hooks.boot': async () => {
    try {
      await configLoad();
      syncProviderCredential().catch(() => {});
      if (!config.upstream) {
        return { ok: false, note: 'upstream not configured' };
      }
      if (config.nativeMode) {
        return { ok: true, note: 'native hook mode: 不启动本地反代，供应商 baseUrl 保持原样', port: null };
      }
      const r = await startServer(config.port);
      warmupConnections(8).catch(() => {});
      return { ok: true, note: r.already ? 'already running' : 'proxy started', port: r.port };
    } catch (e) {
      return { ok: false, note: String((e && e.message) || e) };
    }
  },
  'tools.start': async (args) => {
    await configLoad();
    if (args.profile && PROFILES[args.profile]) config.profile = args.profile;
    if (args.port !== undefined && args.port !== null && args.port !== '') {
      const p = Number(args.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('port must be an integer between 1 and 65535');
      config.port = p;
    }
    const r = await startServer(config.port);
    await cfgSave();
    warmupConnections(8).catch(() => {});
    syncProviderCredential().catch(() => {});
    return { ok: true, port: r.port, localBaseUrl: `http://${displayHost()}:${r.port}/v1`, profile: config.profile, already: r.already, note: providerNote() };
  },
  'tools.stop': async () => {
    const r = await stopServer();
    return { ok: true, ...r };
  },
  'tools.status': async () => {
    await configLoad();
    return {
      running: !!server,
      port: listeningPort,
      localBaseUrl: listeningPort ? `http://${displayHost()}:${listeningPort}/v1` : null,
      note: providerNote(),
      credential: providerCredential(),
      profile: config.profile,
      upstream: config.upstream || null,
      nativeMode: !!config.nativeMode,
      providerSync,
      stats: Object.assign({}, stats, { recent: stats.recent.slice(0, 10) }),
      config: publicConfig(),
    };
  },
  'tools.config': async (args) => {
    await configLoad();
    const keys = ['upstream', 'token', 'tokenMode', 'profile', 'port', 'stripStainless', 'rewriteBody', 'extraHeaders', 'proxy', 'autoStart', 'host', 'authEnabled', 'authMode', 'authToken', 'authUser', 'authPass', 'authHeader', 'providerApiKey', 'nativeMode', 'nativeHosts'];
    const boolKeys = ['stripStainless', 'rewriteBody', 'autoStart', 'authEnabled', 'nativeMode'];
    const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true';
    const toHosts = (v) => {
      let arr = v;
      if (typeof arr === 'string') arr = arr.split(/[\s,]+/);
      if (!Array.isArray(arr)) return [];
      return arr.map((s) => String(s).trim()).filter(Boolean);
    };
    const requestedPort = ('port' in args && args.port !== undefined && args.port !== null)
      ? Number(args.port) : config.port;
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      throw new Error('port must be an integer between 1 and 65535');
    }
    let restart = requestedPort !== config.port;
    for (const k of keys) {
      if (!(k in args) || args[k] === undefined || args[k] === null) continue;
      if (k === 'port') { config.port = requestedPort; continue; }
      if (k === 'nativeHosts') { config.nativeHosts = toHosts(args[k]); continue; }
      if (k === 'host' && args[k] !== config.host) restart = true;
      if (boolKeys.indexOf(k) >= 0) config[k] = toBool(args[k]);
      else config[k] = args[k];
    }
    // 页面回写时 token 是脱敏值，不能覆盖真实 token
    if (config.token && config.token.indexOf('****') > 0) {
      config.token = savedToken;
    } else if (config.token) {
      savedToken = config.token;
    }
    if (config.authToken && config.authToken.indexOf('****') > 0) {
      config.authToken = savedAuthToken;
    } else if (config.authToken) {
      savedAuthToken = config.authToken;
    }
    if (config.authPass === '****') config.authPass = savedAuthPass;
    else if (config.authPass) savedAuthPass = config.authPass;
    await cfgSave();
    syncProviderCredential().catch(() => {});
    if (restart && server) {
      await stopServer();
      await startServer(config.port);
    }
    return { ok: true, running: !!server, port: listeningPort, nativeMode: !!config.nativeMode, providerSync, localBaseUrl: listeningPort ? `http://${displayHost()}:${listeningPort}/v1` : null, credential: providerCredential(), config: publicConfig() };
  },
  'ui.getState': async () => {
    await configLoad();
    return {
      running: !!server,
      port: listeningPort,
      localBaseUrl: listeningPort ? `http://${displayHost()}:${listeningPort}/v1` : null,
      note: providerNote(),
      credential: providerCredential(),
      stats: Object.assign({}, stats, { recent: stats.recent.slice(0, 20) }),
      config: publicConfig(),
      nativeMode: !!config.nativeMode,
      providerSync,
      profiles: Object.keys(PROFILES).map((k) => ({ id: k, label: PROFILES[k].label, userAgent: PROFILES[k].userAgent })),
    };
  },
  'ui.saveConfig': async (args) => handlers['tools.config'](args || {}),
  'ui.start': async (args) => handlers['tools.start'](args || {}),
  'ui.stop': async () => handlers['tools.stop'](),
  'ui.test': async (args) => {
    await configLoad();
    return testUpstream(args && args.model);
  },
  'ui.clearStats': async () => {
    stats.requests = 0;
    stats.forwarded = 0;
    stats.clientErrors = 0;
    stats.upstreamErrors = 0;
    stats.recent.length = 0;
    stats.lastError = null;
    return { ok: true };
  },
};

const CALL_METHODS = ['tool.invoke', 'hook.invoke', 'ui.invoke'];

function handleHostRequest(id, method, params) {
  params = params || {};
  if (CALL_METHODS.indexOf(method) < 0) {
    return send({ jsonrpc: '2.0', id, error: { code: 'METHOD_UNKNOWN', message: method } });
  }
  const fn = handlers[params.handler];
  if (typeof fn !== 'function') {
    return send({ jsonrpc: '2.0', id, error: { code: 'HANDLER_NOT_FOUND', message: params.handler } });
  }
  Promise.resolve()
    .then(() => fn(params.args || {}))
    .then((result) => send({ jsonrpc: '2.0', id, result: result === undefined ? null : result }))
    .catch((e) => send({
      jsonrpc: '2.0', id,
      error: { code: 'PLUGIN_ERROR', message: String((e && e.message) || e) },
    }));
}

process.on('uncaughtException', (e) => {
  try {
    send({ jsonrpc: '2.0', id: 'crash-' + Date.now(), error: { code: 'PLUGIN_UNCAUGHT', message: String((e && e.stack) || e) } });
  } catch (x) {}
});
process.on('unhandledRejection', (reason) => {
  try {
    send({ jsonrpc: '2.0', id: 'reject-' + Date.now(), error: { code: 'PLUGIN_UNHANDLED', message: String((reason && reason.message) || reason) } });
  } catch (x) {}
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  try {
    if (msg.method && msg.id !== undefined) handleHostRequest(msg.id, msg.method, msg.params || {});
    else if (msg.id !== undefined && !msg.method) handleHostResponse(msg.id, msg);
  } catch (e) { /* 单条消息异常不影响后续 */ }
});
rl.on('close', () => {
  Promise.resolve()
    .then(() => stopServer())
    .catch(() => {})
    .then(() => process.exit(0));
});

configLoad().then(async () => {
  if (config.autoStart && config.upstream) {
    startServer(config.port).catch(() => {});
  }
});