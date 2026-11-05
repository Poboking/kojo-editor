#!/usr/bin/env node
/**
 * 开机图字节预算报告（2026-11-05 契约字节闸治理批）。
 *
 * 为什么要有这把刀：`packages/app/tests/ps10-eager-graph.test.ts` 的闸只剩 **22 B**，
 * 每次想给契约加一行字段都得先算命；而 ps10 只在失败时把"谁占字节"糊在断言里。
 * 这把刀把同一份口径（源码字节 + 静态值依赖图）单独跑一遍，**只读**，打印：
 *   - 总量 / 文件数 / 距翻闸还差多少字节（红沿按 ps10 的 `Math.round(bytes/1024)` 口径算）
 *   - 占用最大的 N 枚文件，以及"类型占比"粗估（`export interface|type` 声明块字节）
 *   - 已出图（`import type` 擦除）的提示：类型文件不该出现在榜单里
 *
 * 用法：
 *   node tools/eager-graph-report.mjs            # 默认入口 main.tsx、闸 197 文件 / 3,624 KB
 *   node tools/eager-graph-report.mjs --top 25   # 多看几枚
 *
 * 口径与 ps10 **必须**同源（同两枚正则、同 `import type` 擦除判据）；ps10 改了这里也要改，
 * 反之亦然——两处漂了就叫（本文件头注释即契约）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const topArg = args.indexOf('--top');
const TOP = topArg >= 0 ? Number(args[topArg + 1]) || 20 : 20;
const GATE_FILES = 197;
const GATE_KB = 3_624;
const ENTRY = 'packages/app/src/main.tsx';

const read = (abs) => readFileSync(abs, 'utf8');
const relOf = (abs) => path.relative(repoRoot, abs).split(path.sep).join('/');

/** 与 ps10 同源：静态 import 与裸 import（CSS / worker 不算主线程 JS 图） */
const STATIC_IMPORT_RE = /(?:^|\n)\s*import\s+(?!type\b)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /(?:^|\n)\s*export\s+(?!type\b)(?:\*|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/g;

/** 具名导入里是否含"有值"绑定（与 ps10 逐字同口径：整串 split(',') 后看有没有非 `type` 项） */
function hasValueBinding(clause) {
  return clause
    .split(',')
    .some((part) => part.trim() !== '' && !/^\s*type\b/.test(part.trim()));
}

function aliasMap() {
  const map = new Map();
  const vite = read(path.join(repoRoot, 'packages/app/vite.config.ts'));
  // 与 ps10 同源：vite 的 alias 值写成 `r('...')`
  for (const m of vite.matchAll(/['"](@kojo\/[^'"]+)['"]\s*:\s*r\('([^']+)'\)/g)) {
    map.set(m[1], path.resolve(repoRoot, 'packages/app', m[2]));
  }
  for (const dir of readdirSync(path.join(repoRoot, 'packages/plugins'))) {
    const manifest = path.join(repoRoot, 'packages/plugins', dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const name = JSON.parse(readFileSync(manifest, 'utf8')).name;
    if (name.startsWith('@kojo/plugin-') && !map.has(name))
      map.set(name, path.join(repoRoot, 'packages/plugins', dir, 'src/index.ts'));
  }
  return map;
}
const ALIASES = aliasMap();

function resolveSpec(spec, fromFile) {
  if (spec.startsWith('@kojo/')) return ALIASES.get(spec) ?? null;
  if (!spec.startsWith('.')) return null; // node_modules 不在本图判据内（与 ps10 同）
  const base = path.resolve(path.dirname(fromFile), spec.split('?')[0]);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** 与 ps10 逐字同口径：只跳过 worker 与 css（其余交给 resolveSpec，解析不到就不进图） */
const isLeaf = (spec) => spec.includes('?worker') || spec.endsWith('.css');

function walk(entryAbs) {
  const out = new Map();
  const visit = (abs) => {
    const rel = relOf(abs);
    if (out.has(rel)) return;
    const src = read(abs);
    out.set(rel, Buffer.byteLength(src));
    const specs = new Set();
    for (const m of src.matchAll(STATIC_IMPORT_RE)) if (hasValueBinding(m[1])) specs.add(m[2]);
    for (const m of src.matchAll(BARE_IMPORT_RE)) specs.add(m[1]);
    for (const m of src.matchAll(EXPORT_FROM_RE)) specs.add(m[1]);
    for (const spec of specs) {
      if (isLeaf(spec)) continue;
      const abs2 = resolveSpec(spec, abs);
      if (abs2 !== null) visit(abs2);
    }
  };
  visit(entryAbs);
  return out;
}

/** 类型声明块字节粗估：`export interface|type` 起首、到配对结束（括号计数 / 到 `;` 或空行） */
function estimateTypeBytes(src) {
  let bytes = 0;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*export\s+(interface|type)\b/.test(lines[i])) continue;
    let depth = 0;
    let j = i;
    for (; j < lines.length; j += 1) {
      const l = lines[j];
      for (const ch of l) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      bytes += Buffer.byteLength(l) + 1;
      if (depth <= 0 && (j > i || /;\s*$/.test(l))) break;
    }
    i = j;
  }
  return bytes;
}

const graph = walk(path.join(repoRoot, ENTRY));
const rows = [...graph.entries()].map(([rel, bytes]) => {
  const src = read(path.join(repoRoot, rel));
  return { rel, bytes, typeBytes: estimateTypeBytes(src) };
});
const totalBytes = rows.reduce((n, r) => n + r.bytes, 0);
const totalKb = Math.round(totalBytes / 1024);
const redLine = (GATE_KB + 0.5) * 1024; // round(bytes/1024) > GATE_KB 的最小字节数
const gateFilesRed = GATE_FILES + 1;

console.log(`[eager-graph] 入口 ${ENTRY}`);
console.log(`[eager-graph] 现读数 ${rows.length} 文件 / ${totalKb} KB · ${totalBytes} B（闸 ≤${GATE_FILES} 文件 / ≤${GATE_KB} KB）`);
console.log(
  `[eager-graph] 余量：文件 ${GATE_FILES - rows.length} 枚 · 字节 ${Math.floor(redLine) - totalBytes} B（红沿 ${Math.floor(redLine)} B）`,
);
if (rows.length >= gateFilesRed || totalBytes >= redLine) {
  console.log('[eager-graph] ⚠ 已越闸：先出图 / 瘦身，再抬闸（抬闸须逐文件归因，见 PITFALLS 278）');
}
console.log('');
console.log(`占用最大的 ${TOP} 枚（type≈ 是"export interface/type 声明块"粗估，可搬出去的部分）：`);
const top = [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, TOP);
for (const r of top) {
  const typePct = r.bytes > 0 ? Math.round((r.typeBytes / r.bytes) * 100) : 0;
  console.log(
    `  ${String(r.bytes).padStart(8)} B  type≈${String(r.typeBytes).padStart(7)} B (${String(typePct).padStart(3)}%)  ${r.rel}`,
  );
}
const movable = rows
  .filter((r) => r.typeBytes / Math.max(1, r.bytes) >= 0.4 && /\.tsx?$/.test(r.rel))
  .sort((a, b) => b.typeBytes - a.typeBytes)
  .slice(0, 10);
if (movable.length > 0) {
  console.log('');
  console.log('候选瘦身（类型占比 ≥40%，按可搬字节排序；搬到 `*-types.ts` 后 `import type` 擦除、不进图）：');
  for (const r of movable) console.log(`  ${String(r.typeBytes).padStart(7)} B  ${r.rel}`);
}
