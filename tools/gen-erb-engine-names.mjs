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
// EOL 归一化后再算 sha：git 的 autocrlf 会在 checkout 时把 CRLF 换成 LF，
// 直接对原始字节算会让同一份逻辑内容在不同 checkout 下得到不同指纹（rebase 后实测踩过）。
const normalized = raw.replace(/\r\n?/g, '\n');
const sha256 = createHash('sha256').update(normalized, 'utf8').digest('hex');
const lines = normalized.split('\n');

/**
 * 顶层段 → 段内条目（名 + 该段可确定的维度/类型）。
 *
 * 维度语义（`variables.yaml` 各段的 `dim:` / `kind:` 字段与段注释）：
 * - `integer_arrays` / `string_arrays` / `local_vars` = 1 维；`multi_dim_arrays` 逐条 `dim:` 给 2 或 3；
 * - `pseudo_vars` 段没有 `dim` 字段且成员形态不一（`RAND` 收上界、`CHARANUM` 标量）⇒ **不猜**；
 * - `csv_constants` = 1 维只读字符串数组（`Str1DConstantToken`）；`gamebase_constants` = 0 维只读常量；
 * - `character_vars` 的子段结构（layout 行 + 4 个子段）与 `float_vars` 的条目形态不统一，
 *   **不在这里猜**——留 `undefined`，消费方按「未知维度」处理（fail-open）。
 */
function extractSectionDetailed(section) {
  const out = [];
  let inSection = false;
  for (const ln of lines) {
    const head = /^([a-z_][a-z0-9_]*):\s*(?:#.*)?$/.exec(ln);
    if (head) {
      inSection = head[1] === section;
      continue;
    }
    if (!inSection || !/^\s*-\s*\{name:/.test(ln)) continue;
    const m = /name:\s*['"]?([A-Za-z_][A-Za-z0-9_.]*)['"]?/.exec(ln);
    if (!m) continue;
    const dimM = /(?:^|[{,\s])dim:\s*(\d+)/.exec(ln);
    const kindM = /(?:^|[{,\s])kind:\s*(\w+)/.exec(ln);
    out.push({
      name: m[1],
      dim: dimM ? Number(dimM[1]) : undefined,
      kind: kindM ? kindM[1] : undefined,
    });
  }
  return out;
}

/**
 * 段级默认（条目自带同名字段时以条目为准）。
 *
 * ⚠ 2026-11-28 订正：此前把 `pseudo_vars` 一律当 0 维、`csv_constants` 也当 0 维，
 * 两处都是**拍的**，语料一验就崩：
 * - `csv_constants` 是 `Str1DConstantToken`（`VariableData.cs:3112-3139`）⇒ **1 维**；
 *   探针在 eraTW 4.981 语料里量到 `ABLNAME:0` 一类写法 400+ 处，全是对的。
 * - `pseudo_vars` 段**没有** `dim` 字段，成员形态还不统一：`RAND` 是 `RandToken`
 *   （`VariableData.cs:3153-3155`，收一个上界，语料里 `RAND:n` 有 **76,015** 处），
 *   而 `CHARANUM` / `__INT_MAX__` 才是标量 ⇒ 这一段的维度**不猜**，留空 fail-open。
 * - `string_arrays` 里 `SAVEDATA_TEXT` 是唯一的 0 维（`StrVariableToken`，
 *   `VariableData.cs:3073` 的 `index: -`），故单条覆盖。
 */
const SECTION_DEFAULT = {
  integer_arrays: { dim: 1, kind: 'int' },
  string_arrays: { dim: 1, kind: 'str' },
  multi_dim_arrays: { dim: undefined, kind: 'int' },
  local_vars: { dim: 1, kind: 'int' },
  pseudo_vars: { dim: undefined, kind: undefined },
  csv_constants: { dim: 1, kind: 'str' },
  gamebase_constants: { dim: 0, kind: undefined },
  character_vars: { dim: undefined, kind: undefined },
  float_vars: { dim: undefined, kind: 'float' },
};

/** 逐条覆盖：段级默认不成立的那几个（每条都要有锚，不许凭印象补） */
const ENTRY_OVERRIDE = {
  // 0 维字符串标量，`index: -` 即证据（VariableData.cs:3073）
  SAVEDATA_TEXT: { dim: 0 },
};

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
  const def = SECTION_DEFAULT[section] ?? {};
  for (const it of extractSectionDetailed(section)) {
    const over = ENTRY_OVERRIDE[it.name] ?? {};
    const dim = over.dim ?? it.dim ?? def.dim;
    const kind = over.kind ?? it.kind ?? def.kind;
    const base = { section: label, ...(dim === undefined ? {} : { dim }), ...(kind === undefined ? {} : { kind }) };
    // `A..Z` 是"26 个单字母数组"的缩写（spec 有注，C# varTokenDic 逐枚注册），展开成名。
    if (it.name === 'A..Z') {
      for (let c = 65; c <= 90; c++) entries.push({ name: String.fromCharCode(c), ...base });
      continue;
    }
    // `__FILE__/__FUNCTION__/__LINE__` 是伪变量族，拆成三枚（spec note 明列）。
    if (it.name === '__FILE__') {
      for (const n of ['__FILE__', '__FUNCTION__', '__LINE__']) entries.push({ name: n, ...base });
      continue;
    }
    entries.push({ name: it.name, ...base });
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
  // `Str1DConstantToken`：名字表是**一维只读字符串数组**（`ABLNAME:0` 合法，语料实证 400+ 处）
  entries.push({ name, section: 'CSV 常量名字表', dim: 1, kind: 'str' });
}
for (const key of ['str', 'int']) {
  for (const rawName of inlineList('gamebase_constants', key)) {
    for (const name of rawName.match(/[A-Z][A-Z0-9_]*/g) ?? []) {
      entries.push({ name, section: 'GAMEBASE 常量', dim: 0, kind: key });
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
  .map((e) => {
    const parts = [`name: ${JSON.stringify(e.name)}`, `section: ${JSON.stringify(e.section)}`];
    if (e.dim !== undefined) parts.push(`dim: ${e.dim}`);
    if (e.kind !== undefined) parts.push(`kind: ${JSON.stringify(e.kind)}`);
    return `  { ${parts.join(', ')} },`;
  })
  .join('\n');
const block = `${BEGIN}
/**
 * 引擎内建变量名 —— **生成区间，勿手改**；由 \`node tools/gen-erb-engine-names.mjs\` 重生成。
 *
 * 真源：eratw-安卓移植计划 \`specs/variables.yaml\`
 *       （反编译 C# \`VariableData.cs\` / \`VariableCode.cs\` / \`ConstantData.cs\` 等，逐条带行号锚）。
 * 快照：\`tools/data/variables.yaml\`，sha256 = \`${sha256}\`。
 * 名数：${unique.length} 条（A..Z 展开 26、伪变量族拆 3、GAMEBASE 旧拼拆 2）。
 *
 * \`dim\` / \`kind\` 是**引擎变量模型**的读数（\`dim: 1\` = 一维数组、\`dim: 0\` = 标量；
 * \`kind\` = int / str / float / mixed）。
 *
 * 缺席（\`undefined\`）= **该名字的维度没被 spec 钉死，不猜**，消费方必须按「未知」fail-open：
 * \`character_vars\` 与 \`float_vars\` 的子段结构不统一；\`pseudo_vars\` 段根本没有 \`dim\` 字段，
 * 且成员形态不一（\`RAND\` 收一个上界、\`CHARANUM\` 是标量）——这两处任何"按段一把梭"的默认值
 * 都会在真语料上炸（\`RAND:n\` 在 eraTW 4.981 里有 76,015 处）。
 *
 * 用途：补全与悬停给出维度/类型；维度诊断（\`FLAG:a:b\` 打在 1 维变量上）的真值来源。
 */
export interface ErbEngineNameEntry {
  readonly name: string;
  readonly section: string;
  /** 数组维度（0 = 标量；缺席 = spec 未钉死，不猜，按未知处理） */
  readonly dim?: number;
  /** 值类型（\`int\` / \`str\` / \`float\` / \`mixed\`；缺席 = 未知） */
  readonly kind?: string;
}

/** 全部引擎内建名（含来源段与维度/类型）；\`ERB_ENGINE_RESERVED_IDENTIFIERS\` 由此派生。 */
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
