/**
 * tree-sitter 结构解析 perf 的**共用口径**（父进程与子进程同一份，保证两侧文档逐字相等）。
 *
 * ## 为什么要有这份文件
 *
 * `tests/tree-sitter-parse.perf.test.ts` 打的是生产引擎（`src/monaco/tree-sitter/engine.ts`），
 * 而 web-tree-sitter 0.27 + Node 24（Windows）在**同一进程里解过一篇大档之后，进程退出时必定
 * 触发 V8 `Fatal process out of memory: Zone` 中止**（实测：连只解一轮的子进程也炸，rc=0x80000003；
 * 只 `init()` 不解则干净退出 rc=0）。父进程（vitest fork）一旦亲自解过档，收尾就会把整条池子报成
 * `Worker exited unexpectedly`。⇒ 全部 wasm 工作搬进子进程，父进程只收 stdout 的 JSON 判据，
 * 这正是仓库里 `packages/kojo-syntax-tree/tools/parse-corpus.mjs` 已经采纳的那条例矩。
 *
 * 文档必须由两侧各自生成同一份（父进程要算 `doc.length` 与编辑、子进程要真的解它），
 * 所以合成语料与拆进程计划放在这里，不放测试文件里，避免两份抄本漂。
 * 本文件是**纯字符串算术**：不 import 引擎、不碰 wasm。
 */

/**
 * 5,000 行合成 `.kojo`：块头 / 更深正文 / 台词 / 旁白 / 注释 / 原生直通混着来，
 * 词形取自 `packages/plugins/kojo-sugar/tests/goldens/corpus-k12-*.kojo` 与
 * `fixtures/sugar/teaching-full.kojo` 的同族写法（**取写法不取语料本体**：语料目录名会变、
 * 也可能整目录暂离，perf 基线不许依赖它在位）。
 */
export const SYNTHETIC_LINES: readonly string[] = [
  '时机 指令 300 成否: 游戏判定：',
  '\t如果 CFLAG:ブチギレ == 1：',
  '\t\t随机：',
  '\t\t\tPRINTFORMW 「就算是%CALLNAME:MASTER%也不能原谅啊ー」',
  '\t\t\t「现在不想说话啊ー？」',
  '\t\t\t「笨ー蛋！略略略！」',
  '\t\t否则：',
  '\t\t\t「……哼」',
  '\t\t\t「肚子饿了啊ー」',
  '\t否则如果 TCVAR:302 || TFLAG:193 < 0：',
  '\t\t「能不能聊点别的？」',
  '\t\t「真无ー聊」',
  '\t\t等待',
  '\t结束',
  ';这里是注释行，作者拿来分节',
  '着色 0xFF8080：',
  '\t「这句用作者色」',
  '结束',
  '心形 「还想做……舒服ー的事……HPH」 续',
  '空行',
  '隐藏情景: 如果 她的诶嘿嘿 == 0',
  'PRINTFORMW 她的呼吸乱了半拍。',
  '$NATIVE_DIRECTIVE_LINE',
];

export const DOC_LINES = 5_000;

/** 造合成档（默认 5,000 行 ≈ 74,575 个 UTF-16 码元） */
export function syntheticDoc(lines = DOC_LINES): string {
  const out = ['角色: 12', '旁白色: 作者色', ';perf 合成语料（结构解析增量基线）', ''];
  for (let i = 0; out.length < lines; i++) out.push(SYNTHETIC_LINES[i % SYNTHETIC_LINES.length]!);
  return `${out.slice(0, lines).join('\n')}\n`;
}

/** 行首偏移表（造编辑用，与被测代码无关） */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/* --------------------------- 代理对小档（判据 ③） --------------------------- */

/** 含 emoji（astral 码点）的小档：码元数 > 码点数，偏移口径一漂就红 */
export function surrogateDoc(): string {
  return [
    '角色: 12',
    '旁白色: 作者色',
    '时机 指令 300 成否: 游戏判定：',
    '\t如果 她的诶嘿嘿 😀 == 1：',
    '\t\tPRINTFORMW 「第一行台词 🎵 带代理对」',
    '\t\t「第二行 🈴」',
    '\t否则：',
    '\t\t「第三行 😇」',
    '结束',
    ';注释里也有一枚 😀',
  ].join('\n');
}

/** 把第一枚代理对换成另一枚（等宽替换 ⇒ 编辑点之后每一格偏移都该照旧对齐） */
export function surrogateNextDoc(doc: string): string {
  const at = doc.indexOf('😀');
  return `${doc.slice(0, at)}🙂${doc.slice(at + 2)}`;
}

/* ----------------------------- 拆进程计划 ----------------------------- */

/**
 * 冷全量解：**5 个子进程 × (2 轮预热 + 4 轮计量)** ⇒ 样本数仍是 `COLD_RUNS = 20`。
 * 每子进程 6 次整篇解 ⇒ 原生 RSS 峰值实测 ≈ 0.9 GB（单次整篇解在 Windows 上抬 ~150 MB 且不还给
 * OS，见本文件头注）；轮数再加就是把峰值线性推高，要改这里先想清楚机器扛不扛得住。
 * 预热丢 2 轮：子进程内读数一路走低（实测 113 → 55 → 54 → 64 → 60 → 54 ms），只丢首轮会把
 * 还在预热的轮灌进 p50；代价是本池绝对值仍比"同一台引擎连解 20 轮"的长进程略高（~10%），
 * **增量 vs 全量那条比值判据不受影响**（两条腿同一条预热纪律）。
 */
export const COLD_CHILDREN = 5;
export const COLD_WARM_ROUNDS = 2;
export const COLD_SAMPLES_PER_CHILD = 4;
export const COLD_RUNS = COLD_CHILDREN * COLD_SAMPLES_PER_CHILD;

/**
 * 单击键增量：**4 个子进程 × (1 次整篇打底 + 2 次预热击键 + 3 次计量击键)** ⇒ 样本数仍是 `EDIT_RUNS = 12`。
 * 每子进程 6 次解（1 整篇 + 5 次带旧树的增量）⇒ 原生 RSS 峰值同样 ≈ 0.85 GB 量级。
 */
export const EDIT_CHILDREN = 4;
export const EDIT_WARM_EDITS = 2;
export const EDIT_SAMPLES_PER_CHILD = 3;
export const EDIT_RUNS = EDIT_CHILDREN * EDIT_SAMPLES_PER_CHILD;

/** 单击键判据（判据 ②）改的那一行（0 基） */
export const SINGLE_EDIT_ROW = 1200;

/**
 * 判据 ② 里"先空跑一击键"落在哪一行（0 基）：**紧贴被测那一击下方两行**。
 *
 * 实测两件事：① 整篇解之后的**第一次**带旧树重解必然从头重扫（reads ≈ 19–20、窗口 = 全文），
 * 从第二次击键起才是真局部（reads = 1–2）⇒ 局部性判据钉在稳定态那一击，首击读数另行打印不藏；
 * ② 上一击留下的脏区还会被下一击扫一眼（`readEnd` 会伸到那一行附近）⇒ 预热击键必须落在
 * 被测行**附近**，否则窗口里混进来的是"上次改动的位置"而不是"本次改动的局部"。
 */
export const WARM_EDIT_ROW = SINGLE_EDIT_ROW + 2;

/** 把第 `row` 行整行换成一条注释（判据 ② 用的那一处改动；两侧共用，免得父子算出两个 nextDoc） */
export function nextDocAfterLineReplace(doc: string, row: number): string {
  const starts = lineStarts(doc);
  const at = starts[row]!;
  return `${doc.slice(0, at)}// 改了这一行\n${doc.slice(starts[row + 1]!)}`;
}

/** 在第 `row` 行行首插一个字符（判据 ④ 的击键流；一子进程内反复用同一条公式推进文本） */
export function nextDocAfterInsert(doc: string, row: number): string {
  const at = lineStarts(doc)[row]!;
  return `${doc.slice(0, at)}X${doc.slice(at)}`;
}

/** 增量循环里第 `globalRun` 次击键落在哪一行（与拆进程前同一条公式，保证改动形状不变） */
export function editRowFor(globalRun: number, starts: readonly number[]): number {
  return 50 + ((globalRun * 173) % (starts.length - 80));
}

/** 无旧树回落那一条用的 200 行小档 */
export const FALLBACK_DOC_LINES = 200;

/* --------------------------- 击键流对账（判据 ⑥） --------------------------- */

/**
 * 击键流对账用的档长与击键数。
 *
 * 为什么是这个数：对账要**每击键**拿"增量结果"与"整篇重算结果"逐字比一次 ⇒ 一台引擎走增量、
 * 另一台每击键整篇重解（真值只能是整篇那一条路）。每次整篇重解都要在 wasm 侧留一块还不还给
 * 操作系统的原生高水位（本文件头注那条事实），400 行 × 24 击 ≈ 两次解/击 ⇒ 单批峰值实测
 * 与 `edit-batch` 那几批同量级（读数由子进程回传，`memory.peakRssMb`）。再往上加请先看那个数。
 */
export const STREAM_DOC_LINES = 400;
export const STREAM_EDITS = 24;

/**
 * 带**真残缺**的合成档（击键流对账用）：合成语料本身写得很干净 ⇒ 残缺那一面在干净档上
 * 永远是空数组，"增量 == 整篇"比的是空气。这里照作者真实的两种写坏法钉进去：
 * 没收束词的块（`循环：` 没有 `循环结束`）与没合上的台词引号（`「` 光杆）。
 * 两侧各自生成同一份 ⇒ 与 `syntheticDoc` 同一条"取写法不取语料本体"的纪律。
 */
export function brokenDoc(lines = STREAM_DOC_LINES): string {
  const base = syntheticDoc(lines);
  const starts = lineStarts(base);
  // ① 第 60 行整行换成一条没有收束词的块头（MISSING 会插到回缩点那一行）
  let out = `${base.slice(0, starts[60]!)}\t\t循环：\n${base.slice(starts[61]!)}`;
  // ② 第 210 行换成一条没合上引号的台词（ERROR 落自己那一行）
  const starts2 = lineStarts(out);
  out = `${out.slice(0, starts2[210]!)}\t\t「这句的引号没合上\n${out.slice(starts2[211]!)}`;
  // ③ 文末再来一条没收盘的块（残缺点 = 文件末，块头行与残缺点隔最远 ⇒ 平移判据最吃紧）
  out = `${out}\t循环：\n\t\t「还在开着的那句」\n`;
  return out;
}

/** 击键流里第 `step` 击改哪儿、怎么改（形状覆盖：换行 / 插字符 / 插行 / 删行 / 补收束 / 粘一段 / 改文末） */
export const STREAM_EDIT_KINDS = [
  'replace',
  'insertChar',
  'insertLine',
  'deleteLine',
  'closeBlock',
  'unclosedBlock',
  'paste',
  'tail',
] as const;

export type StreamEditKind = (typeof STREAM_EDIT_KINDS)[number];

/** 第 `step` 击的形状与落点（0 基行号；落点刻意压到档首、档尾与两处残缺附近） */
export function streamEditAt(step: number, lineCount: number): { kind: StreamEditKind; row: number } {
  const kind = STREAM_EDIT_KINDS[step % STREAM_EDIT_KINDS.length]!;
  const last = Math.max(4, lineCount - 3);
  const raw = 2 + ((step * 137) % (last - 4));
  if (step < 4) return { kind, row: [1, last - 2, 60, 210][step]! };
  return { kind, row: Math.min(last - 2, raw) };
}

/** 按第 `step` 击的形状算出下一版文本（纯字符串算术，父子共用同一条公式） */
export function nextDocForStreamEdit(doc: string, step: number): string {
  const { kind, row } = streamEditAt(step, lineStarts(doc).length - 1);
  const starts = lineStarts(doc);
  const at = starts[Math.min(row, starts.length - 2)]!;
  const next = starts[Math.min(row + 1, starts.length - 1)]!;
  switch (kind) {
    case 'replace':
      return `${doc.slice(0, at)}; 改了这一行 ${step}\n${doc.slice(next)}`;
    case 'insertChar':
      return `${doc.slice(0, at)}X${doc.slice(at)}`;
    case 'insertLine':
      return `${doc.slice(0, at)}\t\t「插入的一行台词」\n${doc.slice(at)}`;
    case 'deleteLine':
      return `${doc.slice(0, at)}${doc.slice(next)}`;
    case 'closeBlock':
      return `${doc.slice(0, at)}\t\t循环结束\n${doc.slice(next)}`;
    case 'unclosedBlock':
      return `${doc.slice(0, at)}\t\t循环：\n${doc.slice(next)}`;
    case 'paste': {
      const blob = Array.from({ length: 12 }, (_unused, i) => `\t\t「粘贴第 ${i} 句」`).join('\n');
      return `${doc.slice(0, at)}${blob}\n${doc.slice(at)}`;
    }
    case 'tail':
      return `${doc.slice(0, doc.lastIndexOf('\n'))}\n; 文末改一次 ${step}\n`;
  }
}

/* ------------------------------ 子进程契约 ------------------------------ */

/** 一次解的计量样本（`ms` = parse + 查询 + 回话的墙钟） */
export interface PerfSample {
  readonly ms: number;
  readonly reads: number;
  readonly readStart: number;
  readonly readEnd: number;
  readonly editStart: number;
  readonly editEnd: number;
  readonly documentLength: number;
  readonly incremental: boolean;
  readonly tokenCount: number;
  /** 查询侧读数：这一趟三面走的是窗口还是整篇（见 `engine.ts` 的 `StructureParseStat`） */
  readonly queryScope: 'window' | 'full' | 'none';
  /** 窗口里重查了几枚顶层节点（整篇重算 = 0） */
  readonly windowNodes: number;
  /** 旧树报回来的改动段数（没问 = -1） */
  readonly changedRanges: number;
  /** 没走窗口时的理由（走窗口 = 空串） */
  readonly queryFullReason: string;
}

/** 分腿均值（只有子进程挂了 `trace` 才有；单位 ms，按计量轮次平均） */
export type PerfLegs = Partial<Record<
  'parse' | 'changedRanges' | 'semanticQuery' | 'foldsQuery' | 'indentQuery' | 'syntaxScan',
  number
>>;

/** 击键流对账的一击结果（增量 vs 整篇逐字比较，只在不等价时带差异样本） */
export interface StreamEditRecord {
  readonly step: number;
  readonly kind: string;
  readonly row: number;
  readonly deltaRows: number;
  readonly queryScope: 'window' | 'full' | 'none';
  readonly windowNodes: number;
  readonly changedRanges: number;
  readonly tokens: number;
  readonly folds: number;
  readonly faults: number;
  /** 三面是否与整篇重算逐字相等（`null` = 相等；字符串 = 不等价面的第一条差异说明） */
  readonly mismatch: string | null;
}

/** 一次解的计量样本（父进程按此判据；额外字段按场景给） */
export interface ChildMemory {
  readonly peakRssMb: number;
  readonly peakHeapMb: number;
  readonly externalMb: number;
}

/** 子进程 stdout 那一行 JSON 的形状（父进程按此判据；额外字段按场景给） */
export interface ChildResult {
  readonly scenario: string;
  readonly batch: number;
  readonly readChunk: number;
  readonly docLength: number;
  readonly samples: readonly PerfSample[];
  readonly emitted: string;
  readonly emittedRealigned?: string;
  /** 引擎实际在跑的面（`StructureEngine.capabilities`，不是宿主抄的清单） */
  readonly capabilities?: readonly string[];
  readonly legs?: PerfLegs;
  readonly tokens: readonly unknown[] | null;
  readonly tokensRealigned: readonly unknown[] | null;
  readonly folds?: readonly unknown[] | null;
  readonly foldsRealigned?: readonly unknown[] | null;
  readonly faults?: readonly unknown[] | null;
  readonly faultsRealigned?: readonly unknown[] | null;
  readonly baselineCount?: number;
  readonly baselineFolds?: number;
  readonly baselineFaults?: number;
  readonly nextDocLength?: number;
  readonly preInitReplies: number;
  readonly preInitStat?: unknown;
  readonly coldStat: PerfSample | null;
  readonly changedStat: PerfSample | null;
  /** 击键流对账：每一击一条记录（判据 = `mismatch` 全 null） */
  readonly stream?: readonly StreamEditRecord[];
  readonly fatal: readonly unknown[];
  readonly memory: ChildMemory;
  readonly error: string | null;
}
