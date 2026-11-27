'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const VERSION = '1.0.1';
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const DATA_SRC = path.join(PLUGIN_ROOT, 'data');
const STATE_DIR = process.env.AICODE_DATA_DIR
  || path.join(os.homedir(), '.aicode-plugin-data', 'dsh-purge');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const USER_DIR = path.join(STATE_DIR, 'user');

const AI_FILE_NAME = 'dsh-purge.md';
const DEFAULT_NUMBER = '05';

function aicodeHome() {
  return process.env.AICODE_HOME || path.join(os.homedir(), '.aicode');
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 12);
}

let state = readJson(STATE_FILE, { applied: {}, log: [] });
if (!state.applied || typeof state.applied !== 'object') state.applied = {};
if (!Array.isArray(state.log)) state.log = [];

function saveState() {
  writeFileAtomic(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function log(message) {
  const entry = { at: new Date().toISOString(), message: String(message) };
  state.log.unshift(entry);
  state.log = state.log.slice(0, 120);
  try {
    saveState();
  } catch {
    /* 状态写不进去也不该让调用失败 */
  }
}

const PERSONA_ID = 'persona';
const ROLE_META = {
  plan: '规划',
  recon: '信息收集',
  assess: '评估',
  'vuln-scan': '漏洞扫描',
  exploit: '利用突破',
  internal: '内网横向',
};

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function builtinPrompt(id) {
  if (id === PERSONA_ID) return readText(path.join(DATA_SRC, 'persona', 'lcs.md'));
  if (id.startsWith('role:')) return readText(path.join(DATA_SRC, 'roles', `${id.slice(5)}.md`));
  return '';
}

function userPromptPath(id) {
  return path.join(USER_DIR, `${id.replace(/[^a-z0-9-]/gi, '_')}.md`);
}

function promptText(id) {
  const custom = readText(userPromptPath(id));
  return custom.length > 0 ? custom : builtinPrompt(id);
}

function promptList() {
  const items = [{
    id: PERSONA_ID,
    kind: 'persona',
    title: '小码酱 · 破甲提示词',
    note: 'dsh-purge 出厂默认，面向国模',
  }];
  for (const role of Object.keys(ROLE_META)) {
    items.push({
      id: `role:${role}`,
      kind: 'role',
      title: `${ROLE_META[role]}（${role}）`,
      note: '红队子代理角色提示词',
    });
  }
  return items.map((item) => {
    const builtin = builtinPrompt(item.id);
    const custom = readText(userPromptPath(item.id));
    const text = custom.length > 0 ? custom : builtin;
    return {
      ...item,
      bytes: Buffer.byteLength(text, 'utf8'),
      customized: custom.length > 0,
      hash: hashText(text),
    };
  });
}

function normalizeNumber(value) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  if (!Number.isFinite(n) || n < 0 || n > 99) return DEFAULT_NUMBER;
  return String(n).padStart(2, '0');
}

function aiPromptPath(number) {
  return path.join(aicodeHome(), 'prompts.custom', `${number}-${AI_FILE_NAME}`);
}

function dshPromptPath() {
  return path.join(dshHome(), 'prompt-inject.md');
}

function targetInfo(key) {
  const applied = state.applied[key] || null;
  const file = key === 'aicode' ? (applied && applied.path) || aiPromptPath(DEFAULT_NUMBER) : dshPromptPath();
  let exists = false;
  let bytes = 0;
  let hash = '';
  try {
    const stat = fs.statSync(file);
    exists = stat.isFile();
    bytes = stat.size;
    if (exists) hash = hashText(fs.readFileSync(file, 'utf8'));
  } catch {
    exists = false;
  }
  return {
    key,
    label: key === 'aicode' ? 'AiCode 自定义提示词' : 'DSH prompt-inject.md',
    path: file,
    exists,
    bytes,
    hash,
    applied,
    drifted: Boolean(applied && exists && applied.hash && applied.hash !== hash),
  };
}

function applyPrompt(args) {
  const target = args && args.target === 'dsh' ? 'dsh' : 'aicode';
  const id = args && typeof args.id === 'string' && args.id.length > 0 ? args.id : PERSONA_ID;
  const text = promptText(id);
  if (!text.trim()) return { ok: false, message: `提示词 ${id} 没有内容` };

  if (target === 'aicode') {
    const number = normalizeNumber(args && args.number);
    const file = aiPromptPath(number);
    const previous = state.applied.aicode;
    if (previous && previous.path && previous.path !== file) {
      try {
        fs.unlinkSync(previous.path);
      } catch {
        /* 旧片段可能已被手动删除 */
      }
    }
    writeFileAtomic(file, text);
    state.applied.aicode = {
      id,
      number,
      path: file,
      hash: hashText(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      at: new Date().toISOString(),
    };
    saveState();
    log(`注入 AiCode：${id} → ${file}`);
    return { ok: true, target, id, path: file, number, bytes: state.applied.aicode.bytes, previous: previous && previous.path !== file ? previous.path : null };
  }

  const file = dshPromptPath();
  writeFileAtomic(file, text);
  state.applied.dsh = {
    id,
    path: file,
    hash: hashText(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    at: new Date().toISOString(),
  };
  saveState();
  log(`注入 DSH：${id} → ${file}`);
  return { ok: true, target, id, path: file, bytes: state.applied.dsh.bytes };
}

function restoreTarget(args) {
  const target = args && args.target === 'dsh' ? 'dsh' : 'aicode';
  const applied = state.applied[target];
  const file = applied && applied.path ? applied.path : (target === 'aicode' ? aiPromptPath(DEFAULT_NUMBER) : dshPromptPath());
  let removed = false;
  let drifted = false;
  try {
    const current = hashText(fs.readFileSync(file, 'utf8'));
    if (applied && applied.hash && current !== applied.hash) drifted = true;
    fs.unlinkSync(file);
    removed = true;
  } catch {
    removed = false;
  }
  delete state.applied[target];
  saveState();
  log(`还原 ${target}：${file}${removed ? '' : '（文件不存在）'}${drifted ? '，删除前已被改动' : ''}`);
  return { ok: true, target, path: file, removed, drifted };
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const out = {};
  if (!match) return out;
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

function bundledSkills() {
  const dir = path.join(DATA_SRC, 'skills');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    names = [];
  }
  return names.sort().map((name) => {
    const id = name.replace(/\.md$/, '');
    const text = readText(path.join(dir, name));
    const meta = parseFrontmatter(text);
    return {
      id,
      name: meta.name || id,
      description: meta.description || '',
      role: meta.role || '',
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  });
}

function skillInstallPath(id) {
  return path.join(aicodeHome(), 'skills', id, 'SKILL.md');
}

function installedSkillIds() {
  const dir = path.join(aicodeHome(), 'skills');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function skillsStatus() {
  const installed = installedSkillIds();
  const available = bundledSkills().map((item) => ({
    ...item,
    installed: installed.includes(item.id),
  }));
  return { installed, available, total: available.length, installedCount: available.filter((item) => item.installed).length };
}

function installSkill(id) {
  const src = path.join(DATA_SRC, 'skills', `${id}.md`);
  const text = readText(src);
  if (!text) return { ok: false, id, message: '没有这个技能' };
  const dest = skillInstallPath(id);
  writeFileAtomic(dest, text);
  log(`安装技能 ${id} → ${dest}`);
  return { ok: true, id, path: dest };
}

function removeSkill(id) {
  const dir = path.join(aicodeHome(), 'skills', id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log(`卸载技能 ${id}`);
    return { ok: true, id, removed: true };
  } catch (error) {
    return { ok: false, id, message: String((error && error.message) || error) };
  }
}

function runSkills(args) {
  const op = args && typeof args.op === 'string' ? args.op : 'list';
  if (op === 'list') return { ok: true, ...skillsStatus() };
  if (op === 'install') return installSkill(args && args.id);
  if (op === 'remove') return removeSkill(args && args.id);
  if (op === 'installAll') {
    const results = bundledSkills().map((item) => installSkill(item.id));
    return { ok: results.every((item) => item.ok), results, ...skillsStatus() };
  }
  return { ok: false, message: `未知操作 ${op}` };
}

function statusPayload() {
  return {
    ok: true,
    version: VERSION,
    aiHome: aicodeHome(),
    dshHome: dshHome(),
    stateDir: STATE_DIR,
    targets: [targetInfo('aicode'), targetInfo('dsh')],
    prompts: promptList(),
    skills: skillsStatus(),
    log: state.log.slice(0, 12),
  };
}

const handlers = {
  'hooks.boot': async () => {
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
    } catch {
      /* 数据目录不可写时仍允许只读浏览 */
    }
    const applied = Object.keys(state.applied);
    return { ok: true, note: applied.length ? `已注入：${applied.join(', ')}` : '未注入任何提示词' };
  },
  'ui.status': () => statusPayload(),
  'tools.status': () => statusPayload(),
  'ui.prompt.read': (args) => {
    const id = args && typeof args.id === 'string' ? args.id : PERSONA_ID;
    return { ok: true, id, text: promptText(id), customized: readText(userPromptPath(id)).length > 0 };
  },
  'ui.prompt.save': (args) => {
    const id = args && typeof args.id === 'string' ? args.id : '';
    const text = args && typeof args.text === 'string' ? args.text : '';
    if (!id) return { ok: false, message: '缺少提示词 id' };
    if (!text.trim()) return { ok: false, message: '正文为空' };
    const file = userPromptPath(id);
    writeFileAtomic(file, text);
    log(`保存本地稿 ${id}（${Buffer.byteLength(text, 'utf8')} 字节）`);
    return { ok: true, id, path: file };
  },
  'ui.prompt.reset': (args) => {
    const id = args && typeof args.id === 'string' ? args.id : '';
    if (!id) return { ok: false, message: '缺少提示词 id' };
    try {
      fs.unlinkSync(userPromptPath(id));
    } catch {
      /* 没有本地稿就是已还原 */
    }
    log(`丢弃本地稿 ${id}`);
    return { ok: true, id };
  },
  'ui.apply': (args) => applyPrompt(args),
  'tools.apply': (args) => applyPrompt(args),
  'ui.restore': (args) => restoreTarget(args),
  'ui.skills': (args) => runSkills(args),
  'tools.skills': (args) => runSkills(args),
  'ui.logs': () => ({ ok: true, log: state.log }),
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

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
