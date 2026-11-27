# 客户端伪装反代 · Client Spoof Proxy

本地 HTTP 反向代理。把请求伪装成 Codex、Claude Code 等编程客户端后转发到中转站，绕开网关的「本站仅支持编程客户端使用」403 拦截。

适配 Muse 插件系统（`pluginApi ^1.0.0`）。

---

## 工作原理

```
你的聊天客户端                 本地反代                    中转站
(base_url 指向反代)  ──请求──▶  :8788  ──改写头/body──▶  网关
                                  │  ① 换 User-Agent     放行 200
                                  │  ② 删 SDK 特征头
                                  │  ③ 补档位指纹头
                                  │  ④ 按 body 改写规则
                                  └────── ⑤ SSE 流式透传 ──────▶ 客户端
```

网关判定「是不是编程客户端」通常看这几个特征，反代逐一处理：

| 判定点 | 反代处理 |
|---|---|
| `User-Agent` | 替换为档位对应客户端的真实 UA |
| `x-stainless-*`（SDK 直连痕迹） | 删除，换成客户端自己的版本号 |
| 客户端专有头（如 `originator`） | 注入 |
| 鉴权头形态 | 按 `Bearer` / `x-api-key` / 两者注入服务端 Token |
| 请求体字段 | 按档位补 `instructions` / `store` / `system` 结构等 |
| SSE 流式 | 逐块透传，禁用缓冲 |
| 出网链路 | 可选走上游代理（HTTP 转发 / HTTPS CONNECT 隧道） |
| DNS 解析 | 域名解析结果缓存 10 分钟，直连用解析出的 IP + 原域名 SNI，避免每请求重复慢解析；并发请求共用同一次解析 |
| 连接复用 | 直连 HTTPS 启用 keep-alive 连接池（`maxSockets 128` / `maxFreeSockets 32` / `keepAliveMsecs 60s` / LIFO 调度），省去每请求的 TCP/TLS 握手；启动时预热 8 条连接 |
| 流式空闲超时 | SSE 流式请求的 idle timeout 放宽到 10 分钟（非流式 5 分钟），避免大模型长思考期间连接被误杀 |
| 配置健壮性 | 工具入口对布尔字段显式归一化，`"false"` 不会误判为真；schema 与 runtime 支持字段对齐 |
| 启动并发控制 | `proxy_start` 并发调用复用同一次启动，同进程只监听一个端口，避免 baseUrl 与 provider 声明不一致 |
| 上游地址兜底 | `upstream` 非空但 URL 非法时返回明确 502 并记录错误，不表现为无记录的 500 |

---

## AiCode 适配（1.0.3）

1.0.2 是按「通用 Muse 插件」写的，装进本软件（AiCode，`pluginApi 1.0.0`）后有以下差异，1.0.3 已逐项对齐：

| 差异点 | 1.0.2 行为 | 1.0.3 处理 |
|---|---|---|
| 伪装入口 | 只能靠本地反代，必须把供应商 baseUrl 改到 `127.0.0.1:8788/v1` | 新增 `agent.http.before` 接管（`nativeMode`），宿主请求发出前直接改 url/headers/body，**供应商地址不用动** |
| 端口顺延 | 顺延后 baseUrl 对不上，需手动改 | `nativeMode` 下不依赖端口；反代模式下仍提示，`providerNote` 写明实际端口 |
| 供应商 API Key | 只能「复制 Key → 手动粘贴」 | 启动/保存/开机时调 `host.providers.setApiKey({providerId:'spoof'})` 直接写入，失败原因回显在配置页 |
| 剪贴板 | 先调 `aicode.call('clipboard.write', {text})`，本宿主无此方法 | 改为按 `aicode.clipboard.write(text)` 优先、`aicode.call` 兜底 |
| 鉴权占位符 | 反代路径不受影响 | `agent.http.before` 的 payload 里鉴权头是 `{{Token}}`；改 origin 后宿主不再还原，因此直接写入上游真实 token，绝不把占位符发出去 |
| 会话头 | 未处理 | 保留宿主自动加的 `X-AiCode-Session-Id` 透传给上游 |
| 自启动 | 无条件起监听 | `nativeMode` 开启时跳过本地监听，只保留钩子 |

两种模式不要同时开：`nativeMode` 开启后请求已在钩子里改到上游，本地反代收不到流量；需要抓包对比时再手动「启动」。

配置页「服务」卡片多了 **原生接管（不改 baseUrl）** 开关；顶部状态在钩子模式下显示「钩子接管中」，本地地址显示「原生接管：无需本地端口」。

自测：`node tools/selftest-native.js`（mock 宿主驱动 `dis/main.js`，16 项断言覆盖改写、鉴权、占位符、开关关闭）。

## 安装

设置 → 插件 → 右上角「+」→ 选择 `jinghan.spoof-proxy-1.0.3.zip`。

开发者模式下也可直接放开发目录 `~/.muse/plugin-dev/spoof-proxy/`，改动文件自动热替换。

---

## 快速开始

1. 打开配置页：**设置 → AI 配置 → 客户端伪装反代**（或在插件详情页点「打开配置」）。
2. 填 **上游地址**（如 `https://gw.example.com`，不带 `/v1` 尾巴；带 `…/v1` 也能自动去重）。
3. 填 **Token**，选注入方式（一般选 `Bearer`）。
4. 需要走代理才能在容器内出网时，填 **上游代理**（如 `http://127.0.0.1:7890`）。
5. 选 **伪装档位**：
   - GPT / OpenAI 系网关 → `codex`
   - Claude 系网关 → `claude-code`
6. 点 **启动**。得到本地地址，默认 `http://127.0.0.1:8788/v1`；若该端口被占用会自动顺延到下一个空闲端口，并在输入框和提示里回填实际端口。
7. 聊天客户端的 base_url 改成上面这个地址，正常对话即可。也可在「设置 → AI 供应商」选带「插件」标签的 **伪装反代** 条目，API Key 填访问鉴权密钥（若启用）即可直接使用。

反代以 OpenAI 兼容格式注册为静态供应商，宿主加载清单时读取一次地址（清单里写死 `http://127.0.0.1:8788/v1`）。若端口自动顺延到 8788 以外的端口，配置页会提示你把该供应商地址改成实际端口——宿主没有运行时改 baseUrl 的接口，这一步需手动同步。

验证连通性：配置页点 **测试上游**，会按当前配置（含代理）向 `/v1/chat/completions` 发一次真实请求并显示状态码与响应片段。放行显示 200，被拦显示 403 与上游文案。

---

## 配置项

### 上游

| 字段 | 说明 |
|---|---|
| 上游地址 | 中转站根地址。`/v1` 尾巴会被自动去重，避免拼成 `/v1/v1/…` |
| Token | 服务端密钥，注入方式可选 `Bearer` / `x-api-key` / 两者都发 |
| 上游代理 | 可选，如 `http://127.0.0.1:7890`。填了就走代理出站 |

> Token 只存插件私有目录 `data://`，卸载时自动清除，不进宿主备份。界面上始终脱敏显示，留空表示沿用已保存的值。

**上游代理支持：**

- HTTP 上游（`http://`）：直接把请求发给代理，请求行用绝对 URL
- HTTPS 上游（`https://`）：先向代理发 `CONNECT` 建隧道，再在隧道里发请求
- 代理鉴权：写在 URL 里即可，如 `http://user:pass@127.0.0.1:7890`，会转成 `Proxy-Authorization: Basic …`
- 从直连切到代理、或换代理地址，**无需重启**，下次请求即生效

### 伪装档位

| 档位 | 对应客户端 | 关键指纹 |
|---|---|---|
| `codex` | Codex CLI | `codex_cli_rs/x (Mac OS 15.0; arm64) terminal` + `originator: codex_cli_rs` |
| `claude-code` | Claude Code CLI | `claude-cli/x (external, cli)` + `anthropic-beta`、`x-app: cli` |
| `opencode` | OpenCode | `opencode/x (linux; x64)` |
| `cursor` | Cursor | `Cursor/x (darwin arm64)` |
| `cline` | Cline (VSCode) | `vscode/x Cline/x` |
| `roo` | Roo Code | `vscode/x Roo-Code/x` |
| `kilo` | Kilo Code | `vscode/x Kilo-Code/x` |
| `copilot` | GitHub Copilot | `GitHubCopilotChat/x` + `copilot-integration-id` |
| `grok-cli` | Grok CLI | `grok-cli/x` |
| `trae` | Trae | `Trae/x` |
| `qoder` | Qoder | `Qoder/x` |
| `custom` | 自定义 | 同 Codex UA，不注入档位头 |

选错档位一般不会更糟（上游只看 UA 是否在白名单），但贴近真实客户端成功率更高。

### 服务开关

| 开关 | 默认 | 说明 |
|---|---|---|
| 剔除 SDK 特征头 | 开 | 删掉客户端自带的 `x-stainless-*`，换档位版本号 |
| 改写请求体 | 关 | 按档位补 body 字段（见下表） |
| 随插件自启 | 开 | 插件加载后立即监听，并由 `app.started` hook 在宿主启动时拉起 |
| 监听端口 | 8788 | 被占用时自动顺延到空闲端口并回写配置；手动改端口会重启 |

### 访问鉴权

本地反代默认无鉴权，任何能访问监听地址的请求都会被转发。启用后，客户端请求必须带对应凭证，否则返回 `401`。鉴权在伪装处理之前校验，状态页 `/__spoof`、`/__spoof/health` 与 `OPTIONS` 预检免检。

| 字段 | 说明 |
|---|---|
| 启用鉴权 | 开/关，默认关 |
| 校验方式 | `bearer`（`Authorization: Bearer <密钥>`）、`basic`（`Authorization: Basic base64(user:pass)`）、`header`（自定义头 `<头名称>: <密钥>`） |
| 密钥 | bearer / header 方式共用；留空表示沿用已保存值 |
| 用户名 / 密码 | basic 方式；密码留空表示沿用已保存值 |
| 头名称 | header 方式自定义，默认 `x-api-key` |

密钥比对使用恒定时间比较；密钥与密码只在 `data://` 保存，界面脱敏显示。启用 Bearer 时，聊天客户端的 API Key 填这里设的密钥即可，服务端 Token 仍由反代注入。

**供应商 API Key（自动写入）**：要在「设置 → AI 供应商 → 伪装反代」里填的 API Key 存在插件配置 `providerApiKey`。1.0.3 起插件在启动、保存配置、开机 hook 时调 `host.providers.setApiKey({providerId:'spoof', apiKey})` 直接写入宿主供应商条目，无需手动粘贴；成功与否回显在配置页顶部提示行（`✓` / `✗`）。仍保留「复制 Key」按钮作为兜底。

说明：`setApiKey` 要求供应商条目已注册（插件已启用），失败时返回 `PROVIDER_NOT_FOUND`，插件只记录原因不报错，启用插件后下次保存会重试。baseUrl 没有运行时改写接口，因此端口顺延的同步仍需手动处理，或直接改用 `nativeMode` 绕过该问题。

反代会剥离客户端发来的 `Authorization` / `x-api-key`，再用本页「上游 → Token」的值向网关鉴权——所以供应商 API Key 的实际内容不影响上游转发。

**改写请求体规则：**

- `codex` + `/v1/responses`：补 `instructions`（Codex 系统提示）、`store:false`、`stream:true`、`include`、`parallel_tool_calls`
- `claude-code` + `/v1/messages`：`system` 字符串转成带 `cache_control: ephemeral` 的数组块，补 `stream:true`
- 其余档位：原样转发

### 额外请求头

JSON 对象，覆盖同名头，用于补齐网关额外要求的字段：

```json
{ "x-custom": "value", "x-request-id": "00000000-0000-0000-0000-000000000000" }
```

---

## AI 工具

装好后 AI 可直接调用以下工具（`plugin__jinghan_spoof-proxy__<工具>`）：

| 工具 | 入参 | 说明 |
|---|---|---|
| `proxy_start` | `port`?、`profile`? | 启动反代，返回本地地址 |
| `proxy_stop` | — | 停止服务 |
| `proxy_status` | — | 状态、计数、最近 10 条请求、配置 |
| `proxy_config` | `upstream`?、`token`?、`tokenMode`?、`profile`?、`port`?、`stripStainless`?、`rewriteBody`?、`extraHeaders`?、`proxy`?、`autoStart`?、`nativeMode`?、`authEnabled`?、`authMode`?、`authToken`?、`authUser`?、`authPass`?、`authHeader`? | 写配置；改端口会自动重启；`nativeMode` 切换原生接管 |

---

## 排查

| 现象 | 原因与处理 |
|---|---|
| 上游仍 403 | 换档位；配置页点「测试上游」看上游文案。若开了 WAF 查 TLS 指纹（JA3/JA4），HTTP 层伪装不够，需 TLS 层方案 |
| 连不上 8788 | 端口被占用会自动顺延，看配置页提示的实际端口；插件被回收 → 详情页确认运行状态 |
| 客户端报连接失败 | base_url 结尾少了 `/v1`；或反代未启动 |
| SSE 不流式 | 确认请求体里 `"stream": true`；反代已逐块透传并禁用 Nagle |
| 上游 502 | 上游地址不可达；或代理配置错误。填了代理但代理未运行也会 502 |
| 走代理后报证书错误 | 上游为自签证书会被拒绝（反代强制校验 TLS） |

---

## 目录结构

```
spoof-proxy/
├── plugin.json                  # 清单（含 agent.http.before hook）
├── dist/main.js                 # runtime：反代 + 原生接管 + 伪装 + 配置持久化
├── pages/config.html            # 配置页（跟随宿主主题）
├── schemas/                     # 工具入参 JSON Schema
│   ├── empty.input.json
│   ├── proxy_config.input.json
│   └── proxy_start.input.json
├── tools/                       # 开发期自检（不参与运行时）
│   ├── selftest-native.js
│   └── page-check.py
└── data/                        # 运行时私有目录（配置 data://config.json），不打包
```

runtime 声明 `resident: true`，保证反代服务不被空闲回收。

---

## 说明与边界

- 请求只在本地容器内转发，日志不落盘；`proxy_status` 的最近请求只保留 30 条内存快照。
- 配置走 `data://`，卸载插件即清除。
- 若网关在 TLS 指纹层做校验，HTTP 层的 UA / header 伪装无法绕过，需要 `curl_cffi` 一类的 TLS 指纹伪造（当前未实现）。
- 仅供个人调试使用，遵守上游服务条款。
