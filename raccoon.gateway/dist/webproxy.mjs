/**
 * 小浣熊网页登录的「微型浏览器」后端。
 *
 * 官方登录页没有任何 X-Frame-Options / CSP，但资源走 CDN 绝对地址、接口的会话
 * cookie 又落在 xiaohuanxiong.com 域上，直接 iframe 进来会因为第三方 cookie 与
 * 跨域脚本拿不到会话。因此这里把登录页同源代理到网关本地：页面在 127.0.0.1
 * 之下，cookie 落在本地域，接口也经这里转发，登录完成时的 302（跳到
 * office-raccoon://auth/callback?code=…）在代理层就被截住，直接换令牌入池。
 */

const BASE = 'https://xiaohuanxiong.com';
const CDN_HOSTS = ['sta-volc.xiaohuanxiong.com'];
const UA = 'Mozilla/5.0 (Linux; Android 14; Microsoft Edge 131.0.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(setCookie) {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    const pair = String(raw).split(';')[0];
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

export function clearSession() {
  jar.clear();
}

export function hasSession() {
  return jar.size > 0;
}

/**
 * 把页面里的官网绝对地址改成同源前缀，并注入一层薄适配：
 * fetch / XHR 的接口地址改走 /rp，登录完成的前端软导航改成整页跳转，
 * 这样 302 才会落到代理层被截住。
 */
function rewriteHtml(html) {
  const injected = `<script>(function(){
var B='${BASE}', P='/rp';
function api(u){
  if (typeof u !== 'string') return u;
  if (u.indexOf(B) === 0) return P + u.slice(B.length);
  if (/^\/(api|work)\//.test(u)) return P + u;
  return u;
}
var f = window.fetch;
if (f) window.fetch = function(input, init){
  try {
    if (typeof input === 'string') { var n = api(input); if (n !== input) arguments[0] = n; }
    else if (input && typeof input.url === 'string') {
      var n2 = api(input.url);
      if (n2 !== input.url) arguments[0] = new Request(n2, input);
    }
  } catch (e) {}
  return f.apply(this, arguments);
};
var open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(){
  try { var u = arguments[1]; var n = api(u); if (n !== u) arguments[1] = n; } catch (e) {}
  return open.apply(this, arguments);
};
function go(u){
  if (typeof u !== 'string') return false;
  if (u.indexOf('code/authorize') < 0 && u.indexOf('login_with') < 0) return false;
  location.href = api(u);
  return true;
}
var ps = history.pushState, pr = history.replaceState;
history.pushState = function(s, t, u){ if (go(u)) return; return ps.apply(this, arguments); };
history.replaceState = function(s, t, u){ if (go(u)) return; return pr.apply(this, arguments); };
})();</script>`;

  return html
    .replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}><base href="${BASE}/">${injected}`)
    .replace(new RegExp(`https://${BASE.replace('https://', '')}`, 'g'), '')
    .replace(/https?:\/\/sta-volc\.xiaohuanxiong\.com/g, 'https://sta-volc.xiaohuanxiong.com');
}

function upstreamHeaders(req, extra) {
  const headers = {
    'user-agent': UA,
    accept: req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'zh-CN,zh;q=0.9',
    referer: `${BASE}/`,
    ...extra,
  };
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['x-requested-with']) headers['x-requested-with'] = req.headers['x-requested-with'];
  return headers;
}

function passCookies(response, res) {
  const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (raw.length === 0) return;
  absorbCookies(raw);
  const cleaned = raw.map((item) => String(item)
    .replace(/;\s*domain=[^;]*/gi, '')
    .replace(/;\s*secure/gi, '')
    .replace(/;\s*samesite=none/gi, '')
    .replace(/;\s*samesite=strict/gi, '; SameSite=Lax'));
  res.setHeader('set-cookie', cleaned);
}

/** 授权码就是在这个 302 的 Location 里；截住它，别再让浏览器去跳自定义协议。 */
function extractCode(location) {
  if (typeof location !== 'string') return '';
  if (location.indexOf('office-raccoon://') !== 0) return '';
  const matched = location.match(/[?&]code=([^&#\s]+)/i);
  return matched ? decodeURIComponent(matched[1]) : '';
}

export async function proxy(req, res, url, options = {}) {
  const targetPath = options.path || url.pathname.replace(/^\/rp/, '') || '/';
  const search = url.search || '';
  const method = req.method || 'GET';
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = options.body !== undefined ? options.body : await readAll(req);
  }

  const response = await fetch(`${BASE}${targetPath}${search}`, {
    method,
    headers: upstreamHeaders(req, body ? {} : {}),
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });

  passCookies(response, res);

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') || '';
    const code = extractCode(location);
    if (code && options.onCode) {
      const html = await options.onCode(code);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    const rewritten = location.startsWith('/') ? `/rp${location}`
      : location.startsWith(BASE) ? `/rp${location.slice(BASE.length)}`
        : location;
    res.writeHead(response.status, { location: rewritten });
    res.end();
    return;
  }

  const type = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());

  if (type.includes('text/html')) {
    const html = rewriteHtml(buffer.toString('utf8'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }

  res.writeHead(response.status, {
    'content-type': type,
    'cache-control': response.headers.get('cache-control') || 'no-store',
  });
  res.end(buffer);
}

function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
