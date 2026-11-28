/**
 * 生成 ERB 引擎变量尺寸表（消费方：convention-linter 的 lazy 规则，不进 PS-10 开机图）。
 *
 * 真源：eratw `specs/variables.yaml`（快照 `tools/data/variables.yaml`，EOL 归一化 sha
 * `f9e75fab…`），逐条带 `VariableData.cs` / `ConstantData.cs` 行锚。
 *
 * 为什么要**带出厂值又允许游戏 CSV 覆盖**：CB-002 的实时教训——eraTW 的
 * `CFLAG` 出厂 1000、`CSV/VariableSize.csv` 改成 10000，语料里 `CFLAG:14:1000`
 * 有 12,825 处；照出厂判就是一万多条假缺陷。规则必须先把游戏 CSV 读进来。
 *
 * 只生成**能静态判**的面：
 * - `integer_arrays` / `string_arrays`：1 维全局数组（含 `A..Z` 展开）；
 * - `character_vars.int_1d` / `str_1d`：角色数组，第 1 参是角色号、第 2 参才是槽；
 * - `csv_constants.names`：名字表（Str1DConstantToken），尺寸走 CSV/出厂；
 * - `multi_dim_arrays`：2D/3D 逐维尺寸。
 * 伪变量 / 局部变量 / 浮点变量不收：它们的有效长度受 `#LOCALFSIZE`、函数形参、
 * 运行期角色数影响，静态判不出（fail-open）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = `${ROOT}tools/data/variables.yaml`;
const TARGET = `${ROOT}packages/plugins/eratw-adapter/src/data/variable-sizes.ts`;

const text = readFileSync(SNAPSHOT, 'utf8').replace(/\r\n?/g, '\n');
export const SHA256 = createHash('sha256').update(text, 'utf8').digest('hex');

function section(name) {
  const i = text.indexOf(`\n${name}:\n`);
  if (i < 0) throw new Error(`variables.yaml 缺段 ${name}`);
  const rest = text.slice(i + name.length + 3);
  const end = rest.search(/^\S/m);
  return end < 0 ? rest : rest.slice(0, end);
}
function items(sec) {
  return [...sec.matchAll(/^\s*- \{([^}]*)\}/gm)].map((m) => {
    const out = {};
    for (const kv of m[1].matchAll(/([a-z_]+):\s*("[^"]*"|[^,]+)/g)) {
      out[kv[1]] = kv[2].trim().replace(/^"|"$/g, '');
    }
    return out;
  });
}
function sizes(v) {
  const m = String(v ?? '').match(/\d+/g);
  return m ? m.map(Number) : [];
}

const entries = [];
for (const [sec, kind, sectionLabel] of [
  ['integer_arrays', 'int', '全局整数数组'],
  ['string_arrays', 'str', '全局字符串数组'],
]) {
  for (const it of items(section(sec))) {
    const dims = sizes(it.size);
    if (dims.length === 0) continue;
    if (it.name === 'A..Z') {
      for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        entries.push({ name: c, dim: 1, sizes: dims, kind, section: sectionLabel });
      }
    } else if (/^[A-Z_][A-Z_0-9]*$/.test(it.name)) {
      entries.push({ name: it.name, dim: 1, sizes: dims, kind, section: sectionLabel });
    }
  }
}

// 角色数组的出厂尺寸：variables.yaml `default_sizes.chara_int_1d` 的文字口径
// （"全部 100; TALENT=1000; CFLAG=1000; JUEL=200; GOTJUEL=200"）。
const CHARA_INT = { TALENT: 1000, CFLAG: 1000, JUEL: 200, GOTJUEL: 200 };
const chara = section('character_vars');
const int1 = chara.slice(chara.indexOf('int_1d:'), chara.indexOf('str_1d:'));
for (const it of items(int1)) {
  if (!/^[A-Z_][A-Z_0-9]*$/.test(it.name)) continue;
  entries.push({
    name: it.name,
    dim: 2, // 第 1 参 = 角色号（CHARANUM 运行期值，不判），第 2 参 = 槽
    sizes: [CHARA_INT[it.name] ?? 100],
    kind: 'int',
    section: '角色整数数组',
  });
}
for (const it of items(chara.slice(chara.indexOf('str_1d:'), chara.indexOf('int_2d:')))) {
  if (!/^[A-Z_][A-Z_0-9]*$/.test(it.name)) continue;
  entries.push({
    name: it.name,
    dim: 2,
    sizes: sizes(it.size ?? 100),
    kind: 'str',
    section: '角色字符串数组',
  });
}
for (const it of items(section('multi_dim_arrays'))) {
  const dims = sizes(it.size);
  if (!/^[A-Z_][A-Z_0-9]*$/.test(it.name) || dims.length === 0) continue;
  entries.push({ name: it.name, dim: dims.length, sizes: dims, kind: 'int', section: '多维整数数组' });
}
const csvNames = (text.match(/names: \[([^\]]*)\]/) ?? [])[1] ?? '';
for (const name of csvNames.split(',').map((s) => s.trim()).filter((s) => /^[A-Z_][A-Z_0-9]*$/.test(s))) {
  entries.push({ name, dim: 1, sizes: [], kind: 'str', section: 'CSV 名字表常量' });
}

entries.sort((a, b) => a.name.localeCompare(b.name) || a.dim - b.dim);
const names = new Set(entries.map((e) => e.name));
if (names.size !== entries.length) throw new Error('变量尺寸表出现重名（同名不同维？先复核再生成）');
if (entries.length < 100) throw new Error(`变量尺寸表只取到 ${entries.length} 条，快照换代了`);

const q = (s) => JSON.stringify(s);
const rows = entries.map(
  (e) => `  { name: ${q(e.name)}, dim: ${e.dim}, sizes: [${e.sizes.join(', ')}], kind: ${q(e.kind)}, section: ${q(e.section)} },`,
);

const head = `/**
 * ERB 引擎变量尺寸表——**生成文件，勿手改**（\`tools/gen-erb-variable-sizes.mjs\`）。
 *
 * 真源：eratw \`specs/variables.yaml\`（快照 \`tools/data/variables.yaml\`，EOL 归一化
 * sha256 \`${SHA256}\`）。出厂尺寸只是**兜底**：eraTW 的 \`CSV/VariableSize.csv\` 改了
 * 90+ 个名字（CFLAG 1000→10000、ITEMNAME 100→1200…），消费方必须先读游戏 CSV 覆盖，
 * 否则 CB-002 那类一万多条假越界会淹掉真问题。
 *
 * \`dim: 2\` 的角色数组：第 1 参是角色号（运行期 \`CHARANUM\`，静态不判），
 * \`sizes[0]\` 约束的是**第 2 参**。\`kind: 'str'\` 的 CSV 名字表 \`sizes: []\` 表示
 * 出厂值随对应 MaxDataList 槽位（逐名字不同，快照没给 ⇒ 规则只在游戏 CSV
 * 明确声明后才判，不猜）。
 */
export interface ErbVariableSizeEntry {
  readonly name: string;
  readonly dim: number;
  readonly sizes: readonly number[];
  readonly kind: 'int' | 'str';
  readonly section: string;
}

/** EOL 归一化快照指纹——规则层与契约测试共用（换代即红） */
export const ERB_VARIABLE_SIZE_SHA256 = ${q(SHA256)};

export const ERB_VARIABLE_SIZES: readonly ErbVariableSizeEntry[] = [
${rows.join('\n')}
];
`;
writeFileSync(TARGET, head, 'utf8');
console.log(`ERB_VARIABLE_SIZES: ${entries.length} 条 / sha ${SHA256.slice(0, 8)}`);
