(function () {
  'use strict';

  var MS_API = 'https://modelscope.cn/api/v1/dolphin/mcpServers';
  var MS_PAGE_SIZE = 10;
  var MS_DETAIL = 'https://modelscope.cn/mcp/servers/';
  var GH_API = 'https://api.github.com/search/repositories';
  var GH_PAGE_SIZE = 20;

  var app = document.getElementById('app');
  var ctx = null;

  var state = {
    view: 'list',
    source: 'all',
    query: '',
    page: { modelscope: 0, github: 0 },
    hasMore: { modelscope: true, github: true },
    items: [],
    loading: false,
    errors: {},
    detail: null,
    draft: '',
    draftName: '',
    endpoint: '',
    draftDirty: false,
    scope: 'global',
    installed: { global: null, project: null },
    installedError: '',
    listScroll: 0,
    restoreScroll: false,
    form: null,
    formError: '',
    ghToken: '',
    tokenSaved: false
  };

  var toastTimer = null;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function safeName(raw) {
    var name = String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
    return name || 'mcp-server';
  }

  function dirname(path) {
    var i = path.lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : path;
  }

  function md(text) {
    var src = String(text || '');
    if (!src) return '';
    var parts = src.split(/^[ \t]*```/m);
    var html = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var seg = parts[i];
        var nl = seg.indexOf('\n');
        var code = nl >= 0 ? seg.slice(nl + 1) : seg;
        html += '<pre><code>' + esc(code.replace(/\n+$/, '')) + '</code></pre>';
      } else {
        html += mdBlocks(parts[i]);
      }
    }
    return html;
  }

  function mdBlocks(text) {
    var lines = String(text || '').split(/\r?\n/);
    var out = '';
    var inList = false;
    var buf = [];

    function flushPara() {
      if (buf.length) {
        out += '<p>' + mdInline(buf.join(' ')) + '</p>';
        buf = [];
      }
    }

    function closeList() {
      if (inList) {
        out += '</ul>';
        inList = false;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) {
        flushPara();
        closeList();
        continue;
      }
      if (/^<[a-zA-Z!/]/.test(line)) {
        flushPara();
        closeList();
        continue;
      }
      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushPara();
        closeList();
        var level = Math.min(heading[1].length + 2, 6);
        out += '<h' + level + '>' + mdInline(heading[2]) + '</h' + level + '>';
        continue;
      }
      var bullet = /^[-*+]\s+(.*)$/.exec(line) || /^\d+[.)]\s+(.*)$/.exec(line);
      if (bullet) {
        flushPara();
        if (!inList) {
          out += '<ul>';
          inList = true;
        }
        out += '<li>' + mdInline(bullet[1]) + '</li>';
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        flushPara();
        closeList();
        continue;
      }
      buf.push(line);
    }
    flushPara();
    closeList();
    return out;
  }

  function mdInline(text) {
    var out = esc(text);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    out = out.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>');
    return out;
  }

  function toast(message) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (el.parentNode) el.remove();
    }, 2400);
  }

  function bridge() {
    if (!window.aicode || typeof window.aicode.http.request !== 'function') {
      return null;
    }
    return window.aicode;
  }

  function httpJson(options) {
    var api = bridge();
    if (!api) return Promise.reject(new Error('页面桥不可用，请重新打开页面'));
    return api.http.request(options).then(function (res) {
      var body = typeof res.body === 'string' ? res.body : '';
      var payload = null;
      try {
        payload = body ? JSON.parse(body) : null;
      } catch (e) {
        payload = null;
      }
      return { status: res.status, headers: res.headers || {}, body: body, json: payload, truncated: !!res.truncated };
    });
  }

  function hasWorkspace() {
    return !!(ctx && ctx.workspace);
  }

  function configPath(scope) {
    if (!ctx) return Promise.reject(new Error('上下文尚未就绪'));
    if (scope === 'project' && !ctx.workspace) {
      return Promise.reject(new Error('当前没有工作区，无法写入项目级配置'));
    }
    return Promise.resolve(scope === 'project'
      ? ctx.workspace + '/.aicode/mcp.json'
      : ctx.home + '/.aicode/mcp.json');
  }

  async function readConfig(scope) {
    var api = bridge();
    var path = await configPath(scope);
    var stat = await api.fs.stat(path);
    if (!stat.exists) return { path: path, data: { mcpServers: {} } };
    var file = await api.fs.read(path);
    var data;
    try {
      data = JSON.parse(file.content || '{}');
    } catch (e) {
      throw new Error('现有配置文件不是合法 JSON，已停止写入：' + path);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
    return { path: path, data: data };
  }

  async function ensureParent(path) {
    var api = bridge();
    var dir = dirname(path);
    var stat = await api.fs.stat(dir);
    if (stat.exists) {
      if (!stat.isDir) throw new Error('配置目录路径被占用：' + dir);
      return;
    }
    await api.fs.mkdir(dir);
  }

  async function writeConfig(scope, data) {
    var api = bridge();
    var path = await configPath(scope);
    await ensureParent(path);
    await api.fs.write(path, JSON.stringify(data, null, 2) + '\n');
    return path;
  }

  async function addServers(scope, servers) {
    var conf = await readConfig(scope);
    var names = Object.keys(servers);
    for (var i = 0; i < names.length; i++) {
      conf.data.mcpServers[names[i]] = servers[names[i]];
    }
    var path = await writeConfig(scope, conf.data);
    await refreshInstalled();
    return { path: path, names: names };
  }

  async function removeServer(scope, name) {
    var conf = await readConfig(scope);
    delete conf.data.mcpServers[name];
    await writeConfig(scope, conf.data);
    await refreshInstalled();
  }

  async function refreshInstalled() {
    var api = bridge();
    if (!api) return;
    try {
      var global = await readConfig('global');
      var project = { path: '', data: { mcpServers: {} } };
      if (ctx && ctx.workspace) {
        try {
          project = await readConfig('project');
        } catch (e) {
          project = { path: '', data: { mcpServers: {} } };
        }
      }
      state.installed = { global: global, project: project };
      state.installedError = '';
    } catch (e) {
      state.installed = { global: null, project: null };
      state.installedError = e.message || String(e);
    }
  }

  function installedNames() {
    var names = {};
    var scopes = ['global', 'project'];
    for (var i = 0; i < scopes.length; i++) {
      var conf = state.installed[scopes[i]];
      if (!conf) continue;
      var servers = conf.data.mcpServers || {};
      for (var key in servers) {
        if (Object.prototype.hasOwnProperty.call(servers, key)) names[key] = true;
      }
    }
    return names;
  }

  function normalizeMs(server) {
    var name = String(server.Name || '');
    var path = String(server.Path || '');
    var readme = server.ReadmeCN || server.Readme || '';
    return {
      key: 'ms:' + (server.Id || path + '/' + name),
      source: 'modelscope',
      name: name,
      title: server.ChineseName || name,
      desc: server.AbstractCN || server.Abstract || '',
      author: path,
      avatar: server.FromSiteIcon || '',
      url: MS_DETAIL + path + '/' + name,
      hosted: !!server.Hosted,
      verified: !!server.Verifed,
      stars: Number(server.Stars) || 0,
      calls: Number(server.CallVolume) || 0,
      category: Array.isArray(server.Category) ? server.Category : [],
      license: server.License || '',
      serverConfig: server.ServerConfig || null,
      envSchema: server.EnvSchema || null,
      tools: Array.isArray(server.Tools) ? server.Tools.slice(0, 40) : [],
      readme: String(readme).slice(0, 20000),
      deployedUrl: server.DeployedUrl || '',
      transports: Array.isArray(server.SupportedDeployTransportType) ? server.SupportedDeployTransportType : []
    };
  }

  function normalizeGh(repo) {
    var owner = repo.owner || {};
    return {
      key: 'gh:' + repo.full_name,
      source: 'github',
      name: String(repo.name || ''),
      title: String(repo.name || ''),
      desc: repo.description || '',
      author: owner.login || '',
      url: repo.html_url || '',
      hosted: false,
      verified: false,
      stars: Number(repo.stargazers_count) || 0,
      calls: 0,
      category: Array.isArray(repo.topics) ? repo.topics.slice(0, 6) : [],
      license: repo.license && repo.license.spdx_id ? repo.license.spdx_id : '',
      repo: repo.full_name || '',
      language: repo.language || '',
      updated: repo.pushed_at || '',
      avatar: owner.avatar_url || '',
      readme: ''
    };
  }

  async function loadModelscope(reset) {
    if (reset) {
      state.page.modelscope = 0;
      state.hasMore.modelscope = true;
    }
    var page = state.page.modelscope + 1;
    var res = await httpJson({
      url: MS_API,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ PageNumber: page, PageSize: MS_PAGE_SIZE, Query: state.query.trim() }),
      timeout: 30
    });
    if (res.status !== 200 || !res.json || !res.json.Data) {
      throw new Error('魔搭返回 ' + res.status + (res.json && res.json.Message ? '：' + res.json.Message : ''));
    }
    var block = res.json.Data.McpServer || {};
    var list = Array.isArray(block.McpServers) ? block.McpServers : [];
    state.page.modelscope = page;
    state.hasMore.modelscope = list.length >= MS_PAGE_SIZE;
    return list.map(normalizeMs);
  }

  async function loadGithub(reset) {
    if (reset) {
      state.page.github = 1;
      state.hasMore.github = true;
    }
    var term = state.query.trim();
    var q = term
      ? term + ' mcp in:name,description'
      : 'topic:mcp-server';
    var headers = { 'Accept': 'application/vnd.github+json' };
    if (state.ghToken) headers['Authorization'] = 'Bearer ' + state.ghToken;
    var page = reset ? 1 : state.page.github;
    var res = await httpJson({
      url: GH_API + '?q=' + encodeURIComponent(q) + '&sort=stars&order=desc&per_page=' + GH_PAGE_SIZE + '&page=' + page,
      method: 'GET',
      headers: headers,
      timeout: 30
    });
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub 接口限流（403/429）。在「设置」里填入 GitHub Token 可提升额度');
    }
    if (res.status !== 200 || !res.json) {
      throw new Error('GitHub 返回 ' + res.status + (res.json && res.json.message ? '：' + res.json.message : ''));
    }
    var items = Array.isArray(res.json.items) ? res.json.items : [];
    state.page.github = page + 1;
    state.hasMore.github = items.length >= GH_PAGE_SIZE;
    return items.map(normalizeGh);
  }

  async function runSearch(reset) {
    if (state.loading) return;
    if (reset) {
      state.items = [];
      state.errors = {};
      state.hasMore = { modelscope: true, github: true };
      state.page = { modelscope: 0, github: 0 };
    }
    state.loading = true;
    state.restoreScroll = false;
    render();
    if (reset) window.scrollTo(0, 0);
    var jobs = [];
    if (state.source !== 'github' && state.hasMore.modelscope) {
      jobs.push(loadModelscope(reset).then(function (rows) {
        state.items = state.items.concat(rows);
        delete state.errors.modelscope;
      }).catch(function (err) {
        state.errors.modelscope = err.message || String(err);
      }));
    }
    if (state.source !== 'modelscope' && state.hasMore.github) {
      jobs.push(loadGithub(reset).then(function (rows) {
        state.items = state.items.concat(rows);
        delete state.errors.github;
      }).catch(function (err) {
        state.errors.github = err.message || String(err);
      }));
    }
    await Promise.all(jobs);
    state.loading = false;
    render();
  }

  function extractServers(config) {
    var blocks = Array.isArray(config) ? config : [config];
    var out = {};
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block && block.mcpServers && typeof block.mcpServers === 'object') {
        for (var key in block.mcpServers) {
          if (Object.prototype.hasOwnProperty.call(block.mcpServers, key)) {
            out[key] = block.mcpServers[key];
          }
        }
      }
    }
    return out;
  }

  function guessPackage(item) {
    var repoName = String(item.name || '').toLowerCase();
    var owner = String(item.author || '').toLowerCase();
    if (repoName.indexOf('mcp-server-') === 0) return repoName;
    if (owner && repoName.indexOf('mcp') === -1) return '@' + owner + '/' + repoName;
    return repoName;
  }

  function npmLatestUrl(name) {
    return 'https://registry.npmjs.org/' + encodeURIComponent(name) + '/latest';
  }

  async function probeNpm(name) {
    try {
      var res = await httpJson({ url: npmLatestUrl(name), method: 'GET', timeout: 15 });
      if (res.status === 200 && res.json) {
        return { exists: true, name: String(res.json.name || name), version: String(res.json.version || '') };
      }
      if (res.status === 404) return { exists: false, name: name, version: '' };
    } catch (e) {
      return { exists: null, name: name, version: '' };
    }
    return { exists: null, name: name, version: '' };
  }

  async function resolveGithubItem(item) {
    if (item.source !== 'github' || item.pkgState === 'loading' || item.pkgState === 'ok' || item.pkgState === 'missing') return;
    item.pkgState = 'loading';
    if (state.detail === item) render();

    var candidate = guessPackage(item);
    try {
      var raw = await httpJson({
        url: 'https://raw.githubusercontent.com/' + item.repo + '/HEAD/package.json',
        method: 'GET',
        timeout: 15
      });
      if (raw.status === 200 && raw.json && raw.json.name) {
        var declared = String(raw.json.name).trim();
        if (/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(declared)) candidate = declared;
      }
    } catch (e) {
      /* 读不到就继续用推测名去 npm 核对 */
    }

    var probe = await probeNpm(candidate);
    item.npmName = probe.name || candidate;
    item.npmVersion = probe.version || '';
    item.pkgState = probe.exists === true ? 'ok' : probe.exists === false ? 'missing' : 'unknown';

    if (state.detail === item) {
      if (!state.draftDirty) {
        state.draft = JSON.stringify({ mcpServers: draftServers(item, state.endpoint) }, null, 2);
      }
      render();
    }
  }

  function draftServers(item, endpoint) {
    if (endpoint) {
      var map = {};
      map[safeName(item.name)] = { url: endpoint };
      return map;
    }
    if (item.source === 'modelscope' && item.serverConfig) {
      var servers = extractServers(item.serverConfig);
      if (Object.keys(servers).length) return servers;
    }
    var single = {};
    single[safeName(item.name)] = { command: 'npx', args: ['-y', item.npmName || guessPackage(item)] };
    return single;
  }

  function openDetail(item) {
    state.view = 'detail';
    state.detail = item;
    state.endpoint = item.deployedUrl || '';
    state.scope = 'global';
    state.draft = JSON.stringify({ mcpServers: draftServers(item, state.endpoint) }, null, 2);
    state.draftDirty = false;
    state.listScroll = window.scrollY;
    render();
    resolveGithubItem(item);
  }

  function backToList() {
    state.view = 'list';
    state.detail = null;
    state.restoreScroll = true;
    render();
  }

  async function submitDraft() {
    var parsed;
    try {
      parsed = JSON.parse(state.draft);
    } catch (e) {
      toast('JSON 格式有误：' + e.message);
      return;
    }
    var servers = parsed && parsed.mcpServers ? parsed.mcpServers : parsed;
    if (!servers || typeof servers !== 'object' || !Object.keys(servers).length) {
      toast('配置里没有 mcpServers 条目');
      return;
    }
    try {
      var result = await addServers(state.scope, servers);
      toast('已添加 ' + result.names.join('、') + '\n写入 ' + result.path + '\n新会话生效');
      backToList();
    } catch (e) {
      toast('写入失败：' + (e.message || e));
    }
  }

  async function quickAdd(item) {
    var servers = draftServers(item, item.deployedUrl || '');
    try {
      var result = await addServers('global', servers);
      toast('已添加 ' + result.names.join('、') + '\n新会话生效');
      render();
    } catch (e) {
      toast('写入失败：' + (e.message || e));
    }
  }

  async function copyText(text) {
    var api = bridge();
    try {
      await api.clipboard.write(text);
      toast('已复制到剪贴板');
    } catch (e) {
      toast('复制失败：' + (e.message || e));
    }
  }

  function openExternal(url) {
    var api = bridge();
    if (api && url) api.ui.openUrl(url).catch(function () {});
  }

  function renderHeader() {
    var title = 'MCP 市场';
    var sub = '';
    if (state.view === 'detail') {
      title = '详情';
      sub = state.detail ? state.detail.source === 'modelscope' ? '魔搭' : 'GitHub' : '';
    } else if (state.view === 'custom') {
      title = '自定义服务器';
    } else if (state.view === 'installed') {
      title = '已添加';
    } else if (state.view === 'settings') {
      title = '设置';
    } else if (state.items.length) {
      sub = state.items.length + ' 条';
    }
    return '<header class="bar">' +
      (state.view === 'list' ? '' : '<button class="iconbtn" data-act="back-top">‹</button>') +
      '<h1>' + esc(title) + (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</h1>' +
      (state.view === 'list'
        ? '<button class="iconbtn" data-act="open-custom">＋</button><button class="iconbtn" data-act="open-settings">⚙</button>'
        : '') +
      '</header>';
  }

  function renderTabs() {
    var tabs = [
      { id: 'all', label: '全部' },
      { id: 'modelscope', label: '魔搭' },
      { id: 'github', label: 'GitHub' },
      { id: 'installed', label: '已添加' }
    ];
    var html = '<div class="tabs">';
    for (var i = 0; i < tabs.length; i++) {
      html += '<button class="tab' + (state.source === tabs[i].id ? ' on' : '') +
        '" data-act="switch-source" data-source="' + tabs[i].id + '">' + tabs[i].label + '</button>';
    }
    html += '</div>';
    return html;
  }

  function renderSearch() {
    return '<div class="searchrow">' +
      '<input id="q" type="search" placeholder="搜索 MCP 服务器（仅魔搭与 GitHub）" value="' + esc(state.query) + '">' +
      '<button class="btn" data-act="search"' + (state.loading ? ' disabled' : '') + '>搜索</button>' +
      '</div>';
  }

  function renderErrors() {
    var html = '';
    if (state.errors.modelscope) {
      html += '<div class="hintbar err">魔搭：' + esc(state.errors.modelscope) + '</div>';
    }
    if (state.errors.github) {
      html += '<div class="hintbar err">GitHub：' + esc(state.errors.github) + '</div>';
    }
    return html;
  }

  function sourceBadge(item) {
    return item.source === 'modelscope'
      ? '<span class="badge ms">魔搭</span>'
      : '<span class="badge gh">GitHub</span>';
  }

  function orderedItems() {
    if (state.source !== 'all') return state.items;
    var ms = [];
    var gh = [];
    for (var i = 0; i < state.items.length; i++) {
      (state.items[i].source === 'modelscope' ? ms : gh).push(state.items[i]);
    }
    var out = [];
    var max = Math.max(ms.length, gh.length);
    for (var j = 0; j < max; j++) {
      if (ms[j]) out.push(ms[j]);
      if (gh[j]) out.push(gh[j]);
    }
    return out;
  }

  function renderCard(item) {
    var added = installedNames();
    var servers = draftServers(item, item.deployedUrl || '');
    var isAdded = Object.keys(servers).some(function (name) { return added[name]; });
    var meta = [];
    if (item.author) {
      var author = String(item.author);
      meta.push(author.charAt(0) === '@' ? author : '@' + author);
    }
    if (item.stars) meta.push('★ ' + fmtCount(item.stars));
    if (item.calls) meta.push('调用 ' + fmtCount(item.calls));
    if (item.language) meta.push(esc(item.language));
    var initial = (item.title || item.name || 'M').trim().charAt(0).toUpperCase();
    var avatar = item.avatar
      ? '<img class="avatar-img" src="' + esc(item.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-letter="' + esc(initial) + '">'
      : esc(initial);
    return '<article class="card" data-act="open-detail" data-key="' + esc(item.key) + '">' +
      '<div class="avatar">' + avatar + '</div>' +
      '<div class="body">' +
      '<div class="titleline"><span class="name">' + esc(item.title) + '</span>' +
      sourceBadge(item) +
      (item.hosted ? '<span class="badge hosted">Hosted</span>' : '') +
      (isAdded ? '<span class="badge added">已添加</span>' : '') +
      '</div>' +
      '<div class="desc">' + esc(item.desc || '暂无描述') + '</div>' +
      '<div class="meta">' + meta.map(esc).join('<span>·</span>') + '</div>' +
      '</div>' +
      '<button class="iconbtn" data-act="quick-add" data-key="' + esc(item.key) + '" title="添加">＋</button>' +
      '</article>';
  }

  function renderList() {
    var html = renderHeader() + renderTabs() + renderSearch() + renderErrors();
    if (state.loading && !state.items.length) {
      return html + '<div class="loading"><span class="spinner"></span>正在搜索…</div>';
    }
    if (!state.items.length) {
      return html + '<div class="empty">还没有结果<br>输入关键词搜索，或直接点击搜索看热门 MCP 服务器<br>数据只来自魔搭社区与 GitHub</div>';
    }
    var seen = {};
    var cards = '';
    var ordered = orderedItems();
    for (var i = 0; i < ordered.length; i++) {
      if (seen[ordered[i].key]) continue;
      seen[ordered[i].key] = true;
      cards += renderCard(ordered[i]);
    }
    html += '<div class="list">' + cards + '</div>';
    if (state.loading) {
      html += '<div class="loading"><span class="spinner"></span>加载中…</div>';
    } else if (state.hasMore.modelscope || state.hasMore.github) {
      html += '<div class="list"><button class="btn ghost" data-act="more">加载更多</button></div>';
    } else {
      html += '<div class="footer-note">已经到底了</div>';
    }
    return html;
  }

  function envHint(item) {
    var schema = item.envSchema;
    if (!schema || !schema.properties) return '';
    var keys = Object.keys(schema.properties);
    if (!keys.length) return '';
    var required = Array.isArray(schema.required) ? schema.required : [];
    var rows = '';
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var prop = schema.properties[key] || {};
      var mark = required.indexOf(key) >= 0 ? '（必填）' : '';
      rows += '<li><strong>' + esc(key) + '</strong>' + mark +
        (prop.description ? ' · ' + esc(prop.description) : '') + '</li>';
    }
    return '<div class="hintbar" style="margin:0 0 10px">这个服务器需要环境变量，添加后在下方向应的 env 里填值：' +
      '<ul style="margin:6px 0 0;padding-left:18px">' + rows + '</ul></div>';
  }

  function renderDetail() {
    var item = state.detail;
    if (!item) return renderList();
    var html = renderHeader();
    var chips = [];
    if (item.author) chips.push(item.author);
    if (item.license) chips.push(item.license);
    if (item.language) chips.push(item.language);
    if (Array.isArray(item.category)) {
      for (var c = 0; c < item.category.length; c++) chips.push(item.category[c]);
    }
    if (item.updated) chips.push('更新 ' + String(item.updated).slice(0, 10));

    html += '<div class="detail">';
    html += '<h2>' + esc(item.title) + ' ' + sourceBadge(item) + '</h2>';
    html += '<div class="path">' + esc(item.name) + (item.author ? ' · ' + esc(item.author) : '') + '</div>';
    if (chips.length) {
      html += '<div class="chips">' + chips.map(function (x) { return '<span class="chip">' + esc(x) + '</span>'; }).join('') + '</div>';
    }
    html += '<div class="panel" style="margin-top:12px">' + md(item.desc || '暂无描述') + '</div>';

    var scopeSwitch = hasWorkspace()
      ? '<div class="field"><label>作用域</label><div class="segmented">' +
        '<button class="' + (state.scope === 'global' ? 'on' : '') + '" data-act="set-scope" data-scope="global">全局</button>' +
        '<button class="' + (state.scope === 'project' ? 'on' : '') + '" data-act="set-scope" data-scope="project">当前项目</button>' +
        '</div></div>'
      : '';
    html += '<div class="section"><h3>接入配置</h3>' + scopeSwitch;

    if (item.source === 'modelscope' && item.hosted) {
      html += '<div class="field"><label>托管服务地址（可选，填了就用远程 URL 接入）</label>' +
        '<input id="endpoint" type="url" placeholder="https://…/sse" value="' + esc(state.endpoint) + '"></div>';
    }

    html += envHint(item);
    if (item.source === 'github') {
      if (item.pkgState === 'loading') {
        html += '<div class="hintbar">正在核对 npm 包名…</div>';
      } else if (item.pkgState === 'ok') {
        html += '<div class="hintbar ok">npm 包已确认：' + esc(item.npmName) +
          (item.npmVersion ? ' v' + esc(item.npmVersion) : '') + '</div>';
      } else if (item.pkgState === 'missing') {
        html += '<div class="hintbar err">npm 上找不到 ' + esc(item.npmName) +
          '，按这个配置大概率连不上。请到仓库 README 里核对正确的包名或启动命令。</div>';
      } else if (item.pkgState === 'unknown') {
        html += '<div class="hintbar">未能确认包名，添加前请核对仓库的安装说明。</div>';
      }
    }
    html += '<div class="field"><label>mcp.json 片段（可编辑）</label>' +
      '<textarea id="draft" spellcheck="false">' + esc(state.draft) + '</textarea></div>' +
      '<div class="scope-row">写入 ' + esc(state.scope === 'project' ? '当前项目' : '全局') + '配置 mcp.json，新会话生效</div>' +
      '<div class="actions">' +
      '<button class="btn" data-act="submit-draft">添加</button>' +
      '<button class="btn ghost" data-act="copy-draft">复制配置</button>' +
      '<button class="btn ghost" data-act="open-repo">打开来源页</button>' +
      '</div></div>';

    if (item.tools && item.tools.length) {
      html += '<div class="section"><h3>工具 ' + item.tools.length + '</h3><div class="panel">';
      for (var t = 0; t < item.tools.length; t++) {
        var tool = item.tools[t] || {};
        html += '<div class="tool"><div class="tname">' + esc(tool.name) + '</div>' +
          (tool.description ? '<div class="tdesc">' + esc(tool.description) + '</div>' : '') + '</div>';
      }
      html += '</div></div>';
    }

    if (item.readme) {
      html += '<div class="section"><h3>说明文档</h3><div class="panel">' + md(item.readme) + '</div></div>';
    }

    html += '</div>';
    return html;
  }

  function emptyForm() {
    return { name: '', type: 'stdio', command: 'npx', args: '-y mcp-server-fetch', env: '', url: '', headers: '', scope: 'global' };
  }

  function renderCustom() {
    var form = state.form || emptyForm();
    var html = renderHeader();
    html += '<div class="detail">';
    html += '<div class="panel">手动填写一个 MCP 服务器，直接写入配置文件。' +
      '远程服务用 HTTP（streamable HTTP / SSE 地址），本地进程用 stdio 命令。</div>';

    html += '<div class="field"><label>名称</label><input id="f-name" placeholder="my-server" value="' + esc(form.name) + '"></div>';
    html += '<div class="field"><label>类型</label><div class="segmented">' +
      '<button class="' + (form.type === 'stdio' ? 'on' : '') + '" data-act="set-type" data-type="stdio">stdio</button>' +
      '<button class="' + (form.type === 'http' ? 'on' : '') + '" data-act="set-type" data-type="http">HTTP</button>' +
      '</div></div>';

    if (form.type === 'stdio') {
      html += '<div class="field"><label>命令</label><input id="f-command" placeholder="npx" value="' + esc(form.command) + '"></div>';
      html += '<div class="field"><label>参数（空格分隔）</label><input id="f-args" placeholder="-y @scope/pkg" value="' + esc(form.args) + '"></div>';
      html += '<div class="field"><label>环境变量（每行 KEY=VALUE）</label><textarea id="f-env" spellcheck="false">' + esc(form.env) + '</textarea></div>';
    } else {
      html += '<div class="field"><label>服务地址</label><input id="f-url" placeholder="https://example.com/mcp" value="' + esc(form.url) + '"></div>';
      html += '<div class="field"><label>请求头（每行 KEY: VALUE）</label><textarea id="f-headers" spellcheck="false">' + esc(form.headers) + '</textarea></div>';
    }

    var formScope = hasWorkspace()
      ? '<div class="field"><label>作用域</label><div class="segmented">' +
        '<button class="' + (form.scope === 'global' ? 'on' : '') + '" data-act="set-form-scope" data-scope="global">全局</button>' +
        '<button class="' + (form.scope === 'project' ? 'on' : '') + '" data-act="set-form-scope" data-scope="project">当前项目</button>' +
        '</div></div>'
      : '';
    html += formScope;

    if (state.formError) html += '<div class="hintbar err">' + esc(state.formError) + '</div>';

    html += '<div class="actions"><button class="btn" data-act="save-custom">保存到配置</button>' +
      '<button class="btn ghost" data-act="back-list">取消</button></div>';
    html += '</div>';
    return html;
  }

  function parseLines(text, sep) {
    var out = {};
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var idx = line.indexOf(sep);
      if (idx <= 0) continue;
      var key = line.slice(0, idx).trim();
      var value = line.slice(idx + sep.length).trim();
      if (!key) continue;
      out[key] = value;
    }
    return out;
  }

  async function saveCustom() {
    var form = state.form || emptyForm();
    var name = safeName(form.name);
    if (!form.name.trim()) {
      state.formError = '请填写名称';
      render();
      return;
    }
    var config = {};
    if (form.type === 'stdio') {
      if (!form.command.trim()) {
        state.formError = '请填写命令';
        render();
        return;
      }
      config.command = form.command.trim();
      var args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
      if (args.length) config.args = args;
      var env = parseLines(form.env, '=');
      if (Object.keys(env).length) config.env = env;
    } else {
      if (!/^https?:\/\//.test(form.url.trim())) {
        state.formError = '请填写 http/https 地址';
        render();
        return;
      }
      config.url = form.url.trim();
      var headers = parseLines(form.headers, ':');
      if (Object.keys(headers).length) config.headers = headers;
    }
    var servers = {};
    servers[name] = config;
    try {
      var result = await addServers(form.scope, servers);
      state.form = emptyForm();
      state.formError = '';
      toast('已添加 ' + name + '\n新会话生效');
      state.view = 'installed';
      render();
    } catch (e) {
      state.formError = '写入失败：' + (e.message || e);
      render();
    }
  }

  function describeConfig(config) {
    if (!config || typeof config !== 'object') return '';
    if (config.url) return 'HTTP · ' + config.url;
    if (config.command) {
      var args = Array.isArray(config.args) ? config.args.join(' ') : '';
      return 'stdio · ' + config.command + (args ? ' ' + args : '');
    }
    return '未识别的配置';
  }

  function renderInstalled() {
    var html = renderHeader();
    html += '<div class="list">';
    if (state.installedError) {
      html += '<div class="hintbar err">' + esc(state.installedError) + '</div>';
    }
    var scopes = [
      { id: 'global', label: '全局', conf: state.installed.global }
    ];
    if (hasWorkspace()) scopes.push({ id: 'project', label: '当前项目', conf: state.installed.project });
    var total = 0;
    for (var s = 0; s < scopes.length; s++) {
      var conf = scopes[s].conf;
      if (!conf) continue;
      var servers = conf.data.mcpServers || {};
      var names = Object.keys(servers);
      total += names.length;
      html += '<div class="section"><h3>' + esc(scopes[s].label) + ' · ' + names.length + '</h3>';
      if (!names.length) {
        html += '<div class="empty" style="padding:18px">暂无</div>';
      } else {
        for (var i = 0; i < names.length; i++) {
          var n = names[i];
          html += '<div class="card" style="cursor:default">' +
            '<div class="avatar">' + esc(n.charAt(0).toUpperCase()) + '</div>' +
            '<div class="body"><div class="titleline"><span class="name">' + esc(n) + '</span></div>' +
            '<div class="desc">' + esc(describeConfig(servers[n])) + '</div>' +
            '<div class="meta"><span>' + esc(conf.path) + '</span></div></div>' +
            '<button class="iconbtn" data-act="remove-server" data-scope="' + scopes[s].id + '" data-name="' + esc(n) + '">🗑</button>' +
            '</div>';
        }
      }
      html += '</div>';
    }
    if (!state.installed.global && !state.installed.project) {
      html += '<div class="empty">还没有可读的 MCP 配置</div>';
    } else if (!total) {
      html += '<div class="empty">还没有添加任何 MCP 服务器</div>';
    }
    html += '</div>';
    html += '<div class="footer-note">修改后需要新会话才会加载新服务器</div>';
    return html;
  }

  function renderSettings() {
    var html = renderHeader();
    html += '<div class="detail">';
    html += '<div class="section"><h3>GitHub Token（可选）</h3>' +
      '<div class="panel">不填也能搜索，但 GitHub 匿名接口约 10 次/分钟，容易限流。' +
      '填入个人访问令牌后额度提升到 30 次/分钟的搜索请求。令牌保存在插件私有加密存储中。</div>' +
      '<div class="field"><label>' + (state.tokenSaved ? '已保存（留空不修改）' : '未设置') + '</label>' +
      '<input id="f-token" type="password" placeholder="ghp_…" value=""></div>' +
      '<div class="actions"><button class="btn sm" data-act="save-token">保存</button>' +
      '<button class="btn ghost sm" data-act="clear-token">清除</button></div></div>';

    html += '<div class="section"><h3>数据来源</h3><div class="panel">' +
      '<p><strong>魔搭社区</strong>：MCP 广场的公开列表接口，含托管与本地两类服务器、工具清单与接入配置。</p>' +
      '<p><strong>GitHub</strong>：仓库搜索接口，用 topic:mcp-server 与关键词筛选仓库。</p>' +
      '<p>不接入其他 MCP 目录，搜索范围只有这两个来源。</p></div></div>';

    html += '<div class="section"><h3>配置位置</h3><div class="panel">' +
      '<p>全局：' + esc(ctx ? ctx.home + '/.aicode/mcp.json' : '~/.aicode/mcp.json') + '</p>' +
      '<p>项目：' + esc(ctx ? ctx.workspace + '/.aicode/mcp.json' : '<工作区>/.aicode/mcp.json') + '</p></div></div>';

    html += '</div>';
    return html;
  }

  function render() {
    var html = '';
    if (state.view === 'detail') html = renderDetail();
    else if (state.view === 'custom') html = renderCustom();
    else if (state.view === 'installed') html = renderInstalled();
    else if (state.view === 'settings') html = renderSettings();
    else html = renderList();
    app.innerHTML = '<div class="page">' + html + '</div>';
    if (state.restoreScroll) {
      state.restoreScroll = false;
      window.scrollTo(0, state.listScroll || 0);
    } else if (state.view !== 'list') {
      window.scrollTo(0, 0);
    }
  }

  function findItem(key) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].key === key) return state.items[i];
    }
    return null;
  }

  app.addEventListener('click', function (event) {
    var target = event.target.closest('[data-act]');
    if (!target) {
      var link = event.target.closest('a[href]');
      if (link && /^https?:/i.test(link.getAttribute('href'))) {
        event.preventDefault();
        openExternal(link.getAttribute('href'));
      }
      return;
    }
    var act = target.getAttribute('data-act');

    if (act === 'search') {
      runSearch(true);
    } else if (act === 'more') {
      runSearch(false);
    } else if (act === 'switch-source') {
      var source = target.getAttribute('data-source');
      if (source === 'installed') {
        state.view = 'installed';
        render();
        refreshInstalled().then(render);
        return;
      }
      if (source !== state.source) {
        state.source = source;
        runSearch(true);
      }
    } else if (act === 'open-detail') {
      var item = findItem(target.getAttribute('data-key'));
      if (item) openDetail(item);
    } else if (act === 'quick-add') {
      event.stopPropagation();
      var quickItem = findItem(target.getAttribute('data-key'));
      if (quickItem) quickAdd(quickItem);
    } else if (act === 'back-top') {
      backToList();
    } else if (act === 'back-list') {
      backToList();
    } else if (act === 'open-custom') {
      state.form = state.form || emptyForm();
      state.formError = '';
      state.view = 'custom';
      render();
    } else if (act === 'open-settings') {
      state.view = 'settings';
      render();
    } else if (act === 'set-scope') {
      state.scope = target.getAttribute('data-scope');
      render();
    } else if (act === 'submit-draft') {
      submitDraft();
    } else if (act === 'copy-draft') {
      copyText(state.draft);
    } else if (act === 'open-repo') {
      if (state.detail) openExternal(state.detail.url);
    } else if (act === 'set-type') {
      var form = state.form || emptyForm();
      form.type = target.getAttribute('data-type');
      state.form = form;
      render();
    } else if (act === 'set-form-scope') {
      var f = state.form || emptyForm();
      f.scope = target.getAttribute('data-scope');
      state.form = f;
      render();
    } else if (act === 'save-custom') {
      saveCustom();
    } else if (act === 'remove-server') {
      var scope = target.getAttribute('data-scope');
      var name = target.getAttribute('data-name');
      removeServer(scope, name).then(function () {
        toast('已移除 ' + name);
        render();
      }).catch(function (e) {
        toast('移除失败：' + (e.message || e));
      });
    } else if (act === 'save-token') {
      var input = document.getElementById('f-token');
      var value = input ? input.value.trim() : '';
      if (!value) {
        toast('请输入 Token');
        return;
      }
      bridge().secrets.set('github_token', value).then(function () {
        state.ghToken = value;
        state.tokenSaved = true;
        toast('已保存 GitHub Token');
        render();
      }).catch(function (e) {
        toast('保存失败：' + (e.message || e));
      });
    } else if (act === 'clear-token') {
      bridge().secrets.delete('github_token').then(function () {
        state.ghToken = '';
        state.tokenSaved = false;
        toast('已清除 GitHub Token');
        render();
      }).catch(function (e) {
        toast('清除失败：' + (e.message || e));
      });
    }
  });

  app.addEventListener('error', function (event) {
    var img = event.target;
    if (img && img.tagName === 'IMG' && img.classList.contains('avatar-img')) {
      var box = img.parentNode;
      if (box) box.textContent = img.getAttribute('data-letter') || '?';
    }
  }, true);

  app.addEventListener('input', function (event) {
    var id = event.target.id;
    if (id === 'q') {
      state.query = event.target.value;
      return;
    }
    if (id === 'draft') {
      state.draft = event.target.value;
      state.draftDirty = true;
      return;
    }
    if (id === 'endpoint') {
      state.endpoint = event.target.value;
      var item = state.detail;
      if (item) {
        state.draft = JSON.stringify({ mcpServers: draftServers(item, state.endpoint.trim()) }, null, 2);
        var box = document.getElementById('draft');
        if (box) box.value = state.draft;
      }
      return;
    }
    var form = state.form || emptyForm();
    if (id === 'f-name') form.name = event.target.value;
    else if (id === 'f-command') form.command = event.target.value;
    else if (id === 'f-args') form.args = event.target.value;
    else if (id === 'f-env') form.env = event.target.value;
    else if (id === 'f-url') form.url = event.target.value;
    else if (id === 'f-headers') form.headers = event.target.value;
    else return;
    state.form = form;
  });

  app.addEventListener('keydown', function (event) {
    if (event.target.id === 'q' && event.key === 'Enter') {
      event.preventDefault();
      runSearch(true);
    }
  });

  async function init() {
    var api = bridge();
    if (!api) {
      app.innerHTML = '<div class="page"><div class="empty">页面桥未就绪，请在 AiCode 中打开本页面</div></div>';
      return;
    }
    try {
      ctx = await api.context();
    } catch (e) {
      ctx = null;
    }
    try {
      var token = await api.secrets.get('github_token');
      if (token && token.value) {
        state.ghToken = token.value;
        state.tokenSaved = true;
      }
    } catch (e) {
      state.tokenSaved = false;
    }
    render();
    try {
      await refreshInstalled();
    } catch (e) {
      state.installedError = e.message || String(e);
    }
    render();
    runSearch(true);

    try {
      await api.ui.onBack(function () {
        if (state.view !== 'list') {
          state.view = 'list';
          state.detail = null;
          render();
          return true;
        }
        return false;
      });
    } catch (e) {
      /* 返回键接管不可用时由宿主默认处理 */
    }

    try {
      api.events.on(function (event) {
        if (event && event.name === 'ui.lifecycle' && event.payload && event.payload.visible) {
          refreshInstalled().then(render).catch(function () {});
        }
      });
    } catch (e) {
      /* 事件订阅不可用时忽略 */
    }
  }

  init();
})();
