'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.0.0';
const FENCE_START = '<!-- LCS-HOTWATER:START';
const FENCE_END = '<!-- LCS-HOTWATER:END -->';
const NAME = '热开水';
const GREETING = '热开水在线，是时候喝点热水了。';

const SEATS = [
  {
    id: 'master',
    index: '00',
    title: '热开水总控',
    vendor: 'ALL',
    color: '#0f172a',
    duty: '未指定席位时的总控包',
    tone: '总控'
  },
  {
    id: 'codex',
    index: '01',
    title: 'Codex / GPT-5.6',
    vendor: 'Codex',
    color: '#2563eb',
    duty: '指令编排与流程组织',
    tone: '指令编排'
  },
  {
    id: 'claude',
    index: '02',
    title: 'Claude Code',
    vendor: 'Claude',
    color: '#0f766e',
    duty: '长会话与规则整理',
    tone: '规则'
  },
  {
    id: 'grok',
    index: '03',
    title: 'Grok 4.6',
    vendor: 'Grok',
    color: '#b45309',
    duty: '实时信息与模板输出',
    tone: '模板'
  },
  {
    id: 'cursor',
    index: '04',
    title: 'Cursor',
    vendor: 'Cursor',
    color: '#111827',
    duty: 'IDE 规则与技能落地',
    tone: '落地'
  },
  {
    id: 'deepseek',
    index: '05',
    title: 'DeepSeek v4 Pro',
    vendor: 'DeepSeek',
    color: '#334155',
    duty: '深度推理与结果导出',
    tone: '推理'
  },
  {
    id: 'glm53',
    index: '06',
    title: 'GLM 5.3',
    vendor: 'GLM',
    color: '#475569',
    duty: '本地流程与文本重写',
    tone: '重写'
  },
  {
    id: 'workbuddy',
    index: '07',
    title: 'WorkBuddy',
    vendor: 'WorkBuddy AI',
    color: '#7c3aed',
    duty: '灵魂槽与桌面工作台',
    tone: '工作台'
  }
];

const MODES = [
  {
    id: 'max',
    label: 'MAX',
    title: '全开',
    tag: '人设锁定、完整注入、直接干活',
    detail: '完整、直接、可继续',
    body: '人设锁定、完整注入、直接干活。输出要完整、直接、可继续，不要留半截。'
  },
  {
    id: 'focused',
    label: 'FOCUSED',
    title: '聚焦',
    tag: '聚焦',
    detail: '短链路、少噪声',
    body: '短链路、少噪声。只答被问的那件事，砍掉一切铺垫。'
  },
  {
    id: 'builder',
    label: 'BUILDER',
    title: '构建',
    tag: '构建',
    detail: '实现、打包、可复现',
    body: '实现、打包、可复现。给能直接跑的代码和构建命令，产物落地成文件。'
  },
  {
    id: 'research',
    label: 'RESEARCH',
    title: '研究',
    tag: '研究',
    detail: '来源、证据、分层',
    tone: '来源',
    body: '来源、证据、分层。结论要能追溯，证据和推断分开写。'
  },
  {
    id: 'creative',
    label: 'CREATIVE',
    title: '创作',
    tag: '创作',
    detail: '角色、语气、连续性',
    tone: '语气',
    body: '角色、语气、连续性。人物不崩，语气不断，上下文接得上。'
  }
];

const CHAINS = [
  { id: 'reverse', label: 'REVERSE', title: '拆解', detail: '结构还原、依赖梳理' },
  { id: 'unlock', label: 'UNLOCK', title: '开锁', detail: '校验定位、规则排查' },
  { id: 'infil', label: 'INFIL', title: '深入', detail: '路径分析、入口梳理' },
  { id: 'harvest', label: 'HARVEST', title: '采集', detail: '数据整理、结果续接' },
  { id: 'train', label: 'TRAIN', title: '训练', detail: '本地流程、视图组织' }
];

const CHANNELS = [
  { id: 'auto', label: '自动选择', detail: '按当前目标组织工作链' },
  { id: 'codex', label: 'Codex 工程通道 v1.7.3', detail: '当前专业版' },
  { id: 'deepseek', label: 'DeepSeek 工程通道 v1.7.3', detail: '当前专业版' }
];

const TARGETS = [
  {
    id: 'aicode',
    name: 'AiCode 自定义提示词',
    kind: 'file',
    reach: 'direct',
    note: '写入 prompts.custom，下一次会话生效；同编号会覆盖内置片段',
    paths: (ctx) => [path.join(ctx.aicodeHome, 'prompts.custom', `${ctx.customNumber}-hotwater.md`)]
  },
  {
    id: 'aicode-agents',
    name: 'AiCode 工作区规则 AGENTS.md',
    kind: 'fence',
    reach: 'direct',
    note: '以标记段追加到工作区 AGENTS.md，可整段撤销',
    paths: (ctx) => [path.join(ctx.projectRoot, 'AGENTS.md')]
  },
  {
    id: 'codex',
    name: 'Codex 人设槽',
    kind: 'fence',
    reach: 'direct',
    note: 'system-prompt.md 与 AGENTS.md 两处都写；config.toml 需自行挂 model_instructions_file',
    paths: (ctx) => [path.join(ctx.home, '.codex', 'system-prompt.md'), path.join(ctx.home, '.codex', 'AGENTS.md')]
  },
  {
    id: 'claude',
    name: 'Claude Code 人设槽',
    kind: 'fence',
    reach: 'direct',
    note: 'ROOT 与工作区规则两处都写，CLAUDE.md 盖不住 ROOT',
    paths: (ctx) => [path.join(ctx.home, '.claude', 'system-prompt.md'), path.join(ctx.home, '.claude', 'CLAUDE.md')]
  },
  {
    id: 'cursor',
    name: 'Cursor 规则',
    kind: 'fence',
    reach: 'direct',
    note: '写入 alwaysApply 规则文件',
    paths: (ctx) => [path.join(ctx.home, '.cursor', 'rules', 'hotwater.mdc')]
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy 灵魂槽',
    kind: 'fence',
    reach: 'direct',
    note: 'SOUL.md / IDENTITY.md / AGENTS.md；BOOTSTRAP.md 存在会退回 onboarding，需要清掉',
    paths: (ctx) => [
      path.join(ctx.home, '.workbuddy', 'SOUL.md'),
      path.join(ctx.home, '.workbuddy', 'IDENTITY.md'),
      path.join(ctx.home, '.workbuddy', 'AGENTS.md')
    ],
    cleanup: (ctx) => [path.join(ctx.home, '.workbuddy', 'BOOTSTRAP.md')]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Harness 人设槽',
    kind: 'dir',
    reach: 'direct',
    note: '写 DSH_HOME 下的 AGENTS.md 与 hotwater preset；settings.yaml 里 agent-presets.default 需自行确认，旧会话要新开才生效',
    paths: (ctx) => {
      const dsh = ctx.dshHome || path.join(ctx.home, 'AppData', 'Roaming', 'dsh-desktop', 'harness');
      return [
        path.join(dsh, 'AGENTS.md'),
        path.join(dsh, '.agent-presets', 'hotwater', 'agent.cordis.yml')
      ];
    },
    manualKey: 'agent-presets.default: hotwater'
  },
  {
    id: 'grok',
    name: 'Grok 对话',
    kind: 'preview',
    reach: 'preview',
    note: '没有落地文件，只出文本自己贴进对话',
    paths: () => []
  },
  {
    id: 'glm53',
    name: 'GLM 本地工作流',
    kind: 'preview',
    reach: 'preview',
    note: '没有落地文件，只出文本自己贴进系统提示',
    paths: () => []
  }
];

function findSeat(id) {
  return SEATS.find((item) => item.id === id) || null;
}

function findMode(id) {
  return MODES.find((item) => item.id === id) || null;
}

function findChain(id) {
  return CHAINS.find((item) => item.id === id) || null;
}

function findChannel(id) {
  return CHANNELS.find((item) => item.id === id) || null;
}

function findTarget(id) {
  return TARGETS.find((item) => item.id === id) || null;
}

function assetRoot() {
  return path.join(__dirname, '..', 'assets');
}

function readAsset(rel) {
  return fs.readFileSync(path.join(assetRoot(), rel), 'utf8').replace(/\r\n/g, '\n').trimEnd();
}

function readSeatBlock(seatId) {
  const seat = findSeat(seatId);
  if (!seat) throw new Error(`席位无效：${seatId || '(空)'}`);
  return readAsset(path.join('seats', `${seat.id}.md`));
}

function readCore() {
  return readAsset('core.md');
}

function chainLabel(chainId) {
  const chain = findChain(chainId);
  return chain ? `${chain.label} ${chain.title}（${chain.detail}）` : '';
}

function resolveChains(raw, mode) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const ids = list.map((item) => String(item || '').trim()).filter(Boolean);
  const unknown = ids.filter((id) => !findChain(id));
  if (unknown.length) throw new Error(`工作链无效：${unknown.join(', ')}`);
  if (ids.length) return ids.slice(0, 5);
  if (mode.id === 'max') return ['reverse', 'infil'];
  if (mode.id === 'builder') return ['reverse', 'train'];
  if (mode.id === 'research') return ['harvest'];
  if (mode.id === 'creative') return ['train'];
  return ['reverse'];
}

function buildPersona(input) {
  const seatId = String(input.seat || input.seatId || 'master').trim();
  const modeId = String(input.mode || 'max').trim();
  const channelId = String(input.channel || 'auto').trim();
  const goal = String(input.goal || '').trim();

  const seat = findSeat(seatId);
  if (!seat) throw new Error(`席位无效：${seatId}`);
  const mode = findMode(modeId);
  if (!mode) throw new Error(`档位无效：${modeId}`);
  const channel = findChannel(channelId);
  if (!channel) throw new Error(`通道无效：${channelId}`);

  const chains = resolveChains(input.chain, mode);
  const tone = String(input.tone || mode.tone || seat.tone || '').trim();
  const seatBlock = readSeatBlock(seat.id);
  const core = readCore();

  const head = [
    `席位：${seat.title}（${seat.id}）`,
    `工作链：${chains.map(chainLabel).join(' -> ')}`,
    `通道：${channel.label}${channel.detail ? ` · ${channel.detail}` : ''}`,
    `语气：${tone || '默认'}`
  ].join('\n');

  const modeBlock = [
    `## 档位：${mode.label} ${mode.title}`,
    mode.body
  ].join('\n');

  const lines = [
    `${FENCE_START} v${VERSION} seat=${seat.id} mode=${mode.id} chain=${chains.join('+')} -->`,
    `# ${NAME}身份锁定`,
    '',
    head,
    '',
    '## 身份注入',
    '',
    seatBlock,
    '',
    core,
    '',
    modeBlock,
    '',
    '## 装配约定',
    '',
    '保持用户目标、格式和完成判据；缺失项使用占位符；先输出可执行产物，再列出检查点。',
    `核心编排、通道和工作链不变。人设以${NAME}为准。本包只给${seat.title}用，不要套到别的席位。`,
    '',
    `用户目标：${goal || '请先输入明确目标'}`,
    '',
    FENCE_END
  ];

  return {
    markdown: lines.join('\n'),
    seat,
    mode,
    channel,
    chains: chains.map((id) => findChain(id)),
    tone: tone || '默认',
    goal,
    greeting: GREETING
  };
}

function buildSeatMatrix(input) {
  const goal = String(input.goal || '').trim();
  const modeId = String(input.mode || 'max').trim();
  const parts = [];
  for (const seat of SEATS) {
    const built = buildPersona({ seat: seat.id, mode: modeId, goal, channel: input.channel, chain: input.chain, tone: input.tone });
    parts.push(built.markdown);
  }
  return parts.join('\n\n========== 席位分隔 ==========\n\n');
}

function catalog() {
  return {
    name: NAME,
    version: VERSION,
    greeting: GREETING,
    seats: SEATS,
    modes: MODES,
    chains: CHAINS,
    channels: CHANNELS,
    targets: TARGETS.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      reach: item.reach,
      note: item.note
    }))
  };
}

module.exports = {
  VERSION,
  NAME,
  GREETING,
  FENCE_START,
  FENCE_END,
  SEATS,
  MODES,
  CHAINS,
  CHANNELS,
  TARGETS,
  findSeat,
  findMode,
  findChain,
  findChannel,
  findTarget,
  readAsset,
  readSeatBlock,
  readCore,
  buildPersona,
  buildSeatMatrix,
  catalog
};
