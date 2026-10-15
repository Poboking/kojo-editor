import type * as Monaco from 'monaco-editor';

/**
 * EC-3 · `.erb` **函数名补全** —— 定义位（行首 `@<前缀>`）与调用位
 * （`CALL` / `CALLFORM` / `TRYCALL` / `TRYCALLFORM` / `TRYCALLFORMF` / `TRYCCALLFORM` /
 * `JUMP` … 之后）弹出项目函数名候选。
 *
 * 名字来源 = 基座传入的 `functionNames`（`ErbIndex.byName` 的键，按 `fingerprint` 记忆化）；
 * 本模块**不读盘、不 import 内核 / 插件**，只做上下文判定 + 过滤 + 出项。
 * Monaco provider 注册刻意不在此处——编排层负责把本函数接进补全基座。
 *
 * ## 性能做法（硬约束：候选可达 ~10 万条）
 * 「逐条 `startsWith` 全扫」在 10 万条上每击键就是 10 万次调用，与项目体量线性挂钩。
 * 这里改为**前缀区间级**：
 * 1. **按数组身份记忆化前缀索引**（`WeakMap<object, PrefixIndex>`）——基座按 fingerprint
 *    记忆化后反复传**同一个数组引用**，故索引只建一次。索引 = 归一化名（大写）**升序**数组
 *    + 平行条目数组；建一次 `O(n log n)`（合成 10 万条实测冷建 ~100 ms，**按数组身份只建一次**，
 *    均摊到每次补全可忽略）。
 * 2. 单次过滤 = 二分找前缀**下界**，再自下界**连续前扫**到不再命中 ⇒ `O(log n + 命中数)`，
 *    **与总量无关**。合成 10 万条实测单次（前缀命中 100 条）**< 0.1 ms**（见同目录测试）。
 *
 * 前缀匹配**大小写不敏感**（Emuera 函数名大小写不敏感，与 `ErbIndex.normalizedName` 同口径）。
 * 命中集有**条数上限**（`MAX_ITEMS`）——空前缀 / 极短前缀会命中全部候选，逐条造对象既慢又
 * 无意义；上限内的顺序**前缀精确优先，其次按名（归一化升序）**。
 *
 * 纯函数 + 薄 Monaco 翻译（纪律同 `kojo-completion-faces.ts`）：位置不符 / 名字表缺省
 * ⇒ 返回 `[]`，**绝不猜、绝不抛**。
 */

/** 名字字符集（正向定义；ASCII 词字符 + 假名 + 汉字 + 全角字母数字 + 半角片假名） */
const NAME_CHAR_RE =
  /[0-9A-Za-z_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9f]/;

/** 单次补全的命中上限（防空前缀命中 10 万条时造整表对象；精确/升序保证上限内即先见常用名） */
const MAX_ITEMS = 1000;

/** 定义位：行首可选空白 + `@`（`@` 之后即函数名） */
const DEF_RE = /^[ \t]*@/;

/**
 * 调用位关键字（长词在前；`i` 使指令大小写不敏感）。
 * `FORM` 类关键字（含 `FORM` 子串）后的名字槽是 FORM 串，可含 `%…%` / `{…}` 段。
 */
const CALL_RE =
  /^[ \t]*(TRYCALLFORMF|TRYCALLFORM|TRYCCALLFORM|CALLFORML|CALLFORMF|CALLFORM|CALLL|CALLF|CALL|TRYCALL|TRYJUMP|JUMP)[ \t]+/i;

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && NAME_CHAR_RE.test(ch);
}

/** 一次补全的「名字段」位置（0 基区间 + 光标前已输入前缀） */
interface NameContext {
  /** 名字段起点（0 基，含）——替换范围左界 */
  readonly start: number;
  /** 名字段终点（0 基，不含）——替换范围右界 */
  readonly end: number;
  /** 光标前已输入的名字前缀（用于过滤 / 排序） */
  readonly prefix: string;
}

/** 名字槽是否**停在**未闭合的 `%…%` / `{…}` 内（严格在插值里 ⇒ 不猜） */
function insideInterp(section: string): boolean {
  let pct = 0;
  let brace = 0;
  for (const ch of section) {
    if (ch === '%') pct++;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
  }
  return pct % 2 === 1 || brace !== 0;
}

/**
 * 解析「名字槽」里的补全位置（**纯函数**；`col0` = 0 基列）。
 *
 * `boundStart` = 名字槽左界（`@` 之后 / 调用关键字 + 空白之后）；名字槽右界 = 该界之后
 * 第一个 `(` / `;` / 空白。返回 `null` = 该处不是可补全的名字位置：
 * 光标越过槽右界 / 非 `allowInterp` 槽里混入非名字字符 / `allowInterp` 槽里光标严格停在
 * 未闭合插值内——**一律不猜**。
 */
function parseNameSlot(
  lineText: string,
  col0: number,
  boundStart: number,
  allowInterp: boolean,
): NameContext | null {
  if (col0 < boundStart) return null;

  let slotEnd = boundStart;
  while (slotEnd < lineText.length) {
    const ch = lineText[slotEnd]!;
    if (ch === '(' || ch === ';' || ch === ' ' || ch === '\t') break;
    slotEnd++;
  }
  if (col0 > slotEnd) return null;

  const section = lineText.slice(boundStart, col0);
  if (allowInterp) {
    if (insideInterp(section)) return null;
  } else if (![...section].every(isNameChar)) {
    return null;
  }

  let start = col0;
  while (start > boundStart && isNameChar(lineText[start - 1])) start--;
  let end = col0;
  while (end < lineText.length && isNameChar(lineText[end])) end++;

  return { start, end, prefix: lineText.slice(start, col0) };
}

/** 归一化候选条目 */
interface Candidate {
  readonly name: string;
  readonly file?: string;
}

/** 记忆化的前缀索引：归一化名升序 + 平行条目 */
interface PrefixIndex {
  readonly keys: readonly string[];
  readonly entries: readonly Candidate[];
}

/** 按数组身份（基座按 fingerprint 记忆化的那个数组）缓存前缀索引 */
const INDEX_CACHE = new WeakMap<object, PrefixIndex>();

function prefixIndexFor(
  functionNames: readonly (string | { name: string; file?: string })[],
): PrefixIndex {
  const cached = INDEX_CACHE.get(functionNames);
  if (cached !== undefined) return cached;

  const seen = new Set<string>();
  const pairs: { key: string; entry: Candidate }[] = [];
  for (const item of functionNames) {
    const name = typeof item === 'string' ? item : item.name;
    if (name.length === 0) continue;
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const file = typeof item === 'string' ? undefined : item.file;
    pairs.push({ key, entry: file === undefined ? { name } : { name, file } });
  }
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const index: PrefixIndex = {
    keys: pairs.map((p) => p.key),
    entries: pairs.map((p) => p.entry),
  };
  INDEX_CACHE.set(functionNames, index);
  return index;
}

/** 首个小写等于或大于 `target` 的下标（升序数组；`target` 已归一化为大写） */
function lowerBound(keys: readonly string[], target: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 产出 `.erb` 函数名补全候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标落在**定义位**（行首 `@` 之后的名字槽）或**调用位**（`CALL` 系 / `JUMP`
 * 之后的名字槽，FORM 关键字允许 `%…%` / `{…}` 段）时产出候选；名字取自 `functionNames`
 * （唯一真源，由基座传入），`kind` = `Function`，`insertText` = 名字（定义位**不再插
 * `@`**——`@` 已在文里），替换范围**只覆盖名字那一段**；排序受控（前缀精确优先，其次按名）。
 * 位置不符 / `functionNames` 缺省或为空 ⇒ 返回 `[]`，不抛。
 */
export function erbFunctionCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  functionNames: readonly (string | { name: string; file?: string })[] | undefined,
): Monaco.languages.CompletionItem[] {
  if (!monaco || !model || !position) return [];
  if (!functionNames || functionNames.length === 0) return [];
  const lineNumber = position.lineNumber;
  const column = position.column;
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return [];
  if (!Number.isFinite(column) || column < 1) return [];

  const line = model.getLineContent(lineNumber);
  const col0 = Math.min(column - 1, line.length);

  let context: NameContext | null = null;
  const def = DEF_RE.exec(line);
  if (def !== null) {
    context = parseNameSlot(line, col0, def[0].length, false);
  } else {
    const call = CALL_RE.exec(line);
    if (call !== null) {
      const allowInterp = call[1]!.toUpperCase().includes('FORM');
      context = parseNameSlot(line, col0, call[0].length, allowInterp);
    }
  }
  if (context === null) return [];

  const index = prefixIndexFor(functionNames);
  const keys = index.keys;
  const norm = context.prefix.toUpperCase();
  const from = lowerBound(keys, norm);
  if (from >= keys.length || !keys[from]!.startsWith(norm)) return [];

  const range: Monaco.IRange = {
    startLineNumber: lineNumber,
    endLineNumber: lineNumber,
    startColumn: context.start + 1,
    endColumn: context.end + 1,
  };
  const kind = monaco.languages.CompletionItemKind.Function;

  const items: Monaco.languages.CompletionItem[] = [];
  for (let i = from; i < keys.length && items.length < MAX_ITEMS; i++) {
    const key = keys[i]!;
    if (!key.startsWith(norm)) break;
    const entry = index.entries[i]!;
    const exact = key === norm;
    items.push({
      label: entry.name,
      kind,
      insertText: entry.name,
      range,
      sortText: `${exact ? '0' : '1'}_${entry.name}`,
      ...(entry.file !== undefined ? { detail: entry.file } : {}),
    });
  }
  return items;
}
