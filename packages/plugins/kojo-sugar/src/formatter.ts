/**
 * 文档格式化（`Shift+Alt+F`）核心 —— **纯函数**：文本进、行级 edits 出。
 * 零 IO、零 Monaco、零内核依赖；宿主侧（`packages/app/src/monaco/kojo-format.ts`）
 * 只做 Monaco 协议翻译，E2「保存时格式化」也复用这同一份规则（不许有第二真源）。
 *
 * ## 为什么住 `kojo-sugar` 而不是 kernel / 契约层
 *
 * 缩进对 `.kojo` 是语法的一部分，而层级的唯一算法是这里的 `indentLevel`
 * （TAB = 1 级、`U+3000` = 2 空格、空格 = `ceil(n/4)`）与行分类的 `classifyLine`
 * /`inlineCommentIndex`。格式化若不在同一层实现，就必然要抄一份判据——抄的那刻起
 * "改缩进不改语义"这个保证就没了。ERB 形只是**同一套规则关掉缩进那条**，
 * 所以两种方言放同一个模块，而不是拆到 `erb-parser` 去各写一遍。
 *
 * ## 三条规则与它们的边界（取舍都写在这，改动前先读）
 *
 * 1. **全角空格 `U+3000` → 半角**：只动两处**空白身份明确**的位置——
 *    行首缩进（折成 **2 个**半角空格，因为 `indentLevel` 把 `U+3000` 记作 2 空格，
 *    折 1 个就是把层级改小 = 改语义）与**注释区**（折成 1 个半角空格，与既有
 *    「替换为半角并保存」那条处置逐字同口径）。
 *    **正文/台词/字符串里的 `U+3000` 一律不动**：eraTW 4.980 全量实测 55,565 行含
 *    `U+3000` 者**全部是行中用途**（注释分隔与 `PRINTFORMW 　「…」` 的台词缩进），
 *    那是作者要的排版、且会原样打印给玩家——一刀切替换就是把内容改了。
 * 2. **缩进归一**（仅 `.kojo`，且仅"糖行"）：将行首空白重排成
 *    `<单位> × indentLevel(原行首空白)` —— 层级由转译器算出、再按同一函数折回，
 *    **可证不变**（`indentLevel(新缩进) === indentLevel(旧缩进)`），所以它只统一
 *    写法、不动结构。单位在文件内探测（TAB 或 4 空格，取占多数的一方）；
 *    探测不出（无缩进行 / 平局 / 全是 2 空格这类"层级本就判不准"的写法）就**整条规则关掉**。
 *    原生直通行（`rawLine`）不参与归一：ERB 原文的缩进没有结构含义。
 *    `@` 原生块（`rawBlockStart` 起，延续到下一个 `@` 行或文件尾）**整块一个字符都不动** ——
 *    那里的每一行逐字节进产物，"改了也不进产物"这条放行前提在块内不成立。
 * 3. **行尾**：编辑**永不跨物理行**（每条 edit 落在同一行内），换行符原样保留，
 *    混合行尾也原样保留 —— 既不会把 LF 变成 CRLF，也不会把 CRLF 变成 LF。
 *
 * 一句话放行判据：**只动"空白身份明确"的位置**——行首缩进、纯空白行、注释区。
 * 台词正文与引号内的值是打印给玩家的字符 ⇒ 一个都不动；`@` 原生块逐行进产物 ⇒ 整块不动。
 * 唯一被允许的产物空白差 = 糖区**注释文本**里的全角空格折算（注释行会原样落进产物注释），
 * 产物里可打印的字符一个不许变 —— 由 `tests/formatter.invariants.test.ts` 的
 * "逐行折叠空白后相等 + 无全角样例逐字节相等"两条一起钉住。
 *
 * ## 规则可逐条关（P2-14「格式化规则零可配置」）
 *
 * `computeFormatEdits` / `formatText` 收一个 **additive** 选项参 `FormatRuleOptions`：
 * 两条规则各有一个布尔开关，**缺省全开 ⇒ 与加选项之前逐字等价**（既有调用方与既有
 * 测试零改动）。设置页的两个开关（`packages/app/src/ui/format-pref.ts`）经宿主
 * （`packages/app/src/monaco/kojo-format.ts`）传到这里；E2「保存时格式化」同样
 * 落盘前现读同一份开关（`applyFormatOnSave` 的 `rules` 参）——缺省全开 ⇒ 老用户
 * 零感知，显式关掉某条的作者在手动与保存两条路上拿到**同一个**口径。
 *
 * 关 `fullWidthSpace` 的语义是"**U+3000 原样保留**"（不是"少折一处"）：
 * 行首缩进与注释区的 U+3000 都不折；仅含 U+3000 的空白行也不再清空（半角空白行
 * 照旧清空——那不是全角问题）；含 U+3000 的缩进同时排除出「缩进归一」的重排
 * （否则归一会把 U+3000 按层级抹掉，"保留"就成了空话）。
 * 关 `indent` 的语义是"**行首空白写法不动**"：只影响 `.kojo` 糖行的单位×层级重排
 * （ERB 形本来就没有这条规则，关了行为不变）。
 *
 * ## 明确不做（与结构修复 `erb-structure-fix` 划界）
 *
 * 不补 `ENDIF`、不改块层级、不动行尾空白（台词行尾的 `U+3000` 是要打印的字）、
 * 不碰折行（`\` 续接）涉及的任何物理行、不改编码。判不准的一律不动：
 * 格式化产出 0 条 edit 是**正常结果**，不是失败。
 */

import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import {
  classifyLine,
  inlineCommentIndex,
  splitLogicalLines,
  type LineClass,
  type LogicalLine,
} from './lexer';

/** 方言：`kojo` = 表层 DSL（缩进是语法）；`erb` = 原生脚本（缩进只是排版） */
export type FormatDialect = 'erb' | 'kojo';

/**
 * 一条行内替换（1 基行号；列按 UTF-16 码元，`endColumn` 不含端点 —— 与 Monaco
 * `Range` 的列语义逐字一致，宿主据此直翻成 `DocumentFormattingEdit`）。
 */
export interface FormatEdit {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  /** 替换进来的文本（不含行尾） */
  readonly text: string;
}

/** 一个缩进层级 = 4 个半角空格（`indentLevel` 的折算基：`ceil(空格数 / 4)`；`enter.ts` 的回车追加单位与它同源） */
export const SPACE_UNIT = '    ';
/** 一个缩进层级 = 1 个 TAB（同上） */
export const TAB_UNIT = '\t';

/**
 * 规则开关（P2-14，additive）：两条规则各一个布尔，`undefined` / `true` = 开。
 *
 * 形状是**结构相容**的最小面：宿主侧（`packages/app/src/ui/format-pref.ts` 的
 * `FormatRules`）按同一字段名传参，不需要反向 import 本类型——插件公共面
 * （`src/index.ts` 的 exports 清单）本批冻结，不新增导出。
 */
export interface FormatRuleOptions {
  /**
   * 全角空格折算：行首缩进的 `U+3000` → 2 个半角空格、注释区的 `U+3000` → 1 个半角
   * 空格；连带「仅含 U+3000 的空白行清空」也归这条管。关 ⇒ U+3000 原样保留。
   */
  readonly fullWidthSpace?: boolean;
  /**
   * 缩进归一（仅 `.kojo` 糖行）：行首空白按探测单位 × 层级重排。关 ⇒ 行首空白
   * 写法一个字符都不动（ERB 形本就不做这条，关了与今天一致）。
   */
  readonly indent?: boolean;
}

/** 解析后的规则（两个布尔都落地，缺省 = 全开） */
interface ResolvedRules {
  readonly fullWidthSpace: boolean;
  readonly indent: boolean;
}

/** `!== false` ⇒ 开：显式传 `true` 与不传同义（additive 的口径） */
function resolveRules(options: FormatRuleOptions | undefined): ResolvedRules {
  return {
    fullWidthSpace: options?.fullWidthSpace !== false,
    indent: options?.indent !== false,
  };
}

/**
 * 不做行内注释剥离、也不进缩进探测的行类。
 * 判据逐字来自 `classifyLine`：`text` / `heartText` 是台词与心形行（`;` 是要打印的字符）、
 * `rawLine` 是 ERB 原文（inline `;` 的语义在那边另有一套，判不准就不动）、
 * `comment` 整行都是注释、`blank` 无内容、`rawBlockStart` 走原生块通路。
 */
const NO_INLINE_COMMENT = new Set<LineClass['kind']>([
  'blank',
  'comment',
  'rawLine',
  'rawBlockStart',
  'text',
  'heartText',
]);

/** 物理行：内容与**它自己的行尾**（`eol` 为空 = 文件最后一行） */
interface PhysicalLine {
  content: string;
  readonly eol: string;
}

function splitPhysical(text: string): PhysicalLine[] {
  const out: PhysicalLine[] = [];
  const re = /\r\n|\r|\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ content: text.slice(last, m.index), eol: m[0] });
    last = m.index + m[0].length;
  }
  out.push({ content: text.slice(last), eol: '' });
  return out;
}

function isIndentChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === FULLWIDTH_SPACE;
}

/** 行首空白串（口径同 lexer 的 `rawIndent`：空格 / TAB / 全角空格，只是这里不写第二份正则） */
function leadingIndent(content: string): string {
  let i = 0;
  while (i < content.length && isIndentChar(content[i]!)) i++;
  return content.slice(0, i);
}

/** 整行都是空白（含全角）——`U+3000` 独占行与 `' '` 独占行同判 */
function isAllIndent(content: string): boolean {
  for (const ch of content) if (!isIndentChar(ch)) return false;
  return true;
}

/** 注释 / 文本区：全角空格 → 一个半角空格（与 `EditorPane` 既有的「替换为半角并保存」同口径） */
function halfwidthInText(s: string): string {
  return s.includes(FULLWIDTH_SPACE) ? s.split(FULLWIDTH_SPACE).join(' ') : s;
}

/** 行首缩进：全角空格 → **两个**半角空格（`indentLevel` 记 U+3000 为 2 空格 ⇒ 层级不变、宽度不变） */
function halfwidthInIndent(s: string): string {
  return s.includes(FULLWIDTH_SPACE) ? s.split(FULLWIDTH_SPACE).join('  ') : s;
}

/**
 * ERB 一行的新内容（`null` = 不用改）。
 *
 * 注释判据刻意只认**整行注释**（去缩进后以 `;` 开头）：ERB 的行中 `;` 既可能是注释、
 * 也可能就在打印文本里（`PRINTFORMW` 的参数不是带引号的串），这一层分不开 ⇒ 不动。
 */
function erbNewContent(content: string, rules: ResolvedRules): string | null {
  if (content.length === 0) return null;
  if (isAllIndent(content)) {
    // 纯空白行 → 真空行（空白身份无歧义）；但行内有 U+3000 且折算规则关着时不动
    if (!rules.fullWidthSpace && content.includes(FULLWIDTH_SPACE)) return null;
    return '';
  }
  const indent = leadingIndent(content);
  const rest = content.slice(indent.length);
  // 折算关 ⇒ 缩进与注释区都原样（返回与原串相等 ⇒ 上层记 null）
  const newIndent = rules.fullWidthSpace ? halfwidthInIndent(indent) : indent;
  const newRest = rules.fullWidthSpace && rest.startsWith(';') ? halfwidthInText(rest) : rest;
  const next = newIndent + newRest;
  return next === content ? null : next;
}

/** 糖行的注释区起点（`rest` 内下标）；-1 = 这一行没有可动的注释区 */
function sugarCommentStart(cls: LineClass, rest: string): number {
  if (cls.kind === 'comment') return 0;
  if (NO_INLINE_COMMENT.has(cls.kind)) return -1;
  return inlineCommentIndex(rest);
}

/** 一条逻辑行的处理结果（只作用在它的**首个物理行**上） */
interface SugarEntry {
  readonly logical: LogicalLine;
  readonly cls: LineClass | null;
  /** 是否落在 `@` 原生块里（判据同 `readRawFunctionBlock`：一旦开始就延续到下一个 `@` 行或文件尾） */
  readonly raw: boolean;
}

/**
 * 缩进单位探测：只在**糖行**、**有缩进**、**未折行**、**分类成功**的行里数。
 *
 * 只认 TAB 与 4 空格两种单位——它们是仅有的两种"重排后层级必然不变"的单位
 * （2 空格单位会把 level 2 折回 level 1：`indentLevel('    ') === 1`）。
 * 谁多取谁；平局或一方都没有 ⇒ `null` = 判不准 ⇒ 缩进规则整体关掉。
 */
function detectIndentUnit(entries: readonly SugarEntry[]): string | null {
  let tabs = 0;
  let spaces = 0;
  for (const e of entries) {
    if (e.raw || e.cls === null) continue;
    if (e.cls.kind === 'blank' || e.cls.kind === 'rawLine') continue;
    if (e.logical.endLine !== e.logical.line) continue;
    if (e.logical.indent <= 0) continue;
    const raw = e.logical.rawIndent;
    if (raw.length === 0) continue;
    if (/^\t+$/.test(raw)) tabs++;
    else if (/^ +$/.test(raw) && raw.length % SPACE_UNIT.length === 0) spaces++;
  }
  if (tabs === spaces) return null;
  return tabs > spaces ? TAB_UNIT : SPACE_UNIT;
}

/** 按方言算出每条物理行的新内容（`null` = 不改） */
function newContents(text: string, dialect: FormatDialect, rules: ResolvedRules): (string | null)[] {
  const lines = splitPhysical(text);
  const out: (string | null)[] = lines.map(() => null);

  if (dialect === 'erb') {
    for (let i = 0; i < lines.length; i++) out[i] = erbNewContent(lines[i]!.content, rules);
    return out;
  }

  // ---- `.kojo`：先按词法器切逻辑行（折行合并、层级、行类全同一条口径）----
  let logicals: LogicalLine[] = [];
  try {
    logicals = splitLogicalLines(text);
  } catch {
    // 词法都切不动的文本没有"可信层级"可言：缩进与注释一律不动，只保留空白身份最明确的两类
    for (let i = 0; i < lines.length; i++) {
      const c = lines[i]!.content;
      if (c.length > 0 && isAllIndent(c)) out[i] = '';
    }
    return out;
  }

  const entries: SugarEntry[] = [];
  let inRawBlock = false;
  for (const logical of logicals) {
    let cls: LineClass | null = null;
    try {
      cls = classifyLine(logical);
    } catch {
      cls = null; // 分类抛错 = 判不准 ⇒ 这一行整条不动
    }
    if (cls?.kind === 'rawBlockStart') inRawBlock = true;
    entries.push({ logical, cls, raw: inRawBlock });
  }

  const unit = detectIndentUnit(entries);

  for (const e of entries) {
    const index = e.logical.line - 1;
    const line = lines[index];
    if (!line) continue;
    // 折行（`\` 续接）涉及的逻辑行整条不动：改首行会改续接、改续行会改内容
    if (e.logical.endLine !== e.logical.line) continue;

    // 原生块（`@` 起，判据同 `readRawFunctionBlock`）：**一个字符都不动**。
    // 那里的每一行都逐字节进产物（连行首空白与注释原文一起），"改了也不进产物"这条
    // 放行前提在块内不成立 ⇒ 整块跳过（要整理那段 ERB，请直接对它做 ERB 形格式化）。
    if (e.raw) continue;
    if (e.cls === null) continue;

    if (e.cls.kind === 'blank') {
      if (line.content.length === 0) {
        out[index] = null;
        continue;
      }
      // 与 ERB 形同口径：仅含 U+3000 的空白行在折算规则关着时原样保留
      if (!rules.fullWidthSpace && line.content.includes(FULLWIDTH_SPACE)) continue;
      out[index] = '';
      continue;
    }

    const rawIndent = e.logical.rawIndent;
    const rest = line.content.slice(rawIndent.length);
    // 归一：糖行 + 探到单位 + 规则开；折算关时含 U+3000 的缩进排除出重排
    // （否则 unit.repeat 会把 U+3000 按层级抹掉，"U+3000 保留"就成了空话）
    const canNormalize = rules.indent && unit !== null && e.cls.kind !== 'rawLine';
    const keepRawIndent = !rules.fullWidthSpace && rawIndent.includes(FULLWIDTH_SPACE);
    const newIndent =
      canNormalize && !keepRawIndent
        ? unit.repeat(e.logical.indent)
        : rules.fullWidthSpace
          ? halfwidthInIndent(rawIndent)
          : rawIndent;
    // 注释区折算归 fullWidthSpace 管：关 ⇒ 一个字符都不碰
    const commentStart = rules.fullWidthSpace ? sugarCommentStart(e.cls, rest) : -1;
    const newRest =
      commentStart >= 0 ? rest.slice(0, commentStart) + halfwidthInText(rest.slice(commentStart)) : rest;
    const next = newIndent + newRest;
    out[index] = next === line.content ? null : next;
  }
  return out;
}

/**
 * 文本进、edits 出（无变化 ⇒ 空数组）。
 *
 * `options` 为 P2-14 的规则开关（缺省全开 ⇒ 与加选项之前逐字等价）；保存链路
 * （E2）刻意不传，落盘口径永远是全开。
 */
export function computeFormatEdits(
  text: string,
  dialect: FormatDialect,
  options: FormatRuleOptions = {},
): FormatEdit[] {
  const lines = splitPhysical(text);
  const next = newContents(text, dialect, resolveRules(options));
  const edits: FormatEdit[] = [];
  for (let i = 0; i < next.length; i++) {
    const content = next[i];
    const original = lines[i];
    if (typeof content !== 'string' || !original || content === original.content) continue;
    edits.push({ line: i + 1, startColumn: 1, endColumn: original.content.length + 1, text: content });
  }
  return edits;
}

/**
 * 把 edits 落回文本，**行尾原样保留**（每条 edit 都被夹在同一行内，绝不跨行）。
 * 越界坐标按夹取处理：陈旧行号/列号不该让保存链路抛错。
 */
export function applyFormatEdits(text: string, edits: readonly FormatEdit[]): string {
  if (edits.length === 0) return text;
  const lines = splitPhysical(text);
  for (const e of edits) {
    const line = lines[e.line - 1];
    if (!line) continue;
    const from = Math.min(Math.max(0, e.startColumn - 1), line.content.length);
    const to = Math.min(Math.max(from, e.endColumn - 1), line.content.length);
    line.content = line.content.slice(0, from) + e.text + line.content.slice(to);
  }
  return lines.map((l) => l.content + l.eol).join('');
}

/** 一步到位（E2 用）：格式化后的文本 + 本次实际改动数（`options` 同 `computeFormatEdits`） */
export function formatText(
  text: string,
  dialect: FormatDialect,
  options: FormatRuleOptions = {},
): { text: string; edits: FormatEdit[] } {
  const edits = computeFormatEdits(text, dialect, options);
  return { text: applyFormatEdits(text, edits), edits };
}
