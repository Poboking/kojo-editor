import type { ErbStructureIssue } from '@kojo/plugin-api';
import { closerNameForPair, forEachControlFlowLine, parseFunctionDefinition } from './scanner';

/**
 * ERB 结构体检（2026-10-13 UI 反馈 7）：只报**可证明**的配对错误。
 *
 * 为什么要这个模块：老作者直接手写 `.ERB`，而编辑器此前对 ERB **一条波浪线都没有**
 * （唯一的 marker 贡献者只管 `.kojo`）——写完一个 `IF` 忘了 `ENDIF`，要等到引擎在运行时
 * 把整个函数读歪才知道。波浪线在这里的价值不是"好看"，是**把只有编译器能告诉你的事，
 * 提前到打字的那一秒**。
 *
 * 精度口径（错标比不标危险，所以只报三类）：
 * 1. **孤儿闭合**：`ENDIF` / `REND` / `ENDSELECT` … 在栈里找不到对应的开块；
 * 2. **未闭合的开块**：走到**函数边界**（`@` 行）或文件结尾，栈里还剩着开块
 *    （含"被更外层的闭合语句吞掉"的形状：`IF` → `REPEAT` → `ENDIF`）；
 * 3. **无主的分支**：`ELSE` / `ELSEIF` / `CASE` / `CASEELSE` / `CATCH` 出现时，
 *    栈里根本没有它要归属的那一类开块。
 *
 * 刻意**不报**的（报了就是误报农场）：
 * - 未知变量名 / 未知函数名 / `CALLFORM` 悬空引用——那是全项目语义，不是结构；
 * - 表达式写法（等号两侧、括号索引段）——`condition-extractor` 的表达式解析器领域；
 * - **分支上面还压着别的层**（`IF` → `REPEAT` → `ELSE`）：只报那条未闭合的 `REPEAT`，
 *   不额外判 `ELSE` 有罪——同一个根因报两条会让作者以为是两个错；
 * - `#` 指令行不当区域边界（函数头部那一串 `#DIM` / `#FUNCTION` 会被误报成一批未闭合块）。
 *
 * 配对表**一律复用 `scanner.ts`**（`forEachControlFlowLine` + `closerNameForPair`）：
 * 骨架扫描与结构体检必须看到同一批行、用同一张表。两处各抄一份必然漂移，
 * 漂移的表现是"波浪线指的行骨架里根本没有"，那种排查成本本项目已经付过一次。
 */

/**
 * 单次体检最多报多少条。
 *
 * 结构整个崩坏的巨型文件能刷出上千条，问题列表会被淹掉、Monaco 也要跟着画上千个 marker。
 * 到顶就**停**（不再追加），由消费方（编辑器装饰器）补一句"还有多少条没列出来"——
 * 截断必须可见，静默丢掉后面的等于让用户信"只有 50 个错"。
 */
export const MAX_STRUCTURE_ISSUES = 50;

/**
 * 一条结构发现的**诊断码**（单一真源）。
 *
 * 波浪线（`ui.editor.decorator`）与 💡 修复（`ui.editor.codeAction`）必须给同一个字符串：
 * B9 之后宿主把码写进 Monaco marker 的 `code` 字段，作者按 `Ctrl+.` 时"这条诊断 ↔ 这个动作"
 * 靠的就是它——两处各拼一份 `"erb." + kind`，一处改名一处没改，关联就静默断了。
 */
export const structureIssueCode = (issue: ErbStructureIssue): string => `erb.${issue.kind}`;

/** 一个还开着的块（栈元素） */
interface OpenBlock {
  readonly kind: string;
  readonly pair: string;
  readonly line: number;
}

/**
 * 这一行是不是**函数边界**（新函数从这里开始）。
 *
 * 为什么不能只看 `@` 开头（第一版就是这么写的，真实语料当场打脸）：
 * 语料里有大量**跨行 CALL 的续行**以 `@"…"` 开头，例如
 * `        @"给%CALLNAME:TARGET%使用避孕套（剩余{ITEM:45}枚）",ITEM:45,`
 * 那不是函数定义，但按前缀判就是"新函数开始了"——于是把上一个还没闭合的 `IF`
 * 判成未闭合、把后面真正的 `ENDIF` 判成孤儿，一次误报连环两条。
 *
 * 引擎侧的硬事实：函数名不可能是字符串字面量，`@"` 开头只能是续行/内联串。
 * 所以这里只排除 `@` 后紧跟双引号这一种形态，其余按边界处理。
 * 漏判边界是**安全方向**（未闭合会在文件结尾照样报出来，行号仍然指着开块那一行），
 * 误判边界则直接制造假缺陷——两者代价不对称，所以规则只写能证明的那一条。
 */
function isFunctionBoundary(trimmed: string): boolean {
  if (!trimmed.startsWith('@')) return false;
  const def = parseFunctionDefinition(trimmed);
  // 名字必须像标识符：续行里的 @"给%CALLNAME:TARGET%使用…（剩余{ITEM:45}枚）" 也能被
  // parseFunctionDefinition 切出一个"名字"（空格即断），但它显然不是函数名。
  return def !== null && /^[A-Za-z_]/.test(def.name);
}

/** 栈里是否压着某一类的开块（用于 CATCH 的"归属存疑就不报"判据） */
function hasPair(stack: readonly OpenBlock[], pair: string): boolean {
  return stack.some((b) => b.pair === pair);
}

/** 向栈内找**最近**的匹配层（与 `scanControlFlow` 同一条查找方向：自顶向下） */
function findPair(stack: readonly OpenBlock[], pair: string): number {
  for (let s = stack.length - 1; s >= 0; s--) {
    if (stack[s]!.pair === pair) return s;
  }
  return -1;
}

/**
 * 结构体检主入口（纯函数：同一份文本必得同一份结果，不读盘、不看索引、不看项目）。
 *
 * 返回值按行号升序（遍历本身就是行序），最多 `MAX_STRUCTURE_ISSUES` 条。
 */
export function checkControlFlowStructure(text: string): ErbStructureIssue[] {
  const issues: ErbStructureIssue[] = [];
  let stack: OpenBlock[] = [];
  /** 行尾多空行也算一行：追加点要指着"最后一行之后"，与 walker 用同一种归一 */
  const lastLine = text.replace(/\r\n?/g, '\n').split('\n').length;

  /**
   * 栈里剩下的开块 = 到这里还没闭合。
   * `swallowedBy` 给出"是被谁提前收尾的"上下文；`fixBefore` 是建议插入闭合词的位置
   * （函数边界那一行 / 吞掉它的那条闭合语句之前 / 文件末尾之后）。
   */
  const flushOpen = (blocks: readonly OpenBlock[], fixBefore: number, swallowedBy?: string): void => {
    for (const b of blocks) {
      if (issues.length >= MAX_STRUCTURE_ISSUES) return;
      const closer = closerNameForPair(b.pair);
      const message =
        closer === ''
          ? `${b.kind}（第 ${b.line} 行）到这里还没有闭合。`
          : swallowedBy === undefined
            ? `${b.kind}（第 ${b.line} 行）到这里还没有闭合，缺 ${closer}。`
            : `${b.kind}（第 ${b.line} 行）还没闭合，就先被 ${swallowedBy} 收尾了——少一个 ${closer}。`;
      issues.push({
        kind: 'unclosed-open',
        line: b.line,
        statement: b.kind,
        message,
        ...(closer === '' ? {} : { closer, fixBeforeLine: fixBefore }),
      });
    }
  };

  forEachControlFlowLine(text, ({ line, text: raw, boundary, statement }) => {
    if (boundary) {
      // 只有 `@` 是新函数的开始：上一个函数体若还开着块，那是确凿的未闭合
      if (isFunctionBoundary(raw)) {
        flushOpen(stack, line);
        stack = [];
      }
      return;
    }
    if (statement === null) return;

    if (statement.role === 'leaf') return;

    if (statement.role === 'open') {
      stack.push({ kind: statement.kind, pair: statement.pair, line });
      return;
    }

    const found = findPair(stack, statement.pair);

    if (statement.role === 'branch') {
      // CATCH 例外：TRYCALLLIST / TRYGOTOLIST / TRYJUMPLIST 那一族（配对类 funclist）在引擎里
      // 与 TRYC 族共用 CATCH 这一分支词，而我们**没有**引擎侧证据说"列表块里的 CATCH 非法"
      // （真实语料 3,818 个文件里一次都没出现 TRYCALLLIST，无从实测）。
      // 没有证据就不报——这是精度纪律，不是偷懒：宁可漏报一条，也不要让波浪线开始说谎。
      const owned = found >= 0 || (statement.kind === 'CATCH' && hasPair(stack, 'funclist'));
      if (!owned && issues.length < MAX_STRUCTURE_ISSUES) {
        issues.push({
          kind: 'orphan-branch',
          line,
          statement: statement.kind,
          message: `${statement.kind} 不在它所属的块里——前面没有开着的配对块。`,
        });
      }
      return; // 分支不改栈深：开块继续开着，等它自己的闭合语句
    }

    // 闭合语句
    if (found < 0) {
      if (issues.length < MAX_STRUCTURE_ISSUES) {
        issues.push({
          kind: 'orphan-close',
          line,
          statement: statement.kind,
          message: `${statement.kind} 找不到对应的开块语句——多半是多写了一个，或上面少写了对应的开块。`,
        });
      }
      return;
    }
    // 找到配对：中间那些更深的层没被闭合就被吞掉了（IF → REPEAT → ENDIF 那种形状）
    flushOpen(stack.slice(found + 1), line, statement.kind);
    stack = stack.slice(0, found);
  });

  flushOpen(stack, lastLine + 1);
  return issues;
}
