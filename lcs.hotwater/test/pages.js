'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGES = path.resolve(__dirname, '..', 'pages');
let failed = 0;

for (const name of fs.readdirSync(PAGES).filter((f) => f.endsWith('.html'))) {
  const file = path.join(PAGES, name);
  const html = fs.readFileSync(file, 'utf8');
  const problems = [];

  if (!html.includes('/__aicode/theme.css')) problems.push('缺少 theme.css');
  if (!html.includes('/__aicode/aicode.js')) problems.push('缺少 aicode.js');

  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!scripts.length) problems.push('没有内联脚本');

  scripts.forEach((code, index) => {
    try {
      new vm.Script(code, { filename: `${name}#script${index}` });
    } catch (error) {
      problems.push(`内联脚本 ${index} 语法错误：${error.message}`);
    }
  });

  const handlers = [...html.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
  const allowed = new Set([
    'ui.seats', 'ui.build', 'ui.inject', 'ui.status', 'ui.remove',
    'ui.config.get', 'ui.config.save', 'ui.paths', 'ui.cleanupBootstrap'
  ]);
  const bad = handlers.filter((h) => !allowed.has(h));
  if (bad.length) problems.push(`调用了未注册的 handler：${[...new Set(bad)].join(', ')}`);

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const used = [...html.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((id) => !ids.includes(id));
  if (missing.length) problems.push(`脚本引用了不存在的元素：${missing.join(', ')}`);

  if (problems.length) {
    failed++;
    console.log(`FAIL  ${name}`);
    problems.forEach((p) => console.log(`      - ${p}`));
  } else {
    console.log(`PASS  ${name}  (脚本 ${scripts.length} 段, handler ${new Set(handlers).size} 个)`);
  }
}

if (failed) {
  console.log(`\n${failed} 个页面有问题`);
  process.exitCode = 1;
} else {
  console.log('\n页面校验全部通过');
}
