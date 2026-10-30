/**
 * ERB (EraBasic) 指令词表 —— 宿主层**单一真源**（零 app 内依赖：不 import 任何 monaco / theme 模块）。
 *
 * 为什么单独成叶：同一份词表要被两处语言定义共用——`.erb` 的 Monarch（`erb-language.ts`）
 * 与 `.kojo` 原生直通行高亮（`kojo-language.ts`）。而 `erb-language.ts` → `theme.ts` →
 * `kojo-language.ts` 已有模块环，kojo 侧若 import `erb-language.ts` 就踩 TDZ；
 * 词表自身不碰这条环 ⇒ 叶子模块是唯一无环形态，`erb-language.ts` 原样 re-export 保旧 import 点。
 *
 * ## 两个来源，一份并集（2026-10-25 ERB 语法缺口批 P0-2）
 * 1. **控制流词**（`IF` / `ENDDATA` / `CATCH` / `TRYC*` 族 …）**不在这里手写**——一律从
 *    `@kojo/plugin-erb-parser` 的 `ERB_CONTROL_STATEMENTS` 派生。那张表是 scanner 开/分支/
 *    闭合配对表的并集，也正是 `packages/erb-syntax-tree/src/structure.json` 的投影来源：
 *    结构（tree-sitter 折叠/配对）与显示（着色/补全）从此同源，改一处不会再漂一次。
 *    旧形态在这里手抄了 23 个控制词，代价是"结构认、着色/补全不认"的 20 个词
 *    （`ENDDATA` 语料 3,884 行）长期白字、不可补全。
 * 2. **非控制流的常用语句**（`PRINT*` 族 / `CALL*` 族 / 变量族头 …）仍是手写清单
 *    `ERB_STATEMENT_DIRECTIVES`，口径见下。
 *
 * 纪律：**控制流词不得回填进手写清单**——`tests/erb-directive-words.test.ts` 的
 * 「手写清单与控制流真源零交集」一条会红。
 *
 * ## 手写清单的口径 = **口上高频子集**（非 Emuera 全集，不收冷门货）
 * 补齐依据：eraTW 4.980 真实语料（ERB 全树 3,980 文件）实测词频 ≥1000 的缺失名——
 * PRINTFORMDW / PRINTFORMDL / DATAFORM / RETURNF / PRINTDW / PRINTDL / GOTO / VARSET /
 * PRINTFORMD / DOWNBASE / GETNUM / PRINTBUTTON；下一档（HTML_PRINT 519 / REDRAW 307 /
 * FORCEWAIT 162 …）不收。同族但语料零命中的 L/W 组合（PRINTLW / PRINTFORMLW /
 * PRINTDATALW / PRINTFORMDLW）同样拒收——"族完整性"不是收录理由，"作者真在写"才是。
 *
 * ### 2026-10-25 P1-1 第二批：按**行首语句**形态重测（Top 59，阈值 = 频次 ≥ 10）
 * 上一批用的是"行首词 + 任意后续"的粗口径，把 `LOCAL = …` / `PAGE ++` 这类**变量语句**
 * 也算了进去。本批改按真语句判据（行首词后不得是赋值 / 自增：`=` `'=` `+=` `++` `--` …，
 * 也不得紧跟 `(`），eraNAS 4,398,019 行实测：缺失词从 2,389 个/109,279 次
 * 收敛到 **143 个 / 7,454 次**，与审计文档的 104 个 / 8,391 次同量级。
 * 本批收频次 ≥10 的 59 个（合计 6,860 次，覆盖剩余缺口的 92%），逐词频次见
 * `tests/erb-directive-words.test.ts` 的 `CORPUS_STATEMENT_GAPS`（那张表是**闸**：
 * 词表里的新增词必须在表里、表里的频次必须单调不增、且每个词在真语料里仍能命中）。
 * 下一档（SUBSTRINGU 9 / ARRAYMSORT 9 / CURRENTREDRAW 9 / QUIT 8 / PRINT_RECT 8 …）不收。
 * `DATA` 122 次单列说明：它是 `PRINTDATA` / `STRDATA` 块里的**数据行**关键字，不是变量，
 * 结构扫描器不建模它（块内行不配对），所以必须走手写清单。
 *
 * ### 2026-10-25 K5 第三批：**同一真语句判据**换 eraTW 4.980 基线语料重测（阈值 ≥10 不变，收 11 枚）
 * 口径 = 上一批立下的真语句判据（行首词后非赋值 / 非自增 / 非 `(`），测量脚本
 * `.local/erb-gap/measure.mjs`（读数 `.local/erb-gap/out.json`），语料换成本仓基线盘
 * **eraTW 画蛇添足版 4.980**（`ERB` 全树 3,971 份 / 4,126,929 行，实测全 UTF-8、3,920 份带 BOM；
 * 有效语句行 2,571,686、行首标识词 257 枚）。显示词表已认 206 枚 ⇒ 剩余缺口收敛到
 * **107 词 / 426 次**，分档：≥10 次 = **11 词 / 188 次**；3~9 次 = 32 词 / 159 次；1~2 次 = 64 词。
 * 本批收 ≥10 档全部 11 枚（逐词频次与**原样语句样例**都钉在测试闸表里）：
 * TONEINPUTS 39 / XML_GET 26 / MAP_SET 20 / GDRAWG 19 / TOOLTIP_SETDELAY 16 /
 * MAP_CREATE 16 / XML_ADDNODE 11 / AWAIT 11 / PRINT_RECT 10 / GETCOLOR 10 / BINPUT 10。
 * 上一批按 eraNAS 口径拒收的 PRINT_RECT（当时 8 次），在新语料实测 10 次达标，本批随档收入。
 *
 * **3~9 档 32 词 / 159 次与 1~2 档 64 词一律不收**，理由：①阈值是本词表唯一的收录纪律
 * （≥10），改档去迁就词就是改闸——`CORPUS_STATEMENT_GAPS` 的「最小频次 ≥ 阈值」断言会红，
 * 这条不许动；②3~9 档平均一词才 5 次、多为单份口上的私货与同族低频兄弟
 * （MAP_GETKEYS 7 / MAP_CLEAR 6 / TOOLTIP_SETDURATION 7 / XML_ADDATTRIBUTE 4 等——同族不是收录理由，
 * 「作者真在写且写到线上」才是）；③1~2 档 64 词若收，补全候选被噪声稀释，违背「口上高频子集」口径。
 * 测试里的 `CORPUS_UNCOLLECTED_TIER_3TO9` 把拒收名单也钉成闸：谁想收谁先重新取证抬档。
 *
 * `GDRAWG` 19 次但按判据只集中在 1 份文件（`ステータス表示関連\縁取り.ERB`，skip 区外的真代码；
 * `SHOP関連\TEST.ERB` 的另外 9 行整块住在 `[SKIPSTART]…[SKIPEND]` 演示区、且写作
 * `GDRAWG ++i, …` 形，被双重判据正确排除在计数外）——**收**。取舍理由：判据口径是「作者真在写」，
 * 19 条语句行全部落在系统级显示文件而非私货口上；引擎那一腿有公开手册（Emuera.EM+EE 参考手册的
 * GDRAW 家族点名 `GDRAWG` / `GDRAWGWITHMASK`，仓内已收 GDRAWTEXT / GCREATE 同族）+ 基线盘自带引擎
 * `Emuera_LazyLoadingV3.0` 二进制串面点名。单文件货若后续重测掉线，按闸表整行删除。
 *
 * 本机无引擎沙盒（`KOJO_CLIDBG_DIR` 未设，PITFALLS §103 双证里「跑起来」那一腿缺）⇒
 * 本批 11 枚全部有**语句行原样 + 手册点名**可查；把握不足的记号一个没收（待 lead 决为空白）。
 * 控制流词照旧**禁止**回填进手写清单（`ERB_CONTROL_STATEMENTS` 派生，测试零交集断言把闸）。
 *
 * 族头词（CFLAG / DOWNBASE …）在此照收不误：`.erb` 侧统一 keyword 档即正确；`.kojo` 侧
 * 由 `FAMILY_HEAD_SET` 滤出另立 `keyword.erb.family` 档（`kojo-language.ts` 派生处）。
 */
import {
  ERB_CONTROL_STATEMENTS,
  ERB_DECLARATION_DIRECTIVES,
  ERB_STATEMENT_DIRECTIVES,
} from '@kojo/plugin-erb-parser';

/**
 * 手写常用语句与 `#` 声明族两张词表**已搬进插件**（ERB-PARITY G1，2026-10-31）：
 * 悬停分类的判据在 `@kojo/plugin-erb-parser` 侧，宿主只 re-export（单源，不抄第二份）。
 */
export { ERB_DECLARATION_DIRECTIVES, ERB_STATEMENT_DIRECTIVES };

/** 大小写归一去重（先出现者保留原样），保持插入顺序 */
function appendUnseen(base: readonly string[], extra: readonly string[]): string[] {
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
 * 显示 / 补全全表 = 手写常用语句 ∪ **结构真源派生的控制流词**。
 * 顺序：手写清单原序在前（既有候选序不动），派生词按真源自带的码元序追加。
 */
export const ERB_DIRECTIVES: readonly string[] = appendUnseen(
  ERB_STATEMENT_DIRECTIVES,
  ERB_CONTROL_STATEMENTS,
);

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
 * 所以这里把大小写写进字符类，才能让 `[if 恋慕开关]` / `#dim` 与引擎同判。
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
 * 与 `ERB_PREPROC_MARKERS` 同集，但高亮要连宏名一起涂成一档（`[IF 恋慕开关]` 整行一个颜色），
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

