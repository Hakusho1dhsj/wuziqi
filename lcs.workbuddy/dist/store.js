'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const catalog = require('./catalog.js');

const STATE_VERSION = 1;

const REGIONS = {
  domestic: {
    code: 'domestic',
    displayName: '国内版',
    realm: '',
    apiBase: 'https://copilot.tencent.com',
    chatBases: ['https://www.workbuddy.cn', 'https://www.codebuddy.cn', 'https://copilot.tencent.com'],
    ideVersion: '5.9.3',
    domain: 'www.codebuddy.cn',
    origin: 'https://www.codebuddy.cn',
    referer: 'https://www.codebuddy.cn/',
    acceptLanguage: 'zh-CN',
    modelsBase: 'https://www.workbuddy.cn'
  },
  international: {
    code: 'international',
    displayName: '国际版',
    realm: 'global',
    apiBase: 'https://www.codebuddy.ai',
    chatBases: ['https://www.workbuddy.ai'],
    ideVersion: '5.9.4',
    domain: 'www.codebuddy.ai',
    origin: 'https://www.workbuddy.ai',
    referer: 'https://www.workbuddy.ai/',
    acceptLanguage: 'en-US',
    modelsBase: 'https://www.workbuddy.ai'
  }
};

const DEFAULT_REGION = 'international';
const USER_AGENT = 'WorkBuddy/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0';
const IDE_UA_GLOBAL = 'WorkBuddy/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0';
const IDE_UA_DOMESTIC = 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0';
const STAINLESS = {
  lang: 'js',
  packageVersion: '6.25.0',
  os: 'Windows',
  arch: 'x64',
  runtime: 'node',
  runtimeVersion: 'v22.21.1'
};
const WEB_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const QUOTA_USER_AGENT = 'WorkBuddy/5.5.4';
const QUOTA_PRODUCT_CODE = 'p_tcaca';
const GROWTH_HOST = 'https://www.workbuddy.cn';
// 未完成授权时上游返回 code=11217（login ing...），无 data 字段
const PENDING_AUTH_CODE = 11217;

const BUILTIN_MODELS = catalog.listAll();

function builtinModels() {
  return catalog.listAll();
}

function aicodeHome() {
  return process.env.AICODE_HOME || path.join(os.homedir(), '.aicode');
}

function stateDir() {
  return path.join(aicodeHome(), 'workbuddy');
}

function stateFile() {
  return path.join(stateDir(), 'state.json');
}

function exportFile() {
  return path.join(stateDir(), 'export.json');
}

function defaultState() {
  return {
    version: STATE_VERSION,
    account: null,
    quota: null,
    authSession: null,
    settings: { region: DEFAULT_REGION },
    updatedAt: 0
  };
}

function load() {
  const base = defaultState();
  let raw;
  try {
    raw = fs.readFileSync(stateFile(), 'utf8');
  } catch {
    return base;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== 'object') return base;
  const state = Object.assign(base, parsed);
  state.settings = Object.assign(defaultState().settings, parsed.settings || {});
  state.version = STATE_VERSION;
  if (!REGIONS[state.settings.region]) state.settings.region = DEFAULT_REGION;
  return state;
}

function save(state) {
  const next = Object.assign(defaultState(), state || {});
  next.version = STATE_VERSION;
  next.updatedAt = Date.now();
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function patch(partial) {
  const state = load();
  const next = Object.assign(state, partial || {});
  if (next.settings) next.settings = Object.assign(state.settings, next.settings);
  return save(next);
}

function resolveRegion(codeOrDomain) {
  const value = String(codeOrDomain || '').trim().toLowerCase();
  if (REGIONS[value]) return REGIONS[value];
  if (!value) return REGIONS[DEFAULT_REGION];
  const byDomain = Object.keys(REGIONS)
    .map((key) => REGIONS[key])
    .find((region) => region.domain === value || region.apiBase.includes(value) || value.includes(region.domain));
  return byDomain || REGIONS[DEFAULT_REGION];
}

function regionOf(state) {
  const account = state && state.account;
  if (account && account.region && REGIONS[account.region]) return REGIONS[account.region];
  return resolveRegion(state && state.settings && state.settings.region);
}

// 区域归属来自 /v3/config 快照与运行期刷新：上游用 "global:" 前缀标记国际路由，
// 裸 id 属于国内路由，同名的两侧条目是独立模型。settings.modelRegions 可按模型覆盖。
function inferModelRegions(id) {
  return catalog.regionsOf(id);
}

function modelRegions(id, settings) {
  const overrides = settings && settings.modelRegions && typeof settings.modelRegions === 'object'
    ? settings.modelRegions
    : {};
  const custom = overrides[String(id || '')];
  if (Array.isArray(custom)) {
    const valid = custom.filter((item) => REGIONS[item]);
    if (valid.length) return valid;
  }
  return inferModelRegions(id);
}

const REGION_LABELS = { domestic: '国内', international: '国外' };
const MODEL_REGION_LABELS = { domestic: '国内模型', international: '国外模型' };

function regionLabel(regions) {
  const list = (regions || []).filter((item) => REGION_LABELS[item]);
  if (!list.length) return '未标注';
  if (list.length === Object.keys(REGION_LABELS).length) return '国内外';
  return list.map((item) => REGION_LABELS[item]).join('/');
}

function modelRegionLabel(regions) {
  const list = (regions || []).filter((item) => MODEL_REGION_LABELS[item]);
  if (!list.length) return '未标注';
  if (list.length === Object.keys(MODEL_REGION_LABELS).length) return '国内外模型';
  return list.map((item) => MODEL_REGION_LABELS[item]).join('/');
}

function maskToken(token) {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 12) return `${value.slice(0, 3)}***`;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

// GMT+8 偏移若干天的日期，格式 YYYY-MM-DD
function gmt8DayOffset(days) {
  const date = new Date(Date.now() + Number(days || 0) * 86400000 + 8 * 3600000);
  return date.toISOString().slice(0, 10);
}

module.exports = {
  STATE_VERSION,
  REGIONS,
  DEFAULT_REGION,
  USER_AGENT,
  IDE_UA_GLOBAL,
  IDE_UA_DOMESTIC,
  STAINLESS,
  WEB_USER_AGENT,
  QUOTA_USER_AGENT,
  QUOTA_PRODUCT_CODE,
  GROWTH_HOST,
  PENDING_AUTH_CODE,
  BUILTIN_MODELS,
  builtinModels,
  catalog,
  aicodeHome,
  stateDir,
  stateFile,
  exportFile,
  defaultState,
  load,
  save,
  patch,
  resolveRegion,
  regionOf,
  modelRegions,
  inferModelRegions,
  regionLabel,
  REGION_LABELS,
  modelRegionLabel,
  MODEL_REGION_LABELS,
  maskToken,
  gmt8DayOffset
};