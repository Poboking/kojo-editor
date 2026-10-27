#!/usr/bin/env node
/**
 * fold-report.mjs —— 块节点读数工具（语法批自检 / 折叠 A/B 取数）。
 *
 * 逐文件解析，打印：`(block)` 容器数、块头/体/收束的行跨度，并（给了 --rows 时）逐节点
 * 打印 start/end 行列与文本，用来核对"extras 是否被吞进节点 span"这类坐标口径。
 *
 * 用法（仓库根）：
 *   node packages/kojo-syntax-tree/tools/fold-report.mjs                 # 全部真实语料 + 残缺 fixtures
 *   node packages/kojo-syntax-tree/tools/fold-report.mjs --rows path.kojo # 单文件逐节点坐标
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo.wasm');
const worker = join(here, '_fold-one.mjs');
const BROKEN_DIR = join(pkgRoot, 'tests', 'fixtures');

function collect(dir, out, exclude) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (exclude && (p === exclude || p.startsWith(exclude + '\\'))) continue;
    if (e.isDirectory()) collect(p, out, exclude);
    // kojo1 源：标准形 `.kojo1`；LAU-3b-FLIP 之后 `.kojo` 归 2.0，但盘上还有没改名的旧源
    else if (e.name.endsWith('.kojo1') || e.name.endsWith('.kojo')) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const wantRows = args[0] === '--rows';
const explicit = wantRows ? args.slice(1) : args;
const files = [];
if (explicit.length > 0) files.push(...explicit.map((f) => resolve(repoRoot, f)));
else {
  for (const top of ['packages', 'fixtures']) collect(join(repoRoot, top), files, BROKEN_DIR);
  collect(BROKEN_DIR, files, null);
}
files.sort();

let totalBlocks = 0;
let totalErrors = 0;
let totalFolds = 0;
/** 全部具名节点类型计数（行内节点 native_string/comment_inline 的覆盖面看这里） */
const typeTotals = {};
for (const file of files) {
  const r = spawnSync(process.execPath, [worker, wasmPath, file, wantRows ? 'rows' : ''], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  const line = (r.stdout || '').trim().split('\n').pop();
  let res;
  try {
    res = JSON.parse(line);
  } catch {
    console.log(`${file} :: CRASH (no json) stderr=${(r.stderr || '').slice(0, 200)}`);
    continue;
  }
  totalBlocks += res.blocks;
  totalErrors += res.errors;
  for (const [t, n] of Object.entries(res.types || {})) typeTotals[t] = (typeTotals[t] || 0) + n;
  totalFolds += res.folds;
  const rel = file.slice(repoRoot.length + 1).replaceAll('\\', '/');
  console.log(
    `${rel} :: block=${res.blocks} fold区间=${res.folds}(空${res.foldEmpty}) block_body=${res.bodies} 最大深度=${res.maxDepth} ERROR=${res.errors} MISSING=${res.missing} topNodes=${res.topCount}`,
  );
  if (res.foldError) console.log(`   !! folds.scm 查询失败：${res.foldError}`);
  console.log(`   块头 kind: ${JSON.stringify(res.headKinds)}`);
  console.log(
    `   行内/上下文节点: native_string=${res.types.native_string || 0} comment_inline=${res.types.comment_inline || 0} choice_item=${res.types.choice_item || 0} switch_item=${res.types.switch_item || 0} arrow_case=${res.types.arrow_case || 0} arrow_else=${res.types.arrow_else || 0}`,
  );
  if (wantRows) {
    for (const n of res.nodes) {
      console.log(
        `   [${n.depth}] ${n.type.padEnd(18)} ${n.srow}:${n.scol}-${n.erow}:${n.ecol} ${JSON.stringify(n.text.slice(0, 28))} field=${n.field}`,
      );
    }
  }
}
console.log(
  `\n合计：文件 ${files.length} / block+item_block 节点 ${totalBlocks} / @fold 区间 ${totalFolds} / ERROR ${totalErrors}`,
);
console.log(`行内与上下文节点总数：${JSON.stringify({
  native_string: typeTotals.native_string || 0,
  comment_inline: typeTotals.comment_inline || 0,
  choice_item: typeTotals.choice_item || 0,
  switch_item: typeTotals.switch_item || 0,
  arrow_case: typeTotals.arrow_case || 0,
  arrow_else: typeTotals.arrow_else || 0,
  block: typeTotals.block || 0,
  item_block: typeTotals.item_block || 0,
})}`);
