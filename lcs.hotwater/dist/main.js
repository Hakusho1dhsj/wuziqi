'use strict';

const readline = require('readline');

const persona = require('./persona');
const store = require('./inject');

function errorText(error) {
  return String((error && error.message) || error);
}

function catalogHandler() {
  const snap = store.status();
  const config = store.readConfig();
  return {
    ok: true,
    ...persona.catalog(),
    injectedCount: snap.injectedCount,
    config,
    paths: snap.paths,
    message: `${persona.NAME} v${persona.VERSION}：${persona.SEATS.length} 个席位，${persona.MODES.length} 个档位，${snap.injectedCount}/${snap.rows.length} 个目标已注入。`
  };
}

function buildHandler(args) {
  if (args.matrix === true || args.all === true) {
    const markdown = persona.buildSeatMatrix(args || {});
    return {
      ok: true,
      matrix: true,
      count: persona.SEATS.length,
      markdown,
      message: `已生成 ${persona.SEATS.length} 个席位的注入包（${persona.SEATS.map((s) => s.id).join(', ')}）。`
    };
  }
  const built = persona.buildPersona(args || {});
  return {
    ok: true,
    seat: built.seat,
    mode: built.mode,
    channel: built.channel,
    chains: built.chains,
    tone: built.tone,
    goal: built.goal,
    markdown: built.markdown,
    message: `${persona.NAME} ${built.seat.title} · ${built.mode.label} · 工作链 ${built.chains.map((c) => c.label).join(' -> ')}`
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
    targets: persona.TARGETS.map((target) => ({
      id: target.id,
      name: target.name,
      reach: target.reach,
      files: target.reach === 'preview' ? [] : target.paths(ctx)
    }))
  };
}

function cleanupHandler(args) {
  return store.cleanupBootstrap(args || {});
}

const handlers = {
  'tools.seats': catalogHandler,
  'tools.build': buildHandler,
  'tools.inject': injectHandler,
  'tools.status': statusHandler,
  'tools.remove': removeHandler,
  'ui.seats': catalogHandler,
  'ui.build': buildHandler,
  'ui.inject': injectHandler,
  'ui.status': statusHandler,
  'ui.remove': removeHandler,
  'ui.config.get': configGetHandler,
  'ui.config.save': configSaveHandler,
  'ui.paths': pathsHandler,
  'ui.cleanupBootstrap': cleanupHandler
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
  buildHandler,
  injectHandler,
  statusHandler,
  removeHandler,
  configGetHandler,
  configSaveHandler,
  pathsHandler,
  cleanupHandler
};
