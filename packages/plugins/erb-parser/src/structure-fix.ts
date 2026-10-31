import { splitEolLines } from '@kojo/plugin-api/eol';
import type { EditorTextEdit, ErbStructureIssue, LineDecoration } from '@kojo/plugin-api';
import { checkControlFlowStructure, structureIssueCode } from './structure';
/**
 * 结构体检的**就地修复**（💡 那一下）：给未闭合的开块补上它缺的闭合语句。
 *
 * 为什么值得做：波浪线只说"少一个 `ENDIF`"，作者还得自己判断该补在哪一行。
 * 对刚接触 ERB 的人，"补在哪里"恰恰是最难的一半——补在 `IF` 紧后面和补在函数末尾，
 * 编译都过，语义完全不同。这里给的是**最保守的那一种**：在本函数结束之前补，
 * 也就是体检器判定"这一层到这里一定没关"的那个位置，改完语义等于"这个块覆盖到函数尾"。
 *
 * 为什么**只**修 `unclosed-open`（口径与 `plugin-api/erb.ts` 的 `fixBeforeLine` 同源）：
 * - 少写闭合词：栈里那一层在本函数内确定没关，插入点由配对器给出 ⇒ 可证明；
 * - 多写闭合词 / 无主分支：也可能只是**我们把函数边界漏判了**（漏判是安全方向，
 *   所以判据故意留着它），拿一条不确定推断去删用户写好的行 = 把不确定的事做成了动作。
 *   那两类只报位置，不给动作。
 *
 * 纯函数：不读盘、不碰 Monaco。`EditorTextEdit` 是**整行替换**语义（宿主按行号降序合并成
 * 一次可撤销编辑），所以插入 = 把锚点那一行原样重写、再把闭合词添在它前面/后面。
 */

export interface ErbStructureFix {
  /** 动作标题（进 💡 列表，中文、说清落在哪） */
  readonly title: string;
  /** 波浪线所在行（宿主按光标行筛选） */
  readonly issueLine: number;
  /**
   * 这条修复**消解的那一条波浪线**（B9）：与 `ui.editor.decorator` 发布出去的那一份
   * 同源同形（同一个 `structureDiagnostic`，见下）。宿主把它挂进 Monaco 的
   * `CodeAction.diagnostics` —— `Ctrl+.` 落在哪条波浪线上、优先排谁、应用时高亮哪一段，
   * 全看这一份对不对得上。
   */
  readonly diagnostic: LineDecoration;
  readonly edits: readonly EditorTextEdit[];
}

/**
 * 一条结构发现 → 它对应的那条波浪线（**单一真源**）。
 *
 * 为什么要有这个函数：波浪线（`ui.editor.decorator`）与修复动作（`ui.editor.codeAction`）
 * 是同一个插件的两个贡献，B9 之后它们必须**逐字段相等**才能被 Monaco 认作
 * "这条诊断 ↔ 这个修复"。两处各拼一遍 `{line, severity, message, code}`，
 * 一处改了另一处没改，症状是"💡 里躺着修不了的动作"或"波浪线上按不出菜单"——
 * 静默、且不报错。抄一份不如交一份。
 */
export function structureDiagnostic(issue: ErbStructureIssue): LineDecoration {
  return {
    line: issue.line,
    // 声明面两类要分档：`#DIM` 硬规则 = error（文件加载失败）、`#FUNCTION` 收尾 = warning。
    // 缺省（配对三类）仍是 error——它们都是"这一块读不通"。
    severity: issue.severity ?? 'error',
    message: issue.message,
    code: structureIssueCode(issue),
  };
}

/** 这条波浪线是不是本次请求点明的那几条之一（按 `code` + 行精确匹配，**不做近似**） */
function isRequested(diagnostic: LineDecoration, requested: readonly LineDecoration[]): boolean {
  return requested.some(
    (d) => d.line === diagnostic.line && d.code !== undefined && d.code === diagnostic.code,
  );
}

/** 与 `scanner.normalizeEol` 同一口径：行号坐标系必须和体检器一致 */
function toLines(text: string): string[] {
  return splitEolLines(text);
}

/** 取某一行的原文（越界 / 陈旧行号一律给空串，调用方据此放弃动作而不是崩） */
function lineAt(lines: readonly string[], line: number): string {
  const i = line - 1;
  return i >= 0 && i < lines.length ? lines[i]! : '';
}

/**
 * 一条发现 → 一个修复。给不出安全插入点（缺 `closer` / 行号已经不存在）时返回 null，
 * 让上层"没有动作"成为正常结局，而不是造一个会改坏文件的动作。
 */
function fixFor(issue: ErbStructureIssue, lines: readonly string[]): ErbStructureFix | null {
  const closer = issue.closer;
  const before = issue.fixBeforeLine;
  if (closer === undefined || closer === '' || before === undefined) return null;
  if (lines.length === 0) return null;
  const diagnostic = structureDiagnostic(issue);
  const last = lines.length;
  // 开块那一行的缩进跟着走：ERB 不靠缩进语法，但作者靠缩进读层次
  const indent = /^[ \t]*/.exec(lineAt(lines, issue.line))?.[0] ?? '';
  const patch = indent + closer;

  if (before > last) {
    const tail = lines[last - 1] ?? '';
    // 末行本身是空白 ⇒ 直接把那一行换成闭合词，避免多塞一层空行
    if (tail.trim() === '') {
      return {
        issueLine: issue.line,
        diagnostic,
        title: `补上缺失的 ${patch.trim()}（放在文件末尾）`,
        edits: [{ fromLine: last, toLine: last, newText: patch }],
      };
    }
    return {
      issueLine: issue.line,
      diagnostic,
      title: `补上缺失的 ${patch.trim()}（放在文件末尾）`,
      edits: [{ fromLine: last, toLine: last, newText: tail + '\n' + patch }],
    };
  }
  const anchor = before < 1 ? 1 : before;
  const anchorText = lineAt(lines, anchor);
  if (anchorText === '' && anchor !== 1) {
    // 锚点行取不到（陈旧行号 / 越界）⇒ 宁可不给动作
    return null;
  }
  return {
    issueLine: issue.line,
    diagnostic,
    title: `补上缺失的 ${patch.trim()}（放在第 ${anchor} 行之前）`,
    edits: [{ fromLine: anchor, toLine: anchor, newText: patch + '\n' + anchorText }],
  };
}

/**
 * 当前文本的结构修复动作（宿主每次 💡 计算都会调，故要便宜：一次体检 + 一次分行）。
 *
 * `cursorLine` 给出时只返回**光标所在那一行**的动作（波浪线就在那行上，作者在那儿按
 * 💡 才找得到）；不给则返回全部（消费方自行筛选）。同一份文本必得同一份结果。
 *
 * `requested`（additive，B9）= 宿主点明的"当前这几条波浪线才是本次请求的对象"。
 * 给了就**只应答对得上的那些**（按 `code` + 行精确匹配，不近似）：
 * `Ctrl+.` 是一条针对具体诊断的请求，把同一行另一族的修复、或另一行的问题一起塞进
 * 菜单，就是"假装能修"。**没给**（旧宿主 / 非编辑器消费方）⇒ 沿用 `cursorLine` 判据，
 * 行为与改动前逐字节一致。
 */
export function buildStructureFixes(
  text: string,
  cursorLine?: number,
  requested?: readonly LineDecoration[],
): ErbStructureFix[] {
  const lines = toLines(text);
  const out: ErbStructureFix[] = [];
  for (const issue of checkControlFlowStructure(text)) {
    if (issue.kind !== 'unclosed-open') continue;
    if (cursorLine !== undefined && issue.line !== cursorLine) continue;
    const fix = fixFor(issue, lines);
    if (!fix) continue;
    if (requested && !isRequested(fix.diagnostic, requested)) continue;
    out.push(fix);
  }
  return out;
}

/** 把修复落到文本上（测试与"修完复检"用；宿主走 Monaco，不经过这里） */
export function applyStructureFix(text: string, fix: ErbStructureFix): string {
  const lines = toLines(text);
  const sorted = [...fix.edits].sort((a, b) => b.fromLine - a.fromLine);
  for (const e of sorted) {
    const from = Math.min(Math.max(1, e.fromLine), lines.length);
    const to = Math.min(Math.max(from, e.toLine), lines.length);
    lines.splice(from - 1, to - from + 1, ...e.newText.split('\n'));
  }
  return lines.join('\n');
}
