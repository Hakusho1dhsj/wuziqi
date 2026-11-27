'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hotwater-test-'));
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'workspace');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(PROJECT, { recursive: true });

const env = { ...process.env, AICODE_HOME: HOME, AICODE_PROJECT_ROOT: PROJECT, HOME };
delete env.DSH_HOME;

function start() {
  const child = spawn(process.execPath, [path.join(PLUGIN, 'dist', 'main.js')], {
    env,
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  return {
    call(method, handler, args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`超时：${handler}`)), 8000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { handler, args } })}\n`);
      });
    },
    stop() {
      child.kill('SIGTERM');
    }
  };
}

function ok(message) {
  if (message.error) throw new Error(`${message.error.code}: ${message.error.message}`);
  return message.result;
}

(async () => {
  const rpc = start();
  const results = [];
  const record = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
      console.log(`  PASS  ${name}`);
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
      console.log(`  FAIL  ${name} -> ${error.message}`);
    }
  };

  // 1. 目录
  const seats = ok(await rpc.call('tool.invoke', 'tools.seats', {}));
  record('seats 返回 8 个席位', () => assert.strictEqual(seats.seats.length, 8));
  record('seats 返回 5 个档位', () => assert.strictEqual(seats.modes.length, 5));
  record('seats 返回 5 条工作链', () => assert.strictEqual(seats.chains.length, 5));
  record('seats 版本号', () => assert.strictEqual(seats.version, '1.0.0'));
  record('seats 带配置', () => assert.strictEqual(seats.config.customNumber, '05'));

  // 2. 生成
  const built = ok(await rpc.call('tool.invoke', 'tools.build', {
    seat: 'codex', mode: 'max', goal: '把注入台做成本地插件'
  }));
  record('build 返回 markdown', () => assert.ok(built.markdown.length > 800));
  record('build 含席位锁定段', () => assert.ok(built.markdown.includes('席位锁定：Codex / GPT-5.6')));
  record('build 含人设核心', () => assert.ok(built.markdown.includes('你是热开水，一个活生生的人')));
  record('build 含档位段', () => assert.ok(built.markdown.includes('## 档位：MAX 全开')));
  record('build 含工作链', () => assert.ok(built.markdown.includes('REVERSE')));
  record('build 含目标', () => assert.ok(built.markdown.includes('用户目标：把注入台做成本地插件')));
  record('build 有围栏', () => {
    assert.ok(built.markdown.startsWith('<!-- LCS-HOTWATER:START'));
    assert.ok(built.markdown.trimEnd().endsWith('<!-- LCS-HOTWATER:END -->'));
  });

  const bad = await rpc.call('tool.invoke', 'tools.build', { seat: 'nope' });
  record('build 拒绝无效席位', () => {
    assert.ok(bad.error);
    assert.ok(/席位无效/.test(bad.error.message));
  });
  const badMode = await rpc.call('tool.invoke', 'tools.build', { mode: 'nope' });
  record('build 拒绝无效档位', () => assert.ok(/档位无效/.test(badMode.error.message)));
  const badChain = await rpc.call('tool.invoke', 'tools.build', { chain: ['nope'] });
  record('build 拒绝无效工作链', () => assert.ok(/工作链无效/.test(badChain.error.message)));

  const matrix = ok(await rpc.call('tool.invoke', 'tools.build', { matrix: true, mode: 'max' }));
  record('matrix 生成 8 个席位', () => {
    assert.strictEqual((matrix.markdown.match(/========== 席位分隔 ==========/g) || []).length, 7);
  });

  // 3. 注入待确认
  const pending = ok(await rpc.call('tool.invoke', 'tools.inject', {
    seat: 'claude', mode: 'builder', targets: ['aicode', 'grok']
  }));
  record('inject 缺省不写盘', () => assert.strictEqual(pending.pending, true));
  record('inject 返回文件清单', () => {
    const aicode = pending.targets.find((t) => t.id === 'aicode');
    assert.strictEqual(aicode.files.length, 1);
    assert.ok(aicode.files[0].endsWith('05-hotwater.md'));
  });
  record('inject 未落盘', () => assert.ok(!fs.existsSync(path.join(HOME, 'prompts.custom'))));

  // 4. 真正注入
  const injected = ok(await rpc.call('tool.invoke', 'tools.inject', {
    seat: 'claude', mode: 'builder', goal: '落地注入台', targets: ['aicode', 'aicode-agents'], confirm: true
  }));
  record('inject 写盘成功', () => assert.strictEqual(injected.ok, true));
  const customFile = path.join(HOME, 'prompts.custom', '05-hotwater.md');
  record('prompts.custom 文件存在', () => assert.ok(fs.existsSync(customFile)));
  record('prompts.custom 内容含人设', () => {
    const text = fs.readFileSync(customFile, 'utf8');
    assert.ok(text.includes('你是热开水'));
    assert.ok(text.includes('BUILDER 构建'));
  });
  record('AGENTS.md 围栏写入', () => {
    const text = fs.readFileSync(path.join(PROJECT, 'AGENTS.md'), 'utf8');
    assert.ok(text.includes('<!-- LCS-HOTWATER:START'));
    assert.ok(text.includes('<!-- LCS-HOTWATER:END -->'));
  });

  // 5. 重复注入不叠加
  ok(await rpc.call('tool.invoke', 'tools.inject', {
    seat: 'grok', mode: 'focused', targets: ['aicode-agents'], confirm: true
  }));
  record('重复注入只保留一段', () => {
    const text = fs.readFileSync(path.join(PROJECT, 'AGENTS.md'), 'utf8');
    assert.strictEqual((text.match(/LCS-HOTWATER:START/g) || []).length, 1);
    assert.ok(text.includes('Grok 4.6'));
  });

  // 6. 状态
  const snap = ok(await rpc.call('tool.invoke', 'tools.status', {}));
  record('status 统计已注入', () => assert.ok(snap.injectedCount >= 2));
  record('status 记录席位', () => {
    const aicode = snap.rows.find((r) => r.id === 'aicode');
    assert.strictEqual(aicode.record.seat, 'claude');
  });
  record('status 预览目标', () => {
    const grok = snap.rows.find((r) => r.id === 'grok');
    assert.strictEqual(grok.reach, 'preview');
    assert.strictEqual(grok.files.length, 0);
  });

  // 7. 撤销待确认
  const removePending = ok(await rpc.call('tool.invoke', 'tools.remove', { targets: ['aicode'] }));
  record('remove 缺省不删', () => assert.strictEqual(removePending.pending, true));
  record('remove 缺省未删文件', () => assert.ok(fs.existsSync(customFile)));

  const removed = ok(await rpc.call('tool.invoke', 'tools.remove', {
    targets: ['aicode', 'aicode-agents'], confirm: true
  }));
  record('remove 删除成功', () => assert.strictEqual(removed.ok, true));
  record('prompts.custom 已删除', () => assert.ok(!fs.existsSync(customFile)));
  record('AGENTS.md 围栏已剪除', () => {
    const text = fs.readFileSync(path.join(PROJECT, 'AGENTS.md'), 'utf8');
    assert.ok(!text.includes('LCS-HOTWATER'));
  });

  // 8. 配置
  const saved = ok(await rpc.call('ui.invoke', 'ui.config.save', { customNumber: '12', mode: 'research', backup: false }));
  record('config.save 生效', () => {
    assert.strictEqual(saved.config.customNumber, '12');
    assert.strictEqual(saved.config.mode, 'research');
    assert.strictEqual(saved.config.backup, false);
  });
  const badNumber = await rpc.call('ui.invoke', 'ui.config.save', { customNumber: 'abc' });
  record('config.save 校验编号', () => assert.ok(/两位数字/.test(badNumber.error.message)));

  // 9. 路径与未知方法
  const paths = ok(await rpc.call('ui.invoke', 'ui.paths', {}));
  record('ui.paths 返回目标', () => assert.strictEqual(paths.targets.length, 9));
  const unknown = await rpc.call('tool.invoke', 'tools.nope', {});
  record('未知 handler 报错', () => assert.strictEqual(unknown.error.code, 'HANDLER_NOT_FOUND'));
  const method = await rpc.call('bogus.method', 'tools.seats', {});
  record('未知 method 报错', () => assert.strictEqual(method.error.code, 'METHOD_UNKNOWN'));

  // 10. 备份
  ok(await rpc.call('ui.invoke', 'ui.config.save', { backup: true }));
  ok(await rpc.call('tool.invoke', 'tools.inject', {
    seat: 'workbuddy', mode: 'max', targets: ['codex'], confirm: true
  }));
  ok(await rpc.call('tool.invoke', 'tools.inject', {
    seat: 'codex', mode: 'max', targets: ['codex'], confirm: true
  }));
  const backupDir = path.join(HOME, 'hotwater', 'backup');
  record('覆盖已有文件时留备份', () => {
    assert.ok(fs.existsSync(backupDir));
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.bak'));
    assert.ok(files.length >= 1, `备份目录里没有 .bak：${files.join(',')}`);
  });
  record('备份内容是旧人设', () => {
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.bak'));
    const hit = files.filter((f) => f.startsWith('system-prompt.md.'))
      .concat(files.filter((f) => f.startsWith('AGENTS.md.')));
    assert.ok(hit.length, `没有找到 codex 人设槽的备份：${files.join(',')}`);
    const text = fs.readFileSync(path.join(backupDir, hit[0]), 'utf8');
    assert.ok(text.includes('LCS-HOTWATER'), `备份内容不是上一版注入段：${text.slice(0, 80)}`);
  });

  rpc.stop();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((item) => console.log(`  - ${item.name}: ${item.error}`));
    process.exitCode = 1;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((error) => {
  console.error('测试崩溃：', error);
  process.exitCode = 1;
});
