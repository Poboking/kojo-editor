import type { SearchOptionsState } from './search-store';

/**
 * 全文替换的**纯逻辑**（无 React、无 IPC、无 Monaco）：把「查询 + 三个开关 + 替换模板」
 * 变成对一段现文本的逐处命中与改写计划。抽独立模块的理由与 `search-query.ts` 同款——
 * 这是数据判据，不是渲染细节；替换是**写盘操作**，判据必须独立成模块才钉得住。
 *
 * ## 与检索语义的对齐
 *
 * 命中判定在**本层用 JS 正则现场重做**，不信任检索结果的坐标：检索（Rust 侧）与替换
 * （本层）之间隔着一次异步，作者可能已经改了文件。全部替换对**现文本**重新逐行匹配
 * ——坐标天生就是现在的，不存在"陈旧坐标硬写"；单条替换才拿检索结果的行列做起点，
 * 并用 sticky 正则在该列上验证（见 `planSingleReplacement`）。
 *
 * ## 全词边界（与 erb-rename 的 IDENT_RE 同口径）
 *
 * JS 的 `\b` 是 ASCII 口径，CJK 不是 `\w`——真语料 21% 的函数名含 CJK，`\b` 会静默
 * 漏配。这里不用 `\b`，命中后**逐侧看一格字符**（Unicode 字母/数字/下划线即非边界），
 * 行内判定（与 Rust 侧逐行检索的口径一致：跨行的"词边界"不是这条检索的语义）。
 *
 * ## 宽度折叠（2026-10-20，与检索侧同表）
 *
 * 中文作者常把 `（` 打成 `(`、把 `Ａ` 打成 `A`。检索与替换两侧都做**全角/半角折叠**
 * （U+FF01–U+FF5E ↔ U+0021–U+007E、U+3000 ↔ 空格），否则"搜得到、替换不到"会分叉：
 * 字面量查询逐字符展开成"宽度等价类"（一个同时含 `(` 与 `（` 的字符类），命中偏移
 * 仍落在原文上；全词边界先折相邻一格再判标识字符（`＿` 折成 `_` ⇒ 标识字符）。
 *
 * **只折宽度**：不折繁简（`髙`≠`高`）、不折假名、不折大小写（大小写仍由 `i` 标志 /
 * `caseSensitive` 管）。正则模式**不折**——作者拥有 pattern 的解释权，折叠会改写
 * 转义/字符类/量词语义；需要精确宽度匹配时，正则模式就是逃生口。
 *
 * 恒开、无开关。影响面（与 Rust 侧同步记录）：搜 `Ａ` 也会命中 `A`、搜 `(` 也会命中
 * `（`——这正是本功能的目的；代价是字面量检索不再"逐字节精确"，精确需求走正则模式。
 *
 * 跨语言契约：折叠表与 Rust `src-tauri/src/lib.rs` 的 `fold_width` / `literal_width_pattern`
 * **同一张表**；样例数组 `WIDTH_FOLD_CASES` 与 `search_tests.rs` 的同名常量逐字同源。
 * **改一处必须改两处**。
 */

/** 标识字符（与 `erb-rename.ts` 的 IDENT_RE 同一字符集，单字符判定） */
const IDENT_RE = /[\p{L}\p{N}_]/u;

/**
 * 宽度折叠的**规范形**（半角）：全角 ASCII 区 U+FF01–U+FF5E 折回 U+0021–U+007E，
 * U+3000（全角空格）折成 U+0020，其余字符原样。**只折宽度**——不折繁简、不折假名、
 * 不折大小写（那是 `caseSensitive` 开关的事）。
 *
 * 与 Rust `lib.rs` 的 `fold_width` **同一张表**（同一组码点区间与位移 0xFEE0）；
 * **改一处必须改两处**。
 */
function foldWidth(ch: string): string {
  const cp = ch.charCodeAt(0);
  if (cp >= 0xff01 && cp <= 0xff5e) return String.fromCharCode(cp - 0xfee0);
  if (cp === 0x3000) return ' ';
  return ch;
}

/** 规范半角形 → 另一半（全角形）：U+0021–U+007E → U+FF01–U+FF5E，空格 → U+3000。 */
function unfoldWidth(ch: string): string {
  const cp = ch.charCodeAt(0);
  if (cp >= 0x21 && cp <= 0x7e) return String.fromCharCode(cp + 0xfee0);
  if (cp === 0x20) return '\u3000';
  return ch;
}

/** 字符类内需要转义的四个字符（其余正则元字符在类内本就是字面）。 */
const CLASS_SPECIAL = new Set(['\\', ']', '^', '-']);

function escapeClassChar(ch: string): string {
  return CLASS_SPECIAL.has(ch) ? `\\${ch}` : ch;
}

/**
 * 字面量查询 → **宽度折叠等价**的正则源码：每个字符展开成它的宽度等价类。
 * 逐字符一一展开、长度不变 ⇒ 命中偏移仍落在原文上（与 Rust `literal_width_pattern` 同形）。
 */
function foldLiteralSource(query: string): string {
  let out = '';
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!;
    const half = foldWidth(ch);
    const full = unfoldWidth(half);
    if (half === full) out += escapeRegExp(half);
    else out += `[${escapeClassChar(half)}${escapeClassChar(full)}]`;
  }
  return out;
}

function isIdentChar(ch: string | undefined): boolean {
  // 先折宽度再判：`＿`（U+FF3F）折成 `_` 后是标识字符，与半角写法同判
  return ch !== undefined && IDENT_RE.test(foldWidth(ch));
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 单处命中：行内 0 基半开区间 + 供 $1 展开的捕获组（`groups[0]` = 第一个捕获组） */
export interface ReplaceHit {
  readonly start: number;
  readonly end: number;
  readonly whole: string;
  readonly groups: readonly string[];
}

/**
 * 替换匹配器：同一份查询源，`global` 供逐行扫描、`sticky` 供定列验证。
 * **每次取用都新建实例**——global 正则的 `lastIndex` 是状态，跨行共享必串线。
 */
export interface ReplaceMatcher {
  global(): RegExp;
  sticky(): RegExp;
  readonly wholeWord: boolean;
}

/**
 * 编译替换匹配器（**纯函数**）。
 *
 * - 非正则模式：整词转义后按字面匹配，并做**宽度折叠**（`（` 与 `(` 同一类，见
 *   `foldLiteralSource` 与模块头的折叠表）；
 * - 正则模式：作者的正则原样进引擎（**不折宽度**——作者拥有 pattern 的解释权；
 *   非法正则抛错，由调用方明示，不静默吞）；
 * - 大小写不敏感 = `i` 标志（与检索开关同语义；宽度与大小写是两个维度）。
 *
 * 空查询返回 `null`（空串匹配每一处 = 灾难，前置挡下）。
 */
export function compileReplaceMatcher(
  query: string,
  opts: Pick<SearchOptionsState, 'isRegex' | 'caseSensitive' | 'wholeWord'>,
): ReplaceMatcher | null {
  const source = query === '' ? null : opts.isRegex ? query : foldLiteralSource(query);
  if (source === null) return null;
  const flags = opts.caseSensitive ? '' : 'i';
  new RegExp(source, flags); // 合法性当场验证：非法正则在这里抛，执行层明示给作者
  return {
    wholeWord: opts.wholeWord,
    global: () => new RegExp(source, `g${flags}`),
    sticky: () => new RegExp(source, `y${flags}`),
  };
}

/** 命中处两侧都不是标识字符（或贴着行首/行尾）才算全词 */
function wholeWordOk(line: string, start: number, end: number): boolean {
  if (isIdentChar(line[start - 1])) return false;
  if (isIdentChar(line[end])) return false;
  return true;
}

/** 一行内的全部命中（wholeWord 在此过滤；匹配推进不重叠） */
export function planLineMatches(line: string, m: ReplaceMatcher): ReplaceHit[] {
  const re = m.global();
  const hits: ReplaceHit[] = [];
  for (let g = re.exec(line); g !== null; g = re.exec(line)) {
    const [whole, ...groups] = g;
    const start = g.index;
    const end = start + whole.length;
    if (!m.wholeWord || wholeWordOk(line, start, end)) {
      hits.push({ start, end, whole, groups });
    }
    if (whole.length === 0) re.lastIndex++; // 空匹配防死循环（正则模式可能写出）
  }
  return hits;
}

/**
 * 替换模板展开：`$&` = 整个命中，`$1`–`$99` = 捕获组（越界 = 空串），`$$` = 字面 `$`。
 * 其余 `$x` 原样保留——不猜（作者写错引用号，改出来不该是悄悄吞掉一个字符）。
 *
 * `opts.preserveCase`（P2-15）：展开完成后把命中处的大小写形态借给替换词，
 * 判据见 `preserveReplacementCase`。缺省 `false` = 原样展开（老调用方零改动）。
 */
export function expandReplacement(
  template: string,
  hit: Pick<ReplaceHit, 'whole' | 'groups'>,
  opts?: ReplaceCaseOpts,
): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch !== '$' || i === template.length - 1) {
      out += ch;
      continue;
    }
    const next = template[i + 1]!; // 走到这说明 ch === '$' 且不是末字符，后一位必存在
    if (next === '$') {
      out += '$';
      i++;
    } else if (next === '&') {
      out += hit.whole;
      i++;
    } else if (next >= '1' && next <= '9') {
      // 两位数组号优先（与 JS String.replace 同语义）：$12 = 第 12 组**存在时**才取，
      // 否则回落 $1 + 字面 '2'（越界组静默变空串会把字面数字一起吞掉）
      const two = template.slice(i + 1, i + 3);
      const n2 = /^\d{2}$/.test(two) ? Number(two) : 0;
      if (n2 >= 10 && n2 <= 99 && n2 <= hit.groups.length) {
        out += hit.groups[n2 - 1] ?? '';
        i += 2;
      } else {
        out += hit.groups[Number(next) - 1] ?? '';
        i++;
      }
    } else {
      out += ch;
    }
  }
  // 保留大小写发生在展开**之后**：模板可能展开成 $&（= 命中本身，映射恒等），
  // 也可能展开成字面词——该借形态的是最终落盘的那串文本
  return opts?.preserveCase === true ? preserveReplacementCase(hit.whole, out) : out;
}

/** 替换的大小写选项（P2-15；缺省不开 = 老行为逐字不变） */
export interface ReplaceCaseOpts {
  readonly preserveCase?: boolean;
}

/** 字符有没有大小开形态（CJK / 数字 / 符号没有——借形态时它们原样站桩） */
const isCased = (ch: string): boolean => ch.toLowerCase() !== ch.toUpperCase();
/** 有大小写形态的字符是否正处于大写形态 */
const isUpper = (ch: string): boolean => isCased(ch) && ch === ch.toUpperCase();

/** 置大写（ß→SS 这类"一个字符对多个字符"的映射会改内容，只做长度 1 的；否则原样） */
function toUpper1(ch: string): string {
  const u = ch.toUpperCase();
  return u.length === 1 ? u : ch;
}

/** 置小写（同上：长度 1 才映射） */
function toLower1(ch: string): string {
  const l = ch.toLowerCase();
  return l.length === 1 ? l : ch;
}

/**
 * 把命中处的大小写形态借给替换词（P2-15「替换保留大小写」；**纯函数**）。
 *
 * 与常见编辑器（VSCode / JetBrains）同语义，偏好缺省**开**（理由见
 * `search-query.ts` 的偏好注释：脚本域里大写常常有含义，悄悄改小写比不改更糟）。
 *
 * ## 四种形态（各有一条单测钉死）
 * 1. 命中**全大写**（有大小写字符且无小写）⇒ 替换词全大写：`FOO` + `bar` ⇒ `BAR`；
 * 2. 命中**首字母大写**（首个大小写字符大写、其余全小写）⇒ 替换词首字母大写、
 *    其余小写：`Foo` + `bar` ⇒ `Bar`；
 * 3. 命中**混合大小写** ⇒ **逐位**映射：`fOo` + `bar` ⇒ `bAr`（命中第 i 位是大写，
 *    替换词第 i 位就大写；命中那位不是大小写字符 ⇒ 保留替换词自身形态）；
 * 4. **原样 / 回落**——形态映射不了时回落替换词原文，**理由写在下面**（不静默）：
 *    - 命中里一个大小写字符都没有（CJK / 数字 / 符号）：无可辨形态可借；
 *    - 替换词长于命中：命中的形态信息只有那么多字符宽，多出来的位没有来源。
 *      按"前半截映射、后半截留原样"会产出 `FOO`→`barbar` ⇒ `BARbar` 这种半截
 *      全大写——比原样更容易误读，故整条回落；
 *    - 替换词自己带着大写：作者显式写的大写 = 显式意图，原样尊重
 *      （命中 `foo` + 替换词 `BAR` ⇒ `BAR`，与 F2 rename 对拍口径一致）。
 *
 * ## 长度不一致的口径（写在这里，不靠猜）
 * - 替换词**短于或等长于**命中：照常映射（形态 1/2 整词映射；形态 3 逐位映射前
 *   `替换词长度` 位——超出的命中位反正会被换掉，无位可映射也不影响）；
 * - 替换词**长于**命中：整条回落替换词原文（见回落理由第 2 条）。
 *
 * 索引一律按**码点**（不是 UTF-16 单元）：代理对（emoji）在两种下标体系里宽度不同，
 * 逐位映射用码点才谈得上"第 i 位对第 i 位"。
 */
export function preserveReplacementCase(hit: string, replacement: string): string {
  if (replacement === '') return replacement; // 删除命中：没有可映射的位
  const hitChars = [...hit];
  const replChars = [...replacement];
  const cased = hitChars.filter(isCased);
  // 回落 ①：命中无可辨形态（CJK / 数字 / 符号）
  if (cased.length === 0) return replacement;
  // 回落 ③：替换词自带大写 ⇒ 显式意图，原样尊重
  if (replChars.some(isUpper)) return replacement;
  // 回落 ②：替换词长于命中 ⇒ 形态宽度不够，整条回落（理由见上）
  if (replChars.length > hitChars.length) return replacement;
  // 形态 1：命中全大写 ⇒ 替换词全大写
  if (cased.every(isUpper)) return replacement.toUpperCase();
  // 形态 2：命中首字母大写、其余全小写 ⇒ 替换词首字母大写、其余小写
  if (isUpper(cased[0]!) && cased.slice(1).every((ch) => !isUpper(ch))) {
    return toUpper1(replChars[0]!) + replChars.slice(1).map(toLower1).join('');
  }
  // 形态 3：混合 ⇒ 逐位映射（命中非大小写字符位保留替换词自身形态）
  return replChars.map((ch, i) => {
    const h = hitChars[i];
    if (h === undefined || !isCased(h)) return ch;
    return isUpper(h) ? toUpper1(ch) : toLower1(ch);
  }).join('');
}

/** 一行的改写计划：0 基半开区间 → 新文本（替换串按命中从后往前才不位移） */
export interface LineEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** 跨行的编辑计划（行号 1 基，与 Monaco 行号同口径） */
export interface FileLineEdit extends LineEdit {
  readonly lineNumber: number;
}

/** 一行：命中 → 展开替换文本（顺序天然从左到右，写入方自行降序应用）。
 *  `opts.preserveCase` 透传给 `expandReplacement`（P2-15；缺省 false = 老行为）。 */
export function planLineEdit(line: string, m: ReplaceMatcher, template: string, opts?: ReplaceCaseOpts): LineEdit[] {
  return planLineMatches(line, m).map((h) => ({
    start: h.start,
    end: h.end,
    text: expandReplacement(template, h, opts),
  }));
}

/**
 * 把逐行编辑落进整篇文本（**纯函数**；闭文件 io 通道与单测共用）。
 * 同一行内降序应用：前面的偏移才不会因替换而位移（与 `erb-rename` 的 ops 排序同款）。
 */
export function applyLineEdits(lines: readonly string[], edits: readonly FileLineEdit[]): string {
  const byLine = new Map<number, LineEdit[]>();
  for (const e of edits) {
    const list = byLine.get(e.lineNumber);
    if (list) list.push(e);
    else byLine.set(e.lineNumber, [e]);
  }
  const next = lines.slice();
  for (const [lineNumber, list] of byLine) {
    let line = next[lineNumber - 1]!;
    for (const e of [...list].sort((a, b) => b.start - a.start)) {
      line = line.slice(0, e.start) + e.text + line.slice(e.end);
    }
    next[lineNumber - 1] = line;
  }
  return next.join('\n');
}

/** 单条替换的裁决：可替换（带展开文本）或拒绝（理由给作者看） */
export type SingleReplaceVerdict =
  | { readonly kind: 'replace'; readonly start: number; readonly end: number; readonly text: string }
  | { readonly kind: 'skip'; readonly reason: string };

/**
 * 单条替换（**纯函数**；`col0` = 检索结果给的 0 基列）。
 *
 * sticky 正则在 `col0` 上**定死起点**匹配：命中不到（文本已移走）或命中文本与检索时
 * 的原文不一致（大小写不敏感比对，`expected` = 检索结果里那一小段）⇒ 拒绝并给理由
 * ——陈旧坐标绝不硬写（与 `erb-rename` 的 live 验证同一条纪律）。
 * `expected` 传 `null` 跳过内容比对（调用方明确知道文本是现的）。
 */
export function planSingleReplacement(
  line: string,
  col0: number,
  m: ReplaceMatcher,
  template: string,
  expected: string | null,
  opts?: ReplaceCaseOpts,
): SingleReplaceVerdict {
  if (!Number.isInteger(col0) || col0 < 0 || col0 > line.length) {
    return { kind: 'skip', reason: '列号越界（文本已变化）' };
  }
  const re = m.sticky();
  re.lastIndex = col0;
  const g = re.exec(line);
  if (g === null || g.index !== col0) {
    return { kind: 'skip', reason: '该处已不匹配检索词（文本已变化）' };
  }
  if (!m.wholeWord || wholeWordOk(line, col0, col0 + g[0].length)) {
    if (expected !== null && g[0].toLowerCase() !== expected.toLowerCase()) {
      return { kind: 'skip', reason: '该处文本与检索结果不一致（文本已变化）' };
    }
    return {
      kind: 'replace',
      start: col0,
      end: col0 + g[0].length,
      text: expandReplacement(template, { whole: g[0], groups: g.slice(1) }, opts),
    };
  }
  return { kind: 'skip', reason: '该处不再是全词命中（文本已变化）' };
}
