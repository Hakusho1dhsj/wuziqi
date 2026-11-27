'use strict';

// /v3/config 快照：国际版 www.workbuddy.ai，国内版 workbuddy.cn / codebuddy.cn / copilot.tencent.com。
// 国际条目统一带 "global:" 前缀，国内条目是裸 id；两侧同名的是独立模型而非同一模型。
const CATALOG_DOMESTIC = [
  { id: "balanced-model", name: "均衡", vendor: "f" },
  { id: "deep-model", name: "极致", vendor: "f" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", vendor: "f" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", vendor: "f" },
  { id: "fast-model", name: "快速", vendor: "f" },
  { id: "glm-5.2", name: "GLM-5.2", vendor: "e" },
  { id: "glm-5.3", name: "GLM-5.3", vendor: "e" },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", vendor: "f" },
  { id: "hy4flash-free", name: "Hy4 flash", vendor: "j" },
  { id: "hy4std", name: "Hy4", vendor: "j" },
  { id: "kimi-k2.6-preview", name: "Kimi-K2.6-Preview", vendor: "f" },
  { id: "kimi-k3-1", name: "Kimi-K3", vendor: "f" },
  { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", vendor: "f" },
  { id: "mimo-v2.6-pro", name: "Xiaomi MiMo-V2.6-Pro", vendor: "e" },
  { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", vendor: "f" },
  { id: "space-bunny", name: "Space-Bunny", vendor: "f" },
  { id: "step-5-preview", name: "Step-5-Preview", vendor: "f" }
];

const CATALOG_INTERNATIONAL = [
  { id: "global:balanced-model", name: "均衡", vendor: "f" },
  { id: "global:deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", vendor: "f" },
  { id: "global:deepseek-v4.1-flash-sg", name: "DeepSeek-V4.1-Flash-SG", vendor: "f" },
  { id: "global:default-model", name: "Auto", vendor: "e" },
  { id: "global:fast-model", name: "快速", vendor: "f" },
  { id: "global:gemini-3.8-flash", name: "Gemini-3.8-Flash", vendor: "e" },
  { id: "global:gemini-4-argon", name: "Gemini-4-Argon", vendor: "e" },
  { id: "global:gemini-4-carbon", name: "Gemini-4-Carbon", vendor: "e" },
  { id: "global:glm-5.2", name: "GLM-5.2", vendor: "e" },
  { id: "global:glm-5.3", name: "GLM-5.3", vendor: "e" },
  { id: "global:glm-5.3-flash", name: "GLM-5.3-Flash", vendor: "f" },
  { id: "global:gpt-5.4", name: "GPT-5.4", vendor: "e" },
  { id: "global:gpt-5.5", name: "GPT-5.5", vendor: "e" },
  { id: "global:gpt-5.6-luna", name: "GPT-5.6-Luna", vendor: "e" },
  { id: "global:gpt-5.6-sol", name: "GPT-5.6-Sol", vendor: "e" },
  { id: "global:gpt-5.6-terra", name: "GPT-5.6-Terra", vendor: "e" },
  { id: "global:gpt-6-astra", name: "GPT-6-Astra", vendor: "e" },
  { id: "global:gpt-6-luna", name: "GPT-6-Luna", vendor: "e" },
  { id: "global:gpt-6-sol", name: "GPT-6-Sol", vendor: "e" },
  { id: "global:gpt-6.1-sol", name: "GPT-6.1-Sol", vendor: "e" },
  { id: "global:gpt-6.1-terra", name: "GPT-6.1-Terra", vendor: "e" },
  { id: "global:gpt-6.2-astra", name: "GPT-6.2-Astra", vendor: "e" },
  { id: "global:gpt-6.2-sol", name: "GPT-6.2-Sol", vendor: "e" },
  { id: "global:grok-4.7", name: "Grok-4.7", vendor: "f" },
  { id: "global:hy3", name: "Hy3", vendor: "j" },
  { id: "global:hy4-preview", name: "Hy4 preview", vendor: "j" },
  { id: "global:hy4flash-free", name: "Hy4 flash", vendor: "j" },
  { id: "global:hy4std", name: "Hy4", vendor: "j" },
  { id: "global:kimi-k3", name: "Kimi-K3", vendor: "f" },
  { id: "global:kimi-k3.1-pro", name: "Kimi-K3.1-Pro", vendor: "f" },
  { id: "global:kimi-k3.1-pro-highspeed", name: "Kimi-K3.1-Pro-Highspeed", vendor: "f" },
  { id: "global:max-model", name: "Max", vendor: "e" },
  { id: "global:minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", vendor: "f" },
  { id: "global:primary-model", name: "Primary", vendor: "e" }
];

const SHARED_IDS = ["balanced-model", "deepseek-v4.1-flash", "fast-model", "glm-5.2", "glm-5.3", "glm-5.3-flash", "hy4flash-free", "hy4std", "kimi-k3.1-pro", "minimax-m3.1-flash"];

// 已实测可调用、但 /v3/config 的 agents 白名单里没有的模型。
// 远程目录是整体替换，不额外登记就会从客户端列表里消失。
const PINNED_MODELS = {
  domestic: [],
  international: [{ id: "global:deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", vendor: "f" }]
};

const SNAPSHOT_AT = "2026-11-19";
const REFRESH_MS = 10 * 60 * 1000;

const REGION_CODES = ['domestic', 'international'];

// 客户端可能把 "global:" 改写成 "global-"，两种都要认，否则剥不掉前缀会把整串当裸 id 发给上游。
const INTL_PREFIXES = ['global:', 'global-'];
const DOM_PREFIXES = ['cn:', 'cn-'];

const state = {
  domestic: CATALOG_DOMESTIC.slice(),
  international: CATALOG_INTERNATIONAL.slice(),
  updatedAt: { domestic: 0, international: 0 },
  source: { domestic: 'snapshot', international: 'snapshot' }
};

function normalize(list, region) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = String((item && (item.id || item.model)) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // 保留上游原始字段（maxInputTokens / supportsToolCall / tags 等），下游再按需映射；
    // 丢掉它们会让客户端拿不到上下文长度与能力标签
    out.push(Object.assign({}, item, {
      id,
      name: String(item.name || item.display_name || id),
      vendor: item.vendor ? String(item.vendor) : '',
      regions: [region]
    }));
  }
  return out;
}

function listFor(region) {
  const list = state[region] || [];
  return list.map((item) => Object.assign({}, item, { regions: regionsOf(item.id) }));
}

function listAll() {
  const merged = new Map();
  for (const region of REGION_CODES) {
    for (const item of listFor(region)) {
      const prev = merged.get(item.id);
      if (prev) {
        if (!prev.regions.includes(region)) prev.regions.push(region);
      } else {
        merged.set(item.id, Object.assign({}, item));
      }
    }
  }
  return [...merged.values()].map((item) => {
    const regions = REGION_CODES.filter((r) => item.regions.includes(r));
    return Object.assign({}, item, { regions });
  });
}

function stripRegion(id) {
  const value = String(id || '').trim();
  for (const prefix of INTL_PREFIXES) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  for (const prefix of DOM_PREFIXES) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

// 上游用 "global:" 前缀标记国际模型，裸 id 属于国内；前缀优先于目录归属。
function regionFromId(id) {
  const value = String(id || '').trim();
  if (!value) return null;
  for (const prefix of INTL_PREFIXES) {
    if (value.startsWith(prefix)) return 'international';
  }
  for (const prefix of DOM_PREFIXES) {
    if (value.startsWith(prefix)) return 'domestic';
  }
  return null;
}

function regionsOf(id) {
  const value = String(id || '').trim();
  if (!value) return REGION_CODES.slice();
  const marked = regionFromId(value);
  if (marked) return [marked];
  // 裸 id 优先精确命中裸目录；精确不中时回退到 strip 后匹配，
  // 兼顾旧客户端已有的无前缀国际 id（如 gpt-6-sol → global:gpt-6-sol）
  const exact = REGION_CODES.filter((region) => (state[region] || []).some((item) => item.id === value));
  if (exact.length) return exact;
  const fallback = REGION_CODES.filter((region) => (state[region] || []).some((item) => stripRegion(item.id) === value));
  if (fallback.length) return fallback;
  // 目录外的自定义/新模型不本地拦截，交给上游判定，避免误拒
  return REGION_CODES.slice();
}

function knows(id) {
  const value = String(id || '').trim();
  if (!value) return false;
  const bare = stripRegion(value);
  return REGION_CODES.some((region) =>
    (state[region] || []).some((item) => item.id === value || stripRegion(item.id) === bare));
}

function setRegion(region, list, source) {
  if (!REGION_CODES.includes(region)) return false;
  const normalized = normalize(list, region);
  if (!normalized.length) return false;
  const seen = new Set(normalized.map((item) => item.id));
  for (const pinned of PINNED_MODELS[region] || []) {
    if (!seen.has(pinned.id)) normalized.push(Object.assign({}, pinned, { regions: [region] }));
  }
  state[region] = normalized;
  state.updatedAt[region] = Date.now();
  state.source[region] = source || 'remote';
  return true;
}

function setState(region, list, source) { return setRegion(region, list, source); }

function stale(region, now) {
  const at = state.updatedAt[region] || 0;
  return !at || (now || Date.now()) - at > REFRESH_MS;
}

function status() {
  return {
    snapshotAt: SNAPSHOT_AT,
    counts: { domestic: (state.domestic || []).length, international: (state.international || []).length },
    updatedAt: Object.assign({}, state.updatedAt),
    source: Object.assign({}, state.source)
  };
}

// 默认模型按区域选：国内用 fast-model，国外用 default-model，两边都不是时退到该侧第一个模型。
function defaultModel(regions) {
  const list = Array.isArray(regions) && regions.length ? regions : REGION_CODES.slice();
  const pick = (region, pref) => {
    const items = state[region] || [];
    for (const id of pref) {
      if (items.some((item) => item.id === id)) return id;
    }
    return items.length ? items[0].id : null;
  };
  if (list.includes('domestic')) {
    const id = pick('domestic', ['fast-model', 'balanced-model']);
    if (id) return id;
  }
  if (list.includes('international')) {
    const id = pick('international', ['global:default-model', 'global:fast-model']);
    if (id) return id;
  }
  return 'fast-model';
}

module.exports = {
  CATALOG_DOMESTIC,
  CATALOG_INTERNATIONAL,
  SHARED_IDS,
  SNAPSHOT_AT,
  REFRESH_MS,
  REGION_CODES,
  listFor,
  listAll,
  regionsOf,
  stripRegion,
  regionFromId,
  knows,
  defaultModel,
  setState,
  stale,
  status
};
