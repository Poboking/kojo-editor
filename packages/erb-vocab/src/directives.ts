/**
 * ERB (EraBasic) 指令词表的**派生判据与整行标记** —— `@kojo/erb-vocab/directives` 叶
 * （2026-11 指令词表下沉批，从宿主 `monaco/erb-directives.ts` 逐字搬来；**不进 `src/index.ts`
 * 桶**：两处语言定义都引叶，不整包）。
 *
 * ## 为什么下沉进包
 * 同一份判据要被两处语言定义共用——`.erb` 的 Monarch（宿主 `erb-language.ts`）与 `.kojo`
 * 原生直通行高亮（宿主 `kojo-language.ts`）。`erb-language.ts` → `theme.ts` →
 * `kojo-language.ts` 是既有模块环，kojo 侧若 import `erb-language.ts` 就踩 TDZ；判据下沉进
 * 包后两边都指包，**这条环不许再长回来**（宿主侧单开一叶的旧形态本批起不再需要）。
 *
 * ## 留在原处的两样（搬的是落点，不是判据分裂）
 * - **两张词表数据**（手写常用语句 `ERB_STATEMENT_DIRECTIVES`、`#` 声明族
 *   `ERB_DECLARATION_DIRECTIVES`）住常驻插件 `@kojo/plugin-erb-parser`（`instructions.ts`，
 *   悬停分类判据同住，ERB-PARITY G1 定盘）：表内含引擎变量族头名，与本包**零游戏名词**的
 *   分层守卫闸（`tests/control-flow-boundary.test.ts`）互斥，搬不进包；
 * - **显示 / 补全全表 `ERB_DIRECTIVES`**（= 手写清单 ∪ 控制流派生词）在宿主
 *   `monaco/erb-highlight-words.ts` 物化：拼并集要同时读插件那张表与配对表，把这条装配边
 *   拉回包里就是"库包引插件"的分层倒置（2026-10-30 ERB-VOCAB 批刚清偿的债，不许再长）。
 *   **派生判据只有本文件 {@link appendUnseen} 一份**，宿主只接料。
 *
 * ## 收录口径（逐字保留；闸 = `packages/app/tests/erb-directive-words.test.ts`）
 * 1. **控制流词**一律从 `@kojo/erb-vocab/control-flow` 的 `ERB_CONTROL_STATEMENTS` 派生
 *   （scanner 开 / 分支 / 闭合配对表的并集，也正是 `erb-syntax-tree/src/structure.json` 的
 *   投影来源）：结构（折叠 / 配对）与显示（着色 / 补全）同源，改一处不会再漂一次。
 *   **禁止**把控制流词回填进手写清单——闸的「零交集」断言会红。
 * 2. 非控制流的常用语句 = **口上高频子集**（非引擎全集，不收冷门货）：按行首语句判据
 *   （行首词后不得是赋值 / 自增，也不得紧跟 `(`）在两个方言的基线真语料实测，
 *   频次达阈值（≥10）才收。三批收词的逐词频次、拒收档与**原样语句样例**全部钉在闸的
 *   证据表里（新增词必须在表里、频次单调不增、真语料仍能命中——一条都不许放宽）；
 *   同族但语料零命中的组合拒收——"族完整性"不是收录理由，"作者真在写"才是。
 *   历史逐词归因（读数、档位取舍、单文件货的判据）以 git 提交与闸表为准，本注不抄第二份。
 * 3. 族头词（同时是引擎变量族头的那些手写清单词）在显示表照收不误：`.erb` 侧统一
 *   keyword 档即正确；`.kojo` 侧由 `FAMILY_HEAD_SET` 滤出另立 `keyword.erb.family`
 *   档（宿主 `kojo-language.ts` 派生处）。
 *
 * 硬约束（本包纪律）：**零运行时 import**（连本包内相对 import 都不需要——控制流词由
 * 宿主装配时喂入）、纯数据 / 纯函数、零游戏名词。
 */

/** 大小写归一去重（先出现者保留原样），保持插入顺序 */
export function appendUnseen(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set(base.map((w) => w.toUpperCase()));
  const out = [...base];
  for (const word of extra) {
    const key = word.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

/**
 * 显示 / 补全全表的装配序（宿主用 {@link appendUnseen} 组装 `ERB_DIRECTIVES` 时遵守）：
 * 手写清单原序在前（既有候选序不动），派生词按真源自带的码元序追加。
 */

/* ============================== 原生标记（v1.9 P2 面接线） ============================== */

/**
 * 预处理标记（补全骨架；整行严格等值，见 `plugin-api/erb.ts` 的 `ERB_PREPROC_PATTERNS`）。
 * `[IF]` / `[ELSEIF]` 插入后还需作者补宏名——这里只给骨架，不猜宏。
 */
export const ERB_PREPROC_MARKERS: readonly string[] = [
  '[IF]',
  '[ELSEIF]',
  '[ELSE]',
  '[ENDIF]',
  '[IF_DEBUG]',
  '[IF_NDEBUG]',
];

/**
 * 逐字母大小写双写（`IF` → `[iI][fF]`）。
 *
 * 为什么不用 `i` 标志：Monarch 编译时会**丢掉定义里正则自带的 flags**，统一按
 * `lexer.ignoreCase` 重建；`.kojo` 的 def 是 `ignoreCase: false`（中文词形大小写敏感），
 * 所以这里把大小写写进字符类，才能让 `[if 宏名]` / `#dim` 与引擎同判。
 */
function ciWord(word: string): string {
  return word
    .split('')
    .map((ch) => (/[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch))
    .join('');
}

/**
 * 整行预处理标记（**高亮**判据）：大小写不敏感、允许行首缩进；`[IF …]` / `[ELSEIF …]` 允许宏名。
 *
 * 与 `ERB_PREPROC_MARKERS` 同集，但高亮要连宏名一起涂成一档（`[IF 宏名]` 整行一个颜色），
 * 故这里写成一条整行正则，而不是逐词命中。放在 `.kojo` 根态、**先于**行内 `[` 运算符规则。
 */
export const ERB_PREPROC_LINE_RE = new RegExp(
  `^\\s*\\[(?:${ciWord('IF')}|${ciWord('ELSEIF')})(?:\\s+[^\\]]*)?\\]\\s*$` +
    `|^\\s*\\[(?:${ciWord('ELSE')}|${ciWord('ENDIF')}|${ciWord('IF_DEBUG')}|${ciWord('IF_NDEBUG')})\\]\\s*$`,
);

/**
 * 整行 `#` 声明（**高亮**判据）：与 `ERB_DECLARATION_DIRECTIVES` 同集。
 * `\b` 保证 `#FUNCTION` 不吃 `#FUNCTIONS`、`#DIM` 不吃 `#DIMSTR`。
 */
export const ERB_DECLARATION_LINE_RE = new RegExp(
  `^\\s*#(?:${['DIMSTR', 'DIMCHAR', 'DIMF', 'DIMS', 'DIM', 'DEFINE'].map(ciWord).join('|')})\\b` +
    `|^\\s*#(?:${['FUNCTIONS', 'FUNCTION', 'GLOBAL', 'LOCALSSIZE', 'LOCALSIZE', 'SFUNCTION', 'XFUNCTION', 'TESTMEMORY']
      .map(ciWord)
      .join('|')})\\b`,
);
