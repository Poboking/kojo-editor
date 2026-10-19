#!/usr/bin/env node
/**
 * gen-word-forms.mjs —— 词表构建期投影：把 `kojo-sugar` 的活词表灌进 `src/word-forms.json`，
 * 供 `grammar.js` require（tree-sitter CLI 用裸 node 读 grammar，故产物必须是 JSON）。
 *
 * 真源（**只读，绝不回写**）：
 * - `packages/plugins/kojo-sugar/src/keywords.ts` 的 `SUGAR_LEXICON_WORDS` /
 *   `HEAD_DECL_KEYS` / `primaryWord()` / `blockEndWord()`（聚合入口 `sugarEditorLexicon()`
 *   同一批内表，此处按语义 id 需要直读导出表）；
 * - `packages/plugins/kojo-sugar/src/statement-functions.ts` 的 `STATEMENT_FUNCTIONS` 键集。
 *
 * 机制口径：真源是**零依赖叶子 TS 模块**，Node ≥23.6（本仓 24.x）原生类型擦除即可
 * `import()`——与 app 侧 `kojo-lexicon-single-source.test.ts` 同一「直读真源、零手抄」纪律，
 * 不另造第二份词表。上游随时登记新中文主形/别名 ⇒ 只需 `pnpm --filter @kojo/kojo-syntax-tree build`
 * （build 链第一步就是本脚本）；忘了重生成由 `tests/word-forms-single-source.test.ts` 判红。
 *
 * 产物**确定性**：id 键、词形列表、语句词表一律按 UTF-16 码元升序（`sort()` 默认序，
 * 不依赖 locale）；正则择一分支由 DFA 最长匹配裁决、分支书写序不影响行为。
 *
 * 用法（仓库根或本包目录均可）：node packages/kojo-syntax-tree/tools/gen-word-forms.mjs [--check]
 *   --check：只比对既有产物是否与重新生成的一致（不一致退 1，供 CI 用）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/kojo-syntax-tree/tools
const pkgRoot = resolve(here, '..'); // packages/kojo-syntax-tree
const OUT = join(pkgRoot, 'src', 'word-forms.json');

/** 有收束词的三族（开块 id → 收束 id）；顺序即 stable 输出序。 */
const END_FAMILIES = [
  ['block.loop', 'block.loopEnd'],
  ['block.catch', 'block.catchEnd'],
  ['block.dataTable', 'block.dataTableEnd'],
];

/** 读两份零依赖真源模块（Node 原生类型擦除）。 */
export async function loadTruth() {
  const kwUrl = pathToFileURL(
    resolve(pkgRoot, '..', 'plugins', 'kojo-sugar', 'src', 'keywords.ts'),
  ).href;
  const sfUrl = pathToFileURL(
    resolve(pkgRoot, '..', 'plugins', 'kojo-sugar', 'src', 'statement-functions.ts'),
  ).href;
  const kw = await import(kwUrl);
  const sf = await import(sfUrl);
  return {
    words: kw.SUGAR_LEXICON_WORDS,
    headDeclIds: kw.HEAD_DECL_KEYS,
    primaryWord: kw.primaryWord,
    blockEndWord: kw.blockEndWord,
    statementFunctions: sf.STATEMENT_FUNCTIONS,
  };
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 纯投影：真源聚合 → word-forms 数据对象（测试可用**增广词表**做漂移/变异校验）。
 * @param {{words: readonly {word:string;id:string;primary:boolean}[], headDeclIds: readonly string[], primaryWord: (id:string)=>string, blockEndWord: (id:string)=>string, statementFunctions: Map<string,string>}} truth
 */
export function buildWordForms(truth) {
  /** id → 全部词形（中文主形 + 英文别名），码元升序。 */
  const wordsById = {};
  /** id → 中文主形（`primary: true` 那枚；keywords.ts 的 PRIMARY_BY_ID 同一口径）。 */
  const primaryById = {};
  for (const w of truth.words) {
    (wordsById[w.id] ??= []).push(w.word);
    if (w.primary && !(w.id in primaryById)) primaryById[w.id] = w.word;
  }
  for (const id of Object.keys(wordsById)) wordsById[id].sort(cmpStr);

  // 收束词恒等式（keywords.ts 的 BLOCK_END_SUFFIX 派生 vs 表内登记的收束 id）——
  // 上游改后缀而忘登记收束词形 ⇒ 这里立刻抛错（fail-closed），绝不静默产半截词表。
  const endWordOfId = {};
  for (const [openId, endId] of END_FAMILIES) {
    const derived = truth.blockEndWord(openId);
    const registered = primaryById[endId];
    if (registered === undefined) {
      throw new Error(`真源缺收束词形登记：${endId}（应由 blockEndWord('${openId}') = '${derived}'）`);
    }
    if (derived !== registered) {
      throw new Error(`收束词形漂移：blockEndWord('${openId}')='${derived}' ≠ 表内 '${registered}'`);
    }
    endWordOfId[openId] = derived;
  }

  return {
    schema: 1,
    note: '生成文件，禁手改——由 packages/kojo-syntax-tree/tools/gen-word-forms.mjs 从 kojo-sugar 词表真源投影；重生成走本包 build 链。',
    sources: [
      'packages/plugins/kojo-sugar/src/keywords.ts',
      'packages/plugins/kojo-sugar/src/statement-functions.ts',
    ],
    wordsById,
    primaryById,
    endWordOfId,
    headDeclIds: [...truth.headDeclIds],
    statementWords: [...truth.statementFunctions.keys()].sort(cmpStr),
  };
}

/** 稳定序列化（键序 = 构造序；列表已升序 ⇒ 字节可复现）。 */
export function serializeWordForms(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const truth = await loadTruth();
  const text = serializeWordForms(buildWordForms(truth));
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT, 'utf8');
    if (current !== text) {
      console.error('word-forms.json 与真源投影不一致——请重跑 gen-word-forms.mjs');
      process.exit(1);
    }
    console.log('word-forms.json 与真源一致（--check 通过）');
  } else {
    writeFileSync(OUT, text, 'utf8');
    const ids = Object.keys(JSON.parse(text).wordsById).length;
    console.log(`已生成 src/word-forms.json（语义 id ${ids} 个，语句词 ${JSON.parse(text).statementWords.length} 枚）`);
  }
}
