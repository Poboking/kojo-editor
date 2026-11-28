/**
 * eraTW 符号审计数据契约生成器（B 档 / ERBDIAG-ERATW）。
 *
 * 输入：
 *   node tools/gen-erb-audit-findings.mjs <audit.tsv> <corpus-root> [out.ts]
 *
 *   - <audit.tsv>   = `erbcc audit --corpus <ERB目录> --game-root <游戏根> --out <tsv>` 的产物，
 *                     七列表头 `kind/file/function/line/name/detail/count`（SymbolLinkAudit.kt:91）；
 *   - <corpus-root> = 语料根（--corpus 的原值）；TSV 第 2 列是它下面的相对路径；
 *   - [out.ts]      = 缺省 `packages/plugins/eratw-adapter/src/audit-findings.data.ts`。
 *
 * 产物是一枚**纯数据叶子**：只由 `audit-findings.ts` 经动态 import 装载（不进开机图）。
 * 每条文件项带 `stableHash` 指纹 —— 运行时读到的正文指纹不符就**整文件不出诊断**，
 * 绝不让离线快照变成作者改完代码后的陈旧波浪线。
 *
 * 指纹口径与 `@kojo/plugin-api` 的 `stableHash` / `normalizeEol` 逐字同源（见下方实现）；
 * 改那两处真源时必须同步这里，否则每次校验都会因指纹不符而静默全空 —— 测试有反证用例守门。
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const [tsvArg, corpusArg, outArg] = process.argv.slice(2);
if (!tsvArg || !corpusArg) {
  console.error('用法: node tools/gen-erb-audit-findings.mjs <audit.tsv> <corpus-root> [out.ts]');
  process.exit(2);
}
const TSV = path.resolve(tsvArg);
const CORPUS = path.resolve(corpusArg);
const OUT = outArg ? path.resolve(outArg) : path.join(ROOT, 'packages/plugins/eratw-adapter/src/audit-findings.data.ts');

const HEADER = 'kind\tfile\tfunction\tline\tname\tdetail\tcount';
const KINDS = [
  'VAR_UNBOUND',
  'VAR_TYPE_MISMATCH',
  'VAR_DIM_MISMATCH',
  'KEYWORD_UNBOUND',
  'KEYWORD_USER_VAR',
  'PRIVATE_DIM_REJECTED',
  'GLOBAL_DIM_REJECTED',
  'COMPILE_DIM_WARNING',
];

/** 与 plugin-api/src/fingerprint.ts:50 的 stableHash 逐字同源（构建期无 TS 运行时，故复制） */
function stableHash(input) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** 与 plugin-api/src/eol.ts 的 normalizeEol 同源：无 \r 时零拷贝 */
function normalizeEol(text) {
  if (text.indexOf('\r') < 0) return text;
  return text.split(/\r\n|\r|\n/).join('\n');
}

/** TS 单引号字面量转义（detail 里含中文、竖线、引号、反斜杠） */
function q(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

const raw = readFileSync(TSV, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split('\n');
if (lines[0] !== HEADER) throw new Error(`TSV 表头不对：${lines[0]}`);

/** 路径键：TSV 的 file 列 = 语料根相对路径，正斜杠；大小写归一（Windows 盘上不区分大小写） */
const normPath = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').toUpperCase();

/** file -> rows[]（保持 TSV 行序；Kotlin 侧已按 kind.ordinal,file,line,name,detail 排好） */
const groups = new Map();
let total = 0;
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (line === '') continue;
  const cols = line.split('\t');
  if (cols.length !== 7) throw new Error(`TSV 第 ${i + 1} 行是 ${cols.length} 列：${line}`);
  const [kind, file, fn, lineNo, name, detail, count] = cols;
  const ki = KINDS.indexOf(kind);
  if (ki < 0) throw new Error(`TSV 第 ${i + 1} 行 kind 不在 8 类里：${kind}`);
  const ln = Number(lineNo);
  const ct = Number(count);
  if (!Number.isInteger(ln) || !Number.isInteger(ct) || ct < 0) {
    throw new Error(`TSV 第 ${i + 1} 行 line/count 不是整数：${line}`);
  }
  const key = normPath(file);
  const rows = groups.get(key);
  const row = [ki, fn, ln, name, detail, ct];
  if (rows) rows.push(row);
  else groups.set(key, [row]);
  total++;
}

/** 每个有 Finding 的文件算一次正文指纹；读不到就拒绝生成（绝不产出永远命不中的死数据） */
const entries = [];
const missing = [];
for (const [file, rows] of groups) {
  const abs = path.join(CORPUS, ...file.toLowerCase().split('/'));
  let text;
  try {
    text = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    missing.push(`${file}: ${String(err)}`);
    continue;
  }
  entries.push([file, stableHash(normalizeEol(text)), rows]);
}
if (missing.length) {
  throw new Error(`有 Finding 的源文件读不到（拒绝生成永不命中的死数据）:\n${missing.slice(0, 20).join('\n')}`);
}
entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
const body = entries
  .map(
    ([file, hash, rows]) =>
      `  ${q(file)}: {\n` +
      `    s: ${q(hash)},\n` +
      `    r: [\n${rows.map((r) => `      [${r[0]}, ${q(r[1])}, ${r[2]}, ${q(r[3])}, ${q(r[4])}, ${r[5]}],`).join('\n')}\n` +
      `    ],\n` +
      `  },`,
  )
  .join('\n');

const out = `/**
 * erbcc audit 审计读数快照 —— **生成文件，勿手改**。
 *
 * 由 \`node tools/gen-erb-audit-findings.mjs\` 从 eraTW 4.981 全量审计 TSV 生成：
 *   erbcc audit --corpus <语料>/ERB --game-root <语料> --out unresolved-symbols.tsv
 * 源文件 SHA-256 = \`${sha}\`（TSV 逐字）；共 ${entries.length} 个文件 / ${total} 条 Finding。
 *
 * \`s\` = 源文件正文的 stableHash（去 BOM + normalizeEol 后，与 plugin-api 同尺）。
 * \`r\` = 该文件的 Finding 行：\`[kind序号, functionKey, 0基行号, name, detail, count]\`。
 * kind 序号对应 AUDIT_FINDING_KINDS 的下标（见 audit-findings.ts）。
 */
export const AUDIT_SOURCE_SHA256 = ${q(sha)};
export const AUDIT_FILE_COUNT = ${entries.length};
export const AUDIT_FINDING_COUNT = ${total};

export const AUDIT_FILES = {
${body}
} as const;
`;

writeFileSync(OUT, out, 'utf8');
console.log(
  `生成 ${path.relative(ROOT, OUT)}：${entries.length} 文件 / ${total} 条 Finding / ${Buffer.byteLength(out, 'utf8')} 字节`,
);
