import type { ControlFlowStatement, ErbDim, ErbFile, ErbFunction, ErbLabel, ErbParam } from '@kojo/plugin-api';
import { DIM_MODIFIERS, DIM_RE, type ControlFlowRole } from '@kojo/erb-vocab/control-flow';

/**
 * 行首「代码前缀」`;!;` / `;#;`（2026-10-25 ERB 语法缺口批 P2-1）。
 *
 * 语法事实：这两种前缀之后是**有效代码**，不是注释——`;!;` 是"Emuera 专用语句"
 * （eramaker 跳过、Emuera 执行），`;#;` 是"仅调试模式执行"（Era Wiki `Emuera/exetc`）。
 * 当注释吞掉的后果不止"少着一点色"：`;!;[SKIPSTART]` 与对称的 `[SKIPEND]` 会**失配**，
 * 之后整篇文件的行可见性全错（索引 / 波浪线 / 条件矩阵一起歪）。
 *
 * ## 为什么判据写在这里、而不是 import 一个共享模块
 *
 * 本文件被 `packages/erb-syntax-tree/tools/gen-erb-structure.mjs` 用**裸 node** 动态
 * import（要 `ERB_CONTROL_STATEMENTS` / `classifyControlFlow` 的运行时值）。裸 node 的
 * ESM 解析有两条硬约束：① 相对导入必须带扩展名；② 指向 plugin-api 的**值**导入会真的去
 * 加载 `plugin-api/src/index.ts`，而它内部用的是无扩展名相对导入（`from './events'`）⇒
 * 直接失败。`import type` 会被类型擦除整条删掉，所以本文件此前一直只有类型导入。
 * 本批先按"单源"写成从 plugin-api 值导入，`projection-single-source` 的字节闸立刻红；
 * 改成相对导入 `./code-prefix` 也红（缺扩展名）⇒ 结论：**本文件不许有裸 node 解析不了的值导入**
 * （控制流表那条边例外：包 specifier 指向零运行时 import 的自包含叶子，实测可解析）。
 *
 * ## 一致性
 *
 * 契约层的真源是 `@kojo/plugin-api` 的 `erb-code-prefix.ts`（`condition-extractor` 与宿主
 * 都要用，而插件之间禁止互相 import）。本文件是它的字形镜像，`tests/code-prefix.test.ts`
 * 的对拍一节把两处 `ERB_CODE_PREFIXES` 逐项比对——改一处不改另一处当场红。
 */
export const ERB_CODE_PREFIXES: readonly string[] = [';!;', ';#;'];

/** 三种前缀的长度（`;!;` / `;#;` 同为 3） */
export const ERB_CODE_PREFIX_LENGTH = 3;

/** 行首代码前缀的**长度**（0 = 没有前缀）；口径与 `plugin-api` 版逐字相同 */
export function erbCodePrefixLength(trimmed: string): number {
  if (trimmed.length < ERB_CODE_PREFIX_LENGTH) return 0;
  const head = trimmed.slice(0, ERB_CODE_PREFIX_LENGTH);
  for (const prefix of ERB_CODE_PREFIXES) {
    if (head === prefix) return ERB_CODE_PREFIX_LENGTH;
  }
  return 0;
}

/** 去掉行首代码前缀后的**代码正文**（无前缀 ⇒ 原样返回，零分配） */
export function erbCodeBodyOf(trimmed: string): string {
  const len = erbCodePrefixLength(trimmed);
  return len === 0 ? trimmed : trimmed.slice(len);
}

/** 是否**真注释行**（`;` 起头，且不是 `;!;` / `;#;` 代码前缀） */
export function isErbCommentLine(trimmed: string): boolean {
  return trimmed.startsWith(';') && erbCodePrefixLength(trimmed) === 0;
}

/**
 * ERB 结构扫描器（宽容解析，不做完整语法检查）。
 *
 * 只承诺"结构感知"（架构文档 §5.2 / 设计方案 §2）：
 * - 函数边界：`@NAME` / `@NAME(params)`；`$label` 不是函数；
 * - 声明：`#DIM*` 系列（收集名字，语义细分留给 v0.2 对照 Emuera VariableDeclaration）；
 * - 标记：`#FUNCTION` / `#FUNCTIONS`（真实写法在 @ 行**之后**的函数体内，见 AUTO_AEGI.ERB:60-61；
 *   同样兼容写在 @ 前——宽容解析两种都标记）；
 * - 区间：`[SKIPSTART]` … `[SKIPEND]` 内不解析；
 * - 标签：函数内 `$LABEL` 收集进 `ErbFile.labels`（函数局部作用域，各归各的函数；
 *   skip 区与顶层不收——引擎不编译它们）；
 * - 注释：行首 `;`；定义行支持行内 `;` 注释（在括号配对之后截断）。
 *
 * 已知边界（v0.1 接受）：关键字缩写（IF 的 `I`、`SIF`…）不识别（无害）；
 * PRINT 变体与条件块留给 v0.2。
 */

/** 行内换行归一（插件内自带，不依赖 kernel——插件只允许依赖 plugin-api） */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** 顶层分隔符切分（感知括号与双引号；用于参数表） */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (const ch of s) {
    if (inStr) {
      cur += ch;
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 解析形参表（括号内内容）：`ARG, ARG:1 = 3, ref X, ARGS:1 = ""` */
export function parseParams(inner: string): ErbParam[] {
  if (inner.trim().length === 0) return [];
  return splitTopLevel(inner, ',')
    .map((part) => {
      const t = part.trim();
      if (t.length === 0) return null;
      const eq = t.indexOf('=');
      const namePart = eq >= 0 ? t.slice(0, eq) : t;
      // 形如 `ref ARG` / `ARG:1` / `OVERRIDE_TARGET = -1`
      const segments = namePart.trim().split(/\s+/);
      const name = segments[segments.length - 1] ?? '';
      if (name.length === 0) return null;
      return { name, hasDefault: eq >= 0 } satisfies ErbParam;
    })
    .filter((p): p is ErbParam => p !== null);
}

/**
 * 解析 `@NAME(…)` / `@NAME, …` 定义行（输入为已 trim 的行）。
 *
 * **逗号形**是 EraBasic 的传统声明式（真语料 130 处，`@IN_ROOM_MEMBER, ARGS, ARG, ARGS:1, ARG:1`）：
 * 名字终止符因此含 `,`——漏了它名字会带上尾逗号（`byName` 里成了 `IN_ROOM_MEMBER,`，
 * 转到定义 / 重命名 / 未定义 CALL 波浪线全部对不上），且逗号后的**声明槽**全丢。
 * 逗号后直到行内注释（`;` 起，字符串里的 `;` 不算）的段落与括号形共用同一张 `parseParams`。
 *
 * `nameOffset` = 名字在**入参 `trimmed` 内**的 0 基起点（UTF-16 码元），由同一条边界判据
 * 算出的切片顺带得到——**列的唯一算式就在这里**，别处不许再判一次"什么算函数名"。
 * `@` 与名字之间可以夹空白（真语料实测有全角空白形），故切片要 `trimStart()` 才知道名字从哪开始。
 */
export function parseFunctionDefinition(trimmed: string): { name: string; params: ErbParam[]; nameOffset: number } | null {
  if (!trimmed.startsWith('@')) return null;
  const body = trimmed.slice(1);
  // 行首 `@"…"` 是 FORM 续行 / HTML 串（`@` 与开引号合成一枚记号），不是函数定义；
  // 不挡住会把 `@"%UNICODE(0x2660)%"` 一类的续行认成形如 `"%UNICODE` 的函数（真语料 DIM.ERH）。
  const firstNonSpace = body.search(/[^ \t\u3000]/);
  if (firstNonSpace < 0 || body[firstNonSpace] === '"') return null;
  let nameEnd = body.length;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '(' || c === ',' || c === ' ' || c === '\t' || c === ';') {
      nameEnd = i;
      break;
    }
  }
  const slice = body.slice(0, nameEnd);
  const name = slice.trim();
  if (name.length === 0) return null;
  // 名字起点：`@`（1 个码元）+ 切片被 trimStart 剥掉的前导空白
  const nameOffset = 1 + (slice.length - slice.trimStart().length);

  let params: ErbParam[] = [];
  const rest = body.slice(nameEnd);
  if (rest.startsWith('(')) {
    // 括号配对（感知引号）
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]!;
      if (inStr) {
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const inner = end > 0 ? rest.slice(1, end) : rest.slice(1);
    params = parseParams(inner);
  } else if (rest.startsWith(',')) {
    // 逗号形：`, 形参, 形参…`——行内注释尾巴（`;` 起）不进形参表；字符串里的 `;` 不算注释
    let commentAt = -1;
    let inStr = false;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]!;
      if (c === '"') inStr = !inStr;
      else if (c === ';' && !inStr) {
        commentAt = i;
        break;
      }
    }
    const inner = commentAt >= 0 ? rest.slice(1, commentAt) : rest.slice(1);
    params = parseParams(inner);
  }
  return { name, params, nameOffset };
}

/**
 * `#DIM` 族声明行（**指令全集只住这一行**，宿主的 `#DIM` 腿经 `parseDimDeclaration` 复用它）。
 *
 * 族成员取自**本仓唯一的引擎侧字面依据**：`eratw-adapter/variable-schema.ts` 的
 * `parseErhConsts` 认 `DIMS|DIMF|DIM|DEFINE`（注释直接引 Emuera `UserDefinedVariableData.Create`），
 * 而 `plugin-api/erb-ext.ts` 把 `.ERH` 描述成"`#DIM`/`#DIMS`/`#DEFINE` 容器"。
 * 此前扫描器只认 `DIMSTR|DIMCHAR|DIMS|DIM`：`#DEFINE` 一条都不收（基线语料实测 22 行），
 * `DIMF` 收不到（本盘 0 行，但契约注释早就自称含它——注释与实现不符即假文档）。
 * 交替次序**必须**长的在前：`DIM` 排在 `DIMF` 前面时 `#DIMF x` 会退化成"不匹配"
 * （`\s+` 卡在 `F` 上），而不是匹配出个假名字。
 *
 * 2026-10-31：两枚正则上提到 `@kojo/erb-vocab/control-flow`（与配对表同居），构建期投影
 * `gen-erb-structure.mjs` 从那里抽同一份生成 `structure.json`；本文件只 import 使用。
 */
/**
 * 声明行的前置关键字（修饰词）。集合来源同上（`ERH_DECL_KEYWORDS`），
 * 外加本仓既有的 `NOINIT` / `CHARA`（不收会倒退）。
 *
 * **为什么这是"假事实"修复而不是覆盖面调整**：修饰词表漏一个词，那一行的名字就会
 * 被记成**那个关键字**。基线语料实测 2,866 行因此进了错名（`#DIM DYNAMIC CNT_CHARA`
 * 在索引里的变量名是 `DYNAMIC`）——悬停、补全、`#DIM` 引用查找全部指着这条假记录。
 * `LOCAL` / `STATIC` / `DYNAMIC` / `OUT` / `CHARADATA` 此前都在漏网之列。
 *
 * 2026-10-31：与 `DIM_RE` 同批上提到 `@kojo/erb-vocab/control-flow`（构建期投影的第三枚真源）。
 */

/** 解析 `#DIM` 族声明行 */
export function parseDimDeclaration(trimmed: string): { directive: string; name: string } | null {
  const m = DIM_RE.exec(trimmed);
  if (!m) return null;
  let rest = m[2]!.trim();
  // 去修饰词（可能存在多个，如 `CONST SAVEDATA`——循环剥离）
  let guard = 0;
  while (DIM_MODIFIERS.test(rest) && guard++ < 4) {
    rest = rest.replace(DIM_MODIFIERS, '').trim();
  }
  // 逗号/等号只当**分隔符**用，不当"多变量"读：`#DIM 名, 尺寸` 的第二槽是数组维度不是第二个变量。
  // 基线语料实测 1,774 条带顶层逗号的声明行里，第二槽是数字 1,371 条、是标识符的 158 条
  // 全部是 `MAX_CARD_PL` / `LIST_MAX_SORT` / `MAX_COLUMN_GROUP` 这类**尺寸常量名**（`#DIMS SORT_TARGET, LIST_MAX_SORT`），
  // 其余 245 条是表达式或 `=` 初值串（`#DIMS 賭け = "丁", "半"`）。
  // ⇒ "逗号声明多变量"在本盘拿不到任何一例，按它拆会把尺寸/初值收进名录 = 造 1,774 条假名字。
  const name = rest.split(/[\s,=]/)[0] ?? '';
  if (name.length === 0) return null;
  return { directive: m[1]!.toUpperCase(), name };
}

/** 解析 ERB 文本（纯函数，测试友好） */
/**
 * 函数上方注释块的**保留字符上限**。
 *
 * 实测真实语料平均 76 字符，但存在 2,120 字符的英文长文档离群值。
 * 索引会被快照持久化（见 snapshot.ts），离群长文不截断会让单函数吃掉整份快照的预算，
 * 所以截断并留省略号——**截断是显式降级，不是丢数据**（原文仍在文件里，悬停看到前缀即可以定位）。
 */
export const DOC_MAX_CHARS = 600;

/** 纯装饰线：`;` 加一串 `=` `-` `*` `＊` 或空白（eraTW 作者用它画框）。 */
const DOC_DECORATION_ONLY = /^;[\s=\-*＊─━]*$/;

/**
 * 把 `@` 行上方收集到的原始注释行清洗成展示文本；无可展示内容 → undefined。
 *
 * 纯函数、可单测。规则：
 * 1. 丢掉纯装饰线（`;====` 这类画框用的横线）——它们对读代码的人零信息量；
 * 2. 去掉 `;` 前缀与紧随的一个空格；
 * 3. 逐行右trim，整体再trim；全空 → undefined（**缺省而非空串**，避免索引堆无用字段）。
 */
export function cleanDocBlock(rawLines: readonly string[]): string | undefined {
  const kept: string[] = [];
  for (const line of rawLines) {
    if (DOC_DECORATION_ONLY.test(line)) continue;
    const body = line.replace(/^;\s?/, '').trimEnd();
    if (body.length > 0) kept.push(body);
  }
  if (kept.length === 0) return undefined;
  let text = kept.join('\n');
  if (text.length > DOC_MAX_CHARS) {
    text = `${text.slice(0, DOC_MAX_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

/** 解析 `$` 标签行的标签名（行首 `$` 之后到终止符；终止符 = 空白 / `;`，与 `@` 名同款宽容）。空 → undefined */
export function parseLabelDefinition(trimmed: string): string | undefined {
  let end = trimmed.length;
  for (let i = 1; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (c === ' ' || c === '\t' || c === ';') {
      end = i;
      break;
    }
  }
  const name = trimmed.slice(1, end).trim();
  return name.length > 0 ? name : undefined;
}

/**
 * 把字符串拷成**独立副本**，切断 V8 切片串（SlicedString）对父串的引用（MEM-1）。
 *
 * `parseErbText` 的工作形态是 `text.split('\n')` → 逐行 `slice` / `trim` 取名字。V8 的
 * `slice` 在结果 ≥ 13 码元时**不复制字符**，而是造一个指向父串的 `SlicedString`，父串又指向
 * 整篇正文——一枚 20 码元的函数名在堆上等于**整份文件**。索引里每个文件至少留一枚这样的名字
 * ⇒ 整库正文被静默钉住。实测（eraNAS 4,145 份 / 1.137 亿码元 / 100,393 函数）：只解析不入表、
 * 正文读完即弃，堆仍从 20.3 MB 涨到 276.4 MB；摊平后同口径 **63.0 MB**。
 *
 * 写法：`' ' + value` 造出 `ConsString(' ', 切片串)`，`slice(1)` 先摊平它——左段非空 ⇒ V8
 * 不走"左段空就直接返回右段"的快路，必然新分配一份 `SeqString` 并把两段抄进去 ⇒ 新串的父串
 * 只是一段 n+1 码元的小缓冲。实测 20 万枚 20 码元串 ≈ 28 ms，相对一次全库索引（14 s）可忽略。
 * ≤ 12 码元原样返回：V8 的 `SubString` 在该长度以下本来就复制，它已是独立串。
 * （`JSON.parse(JSON.stringify(s))` 同样能摊平且不留切片壳，但慢 3 倍。）
 */
export function detachString(value: string): string {
  if (value.length <= 12) return value;
  return (' ' + value).slice(1);
}

/** 解析单文件文本（**纯函数**）。`preSplit` = 已归一化并切好的行数组（`splitErbLines` 的产物），不传则就地切 */
export function parseErbText(text: string, path = '<memory>', preSplit?: readonly string[]): ErbFile {
  const lines = preSplit ?? normalizeEol(text).split('\n');
  const lineCount = lines.length;

  const functions: ErbFunction[] = [];
  const dims: ErbDim[] = [];
  /**
   * 函数内 `$` 标签（T4，2026-10-16 语言服务批，additive）：标签是**函数局部作用域**，
   * 跨函数的同名定义各归各的函数（归属判据 = 收集时的 `currentFuncStart`）。
   * 顶层（第一个 `@` 之前）与 `[SKIPSTART]` 区间内的不收——引擎根本不编译它们；
   * 无标签 = 缺省不给空数组（与 `docComment` 同纪律，索引不堆空字段）。
   */
  let labels: ErbLabel[] | undefined;
  let hasFunctionDirective = false;
  let inSkipBlock = false;

  /** #FUNCTION 标记：正常写在 @ 行之后（标记"上一个遇到的函数"）；写在其前则标记"下一个函数" */
  let pendingMarkerBeforeNext = false;

  /**
   * `@` 行上方紧邻的 `;` 注释块缓冲（用户反馈 9：函数名全大写 + 长前缀难辨识，
   * 悬停要给注释原文）。遇到任何**语句行**即清空——注释是跟着它下面那个声明的，
   * 隔了一条语句再挂到后面的函数上就是张冠李戴。
   */
  let docBuf: string[] = [];
  let blankRun = 0;
  const clearDoc = (): void => {
    docBuf = [];
    blankRun = 0;
  };
  /** 连续空行超过这个数就断开——防止文件头的注释块跨越大段空白粘到后面的函数上 */
  const DOC_MAX_BLANK_GAP = 2;

  const markExpression = (): void => {
    const last = functions[functions.length - 1];
    if (last && last.startLine === currentFuncStart) {
      last.isExpressionFunction = true;
    }
  };

  let currentFuncStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    /**
     * 行首代码前缀（`;!;` / `;#;`）在**这里**一次剥掉，下游所有判据（`[SKIPSTART]` 等值、
     * 整行 `;`、`#` / `$` / `@` 行、控制流词）因此自动看见"真代码"，不需要各自再写一遍
     * 前缀判据。判据本体见 `code-prefix.ts`（七个消费面共用一份）。
     */
    const outer = raw.trim();
    const prefixLen = erbCodePrefixLength(outer);
    const trimmed = prefixLen === 0 ? outer : outer.slice(prefixLen);

    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    /**
     * 区间标记按**严格等值**判（`trimmed` 逐字等于 `[SKIPSTART]` / `[SKIPEND]`，一字不许差）。
     *
     * 本批（LS-DIM 附带的取证）动过念头的地方，取证后**不改**，读数在此（基线盘 `ERB/`
     * 递归 3,971 份方言文件）：`[SKIPSTART]` 2,186 行、`[SKIPEND]` 2,186 行，其中
     * **大小写变体 0 行、带尾注/尾空格变体 0 行、`[s]` / `[skip]` 一类别名 0 行**
     * ⇒ 放开大小写或改成前缀匹配，在这份盘上**一行已索引事实都不会变**
     * （额外开块的文件 0 份、新被屏蔽的行 0 行：`@` 定义 0 / `#` 声明 0 / `CALL` 行 0）。
     * 语义代价却是实打实的："这段是不是引擎根本不编译的死代码" 会被改写，而本仓**没有**引擎侧
     * 依据说 Emuera 怎么解析 `[skipstart]`（`docs/RESEARCH.md` 无 SKIPSTART 条目）⇒ 不猜。
     * 邻近形态照实记录、同样不改（它们是另一种语句，不是本区间的写法变体）：
     * `[ENDIF]` 84 / `[IF_DEBUG]` 41 / `[IF DEBUG]` 40 / `[IF_NDEBUG]` 2 —— 条件跳过族，
     * 要覆盖它得先拿到引擎侧配对判据，另单。
     * 同一条比较在本仓还写在这些地方（**行为必须与此逐字一致**，要改就同批改）：
     * 本文件 `forEachControlFlowLine`、`references.ts` 的 `visibleCodeLines`、`symbols.ts` 的
     * `labelScopeAt`，以及 app / condition-extractor / kojo-sugar / state-replay（本批不许动）。
     */
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0) {
      // 空行不断块（作者常在注释与 @ 行之间留一行），但连续过多空行视为断开
      if (++blankRun > DOC_MAX_BLANK_GAP) clearDoc();
      continue;
    }
    if (trimmed.startsWith(';')) {
      docBuf.push(trimmed);
      blankRun = 0;
      continue;
    }

    if (trimmed.startsWith('#')) {
      const upper = trimmed.toUpperCase();
      if (upper.startsWith('#FUNCTION')) {
        // #FUNCTION / #FUNCTIONS（含 #FUNCTIONS 是字符串版）
        if (/^#FUNCTIONS?(\s|$)/.test(upper.replace(/\s*;.*$/, ''))) {
          hasFunctionDirective = true;
          if (currentFuncStart >= 0) {
            markExpression();
          } else {
            pendingMarkerBeforeNext = true;
          }
        }
        continue;
      }
      const dim = parseDimDeclaration(trimmed);
      if (dim) {
        dims.push({ name: dim.name, directive: dim.directive, line: i + 1 });
        clearDoc(); // #DIM 上方的注释是说明这个变量声明的，不能挂到后面的函数上
      }
      continue;
    }

    if (trimmed.startsWith('$')) {
      clearDoc(); // 跳转标签同理：注释属于标签，不属于后面第一个函数
      // 函数内才收集：标签是函数局部作用域（T4）；顶层 `$` 行引擎不编译，不收
      if (currentFuncStart >= 0) {
        const name = parseLabelDefinition(trimmed);
        if (name !== undefined) (labels ??= []).push({ name, line: i + 1, functionStartLine: currentFuncStart });
      }
      continue;
    }

    if (trimmed.startsWith('@')) {
      const def = parseFunctionDefinition(trimmed);
      if (def) {
        const doc = cleanDocBlock(docBuf);
        functions.push({
          name: def.name,
          normalizedName: def.name.toUpperCase(),
          params: def.params,
          startLine: i + 1,
          endLine: lineCount, // 稍后收紧
          filePath: path,
          // 名字起点列（1 基、UTF-16 码元）= 行首前导空白宽度 + 代码前缀宽度 + 名字在 trimmed
          // 内的偏移。前导宽度用 `raw.length - raw.trimStart().length`（与 `references.ts` 的
          // `keywordEnd` 同一条算式）；`@` 与名字之间的空白已由 `def.nameOffset` 计过。
          // 本趟里 `raw` 恒在 ⇒ 列恒算得出；算不出（旧盘快照）由 snapshot 侧留空，**不补 1**。
          // 字段位次与 `snapshot.toFunction` 的还原**逐字对齐**（快照对拍比的是 JSON 串，
          // 同一份索引里"刚解析的"与"复用条还原的"两份函数对象键序不同就会红）。
          nameColumn: raw.length - raw.trimStart().length + prefixLen + def.nameOffset + 1,
          isExpressionFunction: pendingMarkerBeforeNext,
          ...(doc !== undefined ? { docComment: doc } : {}),
        });
        pendingMarkerBeforeNext = false;
        currentFuncStart = i + 1;
      }
      clearDoc();
      continue;
    }
    // 其余行为函数体/顶层语句：不影响结构扫描（v0.1）
    clearDoc();
  }

  // 收紧 endLine：下一个函数定义前一行
  for (let i = 0; i < functions.length; i++) {
    const next = functions[i + 1];
    functions[i]!.endLine = next ? next.startLine - 1 : lineCount;
  }

  /**
   * 切片留存闸（MEM-1）：本函数产出的**全部常驻字符串**都要与入参 `text` 脱钩。
   *
   * 来源都是切片：函数名与形参名（`@` 行切）、`#DIM` 族名（`split` 切）、`$` 标签名、
   * **注释块**（`cleanDocBlock` 的 `replace`/`trimEnd` 逐行切，`join('\n')` 只有一段时直接
   * 返回那枚切片——单行注释最常见）。谁不摊平谁就把整份正文拖进堆里：只摊 `name` 与把
   * `normalizedName`/`docComment` 一起摊，索引常驻差 130 MB 量级。
   *
   * 为什么不逐处在创建点摊：创建点有六处，漏一处的表现是"内存莫名多几百兆、功能全对"。
   * 收在出口这一趟，判据只有一条：**凡离开本函数且会被索引常驻的字符串，都摊过**。
   * `path` 不在闸内（调用方给的独立串）；`normalizedName` 在闸内，理由见下。
   */
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i]!;
    const rawName = fn.name;
    const detached = detachString(rawName);
    fn.name = detached;
    /**
     * `normalizedName` 是最容易漏的一处：`toUpperCase()` 对"本来就没有小写"的名字
     * （ERB 函数名绝大多数是全大写 ASCII 或纯假名）走快路**原样返回接收者**——也就是那枚切片。
     * 它一留着，`detachString(fn.name)` 刚断开的链又接回去了，而且断点在另一个字段上，
     * 只测 `name` 根本看不出来。内容相等时直接复用摊平后的那份；不等（真有小写要转）
     * 说明 `toUpperCase()` 造了新串，但它仍可能是新串上的切片，同样要摊。
     */
    fn.normalizedName = fn.normalizedName === rawName ? detached : detachString(fn.normalizedName);
    if (fn.docComment !== undefined) fn.docComment = detachString(fn.docComment);
    for (let k = 0; k < fn.params.length; k++) {
      const param = fn.params[k]!;
      param.name = detachString(param.name);
    }
  }
  for (let i = 0; i < dims.length; i++) dims[i]!.name = detachString(dims[i]!.name);
  if (labels) {
    for (let i = 0; i < labels.length; i++) labels[i]!.name = detachString(labels[i]!.name);
  }

  return { path, functions, dims, hasFunctionDirective, lineCount, ...(labels ? { labels } : {}) };
}

// ---------------------------------------------------------------------------
// 控制流骨架扫描（v0.2 第四批）——纯结构，零语义。
// 配对表（引擎 `FunctionIdentifier.cs` 的 funcMatch）住在非插件库包
// `@kojo/erb-vocab/control-flow`：本文件与库 `@kojo/erb-lang` 都只是读者，谁也不引谁。
// 头注那条"零值导入"的理由是**裸 node 解析不了**；这条边指向零运行时 import 的自包含叶子，
// `gen-erb-structure.mjs --check` 与直接 `import(scanner.ts)` 两条实测均 rc=0。
// ---------------------------------------------------------------------------

import { classifyControlFlow, closerNameForPair, ERB_CONTROL_STATEMENTS } from '@kojo/erb-vocab/control-flow';
export { classifyControlFlow, closerNameForPair, ERB_CONTROL_STATEMENTS };
export type { ControlFlowRole } from '@kojo/erb-vocab/control-flow';

/** 一行原文 → 控制流语句的形状（不是控制流语句则 null） */
export interface ControlFlowToken {
  /** 引擎里的语句原词（大写归一后的形态，如 `ENDIF`） */
  readonly kind: string;
  readonly role: ControlFlowRole;
  /** 配对类别（`if` / `select` / `try` / `funclist` …；leaf 为空串） */
  readonly pair: string;
  /** 语句后面的原文（截行内注释之前；只有需要表达式的语句非空） */
  readonly expression: string;
}

/** 提取表达式原文的语句（其余受支持语句的 expression 为空串） */
const EXPRESSION_KINDS = new Set(['IF', 'ELSEIF', 'SIF', 'SELECTCASE', 'CASE', 'REPEAT', 'FOR', 'WHILE']);

/** 行首 `;` 注释、`@` / `#` / `$` 指令行不参与控制流（`#` 同时是结构体检的区域边界，见 structure.ts） */
export function isIgnorableFlowLine(trimmed: string): boolean {
  return (
    trimmed.length === 0 ||
    trimmed.startsWith(';') ||
    trimmed.startsWith('@') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('$')
  );
}

/** 一行取控制流形状；不是控制流语句 → null */
export function controlFlowToken(trimmed: string): ControlFlowToken | null {
  const wordMatch = /^([A-Za-z_]+)/.exec(trimmed);
  if (!wordMatch) return null;
  const kind = wordMatch[1]!.toUpperCase();
  const classified = classifyControlFlow(kind);
  if (!classified) return null;
  const rest = trimmed.slice(wordMatch[1]!.length);
  return {
    kind,
    role: classified.role,
    pair: classified.pair,
    expression: EXPRESSION_KINDS.has(kind) ? sliceExpression(rest) : '',
  };
}

/**
 * 截取表达式原文：在**引号外**遇到 `;` 视为行内注释截断；
 * 字符串内的 `;` 原样保留（如 `IF STR == "a;b"`）。
 */
function sliceExpression(rest: string): string {
  let inStr = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === ';') return rest.slice(0, i).trim();
  }
  return rest.trim();
}

/**
 * 控制流视野下的逐行形状（`scanControlFlow` 与结构体检共用，见 `forEachControlFlowLine`）。
 *
 * - `statement` = null 时 `boundary` 才可能为 true（`@` / `#` / `$` 指令行）；
 * - `[SKIPSTART]…[SKIPEND]` 区间内的行两者都为 false（整段屏蔽）。
 */
export interface ControlFlowLine {
  /** 1 基行号 */
  readonly line: number;
  /** 该行原文（trim 后） */
  readonly text: string;
  /** 函数/区域边界行（`@` 或 `#` 开头；`$` 标签不算边界） */
  readonly boundary: boolean;
  /** 控制流语句形状；不是控制流语句则 null */
  readonly statement: ControlFlowToken | null;
}

/**
 * 逐行喂给控制流的**唯一**遍历（2026-10-13 反馈 7）。
 *
 * 为什么要有这一道门：骨架扫描（索引/条件抽取的热路径）与结构体检（编辑器波浪线）必须看到
 * **同一批行**。两份各自的"哪些行算数"规则一旦分叉，表现就是"波浪线指的行骨架里根本没有"——
 * 排查成本极高。屏蔽规则（注释、`@`/`#`/`$`、`[SKIPSTART]…[SKIPEND]`）从此只写在这里。
 */
export function forEachControlFlowLine(text: string, visit: (l: ControlFlowLine) => void): void {
  const lines = normalizeEol(text).split('\n');
  let inSkipBlock = false;
  for (let i = 0; i < lines.length; i++) {
    // 代码前缀（`;!;` / `;#;`）先剥掉：`;!;[SKIPSTART]` 要真的开停用区，
    // `;!;IF x` 要真的进控制流栈（判据单源 `code-prefix.ts`）
    const outer = lines[i]!.trim();
    const trimmed = erbCodeBodyOf(outer);
    if (inSkipBlock) {
      if (trimmed === '[SKIPEND]') inSkipBlock = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkipBlock = true;
      continue;
    }
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('$')) continue;
    if (trimmed.startsWith('@') || trimmed.startsWith('#')) {
      visit({ line: i + 1, text: trimmed, boundary: true, statement: null });
      continue;
    }
    visit({ line: i + 1, text: trimmed, boundary: false, statement: controlFlowToken(trimmed) });
  }
}

/**
 * 控制流骨架扫描（纯函数，宽容解析）：
 * - 线性输出全部控制流语句，附带块深度（见 `ControlFlowStatement` 契约）；
 * - `[SKIPSTART]…[SKIPEND]`、注释、`@` / `#` / `$` 行不参与；
 * - 配对不完好（孤儿闭合 / 错配嵌套）时不中断：闭合语句向栈内查找最近匹配项，
 *   找不到则不动栈——深度尽量保持可用（真实语料配平完好，此路径为防御性）。
 *
 * 报错是另一个人的活：结构体检在 `structure.ts`，与这里共用 `forEachControlFlowLine` 的视野。
 */
export function scanControlFlow(text: string): ControlFlowStatement[] {
  const out: ControlFlowStatement[] = [];
  const stack: string[] = []; // 配对类别栈

  forEachControlFlowLine(text, ({ line, statement }) => {
    if (!statement) return;
    const { kind, expression, role, pair } = statement;

    if (role === 'leaf') {
      out.push({ kind, expression, depth: stack.length, line });
    } else if (role === 'open') {
      out.push({ kind, expression, depth: stack.length, line });
      stack.push(pair);
    } else if (role === 'branch') {
      // 与所配对的开启语句同深度（向栈内找最近匹配；找不到时退化为"栈内一层"）
      let found = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s] === pair) {
          found = s;
          break;
        }
      }
      out.push({ kind, expression, depth: found >= 0 ? found : Math.max(0, stack.length - 1), line });
    } else {
      // 闭合：向栈内查找最近匹配项并弹到它（含）；找不到则不动栈
      let found = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s] === pair) {
          found = s;
          break;
        }
      }
      if (found >= 0) stack.length = found;
      out.push({ kind, expression, depth: stack.length, line });
    }
  });

  return out;
}
