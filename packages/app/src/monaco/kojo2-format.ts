/**
 * Kojo 2.0 **文档格式化**（设计稿 §16.7 U6.6 / K2-FORMAT-2）—— 纯逻辑 + 一枚宿主接线。
 *
 * ## 规则（写死，按本文件实现为准；options 只提供"整条关"的加法开关）
 *
 * | # | 规则 | 口径 |
 * |---|---|---|
 * | ① | 缩进归一 | 每行的**嵌套深度**由"开体栈"算出（`#` 块声明 / `@` 块头 / `?` / `选项` / `!` 带插入体 / 行尾全角冒号才是开体行；空行 / 注释 / `@原生` 体内不压栈），输出 = `depth × KOJO2_INDENT_WIDTH` 个空格。`# 表` 两列 / `@随机` 候选 / `# 池` 分支是**开体栈上的并列项**（同层项永远同层），多缩了两格也归一到同一层。`@原生` 围栏**头**的缩进也原样保留：改它可能把体内某行的"更深"判据改掉，从而重解释围栏（字节没变、语义变了），判不准就不动。 |
 * | ② | 空行呼吸 | 连续空行折叠为一个；文件首尾的空行去掉（结尾是否换行保持不变）。单行声明（`# 幕` `# 视` `# 机` `# 变量` `# 常量`）之间**不空行**；单行声明组与别的东西之间、块（`# 表` `# 池` `# 模` `@算` `@着色` `@随机` `@循` `@巡` `@复` `@函` `@织` `@原生` `选项：`）前后**各一空行**。紧跟注释行的块不在注释与块之间插空行（注释属于下一块）。 |
 * | ③ | 行尾空白 | 非 `@原生` 行尾的半角空格 / Tab / 全角空格 / NBSP 一律清除；纯空白行归一为真空行。 |
 * | ④ | `//` 整行注释 | **行首空白逐字保留**（规范 §4.13 允许注释写在任意缩进；重排会把注释挪离它注释的那一行），只按规则③清行尾。 |
 * | ⑤ | 正文不动 | 只动行首缩进 / 空行 / 行尾空白：行内文本（引号内、`>` 之后、表行值、表达式）一个字符都不改。`@原生` 体内**逐字节不变**（连 Tab / 行尾空白 / 纯空白行都原样）。 |
 * | ⑥ | EOL 保留 | 每行保留自己的行尾（CRLF 进 ⇒ CRLF 出；混合行尾也逐行保留）。新增的空行取相邻行的行尾。 |
 *
 * ## 安全闸（两条，缺一条就咬人）
 *
 * - **可解析**：格式化后的 `parseSource(code)` 的 **error 数不得大于输入**。变大 ⇒ 整个结果退回原文
 *   （`changed=false`）——格式化不许把输入改得更坏。判据只比 error 数（warning 不参与）。
 * - **幂等**：`format(format(x)).code === format(x).code`，且第二次 `changed=false`；`code === source`
 *   就是 `changed=false` 的唯一含义（不返回"等价但不同字节"的结果）。
 *
 * ## 分层
 *
 * 本文件零 Monaco 运行时：`formatKojo2Source` 只依赖 core 词法（`lex`，行类 / 缩进 / 围栏状态的
 * 唯一真源）、core 文法（`parseSource`，只做上面的可解析闸）与 `kojo2-lexicon` 的词表。
 * {@link installKojo2DocumentFormatter} 是 `Shift+Alt+F` 的 provider 接线（flag 关 = 零注册）；
 * {@link formatKojo2Range} / {@link installKojo2RangeFormatter} 是**区间格式化**（K2-INDENT-BRACKETS
 * 加的 additive 腿）：同一台 `runKojo2Format` 整篇算、按行映射只落选中行，provider 同样 flag 关零注册。
 * {@link applyKojo2Format} 是给命令 / 保存链路用的**落地端口**，它**动态** import 宿主既有的
 * `applyTextEdits`（前后各一颗 undo 停点，CODEACTION-UNDO-STACK 口径）——本文件**不出现**
 * `executeEdits` / `pushUndoStop`，也不另造第二套编辑应用机制。
 *
 * ## edits 的两档形状
 *
 * - 行数没变（只改缩进 / 行尾空白）⇒ **逐行最小 edit**（range 落在单行内，光标锚定最好）；
 * - 行数变了（空行增删）⇒ **整篇一条 edit**：删行/插行的行级映射要靠第二套 diff 才做得稳，
 *   而一次格式化本来就是一个撤销步，这里不为省几十个字符再写一份 diff。
 * - `newText` 一律用 `\n` 作行分隔（EOL 由 model 自己按 §10.4 保留；`code` 字段才是保 EOL 的成品）。
 */

import type * as Monaco from './entry';
import type { applyTextEdits } from '../ui/editor-global-providers';
import {
  KOJO2_DECL_WORDS,
  KOJO2_DISPATCH_WORDS,
  KOJO2_INDENT_WIDTH,
} from './kojo2-lexicon';
import { KOJO2_LANGUAGE_ID } from './kojo2-constants';
import { KOJO2_BLOCK_HEADER_COLON_RE } from './kojo2-enter';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import { lex, parseSource, type KojoLexLine } from '@kojo/kojo-core';

/* ============================== 词表位序（不写字形） ============================== */

const [, , , , , TABLE_WORD = '', POOL_WORD = '', TEMPLATE_WORD = ''] = KOJO2_DECL_WORDS;

const [
  CALC_WORD = '',
  COLOR_WORD = '',
  ,
  RANDOM_WORD = '',
  GROUP_WORD = '',
  WHILE_WORD = '',
  REPEAT_WORD = '',
  FOREACH_WORD = '',
  FUNCTION_WORD = '',
  WEAVE_WORD = '',
  ,
  ,
  ,
  ,
  ,
  NATIVE_WORD = '',
] = KOJO2_DISPATCH_WORDS;

/** 单行声明：连续写、之间不空行、整组与正文之间空一行（§3.2）。 */
const SINGLE_DECL_WORDS: ReadonlySet<string> = new Set(KOJO2_DECL_WORDS.slice(0, 5));

/** 块声明：前后各空一行（§3.2）。 */
const BLOCK_DECL_WORDS: ReadonlySet<string> = new Set([TABLE_WORD, POOL_WORD, TEMPLATE_WORD]);

/** `@` 开体的块头：前后各空一行（`@组` 只在 `@随机` 体内出现，级别不会是 0，列全是为了同源）。 */
const BLOCK_DISPATCH_WORDS: ReadonlySet<string> = new Set([
  CALC_WORD,
  COLOR_WORD,
  RANDOM_WORD,
  GROUP_WORD,
  WHILE_WORD,
  REPEAT_WORD,
  FOREACH_WORD,
  FUNCTION_WORD,
  WEAVE_WORD,
  NATIVE_WORD,
]);

/* ============================== 公开形状 ============================== */

/** 一条 edit 的 range（Monaco 同形；1 基行列，`endColumn` 不含端点）。 */
export interface Kojo2FormatRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

/** 一条格式化 edit（`newText` 用 `\n` 作行分隔，见模块头「edits 的两档形状」）。 */
export interface Kojo2FormatEdit {
  readonly range: Kojo2FormatRange;
  readonly newText: string;
}

/**
 * 规则开关（additive；缺省三条全开 ⇒ 与不传逐字等价）。
 *
 * 关 `indent` = 行首缩进写法一个字符都不动；关 `blankLines` = 不折叠 / 不插入 / 不删首尾空行；
 * 关 `trailingWhitespace` = 行尾空白与纯空白行原样保留（此时 `blankLines` 仍可折叠空行，
 * 但折叠出的空行只留原有行尾空白，不会凭空改写正文）。
 */
export interface Kojo2FormatOptions {
  readonly indent?: boolean;
  readonly blankLines?: boolean;
  readonly trailingWhitespace?: boolean;
}

/** 格式化结果：`changed=false` 时 `code` 与输入**逐字节相等**（`edits` 缺席）。 */
export interface Kojo2FormatResult {
  readonly code: string;
  readonly changed: boolean;
  readonly edits?: readonly Kojo2FormatEdit[];
}

/* ============================== 基础工具 ============================== */

/** 行尾空白集：与 core `lexer.isSpaceCode` 同一张表（半角空格 / Tab / 全角空格 / NBSP）。 */
const TRAILING_WS_RE = /[ \t\u3000\u00a0]+$/;

/** 物理行（内容 + 它自己的行尾；`eol === ''` = 文件最后一行没有换行）。 */
interface RawLine {
  readonly content: string;
  readonly eol: string;
}

/** 按 core 同一条行尾正则切物理行（不归一化 EOL；末行无换行时 `eol === ''`）。 */
function splitPhysical(text: string): RawLine[] {
  const out: RawLine[] = [];
  const re = /\r\n|\r|\n/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push({ content: text.slice(last, match.index), eol: match[0] });
    last = match.index + match[0].length;
  }
  out.push({ content: text.slice(last), eol: '' });
  return out;
}

function stripTrailing(text: string): string {
  return text.replace(TRAILING_WS_RE, '');
}

/* ============================== 结构判据 ============================== */

type LineRole = 'blank' | 'comment' | 'native' | 'declSingle' | 'blockHeader' | 'flat';

/** 开体行：只有它会压栈；层级 = 祖先条数（与 `computeDepths` 同源）。 */
type OpenerKind = 'block' | 'table' | 'random' | 'condition' | 'options' | 'trigger' | 'colon';

/** 结构栈的一帧（`openIndent` = 这一行的原缩进列宽；体 = `depth + 1`）。 */
interface Frame {
  readonly openIndent: number;
  readonly kind: OpenerKind;
}

/**
 * 这一行是不是开体行（`null` = 不开体）。
 *
 * 判据只消费 core 词法（`kind` / `word` / `indent`）与两条结构正则：
 * - `#` 块声明（表 / 池 / 模）、`@` 块头（算 / 着色 / 随机 / 组 / 循 / 复 / 巡 / 函 / 织 / 原生）；
 * - `?` 条件行、`选项` 行；
 * - `!` 调用行**只有紧跟更深一行时**才开体（插槽体不是每条调用都有，§7.2）；
 * - 迁移期块头 / `选项` 按钮标签：行尾全角冒号（与 `kojo2-enter` 同一条正则）。**`# 表` 行 /
 *   `@随机` 直接候选里不认**——那两处的行是并列的值/候选，不是块头（表行尾的 `：` 是值的一部分）。
 */
function openerKindOf(
  line: KojoLexLine,
  index: number,
  lines: readonly KojoLexLine[],
  parent: Frame | null,
): OpenerKind | null {
  if (line.kind === 'decl' && line.known) {
    if (line.word === TABLE_WORD) return 'table';
    if (line.word === POOL_WORD || line.word === TEMPLATE_WORD) return 'block';
    return null;
  }
  if (line.kind === 'dispatch' && line.known) {
    if (line.word === RANDOM_WORD) return 'random';
    if (BLOCK_DISPATCH_WORDS.has(line.word)) return 'block';
    return null;
  }
  if (line.kind === 'condition') return 'condition';
  if (line.kind === 'options') return 'options';
  if (line.kind === 'trigger') {
    const next = nextStructuralLine(lines, index + 1);
    return next !== null && next.indent > line.indent ? 'trigger' : null;
  }
  const colonHeader =
    line.kind === 'text' || line.kind === 'legacy' || line.kind === 'unknown' ||
    // `选项` 的按钮标签是裸引号行（`「标签」：`）：只在这一格认它是开体行
    (line.kind === 'bareQuote' && parent?.kind === 'options');
  if (
    colonHeader &&
    KOJO2_BLOCK_HEADER_COLON_RE.test(line.text) &&
    parent?.kind !== 'table' &&
    parent?.kind !== 'random'
  ) {
    return 'colon';
  }
  return null;
}

/** 下一行既不是空行 / 注释 / 围栏体（`!` 调用体判据只问"紧跟的更深的实义行"）。 */
function nextStructuralLine(lines: readonly KojoLexLine[], from: number): KojoLexLine | null {
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.kind === 'blank' || line.kind === 'comment' || line.kind === 'native') continue;
    return line;
  }
  return null;
}

/**
 * 嵌套深度（0 基）= 当前压栈的**开体祖先**条数。
 *
 * 为什么不直接把缩进宽度除以 4：`# 表` 的两列行、`@随机` 的候选、`# 池` 的 `?` 兄弟都是
 * **并列**的（行与行同层），它们的缩进只要比块头深就成立；按宽度算会把一个多缩了两格的
 * 表行当成"下一层"。按开体栈算则同层项永远同层，格式化只统一宽度、不改并列关系（§6.1 / §8.4）。
 * 空行 / 注释 / `@原生` 体内不压栈（空行不参与缩进计算，注释不打断块，围栏体内不是层级）。
 */
function computeDepths(lines: readonly KojoLexLine[]): (number | null)[] {
  const out = new Array<number | null>(lines.length).fill(null);
  const frames: Frame[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.kind === 'blank' || line.kind === 'comment' || line.kind === 'native') continue;
    while (frames.length > 0 && line.indent <= frames[frames.length - 1]!.openIndent) frames.pop();
    const depth = frames.length;
    out[i] = depth;
    const parent = frames.length > 0 ? frames[frames.length - 1]! : null;
    const opener = openerKindOf(line, i, lines, parent);
    if (opener !== null) frames.push({ openIndent: line.indent, kind: opener });
  }
  return out;
}

function isNativeFenceHeader(line: KojoLexLine): boolean {
  return line.kind === 'dispatch' && line.known && line.word === NATIVE_WORD;
}

function roleOf(line: KojoLexLine, depth: number | null): LineRole {
  if (line.kind === 'blank') return 'blank';
  if (line.kind === 'comment') return 'comment';
  if (line.kind === 'native') return 'native';
  if (depth === 0) {
    if (line.kind === 'decl' && line.known && SINGLE_DECL_WORDS.has(line.word)) return 'declSingle';
    if (line.kind === 'decl' && line.known && BLOCK_DECL_WORDS.has(line.word)) return 'blockHeader';
    if (line.kind === 'dispatch' && line.known && BLOCK_DISPATCH_WORDS.has(line.word)) {
      return 'blockHeader';
    }
    if (line.kind === 'options') return 'blockHeader';
  }
  return 'flat';
}

function isBlockHeader(role: LineRole): boolean {
  return role === 'blockHeader';
}

/** 格式化后的一行（`origin` = core 词法行下标；插入的空行 = -1）。 */
interface KeptLine {
  readonly text: string;
  readonly eol: string;
  readonly role: LineRole;
  readonly depth: number | null;
  readonly origin: number;
  /** 原缩进列宽（空行 / 注释也有）；块尾判据用它区分"缩进在块内的注释"。 */
  readonly origIndent: number;
}

/* ============================== 空行 ============================== */

/**
 * 一个空行游程最终要几个空行（`prev` / `next` 是游程两侧的**非空行**，`null` = 文件首尾）。
 *
 * 顺序即优先级：单行声明组内部 = 0 → 块边界 / 声明组边界 = 1 → 其余折叠到 1。
 * 注释与块头/声明组之间不插（注释属于下一段；`// 注释` 紧跟被注释的块是正典写法）。
 */
function desiredBlankCount(
  prev: KeptLine | null,
  next: KeptLine | null,
  had: number,
  prevEndsBlock: boolean,
): number {
  if (prev === null || next === null) return 0;
  // 相邻的 `@原生` 纯空白行已经提供了这一格的"空行"（围栏体一个字节都不许动）⇒ 不再叠一条
  if (prev.text.trim().length === 0 || next.text.trim().length === 0) return 0;
  // 注释属于它下面那一行：紧跟注释的缝只折叠、不插入（`// 说明` 与 `# 机` / `@算` 贴在一起是正典）
  if (prev.role === 'comment' || next.role === 'comment') return had > 0 ? 1 : 0;
  if (prev.role === 'declSingle' && next.role === 'declSingle') return 0;
  if (isBlockHeader(next.role)) return 1;
  if (prev.role === 'declSingle') return 1;
  if (next.role === 'declSingle') return 1;
  if (prevEndsBlock) return 1;
  return had > 0 ? 1 : 0;
}

/** 块尾行（kept 下标）：块头之后、下一个深度 0 的非注释行之前，最后一个属于块体的行。 */
function blockEndIndices(kept: readonly KeptLine[]): ReadonlySet<number> {
  const ends = new Set<number>();
  for (let head = 0; head < kept.length; head += 1) {
    const header = kept[head]!;
    if (!isBlockHeader(header.role)) continue;
    let end = head;
    for (let j = head + 1; j < kept.length; j += 1) {
      const line = kept[j]!;
      if (line.role === 'blank') continue;
      if (line.role === 'native') {
        end = j;
        continue;
      }
      if (line.role === 'comment') {
        // 缩进在块内的注释算块体；顶格注释起的是下一段（不把块尾推到注释后面）
        if (line.origIndent > header.origIndent) {
          end = j;
          continue;
        }
        break;
      }
      if (line.depth !== null && line.depth <= 0) break;
      end = j;
    }
    ends.add(end);
  }
  return ends;
}

/* ============================== 可解析闸 ============================== */

/** 解析错误数；`null` = `parseSource` 自己抛了（判不准 ⇒ 不格式化）。 */
function parseErrorCount(source: string): number | null {
  try {
    const file = parseSource(source);
    let errors = 0;
    for (const diagnostic of file.diagnostics) {
      if (diagnostic.severity === 'error') errors += 1;
    }
    return errors;
  } catch {
    return null;
  }
}

/* ============================== 主函数 ============================== */

/** 一次格式化的**中间产物**（`formatKojo2Source` 与 `formatKojo2Range` 共用同一台规则） */
interface Kojo2FormatLayout {
  readonly code: string;
  readonly bom: string;
  readonly rawLines: readonly RawLine[];
  readonly lexLineCount: number;
  /** 逐行成品（`origin` = 原始物理行下标；插入的空行 = -1） */
  readonly rebuilt: readonly KeptLine[];
  readonly endsWithEol: boolean;
}

/**
 * 规则主体（内部）：文本进、逐行成品出；`null` = 不改（空文件 / 词法抛错 / 行数对不上 /
 * 无可解析闸不过 / 结果与输入逐字节相同）。
 *
 * K2-INDENT-BRACKETS 把这一层从 `formatKojo2Source` 里抽出来，是因为**区间格式化**要同一份
 * `rebuilt`（含 `origin` 行映射）才能只改选中行；再跑一遍规则会分叉出第二套空行/缩进判断。
 */
function runKojo2Format(source: string, options: Kojo2FormatOptions): Kojo2FormatLayout | null {
  if (typeof source !== 'string' || source.length === 0) return null;

  const wantIndent = options.indent !== false;
  const wantBlankLines = options.blankLines !== false;
  const wantTrailing = options.trailingWhitespace !== false;

  const bom = source.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const body = source.slice(bom.length);
  if (body.length === 0) return null;
  const endsWithEol = /(?:\r\n|\r|\n)$/.test(body);
  const rawLines = splitPhysical(body);

  let lexLines: readonly KojoLexLine[];
  try {
    lexLines = lex(source).lines;
  } catch {
    return null;
  }
  // core 词法行 = 物理行（末行无换行时与 splitPhysical 等长；有换行时少一格"EOL 后的空行"）。
  if (lexLines.length === 0 || lexLines.length > rawLines.length) return null;
  if (lexLines.every((line) => line.kind === 'blank')) return null;

  const depths = computeDepths(lexLines);

  /* ---- 逐行成文（缩进 / 行尾 / 注释 / 围栏体内） ---- */
  const kept: KeptLine[] = [];
  for (let i = 0; i < lexLines.length; i += 1) {
    const line = lexLines[i]!;
    const raw = rawLines[i]!;
    const depth = depths[i] ?? null;
    const role = roleOf(line, depth);
    let text: string;
    if (line.kind === 'native') {
      // 逐字节逃生舱：连行尾空白与纯空白行都原样
      text = line.raw;
    } else if (line.kind === 'blank') {
      text = wantTrailing ? '' : raw.content;
    } else {
      const indentChars = line.contentOffset - line.lineOffset;
      const leading = raw.content.slice(0, indentChars);
      const rest = raw.content.slice(indentChars);
      const restText = wantTrailing ? stripTrailing(rest) : rest;
      if (line.kind === 'comment') {
        // ④ 注释行首空白逐字保留（可写在任意缩进）
        text = leading + restText;
      } else if (isNativeFenceHeader(line)) {
        // 围栏头缩进不动：改它可能把体内某行"更深"的判据改掉（字节没变、围栏边界变了）
        text = leading + restText;
      } else if (wantIndent && depth !== null) {
        text = ' '.repeat(depth * KOJO2_INDENT_WIDTH) + restText;
      } else {
        text = leading + restText;
      }
    }
    kept.push({ text, eol: raw.eol, role, depth, origin: i, origIndent: line.indent });
  }

  /* ---- 空行呼吸 ---- */
  const ends = blockEndIndices(kept);
  const rebuilt: KeptLine[] = [];
  if (!wantBlankLines) {
    rebuilt.push(...kept);
  } else {
    // 逐个"非空行 → 空行游程 → 非空行"的缝处理：既有游程可折叠/删除，游程为零的缝也能**插入**
    // 一个空行（块与块之间 / 声明组与正文之间的呼吸靠这一条，不只是折叠）。
    const contentIndices: number[] = [];
    for (let i = 0; i < kept.length; i += 1) {
      if (kept[i]!.role !== 'blank') contentIndices.push(i);
    }
    for (let c = 0; c < contentIndices.length; c += 1) {
      const index = contentIndices[c]!;
      const line = kept[index]!;
      rebuilt.push(line);
      const nextIndex = contentIndices[c + 1] ?? kept.length;
      const run = kept.slice(index + 1, nextIndex);
      const next = c + 1 < contentIndices.length ? kept[contentIndices[c + 1]!]! : null;
      const desired = desiredBlankCount(line, next, run.length, ends.has(index));
      for (let k = 0; k < desired; k += 1) {
        // 数量没变时**复用原空行**（保 origin / 行尾，让"只改缩进"仍走逐行最小 edit）；
        // 多出来的才是新插入行（沿用相邻行的行尾）。
        const original = run[k];
        if (original !== undefined) {
          rebuilt.push({ ...original, text: wantTrailing ? '' : original.text });
          continue;
        }
        const eol = line.eol !== '' ? line.eol : (next?.eol ?? '\n');
        rebuilt.push({ text: '', eol, role: 'blank', depth: null, origin: -1, origIndent: 0 });
      }
    }
  }

  // 结尾无换行的文件，删掉尾部空行后也要保持"结尾无换行"这个源事实
  if (!endsWithEol && rebuilt.length > 0) {
    const last = rebuilt[rebuilt.length - 1]!;
    if (last.eol !== '') rebuilt[rebuilt.length - 1] = { ...last, eol: '' };
  }

  const code = bom + rebuilt.map((line) => line.text + line.eol).join('');
  if (code === source) return null;

  /* ---- 可解析闸 ---- */
  const before = parseErrorCount(source);
  const after = parseErrorCount(code);
  if (before === null || after === null || after > before) return null;

  return { code, bom, rawLines, lexLineCount: lexLines.length, rebuilt, endsWithEol };
}

/**
 * 格式化 2.0 源码（纯函数：文本进、成品 + edits 出）。
 *
 * 失败方向永远是"少改"：词法/文法抛错、行数对不上、格式化后 error 数变大 ⇒ 原样返回
 * （`changed=false`，`edits` 缺席）。空文件 / 全空白文件同样原样返回——那种文件没有结构可归一，
 * 动它只会改写源事实。
 */
export function formatKojo2Source(source: string, options: Kojo2FormatOptions = {}): Kojo2FormatResult {
  const run = runKojo2Format(source, options);
  if (run === null) return { code: source, changed: false };
  return {
    code: run.code,
    changed: true,
    edits: buildEdits(run.bom, run.rawLines, run.lexLineCount, run.rebuilt, run.endsWithEol),
  };
}

/**
 * 结果 edits：行数没变 ⇒ 逐行最小 edit；行数变了 ⇒ 整篇一条。
 *
 * `newText` 一律 `\n` 分隔；首行若带 BOM，替换首行时把 BOM 一并带上（range 从第 1 列起，
 * 覆盖的正是含 BOM 的那一行原文）。
 */
function buildEdits(
  bom: string,
  rawLines: readonly RawLine[],
  lexLineCount: number,
  rebuilt: readonly KeptLine[],
  endsWithEol: boolean,
): Kojo2FormatEdit[] {
  const sameShape =
    rebuilt.length === lexLineCount && rebuilt.every((line, index) => line.origin === index);
  if (sameShape) {
    const edits: Kojo2FormatEdit[] = [];
    for (let i = 0; i < rebuilt.length; i += 1) {
      const line = rebuilt[i]!;
      const original = rawLines[i]!;
      if (line.text === original.content) continue;
      edits.push({
        range: {
          startLineNumber: i + 1,
          startColumn: 1,
          endLineNumber: i + 1,
          endColumn: original.content.length + 1,
        },
        newText: i === 0 ? bom + line.text : line.text,
      });
    }
    return edits;
  }
  const lineCount = rawLines.length;
  const last = rawLines[lineCount - 1]!;
  return [
    {
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: lineCount, endColumn: last.content.length + 1 },
      newText: bom + rebuilt.map((line) => line.text).join('\n') + (endsWithEol ? '\n' : ''),
    },
  ];
}

/* ============================== 区间格式化（K2-INDENT-BRACKETS） ============================== */

/**
 * **区间格式化**（`Ctrl+Shift+I` / 「格式化选择区域」的 2.0 版）：规则与判据全部复用
 * {@link formatKojo2Source}（同一台 `runKojo2Format`），只把落点裁到 `[startLine, endLine]`。
 *
 * ## 为什么不把选区切出来单独格式化
 *
 * 2.0 的缩进深度是**文档级**判据（开体栈从文件头压下来）、`@原生` 围栏状态也是跨行的；
 * 切片视角会把块体内的行当成顶层、把围栏里的行当普通行。所以这里整篇算一遍，再按
 * `rebuilt` 的 `origin` 行映射取"选中行那一段"——与 `Shift+Alt+F` 逐字同口径。
 *
 * ## 与整篇结果的关系（可断言的不变式）
 *
 * `formatKojo2Range(src, a, b).code` 在 `[a, b]` 行上的字节 == `formatKojo2Source(src).code`
 * 对应行（按 `rebuilt` 映射对齐；整篇没有增删行时就是同号行）。选区之外逐字节不动：
 * 那是"只格式化选中行"的定义，也是这条腿唯一敢承诺的东西。
 *
 * ## 边界（一律少改）
 *
 * - 行号非整数 / 倒置 / 越界 ⇒ 原样返回；
 * - 选中的行全被空行规则折掉（没有可落点的 kept 行）⇒ 原样返回，不删行；
 * - 拼出来的混合文档 `parseSource` error 数比输入多 ⇒ 原样返回（与整篇同一条可解析闸）。
 *
 * 选区边界上的空行增删属于**选区之外**的呼吸（例如块头前那一空行），本腿不落笔；
 * 选区内部新增的空行照整篇结果带上（它们夹在 kept 行之间）。
 */
export function formatKojo2Range(
  source: string,
  startLine: number,
  endLine: number,
  options: Kojo2FormatOptions = {},
): Kojo2FormatResult {
  if (typeof source !== 'string' || source.length === 0) return { code: source, changed: false };
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return { code: source, changed: false };
  if (startLine < 1 || endLine < startLine) return { code: source, changed: false };
  const run = runKojo2Format(source, options);
  if (run === null) return { code: source, changed: false };
  const total = run.rawLines.length;
  const lo = Math.min(startLine, total);
  const hi = Math.min(endLine, total);
  if (lo < 1 || hi < lo) return { code: source, changed: false };

  // 选中行 → rebuilt 下标（只认原始行；插在选区内部的空行随首/末 kept 行一起进段）
  let firstUnit = -1;
  let lastUnit = -1;
  for (let index = 0; index < run.rebuilt.length; index += 1) {
    const origin = run.rebuilt[index]!.origin;
    if (origin < lo - 1 || origin > hi - 1) continue;
    if (firstUnit < 0) firstUnit = index;
    lastUnit = index;
  }
  if (firstUnit < 0 || lastUnit < firstUnit) return { code: source, changed: false };

  const segment = run.rebuilt.slice(firstUnit, lastUnit + 1);
  const head = run.rawLines.slice(0, lo - 1);
  const tail = run.rawLines.slice(hi);
  const code =
    run.bom +
    [
      ...head.map((line) => line.content + line.eol),
      ...segment.map((line) => line.text + line.eol),
      ...tail.map((line) => line.content + line.eol),
    ].join('');
  if (code === source) return { code: source, changed: false };

  // 与整篇同一条可解析闸：混合文档不许比输入更坏
  const before = parseErrorCount(source);
  const after = parseErrorCount(code);
  if (before === null || after === null || after > before) return { code: source, changed: false };

  const lastOriginal = run.rawLines[hi - 1]!;
  return {
    code,
    changed: true,
    edits: [
      {
        range: {
          startLineNumber: lo,
          startColumn: 1,
          endLineNumber: hi,
          endColumn: lastOriginal.content.length + 1,
        },
        // 首行带 BOM 时把 BOM 一并带上（与整篇的 buildEdits 同一口径）
        newText: (lo === 1 ? run.bom : '') + segment.map((line) => line.text).join('\n'),
      },
    ],
  };
}

/** 任务书里的名字：`formatRange` 是 {@link formatKojo2Range} 的别名（调用方不必猜前缀） */
export const formatRange = formatKojo2Range;

/* ============================== 宿主接线 1：Shift+Alt+F ============================== */

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/** 只看模型形状（provider 测试用假 model 也测得动） */
interface FormatModelShape {
  getValue(): string;
  getLanguageId?(): string;
}

/**
 * `Shift+Alt+F` 的 2.0 provider（**只注册 `kojo2` 语言 id**；flag 关 = 零注册）。
 *
 * Monaco 把返回的 edits 一次 `executeEdits('formatEditsCommand', …)` 落地 ⇒ 天然一个撤销步；
 * 这里只做"该不该应答 + 形状翻译"，不碰 undo 停点（那是 {@link applyKojo2Format} 的事）。
 * 体内任何异常都收成"这次不格式化"，绝不把 throw 送进命令面板。
 */
export function installKojo2DocumentFormatter(monaco: typeof Monaco): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;
  const provider: Monaco.languages.DocumentFormattingEditProvider = {
    displayName: 'kojo-editor',
    provideDocumentFormattingEdits(model: FormatModelShape): Monaco.languages.TextEdit[] {
      try {
        if (typeof model.getLanguageId === 'function' && model.getLanguageId() !== KOJO2_LANGUAGE_ID) {
          return [];
        }
        const source = model.getValue();
        if (typeof source !== 'string') return [];
        const result = formatKojo2Source(source);
        if (result.edits === undefined) return [];
        return result.edits.map((edit) => ({ range: { ...edit.range }, text: edit.newText }));
      } catch {
        return [];
      }
    },
  };
  const registration = monaco.languages.registerDocumentFormattingEditProvider(
    KOJO2_LANGUAGE_ID,
    provider,
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      registration.dispose();
    },
  };
}

/* ============================== 宿主接线 1b：区间格式化（Ctrl+Shift+I） ============================== */

/**
 * 选中行格式化的 2.0 provider（**只注册 `kojo2` 语言 id**；flag 关 = 零注册）。
 *
 * 与整篇 provider 同一条纪律：只做"该不该应答 + 形状翻译"，异常收成"这次不格式化"。
 * 规则本体是 {@link formatKojo2Range}（整篇算 + 行映射裁剪），本函数一个缩进判据都不写。
 *
 * **接线（已接）**：`ui/editor-global-providers.ts` 的 2.0 段与
 * `installKojo2DocumentFormatter` 并排调用 `installKojo2RangeFormatter(monaco)`（批次八）。
 * 没有这行 = 选区格式化仍走 v1 的 `.kojo` provider（`kojo-format.ts`），2.0 面不接；
 * `packages/app/tests/language-parity.test.ts` 与 `kojo2-format.test.ts` 各钉一条。
 */
export function installKojo2RangeFormatter(monaco: typeof Monaco): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;
  const provider: Monaco.languages.DocumentRangeFormattingEditProvider = {
    displayName: 'kojo-editor',
    provideDocumentRangeFormattingEdits(model: FormatModelShape, range): Monaco.languages.TextEdit[] {
      try {
        if (typeof model.getLanguageId === 'function' && model.getLanguageId() !== KOJO2_LANGUAGE_ID) {
          return [];
        }
        const source = model.getValue();
        if (typeof source !== 'string') return [];
        const result = formatKojo2Range(source, range.startLineNumber, range.endLineNumber);
        if (result.edits === undefined) return [];
        return result.edits.map((edit) => ({ range: { ...edit.range }, text: edit.newText }));
      } catch {
        return [];
      }
    },
  };
  const registration = monaco.languages.registerDocumentRangeFormattingEditProvider(
    KOJO2_LANGUAGE_ID,
    provider,
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      registration.dispose();
    },
  };
}

/* ============================== 宿主接线 2：applyKojo2Format ============================== */

/** `applyKojo2Format` 只认这一格：有 model 就能取文，落地交给宿主既有的 `applyTextEdits`。 */
export interface Kojo2FormatHost {
  getModel(): { getValue(): string } | null;
}

/**
 * 把格式化结果落到编辑器（**复用** `ui/editor-global-providers.ts` 的 `applyTextEdits`：
 * 前后各一颗 undo 停点 ⇒ 一次 Ctrl+Z 只退格式化，不退作者上一笔）。
 *
 * - 返回 `true` = 真落了一次编辑；`false` = 没 model / 无变化 / 模型已释放（不占撤销栈位）；
 * - 动态 import 宿主接线层：本模块静态图里因此**零 Monaco**（同 `ui/problem-fix-apply.ts`
 *   的由调用方动态 import 那条纪律），provider 注册与纯逻辑单测都拉不起 monaco 运行时；
 * - 本函数**不出现** `executeEdits` / `pushUndoStop`（源码钉子在 `kojo2-format.test.ts`）。
 */
export async function applyKojo2Format(editor: Kojo2FormatHost): Promise<boolean> {
  let source: string | null = null;
  try {
    const model = editor.getModel();
    if (model === null) return false;
    const value = model.getValue();
    source = typeof value === 'string' ? value : null;
  } catch {
    return false; // 模型已释放 / 桩对象：一次都不落
  }
  if (source === null) return false;
  const result = formatKojo2Source(source);
  if (!result.changed || result.edits === undefined || result.edits.length === 0) return false;
  const lineEdits = result.edits.map((edit) => ({
    fromLine: edit.range.startLineNumber,
    toLine: edit.range.endLineNumber,
    newText: edit.newText,
  }));
  const { applyTextEdits } = await import('../ui/editor-global-providers');
  return applyTextEdits(editor as unknown as Parameters<typeof applyTextEdits>[0], lineEdits);
}
