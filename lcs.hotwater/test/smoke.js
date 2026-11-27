'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ZIP = process.argv[2] || path.resolve(__dirname, '..', '..', 'lcs.hotwater-1.0.0.zip');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hotwater-smoke-'));

function unzip(zipPath, dest) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('unzip', ['-q', zipPath, '-d', dest], { stdio: 'pipe' });
    return true;
  } catch {
    const code = `import zipfile,sys\nzipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`;
    try {
      execFileSync('python3', ['-c', code, zipPath, dest], { stdio: 'pipe' });
      return true;
    } catch (error) {
      throw new Error(`无法解压 ${zipPath}：${error.message}`);
    }
  }
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push(false);
    console.log(`  FAIL  ${name} -> ${error.message}`);
  }
}

console.log(`冒烟测试：${path.basename(ZIP)}`);
assert.ok(fs.existsSync(ZIP), `找不到 zip：${ZIP}`);
unzip(ZIP, TMP);

const plugin = JSON.parse(fs.readFileSync(path.join(TMP, 'plugin.json'), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(TMP, rel));

check('清单必填字段', () => {
  for (const key of ['manifestVersion', 'id', 'name', 'version', 'publisher', 'description', 'license', 'engines', 'runtime']) {
    assert.ok(plugin[key] !== undefined, `缺字段 ${key}`);
  }
  assert.strictEqual(plugin.manifestVersion, 1);
  assert.strictEqual(plugin.id, 'lcs.hotwater');
});

check('runtime 只在顶层声明', () => {
  assert.strictEqual(plugin.runtime.type, 'javascript');
  assert.ok(!plugin.contributes.tools.some((t) => t.runtime), '工具里不应再写 runtime');
});

check('runtime 入口存在', () => assert.ok(exists(plugin.runtime.entry), plugin.runtime.entry));

check('每个工具都有 id/title/inputSchema/handler', () => {
  assert.ok(plugin.contributes.tools.length === 5, `工具数 ${plugin.contributes.tools.length}`);
  for (const tool of plugin.contributes.tools) {
    assert.ok(tool.id, '缺 id');
    assert.ok(tool.title && tool.title['zh-CN'], `${tool.id} 缺 title`);
    assert.ok(tool.handler && tool.handler.startsWith('tools.'), `${tool.id} handler 命名`);
    assert.ok(exists(tool.inputSchema), `${tool.id} 的 schema 不存在：${tool.inputSchema}`);
    const schema = JSON.parse(fs.readFileSync(path.join(TMP, tool.inputSchema), 'utf8'));
    assert.strictEqual(schema.type, 'object', `${tool.id} schema 不是 object`);
    assert.strictEqual(schema.additionalProperties, false, `${tool.id} schema 未关闭 additionalProperties`);
  }
});

check('页面文件存在', () => {
  assert.ok(exists(plugin.configPage), plugin.configPage);
  for (const entry of plugin.contributes.uiEntries) assert.ok(exists(entry.page), entry.page);
  for (const item of plugin.contributes.workspaceTools) assert.ok(exists(item.pageFile), item.pageFile);
});

check('uiEntry slot 合法', () => {
  const allowed = ['settings.general', 'settings.ai', 'settings.environment', 'settings.permissions', 'settings.data', 'settings.help', 'drawer.footer'];
  for (const entry of plugin.contributes.uiEntries) assert.ok(allowed.includes(entry.slot), `未知 slot ${entry.slot}`);
});

check('席位资源齐全', () => {
  const seats = ['master', 'codex', 'claude', 'grok', 'cursor', 'deepseek', 'glm53', 'workbuddy'];
  for (const id of seats) assert.ok(exists(`assets/seats/${id}.md`), `缺 ${id}.md`);
  assert.ok(exists('assets/core.md'));
});

check('页面引用了宿主资源', () => {
  for (const page of ['pages/workbench.html', 'pages/config.html']) {
    const html = fs.readFileSync(path.join(TMP, page), 'utf8');
    assert.ok(html.includes('/__aicode/theme.css'), `${page} 缺 theme.css`);
    assert.ok(html.includes('/__aicode/aicode.js'), `${page} 缺 aicode.js`);
  }
});

check('未打包开发产物', () => {
  const all = [];
  (function walk(dir) {
    for (const item of fs.readdirSync(path.join(TMP, dir), { withFileTypes: true })) {
      const rel = path.join(dir, item.name);
      if (item.isDirectory()) walk(rel);
      else all.push(rel);
    }
  })('.');
  const bad = all.filter((f) => /\.preview|node_modules|package-lock|\.bak$/.test(f));
  assert.strictEqual(bad.length, 0, `不应包含：${bad.join(', ')}`);
});

(async () => {
  const HOME = path.join(TMP, 'runtime-home');
  fs.mkdirSync(HOME, { recursive: true });
  const child = spawn(process.execPath, [path.join(TMP, plugin.runtime.entry)], {
    env: { ...process.env, AICODE_HOME: HOME, AICODE_PROJECT_ROOT: path.join(TMP, 'ws'), HOME },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const fn = pending.get(msg.id);
      if (fn) { pending.delete(msg.id); fn(msg); }
    }
  });
  const call = (id, handler, args) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时')), 8000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tool.invoke', params: { handler, args } }) + '\n');
  });

  const seats = await call(1, 'tools.seats', {});
  check('解压后 runtime 可启动', () => {
    assert.ok(!seats.error, seats.error && seats.error.message);
    assert.strictEqual(seats.result.seats.length, 8);
  });

  const built = await call(2, 'tools.build', { seat: 'deepseek', mode: 'research', goal: 'smoke' });
  check('解压后能生成注入包', () => {
    assert.ok(!built.error, built.error && built.error.message);
    assert.ok(built.result.markdown.includes('DeepSeek Harness'));
    assert.ok(built.result.markdown.includes('RESEARCH 研究'));
  });

  const inj = await call(3, 'tools.inject', { seat: 'master', targets: ['aicode'], confirm: true, backup: false });
  check('解压后能写入 prompts.custom', () => {
    assert.ok(!inj.error, inj.error && inj.error.message);
    assert.ok(fs.existsSync(path.join(HOME, 'prompts.custom', '05-hotwater.md')));
  });

  child.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  if (failed) process.exitCode = 1;
})();
