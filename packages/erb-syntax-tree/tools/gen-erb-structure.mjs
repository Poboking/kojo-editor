#!/usr/bin/env node
/**
 * gen-erb-structure.mjs —— ERB 结构语法（tree-sitter）的**构建期投影**。
 *
 * 真源（只读，绝不回写）：`packages/plugins/erb-parser/src/scanner.ts`。
 * 它已经是 ERB 行式结构的唯一实现（函数头 / 控制流配对 / `[SKIPSTART]` 区间 / `#DIM` 族），
 * 本包不另抄第二份关键字表：
 *
 * - **控制流配对**：直接 import 真源模块（Node >= 22.18 的类型擦除），用其公开面
 *   `ERB_CONTROL_STATEMENTS` + `classifyControlFlow()` 逐词取角色与配对类别。
 *   上游增删一个控制词 ⇒ 重跑本脚本即同步；忘了重跑由 `tests/projection-single-source.test.ts` 判红。
 * - **整行严格等值标记**（`[SKIPSTART]` / `[SKIPEND]`）：真源里不是词表而是
 *   `trimmed === '…'` 的等值判据（`parseErbText` / `forEachControlFlowLine` 两处），
 *   公开面没有导出 ⇒ 从源码文本抽 `trimmed === '…'`，并按紧随其后的
 *   `inSkipBlock = true|false` 判开/收。抽不到恰好一对就抛（fail-closed）。
 * - **`#DIM` 族**：真源的 `DIM_RE` 是 `/^#(DIMSTR|DIMCHAR|DIMF|DIMS|DIM|DEFINE)\s+(.*)$/i`。
 *   本脚本只投影它的一级分支与 `i` 标志，由 grammar 逐字母展开大小写（tree-sitter 记号正则
 *   没有 `/i`），不投影 `(.*)$`——那是"行内容"不是"结构"。
 *
 * 产物 `src/structure.json` 是 grammar.js 的唯一词表来源（grammar 里零控制词字面量）。
 * 输出确定性：键 / 数组一律按 UTF-16 码元升序；同输入两次逐字节相同。
 *
 * 用法（仓库根或本包目录均可）：
 *   node packages/erb-syntax-tree/tools/gen-erb-structure.mjs
 *   node packages/erb-syntax-tree/tools/gen-erb-structure.mjs --check
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/erb-syntax-tree/tools
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const SCANNER_REL = 'packages/plugins/erb-parser/src/scanner.ts';
const SCANNER_ABS = join(repoRoot, SCANNER_REL);
const OUT = join(pkgRoot, 'src', 'structure.json');
const HEADER_OUT = join(pkgRoot, 'src', 'skip-marker.h');

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 从源码抽**整行严格等值标记**（`trimmed === 'MARKER'`），角色看紧随其后的 inSkipBlock 赋值。 */
export function projectMarkers(scannerSource) {
  const re = /trimmed === '([^']+)'/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(scannerSource)) !== null) {
    const marker = m[1];
    if (!/^\[[A-Z0-9_]+\]$/.test(marker)) continue;
    const after = scannerSource.slice(m.index, m.index + 96);
    let role = null;
    // 取**最近**一处 inSkipBlock 赋值：`[SKIPEND]` 的窗口里可能紧接着出现 `[SKIPSTART]`，
    // 只看"窗口里有没有 true/false"会把开/收判反。
    const assign = /inSkipBlock\s*=\s*(true|false)/.exec(after);
    if (assign) role = assign[1] === 'true' ? 'start' : 'end';
    if (!role) throw new Error(`真源等值标记 ${marker} 之后没有 inSkipBlock 赋值，无法判开/收`);
    const prev = seen.get(marker);
    if (prev && prev !== role) {
      throw new Error(`等值标记 ${marker} 在真源里同时承担 ${prev} / ${role} 两种角色，投影无法唯一化`);
    }
    seen.set(marker, role);
  }
  const starts = [...seen].filter(([, r]) => r === 'start').map(([w]) => w).sort(cmp);
  const ends = [...seen].filter(([, r]) => r === 'end').map(([w]) => w).sort(cmp);
  const unknown = [...seen].filter(([, r]) => r === null).map(([w]) => w);
  if (unknown.length > 0) {
    throw new Error(`真源出现无法判开/收的等值标记：${unknown.join(' ')}——投影脚本须同步角色判据`);
  }
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(`真源整行等值标记应恰为 1 开 1 收，实测开 ${starts.join('/') || '无'}、收 ${ends.join('/') || '无'}`);
  }
  return { skipStart: starts[0], skipEnd: ends[0] };
}

/** 从源码抽 `DIM_RE` 的一级分支（`#` 之后、`\s+` 之前的那组择一分支）与标志。 */
export function projectDimDirectives(scannerSource) {
  const m = /const DIM_RE = \/(.+)\/([a-z]*);/.exec(scannerSource);
  if (!m) throw new Error('真源里找不到 `const DIM_RE = /…/flags;`——投影脚本与 scanner.ts 已漂移');
  const [, pattern, flags] = m;
  if (!flags.includes('i')) {
    throw new Error(`DIM_RE 的标志是 "${flags}"（预期含 i）；grammar 的大小写展开依赖这条判据`);
  }
  const body = /^\^#\(([^)]+)\)\\s/.exec(pattern);
  if (!body) throw new Error(`DIM_RE 形态变了（应以 ^#(…)\\s 起手）：${pattern}`);
  const directives = body[1].split('|').map((s) => s.trim()).filter(Boolean);
  if (directives.length === 0) throw new Error('DIM_RE 一级分支为空');
  for (const d of directives) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(d)) throw new Error(`DIM_RE 分支不是大写指令词：${d}`);
  }
  // 长的在前：`DIM` 排在 `DIMF` 前会让 `#DIMF x` 退化成不匹配（与真源注释同一条判据）。
  directives.sort((a, b) => b.length - a.length || cmp(a, b));
  return { patterns: directives, flags };
}

/** 控制流词 → 角色 / 配对。输入是**活模块**的名单与分类函数，测试可注入别名。 */
export function projectControlFlow(words, classify) {
  const open = {};
  const branch = {};
  const close = {};
  const leaf = [];
  const seen = new Set();
  for (const word of words) {
    if (typeof word !== 'string' || word.length === 0) throw new Error(`控制流名单出现空词：${String(word)}`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(word)) throw new Error(`控制流词不是大写 ASCII 记号：${word}`);
    if (seen.has(word)) throw new Error(`控制流名单重复：${word}`);
    seen.add(word);
    const c = classify(word);
    if (!c) throw new Error(`真源名单里的 ${word} 无法分类——classifyControlFlow 与 ERB_CONTROL_STATEMENTS 已漂移`);
    if (c.role === 'open') open[word] = c.pair;
    else if (c.role === 'branch') branch[word] = c.pair;
    else if (c.role === 'close') close[word] = c.pair;
    else if (c.role === 'leaf') leaf.push(word);
    else throw new Error(`未知控制流角色：${c.role}（${word}）`);
  }
  for (const [word, pair] of Object.entries(open)) {
    if (!pair) throw new Error(`开块词 ${word} 没有配对类别`);
  }
  const pairs = {};
  for (const [word, pair] of Object.entries(open)) {
    (pairs[pair] ??= { open: [], branch: [], close: [] }).open.push(word);
  }
  for (const [word, pair] of Object.entries(branch)) {
    if (!pairs[pair]) throw new Error(`分支词 ${word} 的配对类别 ${pair} 没有开块词`);
    pairs[pair].branch.push(word);
  }
  for (const [word, pair] of Object.entries(close)) {
    if (!pairs[pair]) throw new Error(`收束词 ${word} 的配对类别 ${pair} 没有开块词`);
    pairs[pair].close.push(word);
  }
  for (const [pair, p] of Object.entries(pairs)) {
    if (p.open.length === 0) throw new Error(`配对类别 ${pair} 没有开块词`);
    if (p.close.length === 0) throw new Error(`配对类别 ${pair} 没有收束词`);
    p.open.sort(cmp);
    p.branch.sort(cmp);
    p.close.sort(cmp);
  }
  leaf.sort(cmp);
  return { open, branch, close, leaf, pairs };
}

/** 全部投影的纯函数形态（测试注入/变异用）。 */
export function buildStructure({ scannerSource, words, classify }) {
  const markers = projectMarkers(scannerSource);
  const dim = projectDimDirectives(scannerSource);
  const flow = projectControlFlow(words, classify);
  return {
    source: { scanner: SCANNER_REL },
    markers,
    dimDirectives: dim.patterns,
    dimFlags: dim.flags,
    controlFlow: flow,
  };
}

export function serializeStructure(structure) {
  return `${JSON.stringify(structure, null, 2)}\n`;
}

/**
 * external scanner 的收区标记头（C 侧不能读 JSON）：`src/scanner.c` include 它。
 * 生成物同样受字节闸守护——标记改了却没重跑 build，scanner 会继续吞旧标记。
 */
export function serializeSkipHeader(structure) {
  const start = structure?.markers?.skipStart;
  const end = structure?.markers?.skipEnd;
  if (typeof start !== 'string' || start.length === 0) throw new Error('projection 缺 markers.skipStart');
  if (typeof end !== 'string' || end.length === 0) throw new Error('projection 缺 markers.skipEnd');
  return [
    '/* 生成文件：tools/gen-erb-structure.mjs 从 scanner.ts 的整行等值标记投影而来。禁手改。 */',
    '#ifndef KOJO_ERB_SKIP_MARKER_H',
    '#define KOJO_ERB_SKIP_MARKER_H',
    `#define ERB_SKIP_START_MARKER "${start}"`,
    `#define ERB_SKIP_END_MARKER "${end}"`,
    '#endif',
    '',
  ].join('\n');
}

/** 真源加载（活模块；Node 原生类型擦除）。 */
export async function loadTruth() {
  const mod = await import(pathToFileURL(SCANNER_ABS).href);
  const scannerSource = readFileSync(SCANNER_ABS, 'utf8');
  if (!Array.isArray(mod.ERB_CONTROL_STATEMENTS) || typeof mod.classifyControlFlow !== 'function') {
    throw new Error('scanner.ts 公开面缺 ERB_CONTROL_STATEMENTS / classifyControlFlow——投影契约变了');
  }
  return { scannerSource, words: mod.ERB_CONTROL_STATEMENTS, classify: mod.classifyControlFlow };
}

async function main() {
  const check = process.argv.includes('--check');
  const truth = await loadTruth();
  const structure = buildStructure(truth);
  const serialized = serializeStructure(structure);
  const header = serializeSkipHeader(structure);
  if (check) {
    let current = '';
    let currentHeader = '';
    try {
      current = readFileSync(OUT, 'utf8');
      currentHeader = readFileSync(HEADER_OUT, 'utf8');
    } catch {
      throw new Error(`产物不存在：${OUT} / ${HEADER_OUT}；先跑 node tools/gen-erb-structure.mjs`);
    }
    if (current !== serialized) {
      throw new Error('control-flow / 标记 / #DIM 投影与 scanner.ts 不一致——重跑 node tools/gen-erb-structure.mjs');
    }
    if (currentHeader !== header) {
      throw new Error('external scanner 的 [SKIPEND] 标记头与投影不一致——重跑 node tools/gen-erb-structure.mjs');
    }
    console.log(`[gen-erb-structure] 一致：${OUT} / ${HEADER_OUT}`);
    return;
  }
  writeFileSync(OUT, serialized, 'utf8');
  writeFileSync(HEADER_OUT, header, 'utf8');
  const s = JSON.parse(serialized);
  const pairCount = Object.keys(s.controlFlow.pairs).length;
  console.log(
    `[gen-erb-structure] 已写 ${OUT} + ${HEADER_OUT}：控制词 ${Object.keys(s.controlFlow.open).length + Object.keys(s.controlFlow.branch).length + Object.keys(s.controlFlow.close).length + s.controlFlow.leaf.length} 枚 / ${pairCount} 个配对类别 / 标记 ${s.markers.skipStart}…${s.markers.skipEnd} / #DIM 族 ${s.dimDirectives.length} 枚`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[gen-erb-structure] ${e?.message ?? e}`);
    process.exit(1);
  });
}
