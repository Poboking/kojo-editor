/**
 * 糖投影（B 层）**真实语料量化验收** —— 常驻守门，不是一次性探针。
 *
 * ## 为什么必须常驻
 *
 * 升糖重做的验收口径（`docs/archive/LIFT-REPOSITION-2026-10-12.md` §验收口径 4）明确写着：
 * **"必须有量化提升，不接受「跑通就行」"**。没有一件常驻的测量工具，就没有 before/after，
 * 也就无法证明"从 6.5% 到 90%"这句话在**当前代码**上仍然成立——改动一次逐行映射规则、
 * 混进一个过度保守的判据，覆盖率会悄悄掉回 6.5%，而单测全绿。
 *
 * 故本文件把 `docs/archive/LIFT-REMEASURE-2026-10-12.md` 的临时探针**固化**为守门测试：
 * 既打印完整读数（人看），也断言下限（CI 看）。
 *
 * ## 它测的是真实实现，不是"设想中的规则"
 *
 * 全程走生产链路：内核 + `erb-parser`（结构扫描是地基）+ `eratw-adapter` +
 * `kojo-sugar` 的 `sugar.lift`.liftProject（**被测对象本身**），文件来自真实工程索引。
 *
 * 真实游戏数据不入库：`KOJO_SMOKE_PROJECT` 未设置时整组跳过（CI 安全）。
 * 小样本快跑：`PROBE_FILE_LIMIT=300`。
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErbParserService, SugarLiftService } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { createKernel, type Kernel } from '../src/kernel';
import { NodeBridge } from './helpers/node-bridge';
import { MemoryStorageBackend } from './helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { createEratwAdapterPlugin } from '@kojo/plugin-eratw-adapter';
import { createConditionExtractorPlugin } from '@kojo/plugin-condition-extractor';
import { createKojoSugarPlugin } from '@kojo/plugin-kojo-sugar';

const SMOKE_DIR = process.env.KOJO_SMOKE_PROJECT;
const LIMIT = Number(process.env.PROBE_FILE_LIMIT ?? 0);

/** 口上语料目录名（用于"口上文件 vs 系统脚本"分组读数） */
const KOJO_DIR_MARK = '口上';

/**
 * 两类"读者要读的行"的尺子（**两把都要**，各挡一类回归）：
 *
 * - `FORM_PRINT_RE`：四个有糖形态的 `PRINTFORM*W/L/DW/DL` 变体。这是 B 层落地时的
 *   原始主指标（§5.49 起沿用），口径窄——只含"糖能一比一写出来"的行。
 * - `OUTPUT_PRINT_RE`：**全部会被打印出文本的输出行**（含裸 `PRINTFORM` / `PRINTFORMD`
 *   拼句片段，与非 FORM 的 `PRINTL` / `PRINTW` / `PRINTDL` / `PRINTDW` / `PRINT` / `PRINTD`）。
 *   批 F 把这一族接进投影，若仍只用窄尺子，新能力在守门读数里**完全看不见**。
 *
 * 两者都**不含** `PRINTDATA` 系（块开词）与按钮/排版类变体（表外，刻意不投影）。
 *
 * 批 H（`SIF`）与批 I（函数头）各自另加一把尺子，见下面 `SIF_LINE_RE` / `HEAD_LINE_RE`：
 * 一条能力若在守门读数里没有自己的分母，它悄悄退化时测试不会红。
 */
const FORM_PRINT_RE = /^\s*(PRINTFORM(?:DW|DL|W|L))\b/;
const OUTPUT_PRINT_RE = /^\s*(PRINTFORM(?:DW|DL|W|L|D)?|PRINT(?:DW|DL|W|L|D)?)\b/;
/**
 * 批 H 的尺子：`SIF 条件`（单行条件）。语料实测 100% 写成"条件独占一行 + 下一行单语句"，
 * 投影判据是两行的**配对**，所以必须按行统计"有多少 SIF 行被糖覆盖"——只看总行覆盖的话，
 * 9,516 行只占 0.26%，整条能力悄悄退化都不会红。
 */
const SIF_LINE_RE = /^\s*SIF\b/i;
/**
 * 批 I 的尺子：函数定义头行（`@名字`）。头是**读者定位"这一段在讲什么"的锚点**——
 * 语料 96% 的台词行都挂在某个头下面，但头本身留原代码时读者只知道"这里开始一段"、
 * 不知道是哪一段（`M_KOJO_MESSAGE_COM_K1_310` 对不熟悉 EraBasic 的人等于噪声）。
 *
 * 同 SIF 的道理：全语料头行只占 2.8%，混进"行覆盖"里整条能力退化都不会红，必须单列。
 */
const HEAD_LINE_RE = /^\s*@[A-Za-z_$]/;
/**
 * 批 J 的尺子：**角色状态赋值行**（`CFLAG`/`TALENT`/`ABL`/`EXP`/`MARK`/`BASE`/`PALAM`/
 * `TEQUIP`/`TCVAR` 开头，后面紧跟 `=`/`+=`/`-=`/`*=`/`/=`）。
 *
 * 分母刻意**只含角色作用域族**：语料实测口上域 122,065 条赋值里 `LOCAL` 占 72%
 * （87,853 条），那是读者的噪声底，不该混进"读者要读的行"——把它算进分母会让这把尺子
 * 看起来永远不达标，也永远不红。
 */
const STATE_ASSIGN_RE =
  /^\s*(CFLAG|TALENT|ABL|EXP|MARK|BASE|PALAM|TEQUIP|TCVAR)(?::[^:\s]+)*[ \t]*(\+=|-=|\*=|\/=|=)(?![=>])/;
/**
 * 批 K 的尺子：`CALL HPH_PRINT`（演出文本）。口上域实测 `CALL` 行里**一半是它**
 * （135,720 中 67,808），而这些行的正文就是要给读者看的台词——不投影就等于把台词锁在参数里。
 */
const HEART_LINE_RE = /^\s*CALL\s+HPH_PRINT\b/i;
/**
 * 批 N 的尺子：数据表条目行（`DATAFORM` / `DATA`）。实测全语料 **19,441 + 722 行**，
 * 且**全部**在某个数据表块内（块外游离用法 = 0 行）——这些行的正文就是要给读者看的
 * 候选文案，不投影就等于把 1.9 万行台词锁在 `DATAFORM` 前缀后面。
 *
 * 判据上限（不是缺陷，是刻意的保守）：含 `DATALIST/ENDLIST` 分组的 873 / 3,685 块
 * **整块不投影**（分组语义无引擎侧出处，不替读者下结论），所以本尺子天花板 ≈ 76%。
 */
const DATA_ENTRY_RE = /^\s*(DATAFORM|DATA)\b/;

/**
 * **质量线闸（本包追加，七把尺子之外的新守门）**：兜底形 `未识别语句 · <原文>` 只许
 * 留给**真未知语句**。注释 / 空行 / `[SKIPSTART]…[SKIPEND]` 区 / `PRINT[A-Z]*` 台词族
 * 都是**已知结构**——它们若还落在兜底里，说明规则漏了一类"正常 ERB"，不是读者该看到的
 * "工具没读懂"。本闸逐类计数（命中即失败并打印前 10 条），同时用总量上限防规则回退：
 * 上限 = 修完实测值 ×1.1（常数见下，带实测注释）。
 *
 * **工包 D 追加的第二层**：总量之下还要**成因归因**——`FALLBACK_ATTRIBUTION_KEYS` 六格按行首
 * 记号把兜底行恰分一次（`attributed === fallbackLines`），每格一条棘轮上限（`FALLBACK_CLASS_BUDGET`，
 * 只降不升），并打印每格的记号直方图与前几条样例行（**样例行只带文件名 + 行号，不带语料绝对路径**）。
 * 有了这一层，"兜底还剩 1.3 万行"才从一句总数变成"TRY 系 0 行 / 数据分组 N 行 / 控制流 N 行 /
 * 真未知 N 行"这种可以继续往下砍的形状。
 */
const FALLBACK_PREFIX = '未识别语句 · ';
/**
 * 兜底行总预算：挂盘实测 **2,055**；×1.1 = 2,260（2,260.5 向下取整）。
 * （历史读数：修前 77,329——注释 20,645 / SKIP 区 37,496 / PRINT 族 9,583 全部落兜底；
 *  `@` 函数头与 `#` 声明补上中性显示形后 13,770；`DATALIST`/`ENDLIST`/`STRDATA` 中性形 +
 *  TRY 单行档语句形 9,046；赋值/表达式行与原语补登（`7202f02`）再砍到 **3,744**；
 *  裸自增/自减行（**1,371** 行：`ABL:親密 ++` / `CFLAG:1:1009 ++` / `Snum++;2` 一族）+
 *  `{}` 多行语句括号（**318** 行 = 159 对）⇒ **2,055**。）
 * 只给规则微调留 ≤10% 余量；超过就是"正常 ERB 又被标成错误"的回归。
 */
const FALLBACK_LINE_BUDGET = 2_260;

/* ---------------- 兜底行的**成因归因**（工包 D：总量之外还要问"到底是什么"） ---------------- */

/**
 * 兜底行的成因桶（**闭集**，按行首 token 分派，一行恰进一格）。
 *
 * 为什么按 token 而不是按 `stats.nativeByReason`：那份分因是**行级**的"为什么留原生"，
 * 而兜底只发生在"留原生 **且** 显示层也认不出"的交集上，段（`sugarText`）里不回带成因，
 * 所以只能在测试侧按行首记号自己量。口径与下面的 `leadingTokenOf` 同一条正则——
 * 与本文件既有的 `nativeTokens` 直方图共用一把尺子，两处读数才能对得上。
 */
type FallbackAttributionKey =
  /** TRY 系九枚（`sugar-ident` 的 `TRY_CATCH_OPEN ∪ TRY_LIST_OPEN`）⇒ 本批给了中性显示形 */
  | 'tryNine'
  /** 其余 `TRY*` 记号（`TRYGOTO` / `TRYGOTOFORM` 这类**单行语句**，九枚之外，statement 层也没认领） */
  | 'tryOther'
  /** 数据表**分组**记号（`DATALIST` / `ENDLIST` / `STRDATA`）：批 N 刻意不投影 ⇒ 已知结构、尚无显示形 */
  | 'dataGrouping'
  /** `PRINT*` 表外变体（与上面 `print` 类同一判据，结构性恒 0，留作对照桶） */
  | 'printVariant'
  /** 其它控制流记号（判据不满足的 `SIF` / `FOR` 异形 / 裸 `GOTO` / `$标签` 变形 …） */
  | 'controlFlow'
  /** 剩下的一切：真未知 */
  | 'other';

const FALLBACK_ATTRIBUTION_KEYS: readonly FallbackAttributionKey[] = [
  'tryNine',
  'tryOther',
  'dataGrouping',
  'printVariant',
  'controlFlow',
  'other',
];

/**
 * 每类上限（**只降不升**的棘轮）。
 *
 * 两格是**结构性 0**（判据可证，不依赖实测）：
 * - `tryNine` = 0：本批在 `native-display/control.ts` 给了 `试探 原形 <记号> <原文>` 中性显示形；
 * - `printVariant` = 0：`PRINT` 打头那条判据已由上面的 `print` 类钉成 0，本桶同判据 ⇒ 同 0。
 *
 * 其余四格的首轮上界按池份额给（0.5 / 0.75 × 预算）过一轮；**2026-10-20 挂盘跑出分格实测后
 * 逐字下调**（预算只降不升）：`tryOther` 0 / `dataGrouping` 0（两族的显示形本轮落地 ⇒ 结构性归零）、
 * `controlFlow` 实测 **20**（全是 `FOR` 的异形写法：`FOR 種類,0,MAXPANTS` / `FOR LOCAL, 4`）、
 * `other` 实测 9,026 → 3,724（赋值行收掉之后）→ **2,035**（裸自增/自减 **1,371** +
 * `{}` 多行语句括号 **318** 两族落地后；剩下的头名 = `TIMES` 240 / `LOCALS` 200 /
 * `GETMILLISECOND` 148 / `DEBUGPRINTFORML` 75 / `TWAIT` 74 / `SETFONT` 72 /
 * `CFLAG` 64（`|=` 位运算赋值）/ `REUSELASTLINE` 59 / `RESULTS` 55）。
 */
const FALLBACK_CLASS_BUDGET: Readonly<Record<FallbackAttributionKey, number>> = {
  tryNine: 0, // 结构性：本批交付中性显示形
  tryOther: 0, // 结构性：单行档语句形（`尝试跳到 …`）本轮落地，挂盘实测 0
  dataGrouping: 0, // 结构性：分组记号中性形本轮落地，挂盘实测 0
  printVariant: 0, // 结构性：与 `print` 类同一判据
  controlFlow: 22, // = 实测 20 × 1.1（`FOR` 异形）
  other: 2_238, // = 实测 2,035 × 1.1（下一刀：`TIMES` 表达式语句 / `LOCALS '=` / 位运算赋值 `|=`）
};

/**
 * TRY 系九枚（= `packages/plugins/kojo-sugar/src/sugar-ident.ts` 的
 * `TRY_CATCH_OPEN`（六枚，配 `CATCH`）∪ `TRY_LIST_OPEN`（三枚，配 `ENDFUNC`））。
 *
 * **测试里逐字内联而不 import**：kernel 测试跨包只走 `@kojo/*` 的公开入口，`sugar-ident`
 * 不在 `@kojo/plugin-kojo-sugar` 的导出面上（为一条名单开导出 = 把内部识别核变成契约）。
 * 名单本身的同源闸在 `packages/plugins/kojo-sugar/tests/native-display-control.test.ts`
 * ——那里直接 import 两张集合；本文件这份内联值红了就是"显示面漏了记号"。
 */
const TRY_NINE: ReadonlySet<string> = new Set([
  'TRYCGOTO',
  'TRYCJUMP',
  'TRYCCALL',
  'TRYCGOTOFORM',
  'TRYCJUMPFORM',
  'TRYCCALLFORM',
  'TRYCALLLIST',
  'TRYGOTOLIST',
  'TRYJUMPLIST',
]);

/** 数据表**分组**记号（批 N 刻意不投影的那些；条目 / 块头 / 收束都有显示形，不落这里） */
const DATA_GROUPING_TOKENS: ReadonlySet<string> = new Set(['DATALIST', 'ENDLIST', 'STRDATA']);

/** 控制流记号（`$` = 标签定义行的行首 token；与 `OPENERS` / `STANDALONE` 覆盖的那批同名） */
const CONTROL_FLOW_TOKENS: ReadonlySet<string> = new Set([
  '$',
  'IF',
  'ELSE',
  'ELSEIF',
  'ENDIF',
  'SIF',
  'SELECTCASE',
  'CASE',
  'CASEELSE',
  'ENDSELECT',
  'FOR',
  'NEXT',
  'WHILE',
  'WEND',
  'REPEAT',
  'REND',
  'DO',
  'LOOP',
  'GOTO',
  'JUMP',
  'BREAK',
  'CONTINUE',
  'RESTART',
  'CATCH',
  'ENDCATCH',
  'ENDFUNC',
  'RETURN',
  'RETURNF',
]);

/** 一行（已 trim）⇒ 成因桶。**判据只看行首记号**，不看载荷。 */
function classifyFallbackLine(token: string): FallbackAttributionKey {
  if (TRY_NINE.has(token)) return 'tryNine';
  if (token.startsWith('TRY')) return 'tryOther';
  if (token.startsWith('PRINT')) return 'printVariant';
  if (DATA_GROUPING_TOKENS.has(token)) return 'dataGrouping';
  if (CONTROL_FLOW_TOKENS.has(token)) return 'controlFlow';
  return 'other';
}

/**
 * 行首记号（**与 `nativeTokens` 直方图共用**：同一把正则、同样大写归一）。
 * 标识符形 `[A-Za-z_$@#][A-Za-z0-9_$]*` 之外才退到"第一个非空白串"。
 */
const LEAD_TOKEN_RE = /^([A-Za-z_$@#][A-Za-z0-9_$]*|[$@#]|\S+)/;
function leadingTokenOf(text: string): string {
  const m = LEAD_TOKEN_RE.exec(text);
  return m ? m[1]!.toUpperCase() : '?';
}

/**
 * 样例行里的**文件名**——语料是玩家机器上的真实工程目录，绝对路径不进日志
 * （`tools/corpus.mjs` 的口径：认内容不认名，路径也不许抄进读数）。
 */
function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

interface Totals {
  files: number;
  filesWithSegments: number;
  totalLines: number;
  projected: number;
  passthrough: number;
  native: number;
  segments: number;
  maxSegments: number;
  /** 台词/旁白行总数（有糖形态的 `PRINTFORM*` 行） */
  speechLines: number;
  /** 其中**落在糖段内**（已显示为糖）的行数 */
  speechProjected: number;
  /** 输出行总数（批 F：含裸 FORM 与非 FORM 系——全部"会被打印出文本"的行） */
  outputLines: number;
  /** 其中已显示为糖的行数 */
  outputProjected: number;
  /** `SIF` 行数（批 H 的尺子）与其中显示为「如果 …：」的行数 */
  sifLines: number;
  sifProjected: number;
  /** 函数头行数（批 I 的尺子）与其中显示为「时机 …：」/被骨架吸收的行数 */
  headLines: number;
  headProjected: number;
  /** 角色状态赋值行数（批 J 的尺子）与其中显示成中文属性写法的行数 */
  assignLines: number;
  assignProjected: number;
  /** `CALL HPH_PRINT` 行数（批 K 的尺子）与其中显示成「心形 …」的行数 */
  heartLines: number;
  heartProjected: number;
  /** 数据表条目行数（批 N 的尺子）与其中显示成候选清单的行数 */
  dataLines: number;
  dataProjected: number;
}

const zero = (): Totals => ({
  files: 0,
  filesWithSegments: 0,
  totalLines: 0,
  projected: 0,
  passthrough: 0,
  native: 0,
  segments: 0,
  maxSegments: 0,
  speechLines: 0,
  speechProjected: 0,
  outputLines: 0,
  outputProjected: 0,
  sifLines: 0,
  sifProjected: 0,
  headLines: 0,
  headProjected: 0,
  assignLines: 0,
  assignProjected: 0,
  heartLines: 0,
  heartProjected: 0,
  dataLines: 0,
  dataProjected: 0,
});

const pct = (a: number, b: number): string => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);

function line(t: Totals, label: string): string {
  return (
    `  ${label}：文件 ${t.files}｜有可映射段 ${t.filesWithSegments}（${pct(t.filesWithSegments, t.files)}）` +
    `｜行覆盖 ${pct(t.projected, t.totalLines)}（${t.projected}/${t.totalLines}）` +
    `｜**台词行覆盖 ${pct(t.speechProjected, t.speechLines)}**（${t.speechProjected}/${t.speechLines}）` +
    `｜**输出行覆盖 ${pct(t.outputProjected, t.outputLines)}**（${t.outputProjected}/${t.outputLines}）` +
    `｜**SIF 覆盖 ${pct(t.sifProjected, t.sifLines)}**（${t.sifProjected}/${t.sifLines}）` +
    `｜**函数头可标率 ${pct(t.headProjected, t.headLines)}**（${t.headProjected}/${t.headLines}）` +
    `｜**状态赋值可读率 ${pct(t.assignProjected, t.assignLines)}**（${t.assignProjected}/${t.assignLines}）` +
    `｜**演出行可投影率 ${pct(t.heartProjected, t.heartLines)}**（${t.heartProjected}/${t.heartLines}）` +
    `｜**数据表条目可读率 ${pct(t.dataProjected, t.dataLines)}**（${t.dataProjected}/${t.dataLines}）` +
    `｜段 ${t.segments}（最多 ${t.maxSegments}/文件）`
  );
}

describe.skipIf(!SMOKE_DIR)('糖投影真实语料量化验收', () => {
  it(
    '真实工程全量：行覆盖率 + 分段不变量 + 分因读数',
    async () => {
      const appData = mkdtempSync(nodeJoin(tmpdir(), 'kojo-proj-'));
      const kernel: Kernel = await createKernel({
        platform: new NodeBridge(appData),
        plugins: [
          createErbParserPlugin(),
          createEratwAdapterPlugin(),
          createConditionExtractorPlugin(),
          createKojoSugarPlugin(),
        ],
        storageBackend: new MemoryStorageBackend(),
      });
      await kernel.start();
      const project = await kernel.project.open(SMOKE_DIR!);
      const parser = kernel.services.get<ErbParserService>(WellKnownServices.ErbParser);
      const sugar = kernel.services.get<SugarLiftService>(WellKnownServices.SugarLift);
      const index = await parser.ensureIndex();

      // 只测原生 ERB（`.kojo` 本身是糖，不属于投影对象）
      const all = [...index.files.keys()].filter((p) => /\.erb$/i.test(p)).sort();
      const use = LIMIT > 0 ? all.slice(0, LIMIT) : all;

      const total = zero();
      const kojo = zero();
      const reasons = new Map<string, number>();
      /**
       * 未被投影的**行首 token** 统计（含样本）。
       *
       * 为什么按 token 而不是按成因枚举：成因告诉我们"归到哪一类"，token 告诉我们
       * "到底是什么代码"——后者才能回答"这十万行 `other` 值不值得再做一层糖"。
       * 本项目的老教训：先看真实样本，再定规则。
       */
      const nativeTokens = new Map<string, { count: number; sample: string }>();
      /**
       * 单文件段数分布（宿主性能判据）。
       *
       * 段数 = 宿主要插的 ViewZone 数：几千个 DOM 视图区是**性能悬崖**，
       * 而"段数"又直接由骨架行（`RETURN` / `LOCAL` / `CALL`）切断决定——
       * 这条分布是"要不要做懒渲染 / 骨架合并"的唯一依据。
       */
      const segBuckets = [0, 0, 0, 0, 0, 0, 0]; // <=50 / <=200 / <=500 / <=1000 / <=2000 / <=5000 / >5000
      const bucketOf = (n: number): number =>
        n <= 50 ? 0 : n <= 200 ? 1 : n <= 500 ? 2 : n <= 1000 ? 3 : n <= 2000 ? 4 : n <= 5000 ? 5 : 6;
      let unaccounted = 0;
      let overlap = 0;
      let unreadable = 0;
      // ---- 质量线闸的累加器（本包追加；与上面七把尺子互不读写）----
      let fallbackLines = 0;
      const fallbackClasses = {
        comment: { hits: 0, samples: [] as string[] },
        blank: { hits: 0, samples: [] as string[] },
        skip: { hits: 0, samples: [] as string[] },
        print: { hits: 0, samples: [] as string[] },
        functionHead: { hits: 0, samples: [] as string[] },
        preprocessor: { hits: 0, samples: [] as string[] },
      };
      /**
       * 兜底行的**成因归因**（工包 D）：上面六格管"已知结构不许落兜底"，这一组管
       * "剩下的到底是谁"——每格带样例行与前若干行首记号，读数直接对着 `FALLBACK_CLASS_BUDGET` 收。
       */
      const attribution = new Map<FallbackAttributionKey, { hits: number; samples: string[]; tokens: Map<string, number> }>(
        FALLBACK_ATTRIBUTION_KEYS.map((k) => [k, { hits: 0, samples: [], tokens: new Map<string, number>() }]),
      );

      for (const path of use) {
        let source: string;
        try {
          source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        } catch {
          unreadable++;
          continue;
        }
        const r = sugar.liftProject({ source, filePath: path });
        const isKojo = path.includes(KOJO_DIR_MARK);

        // ---- 不变量 1：三类计数之和 = 总行数（没有行凭空消失）----
        const sum = r.stats.projectedLines + r.stats.passthroughLines + r.stats.nativeLines;
        if (sum !== r.stats.totalLines) unaccounted++;

        // ---- 不变量 2：段升序且互不重叠（宿主 ViewZone 的依据）----
        for (let i = 0; i < r.segments.length; i++) {
          const s = r.segments[i]!;
          const prev = r.segments[i - 1];
          if (s.fromLine > s.toLine || (prev && s.fromLine <= prev.toLine)) overlap++;
        }

        for (const [reason, count] of r.stats.nativeByReason.map((x) => [x.reason, x.count] as const)) {
          reasons.set(reason, (reasons.get(reason) ?? 0) + count);
        }

        // ---- 未投影行按行首 token 归堆（段内行 = 已投影）----
        const covered = new Set<number>();
        for (const s of r.segments) {
          for (let ln = s.fromLine; ln <= s.toLine; ln++) covered.add(ln);
        }
        const srcLines = source.split('\n');

        // ---- 质量线闸：投影文本里 `未识别语句 · ` 兜底行 → 源行类别（本包追加）----
        // 源行是否处在 `[SKIPSTART]…[SKIPEND]` 区内（含两条标记本身；1 基下标）。
        const inSkipRegion = new Array<boolean>(srcLines.length + 2).fill(false);
        let skipWalking = false;
        for (let ln = 1; ln <= srcLines.length; ln++) {
          const c = (srcLines[ln - 1] ?? '').trim();
          if (c === '[SKIPSTART]') skipWalking = true;
          if (skipWalking) inSkipRegion[ln] = true;
          if (c === '[SKIPEND]') skipWalking = false;
        }
        const noteFallback = (kind: keyof typeof fallbackClasses, where: string, text: string): void => {
          const rec = fallbackClasses[kind];
          rec.hits++;
          if (rec.samples.length < 10) rec.samples.push(`${where}  ${text.slice(0, 90)}`);
        };
        /** 成因桶：一行**恰进一格**（`classifyFallbackLine` 是闭集，最后落 `other`），并记行首记号 */
        const noteAttribution = (token: string, where: string, text: string): void => {
          const rec = attribution.get(classifyFallbackLine(token))!;
          rec.hits++;
          rec.tokens.set(token, (rec.tokens.get(token) ?? 0) + 1);
          if (rec.samples.length < 10) rec.samples.push(`${where}  ${text.slice(0, 90)}`);
        };
        for (const s of r.segments) {
          const projected = s.sugarText.split('\n');
          const aligned = projected.length === s.toLine - s.fromLine + 1;
          for (let i = 0; i < projected.length; i++) {
            const stripped = (projected[i] ?? '').replace(/^[\t ]*/, '');
            if (!stripped.startsWith(FALLBACK_PREFIX)) continue;
            fallbackLines++;
            // 兜底形 = 前缀 + 源行内容（`contentOf` 口径）；据此回找源行（段非 1:1 时按内容找）
            const body = stripped.slice(FALLBACK_PREFIX.length);
            let srcLn = s.fromLine + i;
            if (!aligned) {
              const found = srcLines.findIndex(
                (raw, idx) => idx + 1 >= s.fromLine && idx + 1 <= s.toLine && raw.trim() === body,
              );
              if (found >= 0) srcLn = found + 1;
            }
            const raw = srcLines[srcLn - 1] ?? '';
            const t = raw.trim();
            const where = `${baseName(path)}:${srcLn}`; // **不带语料绝对路径**（真实工程目录不进日志）
            if (t.startsWith(';')) noteFallback('comment', where, t);
            if (t.length === 0) noteFallback('blank', where, t);
            if (inSkipRegion[srcLn]) noteFallback('skip', where, t);
            if (/^PRINT[A-Z]*/.test(t)) noteFallback('print', where, t);
            if (t.startsWith('@')) noteFallback('functionHead', where, t);
            if (t.startsWith('#')) noteFallback('preprocessor', where, t);
            noteAttribution(leadingTokenOf(t), where, t);
          }
        }

        for (let ln = 1; ln <= srcLines.length; ln++) {
          if (covered.has(ln)) continue;
          const text = (srcLines[ln - 1] ?? '').trim();
          if (text.length === 0 || text.startsWith(';')) continue; // 注释与空行本来就是"透传"
          const token = leadingTokenOf(text);
          const rec = nativeTokens.get(token) ?? { count: 0, sample: text.slice(0, 80) };
          rec.count++;
          nativeTokens.set(token, rec);
        }

        // ---- 读者要读的行有多少显示成了糖（四把尺子，见文件头与各尺子定义处注释）----
        let speech = 0;
        let speechCovered = 0;
        let output = 0;
        let outputCovered = 0;
        let sif = 0;
        let sifCovered = 0;
        let head = 0;
        let headCovered = 0;
        let assign = 0;
        let assignCovered = 0;
        let heart = 0;
        let heartCovered = 0;
        let dataRows = 0;
        let dataCovered = 0;
        for (let ln = 1; ln <= srcLines.length; ln++) {
          const text = srcLines[ln - 1] ?? '';
          if (DATA_ENTRY_RE.test(text)) {
            dataRows++;
            if (covered.has(ln)) dataCovered++;
            continue;
          }
          if (HEART_LINE_RE.test(text)) {
            heart++;
            if (covered.has(ln)) heartCovered++;
            continue;
          }
          if (STATE_ASSIGN_RE.test(text)) {
            assign++;
            if (covered.has(ln)) assignCovered++;
            continue;
          }
          if (HEAD_LINE_RE.test(text)) {
            head++;
            if (covered.has(ln)) headCovered++;
            continue;
          }
          if (SIF_LINE_RE.test(text)) {
            sif++;
            if (covered.has(ln)) sifCovered++;
            continue;
          }
          const isOutput = OUTPUT_PRINT_RE.test(text);
          if (!isOutput && !FORM_PRINT_RE.test(text)) continue;
          if (isOutput) {
            output++;
            if (covered.has(ln)) outputCovered++;
          }
          if (FORM_PRINT_RE.test(text)) {
            speech++;
            if (covered.has(ln)) speechCovered++;
          }
        }
        for (const t of [total, ...(isKojo ? [kojo] : [])]) {
          t.files++;
          if (r.segments.length > 0) t.filesWithSegments++;
          t.totalLines += r.stats.totalLines;
          t.projected += r.stats.projectedLines;
          t.passthrough += r.stats.passthroughLines;
          t.native += r.stats.nativeLines;
          t.segments += r.segments.length;
          t.maxSegments = Math.max(t.maxSegments, r.segments.length);
          t.speechLines += speech;
          t.speechProjected += speechCovered;
          t.outputLines += output;
          t.outputProjected += outputCovered;
          t.sifLines += sif;
          t.sifProjected += sifCovered;
          t.headLines += head;
          t.headProjected += headCovered;
          t.assignLines += assign;
          t.assignProjected += assignCovered;
          t.heartLines += heart;
          t.heartProjected += heartCovered;
          t.dataLines += dataRows;
          t.dataProjected += dataCovered;
        }
        segBuckets[bucketOf(r.segments.length)]!++;
      }

      // eslint-disable-next-line no-console
      console.log(
        [
          '',
          '========== 糖投影真实语料读数（B 层）==========',
          `样本：${use.length} 个 ERB（全工程 ${all.length}）｜读失败 ${unreadable}`,
          line(total, '全部 ERB'),
          line(kojo, '口上目录'),
          '  保留原代码的分因：',
          ...[...reasons.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `    ${k} = ${v}`),
          '  未投影行按行首 token（前 15）：',
          ...[...nativeTokens.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 15)
            .map(([tok, v]) => `    ${tok.padEnd(18)} ${String(v.count).padStart(7)}   ${v.sample}`),
          `  单文件段数分布：≤50 ${segBuckets[0]}｜≤200 ${segBuckets[1]}｜≤500 ${segBuckets[2]}` +
            `｜≤1000 ${segBuckets[3]}｜≤2000 ${segBuckets[4]}｜≤5000 ${segBuckets[5]}｜>5000 ${segBuckets[6]}`,
          `  不变量违例：计数不平 ${unaccounted}｜段重叠/逆序 ${overlap}`,
          '=============================================',
          '',
        ].join('\n'),
      );

      // ---- 硬不变量（与样本无关，任何输入都不许破）----
      expect(unaccounted).toBe(0);
      expect(overlap).toBe(0);
      expect(unreadable).toBe(0);

      // ---- 覆盖率守门（量化提升的可回归证据）----
      //
      // 三个指标各有分工，缺一个都会掩盖一类回归：
      // - **台词行覆盖**（主指标）：读者真正要读的那类行有多少显示成了糖。
      //   它是本功能的成败线——台词读不出来，其余都是白搭。
      // - **文件覆盖**：有多少文件"打开了能看到人话"（0 命中的文件 = 按了开关没反应）。
      // - **行覆盖**（辅指标）：整份文件的人话密度，用来发现"规则被过度收紧"。
      //
      // 口径说明：行覆盖的分母是**全部行**（含函数骨架、赋值、调用、注释、空行），
      // 因此它天然低于台词行覆盖——两者不可互相替代（`docs/LIFT-REMEASURE` §三 那种
      // "6.5% 行覆盖"与这里的台词行覆盖是两把尺子）。
      expect(total.speechProjected / Math.max(1, total.speechLines)).toBeGreaterThan(0.99);
      // 实测读数（全量 2,285 文件，批 I 后）：台词行 **99.2%**（990,914/999,114）、
      // 输出行 **99.2%**（1,060,647/1,069,516）、行覆盖 **58.8%**。
      // 下限取 0.99 的依据（三个"退化后落点"都算过）：
      // - 退回"非 FORM 系 / 裸 FORM 不投影"（批 F 前）→ 输出行 92.1%（985,559/1,069,516），红；
      // - 退回"行内条件一律留原代码"（批 G 前）→ 输出行 98.7%、台词行 98.6%，两者都红。
      expect(total.outputProjected / Math.max(1, total.outputLines)).toBeGreaterThan(0.99);
      expect(total.filesWithSegments / Math.max(1, total.files)).toBeGreaterThan(0.9);
      // 行覆盖下限随能力上移：批 I 前实测 56.8%，批 I 后 **58.8%**（头成为锚点后正文并入糖段）。
      // 取 0.55——既能挡"规则被过度收紧"，撤掉批 I 也不会误红（那条回归由函数头尺子负责）。
      expect(total.projected / Math.max(1, total.totalLines)).toBeGreaterThan(0.55);
      // 口上目录是主战场，台词行要求更严
      expect(kojo.speechProjected / Math.max(1, kojo.speechLines)).toBeGreaterThan(0.99);
      expect(kojo.outputProjected / Math.max(1, kojo.outputLines)).toBeGreaterThan(0.99);
      // 批 H：`SIF 条件` + 下一行单语句 → 「如果 …：」。实测读数见上方打印（约 93%）；
      // 剩下的成就是判据**故意**挡下的：正文是开块语句 / 连写 SIF / 停用区 / 文件结束无正文。
      // 这条能力只占全语料 0.26% 的行，混在"行覆盖"里退化不掉红——所以单独一把尺子。
      expect(total.sifProjected / Math.max(1, total.sifLines)).toBeGreaterThan(0.9);
      expect(kojo.sifProjected / Math.max(1, kojo.sifLines)).toBeGreaterThan(0.9);
      // 批 I：`@M_KOJO_MESSAGE_COM_K1_310` → 「时机 指令 COM 310：」，正文缩进一级。
      // 实测（全量 2,285 文件 / 100,532 个头）：**81.2%**（81,656）。
      // 退化落点算过：撤掉批 I → **8.1%**（8,182，全是包装三联被骨架吸收的头），红。
      // 剩下 18.8% 是**故意不硬凑**的：`MESSAGECHECK` 四件套、`KOJO_*_CUSTOM_BUTTON_*`、
      // 工具/辅助函数——分野表里没有的时机就不冒充有（宁留原代码，不给错标签）。
      expect(total.headProjected / Math.max(1, total.headLines)).toBeGreaterThan(0.7);
      expect(kojo.headProjected / Math.max(1, kojo.headLines)).toBeGreaterThan(0.7);
      // 批 J：角色状态赋值行 → 中文属性写法。批 J 单独实测 **26.0%**（5,344 / 20,532）。
      // 这个数**看着小，但它才是真的**：加假阳性守卫之前是 43.8%，多出来的 3,642 行全是
      // `CFLAG:1:好感度` 被读成 `她的既成事実:好感度`（见 §5.67）。
      // 批 L 给规范 §3.8 补上「角色N的X」写法后升到 **54.8%**（11,255）——
      // 剩下的仍是**故意不标**：`CFLAG:ARG:` / `TCVAR:LOCAL:` 这类动态角色作用域糖里没有承诺写法，
      // 以及 `TEQUIP:4` 这种字典查不到名字的编号（L0 数据缺口，不编名字）。
      // 下限 0.4：撤掉批 L → 26.0% 红；撤掉批 J → 0% 红；字典接线掉断 → 红。
      expect(total.assignProjected / Math.max(1, total.assignLines)).toBeGreaterThan(0.4);
      expect(kojo.assignProjected / Math.max(1, kojo.assignLines)).toBeGreaterThan(0.4);
      // 批 K：`CALL HPH_PRINT,@"文本","模式"` → 「心形 文本」。实测 **98.0%**（65,903 / 67,282）。
      // 这是目前**最直白的台词通道**：这些行的正文本来就是要给读者看的话，不投影就等于
      // 把台词锁在指令参数里。剩下 2% 是裸变量实参 / 缺模式字母 / 表外模式（一律不动）。
      // 撤掉批 K → 0%，且段数会**涨回** 4.3 万（演出行原先都在切断糖段）。
      expect(total.heartProjected / Math.max(1, total.heartLines)).toBeGreaterThan(0.9);
      expect(kojo.heartProjected / Math.max(1, kojo.heartLines)).toBeGreaterThan(0.9);
      // 批 N：数据表条目（`DATAFORM` / `DATA`）→ 块头结构标注 + 缩进候选清单。
      // 实测 **57.4%**（10,421 / 18,154）。这个数的上限是**刻意保守**换来的：
      // 全语料 3,685 个 `PRINTDATA*` 块里只有 2,812 块是纯条目，其余 873 块含
      // `DATALIST/ENDLIST` 分组（2,380 对）——分组语义没有引擎侧权威出处，
      // 于是那 873 块的条目也**不**投影（块头与条目必须同进同退，半投影最坏）。
      // 同样刻意不声称的：`…L` / `…W` / `…K` / `…D` 变体的差别（变体词只**原样回显**在括号里，
      // 不写成"随机 / 轮流"——糖表层没有数据表写法，冒充有就是 §5.66 否证过的那类错误）。
      // 退化落点**当场实测**：摘掉批 N ⇒ 读数 **0.0%（0/18,154）**、行覆盖回落 61.0%、
      // 段数涨回 287,805（+2,259）——所以这条尺子真的会红，不是装饰。
      // 注意方向：放宽纯度判据（放过 `DATALIST` 块）只会让读数**升**，
      // 因此本尺子守的是"接线断掉"，语义保守那条由批 N 的判据单测守。
      expect(total.dataProjected / Math.max(1, total.dataLines)).toBeGreaterThan(0.5);
      expect(kojo.dataProjected / Math.max(1, kojo.dataLines)).toBeGreaterThan(0.5);

      // ---- 质量线闸：兜底形只许剩"真未知语句"（本包追加；七把尺子判据零改动）----
      // 上面那句"只许剩真未知语句"到这里才**可核查**：下面的成因归因把剩下的每一行分进一格，
      // 分不完（`attributed !== fallbackLines`）或某格吃掉整池就是规则漏了一类结构。
      /** 成因桶的全池记号直方图（跨桶合并；一行一个记号，与 `attribution` 同一份计数） */
      const fallbackTokens = new Map<string, number>();
      let attributed = 0;
      for (const k of FALLBACK_ATTRIBUTION_KEYS) {
        const rec = attribution.get(k)!;
        attributed += rec.hits;
        for (const [tok, n] of rec.tokens) fallbackTokens.set(tok, (fallbackTokens.get(tok) ?? 0) + n);
      }
      // eslint-disable-next-line no-console
      console.log(
        [
          '',
          '========== 兜底行质量线（`未识别语句 · `）==========',
          `兜底行总数：${fallbackLines}（预算 ${FALLBACK_LINE_BUDGET}）`,
          `  注释 ${fallbackClasses.comment.hits}｜空行 ${fallbackClasses.blank.hits}` +
            `｜SKIP 区 ${fallbackClasses.skip.hits}｜PRINT 族 ${fallbackClasses.print.hits}` +
            `｜@函数头 ${fallbackClasses.functionHead.hits}｜#声明 ${fallbackClasses.preprocessor.hits}`,
          ...(['comment', 'blank', 'skip', 'print', 'functionHead', 'preprocessor'] as const).flatMap((k) =>
            fallbackClasses[k].samples.length === 0
              ? []
              : [
                  `  [${k}] 前 ${fallbackClasses[k].samples.length} 条：`,
                  ...fallbackClasses[k].samples.map((x) => `    ${x}`),
                ],
          ),
          // ---- 成因归因（工包 D）：总数之外还要回答"剩下的 1.3 万行到底是什么" ----
          `  成因归因（读数 ≤ 上限；上限见 FALLBACK_CLASS_BUDGET，只降不升）：`,
          ...FALLBACK_ATTRIBUTION_KEYS.flatMap((k) => {
            const rec = attribution.get(k)!;
            const top = [...rec.tokens.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([tok, n]) => `${tok}=${n}`)
              .join(' ');
            const head = `    ${k.padEnd(14)} ${String(rec.hits).padStart(7)} ≤ ${String(
              FALLBACK_CLASS_BUDGET[k],
            ).padStart(7)}｜${top || '—'}`;
            const samples = rec.samples.slice(0, 3).map((x) => `      ${x}`);
            return [head, ...samples];
          }),
          `  兜底行按行首记号（全池前 25）：`,
          ...[...fallbackTokens.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25)
            .map(([tok, n]) => `    ${tok.padEnd(18)} ${String(n).padStart(7)}`),
          '===============================================',
          '',
        ].join('\n'),
      );
      // 归因必须**恰覆盖**每一条兜底行（一行一格；多了漏了都是分类器坏了，不是语料坏了）。
      expect(attributed, '成因归因计数与兜底行总数不平').toBe(fallbackLines);
      // 逐类棘轮：`tryNine` / `printVariant` 是**结构性 0**（判据可证），其余四格首轮按池份额钉，
      // 集成轮拿实测分格读数逐格下调（`FALLBACK_CLASS_BUDGET` 只许改小）。
      for (const k of FALLBACK_ATTRIBUTION_KEYS) {
        expect(
          attribution.get(k)!.hits,
          `兜底成因「${k}」超上限 ${FALLBACK_CLASS_BUDGET[k]}——一类已知结构没给显示形，或该桶需要拆细`,
        ).toBeLessThanOrEqual(FALLBACK_CLASS_BUDGET[k]);
      }
      // 四类**已知结构**一行都不许落进兜底：注释 / 空行 / SKIP 区 / PRINT 族。
      expect(fallbackClasses.comment.hits).toBe(0);
      expect(fallbackClasses.blank.hits).toBe(0);
      expect(fallbackClasses.skip.hits).toBe(0);
      expect(fallbackClasses.print.hits).toBe(0);
      expect(fallbackClasses.functionHead.hits).toBe(0);
      expect(fallbackClasses.preprocessor.hits).toBe(0);
      // 总量棘轮：只许降、不许升（预算 = 修完实测 ×1.1）。
      expect(fallbackLines).toBeLessThanOrEqual(FALLBACK_LINE_BUDGET);

      await kernel.stop();
    },
    180_000,
  );
});
