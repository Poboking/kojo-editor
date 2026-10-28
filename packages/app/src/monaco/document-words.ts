import type * as Monaco from './entry';
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
 * 体量纪律（R9，2026-10-28 复核）：超过 {@link WORD_SUGGESTIONS_MAX_LINES} 行不建索引。
 * 索引按 model 版本号记忆化，同一次击键只扫一遍。
 *
 * 这道闸**复核后保留**，但理由换成读数（原来那句"避免每击键全文扫一遍"没有数）：
 * 4,999 行合成语料冷扫 **22.4 ms**、热扫（行级缓存全命中）**2.58 ms**；按线性推到
 * 24,197 行是 **~108 / ~12 ms**。而这条腿**没有可窄化的形状**——词源本来就是整篇的
 * （行内提示能按视口取数、注解的单价由定义数决定，词源不行），它又跑在**补全的每击键**
 * 路径上（建议面板开着时逐键重算）。12 ms/击键是作者能摸到的延迟，所以闸留着。
 * 将来若把词索引做成"按变更行增量"，这道闸才该撤——那时量的是"改一行要多久"。
 */

/** 单个文档词源的候选上限（前缀一条命中的护栏） */
export const MAX_DOCUMENT_WORD_SUGGESTIONS = 200;

/** 词源生效的最大行数（≥ 该值不供词；与 `LARGE_FILE_LINES` 同阈值口径） */
export const WORD_SUGGESTIONS_MAX_LINES = 5000;

/** 索引去重后的词条上限（病态文件里也不把整篇正文塞进 Set） */
const MAX_WORD_INDEX = 4000;

const MIN_WORD_LENGTH = 2;
const MAX_WORD_LENGTH = 32;
const PURE_NUMBER_RE = /^\d+$/;

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
  if (lineCount > WORD_SUGGESTIONS_MAX_LINES) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
    const line = model.getLineContent(lineNumber) ?? '';
    for (const word of lineWords(line, lang)) {
      if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
      if (PURE_NUMBER_RE.test(word)) continue;
      // ERB 名大小写不敏感：索引按大写去重，保留首次出现的写法
      const key = lang === 'erb' ? word.toUpperCase() : word;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
      if (out.length >= MAX_WORD_INDEX) return out;
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
    if (items.length >= MAX_DOCUMENT_WORD_SUGGESTIONS) break;
  }
  return items;
}
