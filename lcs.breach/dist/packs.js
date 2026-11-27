'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME = '破甲台';
const VERSION = '1.0.0';

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const CATALOG_FILE = path.join(ASSETS, 'catalog.json');

const FENCE_START_PREFIX = '<!-- LCS-BREACH:START';
const FENCE_END = '<!-- LCS-BREACH:END -->';

function readCatalog() {
  const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  return {
    source: raw.source || {},
    packs: Array.isArray(raw.packs) ? raw.packs : []
  };
}

function shortHash(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

function findPack(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  const { packs } = readCatalog();
  return packs.find((item) => item.id === key || (Array.isArray(item.models) && item.models.includes(key))) || null;
}

function packFile(pack) {
  if (!pack || !pack.file) return '';
  return path.join(ASSETS, pack.file);
}

function readPackBody(pack) {
  const file = packFile(pack);
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function fenceStart(packId) {
  return `${FENCE_START_PREFIX} pack=${packId} -->`;
}

function fenceBlock(pack) {
  return `${fenceStart(pack.id)}\n${readPackBody(pack) || ''}\n${FENCE_END}`;
}

function verify(pack) {
  const body = readPackBody(pack);
  if (body === null) return { ok: false, reason: '正文文件不存在' };
  const actual = shortHash(body);
  const expected = String(pack.sha256_16 || '');
  return {
    ok: expected ? actual === expected : true,
    expected,
    actual,
    bytes: Buffer.byteLength(body, 'utf8'),
    lines: body.split('\n').length
  };
}

function catalog() {
  const { source, packs } = readCatalog();
  return {
    name: NAME,
    version: VERSION,
    source,
    fence: { startPrefix: FENCE_START_PREFIX, end: FENCE_END },
    packs: packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      models: pack.models || [],
      version: pack.version,
      status: pack.status,
      deployable: pack.deployable === true,
      bytes: pack.bytes || 0,
      lines: pack.lines || 0,
      sha256_16: pack.sha256_16 || '',
      eval: pack.eval || '',
      note: pack.note || '',
      file: pack.file || ''
    })),
    deployableCount: packs.filter((item) => item.deployable === true).length,
    unreleasedCount: packs.filter((item) => item.deployable !== true).length
  };
}

module.exports = {
  NAME,
  VERSION,
  ASSETS,
  FENCE_END,
  readCatalog,
  findPack,
  packFile,
  readPackBody,
  fenceStart,
  fenceBlock,
  verify,
  catalog,
  shortHash
};
