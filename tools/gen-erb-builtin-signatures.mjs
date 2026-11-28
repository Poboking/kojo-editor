#!/usr/bin/env node
/**
 * 从 eratw core-vm 的**运行时内建注册表**生成 kojo 的内建签名表。
 *
 * ## 为什么是真值而不是手抄
 *
 * 输入 `tools/data/builtin-signatures.tsv` 由反射 dump eratw 的
 * `Builtins.registry`（`core-vm/src/main/kotlin/com/eratw/port/core/fn/Builtins.kt`）得到：
 * 每条的 `minArgs` / `maxArgs` / `omitStart` / `variadicGroup` 都是**装载期与运行期
 * 实际使用**的那份元数据（`BuiltinMethod.checkArity` 直接读它们），且 eratw 是经过
 * 数千名玩家实际游玩校验的线上项目 —— 这份读数比 Era Wiki 手抄页可靠。
 *
 * 旧表（本文件生成前的 `RAW`）是 Wiki 手抄 **170 名**，其中 16 个名字在
 * 1.824 与 4.981 两棵反编译树里**零命中**（`SETBIT` / `CHK_HININ_LOVE` /
 * `FIRSTTIME` 等其实是 eraTW 的 `@FUNC` 用户函数或根本不存在），
 * 而 eratw 注册表有 **331 条**。手抄表既漏 177 条真内建，又混进 16 条假名。
 *
 * ## 类型位从哪来
 *
 * dump 只有个数没有参数类型。类型位从**旧表按位继承**（那 154 名是人工核过 Wiki 的），
 * 新补进来的名字类型一律 `a`（any = 不判类型）——「错标比不标危险」，
 * 判不出的就不判，绝不用猜出来的类型上屏。
 *
 * ## 用法
 *
 * ```bash
 * node tools/gen-erb-builtin-signatures.mjs
 * ```
 * 幂等：同输入重复跑产物逐字相同。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TSV = path.join(ROOT, 'tools', 'data', 'builtin-signatures.tsv');
const TARGET = path.join(ROOT, 'packages', 'plugins', 'erb-parser', 'src', 'builtins.ts');
const BEGIN = '/* @builtin-signatures:begin';
const END = '/* @builtin-signatures:end */';

/** EOL 归一化后再算指纹：git autocrlf 在 checkout 时改字节，原始字节 sha 会假红 */
const normalizeEol = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const rawTsv = normalizeEol(readFileSync(TSV, 'utf8')).replace(/^\uFEFF/, '');
const sha256 = createHash('sha256').update(normalizeEol(readFileSync(TSV, 'utf8')).replace(/^\uFEFF/, ''), 'utf8').digest('hex');
const lines = rawTsv.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('#'));

/** name → { ret, min, max, omit, vg } */
const entries = [];
for (const line of lines) {
  const f = line.split('\t');
  if (f.length < 5) continue;
  const [name, ret, minS, maxS, omitS, vf, vs, ve, vm] = f;
  entries.push({
    name,
    ret: ret === 'STR' ? 's' : 'i', // INT / FLOAT 都是数式（kojo 只有 int/str 两档）
    min: Number(minS),
    max: Number(maxS),
    omit: Number(omitS),
    vg: vf ? { fixed: Number(vf), size: Number(vs), exact: Number(ve), minGroup: Number(vm) } : null,
  });
}
entries.sort((a, b) => a.name.localeCompare(b.name));

// 旧表类型位（人工核过 Wiki）：name → 类型符序列
const srcBefore = readFileSync(TARGET, 'utf8');
const oldBlock = /\/\* @builtin-signatures:begin[\s\S]*?\*\/\n([\s\S]*?)\n\/\* @builtin-signatures:end \*\//.exec(srcBefore);
const oldTypes = new Map();
const typeScanSrc = oldBlock ? oldBlock[1] : srcBefore;
for (const m of typeScanSrc.matchAll(/\['([A-Z_0-9]+)',\s*'[is~]',\s*'([^']*)'\]/g)) {
  const spec = m[2];
  if (spec === '~') continue;
  const body = spec.endsWith(' *') ? spec.slice(0, -2) : spec;
  const toks = body.split(' ').filter((t) => t.length > 0);
  oldTypes.set(m[1], toks.map((t) => (t.endsWith('?') ? t.slice(0, -1) : t)));
}

/** 类型符（`i` / `s` / `v` / `a`）按位取旧表，缺位填 `a` */
function typeAt(name, i) {
  const old = oldTypes.get(name);
  const t = old ? old[i] : undefined;
  return t === 'i' || t === 's' || t === 'v' ? t : 'a';
}

/** 一条 dump 记录 → kojo 的 (ret, params 串, variadicGroup 串) */
function specOf(e) {
  if (e.vg !== null) {
    // 成对变参组：前 fixed 个必需，之后每 size 个一组；另有 exact 形与个数下界 minGroup
    const toks = [];
    for (let i = 0; i < e.vg.fixed; i++) toks.push(typeAt(e.name, i));
    return { spec: toks.join(' '), vg: `${e.vg.fixed},${e.vg.size},${e.vg.exact},${e.vg.minGroup}` };
  }
  if (e.max === -1) {
    // 尾部可变：min 个必需 + ` *`
    const toks = [];
    for (let i = 0; i < e.min; i++) toks.push(typeAt(e.name, i));
    return { spec: `${toks.join(' ')} *`, vg: '' };
  }
  const required = e.omit >= 0 ? e.omit : e.min;
  const slots = e.max;
  const toks = [];
  for (let i = 0; i < slots; i++) toks.push(typeAt(e.name, i) + (i >= required ? '?' : ''));
  return { spec: toks.join(' '), vg: '' };
}

/** 按前缀分组出块注释（只影响可读性，不影响语义） */
const GROUP_ORDER = [
  ['角色 CSV / 角色查询', ['GETCHARA', 'GETSPCHARA', 'CSV', 'FINDCHARA', 'FINDLASTCHARA', 'EXISTCSV', 'CHARA_TO_ENTITY', 'ROSTER_GENERATION']],
  ['数式 / 位运算', ['ABS', 'POWER', 'SQRT', 'CBRT', 'LOG', 'LOG10', 'EXPONENT', 'SIGN', 'LIMIT', 'GETBIT', 'MAX', 'MIN', 'ROUND', 'RAND', 'GROUPMATCH', 'NOSAMES', 'ALLSAMES', 'MATCH', 'CMATCH', 'INRANGE', 'FINDELEMENT', 'FINDLASTELEMENT', 'SUMARRAY', 'SUMCARRAY', 'MAXARRAY', 'MINARRAY', 'ARRAYMSORT', 'UNCHECKED']],
  ['字符串', ['STRLEN', 'SUBSTRING', 'STRFIND', 'STRCOUNT', 'STRJOIN', 'REPLACE', 'TOSTR', 'TOINT', 'TOUPPER', 'TOLOWER', 'TOHALF', 'TOFULL', 'UNICODE', 'UNICODEBYTE', 'ESCAPE', 'ISNUMERIC', 'STRFORM', 'BARSTR']],
  ['变量与符号查询', ['GETNUM', 'GETNUMB', 'GETVAR', 'GETVARS', 'SETVAR', 'VARSIZE', 'VARSETEX', 'ENUMVAR', 'ENUMFUNC', 'ENUMMACRO', 'EXISTVAR', 'EXISTFUNCTION', 'EXISTMETH', 'GETMETH', 'ISDEFINED', 'GETPALAMLV', 'GETEXPLV', 'ERDNAME']],
  ['表示 / 视图', ['PRINT', 'CURRENT', 'COLOR', 'GETCOLOR', 'GETBGCOLOR', 'GETFONT', 'GETSTYLE', 'GETTIME', 'GETTIMES', 'GETMILLISECOND', 'GETSECOND', 'GETDISPLAYLINE', 'GETTEXTBOX', 'SETTEXTBOX', 'MOVETEXTBOX', 'RESUMETEXTBOX', 'LINECOUNT', 'LINESTR', 'LINEISEMPTY', 'BARSTR', 'MONEYSTR', 'HTML', 'SPRITE', 'GCREATE', 'GDISPOSE', 'GCLEAR', 'GFILL', 'GSET', 'GDRAW', 'GDASH', 'GGET', 'CBG', 'BITMAP', 'SETANIMETIMER', 'GETANIMETIMER', 'OUTPUTLOG', 'ISACTIVE', 'MOUSE', 'FLOW', 'HOTKEY']],
  ['存档 / 文件 / 调试', ['CHKDATA', 'CHKCHARADATA', 'SAVENOS', 'SAVETEXT', 'GSAVE', 'GLOAD', 'EXISTFILE', 'ENUMFILES', 'GETCONFIG', 'GETMEMORYUSAGE', 'CLEARMEMORY', 'GETDOINGFUNCTION', 'GETPLATFORM', 'DEBUG', 'ISSKIP', 'MESSKIP']],
  ['SQL / MAP / DT / XML / ENTITY（fork 扩展整族）', ['SQL_', 'MAP_', 'DT_', 'XML_', 'ENTITY_', 'MOD_IS_ACTIVE', 'HAS_SUPER']],
];

const assigned = new Set();
const groups = [];
for (const [label, prefixes] of GROUP_ORDER) {
  const names = [];
  for (const e of entries) {
    if (assigned.has(e.name)) continue;
    if (prefixes.some((p) => e.name === p || e.name.startsWith(p))) {
      names.push(e);
      assigned.add(e.name);
    }
  }
  if (names.length > 0) groups.push([label, names]);
}
const rest = entries.filter((e) => !assigned.has(e.name));
if (rest.length > 0) groups.push(['其他', rest]);

function fmt(e) {
  const { spec, vg } = specOf(e);
  const parts = [`'${e.name}'`, `'${e.ret}'`, `'${spec}'`];
  if (vg) parts.push(`'${vg}'`);
  return `  [${parts.join(', ')}],`;
}

const body = groups
  .map(([label, list]) => `  // —— ${label}（${list.length}）——\n` + list.map(fmt).join('\n'))
  .join('\n\n');

const block = `${BEGIN} — 由 tools/gen-erb-builtin-signatures.mjs 生成，勿手改 ——
 *
 * 真源：eratw core-vm 运行时 \`Builtins.registry\` 的反射 dump
 * （\`tools/data/builtin-signatures.tsv\`，sha256 = \`${sha256}\`）。
 * 共 ${entries.length} 条（含 fork 扩展 SQL_/MAP_/DT_/XML_/ENTITY_ 整族）。
 *
 * 每条 = \`[名字, 返回('i'|'s'), 形参串, 成对变参组?]\`；形参串语法见文件头 KDoc。
 * 第 4 列 \`fixed,size,exact\` = eratw 的 \`VariadicGroup\`（DT_ROW_ADD / DT_ROW_SET）：
 * 合法实参数 = \`fixed + size*n\`，或整组形态 \`exact\`（spec: FunctionMethod.cs:186-193）。
 *
 * 类型位如实为 \`a\`（any）= 该位不判类型（dump 不含类型，旧表没核过就不猜）。
 */
const RAW: readonly (readonly [name: string, ret: 'i' | 's' | '~', params: string, variadicGroup?: string])[] = [
${body}
];
${END}`;

// 替换区间；没有区间时在 `const RAW` 前后插入（首跑）
let out;
if (oldBlock) {
  out = srcBefore.slice(0, oldBlock.index) + block + srcBefore.slice(oldBlock.index + oldBlock[0].length);
} else {
  const anchor = /const RAW: readonly \(readonly \[name: string[^\n]*\n/;
  const m = anchor.exec(srcBefore);
  if (!m) throw new Error('找不到 RAW 表锚点');
  // 删掉旧表体（从声明行到 `];`）
  const start = m.index;
  const endIdx = srcBefore.indexOf('\n];', start);
  out = srcBefore.slice(0, start) + block + srcBefore.slice(endIdx + 3);
}

writeFileSync(TARGET, out, 'utf8');
console.log(`生成 ${entries.length} 条内建签名 → ${path.relative(ROOT, TARGET)}`);
console.log(`  类型继承：${[...oldTypes.keys()].filter((n) => entries.some((e) => e.name === n)).length} 名有原类型`);
console.log(`  成对变参组：${entries.filter((e) => e.vg).map((e) => e.name).join(', ')}`);
