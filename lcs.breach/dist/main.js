'use strict';

const readline = require('readline');

const packs = require('./packs');
const store = require('./inject');

function errorText(error) {
  return String((error && error.message) || error);
}

function catalogHandler() {
  const snap = store.status();
  const config = store.readConfig();
  const data = packs.catalog();
  return {
    ok: true,
    ...data,
    injectedCount: snap.injectedCount,
    config,
    paths: snap.paths,
    message: `${packs.NAME} v${packs.VERSION}：${data.packs.length} 个包（${data.deployableCount} 个可部署，${data.unreleasedCount} 个未发布），${snap.injectedCount}/${snap.rows.length} 个目标已注入。`
  };
}

function showHandler(args) {
  const pack = packs.findPack((args || {}).pack);
  if (!pack) throw new Error(`破甲包无效：${(args || {}).pack}`);
  const meta = {
    id: pack.id,
    name: pack.name,
    models: pack.models || [],
    version: pack.version,
    status: pack.status,
    deployable: pack.deployable === true,
    eval: pack.eval || '',
    note: pack.note || ''
  };
  if (pack.deployable !== true) {
    return {
      ok: true,
      pack: meta,
      hasBody: false,
      body: '',
      message: `${pack.name} 是未发布条目，仓库内没有对应正文。公开读数：${pack.eval || '无'}`
    };
  }
  const body = packs.readPackBody(pack);
  if (body === null) throw new Error(`破甲包 ${pack.id} 的正文文件缺失`);
  const verify = packs.verify(pack);
  const head = Number((args || {}).head);
  const limited = Number.isFinite(head) && head > 0
    ? body.split('\n').slice(0, head).join('\n')
    : body;
  return {
    ok: true,
    pack: meta,
    hasBody: true,
    verify,
    bytes: verify.bytes,
    lines: verify.lines,
    body: limited,
    truncated: limited !== body,
    message: `${pack.name} ${pack.version}：${verify.lines} 行 / ${verify.bytes} 字节，sha256[16]=${verify.actual}${verify.ok ? '（与目录一致）' : '（与目录不一致）'}`
  };
}

function injectHandler(args) {
  return store.inject(args || {});
}

function statusHandler() {
  return store.status();
}

function removeHandler(args) {
  return store.remove(args || {});
}

function configGetHandler() {
  return {
    ok: true,
    config: store.readConfig(),
    context: store.context(),
    paths: { stateDir: store.stateDir(), state: store.stateFile(), config: store.configFile() }
  };
}

function configSaveHandler(args) {
  const config = store.saveConfig(args || {});
  return { ok: true, config, message: '设置已保存' };
}

function pathsHandler() {
  const ctx = store.context();
  return {
    ok: true,
    context: ctx,
    paths: { stateDir: store.stateDir(), state: store.stateFile(), config: store.configFile() },
    targets: store.TARGETS.map((target) => ({
      id: target.id,
      name: target.name,
      reach: target.reach,
      note: target.note,
      files: target.paths(ctx)
    }))
  };
}

const handlers = {
  'tools.packs': catalogHandler,
  'tools.show': showHandler,
  'tools.inject': injectHandler,
  'tools.status': statusHandler,
  'tools.remove': removeHandler,
  'ui.packs': catalogHandler,
  'ui.show': showHandler,
  'ui.inject': injectHandler,
  'ui.status': statusHandler,
  'ui.remove': removeHandler,
  'ui.config.get': configGetHandler,
  'ui.config.save': configSaveHandler,
  'ui.paths': pathsHandler
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
      error: { code: 'PLUGIN_ERROR', message: errorText(error) }
    }));
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
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

if (require.main === module) main();

module.exports = {
  handlers,
  catalogHandler,
  showHandler,
  injectHandler,
  statusHandler,
  removeHandler,
  configGetHandler,
  configSaveHandler,
  pathsHandler
};
