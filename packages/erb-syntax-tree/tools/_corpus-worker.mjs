#!/usr/bin/env node
/**
 * _corpus-worker.mjs —— 批量解析 / 折叠读数子进程（被 parse-corpus.mjs / fold-compare.mjs 调用）。
 *
 * 为什么拆子进程：web-tree-sitter 在同一进程里连续解析大量文件会把 wasm 线性内存推到高水位，
 * 进程退出时可能触发 "Zone" OOM。兄弟包 `kojo-syntax-tree` 的口径是每文件一进程；这里文件量大
 * （真语料 2,000+），改为**一次进程解析一批**，批末 `process.exit(0)` 干净退出。
 *
 * 用法：node _corpus-worker.mjs <wasm 绝对路径> <parse|fold> <文件1> <文件2> ...
 * 输出：stdout 每行一条 JSON（每文件一条），父进程按行聚合。
 */
import { readFileSync } from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';
import { compileQuery, foldRanges, parseStructureText } from '../src/index.ts';
import { readErbText } from './text-read.mjs';

const [wasmPath, mode, ...files] = process.argv.slice(2);
if (!wasmPath || !mode || files.length === 0) {
  console.error('用法: node _corpus-worker.mjs <wasm> <parse|fold> <file...>');
  process.exit(2);
}
const T0 = Date.now();
// 计时钩子：**默认关闭**，`KOJO_WORKER_TIMING=1` 才往 stderr 打点。
// 留着的理由见 PITFALLS 226——每进程固定 ~15 秒才真正退出（wasm teardown），
// 全量读数时间 ≈ 批数 × 15s；下次再怀疑"解析慢"时，用这几个点一眼分清是解析慢还是退出慢。
const tm = (tag) => {
  if (process.env.KOJO_WORKER_TIMING) {
    console.error(`[wt] ${tag} ${Date.now() - T0}ms uptime=${Math.round(process.uptime() * 1000)}ms`);
  }
};
tm('argv');

await Parser.init();
tm('Parser.init');
const language = await Language.load(wasmPath);
tm('Language.load');
const parser = new Parser();
parser.setLanguage(language);

const foldsSource = readFileSync(new URL('../queries/folds.scm', import.meta.url), 'utf8');
const foldsQuery = mode === 'fold' ? compileQuery(language, foldsSource) : null;
tm('query');

for (const file of files) {
  const out = { file, crash: 0, errors: 0, missing: 0, errRows: [], ms: 0 };
  let text;
  try {
    text = readErbText(file);
  } catch (e) {
    out.crash = 1;
    out.errRows = [String(e?.message ?? e)];
    process.stdout.write(JSON.stringify(out) + '\n');
    continue;
  }
  let tree;
  const t0 = performance.now();
  try {
    tree = parseStructureText(parser, text);
  } catch (e) {
    out.crash = 1;
    out.errRows = [String(e?.message ?? e)];
    process.stdout.write(JSON.stringify(out) + '\n');
    continue;
  }
  out.ms = Math.round((performance.now() - t0) * 100) / 100;
  const stack = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop();
    // 未闭合的 `{`…`}`：external 记号被错误恢复插成**零宽** close，tree-sitter 不给它
    // `isMissing` ⇒ 按"零宽"计缺失（PITFALLS 223）。真实 `}` 至少一字节。
    const injectedClose = n.type === 'continuation_close' && n.startIndex === n.endIndex;
    if (n.isMissing || injectedClose) {
      out.missing++;
      if (out.errRows.length < 8) out.errRows.push(`MISSING@${n.startPosition.row + 1}`);
    } else if (n.type === 'ERROR') {
      out.errors++;
      if (out.errRows.length < 8) out.errRows.push(`ERROR@${n.startPosition.row + 1}`);
    }
    for (const c of n.children) stack.push(c);
  }
  if (foldsQuery) out.folds = foldRanges(foldsQuery, tree);
  out.lines = text.split('\n').length;
  tree.delete();
  process.stdout.write(JSON.stringify(out) + '\n');
}

parser.delete();
tm('parser.delete');
tm('exit');
process.exit(0);
