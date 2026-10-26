#!/usr/bin/env node
/**
 * gen-erb-structure.mjs —— ERB 结构语法（tree-sitter）的**构建期投影**。
 *
 * 真源（只读，绝不回写）两枚：`packages/plugins/erb-parser/src/scanner.ts`（行式结构）与
 * `packages/plugin-api/src/erb.ts`（预处理器标记的语言事实）。
 * scanner.ts 已经是 ERB 行式结构的唯一实现（函数头 / 控制流配对 / `[SKIPSTART]` 区间 / `#DIM` 族），
 * 本包不另抄第二份关键字表：
 *
 * - **控制流配对**：直接 import 真源模块（Node >= 22.18 的类型擦除），用其公开面
 *   `ERB_CONTROL_STATEMENTS` + `classifyControlFlow()` 逐词取角色与配对类别。
 *   上游增删一个控制词 ⇒ 重跑本脚本即同步；忘了重跑由 `tests/projection-single-source.test.ts` 判红。
 * - **整行严格等值标记**（`[SKIPSTART]` / `[SKIPEND]`）：真源里不是词表而是
 *   `trimmed === '…'` 的等值判据（`parseErbText` / `forEachControlFlowLine` 两处），
 *   公开面没有导出 ⇒ 从源码文本抽 `trimmed === '…'`，并按紧随其后的
 *   `inSkipBlock = true|false` 判开/收。抽不到恰好一对就抛（fail-closed）。
 * - **行连接标记**（`ERB_CONTINUATION_MARKERS`）：真源是 `plugin-api/src/erb.ts` 的
 *   `{ open: '{', close: '}' }`。C 侧要按字符比较（`scanner.c` 的 `get_column() == 0` 判行首），
 *   所以与 skip 标记走同一条生成头（`src/skip-marker.h`）——两处各抄一份的话，标记一改就会
 *   退化成"某些文件的行连接块莫名消失"。抽不到 / 不是单字符 / 开收相同一律抛。
 * - **预处理条件块三枚正则**（`[IF …]` / `[ELSEIF …]` / `[ELSE]` / `[ENDIF]`）：真源是
 *   `packages/plugin-api/src/erb.ts` 的 `ERB_PREPROC_PATTERNS`（语言事实的**唯一**落点）。
 *   语言包**不许**运行期 import 插件，也不该 import 契约 barrel（把整张契约面拖进动态块），
 *   所以走同一条构建期通道：抽三枚正则的 **pattern 源 + 标志**写进 `structure.json` 的
 *   `preproc` 段，`src/index.ts` 用 `new RegExp(source, flags)` 重建。抽不到三枚、
 *   标志不一致、带 `g`/`y`（`test()` 变有状态、共享实例就会漂）一律抛。
 *   文法侧不吃这一段（预处理条件块在 grammar 里**故意不建块**，见 grammar.js 头注），
 *   所以加这一格**不触碰 parser 产物**。
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
const PREPROC_SOURCE_REL = 'packages/plugin-api/src/erb.ts';
const PREPROC_SOURCE_ABS = join(repoRoot, PREPROC_SOURCE_REL);
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

/** 行连接标记的契约真源声明（与 `ERB_PREPROC_PATTERNS` 同一份文件、同一条构建期通道）。 */
const CONTINUATION_DECL = 'export const ERB_CONTINUATION_MARKERS';

/**
 * 从 `plugin-api/src/erb.ts` 抽行连接的两个标记字符（`ERB_CONTINUATION_MARKERS`）。
 *
 * 为什么要投影到 C 侧：`scanner.c` 判"整行只有它"时不能读 JSON（external scanner 只带
 * 一段 C），skip 标记因此走 `skip-marker.h`；行连接标记是**同一类语言事实**，若在 C 里
 * 手抄 `'{'` / `'}'`，契约层哪天改了标记（或加了全角变体），两处就会各说各话，而症状是
 * "某些文件的行连接块莫名消失"——最难查的那种。⇒ 同一张投影表，同一条字节闸。
 *
 * fail-closed：声明抽不到 / 只抽到一枚 / 不是单字符 / 开收相同，一律抛。
 */
export function projectContinuationMarkers(source) {
  const at = source.indexOf(CONTINUATION_DECL);
  if (at < 0) throw new Error(`真源缺 ${CONTINUATION_DECL}（行连接标记的语言事实）`);
  const window = source.slice(at, at + 400);
  const pick = (role) => {
    const m = new RegExp(`\\b${role}\\s*:\\s*'([^']*)'`).exec(window);
    if (!m) throw new Error(`${CONTINUATION_DECL} 里找不到 ${role}（形态变了？）`);
    const value = m[1];
    if ([...value].length !== 1) throw new Error(`行连接 ${role} 标记应为单个字符，实测 ${JSON.stringify(value)}`);
    return value;
  };
  const open = pick('open');
  const close = pick('close');
  if (open === close) throw new Error(`行连接开/收标记相同（${JSON.stringify(open)}），判据无意义`);
  return { continuationOpen: open, continuationClose: close };
}

/**
 * 预处理条件块三枚正则的真源声明（`packages/plugin-api/src/erb.ts`）。
 * 语言事实的唯一落点是契约层 `ERB_PREPROC_PATTERNS`；这里只**读它的源码文本**，
 * 不在构建期 import（那会把整张契约 barrel 拉进语言包的装载面）。
 */
const PREPROC_DECL = 'export const ERB_PREPROC_PATTERNS';

/** 契约层的三种角色（与 `ErbPreprocRole` 同集合） */
const PREPROC_ROLES = ['open', 'branch', 'close'];

/** 一行一枚的形态：`role: /patternSource/flags,` */
const PREPROC_ENTRY_RE = /^(open|branch|close)\s*:\s*\/((?:\\.|[^/\\])+?)\/([a-z]*)\s*,?\s*$/;

/** 对象字面量的收尾（`});` / `})` / `}`） */
const PREPROC_OBJECT_END_RE = /^\}\s*\)?\s*;?\s*$/;

/** 声明之后最多扫几行（超过 = 形态不是"三行一枚"，fail-closed） */
const PREPROC_SCAN_LIMIT = 40;

/**
 * 从 `plugin-api/src/erb.ts` 的源码文本抽 `ERB_PREPROC_PATTERNS` 的三枚 pattern 源与标志。
 *
 * 为什么走投影而不是运行期 import：语言包不许依赖插件，也不该在动态装载面上 import 契约
 * barrel；`src/index.ts` 拿到的仍是**同一份语言事实的字节**，只是搬运发生在构建期。
 *
 * fail-closed 四条：抽不到三枚 / 有行不是"一行一枚"形态 / 三枚标志不一致（投影只有
 * `flags` 一格）/ 标志含 `g` 或 `y`（共享实例的 `test()` 会变有状态）。
 * 任一条都抛，绝不静默回退成脚本里手抄的正则——那正是本批要消灭的"第二处落地"。
 */
export function projectPreproc(erbSource) {
  if (typeof erbSource !== 'string' || erbSource.length === 0) {
    throw new Error(`projectPreproc 需要 ${PREPROC_SOURCE_REL} 的源码文本（真源缺失 = 投影不能猜正则）`);
  }
  const start = erbSource.indexOf(PREPROC_DECL);
  if (start < 0) {
    throw new Error(`真源里找不到 \`${PREPROC_DECL}\`——投影脚本与 ${PREPROC_SOURCE_REL} 已漂移`);
  }
  const lines = erbSource.slice(start).split('\n');
  /** @type {Map<string, { source: string, flags: string }>} */
  const found = new Map();
  for (let i = 1; i < lines.length && i <= PREPROC_SCAN_LIMIT; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
    if (PREPROC_OBJECT_END_RE.test(line)) break;
    const m = PREPROC_ENTRY_RE.exec(line);
    if (!m) {
      throw new Error(
        `${PREPROC_SOURCE_REL} 的 ERB_PREPROC_PATTERNS 里有一行不是 \`role: /源/标志,\` 形态：${line}——形态变了请同步 projectPreproc`,
      );
    }
    const [, role, source, flags] = m;
    if (found.has(role)) throw new Error(`ERB_PREPROC_PATTERNS 的 ${role} 出现两次——投影只认一枚`);
    found.set(role, { source, flags });
  }
  const missing = PREPROC_ROLES.filter((r) => !found.has(r));
  if (missing.length > 0) {
    throw new Error(
      `ERB_PREPROC_PATTERNS 没抽到 ${missing.join('/')}（声明形态不是"紧跟对象字面量的三行等值"）——先同步 projectPreproc 再重跑`,
    );
  }
  const flagSet = new Set([...found.values()].map((v) => v.flags));
  if (flagSet.size !== 1) {
    const detail = [...found].map(([r, v]) => `${r}="${v.flags}"`).join(' ');
    throw new Error(`三枚预处理器正则的标志不一致（${detail}）——投影只有 flags 一格，请改契约层后重跑`);
  }
  const flags = [...flagSet][0];
  for (const bad of ['g', 'y']) {
    if (flags.includes(bad)) {
      throw new Error(`预处理器正则带 ${bad} 标志：三处消费面共享同一枚实例，lastIndex 会让 test() 变成有状态判据`);
    }
  }
  const preproc = { open: '', branch: '', close: '', flags };
  for (const role of PREPROC_ROLES) {
    const entry = found.get(role);
    try {
      new RegExp(entry.source, flags);
    } catch (e) {
      throw new Error(`预处理正则 ${role} 的源重建失败：${entry.source}（${e?.message ?? e}）`);
    }
    preproc[role] = entry.source;
  }
  return preproc;
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

/**
 * 从源码抽 `DIM_MODIFIERS`（`#DIM` 族声明行的前置关键字）的一级分支与标志。
 *
 * 真源跨两行（`const DIM_MODIFIERS =` 与正则各占一行），故 `=` 之后用 `\s*` 跨行。
 * 修饰词表漏一个词，名字就会被记成那个关键字（`#DIM DYNAMIC CNT_CHARA` → `DYNAMIC`），
 * 所以投影与真源漂移时必须抛错，不许静默回退空表。
 */
export function projectDimModifiers(scannerSource) {
  const m = /const DIM_MODIFIERS =\s*\/\^\(([^)]+)\)\\s\+\/([a-z]*);/.exec(scannerSource);
  if (!m) throw new Error('真源里找不到 `const DIM_MODIFIERS = /^(…)\\s+/flags;`——投影脚本与 scanner.ts 已漂移');
  const [, pattern, flags] = m;
  if (!flags.includes('i')) {
    throw new Error(`DIM_MODIFIERS 的标志是 "${flags}"（预期含 i）；grammar 的大小写展开依赖这条判据`);
  }
  const patterns = pattern.split('|').map((s) => s.trim()).filter(Boolean);
  if (patterns.length === 0) throw new Error('DIM_MODIFIERS 一级分支为空');
  for (const p of patterns) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(p)) throw new Error(`DIM_MODIFIERS 分支不是大写修饰词：${p}`);
  }
  // 长的在前：`DUMMY` 与 `DUMMY_EXT` 并存时短词先胜会把长词劈成「短词 + 名字」。
  patterns.sort((a, b) => b.length - a.length || cmp(a, b));
  return { patterns, flags };
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
export function buildStructure({ scannerSource, erbSource, words, classify }) {
  const markers = { ...projectMarkers(scannerSource), ...projectContinuationMarkers(erbSource) };
  const preproc = projectPreproc(erbSource);
  const dim = projectDimDirectives(scannerSource);
  const dimMods = projectDimModifiers(scannerSource);
  const flow = projectControlFlow(words, classify);
  return {
    source: { scanner: SCANNER_REL, preproc: PREPROC_SOURCE_REL },
    markers,
    preproc,
    dimDirectives: dim.patterns,
    dimFlags: dim.flags,
    dimModifiers: dimMods.patterns,
    dimModifierFlags: dimMods.flags,
    controlFlow: flow,
  };
}

export function serializeStructure(structure) {
  return `${JSON.stringify(structure, null, 2)}\n`;
}

/**
 * external scanner 的判据头（C 侧不能读 JSON）：`src/scanner.c` include 它。
 * 生成物同样受字节闸守护——标记改了却没重跑 build，scanner 会继续吞旧标记。
 *
 * 两类：整行等值标记（skip 区间，字符串形态）与行连接标记（单字符形态，C 里当 char 用）。
 */
export function serializeSkipHeader(structure) {
  const start = structure?.markers?.skipStart;
  const end = structure?.markers?.skipEnd;
  if (typeof start !== 'string' || start.length === 0) throw new Error('projection 缺 markers.skipStart');
  if (typeof end !== 'string' || end.length === 0) throw new Error('projection 缺 markers.skipEnd');
  const contOpen = structure?.markers?.continuationOpen;
  const contClose = structure?.markers?.continuationClose;
  if (typeof contOpen !== 'string' || [...contOpen].length !== 1) throw new Error('projection 缺 markers.continuationOpen');
  if (typeof contClose !== 'string' || [...contClose].length !== 1) throw new Error('projection 缺 markers.continuationClose');
  /** C 字符字面量：只转义引号与反斜杠（当前标记是 `{`/`}`，这里防的是语言事实变化）。 */
  const charLiteral = (ch) => `'${ch === "'" || ch === '\\' ? `\\${ch}` : ch}'`;
  return [
    '/* 生成文件：tools/gen-erb-structure.mjs 从 scanner.ts 的整行等值标记 + plugin-api 的 ERB_CONTINUATION_MARKERS 投影而来。禁手改。 */',
    '#ifndef KOJO_ERB_SKIP_MARKER_H',
    '#define KOJO_ERB_SKIP_MARKER_H',
    `#define ERB_SKIP_START_MARKER "${start}"`,
    `#define ERB_SKIP_END_MARKER "${end}"`,
    `#define ERB_CONTINUATION_OPEN_CHAR ${charLiteral(contOpen)}`,
    `#define ERB_CONTINUATION_CLOSE_CHAR ${charLiteral(contClose)}`,
    '#endif',
    '',
  ].join('\n');
}

/** 真源加载（活模块 + 两份源码文本；Node 原生类型擦除）。 */
export async function loadTruth() {
  const mod = await import(pathToFileURL(SCANNER_ABS).href);
  const scannerSource = readFileSync(SCANNER_ABS, 'utf8');
  const erbSource = readFileSync(PREPROC_SOURCE_ABS, 'utf8');
  if (!Array.isArray(mod.ERB_CONTROL_STATEMENTS) || typeof mod.classifyControlFlow !== 'function') {
    throw new Error('scanner.ts 公开面缺 ERB_CONTROL_STATEMENTS / classifyControlFlow——投影契约变了');
  }
  return { scannerSource, erbSource, words: mod.ERB_CONTROL_STATEMENTS, classify: mod.classifyControlFlow };
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
      throw new Error(
        'control-flow / 标记 / #DIM 投影与 scanner.ts 不一致，或 preproc 段与 plugin-api/src/erb.ts 不一致——重跑 node tools/gen-erb-structure.mjs',
      );
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
    `[gen-erb-structure] 已写 ${OUT} + ${HEADER_OUT}：控制词 ${Object.keys(s.controlFlow.open).length + Object.keys(s.controlFlow.branch).length + Object.keys(s.controlFlow.close).length + s.controlFlow.leaf.length} 枚 / ${pairCount} 个配对类别 / 标记 ${s.markers.skipStart}…${s.markers.skipEnd} / 预处理正则 3 枚（标志 "${s.preproc.flags}"）/ #DIM 族 ${s.dimDirectives.length} 枚 / #DIM 修饰词 ${s.dimModifiers.length} 枚`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[gen-erb-structure] ${e?.message ?? e}`);
    process.exit(1);
  });
}
