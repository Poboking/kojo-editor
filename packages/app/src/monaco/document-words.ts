import type * as Monaco from './entry';
import { DOCUMENT_WORD_SOURCE } from '@kojo/plugin-api';
import { classifyKojoLine } from './kojo-native-zone';
import { nameWordsOf } from './kojo-completion-position';

/**
 * QSUG-2 · **文档词补全**（语义对位 Monaco 的 `wordBasedSuggestions`，实现走语言侧位置门）。
 *
 * 为什么不用 Monaco 内建：它的 `WordBasedCompletionItemProvider` 只读
 * `editor.wordBasedSuggestions` 配置，**在任意光标位置出货**——`.kojo` 的台词 / 旁白行
 * 会被当成普通文本，弹出一整片文档词。那正是 QSUG-1 刚收掉的噪声。故内建选项恒为
 * `off`（`editor-options.ts`），由本模块作为补全装配的**最后一个候选源**出货：
 *
 * - 位置门由各语言装配的 `locate` 先过（`.kojo` 台词 / 旁白 / 注释、`.erb` 字符串 / 注释
 *   在装配层已经零候选）；
 * - 词索引只收**代码行**（`.kojo` 的 `text` / `heartText` / `comment` 行不取词；`.erb`
 *   去掉 `;` 注释与双引号字符串内容）；
 * - 与上下文候选同一张去重表（先注册者胜）⇒ 同名的中文关键字 / 函数名不会被词源复读；
 * - 单文件词源，不跨文件（`wordBasedSuggestions: 'currentDocument'` 的对位口径）。
 *
 * 体量纪律（R9，2026-10-28 复核；1103 KW-25 把数字换成单源 + 复读）：超过
 * `DOCUMENT_WORD_SOURCE.maxLines` 行不建索引。**这一批数字的真源在契约层**
 * （`@kojo/plugin-api` 的 `DOCUMENT_WORD_SOURCE`），因为同一条判据有两条生产路：本文件
 * 服务 `.kojo` 与 `.kojo1` 原生区，`.erb` 的生产路早在 LAU-4 第三批搬进了插件
 * （`erb-parser/src/completion.ts`），搬的时候抄了一份同名同值的 ⇒ 两份真源。
 * 索引按 model 版本号记忆化，同一次击键只扫一遍。
 *
 * 这道闸**复核后保留**，理由换成读数（原来那句"避免每击键全文扫一遍"没有数）：
 * 1103 同机实测（5,000 行合成语料，光标落在赋值右端的词尾，本轮把插件切词器修好之后的数）
 * ——**本文件这一侧**真冷扫（每轮换一份新文本，绕开行缓存与版本记忆化）13.65–21.31 ms
 * （两次夹具形态不同给的区间）、版本记忆化直接命中 **0.04 ms**；与 10-28 那组读数
 * （冷扫 22.4 ms / 行缓存全命中 2.58 ms）在冷扫那一档同阶，复核通过。
 * **插件那一侧**同一个体量是 **33.57 ms/请求**（关掉词源 1.97 ms ⇒ 词源一腿
 * ≈**31.6 ms**，出货截到 200 条上限：搬过去的判据没带上行缓存，每请求都从
 * `splitEolLines` 起冷扫）。与 10-28 头注的**冲突点**就在这个数上：旧注按宿主这一侧的
 * 22.4 ms 记账，而今天 `.erb` 走的是插件那条**贵一半**的路。两侧都按线性推到 24,197 行
 * 是 ~100 / ~150 ms。而这条腿**没有可窄化的形状**——词源本来就是整篇的（行内提示能按
 * 视口取数、注解的单价由定义数决定，词源不行），它又跑在**补全的每击键**路径上
 * （建议面板开着时逐键重算）。31.6 ms/击键是作者能摸到的延迟，所以闸留着。
 * 将来若把词索引做成"按变更行增量"（插件侧先补上行缓存才算），这道闸才该撤——那时量的
 * 是"改一行要多久"。
 */

export type DocumentWordLanguage = 'kojo' | 'erb';

/** 一行里除字符串内容 / 行注释外的代码部分（`"` 配平口径与 `insideStringOrComment` 一致） */
function stripStringsAndComment(line: string): string {
  let out = '';
  let inString = false;
  for (const ch of line) {
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ';') break;
    out += ch;
  }
  return out;
}

function computeLineWords(line: string, lang: DocumentWordLanguage): readonly string[] {
  if (lang === 'kojo') {
    const kind = classifyKojoLine(line).kind;
    // 台词 / 旁白 / 心形正文 / 注释都不是代码：这些行里的词不许进补全面板
    if (kind === 'text' || kind === 'heartText' || kind === 'comment') return [];
  }
  return nameWordsOf(stripStringsAndComment(line));
}

/**
 * 行文本 → 词条的记忆化（**跨 model 版本**）：`classifyKojoLine` 是全篇最贵的一步
 * （5,000 行合成语料实测 ~50ms），但一次击键只改一行——其余行按**原文**命中缓存，
 * 全篇扫描退化为 5,000 次 Map 查询（同语料实测 ~3ms）。
 *
 * 上限只防内存无界（跨文件累计；超出即整表清空，宁可多算一轮也不留无界增长）。
 */
const MAX_LINE_CACHE = 20_000;
const lineWordCache: Record<DocumentWordLanguage, Map<string, readonly string[]>> = {
  kojo: new Map(),
  erb: new Map(),
};

function lineWords(line: string, lang: DocumentWordLanguage): readonly string[] {
  const cache = lineWordCache[lang];
  const hit = cache.get(line);
  if (hit !== undefined) return hit;
  const words = computeLineWords(line, lang);
  if (cache.size >= MAX_LINE_CACHE) cache.clear();
  cache.set(line, words);
  return words;
}

function collectWords(model: Monaco.editor.ITextModel, lang: DocumentWordLanguage): readonly string[] {
  const lineCount = typeof model.getLineCount === 'function' ? model.getLineCount() : 0;
  if (lineCount > DOCUMENT_WORD_SOURCE.maxLines) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
    const line = model.getLineContent(lineNumber) ?? '';
    for (const word of lineWords(line, lang)) {
      if (word.length < DOCUMENT_WORD_SOURCE.minWordLength || word.length > DOCUMENT_WORD_SOURCE.maxWordLength)
        continue;
      if (DOCUMENT_WORD_SOURCE.isPureNumber(word)) continue;
      // ERB 名大小写不敏感：索引按大写去重，保留首次出现的写法
      const key = lang === 'erb' ? word.toUpperCase() : word;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
      if (out.length >= DOCUMENT_WORD_SOURCE.maxIndexedWords) return out;
    }
  }
  return out;
}

interface WordCacheEntry {
  readonly versionId: number;
  readonly lang: DocumentWordLanguage;
  readonly words: readonly string[];
}

const wordCache = new WeakMap<Monaco.editor.ITextModel, WordCacheEntry>();

function versionOf(model: Monaco.editor.ITextModel): number | null {
  try {
    return typeof model.getVersionId === 'function' ? model.getVersionId() : null;
  } catch {
    return null;
  }
}

function wordsFor(model: Monaco.editor.ITextModel, lang: DocumentWordLanguage): readonly string[] {
  const versionId = versionOf(model);
  if (versionId === null) return collectWords(model, lang);
  const cached = wordCache.get(model);
  if (cached !== undefined && cached.versionId === versionId && cached.lang === lang) return cached.words;
  const words = collectWords(model, lang);
  wordCache.set(model, { versionId, lang, words });
  return words;
}

/**
 * 产出当前文档的单词候选（**纯函数**，供语言侧 source 调用）。
 *
 * - 光标前必须已有非空词前缀（空行 / 纯标点处不铺整张词表）；
 * - 与已输入词完全相同的不出（插了也是原位不动）；
 * - `insertText` / `filterText` 都是词原文，`kind` = `Text`（与 Monaco 内建词建议同视觉档），
 *   `sortText` 以 `9_` 打头 ⇒ 同前缀档内排在上下文候选之后。
 */
export function documentWordItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  range: Monaco.IRange,
  lang: DocumentWordLanguage,
): Monaco.languages.CompletionItem[] {
  if (typeof model.getWordUntilPosition !== 'function') return [];
  const word = model.getWordUntilPosition(position).word;
  if (word.length === 0) return [];

  const prefix = word.toLowerCase();
  const kind = monaco.languages.CompletionItemKind.Text;
  const items: Monaco.languages.CompletionItem[] = [];
  for (const candidate of wordsFor(model, lang)) {
    const lower = candidate.toLowerCase();
    if (lower === prefix) continue;
    if (!lower.startsWith(prefix)) continue;
    items.push({
      label: candidate,
      kind,
      insertText: candidate,
      filterText: candidate,
      detail: '文档词',
      range,
      sortText: `9_${candidate}`,
    });
    if (items.length >= DOCUMENT_WORD_SOURCE.maxSuggestions) break;
  }
  return items;
}
