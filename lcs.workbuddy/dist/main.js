'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const store = require('./store');
const wb = require('./wb');
const { parseCredentials, parseCredentialList, toExpiresMs } = require('./cred');

function errorText(error) {
  return String((error && error.message) || error);
}

function requireAccount(state) {
  if (!state.account || !state.account.accessToken) {
    const error = new wb.WorkBuddyError('还没有 WorkBuddy 账户：用 auth 设备码登录，或用 import 粘贴凭证');
    error.needsLogin = true;
    throw error;
  }
  return state.account;
}

function accountBrief(account) {
  if (!account) return null;
  return {
    uid: account.uid || '',
    nickname: account.nickname || '',
    region: account.region || '',
    domain: account.domain || '',
    expiresAt: account.expiresAt || 0,
    expiresInSeconds: account.expiresAt ? Math.round((account.expiresAt - Date.now()) / 1000) : null,
    hasRefreshToken: Boolean(account.refreshToken),
    accessTokenMasked: store.maskToken(account.accessToken)
  };
}

function quotaBrief(quota) {
  if (!quota) return null;
  return {
    remaining: quota.remaining,
    total: quota.total,
    expireAt: quota.expireAt || null,
    packages: (quota.packages || []).map((item) => ({
      name: item.name || '',
      remaining: item.remaining,
      total: item.total,
      expireAt: item.expireAt || null
    }))
  };
}

async function statusHandler(args) {
  const input = args || {};
  const state = store.load();
  const region = store.regionOf(state);
  const result = {
    loggedIn: Boolean(state.account && state.account.accessToken),
    region: { code: region.code, displayName: region.displayName, apiBase: region.apiBase },
    account: accountBrief(state.account),
    quota: quotaBrief(state.quota),
    authPending: Boolean(state.authSession && state.authSession.state),
    stateFile: store.stateFile(),
    errors: []
  };
  if (!result.loggedIn) {
    result.hint = '还没有账户：用 auth 设备码登录，或用 import 粘贴 access_token。';
    return result;
  }
  if (input.refresh === false) return result;
  const account = state.account;
  const expiring = account.expiresAt && account.expiresAt - Date.now() < 120000;
  if (expiring && account.refreshToken) {
    try {
      const next = await wb.refreshToken(region, account);
      store.patch({ account: next });
      result.account = accountBrief(next);
      result.refreshed = true;
    } catch (error) {
      result.errors.push(`刷新令牌失败：${errorText(error)}`);
    }
  }
  if (input.quota !== false) {
    try {
      const current = store.load();
      const quota = await wb.refreshQuota(store.regionOf(current), current.account);
      store.patch({ quota });
      result.quota = quotaBrief(quota);
    } catch (error) {
      result.errors.push(`额度查询失败：${errorText(error)}`);
    }
  }
  return result;
}

async function authHandler(args) {
  const input = args || {};
  const op = String(input.op || 'start').toLowerCase();
  const state = store.load();
  if (op === 'start') {
    const region = input.region ? store.resolveRegion(input.region) : store.regionOf(state);
    const session = await wb.requestAuthState(region);
    store.patch({ authSession: Object.assign({ createdAt: Date.now() }, session) });
    return {
      op: 'start',
      state: session.state,
      authUrl: session.authUrl,
      region: { code: region.code, displayName: region.displayName },
      hint: '在浏览器打开 authUrl 完成登录，然后反复调用 op=poll 直到返回账户。'
    };
  }
  if (op === 'poll') {
    const session = state.authSession;
    if (!session || !session.state) {
      throw new wb.WorkBuddyError('没有进行中的登录：先调用 op=start 取授权地址');
    }
    const region = store.resolveRegion(session.region || state.settings.region);
    const polled = await wb.pollAuthToken(region, session.state);
    if (polled.pending) {
      return { op: 'poll', pending: true, state: session.state, region: region.code, hint: '还没完成登录，稍后再试。' };
    }
    store.patch({ account: polled.account, authSession: null });
    await syncAccountToPool(polled.account);
    return { op: 'poll', pending: false, account: accountBrief(polled.account), quota: null };
  }
  if (op === 'cancel') {
    store.patch({ authSession: null });
    return { op: 'cancel', cancelled: true };
  }
  throw new wb.WorkBuddyError(`不支持的 op：${op}（可用 start / poll / cancel）`);
}

async function importHandler(args) {
  const parsed = parseCredentials(args);
  if (!parsed.accessToken) {
    throw new wb.WorkBuddyError('没有解析到 access_token：粘贴 App 的 WorkBuddy 凭证 JSON，或直接给出 accessToken');
  }
  const region = store.resolveRegion(parsed.region || parsed.domain || store.load().settings.region);
  const account = {
    uid: parsed.uid,
    nickname: parsed.nickname,
    region: region.code,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt || 0,
    domain: parsed.domain || region.domain,
    creditsRemaining: 0,
    creditsTotal: 0,
    creditsExpireAt: 0,
    lastCheckInDate: ''
  };
  store.patch({ account, settings: { region: region.code }, authSession: null });
  const poolSync = await syncAccountToPool(account);
  const result = {
    imported: true,
    region: { code: region.code, displayName: region.displayName },
    account: accountBrief(account),
    warnings: []
  };
  try {
    const quota = await wb.refreshQuota(region, account);
    store.patch({ quota });
    result.quota = quotaBrief(quota);
  } catch (error) {
    result.warnings.push(`额度查询失败：${errorText(error)}`);
  }
  if (poolSync) result.gatewayAccounts = poolSync.imported;
  if (!account.refreshToken) result.warnings.push('没有 refresh_token，令牌过期后需要重新导入');
  if (!account.expiresAt) result.warnings.push('凭证里没有到期时间，无法提前刷新');
  return result;
}

async function refreshHandler() {
  const state = store.load();
  const account = requireAccount(state);
  const region = store.regionOf(state);
  const next = await wb.refreshToken(region, account);
  store.patch({ account: next });
  return { refreshed: true, account: accountBrief(next) };
}

async function quotaHandler(args) {
  const input = args || {};
  if (String(input.scope || 'account') === 'pool') {
    const routePath = input.refresh === false ? 'quota' : 'quota?refresh=1';
    const opts = { timeout: 90000 };
    let payload;
    try {
      payload = await callGateway(routePath, opts);
    } catch (error) {
      if (serviceState.running) throw error;
      await startService().catch(() => null);
      payload = await callGateway(routePath, opts);
    }
    const list = Array.isArray(payload.accounts) ? payload.accounts : [];
    if (!list.length) {
      throw new wb.WorkBuddyError('账号池里没有启用的账号，先导入或启用账号');
    }
    return {
      scope: 'pool',
      remaining: Number(payload.remaining || 0),
      total: Number(payload.total || 0),
      counted: Number(payload.counted || 0),
      failed: Number(payload.failed || 0),
      updatedAt: payload.updatedAt || 0,
      accounts: payload.accounts || []
    };
  }
  const state = store.load();
  const account = requireAccount(state);
  const region = store.regionOf(state);
  if (Number(input.days) > 0 && account.expiresAt && account.expiresAt - Date.now() < input.days * 86400000 && account.refreshToken) {
    const next = await wb.refreshToken(region, account);
    store.patch({ account: next });
  }
  const current = store.load();
  const quota = await wb.refreshQuota(store.regionOf(current), current.account);
  store.patch({ quota });
  return { region: store.regionOf(current).code, quota: quotaBrief(quota) };
}

async function checkinHandler() {
  const state = store.load();
  const account = requireAccount(state);
  const region = store.regionOf(state);
  const result = await wb.checkIn(region, account);
  const patch = {};
  if (result.quota) patch.quota = result.quota;
  if (result.supported && result.ok) {
    patch.account = Object.assign({}, account, { lastCheckInDate: store.gmt8DayOffset(0) });
  }
  if (Object.keys(patch).length) store.patch(patch);
  return {
    region: region.code,
    ok: result.ok,
    already: result.already,
    supported: result.supported,
    message: result.message,
    quota: quotaBrief(result.quota)
  };
}

async function tasksHandler() {
  const state = store.load();
  const account = requireAccount(state);
  const region = store.regionOf(state);
  const tasks = await wb.fetchTasks(region, account);
  return {
    region: region.code,
    count: tasks.length,
    tasks,
    claimable: tasks.filter((task) => !task.locked && task.status !== 'claimed' && task.status !== 'done').map((task) => task.code)
  };
}

async function acceptHandler(args) {
  const input = args || {};
  const codes = (Array.isArray(input.codes) ? input.codes : [input.code])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (!codes.length) throw new wb.WorkBuddyError('没有给出要接受的任务 code');
  const state = store.load();
  const account = requireAccount(state);
  const region = store.regionOf(state);
  const data = await wb.acceptTasks(region, account, codes);
  return { region: region.code, codes, result: data === undefined ? null : data };
}

async function claimHandler(args) {
  const input = args || {};
  const code = String(input.code || '').trim();
  if (!code) throw new wb.WorkBuddyError('没有给出要领取的任务 code');
  const state = store.load();
  const account = requireAccount(state);
  const region = store.regionOf(state);
  const result = await wb.claimTask(region, account, code);
  if (result.credit || result.energy) {
    const quota = await wb.refreshQuota(region, account).catch(() => null);
    if (quota) store.patch({ quota });
    return { region: region.code, code, credit: result.credit, energy: result.energy, already: result.already, message: result.message, quota: quotaBrief(quota) };
  }
  return { region: region.code, code, credit: result.credit, energy: result.energy, already: result.already, message: result.message };
}

async function gatewayActiveRegion() {
  const health = await activeHealth();
  if (health) {
    try {
      const status = await callGateway('status', { port: health.port, timeout: 5000 });
      const code = String((status && status.activeRegion) || '');
      return store.REGIONS[code] ? code : '';
    } catch {
      /* 网关不可达时退回本地设置 */
    }
  }
  const settings = readGatewaySettings();
  const wanted = String(settings.activeRegion || '');
  return store.REGIONS[wanted] ? wanted : '';
}

async function gatewayAccountRegions() {
  const health = await activeHealth();
  if (health) {
    try {
      const status = await callGateway('status', { port: health.port, timeout: 5000 });
      const regions = Array.isArray(status && status.regions) ? status.regions : [];
      const valid = regions.filter((code) => store.REGIONS[code]);
      if (valid.length) return valid;
    } catch {
      /* 网关不可达时退回读 accounts.json */
    }
  }
  const file = path.join(gatewayDataDir(), 'accounts.json');
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    return [];
  }
  const regions = new Set();
  for (const item of list) {
    if (item && item.enabled && item.accessToken && store.REGIONS[item.region]) regions.add(item.region);
  }
  return [...regions];
}

function annotateModels(list, settings, regions) {
  const available = Array.isArray(regions) && regions.length ? regions : null;
  const out = [];
  for (const item of list) {
    const declared = store.modelRegions(item.id, settings);
    if (!declared.length) continue;
    out.push({
      id: item.id,
      name: item.name || item.id,
      region: declared.length > 1 ? 'both' : declared[0],
      regionLabel: store.modelRegionLabel(declared),
      regions: declared,
      effectiveRegions: available ? declared.filter((region) => available.includes(region)) : declared
    });
  }
  return out;
}

async function modelsHandler() {
  const state = store.load();
  const region = store.regionOf(state);
  const poolRegions = await gatewayAccountRegions();
  const activeRegion = await gatewayActiveRegion();
  const activeRegionLabel = activeRegion ? store.regionLabel([activeRegion]) : '';

  const health = await activeHealth();
  if (health && poolRegions.length) {
    try {
      const payload = await callGateway('models', { port: health.port, timeout: 8000 });
      const list = Array.isArray(payload && payload.data) ? payload.data : [];
      const models = list.map((item) => ({
        id: item.id,
        name: item.name || item.id,
        region: item.region,
        regionLabel: item.region_label,
        regions: item.regions,
        effectiveRegions: item.effective_regions
      }));
      return {
        region: region.code,
        source: 'gateway',
        count: models.length,
        models,
        poolRegions,
        activeRegion,
        activeRegionLabel
      };
    } catch {
      /* 网关目录不可用时回退到直连上游 */
    }
  }

  if (!state.account || !state.account.accessToken) {
    const models = annotateModels(store.builtinModels(), state.settings, poolRegions);
    return {
      region: region.code,
      source: 'snapshot',
      count: models.length,
      models,
      poolRegions,
      activeRegion,
      activeRegionLabel,
      hint: '未登录，只返回内置快照模型表。'
    };
  }
  const result = await wb.fetchModels(region, state.account);
  const models = annotateModels(result.models, state.settings, poolRegions);
  return {
    region: region.code,
    source: result.source,
    count: models.length,
    models,
    poolRegions,
    activeRegion,
    activeRegionLabel,
    warnings: result.errors && result.errors.length ? result.errors : undefined
  };
}

function localGatewayKey() {
  const settings = readGatewaySettings();
  if (!settings || !settings.apiKey) return null;
  const port = Number(settings.port) || Number(settings.requestedPort) || DEFAULT_GATEWAY_PORT;
  return { apiKey: settings.apiKey, port };
}

async function buildConfig(state) {
  const region = store.regionOf(state);
  const account = state.account;
  const chatBase = `${region.apiBase}/v2`;
  const headers = [
    { name: 'X-Domain', value: account && account.domain ? account.domain : region.domain },
    { name: 'X-Product', value: 'SaaS' },
    { name: 'X-Requested-With', value: 'XMLHttpRequest' },
    { name: 'Accept-Language', value: region.acceptLanguage }
  ];
  if (account && account.uid) headers.push({ name: 'X-User-Id', value: account.uid });
  const models = store.builtinModels().map((item) => item.id);
  const poolRegions = await gatewayAccountRegions();
  const curlModel = store.catalog.defaultModel(poolRegions);
  const gateway = localGatewayKey();
  const gatewayBase = gateway ? `http://127.0.0.1:${gateway.port}/v1` : '';
  const curl = gateway
    ? [
      `curl ${gatewayBase}/chat/completions \\`,
      `  -H "Authorization: Bearer ${gateway.apiKey}" \\`,
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"model":"' + curlModel + '","stream":false,"messages":[{"role":"user","content":"ping"}]}\''
    ].join('\n')
    : [
      `curl ${chatBase}/chat/completions \\`,
      '  -H "Authorization: Bearer $WB_ACCESS_TOKEN" \\',
      ...headers.map((header) => `  -H "${header.name}: ${header.value}" \\`),
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"model":"' + curlModel + '","stream":false,"messages":[{"role":"user","content":"ping"}]}\''
    ].join('\n');
  const provider = gateway
    ? {
      name: 'WorkBuddy Gateway',
      type: 'openai',
      baseUrl: gatewayBase,
      fullEndpoint: `${gatewayBase}/chat/completions`,
      apiKey: gateway.apiKey,
      apiKeyMasked: store.maskToken(gateway.apiKey),
      customHeaders: [],
      models
    }
    : {
      name: 'WorkBuddy',
      type: 'openai',
      baseUrl: chatBase,
      fullEndpoint: `${chatBase}/chat/completions`,
      apiKey: account ? account.accessToken : '',
      apiKeyMasked: account ? store.maskToken(account.accessToken) : '',
      customHeaders: headers,
      models
    };
  return {
    provider,
    gateway: { enabled: Boolean(gateway), baseUrl: gatewayBase, port: gateway ? gateway.port : 0 },
    upstream: { baseUrl: chatBase, customHeaders: headers, accountDomain: account ? account.domain : '' },
    region: { code: region.code, displayName: region.displayName, apiBase: region.apiBase },
    modelCatalog: annotateModels(store.builtinModels(), state.settings, poolRegions),
    curl,
    notes: gateway
      ? [
        'baseUrl 走本机网关，填到 /v1 为止，OpenAI 兼容客户端会自动拼 /chat/completions。',
        'apiKey 是网关密钥，不是 access_token；账号池与上游请求头都由网关注入。',
        '网关端口若因冲突回退，这里的 baseUrl 会跟着变，改完端口重启插件即可刷新。'
      ]
      : [
        'baseUrl 填到 /v2 为止，OpenAI 兼容客户端会自动拼 /chat/completions。',
        'apiKey 用 access_token；X-User-Id、X-Domain、X-Product 三个头必须带上。',
        '启动本地网关后这里会切换成网关地址，无需再手工填上游请求头。'
      ]
  };
}

async function configHandler(args) {
  const input = args || {};
  const state = store.load();
  if (input.region) state.settings = Object.assign(state.settings, { region: store.resolveRegion(input.region).code });
  const config = await buildConfig(state);
  if (input.write === true) {
    fs.mkdirSync(store.stateDir(), { recursive: true });
    fs.writeFileSync(store.exportFile(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    config.writtenTo = store.exportFile();
  }
  return config;
}

function logoutHandler() {
  store.patch({ account: null, quota: null, authSession: null });
  return { loggedIn: false };
}

function pathsHandler() {
  return {
    dir: store.stateDir(),
    state: store.stateFile(),
    export: store.exportFile(),
    exists: {
      state: fs.existsSync(store.stateFile()),
      export: fs.existsSync(store.exportFile())
    }
  };
}

function configGetHandler() {
  const state = store.load();
  return {
    region: state.settings.region,
    regions: Object.keys(store.REGIONS).map((key) => ({
      code: store.REGIONS[key].code,
      displayName: store.REGIONS[key].displayName,
      apiBase: store.REGIONS[key].apiBase
    })),
    loggedIn: Boolean(state.account && state.account.accessToken),
    paths: pathsHandler(),
    stateFile: store.stateFile()
  };
}

function configSaveHandler(args) {
  const input = args || {};
  const patch = {};
  if (input.region) {
    const region = store.resolveRegion(input.region);
    patch.settings = { region: region.code };
  }
  return { settings: store.patch(patch).settings };
}

const SERVICE_NAME = 'workbuddy-gateway';
const DEFAULT_GATEWAY_PORT = 18913;
const GATEWAY_ENTRY = path.join(__dirname, 'gateway.mjs');

let serviceState = { mode: null, port: 0, child: null, lastError: '' };

function gatewayDataDir() {
  if (process.env.WORKBUDDY_GATEWAY_HOME) return process.env.WORKBUDDY_GATEWAY_HOME;
  const root = process.env.AICODE_DATA_DIR || path.join(process.env.HOME || os.homedir(), '.aicode-plugin-data');
  return path.join(root, 'workbuddy-gateway');
}

function gatewaySettingsFile() {
  return path.join(gatewayDataDir(), 'settings.json');
}

function readGatewaySettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(gatewaySettingsFile(), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // 还没初始化
  }
  return {};
}

function gatewayPort() {
  const settings = readGatewaySettings();
  // requestedPort 是本插件认定的起始端口；port 会被网关改写成实际监听端口
  return Number(settings.requestedPort) || Number(settings.port) || DEFAULT_GATEWAY_PORT;
}

async function probeHealth(port) {
  const candidate = Number(port) || gatewayPort();
  try {
    const res = await fetch(`http://127.0.0.1:${candidate}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.service === SERVICE_NAME) return data;
  } catch {
    // 未启动
  }
  return null;
}

const PORT_SCAN = 64;

let expectedBuildCache = '';

// 从网关模块拿当前构建标识，避免两处硬编码走偏
async function expectedBuild() {
  if (expectedBuildCache) return expectedBuildCache;
  try {
    const mod = await import(pathToFileURL(GATEWAY_ENTRY).href);
    expectedBuildCache = String((mod && mod.BUILD) || '');
  } catch {
    expectedBuildCache = '';
  }
  return expectedBuildCache;
}

function gatewayPids() {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let cmd = '';
    try {
      // cmdline 是 NUL 分隔的，直接当字符串用会匹配不到参数之间的分隔
      cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\u0000').join(' ');
    } catch {
      continue;
    }
    if (!cmd.includes('gateway.mjs')) continue;
    if (!cmd.includes(gatewayDataDir())) continue;
    out.push({ pid, cmd });
  }
  return out;
}

// 旧版插件起的子进程不随插件卸载退场，会一直占着端口并持有旧 adminKey。
// 同数据目录、非同代或认证不过的实例一律收掉，再交给 startService 重建。
async function reapStaleGateways() {
  const build = await expectedBuild();
  const removed = [];
  for (const item of gatewayPids()) {
    const match = /--port\s+(\d+)/.exec(item.cmd);
    const base = match ? Number(match[1]) : 0;
    if (!base) continue;
    let found = null;
    for (let index = 0; index < PORT_SCAN; index += 1) {
      const health = await probeHealth(base + index);
      if (health && health.pid === item.pid) {
        found = health;
        break;
      }
    }
    if (!found) continue;
    const sameBuild = !build || found.build === build;
    if (sameBuild && (await adminReachable(found.port))) continue;
    try {
      process.kill(item.pid, 'SIGTERM');
    } catch {
      continue;
    }
    removed.push({ pid: item.pid, port: found.port });
    for (let wait = 0; wait < 8; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        process.kill(item.pid, 0);
      } catch {
        break;
      }
    }
    try {
      process.kill(item.pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
  return removed;
}

// 旧版把网关跑在插件进程内，cmdline 里没有 --data-dir，gatewayPids() 收不到它，
// 于是它长期占着起始端口，新网关被挤到后面的端口，而 provider 的 baseUrl 是固定的
// 起始端口，客户端就一直打在旧实例上。这里按 /health 报的 pid 兜底收掉。
// 同代实例也要收：装包后宿主不重启插件时，旧同代进程会一直占着端口。
async function reapPortOccupants() {
  const settings = readGatewaySettings();
  const base = Number(settings.requestedPort) || Number(settings.port) || DEFAULT_GATEWAY_PORT;
  const removed = [];
  const ports = Array.from({ length: PORT_SCAN }, (_, index) => base + index);
  const healths = await Promise.all(ports.map((port) => probeHealth(port)));
  for (let index = 0; index < ports.length; index += 1) {
    const health = healths[index];
    if (!health) continue;
    const port = ports[index];
    const pid = Number(health.pid) || 0;
    if (!pid) continue;
    // 嵌入式网关跑在本进程内，健康检查报的就是自己的 pid
    if (pid === process.pid || pid === process.ppid) continue;
    let managed = false;
    try {
      managed = await adminReachable(port);
    } catch {
      managed = false;
    }
    if (!managed) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      continue;
    }
    for (let wait = 0; wait < 10; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
    removed.push({ pid, port, build: health.build });
  }
  return removed;
}

// 网关自身会在 requested 起往后扫端口，旧实例可能正占着起始端口，
// 所以只能按区间找带本插件接口的实例，不能认第一个应答 /health 的
async function scanManaged(basePort, timeoutMs) {
  const base = Number(basePort) || gatewayPort();
  const deadline = Date.now() + (timeoutMs || 0);
  for (;;) {
    const ports = Array.from({ length: PORT_SCAN }, (_, index) => base + index);
    const healths = await Promise.all(ports.map((port) => probeHealth(port)));
    const build = await expectedBuild();
    for (let index = 0; index < ports.length; index += 1) {
      const health = healths[index];
      if (!health) continue;
      // 只认与当前代码同代的实例：旧进程会占着端口但行为不一致
      if (build && health.build !== build) continue;
      if (await adminReachable(ports[index])) return health;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function waitGone(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (!(await activeHealth())) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const REQUIRED_FEATURES = ['quota', 'region', 'models'];

// 旧版网关也能应答 /health 与 status，只有 features 对齐才能当成本插件的实例复用
async function adminReachable(port) {
  if (!readGatewaySettings().adminKey) return false;
  try {
    const status = await callGateway('status', { port, timeout: 3000 });
    const features = Array.isArray(status && status.features) ? status.features : [];
    return REQUIRED_FEATURES.every((item) => features.includes(item));
  } catch {
    return false;
  }
}

// 业务调用默认端口必须是扫描到的实际实例端口：18913 可能被旧版实例占着，
// 本插件实例会落到 18914 之后的端口，用起始端口会打到旧实例并拿到 401
async function managementPort() {
  const cached = Number(serviceState.port) || 0;
  if (cached && (await adminReachable(cached))) return cached;
  const health = await activeHealth();
  if (health) {
    if (!serviceState.child && serviceState.mode !== 'embedded') serviceState.mode = 'external';
    serviceState.port = health.port;
    return health.port;
  }
  return gatewayPort();
}

async function callGateway(routePath, options) {
  const opts = options || {};
  const settings = readGatewaySettings();
  if (!settings.adminKey) {
    throw new wb.WorkBuddyError('网关还没初始化：先启动网关');
  }
  const port = Number(opts.port) || (await managementPort());
  const res = await fetch(`http://127.0.0.1:${port}/admin/api/${routePath}`, {
    method: opts.method || 'GET',
    headers: { 'x-admin-key': settings.adminKey, 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeout || 120000)
  });
  const raw = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }
  if (!res.ok) {
    throw new wb.WorkBuddyError((payload && payload.error) || `网关 HTTP ${res.status}`, res.status);
  }
  return payload;
}

async function startService() {
  const requested = (() => {
    const settings = readGatewaySettings();
    return Number(settings.requestedPort) || Number(settings.port) || DEFAULT_GATEWAY_PORT;
  })();

  // 先收掉同数据目录的旧代实例，否则它们会一直占着端口并让调用拿到 401
  serviceState.reaped = await reapStaleGateways().catch(() => []);
  const occupants = await reapPortOccupants().catch(() => []);
  serviceState.reaped = serviceState.reaped.concat(occupants);

  const managed = await scanManaged(requested);
  if (managed) {
    if (!serviceState.child && serviceState.mode !== 'embedded') serviceState.mode = 'external';
    serviceState.port = managed.port;
    return { mode: serviceState.mode, port: managed.port, reused: true };
  }
  if (await probeHealth(requested)) {
    serviceState.lastError = `端口 ${requested} 已被另一个不属于本插件的网关占用，已在端口 ${requested + 1} 之后启动新实例`;
  }

  try {
    const mod = await import(pathToFileURL(GATEWAY_ENTRY).href);
    const payload = await mod.startGateway({ port: requested, dataDir: gatewayDataDir() });
    serviceState = { mode: 'embedded', port: payload.port, child: null, lastError: '', reaped: serviceState.reaped };
    return { mode: 'embedded', port: payload.port, reused: false };
  } catch (error) {
    serviceState.lastError = errorText(error);
  }

  const child = spawn(
    process.execPath,
    [GATEWAY_ENTRY, '--port', String(requested), '--data-dir', gatewayDataDir()],
    { stdio: 'ignore' }
  );
  child.on('error', (error) => {
    serviceState.lastError = errorText(error);
  });
  serviceState.child = child;

  const ready = await scanManaged(requested, 15000);
  if (!ready) {
    throw new wb.WorkBuddyError(`网关启动失败：${serviceState.lastError || '等待就绪超时'}`);
  }
  serviceState.mode = 'spawn';
  serviceState.port = ready.port;
  return { mode: 'spawn', port: ready.port, reused: false };
}

// 起始端口可能被旧实例占着，本插件的实例往往在区间内更靠后的端口
async function activeHealth() {
  const settings = readGatewaySettings();
  const base = Number(settings.requestedPort) || Number(settings.port) || DEFAULT_GATEWAY_PORT;
  return scanManaged(base);
}

async function stopService() {
  if (!serviceState.child && serviceState.mode !== 'embedded') {
    const health = await activeHealth();
    if (health) {
      serviceState.mode = 'external';
      serviceState.port = health.port;
      return { stopped: false, external: true, running: true };
    }
  }
  if (serviceState.mode === 'external') {
    return { stopped: false, external: true, running: false };
  }
  if (serviceState.child) {
    try {
      serviceState.child.kill('SIGTERM');
    } catch {
      // 进程可能已经退出
    }
    serviceState.child = null;
  }
  if (serviceState.mode === 'embedded') {
    try {
      const mod = await import(pathToFileURL(GATEWAY_ENTRY).href);
      await mod.stopGateway();
    } catch (error) {
      serviceState.lastError = errorText(error);
    }
  }
  const gone = await waitGone(5000);
  serviceState.mode = null;
  serviceState.port = 0;
  return { stopped: gone };
}

async function syncAccountToPool(account) {
  if (!account || !account.accessToken) return null;
  const health = await activeHealth();
  if (!health) return null;
  try {
    return await callGateway('accounts/import', {
      method: 'POST',
      port: health.port,
      body: { payload: account, region: account.region }
    });
  } catch {
    return null;
  }
}

async function gatewayHandler(args) {
  const input = args || {};
  const op = String(input.op || 'status').toLowerCase();

  if (op === 'start' || op === 'restart') {
    if (op === 'restart') await stopService();
    const started = await startService();
    const status = await callGateway('status', { port: started.port }).catch(() => null);
    return { op, started, status };
  }

  if (op === 'stop') {
    const stopped = await stopService();
    return { op, stopped };
  }

  if (op === 'accounts' || op === 'import' || op === 'enable' || op === 'delete' || op === 'refresh-account' || op === 'region') {
    let health = await activeHealth();
    if (!health) {
      if (op !== 'import' && op !== 'region') return { op, running: false, accounts: [] };
      await startService();
      health = await activeHealth();
      if (!health) throw new wb.WorkBuddyError(serviceState.lastError || '网关启动失败');
    }
    const port = health.port;
    if (op === 'accounts') {
      const payload = await callGateway('accounts', { port });
      return { op, running: true, port, accounts: payload.accounts || [] };
    }
    if (op === 'import') {
      const raw = input.payload !== undefined ? input.payload
        : input.text !== undefined ? input.text
          : input.token;
      if (!raw) throw new wb.WorkBuddyError('没有给出要导入的令牌或凭证 JSON');
      const payload = await callGateway('accounts/import', {
        method: 'POST',
        port,
        body: { payload: raw, region: input.region || '' }
      });
      const accountsPayload = await callGateway('accounts', { port });
      return {
        op, running: true, port,
        imported: payload.imported || 0,
        accounts: payload.accounts || [],
        pool: accountsPayload.accounts || []
      };
    }
    if (op === 'enable') {
      const payload = await callGateway('accounts/enable', {
        method: 'POST', port, body: { id: input.id, enabled: input.enabled !== false }
      });
      return { op, enabled: input.enabled !== false, account: payload.account };
    }
    if (op === 'delete') {
      const payload = await callGateway('accounts/delete', { method: 'POST', port, body: { id: input.id } });
      return { op, removed: payload.account || payload };
    }
    if (op === 'region') {
      const payload = await callGateway('region', { method: 'POST', port, body: { region: input.region || '' } });
      return { op, ...payload };
    }
    const payload = await callGateway('accounts/refresh', { method: 'POST', port, body: { id: input.id || '' } });
    return { op, results: payload.results || [] };
  }

  const basePort = gatewayPort();
  let notice = '';
  let health = await activeHealth();
  if (!health) {
    const stale = await probeHealth(basePort);
    if (stale) {
      const started = await startService().catch(() => null);
      if (started) {
        notice = `端口 ${stale.port} 已被另一个不属于本插件的网关占用，已在端口 ${started.port} 启动新实例`;
      }
      health = await activeHealth();
    }
  } else if (health.port !== basePort && (await probeHealth(basePort))) {
    notice = `端口 ${basePort} 已被另一个不属于本插件的网关占用，本插件实例在端口 ${health.port}`;
  }
  let status = null;
  let error = null;
  if (health) {
    try {
      status = await callGateway('status', { port: health.port });
    } catch (cause) {
      error = errorText(cause);
    }
  }
  const port = health ? health.port : gatewayPort();
  let mode = null;
  if (health) {
    if (serviceState.port !== health.port) {
      serviceState = { mode: 'external', port: health.port, child: null, lastError: serviceState.lastError };
    }
    mode = serviceState.mode;
  }
  return {
    op: 'status',
    running: Boolean(health),
    mode,
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    status,
    activeRegion: status ? status.activeRegion : '',
    activeRegionLabel: status ? status.activeRegionLabel : '',
    regionOptions: status ? status.regionOptions : [],
    notice,
    error
  };
}

async function bootHook() {
  const started = await startService();
  const status = await callGateway('status', { port: started.port }).catch(() => null);
  return {
    mode: started.mode,
    port: started.port,
    baseUrl: status ? status.baseUrl : `http://127.0.0.1:${started.port}/v1`,
    apiKey: status ? status.apiKey : '',
    accounts: status ? status.accountCount : 0
  };
}

const handlers = {
  'tools.status': statusHandler,
  'tools.auth': authHandler,
  'tools.import': importHandler,
  'tools.refresh': refreshHandler,
  'tools.quota': quotaHandler,
  'tools.checkin': checkinHandler,
  'tools.tasks': tasksHandler,
  'tools.accept': acceptHandler,
  'tools.claim': claimHandler,
  'tools.models': modelsHandler,
  'tools.config': configHandler,
  'tools.logout': logoutHandler,

  'ui.status': statusHandler,
  'ui.auth.start': (args) => authHandler(Object.assign({}, args, { op: 'start' })),
  'ui.auth.poll': (args) => authHandler(Object.assign({}, args, { op: 'poll' })),
  'ui.auth.cancel': (args) => authHandler(Object.assign({}, args, { op: 'cancel' })),
  'ui.import': importHandler,
  'ui.refresh': refreshHandler,
  'ui.quota': quotaHandler,
  'ui.checkin': checkinHandler,
  'ui.tasks': tasksHandler,
  'ui.accept': acceptHandler,
  'ui.claim': claimHandler,
  'ui.models': modelsHandler,
  'ui.config': configHandler,
  'ui.logout': logoutHandler,
  'ui.paths': pathsHandler,
  'ui.config.get': configGetHandler,
  'ui.config.save': configSaveHandler,
  'ui.gateway': gatewayHandler,
  'tools.gateway': gatewayHandler,
  'hooks.boot': bootHook
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
      error: {
        code: error && error.status ? `HTTP_${error.status}` : 'PLUGIN_ERROR',
        message: errorText(error),
        data: error && error.needsLogin ? { needsLogin: true } : undefined
      }
    }));
}

async function shutdown() {
  try {
    await stopService();
  } catch {
    // 退出路径上的清理失败不阻断退出
  }
  process.exit(0);
}

function main() {
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
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}

if (require.main === module) main();

module.exports = {
  handlers,
  parseCredentials,
  parseCredentialList,
  buildConfig,
  gatewayDataDir,
  probeHealth,
  reapStaleGateways,
  reapPortOccupants,
  accountBrief,
  quotaBrief
};