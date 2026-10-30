import type { EditorDocumentSymbol, ErbFile, ErbFunction, ErbStructureIssue } from '@kojo/plugin-api';
import { ERB_SKIP_MARKERS, erbPreprocRoleOf, isErbDeclarationPath } from '@kojo/plugin-api';
import { checkDeclarationIssues } from './declarations';
import { checkHeaderIssues } from './erh';
import { erbCodeBodyOf, closerNameForPair, forEachControlFlowLine, parseFunctionDefinition } from './scanner';

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
 * 匹配**严格等值**（整行只有标记，允许尾随空白）+ 大小写不敏感：判据与理由全部写在契约
 * 真源 `@kojo/plugin-api` 的 `ERB_PREPROC_PATTERNS`（本模块**不再自己写正则**）。
 * 此前这份语言事实在三处落地——这里一枚、`packages/erb-syntax-tree/src/index.ts` 一枚、
 * 显示层**根本没有**（`[IF_DEBUG]` 整行白字、`[` 位补全只有 SKIP 两枚）。插件不得依赖语言包，
 * 语言包也不该反向依赖插件，所以共同的上界是契约层：两侧都从 `plugin-api` 派生
 * （语法侧经 `structure.json` 的构建期投影），`tests/preproc-block.test.ts` 的对拍表
 * 从此升级为"真源唯一"的正向断言。
 */
export function preprocRoleOf(lineText: string): 'open' | 'branch' | 'close' | null {
  return erbPreprocRoleOf(lineText);
}

/**
 * 一行预处理器标记的完整读数（A5「分支变灰」的判据入口）。
 *
 * `macro` 的语义是**引擎的判据**，不是我们的发明：Emuera `ErbLoader.PPState.AddKeyWord`
 * 里 `[IF xxx]` 走 `Disabled = GlobalStatic.IdentifierDictionary.GetMacro(token2) == null`，
 * 而 `[IF_DEBUG]` / `[IF_NDEBUG]` 走 `Disabled = !Program.DebugMode`（另一条腿）。
 * 两者形状只差一个下划线，判据却完全不同——所以这里必须把"有没有宏名"和"角色"分开答。
 *
 * `text` 是标记原词（`[IF DEBUG]` 这样，大小写按原文），给悬停说明与死区读数用。
 */
export interface PreprocMarkerRead {
  readonly role: 'open' | 'branch' | 'close';
  /** 宏名（大写归一）；`null` = 该标记不是宏测试（`[IF_DEBUG]` / `[IF_NDEBUG]` / `[ELSE]` / `[ENDIF]`） */
  readonly macro: string | null;
  /** 标记原词（方括号内含，尾随空白已去） */
  readonly text: string;
}

/** 宏名的字符判据（对应引擎 `IdentifierDictionary.badSymbolAsIdentifier` 那张黑表） */
const BAD_MACRO_CHAR = /[+\-*/%=!<>&|^~"'(){}\[\],.:\\@$#?;\s]/;

/**
 * 宏名是否**可判**：只有一个裸标识符时才答，其余一律 `null`（= 不判）。
 *
 * 为什么这么严：引擎读 `token2` 用 `ReadSingleIdentifier`（读到空白/符号为止）。
 * `[IF A B]` 在引擎里只取 `A`，随后 `st.Current != ']'` 报 "IgnoreAfterPreprosessor"
 * 并把该行剩余部分丢掉——那已经是写法错误，不该由装饰层替作者猜他想测哪个宏。
 * 中文宏名照收（基线语料 `#DEFINE 時間帯` / `天候` 是常见形态），只有黑表里的符号与空白拒收。
 */
function macroOf(arg: string): string | null {
  const name = arg.trim();
  if (name.length === 0) return null;
  if (BAD_MACRO_CHAR.test(name)) return null;
  if (/^[0-9]/.test(name)) return null; // 引擎读标识符不吞数字开头 ⇒ 那不是宏名
  return name.toUpperCase();
}

/**
 * 标记里的**条件实参**（`[IF xxx]` / `[ELSEIF xxx]` 的 `xxx`）。
 *
 * 这里**不重新判"这是不是标记"**——那件事的唯一真源是契约层的 `erbPreprocRoleOf`
 * （`@kojo/plugin-api` 的 `ERB_PREPROC_PATTERNS`），本模块不再自己写整行判据。
 * 本函数只做"剥关键字、取剩下那段"：`IF_DEBUG` / `IF_NDEBUG` / `ELSE` / `ENDIF`
 * 关键字后面没有空白，天然取不到实参——与引擎"只有 `[IF xxx]` / `[ELSEIF xxx]` 才读宏"
 * 同一个形状，不是另立一条规则。
 */
function macroArgOf(text: string): string | null {
  const body = text.slice(1, text.lastIndexOf(']')).trim();
  const m = /^(?:IF|ELSEIF)\s+(.+)$/i.exec(body);
  return m === null ? null : macroOf(m[1]!);
}

/** 一行是不是预处理器标记；是的话给出角色 + 宏名（结构体检与分支判定共用这一处解析） */
export function preprocMarkerAt(lineText: string): PreprocMarkerRead | null {
  const role = erbPreprocRoleOf(lineText);
  if (role === null) return null;
  const text = lineText.trim();
  return { role, macro: role === 'close' ? null : macroArgOf(text), text: markerOf(text) };
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
      if (trimmed === ERB_SKIP_MARKERS.end) inSkipBlock = false;
      continue;
    }
    if (trimmed === ERB_SKIP_MARKERS.start) {
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

// ---------------------------------------------------------------------------
// 预处理条件块 · 被裁支（A5 / P0-3 尾巴：分支变灰）
// ---------------------------------------------------------------------------

/**
 * 一段被预处理器**裁掉**的分支正文（1 基、含端点）。
 *
 * 区间**不含标记行本身**：`[IF XXX]` / `[ELSE]` / `[ELSEIF XXX]` 是结构骨架，作者要看得见
 * 才读得懂"为什么下面这段是灰的"；压暗的只有引擎不会编译的正文。
 */
export interface PreprocDeadRange {
  /** 正文首行（标记行的下一行） */
  readonly fromLine: number;
  /** 正文末行（下一个分支/闭合标记的前一行） */
  readonly toLine: number;
  /** 把这一支裁掉的标记原词（`[IF DEBUG]` / `[ELSEIF FOO]` / `[ELSE]`） */
  readonly marker: string;
  /** 标记里的宏名（大写归一）；`[ELSE]` 被裁时为空串（它没有宏名） */
  readonly macro: string;
}

/** 一个还开着的条件块（`collectPreprocDeadRanges` 的栈元素） */
interface PreprocFrame {
  /** 本块内是否已有一支**必定执行**（宏命中）——它之后的支一律被裁（引擎的 `done`） */
  taken: boolean;
  /** 当前支的死区起点（1 基）；-1 = 当前支不判死 */
  deadFrom: number;
  /** 把当前支判死的标记原词与宏名（写进 {@link PreprocDeadRange}） */
  deadMarker: string;
  deadMacro: string;
}

/**
 * 找出**引擎一定会裁掉**的预处理分支正文（纯函数，编辑器装饰层的唯一数据源）。
 *
 * ## 判据（逐条对得上 Emuera `ErbLoader.PPState.AddKeyWord`）
 * | 标记 | 引擎 | 这里 |
 * |---|---|---|
 * | `[IF X]` | `Disabled = GetMacro(X) == null` | X 不在 `definedMacros` ⇒ 该支死 |
 * | `[IF_DEBUG]` | `Disabled = !Program.DebugMode` | **不判**（调试模式不可知） |
 * | `[IF_NDEBUG]` | `Disabled = Program.DebugMode` | **不判**（同上） |
 * | `[ELSEIF X]` | `Disabled = done \|\| GetMacro(X) == null` | 前面已有支确定执行，或 X 不在集 ⇒ 死 |
 * | `[ELSE]` | `Disabled = done` | 前面已有支确定执行 ⇒ 死 |
 *
 * `[IF_DEBUG]` 与 `[ELSE]` 的"前面"只要**有可能**执行就不判死（`[IF_DEBUG]…[ELSE]` 两支
 * 互斥但都可能，压错一边就是撒谎）；而 `[ELSEIF X]` 的条件是**我们自己的判据**，
 * 前面那支是否执行不影响"X 未定义 ⇒ 这一支没机会"，所以照判。
 *
 * ## 为什么 `[IF DEBUG]`（带空格）**照判**
 * 形状上它和文档里的宏测试一模一样，但真实语料里它承担的是"调试打印"的角色
 * （eraTW 4.980：`[IF DEBUG]` 40 处 / `[IF_DEBUG]` 41 处并存，块内清一色
 * `PRINTFORMW See the debugger for output.` 这类调试输出）。引擎侧**没有**给 `DEBUG`
 * 这个名字开特例（`GetMacro("DEBUG")` 照样查 `#DEFINE` 表），两个语料盘也都没有
 * `#DEFINE DEBUG` ⇒ 这 41 支在引擎里**任何模式都不会执行**。
 * 于是这里的选择只有两个：按引擎事实压暗（并让作者看见"该写 `[IF_DEBUG]`"），
 * 或者假装它们是活的。前者是真相，后者是替作者圆一个不存在的语义。
 *
 * ## 什么情况下**一个都不判**
 * `definedMacros` 为 `null` / `undefined` ⇒ 直接空数组（没索引就没有"项目里有哪些宏"
 * 这个事实，猜一次就是成片压错）。**空集不在此列**：索引在手、项目确实一个 `#DEFINE`
 * 都没有时，"`[IF X]` 必被裁"仍是可证明的。
 *
 * ## 已知的保守偏差（方向都是"少压"，不会多压）
 * - `#DEFINE` 的可见性在引擎里还受**加载顺序**约束（先加载的文件看不到后定义的宏），
 *   这里按**项目全集**判 ⇒ 顺序上晚定义的宏被当成"已定义" ⇒ 少压一支，不误压；
 * - 大小写按 `IgnoreCase=true` 归一（Emuera 默认档）；盘上若关了这个开关且作者大小写
 *   不一致，同样是"少压"这一侧；
 * - `[SKIPSTART]` 区间整体跳过（引擎那段根本不编译，里面的标记不参与配对，与
 *   `checkPreprocStructure` 同口径）；
 * - 标记行带尾随正文（`[IF DEBUG]PRINTL …`）不认（正则要求整行只有标记）——引擎会
 *   丢尾随部分并告警，那是写法错误，不在装饰层兜底。
 */
export function collectPreprocDeadRanges(
  text: string,
  definedMacros: ReadonlySet<string> | null | undefined,
): PreprocDeadRange[] {
  if (definedMacros === null || definedMacros === undefined) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const stack: PreprocFrame[] = [];
  const raw: PreprocDeadRange[] = [];
  let inSkipBlock = false;

  /** 收掉一帧里还开着的死区（`upto` = 死区最后一个可能行，1 基） */
  const closeDead = (frame: PreprocFrame, upto: number): void => {
    if (frame.deadFrom < 0) return;
    if (upto >= frame.deadFrom) {
      raw.push({
        fromLine: frame.deadFrom,
        toLine: upto,
        marker: frame.deadMarker,
        macro: frame.deadMacro,
      });
    }
    frame.deadFrom = -1;
  };

  for (let i = 0; i < lines.length; i++) {
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
    const marker = preprocMarkerAt(trimmed);
    if (marker === null) continue;
    const line = i + 1;

    if (marker.role === 'close') {
      const frame = stack.pop();
      if (frame !== undefined) closeDead(frame, line - 1);
      continue;
    }

    if (marker.role === 'branch') {
      const frame = stack[stack.length - 1];
      if (frame === undefined) continue; // 孤儿分支：结构体检负责报，这里不判
      closeDead(frame, line - 1);
      const dead = marker.macro === null ? frame.taken : frame.taken || !definedMacros.has(marker.macro);
      if (!dead && marker.macro !== null) frame.taken = true; // 宏命中 ⇒ 这一支必定执行
      if (dead) {
        frame.deadFrom = line + 1;
        frame.deadMarker = marker.text;
        frame.deadMacro = marker.macro ?? '';
      }
      continue;
    }

    // 开块
    let dead = false;
    if (marker.macro !== null) dead = !definedMacros.has(marker.macro);
    const frame: PreprocFrame = {
      taken: marker.macro !== null && !dead,
      deadFrom: dead ? line + 1 : -1,
      deadMarker: marker.text,
      deadMacro: marker.macro ?? '',
    };
    stack.push(frame);
  }

  // 未闭合的块：死区一直延伸到文件末尾（配对错误由结构体检单独报，这里只管显示）
  for (const frame of stack) closeDead(frame, lines.length);

  return mergeDeadRanges(raw);
}

/**
 * 重叠死区合并（嵌套块落在外层死区里时必然重叠）。
 *
 * 只并**重叠**、不并相邻：相邻两段来自不同分支（`[IF A]` 死 + `[ELSE]` 死），
 * 合成一段就会把两条不同的悬停说明挤成一条。
 */
function mergeDeadRanges(ranges: readonly PreprocDeadRange[]): PreprocDeadRange[] {
  if (ranges.length < 2) return [...ranges];
  const sorted = [...ranges].sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);
  const out: PreprocDeadRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.fromLine <= last.toLine) {
      if (r.toLine > last.toLine) out[out.length - 1] = { ...last, toLine: r.toLine };
      continue;
    }
    out.push(r);
  }
  return out;
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
 * 编辑器 `checkStructure` 服务的**全量入口**：配对三类 + 预处理块 + 声明面两类，
 * 拿到路径且是 `.ERH` 时再加头文件形态一趟（2026-10-26 A4）。
 *
 * 为什么在这里合成而不是让宿主分别调：宿主只认一个"这一份文本有什么问题"的答案，
 * 三条判据各自有序、合并后仍要按行升序（波浪线列表与 💡 菜单都按行读）。
 * 上限 `MAX_STRUCTURE_ISSUES` 只在合并后截一次，避免"各趟都截 50 条"变成 150 条。
 *
 * **`path` 是 additive 可选第二参**：单参调用（旧宿主 / 测试替身 / 消费方）语义逐字不变，
 * 只跑前两趟；传了路径才按文件种类分派——这是契约层 `checkStructure?` 的同一口径，
 * 判据本身住在 `erh.ts`（出处与行可见性口径都写在那个文件头上）。
 *
 * 头文件一趟与另外两趟**按行去重**：同一行既被配对/声明面点过名、又是"头文件不许写"的，
 * 只留前一条（更具体的那条）。`.ERH` 里出现 `IF` 就是这种形状——两条一起上屏会让作者
 * 以为有两个错，其实删掉那块就都好了。
 */
export function checkStructure(text: string, path?: string): ErbStructureIssue[] {
  const base = mergeByLine(checkControlFlowStructure(text), checkDeclarationIssues(text));
  if (path === undefined || !isErbDeclarationPath(path)) return base.slice(0, MAX_STRUCTURE_ISSUES);
  // 同一行已经被配对 / 声明面点过名，就不再叠一条"这行不是头文件能写的"：
  // 两条都在说"这一行不对"，叠上去只会让作者以为有两个错（`.ERH` 里写 `IF` 就是这种形状）。
  const flagged = new Set(base.map((i) => i.line));
  const header = checkHeaderIssues(text).filter((i) => !flagged.has(i.line));
  return mergeByLine(base, header).slice(0, MAX_STRUCTURE_ISSUES);
}

/* ------------------------------------------------------------------ *
 * 文档大纲（原 `document-symbols.ts`，2026-10-31 并入本文件）
 *
 * 并入理由：开机图文件数闸 ≤199 是硬线，本批补全判据要占一格进图名额，
 * 就得并掉一格旧名额。`erbDocumentSymbols` 原本只被 `plugin.ts` 一处引用、
 * 与 `checkStructure` 同属"读一份文本给一个汇总答案"，同文件是它本来的住处。
 * ------------------------------------------------------------------ */

/** `detail` 上限（大纲一行放不下长注释；截断比换行好，Monaco 不自适应行高） */
const DETAIL_MAX = 80;

/** ERB 形参 → 副标题（`ARGS` / `ARG:1` 原样列出；无参 = 空串，不留 `()` 噪声） */
function paramsDetail(fn: ErbFunction): string {
  return fn.params.length === 0 ? '' : `(${fn.params.map((p) => p.name).join(', ')})`;
}

/** 函数条目的副标题：作者写的注释首行优先（比形参认得出来），其次形参 */
function functionDetail(fn: ErbFunction): string {
  const comment = fn.docComment ? truncate(firstNonBlankLine(fn.docComment)) : '';
  return comment || paramsDetail(fn);
}

function firstNonBlankLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

function truncate(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

/**
 * 大纲项（函数 + 变量声明，按起始行升序）。
 *
 * 数据源刻意是**当前缓冲区解析结果**（`parseErbText(request.text)`）而不是项目索引：
 * 索引里的 `startLine/endLine` 说的是**磁盘上那份**，作者一有未保存编辑就整体错位——
 * 大纲与吸顶跳过去会落在隔壁函数，比不给大纲更坏。
 *
 * 声明（`#DIM`）也给：`.ERH` 这类声明文件里一个 `@` 定义都没有，只给函数就等于
 * "这类文件没有大纲"——而恰恰是这些文件最需要靠吸顶看清"现在在哪个声明段里"。
 *
 * 纯函数：文本进、符号出，不读盘、不碰索引。
 */
export function erbDocumentSymbols(file: ErbFile): EditorDocumentSymbol[] {
  const out: EditorDocumentSymbol[] = [];
  for (const fn of file.functions) {
    const detail = functionDetail(fn);
    out.push({
      name: fn.name,
      kind: 'function',
      startLine: fn.startLine,
      endLine: fn.endLine,
      ...(detail ? { detail } : {}),
    });
  }
  for (const dim of file.dims) {
    out.push({
      name: dim.name,
      kind: 'declaration',
      startLine: dim.line,
      endLine: dim.line,
      detail: dim.directive,
    });
  }
  // 文档序（同起始行时函数优先——它是"更大的那一段"）
  return out.sort((a, b) => a.startLine - b.startLine || (a.kind === b.kind ? 0 : a.kind === 'function' ? -1 : 1));
}
