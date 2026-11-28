#!/usr/bin/env node
/**
 * ERB 引擎保留名数据契约生成器（ERBDIAG-ERATW）。
 *
 * 输入：`tools/data/variables.yaml` —— 取自 eratw-安卓移植计划的 `specs/variables.yaml`
 *       （语义权威 = 反编译 C# `VariableData.cs` / `VariableCode.cs` 等，逐条带行号锚）。
 * 产物：`packages/plugin-api/src/erb.ts` 中 `// @erb-engine-names:begin` … `:end` 标记区间——
 *       161 枚引擎内建变量名 + 来源段，供 `ERB_ENGINE_RESERVED_IDENTIFIERS` 并集消费。
 *
 * 为什么内联进 erb.ts 而不是单独模块：PS-10 开机图有硬文件数闸（≤197），
 * `ERB_ENGINE_RESERVED_IDENTIFIERS` 在开机图内，新增一个静态 import 模块会 197→198 判红。
 * 内联只在既有文件里加字节（体积闸 ≤3,430 KB 尚有余量），不增加文件数。
 *
 * 为什么是生成而不是手写：kojo-editor 侧的 `ERB_ENGINE_RESERVED_IDENTIFIERS`
 * 长期是 53 枚手抄名，而引擎真源里有 161 枚（COUNT / Y / __INT_MAX__ / ITEMSALES …），
 * 未定义名诊断把这些真变量报成"未定义"——语料闸门已把它们逐条定性为
 * `engine-builtin-vocab-gap`。本生成器把权威名单搬过来，测试再对拍"权威表 ⊆ 生产表"。
 *
 * 用法：node tools/gen-erb-engine-names.mjs
 * 输入快照的 sha256 写进产物头；输入变了必须重跑并订正测试里的指纹。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INPUT = path.join(ROOT, 'tools', 'data', 'variables.yaml');
const TARGET = path.join(ROOT, 'packages', 'plugin-api', 'src', 'erb.ts');
const BEGIN = '// @erb-engine-names:begin';
const END = '// @erb-engine-names:end';

const raw = readFileSync(INPUT, 'utf8');
const sha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
const lines = raw.split(/\r?\n/);

/** 顶层段 → 段内条目名。段名必须顶格（无前导空格），条目形态 `  - {name: XXX, ...}`。 */
function extractSection(section) {
  const names = [];
  let inSection = false;
  for (const ln of lines) {
    const head = /^([a-z_][a-z0-9_]*):\s*(?:#.*)?$/.exec(ln);
    if (head) {
      inSection = head[1] === section;
      continue;
    }
    if (!inSection || !/^\s*-\s*\{name:/.test(ln)) continue;
    const m = /name:\s*['"]?([A-Za-z_][A-Za-z0-9_.]*)['"]?/.exec(ln);
    if (m) names.push(m[1]);
  }
  return names;
}

const SECTIONS = [
  ['integer_arrays', '整数数组'],
  ['string_arrays', '字符串数组'],
  ['multi_dim_arrays', '多维数组'],
  ['local_vars', '函数局部'],
  ['pseudo_vars', '伪变量/常量'],
  ['character_vars', '角色变量'],
  ['float_vars', '浮点变量'],
];

const entries = [];
for (const [section, label] of SECTIONS) {
  for (const name of extractSection(section)) {
    // `A..Z` 是"26 个单字母数组"的缩写（spec 有注，C# varTokenDic 逐枚注册），展开成名。
    if (name === 'A..Z') {
      for (let c = 65; c <= 90; c++) entries.push({ name: String.fromCharCode(c), section: label });
      continue;
    }
    // `__FILE__/__FUNCTION__/__LINE__` 是伪变量族，拆成三枚（spec note 明列）。
    if (name === '__FILE__') {
      for (const n of ['__FILE__', '__FUNCTION__', '__LINE__']) {
        entries.push({ name: n, section: label });
      }
      continue;
    }
    entries.push({ name, section: label });
  }
}

function inlineList(section, key) {
  let inSection = false;
  for (const ln of lines) {
    const head = /^([a-z_][a-z0-9_]*):\s*(?:#.*)?$/.exec(ln);
    if (head) { inSection = head[1] === section; continue; }
    if (!inSection) continue;
    const m = new RegExp('^\\s*' + key + ':\\s*\\[([^\\]]*)\\]').exec(ln);
    if (m) return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  }
  return [];
}
for (const name of inlineList('csv_constants', 'names')) {
  entries.push({ name, section: 'CSV 常量名字表' });
}
for (const key of ['str', 'int']) {
  for (const rawName of inlineList('gamebase_constants', key)) {
    for (const name of rawName.match(/[A-Z][A-Z0-9_]*/g) ?? []) {
      entries.push({ name, section: 'GAMEBASE 常量' });
    }
  }
}

const seen = new Set();
const unique = [];
for (const e of entries) {
  if (seen.has(e.name)) continue;
  seen.add(e.name);
  unique.push(e);
}
unique.sort((a, b) => {
  const A = a.name.toUpperCase(), B = b.name.toUpperCase();
  return A < B ? -1 : A > B ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
});

const body = unique
  .map((e) => `  { name: ${JSON.stringify(e.name)}, section: ${JSON.stringify(e.section)} },`)
  .join('\n');
const block = `${BEGIN}
/**
 * 引擎内建变量名 —— **生成区间，勿手改**；由 \`node tools/gen-erb-engine-names.mjs\` 重生成。
 *
 * 真源：eratw-安卓移植计划 \`specs/variables.yaml\`
 *       （反编译 C# \`VariableData.cs\` / \`VariableCode.cs\` / \`ConstantData.cs\` 等，逐条带行号锚）。
 * 快照：\`tools/data/variables.yaml\`，sha256 = \`${sha256}\`。
 * 名数：${unique.length} 条（A..Z 展开 26、伪变量族拆 3、GAMEBASE 旧拼拆 2）。
 */
export interface ErbEngineNameEntry {
  readonly name: string;
  readonly section: string;
}

/** 全部引擎内建名（含来源段）；\`ERB_ENGINE_RESERVED_IDENTIFIERS\` 由此派生。 */
export const ERB_ENGINE_NAMES: readonly ErbEngineNameEntry[] = [
${body}
];

export const ERB_ENGINE_NAME_LIST: readonly string[] = ERB_ENGINE_NAMES.map((e) => e.name);
${END}`;

const src = readFileSync(TARGET, 'utf8');
const start = src.indexOf(BEGIN);
const end = src.indexOf(END);
if (start < 0 || end < 0 || end < start) {
  throw new Error(`erb.ts 缺少 ${BEGIN}/${END} 标记区间`);
}
const next = src.slice(0, start) + block + src.slice(end + END.length);
writeFileSync(TARGET, next, 'utf8');
console.log(`生成 ${path.relative(ROOT, TARGET)} 标记区间：${unique.length} 名；输入 sha256 ${sha256.slice(0, 16)}…`);
