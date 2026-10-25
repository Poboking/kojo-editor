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
 * 族头词（CFLAG / DOWNBASE …）在此照收不误：`.erb` 侧统一 keyword 档即正确；`.kojo` 侧
 * 由 `FAMILY_HEAD_SET` 滤出另立 `keyword.erb.family` 档（`kojo-language.ts` 派生处）。
 */
import { ERB_CONTROL_STATEMENTS } from '@kojo/plugin-erb-parser';

/**
 * 非控制流的手写常用语句（补全口径）。控制流词由 `ERB_CONTROL_STATEMENTS` 派生后追加，
 * 这里**一个都不许出现**（否则就是第二份清单）。
 */
export const ERB_STATEMENT_DIRECTIVES: readonly string[] = [
  'PRINT', 'PRINTL', 'PRINTW', 'PRINTV', 'PRINTVL',
  'PRINTFORM', 'PRINTFORML', 'PRINTFORMS', 'PRINTFORMW', 'PRINTFORMV',
  'PRINTDATAS',
  'PRINTDW', 'PRINTDL',
  'PRINTFORMD', 'PRINTFORMDL', 'PRINTFORMDW',
  'DATAFORM',
  'PRINTSINGLE', 'PRINTSINGLEL', 'PRINTSINGLEFORM', 'PRINTSINGLEFORML',
  'PRINTBUTTON',
  'BREAK', 'CONTINUE', 'RETURN', 'RETURNF',
  'GOTO',
  'CALL', 'CALLL', 'JUMP', 'CALLFORM', 'CALLFORML', 'TRYCALLFORM', 'TRYCALLFORMF',
  'TRYCALL', 'TRYJUMP', 'CALLF', 'CALLFORMF',
  'DIM', 'DIMS', 'SWAP', 'VARSET',
  'SETCOLOR', 'RESETCOLOR', 'FONTBOLD', 'FONTITALIC', 'FONTREGULAR', 'FONTSIZE', 'FONTSTYLE',
  'WAIT', 'WAITANYKEY', 'INPUT', 'INPUTS', 'ONEINPUT', 'TINPUT', 'TINPUTS', 'TWAIT',
  'SAVEDATA', 'LOADDATA', 'DELDATA', 'SAVEGLOBAL', 'LOADGLOBAL',
  'GETTIME', 'GETMILLISECOND', 'SETBIT', 'CLEARBIT', 'INVERTBIT', 'GETBIT', 'SETCOLORBYNAME',
  'RANDOMIZE', 'RAND', 'TIMES', 'EXISTCSV', 'GETNUM', 'BAR', 'BARL', 'DRAWLINE', 'CLEARLINE', 'ALIGNMENT',
  'ADDCHARA', 'ADDSPCHARA', 'DELCHARA', 'SWAPCHARA', 'PICKUPCHARA', 'GETCHARA', 'CHKCHARA',
  'EQUIP', 'UNEQUIP', 'EQUIPCHECK', 'CHANGE_CFLAG', 'CFLAG', 'DOWNBASE', 'RESETDATA', 'BEGIN', 'EVENTCOM',
  // —— 2026-10-25 P1-1 第二批（行首语句口径，频次 ≥10 的 Top 59；逐词频次见测试里的闸表）——
  // 调试输出 / 显示
  'DEBUGPRINTFORML', 'SKIPDISP', 'REUSELASTLINE', 'RESTART', 'SETFONT',
  // PRINTDATA / STRDATA 块的数据行（结构扫描器不建模，必须手写）
  'DATA',
  // DataTable（DT_* 族）
  'DT_ROW_ADD', 'DT_COLUMN_ADD', 'DT_CELL_SET', 'DT_SELECT', 'DT_ROW_REMOVE', 'DT_CREATE', 'DT_RELEASE',
  // 异常
  'THROW',
  // PRINT 扩展族（引擎方言：居中 / 单行 / 纯文本 / 按钮）
  'PRINTFORMC', 'PRINTS', 'PRINTLC', 'PRINTC', 'PRINTFORMLC', 'PRINTD',
  'PRINTPLAINFORM', 'PRINTFORMSL', 'PRINTPLAIN', 'PRINTBUTTONLC', 'PRINTSL', 'PRINTSINGLEFORMS',
  // 音频
  'PLAYSOUND', 'STOPSOUND',
  // 自绘
  'CUSTOMDRAWLINE', 'DRAWLINEFORM',
  // 数组 / 变量
  'CVARSET', 'ARRAYCOPY', 'ARRAYREMOVE', 'ARRAYSHIFT', 'ARRAYSORT',
  // 背景 / 图形 / 精灵
  'SETBGCOLOR', 'RESETBGCOLOR', 'SPRITECREATE', 'SPRITEDISPOSE',
  'GDRAWSPRITE', 'GDISPOSE', 'GCREATE', 'GCREATEFROMFILE', 'GDRAWTEXT',
  'GSETFONT', 'GSETPEN', 'GCLEAR', 'CBGCLEAR', 'CBGSETG',
  // 字符串
  'SPLIT', 'REPLACE', 'SUBSTRING',
  // 调用 / 数据 / 杂项
  'TRYCALLF', 'CHKDATA', 'RESET_STAIN', 'FINDELEMENT', 'SETANIMETIMER', 'DOTRAIN', 'GETDEFCOLOR',
];

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
