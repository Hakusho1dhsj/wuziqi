'use strict';

function toExpiresMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e11 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}


// accessToken 是 JWT 时，exp 是唯一权威的到期时间。导入侧给的 expiresAt
// 可能是签发方写的别的字段（曾出现记成一年后，导致过期 token 永不刷新）。
function jwtExpMs(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload && payload.exp);
    if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  } catch {
    return 0;
  }
  return 0;
}

function applyJwtExp(out) {
  const exp = jwtExpMs(out.accessToken);
  if (exp) out.expiresAt = exp;
  return out;
}

function toResult(args) {
  const out = {
    accessToken: String(args.accessToken || args.access_token || '').trim(),
    refreshToken: String(args.refreshToken || args.refresh_token || '').trim(),
    uid: String(args.uid || args.user_id || '').trim(),
    nickname: String(args.nickname || args.name || '').trim(),
    domain: String(args.domain || '').trim(),
    region: String(args.region || '').trim(),
    expiresAt: toExpiresMs(args.expiresAt !== undefined ? args.expiresAt : args.expires_at)
  };
  return out;
}

/**
 * 把一个对象（可能带 account 嵌套）或 Key: Value 文本解析成凭证。
 * 返回的对象字段可能为空，由调用方判断是否可用。
 */
function parseCredentials(input) {
  const args = input && typeof input === 'object' ? input : {};
  const out = toResult(args);
  let raw = typeof args.payload === 'string' ? args.payload.trim() : '';
  if (!raw) return applyJwtExp(out);

  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    if (comma > 0) {
      const meta = raw.slice(0, comma);
      const body = raw.slice(comma + 1);
      raw = /;base64/i.test(meta) ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
    }
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === 'object') {
    // App 导出的 WorkBuddy 凭证是数组，取第一个元素
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const first = list[0] && typeof list[0] === 'object' ? list[0] : {};
    const root = first.account && typeof first.account === 'object' ? first.account : first;
    out.accessToken = out.accessToken || String(root.access_token || root.accessToken || '').trim();
    out.refreshToken = out.refreshToken || String(root.refresh_token || root.refreshToken || '').trim();
    out.uid = out.uid || String(root.uid || root.user_id || '').trim();
    out.nickname = out.nickname || String(root.nickname || root.name || '').trim();
    out.domain = out.domain || String(root.domain || '').trim();
    out.region = out.region || String(root.region || '').trim();
    const expires = root.expires_at !== undefined ? root.expires_at : root.expiresAt;
    if (!out.expiresAt && expires !== undefined) out.expiresAt = toExpiresMs(expires);
    return applyJwtExp(out);
  }

  const pairs = {};
  raw.split(/[\r\n;]+/).forEach((line) => {
    const match = line.match(/^\s*["']?([A-Za-z_]+)["']?\s*[:=]\s*["']?(.+?)["']?\s*,?\s*$/);
    if (match) pairs[match[1].toLowerCase()] = match[2].replace(/["',]\s*$/, '');
  });
  out.accessToken = out.accessToken || pairs.access_token || pairs.accesstoken || pairs.token || '';
  out.refreshToken = out.refreshToken || pairs.refresh_token || pairs.refreshtoken || '';
  out.uid = out.uid || pairs.uid || pairs.user_id || '';
  out.nickname = out.nickname || pairs.nickname || pairs.name || '';
  out.domain = out.domain || pairs.domain || '';
  out.region = out.region || pairs.region || '';
  const expiresText = pairs.expires_at || pairs.expiresat;
  if (!out.expiresAt && expiresText) out.expiresAt = toExpiresMs(expiresText);

  if (!out.accessToken) {
    const bare = raw.replace(/^Bearer\s+/i, '').trim();
    if (/^[A-Za-z0-9._-]{20,}$/.test(bare)) out.accessToken = bare;
  }
  return applyJwtExp(out);
}

function parseOneItem(item) {
  if (typeof item === 'string') return parseCredentials({ payload: item });
  if (item && typeof item === 'object') return parseCredentials(item);
  return null;
}

/**
 * 把任意形态的凭证载荷展开成多条账号，用于账号池导入。
 * 支持：对象数组、单对象、JSON 字符串（数组或对象）、Key: Value 文本。
 */
function parseCredentialList(payload) {
  if (payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) {
    return payload.map(parseOneItem).filter((item) => item && item.accessToken);
  }
  if (typeof payload === 'object') {
    const one = parseCredentials(payload);
    return one.accessToken ? [one] : [];
  }
  const text = String(payload).trim();
  if (!text) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object') return parseCredentialList(parsed);
  const lines = text.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  const looksLikePairs = lines.some((line) => /^["']?[A-Za-z_]+["']?\s*[:=]/.test(line));
  if (!looksLikePairs && lines.length > 1) {
    return lines.map(parseOneItem).filter((item) => item && item.accessToken);
  }
  const one = parseCredentials({ payload: text });
  return one.accessToken ? [one] : [];
}

module.exports = { toExpiresMs, parseCredentials, parseCredentialList };
