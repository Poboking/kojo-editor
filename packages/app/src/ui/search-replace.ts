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
 */

/** 标识字符（与 `erb-rename.ts` 的 IDENT_RE 同一字符集，单字符判定） */
const IDENT_RE = /[\p{L}\p{N}_]/u;

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_RE.test(ch);
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
 * - 非正则模式：整词转义后按字面匹配；
 * - 正则模式：作者的正则原样进引擎（非法正则抛错，由调用方明示，不静默吞）；
 * - 大小写不敏感 = `i` 标志（与检索开关同语义）。
 *
 * 空查询返回 `null`（空串匹配每一处 = 灾难，前置挡下）。
 */
export function compileReplaceMatcher(
  query: string,
  opts: Pick<SearchOptionsState, 'isRegex' | 'caseSensitive' | 'wholeWord'>,
): ReplaceMatcher | null {
  const source = query === '' ? null : opts.isRegex ? query : escapeRegExp(query);
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
 */
export function expandReplacement(template: string, hit: Pick<ReplaceHit, 'whole' | 'groups'>): string {
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
  return out;
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

/** 一行：命中 → 展开替换文本（顺序天然从左到右，写入方自行降序应用） */
export function planLineEdit(line: string, m: ReplaceMatcher, template: string): LineEdit[] {
  return planLineMatches(line, m).map((h) => ({
    start: h.start,
    end: h.end,
    text: expandReplacement(template, h),
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
      text: expandReplacement(template, { whole: g[0], groups: g.slice(1) }),
    };
  }
  return { kind: 'skip', reason: '该处不再是全词命中（文本已变化）' };
}
