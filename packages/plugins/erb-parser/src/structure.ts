import type { ErbStructureIssue } from '@kojo/plugin-api';
import { erbCodeBodyOf } from './scanner';
import { checkDeclarationIssues } from './declarations';
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
/**
 * 标识符**起始**字符类（erb-parser 本地一份，**不跨包 import**——audit C 禁插件间依赖）。
 * 与 `kojo-sugar/src/identifier-chars.ts` 的起始集同口径：ASCII 字母/下划线 +
 * 平假名·片假名（\u3040-\u30ff）+ 扩展A·汉字（\u3400-\u4dbf \u4e00-\u9fff）+
 * 全角拉丁 `Ａ-Ｚａ-ｚ`（\uFF21-\uFF3A \uFF41-\uFF5A）；不含数字/`$`/全角标点/全角数字。
 * 两包服务同一引擎事实（ERB 记号的字符集），漂移的表现是"引用面板找得到、
 * 结构体检却认不出定义行"——改这串时两边必须对拍（kojo-sugar 侧还有后续集，别抄错行）。
 */
const IDENT_START = /^[A-Za-z_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uFF21-\uFF3A\uFF41-\uFF5A]/;

function isFunctionBoundary(trimmed: string): boolean {
  if (!trimmed.startsWith('@')) return false;
  const def = parseFunctionDefinition(trimmed);
  // 名字必须像标识符：续行里的 @"给%CALLNAME:TARGET%使用…（剩余{ITEM:45}枚）" 也能被
  // parseFunctionDefinition 切出一个"名字"（空格即断），但它显然不是函数名——
  // 首字符 `"` 不在起始类里，自然被拒（`@"` 排除因此不需要单独一条 if）。
  // 2026-10-16 修复：起始类从 ASCII 扩到 ERB 标识符全集。语料 21% 定义名含 CJK，
  // `@日本語関数` 这类**汉字起首**的定义此前不认成边界 ⇒ 结构栈跨函数串连：
  // A 函数的未闭合 IF 被 B 函数的 ENDIF 吸收（真缺陷消失），或 B 的合法 ENDIF
  // 被判孤儿（假缺陷凭空生）——两个方向都是错的。
  return def !== null && IDENT_START.test(def.name);
}

/** 栈里是否压着某一类的开块（用于 CATCH 的"归属存疑就不报"判据） */
function hasPair(stack: readonly OpenBlock[], pair: string): boolean {
  return stack.some((b) => b.pair === pair);
}

// ---------------------------------------------------------------------------
// 预处理条件块（`[IF xxx]` / `[IF_DEBUG]` / `[IF_NDEBUG]` … `[ENDIF]`）
// ---------------------------------------------------------------------------

/**
 * 三个开块形共用一枚 `[ENDIF]`（引擎事实：预处理器按"宏是否 #DEFINE / 是否调试模式"
 * 裁剪，`[ELSEIF]` / `[ELSE]` 是同一块内的分支）⇒ 配对按**开块族**认，不做词一一映射。
 *
 * 匹配**严格等值**：整行只有标记（允许尾随空白）。与 `[SKIPSTART]` 同一条纪律——
 * 宁可漏认，也不要把 ASCII 画里的方括号行当块边界。大小写不敏感：同一份语料里
 * `[IF_DEBUG]`（41 行）与 `[IF DEBUG]`（40 行）并存，预处理器命令本身不区分大小写。
 *
 * ⚠ 本串与 `packages/erb-syntax-tree/src/index.ts` 的 `PREPROC_*` 是**同一份语言事实的两处
 * 落地**（插件不得依赖语言包，语言包也不该反向依赖插件）。两边一致性由
 * `packages/plugins/erb-parser/tests/preproc-block.test.ts` 的对拍表钉住：
 * 改一处不改另一处 ⇒ 那条测试直接红。
 */
const PREPROC_OPEN = /^\[(?:IF\s+[^\]]*\S|IF_DEBUG|IF_NDEBUG)\]\s*$/i;
const PREPROC_BRANCH = /^\[(?:ELSEIF\s+[^\]]*\S|ELSE)\]\s*$/i;
const PREPROC_CLOSE = /^\[ENDIF\]\s*$/i;

/** `[` 行的预处理器角色；不是预处理器标记 ⇒ null（供结构体检与对拍测试共用） */
export function preprocRoleOf(lineText: string): 'open' | 'branch' | 'close' | null {
  const text = lineText.trim();
  if (PREPROC_CLOSE.test(text)) return 'close';
  if (PREPROC_BRANCH.test(text)) return 'branch';
  if (PREPROC_OPEN.test(text)) return 'open';
  return null;
}

/**
 * 预处理条件块的配对体检（**独立栈**，与 ERB 控制流互不污染）。
 *
 * 为什么必须独立：被裁掉的那一支可以合法地**不配平**（`[IF_DEBUG]` 里开 `IF`、
 * `[ENDIF]` 之后才 `ENDIF`）。把它塞进控制流那张栈，一条本来正确的写法会同时刷出
 * "IF 未闭合" + "ENDIF 孤儿"两条假缺陷——错标比不标危险。
 *
 * 也不按 `@` 行清栈：`[IF]` 区块在引擎里是**文件级**裁剪，可以横跨函数定义。
 *
 * 停用区（`[SKIPSTART]`…`[SKIPEND]`）里的标记不算：那段引擎根本不编译。
 */
export function checkPreprocStructure(text: string): ErbStructureIssue[] {
  const issues: ErbStructureIssue[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const open: { kind: string; line: number }[] = [];
  let inSkipBlock = false;

  for (let i = 0; i < lines.length; i++) {
    // 代码前缀（`;!;` / `;#;`）剥掉：`;!;[SKIPSTART]` 与 `;!;[ENDIF]` 是真标记
    // （判据单源 `code-prefix.ts`）
    const trimmed = erbCodeBodyOf((lines[i] ?? '').trim());
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (!trimmed.startsWith('[')) continue;
    const role = preprocRoleOf(trimmed);
    if (role === 'open') {
      open.push({ kind: markerOf(trimmed), line: i + 1 });
    } else if (role === 'branch') {
      if (open.length === 0 && issues.length < MAX_STRUCTURE_ISSUES) {
        issues.push({
          kind: 'orphan-branch',
          line: i + 1,
          statement: markerOf(trimmed),
          message: `${markerOf(trimmed)} 不在条件块里——上面没有开着的 [IF …]。`,
        });
      }
    } else if (role === 'close') {
      if (open.length === 0) {
        if (issues.length < MAX_STRUCTURE_ISSUES) {
          issues.push({
            kind: 'orphan-close',
            line: i + 1,
            statement: '[ENDIF]',
            message: '[ENDIF] 找不到对应的条件块——多半是多写了一个，或上面少写了 [IF …]。',
          });
        }
      } else {
        open.pop();
      }
    }
  }

  // 未闭合：报告在开块那一行（与 ERB 控制流同口径），修复点在文件末尾
  for (const b of open) {
    if (issues.length >= MAX_STRUCTURE_ISSUES) break;
    issues.push({
      kind: 'unclosed-open',
      line: b.line,
      statement: b.kind,
      message: `${b.kind}（第 ${b.line} 行）到这里还没有闭合，缺 [ENDIF]。`,
      closer: '[ENDIF]',
      fixBeforeLine: lines.length + 1,
    });
  }
  return issues;
}

/** 行首标记原词（`[IF_DEBUG]` / `[ELSE]` …）：只取方括号内，尾随空白与大小写按原文保留 */
function markerOf(trimmed: string): string {
  const end = trimmed.indexOf(']');
  return end < 0 ? trimmed : trimmed.slice(0, end + 1);
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
  // 预处理条件块是**另一张栈**（见 checkPreprocStructure 头注）：两趟各自有序，按行归并。
  return mergeByLine(issues, checkPreprocStructure(text)).slice(0, MAX_STRUCTURE_ISSUES);
}

/** 两趟发现按行号归并（同源稳定：控制流在前、预处理器在后），超出上限一并截断 */
function mergeByLine(a: ErbStructureIssue[], b: ErbStructureIssue[]): ErbStructureIssue[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const out: ErbStructureIssue[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.line <= b[j]!.line) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/**
 * 编辑器 `checkStructure` 服务的**全量入口**：配对三类 + 预处理块 + 声明面两类。
 *
 * 为什么在这里合成而不是让宿主分别调：宿主只认一个"这一份文本有什么问题"的答案，
 * 三条判据各自有序、合并后仍要按行升序（波浪线列表与 💡 菜单都按行读）。
 * 上限 `MAX_STRUCTURE_ISSUES` 只在合并后截一次，避免"各趟都截 50 条"变成 150 条。
 */
export function checkStructure(text: string): ErbStructureIssue[] {
  return mergeByLine(checkControlFlowStructure(text), checkDeclarationIssues(text)).slice(0, MAX_STRUCTURE_ISSUES);
}
