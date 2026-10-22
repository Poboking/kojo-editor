import { toMonacoColumn, toMonacoLine } from '../positions';
import type { KojoStructureSyntaxFault, KojoStructureSyntaxKind } from './types';

/**
 * ERB 结构诊断的**事实 → 作者面**映射（纯函数；零 Monaco，node 池可直接钉死）。
 *
 * ## 与 Kojo 那份上屏器的分工
 *
 * `syntax-decorations.ts` 的文案是 `.kojo` 的（`台词右引号` / 糖词表派生的收束词名），
 * 且它的 `show()` 只接 `KOJO_LANGUAGE_ID`。ERB 的收束记号是 **ASCII 文法记号名**
 * （`endif_line` / `endselect_line` / `skip_end`），文案要照着 ERB 的写法说，不能借 `.kojo`
 * 的词表——所以这里单独一张映射，不让两个语言的文案口径互相污染。
 *
 * 本模块输出的是**plain 诊断事实**（行 / 列 / 码 / 文案），上屏（markers owner、与装饰通道
 * 去重）由装配点决定。ERB 结构诊断的注册点见批次报告：`providers.ts` 的 `onSyntax` 目前
 * 统一交给只认 `.kojo` 的上屏器，接 ERB 需要一处按语言分派（本文件不自带 Monaco 依赖，
 * 就是为了那一步可以直接复用）。
 *
 * ## 两类来源
 *
 * 1. **CST 事实**（`engine.ts::collectFaults`）：`ERROR` / `MISSING`。MISSING 已被引擎认领到
 *    块头行，这里只翻文案；类别闭集沿用 `KojoStructureSyntaxKind`（协议不新造类别）。
 * 2. **停用区标签**（本文件 `erbSkipTagDiagnostics`）：`[SKIPSTART]` 没有 `[SKIPEND]` /
 *    落单的 `[SKIPEND]`。语法层把 `skip_block` 的 close 做成可选（残缺文件不该把全篇吞成
 *    ERROR），所以这一类**不会**出现在 CST 的 ERROR/MISSING 里，必须由这条文本判据补上。
 *    判据与 `erb-parser/scanner.ts` 的区间判据**逐字同口径**：`line.trim()` 严格等值。
 *    停用区**体内**不误报：体内原文由 scanner 一次吞掉，本函数也只在进出区时记账。
 */

/** ERB 诊断类别（CST 闭集 + 停用区标签这一类 ERB 特有形状） */
export type ErbStructureDiagnosticKind = KojoStructureSyntaxKind | 'unpaired-skip';

/** 作者面来源标签（与结构残缺上屏器同一句） */
export const ERB_DIAGNOSTIC_SOURCE = '结构解析';

/** 诊断码前缀：`erb.` + 类别名（与 `erb-parser` 的 `erb.${kind}` 同一条拼法） */
export const ERB_DIAGNOSTIC_CODE_PREFIX = 'erb.';

/** 一条 ERB 结构诊断（行 / 列都是 1 基、终点排他——Monaco marker 直接用这份坐标） */
export interface ErbStructureDiagnostic {
  readonly line: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly message: string;
  readonly code: string;
  readonly kind: ErbStructureDiagnosticKind;
}

/** 结构解析的机器记号名（`endif_line` / `skip_end`）→ 作者要照着补的那个人话名 */
export function erbMissingName(expectedToken: string | undefined): string | null {
  if (!expectedToken) return null;
  if (expectedToken === 'skip_end') return '[SKIPEND]';
  if (expectedToken === 'skip_start') return '[SKIPSTART]';
  const lineToken = /^([A-Za-z][A-Za-z0-9]*)_line$/.exec(expectedToken);
  return lineToken === null ? null : lineToken[1]!.toUpperCase();
}

/** 块头文本 → 那一族的关键字（`IF A AND B` → `IF`、`SELECTCASE X` → `SELECTCASE`） */
export function erbBlockWord(headText: string | undefined): string | null {
  if (!headText) return null;
  const trimmed = headText.trim();
  if (trimmed === '') return null;
  const first = trimmed.split(/[\s:：,，]+/)[0] ?? '';
  return first === '' ? null : first;
}

function unclosedBlockMessage(fault: KojoStructureSyntaxFault): string {
  const line = toMonacoLine(fault.row);
  const faultLine = toMonacoLine(fault.faultRow);
  const word = erbBlockWord(fault.blockHeadText) ?? '控制流';
  const missing = erbMissingName(fault.expectedToken);
  if (missing) {
    return `第 ${line} 行的「${word}」块没有等到「${missing}」——它一直开到第 ${faultLine} 行；请在收回缩进的那一行补写「${missing}」。`;
  }
  return `第 ${line} 行的「${word}」块没有等到它的收束语句——它一直开到第 ${faultLine} 行；请补上这一族该有的收束行。`;
}

function messageFor(fault: KojoStructureSyntaxFault): string {
  const line = toMonacoLine(fault.row);
  switch (fault.kind) {
    case 'unclosed-block':
      return unclosedBlockMessage(fault);
    case 'unterminated-string':
      return `第 ${line} 行的引号开了「"」，到行尾还没等到闭合——请在行尾补上它，或用 @" 续行把这一句接到下一行。`;
    case 'unterminated-interp':
      return `第 ${line} 行的插值开了 {，到行尾还没等到 }——插值要写在同一行内，左右花括号都得有。`;
    case 'unexpected-token':
      return `第 ${line} 行有结构解析读不通的内容——请检查这一行（以及它的上一行）是否缺了收束词、引号或括号。`;
    default:
      return `第 ${line} 行的结构没读通——请检查这一行的写法。`;
  }
}

/** 一处 CST 残缺 → 一条 ERB 诊断（坐标换算与夹取在这里完成一次） */
export function erbCstDiagnostic(fault: KojoStructureSyntaxFault): ErbStructureDiagnostic {
  const line = Math.max(1, toMonacoLine(fault.row));
  const endLine = Math.max(line, toMonacoLine(fault.endRow));
  const startColumn = Math.max(1, toMonacoColumn(fault.column));
  return {
    line,
    endLine,
    startColumn,
    endColumn: Math.max(startColumn + 1, toMonacoColumn(fault.endColumn)),
    message: messageFor(fault),
    code: `${ERB_DIAGNOSTIC_CODE_PREFIX}${fault.kind}`,
    kind: fault.kind,
  };
}

/** CST 残缺表 → 诊断表（同一行只留第一条；行序排序） */
export function erbCstDiagnostics(faults: readonly KojoStructureSyntaxFault[]): ErbStructureDiagnostic[] {
  const byLine = new Map<number, ErbStructureDiagnostic>();
  for (const fault of faults) {
    if (!Number.isFinite(fault.row) || fault.row < 0) continue;
    const diagnostic = erbCstDiagnostic(fault);
    if (byLine.has(diagnostic.line)) continue;
    byLine.set(diagnostic.line, diagnostic);
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/**
 * 停用区标签配对（文本判据，与 `erb-parser/scanner.ts` 的 `[SKIPSTART]` / `[SKIPEND]`
 * 严格等值判据同口径）：
 * - 未闭合的 `[SKIPSTART]` ⇒ 一条 `unpaired-skip`（落点 = 开区行，`endLine` = 文末）；
 * - 落单的 `[SKIPEND]` ⇒ 一条 `unpaired-skip`（落点 = 那一行）；
 * - 区内再来一个 `[SKIPSTART]` 不算新开区（scanner 也只认当前区的 `[SKIPEND]`）。
 */
export function erbSkipTagDiagnostics(text: string): ErbStructureDiagnostic[] {
  const lines = text.split(/\r?\n/);
  const out: ErbStructureDiagnostic[] = [];
  let openLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '[SKIPSTART]') {
      if (openLine < 0) openLine = i + 1;
      continue;
    }
    if (trimmed === '[SKIPEND]') {
      if (openLine >= 0) openLine = -1;
      else {
        out.push({
          line: i + 1,
          endLine: i + 1,
          startColumn: 1,
          endColumn: Math.max(2, lines[i]!.length + 1),
          message: `第 ${i + 1} 行的 [SKIPEND] 没有对应的 [SKIPSTART]——停用区结束标记是落单的；请删掉它或补上开区标记。`,
          code: `${ERB_DIAGNOSTIC_CODE_PREFIX}unpaired-skip`,
          kind: 'unpaired-skip',
        });
      }
    }
  }
  if (openLine >= 0) {
    // `split` 在结尾换行后会多一枚空串：末行取"最后一个有内容的行"，别把空行算进停用区
    const lastContentLine = text.endsWith('\n') ? Math.max(openLine, lines.length - 1) : Math.max(openLine, lines.length);
    out.push({
      line: openLine,
      endLine: lastContentLine,
      startColumn: 1,
      endColumn: lines[openLine - 1]!.length + 1,
      message: `第 ${openLine} 行的 [SKIPSTART] 没有等到 [SKIPEND]——停用区一直开到文末；请补上收束标记。`,
      code: `${ERB_DIAGNOSTIC_CODE_PREFIX}unpaired-skip`,
      kind: 'unpaired-skip',
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** CST 事实 + 停用区标签 → 一份完整诊断表（同码同行去重，行序排序） */
export function erbStructureDiagnostics(
  faults: readonly KojoStructureSyntaxFault[],
  text: string,
): ErbStructureDiagnostic[] {
  const seen = new Set<string>();
  const out: ErbStructureDiagnostic[] = [];
  for (const diagnostic of [...erbCstDiagnostics(faults), ...erbSkipTagDiagnostics(text)]) {
    const key = `${diagnostic.line}\u0000${diagnostic.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out.sort((a, b) => a.line - b.line);
}
