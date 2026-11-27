'use strict';

const fs = require('fs');
const path = require('path');
const persona = require('../dist/persona');
const store = require('../dist/inject');

const OUT = process.env.PREVIEW_OUT || path.resolve(__dirname, '..', '.preview');
fs.mkdirSync(OUT, { recursive: true });

const catalog = persona.catalog();
const snap = store.status();
const config = store.readConfig();

const mockSeats = {
  ...catalog,
  injectedCount: 3,
  config,
  paths: snap.paths
};

const fakeStatus = {
  ok: true,
  version: persona.VERSION,
  injectedCount: 3,
  rows: persona.TARGETS.map((target, index) => ({
    id: target.id,
    name: target.name,
    kind: target.kind,
    reach: target.reach,
    note: target.note,
    injected: index < 3 && target.reach !== 'preview',
    files: target.reach === 'preview' ? [] : [],
    record: index < 3 ? { seat: 'codex', mode: 'max' } : null
  })).map((row) => ({ ...row, files: row.reach === 'preview' ? [] : [{ file: '/demo/' + row.id, exists: row.injected, injected: row.injected }] })),
  paths: snap.paths,
  message: '热开水 v1.0.0：3/9 个目标已注入。'
};

const mockJs = `
window.__calls = [];
window.__toasts = [];
window.aicode = {
  invoke: function (handler, args) {
    window.__calls.push({ handler: handler, args: args });
    var data = window.__mockData[handler];
    return Promise.resolve(data ? data(args) : { ok: true });
  },
  toast: function (text) { window.__toasts.push(text); },
  clipboard: { write: function (text) { window.__copied = text; return Promise.resolve(); } },
  openConfig: function () { window.__openedConfig = true; }
};
`;

const buildTable = {};
for (const seat of persona.SEATS) {
  for (const mode of persona.MODES) {
    buildTable[`${seat.id}|${mode.id}`] = persona.buildPersona({
      seat: seat.id,
      mode: mode.id,
      goal: '__GOAL__'
    }).markdown;
  }
}

const mockData = `
window.__buildTable = ${JSON.stringify(buildTable)};
window.__mockData = {
  'ui.seats': function () { return ${JSON.stringify(mockSeats)}; },
  'ui.status': function () { return ${JSON.stringify(fakeStatus)}; },
  'ui.build': function (args) {
    var seat = (args && args.seat) || 'master';
    var mode = (args && args.mode) || 'max';
    var md = (window.__buildTable[seat + '|' + mode] || '').split('用户目标：__GOAL__').join('用户目标：' + ((args && args.goal) || '请先输入明确目标'));
    return { ok: true, markdown: md, message: '热开水 ' + seat + ' · ' + mode.toUpperCase() + ' · ' + md.length + ' 字' };
  },
  'ui.inject': function () { return {
    ok: true, seat: 'codex', mode: 'max', dryRun: false,
    markdown: '（注入包略）', results: [
      { id: 'aicode', name: 'AiCode 自定义提示词', ok: true, files: [{ file: '~/workspace/demo/prompts.custom/05-hotwater.md', written: true, bytes: 2412 }], manualKey: '', message: '已写入 1 个文件' }
    ],
    message: '热开水 Codex / GPT-5.6 · MAX 已注入 1 个目标。'
  }; },
  'ui.config.get': function () { return { ok: true, config: ${JSON.stringify(config)}, context: { home: '/root', aicodeHome: '/root/.aicode', projectRoot: '/root/workspace', dshHome: '', customNumber: '05' }, paths: ${JSON.stringify(snap.paths)} }; },
  'ui.config.save': function (args) { return { ok: true, config: Object.assign({}, ${JSON.stringify(config)}, args), message: '设置已保存' }; },
  'ui.paths': function () { return { ok: true, context: {}, paths: {}, targets: [] }; },
  'ui.cleanupBootstrap': function () { return { ok: true, removed: [], message: '没有需要清理的文件' }; }
};
`;

const THEME = `
:root {
  --aicode-bg: #0e1116;
  --aicode-surface: rgba(255,255,255,.04);
  --aicode-on-surface: #e6e8ec;
  --aicode-border: rgba(148,163,184,.22);
  --aicode-primary: #2f6fed;
  --aicode-error: #ef5b5b;
  --aicode-warning: #c9a227;
  --aicode-font-scale: 1;
}
`;

for (const name of ['workbench', 'config']) {
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'pages', `${name}.html`), 'utf8');
  const out = html
    .replace('<link rel="stylesheet" href="/__aicode/theme.css">', `<style>${THEME}</style>`)
    .replace('<script src="/__aicode/aicode.js"></script>', `<script>${mockJs}${mockData}</script>`);
  fs.writeFileSync(path.join(OUT, `${name}.html`), out, 'utf8');
}

const demoMarkdown = persona.buildPersona({ seat: 'codex', mode: 'max', goal: '把注入台做成本地插件' }).markdown;
fs.writeFileSync(path.join(OUT, 'sample.md'), demoMarkdown, 'utf8');
console.log(`预览已生成：${OUT}`);
console.log(`workbench.html / config.html / sample.md（sample ${demoMarkdown.length} 字）`);
