#!/usr/bin/env node
// tools/build-plugin.mjs — 把 src/ 下的多文件模块打包成**单文件**的 plugin/spin-bounce/client.js。
//
// ============================ 为什么必须打包 ============================
//
// 游戏的 trusted 插件只下发**入口那一个文件**：内容集描述符里 `sources` 只有 `entry.client`
// 一项，其余相对 import 的路径一律 404（实测 /cs/<cs>/scripts/<id>/core/physics.js → 404）。
// 而且 `linkScript` 刻意不改写 `entry.client` 的字节（只对 entry.sim / entry.meta 链接
// `sp:sdk@1`），所以本地相对依赖根本没有解析途径。
//
// 这是确定性校验的必然结果：描述符必须能覆盖脚本的每一个字节。官方模板（plugin/_template/script）
// 因此也是单一入口、只用 `sp:sdk@1`。
//
// 所以：源码保持多文件（可单测、可复用），**发布产物是单文件**。
//
// 用法：node tools/build-plugin.mjs [--check]
//   --check  只验证产物是否是最新的（CI / 提交前用），不写文件

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'plugin', 'spin-bounce', 'client.js');
const ENTRY = join(SRC, 'client.js');

/** 模块依赖顺序：被依赖的在前。手写而非自动分析——少一个依赖解析器的复杂度。 */
const ORDER = [
  'core/physics.js',
  'core/unit-effect.js',
  'integrations/units.js',
  'integrations/audio.js',
  'integrations/panel.js',
  'client.js',
];

const BANNER = `// ⚠️ 本文件由 tools/build-plugin.mjs 生成 —— 不要直接编辑。
// 源码在仓库的 src/ 下（多文件、可单测）；这里打包成单文件是游戏的硬性要求：
// trusted 插件只下发 entry.client 一个文件，相对 import 的路径一律 404。
// 改源码后运行：node tools/build-plugin.mjs
`;

/** 去掉模块语法：import 行删除，export 关键字剥掉（源码内无重名，直接平铺即可）。 */
function stripModuleSyntax(code, rel) {
  return code
    // import 语句（含多行）
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
    // export { … } from '…' / export * from '…'
    .replace(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    // export { … };（重导出，无 from）
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
    // export const/let/function/class → 去掉 export
    .replace(/^(\s*)export\s+(default\s+)?/gm, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 找出各模块的顶层声明，报告重名。
 *
 * 打包是简单平铺（不做作用域包装），所以两个模块声明同名顶层变量会直接 SyntaxError。
 * 与其产出坏包，不如在这里明确失败并指出冲突在哪两个文件之间。
 */
function topLevelDeclarations(code) {
  const names = [];
  const re = /^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) names.push(m[1]);
  return names;
}

function assertNoCollisions(sources) {
  const seen = new Map();
  const clashes = [];
  for (const [rel, code] of sources) {
    for (const name of topLevelDeclarations(code)) {
      if (seen.has(name) && seen.get(name) !== rel) {
        clashes.push(`${name}（${seen.get(name)} 与 ${rel}）`);
      } else if (!seen.has(name)) {
        seen.set(name, rel);
      }
    }
  }
  if (clashes.length) {
    throw new Error(
      '打包失败：顶层声明重名，平铺后会 SyntaxError。\n  ' +
      clashes.join('\n  ') +
      '\n改法：给其中一个改个模块内唯一的名字（例如 physNum / fxNum / audNum）。');
  }
}

function build() {
  const sources = ORDER.map((rel) => {
    const abs = join(SRC, rel);
    if (!existsSync(abs)) throw new Error(`缺少源文件：src/${rel}`);
    return [rel, readFileSync(abs, 'utf8')];
  });
  assertNoCollisions(sources);
  const parts = [BANNER];
  for (const [rel, code] of sources) {
    parts.push(`// ======== src/${rel} ========\n${stripModuleSyntax(code, rel)}`);
  }
  // trusted 插件导入即生效：入口自己会调用 start()，这里再兜一层，防打包顺序意外
  parts.push(`// ======== 打包尾部：确保启动 ========
if (typeof start === 'function') { try { start(); } catch (err) { console.warn('[spin-bounce] start() 失败', err); } }`);
  return parts.join('\n\n') + '\n';
}

const checkOnly = process.argv.includes('--check');
const next = build();

if (checkOnly) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur === next) { console.log('plugin/spin-bounce/client.js 是最新的'); process.exit(0); }
  console.error('✗ plugin/spin-bounce/client.js 与 src/ 不一致，请运行 node tools/build-plugin.mjs');
  process.exit(1);
}

writeFileSync(OUT, next, 'utf8');
const lines = next.split('\n').length;
console.log(`已生成 plugin/spin-bounce/client.js（${lines} 行，${Buffer.byteLength(next)} 字节）`);
