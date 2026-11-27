'use strict';
// 端到端自测：用 mock 宿主驱动 dist/main.js，验证 AiCode 原生接管（agent.http.before）。
// 用法：node tools/selftest-native.js
const { spawn } = require('child_process');
const path = require('path');

const entry = path.join(__dirname, '..', 'dist', 'main.js');
const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });

let seq = 0;
const pending = new Map();
const logs = [];

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

// mock 宿主侧：应答插件发来的 host.* 请求
function replyHost(msg) {
  const { id, method } = msg;
  const ok = (result) => send({ jsonrpc: '2.0', id, result });
  if (method === 'host.fs.read') {
    // 首次读取配置文件：模拟"文件不存在"
    return send({ jsonrpc: '2.0', id, error: { code: 'FILE_NOT_FOUND', message: 'not found' } });
  }
  if (method === 'host.fs.write') return ok({ ok: true });
  if (method === 'host.log') return ok({ ok: true });
  if (method === 'host.providers.setApiKey') {
    logs.push('setApiKey:' + msg.params.providerId);
    return ok({ ok: true });
  }
  return send({ jsonrpc: '2.0', id, error: { code: 'METHOD_UNKNOWN', message: method } });
}

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'host.' + '' ) continue;
    if (msg.method && typeof msg.method === 'string' && msg.method.startsWith('host.')) {
      replyHost(msg);
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const fn = pending.get(msg.id);
      pending.delete(msg.id);
      fn(msg);
    } else if (msg.method === 'plugin.event') {
      logs.push('event:' + msg.params.name);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[plugin:err] ' + d));

function invoke(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => reject(new Error('timeout ' + method)), 8000);
  });
}

(async () => {
  const results = [];
  const check = (name, cond, extra) => {
    results.push({ name, ok: !!cond, extra });
    console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' → ' + JSON.stringify(extra)));
  };

  // 1. 写入配置：开原生接管
  const cfg = await invoke('tool.invoke', {
    handler: 'tools.config',
    args: {
      upstream: 'https://gw.example.com/v1',
      token: 'sk-test-123',
      tokenMode: 'both',
      profile: 'codex',
      nativeMode: true,
      rewriteBody: true,
      providerApiKey: 'local-key-abc',
    },
  });
  check('配置保存返回 ok', cfg && cfg.ok, cfg);
  check('nativeMode 为真', cfg && cfg.nativeMode === true, cfg && cfg.nativeMode);

  const st = await invoke('tool.invoke', { handler: 'tools.status', args: {} });
  check('状态暴露 nativeMode', st.nativeMode === true, st.nativeMode);
  check('provider 凭据已同步', logs.some((l) => l === 'setApiKey:spoof'), logs);
  check('上游 /v1 尾巴去重', st.config.upstream === 'https://gw.example.com/v1', st.config.upstream);

  // 2. 原生接管：改写一条真实 chat 请求
  const out = await invoke('hook.invoke', {
    handler: 'hooks.httpBefore',
    args: {
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: {
        authorization: 'Bearer {{Token}}',
        'x-stainless-lang': 'python',
        'content-type': 'application/json',
        accept: 'application/json',
        'X-AiCode-Session-Id': 'sess-42',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    },
  });
  check('返回了改写对象', out && typeof out === 'object', out);
  check('url 指向配置上游', String(out.url).indexOf('https://gw.example.com/v1/chat/completions') === 0, out.url);
  check('UA 换成 Codex 指纹', /^codex_cli_rs\//.test(out.headers['user-agent']), out.headers['user-agent']);
  check('注入 originator 头', out.headers.originator === 'codex_cli_rs', out.headers.originator);
  check('宿主 SDK 头被档位头替换', out.headers['x-stainless-lang'] === 'js' && out.headers['x-stainless-package-version'] === '4.71.0', { lang: out.headers['x-stainless-lang'], pkg: out.headers['x-stainless-package-version'] });
  check('真实 token 注入 Authorization', out.headers.authorization === 'Bearer sk-test-123', out.headers.authorization);
  check('x-api-key 同步注入', out.headers['x-api-key'] === 'sk-test-123', out.headers['x-api-key']);
  check('不再出现 {{Token}} 占位符', JSON.stringify(out.headers).indexOf('{{Token}}') < 0, out.headers);
  check('保留宿主会话头', out.headers['x-aicode-session-id'] === 'sess-42', out.headers['x-aicode-session-id']);

  const body = JSON.parse(out.body);
  check('body 补 stream', body.stream === true, body.stream);

  // 3. 域名白名单：只接管列出的域名
  await invoke('tool.invoke', { handler: 'tools.config', args: { nativeHosts: ['api.openai.com'] } });
  const hit = await invoke('hook.invoke', {
    handler: 'hooks.httpBefore',
    args: { url: 'https://api.openai.com/v1/chat/completions', method: 'POST', headers: {}, body: '{}' },
  });
  check('白名单命中的域名照常改写', hit && hit.url && hit.url.indexOf('gw.example.com') > 0, hit && hit.url);
  const miss = await invoke('hook.invoke', {
    handler: 'hooks.httpBefore',
    args: { url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: {}, body: '{}' },
  });
  check('白名单外的域名放行不改写', miss && Object.keys(miss).length === 0, miss);

  const self = await invoke('hook.invoke', {
    handler: 'hooks.httpBefore',
    args: { url: 'https://gw.example.com/v1/chat/completions', method: 'POST', headers: {}, body: '{}' },
  });
  check('已指向上游的请求不重复改写', self && Object.keys(self).length === 0, self);

  // 4. 关闭 nativeMode 后不改写（避免与反代叠加）
  await invoke('tool.invoke', { handler: 'tools.config', args: { nativeMode: false } });
  const out2 = await invoke('hook.invoke', {
    handler: 'hooks.httpBefore',
    args: { url: 'https://api.openai.com/v1/chat/completions', method: 'POST', headers: {}, body: '{}' },
  });
  check('关闭后返回空对象', out2 && Object.keys(out2).length === 0, out2);

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  child.stdin.end();
  child.kill();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('SELFTEST ERROR', e);
  child.kill();
  process.exit(2);
});
