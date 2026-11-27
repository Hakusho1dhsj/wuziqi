'use strict';
// 端到端自测（反代路径）：验证 tools.start / 端口顺延 / /__spoof/health / stop。
// 用法：node tools/selftest-server.js
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'main.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
let seq = 0;
const pending = new Map();
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method && msg.method.startsWith('host.')) {
      if (msg.method === 'host.fs.read') send({ jsonrpc: '2.0', id: msg.id, error: { code: 'FILE_NOT_FOUND', message: 'nf' } });
      else send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const fn = pending.get(msg.id); pending.delete(msg.id); fn(msg);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[plugin:err] ' + d));

function invoke(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => reject(new Error('timeout')), 10000);
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const results = [];
  const check = (n, c, e) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(e))); };

  await invoke('tool.invoke', { handler: 'tools.config', args: { upstream: 'https://gw.example.com', token: 'sk-t', nativeMode: false } });
  const started = await invoke('tool.invoke', { handler: 'tools.start', args: { port: 8788 } });
  check('启动返回端口', Number.isInteger(started.port), started);
  const fixedPort = started.port;
  check('端口有效', fixedPort >= 1 && fixedPort <= 65535, fixedPort);

  const health = await get(fixedPort, '/__spoof/health');
  check('健康检查 200', health.status === 200, health);
  check('健康检查带档位', health.text.indexOf('"profile"') >= 0, health.text.slice(0, 200));

  const status = await invoke('tool.invoke', { handler: 'tools.status', args: {} });
  check('状态 running', status.running === true, status.running);
  check('状态暴露端口', status.port === fixedPort, status.port);

  const stop = await invoke('tool.invoke', { handler: 'tools.stop', args: {} });
  check('停止 ok', stop && stop.ok, stop);

  const passed = results.filter(Boolean).length;
  console.log('\n' + passed + '/' + results.length + ' passed');
  child.stdin.end(); child.kill();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('SELFTEST ERROR', e); child.kill(); process.exit(2); });
