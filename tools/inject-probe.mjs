#!/usr/bin/env node
/**
 * inject-probe.mjs —— LAU-6 探针（**一次性实测工具，不进产品码、不改文法、不重生成 wasm**）。
 *
 * 要验的命题（docs/ARCH-language-unification.md §4.6）：
 *   web-tree-sitter 的 `ParseOptions.includedRanges` 能让 ERB 文法只解析 kojo2 主文档里
 *   `@原生` 体的那一段，且返回的子树坐标**天然是主文档绝对坐标**（无需平移），
 *   于是 `@原生` 体内可以拿到着色 / 折叠 / 残缺可定位，而不必把 ERB 嵌进 kojo2 文法。
 *
 * 跑法（仓库根）：`node tools/inject-probe.mjs`
 * 读出口径：每种区间取法 × 每个夹具都打「ERROR / MISSING / 坐标错位 / 越界节点 / 与去缩进基准的类型差集」，
 *          最后给一条判决（可排 / 需整行对齐 / 不可行）。
 *
 * 语料：kojo2 侧没有真语料通道（语料目录是 ERB/CSV），本探针一律用**仓内夹具**；
 *      若 `tools/corpus.mjs` 能解析出 ERB 语料，则额外取一份真 ERB 文件当 `@原生` 体的内容源。
 */
import { readFileSync, writeSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Parser, Language, Query } from 'web-tree-sitter';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const erbPkg = join(repoRoot, 'packages', 'erb-syntax-tree');
const kojoPkg = join(repoRoot, 'packages', 'kojo-syntax-tree');
const ERB_WASM = join(erbPkg, 'tree-sitter-erb.wasm');
const KOJO_WASM = join(kojoPkg, 'tree-sitter-kojo2.wasm');

const say = (s = '') => { try { writeSync(1, s + '\n'); } catch { /* 管道断了就算了 */ } };
const head = (s) => say(`━━ ${s} `.padEnd(72, '━'));
process.on('uncaughtException', (e) => say(`！！未捕获异常：${e?.stack ?? e}`));

/* ====================================================================
 * 夹具：@原生 体的四种语境
 * ================================================================== */
const CASES = [
  {
    id: 'A-基础',
    note: '注释 / #DIM 指令 / 语句 / 配平 IF…ENDIF / [插槽] / 串与 {…} 切分',
    doc: [
      '# 幕 神社清晨',
      '',
      '@原生',
      '    ; 逃生舱：底层 ERB 代码',
      '    CALL HPH_PRINT "w"',
      '    #DIM STATIC i COUNTER 10',
      '    IF TFLAG:10',
      '        PRINTFORML 天气{x}很好',
      '    ENDIF',
      '    [插槽] 只是普通字符',
      '    SIF TFLAG:20 > 3',
      '        CALLFORM @HPH_PRINT(1)',
      '',
      '> 正文。',
      '',
    ].join('\n'),
  },
  {
    id: 'B-跳过区',
    note: '风险点①：[SKIPSTART]…[SKIPEND] 出现在体内（区内有 @ 行与未闭合引号）',
    doc: [
      '# 幕 跳过',
      '',
      '@原生',
      '    [SKIPSTART]',
      '    @HPH_PRINT(ARG)',
      '        ; 区内任意字符 " 未闭合引号 { 散括号',
      '    CALL X 1',
      '    [SKIPEND]',
      '    PRINTL 区外语句',
      '',
      '> 正文。',
      '',
    ].join('\n'),
  },
  {
    id: 'C-深缩进',
    note: '风险点②：@原生 嵌在 @函 体内，体整体深到第 8 列、内部相对缩进 12 列（spec §8.5 去缩进语境）',
    doc: [
      '# 幕 深层',
      '',
      '@函 增加羁绊(目标, 数值=10)',
      '    灵梦：「开始」',
      '    @原生',
      '        ; 深一级的逃生舱',
      '        IF TFLAG:10 == 1',
      '            PRINTFORML 天气{x}',
      '            CALL HPH_PRINT "w"',
      '        ENDIF',
      '    灵梦：「结束」',
      '',
      '> 正文。',
      '',
    ].join('\n'),
  },
  {
    id: 'D-边界与残缺',
    note: '体内 @ 函数头 + 未配平 IF（MISSING 取证）+ Tab 行 + 代理对字符（UTF-16 口径取证）',
    doc: [
      '# 幕 边界',
      '',
      '> 𠀋 代理对占位一行。',
      '',
      '@原生',
      '    @HPH_PRINT(ARG, B:1 = 3)',
      '    \tSETCOLOR 0xFF8080',
      '    IF TFLAG:10',
      '        PRINTFORML 没有收口',
      '',
      '> 正文。',
      '',
    ].join('\n'),
  },
  {
    id: 'E-深跳过区',
    note: '两个风险点叠加：整体深缩进（嵌在 @循 里，体在第 8 列）＋体内 [SKIPSTART]…[SKIPEND] 嵌套',
    doc: [
      '# 幕 叠加',
      '',
      '@循 体力恢复 < 100',
      '    体力恢复 += 10',
      '    @原生',
      '        [SKIPSTART]',
      '            @死代码(ARG)',
      '                PRINTL "未闭合 { 散括号',
      '        [SKIPEND]',
      '        IF TFLAG:1',
      '            CALL HPH_PRINT "w"',
      '        ENDIF',
      '    > 回到 2.0 正文。',
      '',
      '> 正文。',
      '',
    ].join('\n'),
  },
  {
    id: 'F-EOF收口',
    note: '体直达 EOF 且末行无换行（spec §8.5「EOF 也结束」；对照宿主 parseStructureText 的虚拟换行口径）',
    doc: [
      '# 幕 末尾',
      '',
      '@原生',
      '    CALL HPH_PRINT "w"',
      '    IF TFLAG:10',
      '        ENDIF',
    ].join('\n'),
  },
];

/* ---------- 真 ERB 文本当 @原生 体（仓内出货的真实结构样本，比手写夹具硬） ---------- */
function fileCase(id, note, relPath, indent = 4) {
  try {
    const raw = readFileSync(join(repoRoot, relPath), 'utf8').replace(/\r\n/g, '\n');
    const body = raw.split('\n').map((l) => (l.trim() === '' ? '' : ' '.repeat(indent) + l)).join('\n');
    return { id, note: `${note}｜源 ${relPath} 整段 +${indent} 缩进塞进 @原生 体`, doc: `# 幕 真文本注入\n\n@原生\n${body}\n\n> 正文。\n`, relPath };
  } catch { return null; }
}
for (const c of [
  fileCase('G-真结构样本', 'ERB 文法自身的覆盖样本（函数三形 / 控制流配对 / 停用区 / 指令 / 标签 / 串与 FORM 切分）', 'packages/erb-syntax-tree/tests/fixtures/valid-structure.erb'),
  fileCase('H-真口上摘录', 'fixtures/scaffold 的真实口上 ERB 摘录（含 Tab 行）', 'fixtures/scaffold/日常指令.erb'),
]) if (c) CASES.push(c);

/* ====================================================================
 * 小工具
 * ================================================================== */
const VISIBLE = /^[A-Za-z][A-Za-z0-9_]*$/;
const isStructType = (t) => VISIBLE.test(t) && !t.startsWith('_');

function walk(node, fn) {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

function collect(node, type, acc = []) {
  if (node.type === type) acc.push(node);
  for (const c of node.children) collect(c, type, acc);
  return acc;
}

/** 主文档的 UTF-16 行首表（web-tree-sitter 的 index/column 都是 UTF-16 码元口径）。 */
function lineStarts(text) {
  const ls = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') ls.push(i + 1);
  return ls;
}
function pointOf(ls, index) {
  let lo = 0, hi = ls.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid] <= index) lo = mid; else hi = mid - 1; }
  return { row: lo, column: index - ls[lo] };
}
const lineEndOf = (ls, row, text) => (row + 1 < ls.length ? ls[row + 1] - 1 : text.length);

function inventory(tree, text) {
  const counts = new Map();
  const nodes = [];
  walk(tree.rootNode, (n) => { if (isStructType(n.type)) counts.set(n.type, (counts.get(n.type) || 0) + 1); if (n !== tree.rootNode) nodes.push(n); });
  let errors = 0, missing = 0, errRows = [], missRows = [];
  for (const n of nodes) {
    if (n.isMissing) { missing++; missRows.push(n.startPosition.row); }
    else if (n.type === 'ERROR') { errors++; errRows.push(n.startPosition.row); }
  }
  return { counts, nodes, errors, missing, errRows, missRows };
}

const INDENT_NAMES = { 'indent.begin': '开块抬', 'indent.end': '收束降', 'indent.enter': '抬下一行' };
const CONTROL_LINE_RE = /^([A-Za-z][A-Za-z0-9]*)_line$/;
const NON_CONTROL_LINES = new Set(['comment_line', 'directive_line', 'label_line', 'bracket_line', 'at_string_line', 'string_line', 'statement_line']);

/** 与宿主 erb-indent-patterns.ts 同判据：按节点 kind 取关键字，行首锚 + 词形边界。 */
function erbIndentPattern(nodeType) {
  const m = CONTROL_LINE_RE.exec(nodeType);
  if (!m || NON_CONTROL_LINES.has(nodeType)) return null;
  const word = m[1].toUpperCase();
  const ci = [...word].map((ch) => (/[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch)).join('');
  return new RegExp(`^[ \\t\\u3000]*(?:${ci})(?![A-Za-z_])`);
}

/** 捕获名 → 行首锚正则（与宿主同判据：按节点 kind 取关键字）。 */
function patternFor(nodeType) {
  return erbIndentPattern(nodeType);
}

/**
 * 缩进面**输入等价性**：把 indents.scm 的三档捕获折算成"体里第几行 ⇒ 净增减几级"
 * （begin +1 / end −1 / enter 抬下一行；同枚既 begin 又 end 的分支行净 0）。
 * 这不是 Monaco 缩进算法的重跑，只比较"注入子树"与"去缩进基准"喂给算法的输入是否逐行相等。
 * `rowOffset` 把绝对行号折算回体内行号（基准的行号从 0 起）。
 */
function indentFace(query, tree, rowOffset = 0) {
  if (!query) return null;
  try {
    const caps = query.captures(tree.rootNode);
    const delta = new Map();
    const kinds = new Set();
    for (const c of caps) {
      if (c.node.isMissing || c.node.isError) continue;
      const role = c.name.replace(/^@/, '');
      const row = c.node.startPosition.row - rowOffset;
      const d = role === 'indent.begin' ? 1 : role === 'indent.end' ? -1 : role === 'indent.enter' ? 1 : 0;
      if (d === 0) continue;
      const target = role === 'indent.enter' ? row + 1 : row;
      delta.set(target, (delta.get(target) || 0) + d);
      const p = patternFor(c.node.type);
      if (p) kinds.add(`${role}→${p.source}`);
    }
    const sig = [...delta.entries()].sort((a, b) => a[0] - b[0]).map(([r, d]) => `行${r}:${d > 0 ? '+' : ''}${d}`);
    return { total: caps.length, sig, kinds: [...kinds].sort(), delta };
  } catch { return null; }
}

/** 注入子树（绝对行）与基准（体内相对行）的缩进输入逐行对账：返回不一致的行数。 */
function indentCmp(base, injected) {
  if (!base || !injected) return { dev: -1, detail: '（查询不可用）' };
  const keys = new Set([...base.delta.keys(), ...injected.delta.keys()]);
  const bad = [];
  for (const k of keys) {
    const x = base.delta.get(k) || 0, y = injected.delta.get(k) || 0;
    if (x !== y) bad.push(`行${k}:${x}→${y}`);
  }
  return { dev: bad.length, detail: bad.length ? bad.join(' ') : '逐行相等' };
}

/** 坐标同一性：子树每个节点的 row/col 必须等于「按主文档绝对 index 自己算出来的 row/col」。 */
function coordCheck(nodes, ls) {
  let bad = 0; const samples = [];
  for (const n of nodes) {
    const exp = pointOf(ls, n.startIndex);
    if (exp.row !== n.startPosition.row || exp.column !== n.startPosition.column) {
      bad++;
      if (samples.length < 3) samples.push(`${n.type}@${n.startPosition.row}:${n.startPosition.column} 应为 ${exp.row}:${exp.column}`);
    }
  }
  return { bad, samples };
}

function diffMaps(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const d = [];
  for (const k of [...keys].sort()) { const x = a.get(k) || 0, y = b.get(k) || 0; if (x !== y) d.push(`${k} ${x}→${y}`); }
  return d;
}

/** 去缩进基准：把体行按最小前导空白削平后单独当纯 ERB 解析（"直写 ERB 文件"的对照面）。 */
function dedentedBodyText(body, text, ls) {
  const firstRow = text[body.startIndex] === '\n' ? body.startPosition.row + 1 : body.startPosition.row;
  const lastRow = pointOf(ls, Math.max(0, body.endIndex - 1)).row;
  const rows = [];
  for (let r = firstRow; r <= lastRow; r++) rows.push(text.slice(ls[r], lineEndOf(ls, r, text)));
  const nonEmpty = rows.filter((r) => r.trim() !== '');
  const minIndent = nonEmpty.length ? Math.min(...nonEmpty.map((r) => r.length - r.trimStart().length)) : 0;
  return rows.map((r) => (r.trim() === '' ? '' : r.slice(minIndent))).join('\n') + '\n';
}

/* ====================================================================
 * 主流程
 * ================================================================== */
// git 取证必须**在装载/解析任何 wasm 之前**跑完：实测 spawnSync 在 erb wasm 解析之后调用会当场
// 触发 V8 "Zone" OOM 让进程死在中途（本探针第一版就死在这上面，见提交信息）。
const git = (...a) => { const r = spawnSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };
const GIT = (() => {
  const one = (p) => (git('log', '-1', '--format=%h', '--', p) || '').trim();
  const wasmCommit = one('packages/erb-syntax-tree/tree-sitter-erb.wasm');
  const rawDiff = (git('diff', `${wasmCommit}..HEAD`, '--', 'packages/erb-syntax-tree/grammar.js') || '');
  const changed = rawDiff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(---|\+\+\+)/.test(l));
  const commentish = changed.filter((l) => /^[+-]\s*\*|^[+-]\s*\/\/|^[+-]\s*$/.test(l));
  return {
    wasmCommit,
    parserCommit: one('packages/erb-syntax-tree/src/parser.c'),
    gjCommit: one('packages/erb-syntax-tree/src/grammar.json'),
    scannerCommit: one('packages/erb-syntax-tree/src/scanner.c'),
    scannerExists: existsSync(join(erbPkg, 'src', 'scanner.txt')),
    grammarLog: (git('log', '--format=%h', `${wasmCommit}..HEAD`, '--', 'packages/erb-syntax-tree/grammar.js') || '').trim().split('\n').filter(Boolean),
    touchedByGrammarCommits: (git('log', '--format=%h', `${wasmCommit}..HEAD`, '--', 'packages/erb-syntax-tree/grammar.js') || '')
      .trim().split('\n').filter(Boolean)
      .map((h) => ({ h, files: (git('show', '--name-only', '--format=', h) || '').split('\n').filter((f) => f.startsWith('packages/erb-syntax-tree')) })),
    changed: changed.length,
    commentish: commentish.length,
  };
})();

await Parser.init();
const erbLang = await Language.load(ERB_WASM);
const kojoLang = await Language.load(KOJO_WASM);
const kojoParser = new Parser(); kojoParser.setLanguage(kojoLang);
const erbParser = new Parser(); erbParser.setLanguage(erbLang);

head('0 · 环境与口径');
say(`web-tree-sitter 运行时：erb wasm abi=${erbLang.abiVersion} name=${erbLang.name} types=${erbLang.types.length} · kojo2 wasm abi=${kojoLang.abiVersion} name=${kojoLang.name} types=${kojoLang.types.length}`);
say(` Language.types 含 native_body=${erbLang.types.includes('native_body')} ／ kojo2.types 含 native_body=${kojoLang.types.includes('native_body')} native_head=${kojoLang.types.includes('native_head')} native_line=${kojoLang.types.includes('native_line')} native_block=${kojoLang.types.includes('native_block')}`);
let corpusNote = '夹具（仓内构造）';
try {
  const { resolveCorpusDir } = await import(pathToFileURL(join(repoRoot, 'tools', 'corpus.mjs')).href);
  const dir = resolveCorpusDir({ label: 'inject-probe' });
  corpusNote = dir ? `语料在位：${dir}（kojo2 侧仍用夹具；无 kojo2 真语料通道）` : '语料不在位 ⇒ 全部用夹具';
} catch (e) {
  corpusNote = `语料不在位（${String(e?.message ?? e).split('\n')[0].slice(0, 60)}）⇒ 全部用夹具`;
}
say(` 文档来源：${corpusNote}`);

/* ---------- 查询面（着色 / 折叠 / 缩进）装载 ---------- */
let hiQuery = null, foldQuery = null, indQuery = null, qErr = '';
try {
  hiQuery = new Query(erbLang, readFileSync(join(erbPkg, 'queries', 'highlights.scm'), 'utf8'));
  foldQuery = new Query(erbLang, readFileSync(join(erbPkg, 'queries', 'folds.scm'), 'utf8'));
  indQuery = new Query(erbLang, readFileSync(join(erbPkg, 'queries', 'indents.scm'), 'utf8'));
} catch (e) { qErr = String(e?.message ?? e).slice(0, 120); }

head('1 · 主树定位 native_body（kojo2 已出货 wasm）');
const located = [];
for (const c of CASES) {
  const tree = kojoParser.parse(c.doc);
  const inv = inventory(tree, c.doc);
  const bodies = collect(tree.rootNode, 'native_body');
  const heads = collect(tree.rootNode, 'native_head');
  say(` [${c.id}] kojo2 主树 ERROR=${inv.errors} MISSING=${inv.missing} · native_head=${heads.length} native_body=${bodies.length} · 文档 ${c.doc.length} 码元/${c.doc.split('\n').length - 1} 行`);
  if (bodies.length !== 1) { say(`   ！期望恰好 1 枚 native_body`); tree.delete(); continue; }
  const b = bodies[0];
  const kids = b.children.map((k) => `${k.type}[${k.startIndex},${k.endIndex}]`);
  say(`   body [${b.startIndex},${b.endIndex}) ${b.startPosition.row}:${b.startPosition.column} → ${b.endPosition.row}:${b.endPosition.column}`);
  say(`   首字节=${JSON.stringify(c.doc[b.startIndex])} 末字节(前一枚)=${JSON.stringify(c.doc[b.endIndex - 1])} 起列=${pointOf(lineStarts(c.doc), b.startIndex).column}`);
  say(`   子节点(${b.children.length})：${kids.join(' ')}`);
  const tailByte = JSON.stringify(c.doc[b.endIndex] ?? null);
  say(`   区间尾后一字节=${tailByte} ⇒ ${tailByte === '"\\n"' ? 'kojo2 交来的 body 区间**恒不含末行换行**（ERB 的裸控制词要 \\n 才成 token，见 §2/3 的 ① 偏差）' : '体不在行尾收口'}`);
  const u8 = Buffer.byteLength(c.doc.slice(0, b.startIndex), 'utf8');
  say(`   body 起点单位核对：UTF-16 码元=${b.startIndex} ／ UTF-8 字节=${u8} ⇒ ${u8 === b.startIndex ? '本篇无代理对，两者同值' : '差 ' + (u8 - b.startIndex) + '（web-tree-sitter 的 index 是 UTF-16 码元，不是字节；Monaco 同口径 ⇒ 区间可直接用）'}`);
  located.push({ ...c, body: { startIndex: b.startIndex, endIndex: b.endIndex, startRow: b.startPosition.row, startCol: b.startPosition.column, endRow: b.endPosition.row, endCol: b.endPosition.column } });
  tree.delete();
}

/* ---------- native_body 区间取法 ---------- */
function rangesFor(doc, body, mode) {
  const ls = lineStarts(doc);
  let s = body.startIndex, e = body.endIndex;
  let input = doc;
  if (mode === 'raw') { /* 主树节点的原始字节区间，原样交出去（起在 @原生 头行行内，止于末行正文尾、不含换行） */ }
  else if (mode === 'tailnl') {
    // 只补一件事：区间在末行的换行之后收口
    const lastRow = pointOf(ls, Math.max(0, e - 1)).row;
    e = lineEndOf(ls, lastRow, doc);
    if (doc[e] === '\n') e += 1;
  } else if (mode === 'aligned' || mode === 'virtual') {
    // 体首行第 0 列 → 体末行行尾（含换行）
    if (doc[s] === '\n') s += 1;
    s = ls[pointOf(ls, s).row];
    const lastRow = pointOf(ls, Math.max(0, e - 1)).row;
    e = lineEndOf(ls, lastRow, doc);
    if (doc[e] === '\n') e += 1;
    if (mode === 'virtual' && e === doc.length) {
      // 体直达 EOF 且文末无换行 ⇒ 按宿主 parseStructureText 的同一口径补一枚虚拟换行
      // （index 都在原文里，前追加只加在尾部 ⇒ 既有坐标一律不动）
      input = doc + '\n';
      e = input.length;
    }
  } else if (mode === 'midtoken') {
    // 真·任意字节切：起点切进体首行**正文里**（首个非空白 +2 码元），终点回切进体末行正文（行尾 −3）
    if (doc[s] === '\n') s += 1;
    s += doc.slice(s).match(/^[ \t\u3000]*/)[0].length + 2;
    const lastRow = pointOf(ls, Math.max(0, body.endIndex - 1)).row;
    e = Math.max(s, lineEndOf(ls, lastRow, doc) - 3);
  }
  const lsIn = input === doc ? ls : lineStarts(input);
  const sp = pointOf(lsIn, s), ep = pointOf(lsIn, e);
  return { input, ls: lsIn, range: [{ startIndex: s, startPosition: sp, endIndex: e, endPosition: ep }] };
}

const MODES = [
  ['raw', '① body 节点原始字节区间'],
  ['tailnl', '② 同一区间、仅在末行换行后收口'],
  ['aligned', '③ 整行对齐（体首行第 0 列 → 末行行尾含换行）'],
  ['virtual', '④ 整行对齐 ＋ EOF 无换行时补虚拟换行（宿主 parseStructureText 同口径）'],
  ['midtoken', '⑤ 任意字节切（起＝首行正文 +2 ／ 收＝末行正文 −3）'],
];

head(`2/3 · 五种区间取法 × ${CASES.length} 个语境（含两个风险用例）`);
const verdict = {};
for (const [m] of MODES) verdict[m] = { errors: 0, missDev: 0, coord: 0, outside: 0, typeDev: 0, missTotal: 0, indentDev: 0, indexBad: 0 };
const perCase = [];
for (const c of located) {
  const doc = c.doc, ls = lineStarts(doc);
  const bodyNode = { startIndex: c.body.startIndex, endIndex: c.body.endIndex };
  // 去缩进基准：同一段体内容，作为纯 ERB 文件解析（"作者直接把这段写成 .erb"的对照面）
  const dtext = dedentedBodyText({ ...bodyNode, startPosition: { row: c.body.startRow, column: c.body.startCol } }, doc, ls);
  const dTree = erbParser.parse(dtext);
  const dInv = inventory(dTree, dtext);
  const dInd = indentFace(indQuery, dTree, 0);
  const firstBodyRow = doc[bodyNode.startIndex] === '\n' ? c.body.startRow + 1 : c.body.startRow;
  say('');
  say(` 【${c.id}】${c.note}`);
  say(`   基准：去缩进后整段当纯 ERB 文件解析 ⇒ ERROR=${dInv.errors} MISSING=${dInv.missing} 结构类型 ${[...dInv.counts.keys()].length} 种（${[...dInv.counts.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}）`);
  if (dInd) say(`   基准缩进面（indents.scm 捕获折算）：捕获 ${dInd.total} · 逐行净增减 ${dInd.sig.join(' ') || '（无）'} · 派生规则 ${dInd.kinds.length} 条`);
  dTree.delete();

  for (const [mode, label] of MODES) {
    const { input, ls: lsIn, range: [r] } = rangesFor(doc, bodyNode, mode);
    const sub = erbParser.parse(input, null, { includedRanges: [r] });
    if (!sub) { say(`   ${label} ⇒ parse 返回 null`); continue; }
    const inv = inventory(sub, input);
    const coord = coordCheck(inv.nodes, lsIn);
    const outside = inv.nodes.filter((n) => n.startIndex < r.startIndex || n.endIndex > r.endIndex);
    const invText = [...inv.counts.entries()].map(([k, v]) => `${k}:${v}`).join(' ');
    const dvs = diffMaps(dInv.counts, inv.counts);
    let hi = -1, folds = -1, hiOutside = 0, foldRows = '';
    if (hiQuery && foldQuery) {
      try {
        const caps = hiQuery.captures(sub.rootNode);
        hi = caps.length;
        hiOutside = caps.filter((x) => x.node.startIndex < r.startIndex || x.node.endIndex > r.endIndex).length;
        const ms = foldQuery.matches(sub.rootNode);
        folds = ms.length;
        if (ms.length) {
          const n0 = ms[0].captures[0].node;
          foldRows = ` 首折叠 @${n0.startPosition.row}:${n0.startPosition.column}→${n0.endPosition.row}:${n0.endPosition.column}`;
        }
      } catch (e) { hi = -2; }
    }
    const missDev = inv.missing - dInv.missing;
    // index↔行列 的一致性：切片里的换行数必须等于 endRow−startRow（代理对文档只有按 UTF-16 码元
    // 计数才成立；D 用例正文含「𠀋」）
    let sliceBad = 0;
    for (const n of inv.nodes) {
      const t = input.slice(n.startIndex, n.endIndex);
      if ((t.match(/\n/g) || []).length !== n.endPosition.row - n.startPosition.row) sliceBad++;
    }
    const mInd = indentFace(indQuery, sub, firstBodyRow);
    const indCmp = indentCmp(dInd, mInd);
    say(`   ${label}`);
    say(`     区间 [${r.startIndex},${r.endIndex}) ${r.startPosition.row}:${r.startPosition.column}→${r.endPosition.row}:${r.endPosition.column}｜子树根 [${sub.rootNode.startIndex},${sub.rootNode.endIndex}) ${sub.rootNode.startPosition.row}:${sub.rootNode.startPosition.column}`);
    say(`     ERROR=${inv.errors} MISSING=${inv.missing}（基准 ${dInv.missing}，偏差 ${missDev >= 0 ? '+' : ''}${missDev}）${inv.missRows.length ? ` 残缺节点行号 ${inv.missRows.join(',')}` : ''} 节点=${inv.nodes.length}｜坐标错位=${coord.bad}${coord.samples.length ? ` ${JSON.stringify(coord.samples)}` : ''}｜越界节点=${outside.length}${outside.length ? ` ${JSON.stringify(outside.slice(0, 2).map((n) => `${n.type}[${n.startIndex},${n.endIndex}]`))}` : ''}｜index↔行列不符=${sliceBad}`);
    say(`     结构类型：${invText || '（空）'}`);
    say(`     与去缩进基准的类型计数差：${dvs.length ? dvs.join(' | ') : '0（逐项相等）'}`);
    if (hiQuery) say(`     查询面（绝对坐标）：highlights 捕获=${hi}${hiOutside ? `（越界 ${hiOutside}）` : '（全在区间内）'} · folds 匹配=${folds}${foldRows}${qErr ? ` · 查询装载异常 ${qErr}` : ''}`);
    if (mInd) say(`     缩进面输入：捕获=${mInd.total} 折算=${indCmp.dev === 0 ? '与基准逐行相等' : `与基准偏差 ${indCmp.dev} 行（${indCmp.detail}）`}｜派生规则 ${mInd.kinds.length} 条${mInd.kinds.length ? `：${mInd.kinds.slice(0, 3).join(' ; ')}` : ''}`);
    const v = verdict[mode];
    v.errors += inv.errors; v.missTotal += inv.missing; v.missDev += Math.abs(missDev);
    v.coord += coord.bad; v.outside += outside.length; v.typeDev += dvs.length;
    v.indentDev += Math.max(0, indCmp.dev);
    v.indexBad += sliceBad;
    perCase.push({ case: c.id, mode, errors: inv.errors, missing: inv.missing, missDev, coord: coord.bad, outside: outside.length, delta: dvs.length, indentDev: Math.max(0, indCmp.dev), sliceBad });
    sub.delete();
  }
}

head('4 · 出货 erb wasm ↔ grammar.js 同步核查');
// grammar.js 靠 tree-sitter CLI 注入的全局函数（grammar/token/seq/…）；rules 的每条规则体都是
// 惰性 ($) => …，只要把顶层用到的组合器打桩，就能在不动 packages/** 的前提下读出规则名清单。
const require_ = createRequire(join(erbPkg, 'noop.js'));
let jsRuleNames = null, jsErr = '';
try {
  const stub = () => stubFn();
  function stubFn() { const f = (...a) => ({ kind: 'stub', a }); f.right = (...a) => ({ kind: 'stub', a }); f.left = (...a) => ({ kind: 'stub', a }); f.dynamic = (...a) => ({ kind: 'stub', a }); return f; }
  if (typeof globalThis.grammar === 'undefined') globalThis.grammar = (spec) => spec;
  for (const name of ['token', 'prec', 'seq', 'choice', 'repeat', 'repeat1', 'optional', 'alias', 'field', 'immediateToken', 'reserved', 'suppress', 'inline', 'dedup', 'conflict', 'precede', 'extraPriority']) {
    if (typeof globalThis[name] === 'undefined') globalThis[name] = stub();
  }
  const g = require_(join(erbPkg, 'grammar.js'));
  jsRuleNames = Object.keys(g.rules);
} catch (e) { jsErr = String(e?.message ?? e).split('\n')[0].slice(0, 100); }
say(` grammar.js 直接读规则清单：${jsRuleNames ? `OK（rules ${jsRuleNames.length} 条）` : '失败 ⇒ ' + jsErr}`);
const gj = JSON.parse(readFileSync(join(erbPkg, 'src', 'grammar.json'), 'utf8'));
const gjNames = Object.keys(gj.rules);
const gjExternals = (gj.externals || []).map((e) => e.name ?? e.value ?? JSON.stringify(e));
const wasmTypes = new Set(erbLang.types);
const visibleNames = (a) => a.filter((n) => !n.startsWith('_'));
const hiddenNames = (a) => a.filter((n) => n.startsWith('_'));
const missingVisible = visibleNames(gjNames).filter((n) => !wasmTypes.has(n));
const missingInWasmFromJs = jsRuleNames ? visibleNames(jsRuleNames).filter((n) => !wasmTypes.has(n)) : [];
const jsVsJson = jsRuleNames ? [...new Set([...jsRuleNames, ...gjNames])].filter((n) => !(jsRuleNames.includes(n) && gjNames.includes(n))) : [];
const gjStruct = visibleNames(gjNames);
const wasmVisible = erbLang.types.filter((t) => isStructType(t) && !gjNames.includes(t));
say(` grammar.js(现值) 与 grammar.json(生成物) 的规则名差集：${jsVsJson.length ? jsVsJson.join(',') : '无（一一对应）'}`);
say(` grammar.json ${gjNames.length} 条规则 ⇒ 可见 ${gjStruct.length} 条 / 隐藏(_) ${hiddenNames(gjNames).length} 条`);
say(` **可见规则里不出现在出货 wasm types(${erbLang.types.length}) 的：${missingVisible.length ? missingVisible.join(',') : '无'}**（非空＝文法漂移）`);
say(` 隐藏规则不在 types 表：${hiddenNames(gjNames).filter((n) => !wasmTypes.has(n)).length}/${hiddenNames(gjNames).length} 条——_前缀规则不产节点类型（含 _skip_start/_skip_body/_skip_end 三枚 external 隐藏记号），属预期非漂移`);
say(` grammar.js 现值的可见规则里不出现在 wasm types 的：${missingInWasmFromJs.length ? missingInWasmFromJs.join(',') : '无'}`);
say(` wasm 里有、grammar.json 无同名规则的可见类型（alias 产物，去重后）：${wasmVisible.length ? [...new Set(wasmVisible)].join(',') : '无'}`);
say(` externals：grammar.json=${gjExternals.join(',')}｜wasm types 含 _skip_start=${wasmTypes.has('_skip_start')} _skip_body=${wasmTypes.has('_skip_body')} _skip_end=${wasmTypes.has('_skip_end')}（隐藏记号按上条口径不进表）`);
// 行为面：只有较新文法认识的构造（5b509736 把形参与 #DIM 拆成子节点）
const probes = [
  ['形参切分 @NAME(ARG, B:1 = 3)', '@NAME(ARG, B:1 = 3)\nPRINTL 1\n', (i) => i.counts.get('parameter') === 2 && i.counts.get('parameter_dimension') === 1 && i.counts.get('parameter_default') === 1],
  ['#DIM 族拆节点', '#DIM STATIC i ARR 10\n', (i) => (i.counts.get('dim_directive') || 0) === 1],
  ['停用区一次吞', '[SKIPSTART]\n@X(A\n" 未闭合\n[SKIPEND]\nPRINTL 1\n', (i) => (i.counts.get('skip_block') || 0) === 1 && (i.counts.get('function_block') || 0) === 0],
];
for (const [name, text, check] of probes) {
  const t = erbParser.parse(text);
  const i = inventory(t, text);
  say(`   行为探针「${name}」⇒ ${check(i) ? '✓ 出货 wasm 认得' : '✗ 不认'}（ERROR=${i.errors} MISSING=${i.missing} ${[...i.counts.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}）`);
  t.delete();
}
// 提交面：wasm 的最后一次改动 vs grammar.js 的最后一次改动，两者之间的 grammar.js 差异是不是纯注释
// （全部在进程起手、任何 wasm 解析之前算好，见顶部注释）
say(` 提交面（现算）：tree-sitter-erb.wasm=${GIT.wasmCommit} · src/parser.c=${GIT.parserCommit} · src/grammar.json=${GIT.gjCommit} · src/scanner.c=${GIT.scannerCommit} · src/scanner.txt 存在=${GIT.scannerExists}`);
for (const t of GIT.touchedByGrammarCommits) say(`   ${t.h} 在 packages/erb-syntax-tree 里动过的文件：${t.files.join(', ')}`);
say(` ${GIT.wasmCommit}..HEAD 动过 grammar.js 的提交：${GIT.grammarLog.length ? GIT.grammarLog.join(',') : '无'}；该范围内 grammar.js 的增删行 ${GIT.changed} 行，其中纯注释/空行 ${GIT.commentish} 行 ⇒ ${GIT.changed === GIT.commentish ? '差异**全部是注释**，文法本体未变 ⇒ 出货 wasm 与 grammar.js 同步（无重生成欠账）' : '存在非注释差异 ⇒ 有重生成欠账'}`);

head('判决');
for (const [m, label] of MODES) {
  const v = verdict[m];
  say(` ${label.padEnd(34)} ERROR=${v.errors} MISSING=${v.missTotal}（与基准偏差合计 ${v.missDev}） 坐标错位=${v.coord} 越界节点=${v.outside} index↔行列不符=${v.indexBad} 类型计数偏差=${v.typeDev} 缩进面逐行偏差=${v.indentDev}`);
}
const good = (m) => verdict[m].errors === 0 && verdict[m].coord === 0 && verdict[m].outside === 0 && verdict[m].indexBad === 0 && verdict[m].missDev === 0 && verdict[m].typeDev === 0 && verdict[m].indentDev === 0;
const coordTotal = Object.values(verdict).reduce((n, v) => n + v.coord, 0);
const outsideTotal = Object.values(verdict).reduce((n, v) => n + v.outside, 0);
const indexBadTotal = Object.values(verdict).reduce((n, v) => n + v.indexBad, 0);
say('');
say(` 坐标：全 ${MODES.length * located.length} 组注入解析、坐标错位合计 ${coordTotal}；越界节点合计 ${outsideTotal}；index↔行列不符合计 ${indexBadTotal} ⇒ ${coordTotal === 0 && outsideTotal === 0 && indexBadTotal === 0 ? '子树坐标全程等于主文档绝对坐标，**不平移**（命题的核心主张证真）' : '出现平移/越界/口径错位，见上表'}`);
const astral = located.find((c) => /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(c.doc));
if (astral) {
  const rows = perCase.filter((p) => p.case === astral.id);
  say(` UTF-16 口径：${astral.id} 含代理对，body 起点 UTF-16=${astral.body.startIndex} / UTF-8 字节=${Buffer.byteLength(astral.doc.slice(0, astral.body.startIndex), 'utf8')}；该篇 ${rows.length} 组注入全部 坐标错位=${rows.reduce((n, p) => n + p.coord, 0)}、index↔行列不符=${rows.reduce((n, p) => n + p.sliceBad, 0)} ⇒ Range 用码元口径（与 Monaco 一致），不许按字节换算`);
}
say(` 取法合格线（ERROR/坐标/越界/与基准的 MISSING·类型计数·缩进面偏差全为 0）：${MODES.map(([m]) => `${m} ${good(m) ? '✓' : '✗'}`).join(' · ')}`);
const judge = good('virtual')
  ? (good('raw') ? 'LAU-6 可排（body 原始区间直接可用）' : 'LAU-6 可排——区间口径写死为"整行对齐 ＋ 末行换行收口 ＋ EOF 补虚拟换行"（④）；body 节点原始区间（①）会丢末行的收束词，不能直接用')
  : good('aligned') ? '需改成"整行对齐才可行"' : '不可行';
say(` 判决：${judge}`);
say(` 口径注：D 用例正文本身含未配平 IF，其 MISSING 属预期（基准同为 1，偏差 0）——该枚 MISSING 节点带绝对行号，正是"残缺可定位"的证据。`);
say(` 进程退出：本工具读数写完即固定 rc=3（V8 DisposeIsolate 撞 tree-sitter "Zone" OOM）——单枚 erb wasm 解析一次即触发（kojo2 wasm 单独解析退出正常 rc=0），与 packages/kojo-syntax-tree/tools/_parse-one.mjs 头注同源；判读以 stdout 为准，不看 rc。`);

say('');
say('（读数已逐行同步写到 fd 1；下面 process.exit 仍会撞上退出期 Zone OOM，rc 不作判据）');
process.exit(0);
