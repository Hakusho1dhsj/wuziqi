'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const persona = require('./persona');

const STATE_VERSION = 1;

function homeDir() {
  return process.env.HOME || os.homedir();
}

function aicodeHome() {
  return process.env.AICODE_HOME || path.join(homeDir(), '.aicode');
}

function projectRoot() {
  return process.env.AICODE_PROJECT_ROOT || process.env.HOTWATER_PROJECT_ROOT || path.join(homeDir(), 'workspace');
}

function dshHome() {
  return process.env.DSH_HOME || '';
}

function stateDir() {
  return path.join(aicodeHome(), 'hotwater');
}

function stateFile() {
  return path.join(stateDir(), 'state.json');
}

function configFile() {
  return path.join(stateDir(), 'config.json');
}

const DEFAULT_CONFIG = {
  seat: 'master',
  mode: 'max',
  channel: 'auto',
  tone: '',
  customNumber: '05',
  backup: true
};

function context() {
  const config = readConfig();
  return {
    home: homeDir(),
    aicodeHome: aicodeHome(),
    projectRoot: projectRoot(),
    dshHome: dshHome(),
    customNumber: config.customNumber
  };
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readConfig() {
  const raw = readJson(configFile(), {});
  const merged = { ...DEFAULT_CONFIG, ...raw };
  merged.customNumber = /^\d{2}$/.test(String(merged.customNumber)) ? String(merged.customNumber) : DEFAULT_CONFIG.customNumber;
  if (!persona.findSeat(merged.seat)) merged.seat = DEFAULT_CONFIG.seat;
  if (!persona.findMode(merged.mode)) merged.mode = DEFAULT_CONFIG.mode;
  if (!persona.findChannel(merged.channel)) merged.channel = DEFAULT_CONFIG.channel;
  merged.tone = typeof merged.tone === 'string' ? merged.tone : '';
  merged.backup = merged.backup !== false;
  return merged;
}

function saveConfig(patch) {
  const next = { ...readConfig(), ...(patch || {}) };
  if (patch && patch.customNumber !== undefined) {
    const num = String(patch.customNumber).padStart(2, '0');
    if (!/^\d{2}$/.test(num)) throw new Error('customNumber 必须是两位数字，例如 05');
    next.customNumber = num;
  }
  if (patch && next.seat && !persona.findSeat(next.seat)) throw new Error(`席位无效：${next.seat}`);
  if (patch && next.mode && !persona.findMode(next.mode)) throw new Error(`档位无效：${next.mode}`);
  if (patch && next.channel && !persona.findChannel(next.channel)) throw new Error(`通道无效：${next.channel}`);
  writeJson(configFile(), next);
  return readConfig();
}

function readState() {
  const raw = readJson(stateFile(), {});
  return {
    version: STATE_VERSION,
    targets: raw.targets && typeof raw.targets === 'object' ? raw.targets : {}
  };
}

function writeState(state) {
  writeJson(stateFile(), { version: STATE_VERSION, targets: state.targets, updatedAt: new Date().toISOString() });
}

function fingerprint(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

function targetFiles(targetId) {
  const target = persona.findTarget(targetId);
  if (!target) throw new Error(`注入目标无效：${targetId}`);
  return target.paths(context());
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function findFence(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf(persona.FENCE_START);
  if (start < 0) return null;
  const end = text.indexOf(persona.FENCE_END, start);
  if (end < 0) return null;
  return { start, end: end + persona.FENCE_END.length, body: text.slice(start, end + persona.FENCE_END.length) };
}

function mergeFence(existing, markdown) {
  const fence = findFence(existing);
  if (!fence) {
    const base = (existing || '').replace(/\s+$/, '');
    return base ? `${base}\n\n${markdown}\n` : `${markdown}\n`;
  }
  return `${existing.slice(0, fence.start)}${markdown}${existing.slice(fence.end)}`.replace(/\n{3,}/g, '\n\n');
}

function stripFence(existing) {
  const fence = findFence(existing);
  if (!fence) return { changed: false, text: existing };
  const before = existing.slice(0, fence.start).replace(/\s+$/, '');
  const after = existing.slice(fence.end).replace(/^\s+/, '');
  const joined = [before, after].filter(Boolean).join('\n\n');
  return { changed: true, text: joined ? `${joined}\n` : '' };
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(stateDir(), 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${path.basename(file)}.${stamp}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

function writeFileSafe(file, content, options) {
  const opts = options || {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  let backup = '';
  if (existed && opts.backup !== false) {
    backup = backupFile(file);
  }
  if (opts.dryRun) {
    return { written: false, dryRun: true, existed, backup, bytes: Buffer.byteLength(content, 'utf8') };
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return { written: true, dryRun: false, existed, backup, bytes: Buffer.byteLength(content, 'utf8') };
}

function presetYaml(markdown, seat) {
  const indented = markdown
    .split('\n')
    .map((line) => (line ? `      ${line}` : ''))
    .join('\n');
  return [
    `name: ${persona.NAME}`,
    'description: 热开水人设锁定的完整编码 Agent。',
    'order: 0',
    `seat: ${seat.id}`,
    'prompt: |',
    indented,
    ''
  ].join('\n');
}

function normaliseTargets(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const ids = list.map((item) => String(item || '').trim()).filter(Boolean);
  if (!ids.length) return ['aicode'];
  const unknown = ids.filter((id) => !persona.findTarget(id));
  if (unknown.length) throw new Error(`注入目标无效：${unknown.join(', ')}`);
  return Array.from(new Set(ids));
}

function inject(input) {
  const built = persona.buildPersona(input);
  const ids = normaliseTargets(input.targets);
  const dryRun = input.dryRun === true;
  const dryPreview = input.confirm !== true && !dryRun;
  const config = readConfig();
  const backup = input.backup === undefined ? config.backup : input.backup !== false;

  if (dryPreview) {
    return {
      ok: true,
      pending: true,
      seat: built.seat.id,
      mode: built.mode.id,
      markdown: built.markdown,
      targets: ids.map((id) => {
        const target = persona.findTarget(id);
        return {
          id,
          name: target.name,
          reach: target.reach,
          files: target.reach === 'preview' ? [] : targetFiles(id)
        };
      }),
      message: `${persona.NAME} ${built.seat.title} · ${built.mode.label} 注入包已生成，尚未写盘。确认写入请传 confirm=true。`
    };
  }

  const state = readState();
  const results = [];
  for (const id of ids) {
    const target = persona.findTarget(id);
    if (target.reach === 'preview') {
      results.push({
        id,
        name: target.name,
        ok: true,
        preview: true,
        files: [],
        message: `${target.name} 没有落地文件，只输出文本`
      });
      continue;
    }
    const files = targetFiles(id);
    const fileResults = [];
    for (const file of files) {
      const existing = readText(file);
      let content;
      if (target.kind === 'dir' && file.endsWith('agent.cordis.yml')) {
        content = presetYaml(built.markdown, built.seat);
      } else if (id === 'aicode') {
        content = `${built.markdown}\n`;
      } else {
        content = mergeFence(existing || '', built.markdown);
      }
      const wrote = writeFileSafe(file, content, { backup, dryRun });
      fileResults.push({ file, ...wrote });
    }
    const ok = fileResults.every((item) => item.written || item.dryRun);
    if (ok && !dryRun) {
      state.targets[id] = {
        seat: built.seat.id,
        mode: built.mode.id,
        chains: built.chains.map((item) => item.id),
        hash: fingerprint(built.markdown),
        files,
        at: new Date().toISOString()
      };
    }
    results.push({
      id,
      name: target.name,
      ok,
      files: fileResults,
      manualKey: target.manualKey || '',
      message: ok
        ? `${target.name}：${dryRun ? '预演通过，未写盘' : `已写入 ${fileResults.length} 个文件`}`
        : `${target.name}：写入失败`
    });
  }
  if (!dryRun && results.some((item) => item.ok && !item.preview)) writeState(state);

  const written = results.filter((item) => item.ok && !item.preview).length;
  return {
    ok: results.every((item) => item.ok),
    seat: built.seat.id,
    mode: built.mode.id,
    dryRun,
    results,
    markdown: built.markdown,
    message: dryRun
      ? `预演完成：${ids.length} 个目标，${written} 个可写。`
      : `${persona.NAME} ${built.seat.title} · ${built.mode.label} 已注入 ${written} 个目标。`
  };
}

function remove(input) {
  const ids = normaliseTargets(input.targets);
  if (input.confirm !== true) {
    return {
      ok: true,
      pending: true,
      targets: ids.map((id) => {
        const target = persona.findTarget(id);
        return { id, name: target.name, files: target.reach === 'preview' ? [] : targetFiles(id) };
      }),
      message: `将清除 ${ids.join(', ')} 的${persona.NAME}注入段。确认请传 confirm=true。`
    };
  }
  const state = readState();
  const results = [];
  for (const id of ids) {
    const target = persona.findTarget(id);
    const recorded = state.targets[id] && Array.isArray(state.targets[id].files) ? state.targets[id].files : [];
    const files = target.reach === 'preview' ? [] : (recorded.length ? recorded : targetFiles(id));
    const fileResults = [];
    for (const file of files) {
      const existing = readText(file);
      if (existing === null) {
        fileResults.push({ file, removed: false, reason: '文件不存在' });
        continue;
      }
      if (target.kind === 'dir' && file.endsWith('agent.cordis.yml')) {
        fs.rmSync(file, { force: true });
        fileResults.push({ file, removed: true, reason: '整文件删除（本插件生成）' });
        continue;
      }
      if (id === 'aicode') {
        fs.rmSync(file, { force: true });
        fileResults.push({ file, removed: true, reason: '整文件删除（本插件生成）' });
        continue;
      }
      const stripped = stripFence(existing);
      if (!stripped.changed) {
        fileResults.push({ file, removed: false, reason: '没有注入段' });
        continue;
      }
      writeFileSafe(file, stripped.text, { backup: readConfig().backup });
      fileResults.push({ file, removed: true, reason: '已移除注入段' });
    }
    delete state.targets[id];
    results.push({ id, name: target.name, files: fileResults });
  }
  writeState(state);
  return {
    ok: true,
    results,
    message: `已清除 ${results.filter((item) => item.files.some((f) => f.removed)).length} 个目标的注入段。`
  };
}

function status() {
  const state = readState();
  const rows = persona.TARGETS.map((target) => {
    const files = target.reach === 'preview' ? [] : targetFiles(target.id);
    const items = files.map((file) => {
      const text = readText(file);
      if (text === null) return { file, exists: false, injected: false, hash: '' };
      const fence = findFence(text);
      return {
        file,
        exists: true,
        injected: target.id === 'aicode' ? true : Boolean(fence),
        bytes: Buffer.byteLength(text, 'utf8'),
        hash: fingerprint(fence ? fence.body : text)
      };
    });
    const record = state.targets[target.id] || null;
    return {
      id: target.id,
      name: target.name,
      kind: target.kind,
      reach: target.reach,
      note: target.note,
      manualKey: target.manualKey || '',
      injected: items.some((item) => item.injected),
      files: items,
      record
    };
  });
  const injectedCount = rows.filter((row) => row.injected).length;
  return {
    ok: true,
    version: persona.VERSION,
    injectedCount,
    rows,
    paths: { stateDir: stateDir(), state: stateFile(), config: configFile() },
    message: `${persona.NAME} v${persona.VERSION}：${injectedCount}/${rows.length} 个目标已注入。`
  };
}

function cleanupBootstrap(input) {
  const target = persona.findTarget('workbuddy');
  const files = (target.cleanup && target.cleanup(context())) || [];
  if (!files.length) return { ok: true, removed: [] };
  if (input.confirm !== true) {
    return { ok: true, pending: true, files, message: `将删除 ${files.join(', ')}。确认请传 confirm=true。` };
  }
  const removed = [];
  for (const file of files) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return { ok: true, removed, message: removed.length ? `已删除 ${removed.length} 个 onboarding 文件` : '没有需要清理的文件' };
}

module.exports = {
  homeDir,
  aicodeHome,
  projectRoot,
  dshHome,
  stateDir,
  stateFile,
  configFile,
  DEFAULT_CONFIG,
  context,
  readConfig,
  saveConfig,
  readState,
  writeState,
  fingerprint,
  targetFiles,
  findFence,
  mergeFence,
  stripFence,
  writeFileSafe,
  inject,
  remove,
  status,
  cleanupBootstrap
};
