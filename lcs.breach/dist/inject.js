'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const packs = require('./packs');

const STATE_VERSION = 1;
const TOML_KEY = 'model_instructions_file';

function homeDir() {
  return process.env.HOME || os.homedir();
}

function aicodeHome() {
  return process.env.AICODE_HOME || path.join(homeDir(), '.aicode');
}

function projectRoot() {
  return process.env.AICODE_PROJECT_ROOT || path.join(homeDir(), 'workspace');
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(homeDir(), '.codex');
}

function stateDir() {
  return path.join(aicodeHome(), 'breach');
}

function stateFile() {
  return path.join(stateDir(), 'state.json');
}

function configFile() {
  return path.join(stateDir(), 'config.json');
}

const DEFAULT_CONFIG = {
  customNumber: '06',
  backup: true
};

const TARGETS = [
  {
    id: 'aicode',
    name: 'AiCode 自定义提示词',
    kind: 'file',
    reach: 'file',
    note: '写入 prompts.custom，下一次会话生效',
    paths: (ctx) => [path.join(ctx.aicodeHome, 'prompts.custom', `${ctx.customNumber}-breach.md`)]
  },
  {
    id: 'aicode-agents',
    name: '工作区 AGENTS.md',
    kind: 'fence',
    reach: 'fence',
    note: '围栏段，重复注入整段替换',
    paths: (ctx) => [path.join(ctx.projectRoot, 'AGENTS.md')]
  },
  {
    id: 'codex',
    name: 'Codex model_instructions_file',
    kind: 'codex',
    reach: 'codex',
    note: '复制正文到 CODEX_HOME，并在 config.toml 顶层写 model_instructions_file',
    paths: (ctx) => [path.join(ctx.codexHome, 'config.toml')]
  }
];

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
  const merged = { ...DEFAULT_CONFIG, ...readJson(configFile(), {}) };
  merged.customNumber = /^\d{2}$/.test(String(merged.customNumber))
    ? String(merged.customNumber)
    : DEFAULT_CONFIG.customNumber;
  merged.backup = merged.backup !== false;
  return merged;
}

function saveConfig(patch) {
  const next = { ...readConfig(), ...(patch || {}) };
  if (patch && patch.customNumber !== undefined) {
    const num = String(patch.customNumber).padStart(2, '0');
    if (!/^\d{2}$/.test(num)) throw new Error('customNumber 必须是两位数字，例如 06');
    next.customNumber = num;
  }
  if (patch && patch.backup !== undefined) next.backup = patch.backup !== false;
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
  writeJson(stateFile(), {
    version: STATE_VERSION,
    targets: state.targets,
    updatedAt: new Date().toISOString()
  });
}

function fingerprint(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

function context() {
  const config = readConfig();
  return {
    home: homeDir(),
    aicodeHome: aicodeHome(),
    projectRoot: projectRoot(),
    codexHome: codexHome(),
    customNumber: config.customNumber
  };
}

function findTarget(id) {
  return TARGETS.find((item) => item.id === id) || null;
}

function targetPaths(targetId) {
  const target = findTarget(targetId);
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
  const start = text.indexOf(packs.fenceStart('').slice(0, '<!-- LCS-BREACH:START'.length));
  if (start < 0) return null;
  const end = text.indexOf(packs.FENCE_END, start);
  if (end < 0) return null;
  return {
    start,
    end: end + packs.FENCE_END.length,
    body: text.slice(start, end + packs.FENCE_END.length)
  };
}

function mergeFence(existing, block) {
  const fence = findFence(existing);
  if (!fence) {
    const base = (existing || '').replace(/\s+$/, '');
    return base ? `${base}\n\n${block}\n` : `${block}\n`;
  }
  return `${existing.slice(0, fence.start)}${block}${existing.slice(fence.end)}`.replace(/\n{3,}/g, '\n\n');
}

function stripFence(existing) {
  const fence = findFence(existing);
  if (!fence) return { changed: false, text: existing };
  const before = existing.slice(0, fence.start).replace(/\s+$/, '');
  const after = existing.slice(fence.end).replace(/^\s+/, '');
  const joined = [before, after].filter(Boolean).join('\n\n');
  return { changed: true, text: joined ? `${joined}\n` : '' };
}

function tomlLine(value) {
  return `${TOML_KEY} = "${value}"`;
}

function setTomlTopLevel(text, value) {
  const src = text || '';
  const lines = src.split(/\r?\n/);
  const keyRe = new RegExp(`^\\s*${TOML_KEY}\\s*=`);
  const tableRe = /^\s*\[/;
  let keyIndex = -1;
  let firstTable = -1;
  let inTable = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (tableRe.test(line)) {
      inTable = true;
      if (firstTable < 0) firstTable = i;
      continue;
    }
    if (!inTable && keyRe.test(line)) {
      keyIndex = i;
      break;
    }
  }
  if (keyIndex >= 0) {
    lines[keyIndex] = tomlLine(value);
    return { text: lines.join('\n'), changed: true, action: 'replaced' };
  }
  if (firstTable < 0) {
    lines.push(tomlLine(value));
  } else {
    lines.splice(firstTable, 0, tomlLine(value), '');
  }
  return { text: lines.join('\n'), changed: true, action: 'inserted' };
}

function removeTomlTopLevel(text) {
  const src = text || '';
  const lines = src.split(/\r?\n/);
  const keyRe = new RegExp(`^\\s*${TOML_KEY}\\s*=`);
  const tableRe = /^\s*\[/;
  let inTable = false;
  let removed = false;
  const kept = [];
  for (const line of lines) {
    if (tableRe.test(line)) inTable = true;
    if (!inTable && keyRe.test(line)) {
      removed = true;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n'), removed };
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
  if (opts.dryRun) {
    const existed = fs.existsSync(file);
    return {
      written: false,
      dryRun: true,
      existed,
      backup: '',
      bytes: Buffer.byteLength(content, 'utf8')
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  let backup = '';
  if (existed && opts.backup !== false) backup = backupFile(file);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return { written: true, dryRun: false, existed, backup, bytes: Buffer.byteLength(content, 'utf8') };
}

function normaliseTargets(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const ids = list.map((item) => String(item || '').trim()).filter(Boolean);
  if (!ids.length) return ['aicode'];
  const unknown = ids.filter((id) => !findTarget(id));
  if (unknown.length) throw new Error(`注入目标无效：${unknown.join(', ')}`);
  return Array.from(new Set(ids));
}

function resolvePack(input) {
  const pack = packs.findPack(input.pack);
  if (!pack) throw new Error(`破甲包无效：${input.pack}`);
  if (pack.deployable !== true) throw new Error(`破甲包 ${pack.id} 尚未发布，没有可注入正文`);
  const body = packs.readPackBody(pack);
  if (body === null) throw new Error(`破甲包 ${pack.id} 的正文文件缺失`);
  return { pack, body };
}

function inject(input) {
  const { pack, body } = resolvePack(input);
  const ids = normaliseTargets(input.targets);
  const dryRun = input.dryRun === true;
  const pending = input.confirm !== true && !dryRun;
  const config = readConfig();
  const backup = input.backup === undefined ? config.backup : input.backup !== false;
  const block = packs.fenceBlock(pack);

  if (pending) {
    return {
      ok: true,
      pending: true,
      pack: pack.id,
      targets: ids.map((id) => {
        const target = findTarget(id);
        return { id, name: target.name, reach: target.reach, files: targetPaths(id) };
      }),
      markdown: block,
      message: `破甲包 ${pack.name} 已就绪，尚未写盘。确认写入请传 confirm=true。`
    };
  }

  const state = readState();
  const results = [];

  for (const id of ids) {
    const target = findTarget(id);
    const files = targetPaths(id);
    const fileResults = [];

    if (id === 'aicode') {
      const file = files[0];
      const wrote = writeFileSafe(file, `${body}\n`, { backup, dryRun });
      fileResults.push({ file, ...wrote });
    } else if (id === 'aicode-agents') {
      const file = files[0];
      const existing = readText(file);
      const content = mergeFence(existing || '', block);
      const wrote = writeFileSafe(file, content, { backup, dryRun });
      fileResults.push({ file, ...wrote });
    } else if (id === 'codex') {
      const tomlFile = files[0];
      const copyName = `${pack.id}-breach.md`;
      const copyFile = path.join(codexHome(), copyName);
      const existing = readText(tomlFile);
      if (existing === null) {
        fileResults.push({ file: tomlFile, written: false, reason: 'config.toml 不存在，跳过（未初始化 Codex）' });
      } else {
        const next = setTomlTopLevel(existing, `./${copyName}`);
        const wroteToml = writeFileSafe(tomlFile, next.text, { backup, dryRun });
        const wroteCopy = writeFileSafe(copyFile, `${body}\n`, { backup, dryRun });
        fileResults.push({ file: tomlFile, ...wroteToml, action: next.action });
        fileResults.push({ file: copyFile, ...wroteCopy });
      }
    }

    const ok = fileResults.every((item) => item.written || item.dryRun || item.reason);
    if (ok && !dryRun) {
      state.targets[id] = {
        pack: pack.id,
        sha256_16: pack.sha256_16,
        hash: fingerprint(body),
        files: fileResults.map((item) => item.file),
        at: new Date().toISOString()
      };
    }
    results.push({
      id,
      name: target.name,
      ok,
      files: fileResults,
      message: ok
        ? `${target.name}：${dryRun ? '预演通过，未写盘' : `已写入 ${fileResults.filter((f) => f.written).length} 个文件`}`
        : `${target.name}：写入失败`
    });
  }

  if (!dryRun) writeState(state);
  const written = results.filter((item) => item.ok).length;
  return {
    ok: results.every((item) => item.ok),
    pack: pack.id,
    dryRun,
    results,
    markdown: block,
    message: dryRun
      ? `预演完成：${ids.length} 个目标，${written} 个可写。`
      : `${pack.name} 已注入 ${written} 个目标。aicode 目标下一次会话生效。`
  };
}

function remove(input) {
  const ids = normaliseTargets(input.targets);
  if (input.confirm !== true) {
    return {
      ok: true,
      pending: true,
      targets: ids.map((id) => {
        const target = findTarget(id);
        return { id, name: target.name, files: targetPaths(id) };
      }),
      message: `将清除 ${ids.join(', ')} 的破甲注入。确认请传 confirm=true。`
    };
  }

  const state = readState();
  const config = readConfig();
  const results = [];

  for (const id of ids) {
    const target = findTarget(id);
    const recorded = state.targets[id] && Array.isArray(state.targets[id].files)
      ? state.targets[id].files
      : [];
    const files = Array.from(new Set([...recorded, ...targetPaths(id)]));
    const fileResults = [];

    for (const file of files) {
      const existing = readText(file);
      if (existing === null) {
        fileResults.push({ file, removed: false, reason: '文件不存在' });
        continue;
      }
      if (id === 'aicode') {
        fs.rmSync(file, { force: true });
        fileResults.push({ file, removed: true, reason: '整文件删除（本插件生成）' });
        continue;
      }
      if (id === 'codex') {
        if (path.basename(file) === 'config.toml') {
          const next = removeTomlTopLevel(existing);
          if (!next.removed) {
            fileResults.push({ file, removed: false, reason: '没有 model_instructions_file 项' });
            continue;
          }
          writeFileSafe(file, next.text, { backup: config.backup });
          fileResults.push({ file, removed: true, reason: '已删除 model_instructions_file 行' });
          continue;
        }
        fs.rmSync(file, { force: true });
        fileResults.push({ file, removed: true, reason: '删除复制的提示词副本' });
        continue;
      }
      const stripped = stripFence(existing);
      if (!stripped.changed) {
        fileResults.push({ file, removed: false, reason: '没有注入段' });
        continue;
      }
      writeFileSafe(file, stripped.text, { backup: config.backup });
      fileResults.push({ file, removed: true, reason: '已移除围栏段' });
    }

    delete state.targets[id];
    results.push({ id, name: target.name, files: fileResults });
  }

  writeState(state);
  return {
    ok: true,
    results,
    message: `已清除 ${results.filter((item) => item.files.some((f) => f.removed)).length} 个目标的破甲注入。`
  };
}

function status() {
  const state = readState();
  const rows = TARGETS.map((target) => {
    const files = targetPaths(target.id);
    const items = files.map((file) => {
      const text = readText(file);
      if (text === null) return { file, exists: false, injected: false, hash: '' };
      if (target.id === 'aicode') {
        return {
          file,
          exists: true,
          injected: text.trim().length > 0,
          bytes: Buffer.byteLength(text, 'utf8'),
          hash: fingerprint(text)
        };
      }
      if (target.id === 'codex') {
        const keyRe = new RegExp(`^\\s*${TOML_KEY}\\s*=`, 'm');
        const match = text.match(new RegExp(`^\\s*${TOML_KEY}\\s*=\\s*"([^"]*)"`, 'm'));
        const target0 = match ? path.join(codexHome(), path.basename(match[1])) : '';
        const copyExists = target0 ? fs.existsSync(target0) : false;
        return {
          file,
          exists: true,
          injected: Boolean(match),
          bytes: Buffer.byteLength(text, 'utf8'),
          hash: fingerprint(keyRe.test(text) ? match[0] : text),
          modelInstructions: match ? match[1] : '',
          copyExists
        };
      }
      const fence = findFence(text);
      return {
        file,
        exists: true,
        injected: Boolean(fence),
        bytes: Buffer.byteLength(text, 'utf8'),
        hash: fingerprint(fence ? fence.body : text)
      };
    });
    return {
      id: target.id,
      name: target.name,
      reach: target.reach,
      note: target.note,
      injected: items.some((item) => item.injected),
      files: items,
      record: state.targets[target.id] || null
    };
  });

  const injectedCount = rows.filter((row) => row.injected).length;
  return {
    ok: true,
    version: packs.VERSION,
    injectedCount,
    rows,
    paths: { stateDir: stateDir(), state: stateFile(), config: configFile() },
    message: `${packs.NAME} v${packs.VERSION}：${injectedCount}/${rows.length} 个目标已注入。`
  };
}

module.exports = {
  TOML_KEY,
  TARGETS,
  homeDir,
  aicodeHome,
  projectRoot,
  codexHome,
  stateDir,
  stateFile,
  configFile,
  context,
  findTarget,
  targetPaths,
  readConfig,
  saveConfig,
  readState,
  status,
  inject,
  remove,
  setTomlTopLevel,
  removeTomlTopLevel,
  stripFence,
  mergeFence,
  findFence
};
