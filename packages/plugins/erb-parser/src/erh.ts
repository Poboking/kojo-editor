/**
 * `.ERH` **头文件形态**体检（2026-10-26 批 A4 · P1-4 第七条）。
 *
 * ## 判据出处（引擎源码，不是 wiki 转述）
 *
 * `Emuera/Runtime/Script/Loader/ErhLoader.cs` 的 `loadHeaderFile()`（gitlab
 * `EvilMask/emuera.em` @ `master`）逐字：
 *
 * ```csharp
 * while ((st = eReader.ReadEnabledLine()) != null)
 * {
 *     if (!noError) return false;
 *     LexicalAnalyzer.SkipWhiteSpace(st);
 *     if (st.Current != '#')
 *         throw new CodeEE(trerror.NotStartedSharpLineInHeader.Text, position);
 *     st.ShiftNext();
 *     var sharpID = LexicalAnalyzer.ReadSingleIdentifierROS(st);
 *     if (sharpID.IsEmpty)
 *     {
 *         ParserMediator.Warn(trerror.CanNotInterpretSharpLine.Text, position, 1);
 *         return false;
 *     }
 *     switch (sharpID)
 *     {
 *         case var s when s.Equals("DEFINE", …):           analyzeSharpDefine(st, position); break;
 *         case var s when s.Equals("FUNCTION", …) ||
 *                         s.Equals("FUNCTIONS", …):        analyzeSharpFunction(...); break; // 实现体 = throw new NotImplCodeEE()
 *         case var s when s.Equals("DIM", …) ||
 *                         s.Equals("DIMS", …):             dimlines.Enqueue(...); break;
 *         default: throw new CodeEE(string.Format(trerror.UnknownPreprocessorInSharpLine.Text, sharpID), position);
 *     }
 * }
 * catch (CodeEE e) { ParserMediator.Warn(e.Message, position, 2); return false; }
 * ```
 *
 * 所以 `.ERH` 的合法头只有三种：`#DEFINE` / `#DIM` / `#DIMS`。`#FUNCTION` 虽然在
 * `switch` 里，但 `analyzeSharpFunction` 的实现体是 `throw new NotImplCodeEE()`——
 * 等价于不认（而且错误文案会把人引向"没实现"，所以单独给一句话说清该写去哪）。
 *
 * 三种失败都落在同一处：`return false` ⇒ `LoadHeaderFiles` 的
 * `noError = loadHeaderFile(...); if (!noError) break;` ⇒ **整轮头文件中止**，
 * 后面的 `.ERH` 一份都不再读。后果比"这个文件没生效"更重，故严重级给 `error`。
 *
 * ## 行可见性：不能"逐行看"
 *
 * 循环拿到的不是文件行，而是 `EraStreamReader.ReadEnabledLine()` 的返回
 * （`Emuera/Runtime/Utils/EraStreamReader.cs`）。它的口径与本模块逐条对齐：
 *
 * - **空行 / 全空白行**：`line.Length == 0` 或 `SkipWhiteSpace` 后 `st.EOS` ⇒ 跳过；
 * - **注释行**：`SkipWhiteSpace` 把 `;` 到行尾整个吞掉（`st.Seek(0, End)`）后同样 `EOS`
 *   ⇒ 也跳过。注意 `;!;` / `;#;` 是**代码前缀**不是注释（`st.Jump(3)` 后继续），
 *   所以 `;!;#DIM X, 1` 是一条真声明；
 * - **`{` 行连接**：一行 trim 后正好是 `{` ⇒ 进入合流模式，随后各行原文按引擎口径拼接
 *   （`b.Append(line)` + `Config.ReplaceContinuationBR`，默认值去引号后是**一个半角空格**，
 *   见 `plugin-api` 的 `ERB_CONTINUATION_SEPARATOR`），收束的 `}` 不并入正文；`{` 行本身
 *   也不并入。合流后的那一条逻辑行才是引擎看到的东西。
 *
 * 这三条都不是理论风险：8 盘语料 648 份 `.ERH` 里 **54 份**把 `#DIMS CONST X = `
 * 后面的字符串表摊在 `{`…`}` 里。按"逐行看"判会在这 54 份上各报两条假红
 * （`{` 行和 `}` 行都不是 `#` 开头），而它们全都是能正常加载的文件。
 *
 * ## 行号口径
 *
 * 一条逻辑行报在它的**第一物理行**（`{` 那一行 / 普通行自己）。引擎的
 * `ScriptPosition` 在合流形态下指向收束的 `}` 行（`ReadLine()` 每次都推进 `curNo`），
 * 那是加载器的实现细节；作者要改的是块头，波浪线该落在块头。
 *
 * ## 刻意留在少报一侧
 *
 * `;^;` 也是引擎的代码前缀（`SkipWhiteSpace` 的第三个 case），但本仓的前缀表
 * （`plugin-api/erb-code-prefix.ts` 的 `ERB_CODE_PREFIXES`）只登记 `;!;` / `;#;`。
 * 这里沿用本仓口径：`;^;` 起头的行按注释放行。8 盘语料 `.ERH` 零处使用 `;^;`，
 * 少报一行不痛；把前缀表扩成三枚是另一件事（会同时改高亮与 scanner 的口径）。
 */

import type { ErbStructureIssue } from '@kojo/plugin-api';
import { ERB_CONTINUATION_MARKERS, erbContinuationJoin, erbContinuationRoleOf } from '@kojo/plugin-api';
import { erbCodeBodyOf, isErbCommentLine } from './scanner';

/**
 * 头文件允许的指令头。
 *
 * = 引擎 `switch` 的 case 集（`DEFINE` / `DIM` / `DIMS` / `FUNCTION` / `FUNCTIONS`）
 * 减去 `FUNCTION` 系两枚（实现体是 `throw new NotImplCodeEE()`）。
 */
export const ERH_ALLOWED_DIRECTIVES: readonly string[] = ['DEFINE', 'DIM', 'DIMS'];

/** 本模块自身的护栏（展示上限在 `structure.ts` 的 `MAX_STRUCTURE_ISSUES`，合并后统一截） */
const HEADER_ISSUE_CAP = 200;

/** 取指令名：`#DIM X` → `DIM`；`#` 后没有标识符 → `''`；不以 `#` 开头 → `null` */
function directiveOf(body: string): string | null {
  if (!body.startsWith('#')) return null;
  const m = /^#([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  return m === null ? '' : m[1]!.toUpperCase();
}

/** 非 `#` 行在 `statement` 字段里放什么：首个记号（够作者定位，不整行抄进列表） */
function headWordOf(body: string): string {
  const m = /^\S+/.exec(body);
  if (m === null) return body;
  return m[0].length > 24 ? `${m[0].slice(0, 24)}…` : m[0];
}

/**
 * `.ERH` 形态体检主入口（纯函数：同一份文本必得同一份结果）。
 *
 * 不做的事：`#DIM` 声明内容本身（维数 / CONST / 初值 / 撞保留名）归 `declarations.ts`，
 * 这里只答"这一行**允不允许出现在头文件里**"。两条判据在 `checkStructure` 里合并，
 * 所以同一行可能同时得一条 `erh-invalid`（`#DIMSTR` 这类）与零条 `dim-invalid`。
 */
export function checkHeaderIssues(text: string): ErbStructureIssue[] {
  const issues: ErbStructureIssue[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  const push = (line: number, statement: string, message: string): void => {
    if (issues.length < HEADER_ISSUE_CAP) {
      issues.push({ kind: 'erh-invalid', severity: 'error', line, statement, message });
    }
  };

  const judge = (body: string, line: number): void => {
    if (body.length === 0) return; // 空行 / 全空白 / 注释行（由调用方先行滤过）
    const directive = directiveOf(body);
    if (directive === null) {
      push(
        line,
        headWordOf(body),
        `头文件里只能写 #DIM / #DIMS / #DEFINE——这一行不是 # 开头，Emuera 会判「头文件里出现了不以 # 开头的行」并中止整轮 .ERH 加载（后面的头文件也不再读）。`,
      );
      return;
    }
    if (directive === '') {
      push(
        line,
        '#',
        '「#」后面没有指令名——Emuera 读不出这条指令，会判「无法解释 # 行」并停止读这个文件。',
      );
      return;
    }
    if (ERH_ALLOWED_DIRECTIVES.includes(directive)) return;
    if (directive === 'FUNCTION' || directive === 'FUNCTIONS') {
      push(
        line,
        `#${directive}`,
        `#${directive} 不能写在头文件里——Emuera 的头文件加载器遇到它直接抛 NotImplemented，整个 .ERH 轮中止。函数定义写到 .ERB 里。`,
      );
      return;
    }
    push(
      line,
      `#${directive}`,
      `头文件不认 #${directive}——Emuera 的头文件加载器只认 #DIM / #DIMS / #DEFINE，其余指令会让整轮 .ERH 加载中止。`,
    );
  };

  /** 合流块（`{`…`}`）的正文片段；`null` = 当前不在块内 */
  let joined: string[] | null = null;
  let joinStart = 0;

  /**
   * 收块：把块内各行按引擎口径拼成**一条**逻辑行再判。
   *
   * 分隔符不是一个空格还是不留的"口味"问题——引擎是 `b.Append(line)` 之后紧跟
   * `b.Append(Config.ReplaceContinuationBR.Replace("\"", ""))`，配置项默认值去引号后是
   * **一个半角空格**（见 `plugin-api` 的 `ERB_CONTINUATION_SEPARATOR`）。此前这里写的是
   * `join('')`：`#DIMS CONST X =` 与 `"A"` 拼成 `= "A"`（首行尾部自带空格）看不出差别，
   * 但 `LOCAL` 与 `1` 这种会拼成 `LOCAL1`，与引擎看到的 `LOCAL 1` 是两个名字。
   */
  const closeJoin = (): void => {
    const body = erbCodeBodyOf(erbContinuationJoin(joined ?? []).trim()).trim();
    joined = null;
    if (body.length === 0) {
      push(joinStart, ERB_CONTINUATION_MARKERS.open, '行连接块里没有任何内容——Emuera 会把这条空逻辑行判成「不是 # 开头」并中止。');
      return;
    }
    judge(body, joinStart);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    // 代码前缀（`;!;` / `;#;`）之后的才是正文；前缀与正文之间允许空白
    const body = erbCodeBodyOf(raw.trim()).trim();
    const lineNo = i + 1;
    /** 块内的判据用**原文**（引擎内层循环不剥前缀：`;!;}` 在块内是正文，不是收束） */
    const rawStart = raw.trimStart();

    if (joined !== null) {
      if (rawStart.length === 0) continue; // 块内空行：引擎 append 空串，不影响正文
      if (rawStart[0] === ERB_CONTINUATION_MARKERS.close) {
        // 引擎：`TrimStart` 后首字符是 `}` ⇒ 再要求 `TrimEnd` 后整行等于 `}`
        if (rawStart.trimEnd() === ERB_CONTINUATION_MARKERS.close) {
          closeJoin();
        } else {
          // CharacterAfterContinuationEnd：引擎在该行就抛，块在此终止
          push(
            lineNo,
            ERB_CONTINUATION_MARKERS.close,
            '行连接的收束行 `}` 后面不能再有内容——Emuera 会判「行连接收束符后有多余字符」并中止。',
          );
          joined = null;
        }
        continue;
      }
      if (rawStart === ERB_CONTINUATION_MARKERS.open) {
        // 引擎：合流体内再遇 `{` ⇒ UnexpectedContinuation（中止）。
        // 报完**留在原块里**继续收（引擎在该行就停了，但这里若顺手把块状态丢掉，
        // 紧随其后的 `}` 会被判成"落单"，一条真错变成两条——多报一条也是假红）。
        push(
          lineNo,
          ERB_CONTINUATION_MARKERS.open,
          '行连接块里不能再开一个 `{`——Emuera 会判「意外的行连接开始」并中止。',
        );
        continue;
      }
      joined.push(raw);
      continue;
    }

    if (body.length === 0 || isErbCommentLine(body)) continue; // 空行 / 全空白 / 注释行（前缀已剥）
    if (body.startsWith(ERB_CONTINUATION_MARKERS.open)) {
      // 引擎要求 `{` **整行只有它自己**（`line.Trim() != "{"` ⇒ CharacterAfterContinuation）。
      // 报完照样开块、把 `{` 后面的尾巴当作块内第一段——这样紧随的 `}` 不会变成"落单"，
      // 作者修完 `{` 那一行就够了；引擎反正已经在这一行停了。
      joined = body.length > 1 ? [body.slice(1)] : [];
      joinStart = lineNo;
      if (erbContinuationRoleOf(raw) !== 'open') {
        push(
          lineNo,
          ERB_CONTINUATION_MARKERS.open,
          '行连接的 `{` 必须单独占一行——Emuera 会判「行连接符号后有多余字符」并中止。',
        );
      }
      continue;
    }
    if (body.startsWith(ERB_CONTINUATION_MARKERS.close)) {
      // 引擎在 `#` 检查之前就抛 UnexpectedContinuationEnd（ReadEnabledLine 里）
      push(
        lineNo,
        ERB_CONTINUATION_MARKERS.close,
        '这里没有正在合流的行连接块，却出现了 `}`——Emuera 会判「意外的行连接收束」并中止。',
      );
      continue;
    }
    judge(body, lineNo);
  }

  if (joined !== null) {
    // 引擎：读到文件尾仍没等到 `}` ⇒ NotCloseLineContinuation（中止）
    push(
      joinStart,
      ERB_CONTINUATION_MARKERS.open,
      '行连接块没有收束的 `}`——Emuera 会判「行连接没有结束」并中止。',
    );
  }
  return issues;
}
