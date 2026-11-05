/**
 * 语法糖预览（S4 批）—— 糖源码 → 转译 → 状态回放 → **三向映射**。
 *
 * 设计要点（审阅 §1.2-2 / §1.4）：
 * - **不新建模拟器**：回放一律经注入的 `StateReplayService`（`state.replay`）；
 *   本模块只做"产物行区间 ↔ 回放结果"的**折叠**，不理解任何条件语义；
 * - **不重实现转译**：产物与源映射来自注入的 `transpile`（即本插件自己的
 *   `sugar.transpile`），此处**逐步复用**，不改写一字节；
 * - **不写盘、不发事件**：预览是纯只读观察面（`file.changed` 只消费不发射）；
 * - **降级显式**：无存档 / 无角色 / 无回放服务 / 存档坏了 → `archive: null`
 *   + 原因码，绝不抛错、绝不静默（契约 `SugarPreviewDegradeReason`）。
 *
 * 依赖注入形态与 `compile.ts` 同构：把"回放"做成可选依赖，使单测能以
 * 替身精确驱动三向映射的各条路径（含无存档降级），不必启动整个内核。
 *
 * **坐标契约（本模块最重要的前置条件）**：
 * 三向映射以**产物 ERB 的行号**为共同坐标系——`scanProductFunctions` /
 * `foldMessageBlocks` 用产物行号，`FunctionReplay.branches[].headLine` /
 * `PredicateReplay.line` 也必须是**同一份产物文本的绝对行号**。
 *
 * 生产路径（`sugar.preview` 服务）里，`state.replay` 经 `condition.extractor`
 * 的**磁盘索引**取函数体（`engine.ts` 的 `index.byName.defsOf()` + `ref.startLine`），
 * 其行号天然是**磁盘上那份 `.erb`** 的行号；而预览跑的是**未落盘**的内存产物
 * （UI 喂的是编辑器 live buffer，读盘只是首开窗口期的兜底）。`sourceMap` 只提供
 * 「产物行 ↔ 糖源行」，**没有**「磁盘旧版本行 ↔ 本次产物行」这层映射——磁盘那份是
 * 上一次落盘的旧版本，两个坐标系的对应关系在结构上不可得。
 *
 * 所以本模块**不假设**回放器给的是产物坐标，而是逐产物函数**验证**
 * （`replayAnchorsToProduct`）：起点行相同 + 每一处行引用都落在该产物函数区间内 +
 * 产物文本在该行确实是它声称的那类语句（`IF` / `ELSEIF` / `ELSE` / `SELECTCASE` /
 * `CASE` / `CASEELSE` / `SIF`）。验证不过 ⇒ 该函数的 `archive.functions[].replay`
 * 置 `null`（没有**可对照**的回放结果，warn 显式记录），其消息块折成 `unknown`
 * ——**绝不**当成"无覆盖链 ⇒ 可达"。面板据此决定要不要显示可达徽章
 * （见 `ui-sugar-preview` 的 `archiveStatus`：全不可对照时显式说"只对原代码有效"）。
 *
 * **真映射通道（2026-11-05 已接通）**：本文件把本次产物文本当
 * `ReplayFunctionOptions.textOverride` 交给回放器；抽取器的 override 分支按行首
 * `@名字` 在给定文本里重定位函数（不再借磁盘索引区间），所以回放明细的行号就是
 * **产物坐标**。路径有两处必须同时成立：①装配方把产物文本传下来（本文件负责）；
 * ②抽取器实现 override 重定位（`condition-extractor`，2026-11-05 批）。任一不成立
 * 时，下面的 `replayAnchorsToProduct` 会把对不上的明细丢成"不可对照"，绝不冒充可达。
 */

import type {
  BranchChainOutcome,
  FileIO,
  FunctionReplay,
  Logger,
  ReplayUnknown,
  StateReplayService,
  SugarPreviewArchive,
  SugarPreviewDegradeReason,
  SugarPreviewFunctionReplay,
  SugarPreviewLine,
  SugarPreviewMessageBlock,
  SugarPreviewRequest,
  SugarPreviewResult,
  SugarPreviewService,
  SugarSourceMapEntry,
  SugarTranspileResult,
} from '@kojo/plugin-api';

/** 预览依赖（实现侧注入；`kojo-sugar` 装配时提供） */
export interface PreviewDeps {
  /** 转译函数（纯逻辑；通常即本服务的 `transpile`） */
  transpile: (source: string, options?: { filePath?: string; fileName?: string }) => SugarTranspileResult;
  /**
   * 状态回放服务（`state.replay`）。**缺省 = 无回放能力**——
   * 预览仍产出"糖行 ↔ ERB 行"两向映射，`archive` 报
   * `replay-service-unavailable`（显式，不假装有状态）。
   */
  replay?: StateReplayService;
  /**
   * 内核文件 IO。**仅用于"糖源码未声明角色号"时读源文件补 front-matter**
   * ——但预览的输入本就是内存字符串，故当前实现**不读任何文件**；
   * 该依赖保留是为了让"未来从磁盘取源"的批不必改签名。
   */
  io?: FileIO;
  log?: Logger;
}

/* ============================== 产物函数扫描 ============================== */

/** 产物中的一个函数块（`@名字` 起，到下一个 `@` 行或文件尾） */
interface ProductFunction {
  name: string;
  /** 1 基起始行（`@名字` 所在行） */
  fromLine: number;
  /** 1 基结束行（闭区间；含） */
  toLine: number;
}

/**
 * 扫描产物文本，切出函数块与行号。
 *
 * 只认行首 `@`（ERB 的函数声明语法）；`@` 出现在行中（如字符串里）不算。
 * 产物是转译器生成的，形态可控——不必做容错解析。
 */
export function scanProductFunctions(erb: string): ProductFunction[] {
  return scanFunctionsOfLines(erb.split('\n'));
}

/** `scanProductFunctions` 的行数组形态（`preview()` 复用同一次 split，不重复切分产物） */
function scanFunctionsOfLines(lines: readonly string[]): ProductFunction[] {
  const out: ProductFunction[] = [];
  let current: { name: string; fromLine: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('@')) {
      if (current) {
        out.push({ name: current.name, fromLine: current.fromLine, toLine: lineNo - 1 });
      }
      current = { name: line.slice(1).trim(), fromLine: lineNo };
    }
  }
  if (current) {
    out.push({ name: current.name, fromLine: current.fromLine, toLine: lines.length });
  }
  return out;
}

/* ============================== 消息块折叠 ============================== */

/**
 * 结构行前缀表 —— 这些产物行**不承载文本**，是控制流骨架。
 * 与 `codegen.ts` 的产物形态一一对应（`IF` / `ELSE` / `ELSEIF` /
 * `ENDIF` / `SELECTCASE` / `CASE` / `CASEELSE` / `ENDSELECT` / `RETURN`）。
 *
 * 注：`CASEELSE` / `ENDSELECT` 等**必须在 `CASE` 之前判定**——否则
 * `startsWith('CASE')` 会把 `CASEELSE` 误吞（同理见下方有序匹配）。
 */
const STRUCTURAL_PREFIXES: readonly string[] = [
  'IF ',
  'ELSEIF ',
  'ELSE',
  'ENDIF',
  'SELECTCASE ',
  'CASEELSE',
  'CASE ',
  'ENDSELECT',
  'RETURN',
  '@',
];

/** 该产物行是否为结构行（不承载文本） */
export function isStructuralLine(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true; // 空行
  if (t.startsWith(';')) return true; // 注释行（包装函数骨架的 `;---`）
  if (t.startsWith('@')) return true;
  // 注意 `CASEELSE` 必须在 `CASE` 前——`STRUCTURAL_PREFIXES` 已按此排序
  for (const p of STRUCTURAL_PREFIXES) {
    if (t === p.trimEnd() || t.startsWith(p)) return true;
  }
  // `LOCAL = n` / `TFLAG:192 = n` / `SETBIT RESULT, n` / `RESULTS* = …` 是骨架赋值
  if (/^(LOCAL(?::\d+)?|TFLAG:\d+|RESULTS(?::\d+)?|FLAG:[^=]+|RESULT)\s*=/.test(t)) return true;
  // 位原语三语句（`SETBIT` / `CLEARBIT` / `INVERTBIT <目标>, <位号>`）——位糖（v1.7）产物
  // 与手写同形，都是**结构性操作**（不承载文本），不得折叠进消息块。
  if (/^(SETBIT|CLEARBIT|INVERTBIT)\s+/.test(t)) return true;
  // `CALL <单 token>`（既有函数的转发调用，如包装函数的 `CALL X_1`）是骨架；
  // 带实参的 `CALL HPH_PRINT(@"…","w")` 是文本块。判据：令牌后无 `(` 与 `,`
  // （实参一定含其一二；转发的函数名不含）。
  // 例外（规范 §3.2 `参数:` 声明，v1.5）：包装函数**逐字转发自己的形参**
  // （`CALL X_1(ARG,ARG:1)`）——实参全是 `ARG` 令牌、不含任何文本，仍是骨架；
  // 一旦实参里出现引号/表达式/其它变量就不匹配，仍按文本块走。
  if (/^CALL\s+[^\s(,]+(\(\s*ARG(?::\d+)?\s*(?:,\s*ARG(?::\d+)?\s*)*\))?$/.test(t)) return true;
  return false;
}

/**
 * 把产物行折叠成**消息块**（连续的非结构行合一）。
 *
 * 产物缩进即块结构：同一缩进层级的连续文本行属于同一块；遇到结构行或
 * 缩进变化即断开。这样 `IF` 体里的两行文本是一个块，而它的 `IF` / `ENDIF`
 * 不进块（折进 `guards`——本版直接以行区间暴露，不重复表达）。
 */
export function foldMessageBlocks(erb: string): { fromLine: number; toLine: number; text: string }[] {
  return foldProductLines(erb.split('\n')).blocks;
}

/**
 * 产物结构的**单遍**扫描：消息块 + 结构行清单一次走完。
 *
 * 为什么合并：两者都以 `isStructuralLine` 为唯一判据（结构行 = 块的断点），
 * 分开做就是**同一份产物跑两遍正则**——`isStructuralLine` 每行 6 条正则，
 * 5 万行级产物下这是可测的常数倍。合并后产物只被 `split` 一次、每行只判一次，
 * 输出与"两次分开扫"逐条相同（含末尾空尾行的 `pop` 口径）。
 */
function foldProductLines(lines: readonly string[]): {
  blocks: { fromLine: number; toLine: number; text: string }[];
  structuralLines: number[];
} {
  const blocks: { fromLine: number; toLine: number; text: string }[] = [];
  const structuralLines: number[] = [];
  let run: { fromLine: number; texts: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    if (isStructuralLine(raw)) {
      structuralLines.push(lineNo);
      if (run) {
        blocks.push({ fromLine: run.fromLine, toLine: lineNo - 1, text: run.texts.join('\n') });
        run = null;
      }
      continue;
    }
    if (!run) {
      run = { fromLine: lineNo, texts: [raw] };
    } else {
      run.texts.push(raw);
    }
  }
  if (run) {
    blocks.push({ fromLine: run.fromLine, toLine: lines.length, text: run.texts.join('\n') });
  }
  // 产物末尾的空尾行（join + '\n' 产生）不算结构行
  if (lines.length > 0 && lines[lines.length - 1] === '') structuralLines.pop();
  return { blocks, structuralLines };
}

/* ============================== 坐标可对照性（诚实降级判据） ============================== */

/**
 * 语句种类 → 产物行首关键字（验证"这一行确实是它声称的那条语句"）。
 *
 * 只认**行首**：产物缩进用 `\t` / 空格，故匹配前 `trimStart`。`ELSE` / `CASE`
 * 的判据带 `(\s|$)` 尾界，避免把 `ELSEIF` 当 `ELSE`、把 `CASEELSE` 当 `CASE`
 * （与 `STRUCTURAL_PREFIXES` 的有序匹配同一条经验）。
 */
const LINE_KEYWORD = {
  IF: /^IF(\s|$)/,
  ELSEIF: /^ELSEIF(\s|$)/,
  ELSE: /^ELSE(\s|$)/,
  CASE: /^CASE(\s|$)/,
  CASEELSE: /^CASEELSE(\s|$)/,
  SELECTCASE: /^SELECTCASE(\s|$)/,
  SIF: /^SIF(\s|$)/,
  ENDIF: /^ENDIF(\s|$)/,
  ENDSELECT: /^ENDSELECT(\s|$)/,
} as const;

/**
 * 回放明细的行号能否**锚定到本次产物**（坐标同源判据）。
 *
 * 判据（三者全中才算同源）：
 * 1. 回放器给出的函数起点行 == 产物扫描到的 `@名字` 行——起点头错位就整体错位；
 * 2. 明细引用的**每一行**（谓词行 / 链头 / 链成员 / 闭合行 / 命中行）都落在该
 *    产物函数的 `[fromLine, toLine]` 内；
 * 3. 产物文本在每一处引用上确实是它声称的那类语句。**行号落在区间里 ≠ 指着同一条
 *    语句**：磁盘旧版本的行号完全可能碰巧落在区间内的文本行上，只查区间会把
 *    "文本行"当成 `IF` 链头，于是块与链随机错配（本批要修的就是这个）。
 *
 * 不满足任一条 ⇒ 回放明细属于另一个坐标系（磁盘旧版本 / 回放器读的不是这份产物），
 * **不许**折进可达性。纯几何 + 文本判定，不做任何条件求值（求值是回放器的职责）。
 *
 * 已知边界（**故意不猜**）：同一行上的条件**文本**改了但语句种类与位置没变（如
 * `IF TFLAG:193 == 1` → `== 2`），本判据看不出——那需要回放侧按产物文本解析
 * （`ReplayFunctionOptions.textOverride`）才能根治；此时宁可保留旧结论也不做
 * 字符串启发式（多行 `{…}` 条件会把"拼接原文"误判成"文本不符"，误杀比漏放更糟）。
 */
export function replayAnchorsToProduct(
  replay: FunctionReplay,
  fn: { fromLine: number; toLine: number },
  productLines: readonly string[],
): boolean {
  if (replay.startLine !== fn.fromLine) return false;

  /** 行号在产物函数区间内时给该行原文；否则 null（越界 = 不同源） */
  const lineAt = (line: number): string | null => {
    if (!Number.isInteger(line) || line < fn.fromLine || line > fn.toLine) return null;
    return productLines[line - 1] ?? null;
  };
  const matches = (line: number, keyword: RegExp): boolean => {
    const text = lineAt(line);
    return text !== null && keyword.test(text.trimStart());
  };

  for (const p of replay.predicates) {
    if (!matches(p.line, LINE_KEYWORD[p.kind])) return false;
  }
  for (const chain of replay.branches) {
    if (!matches(chain.headLine, chain.kind === 'if-chain' ? LINE_KEYWORD.IF : LINE_KEYWORD.SELECTCASE)) {
      return false;
    }
    if (
      chain.endLine !== undefined &&
      !matches(chain.endLine, chain.kind === 'if-chain' ? LINE_KEYWORD.ENDIF : LINE_KEYWORD.ENDSELECT)
    ) {
      return false;
    }
    if (chain.takenLine !== null && lineAt(chain.takenLine) === null) return false;
    for (const m of chain.members) {
      if (!matches(m.line, LINE_KEYWORD[m.kind])) return false;
    }
  }
  return true;
}

/**
 * 「该块没有可锚定的回放结果」的显式原因（`ReplayUnknown.code = 'other'`）。
 *
 * 面板侧同一句判性文案住 `ui-sugar-preview/src/panel-logic.ts` 的 `archiveStatus`
 * （跨插件禁 import，故两处各写一遍；改文案时两处一起改）。
 */
const NO_ANCHOR_MESSAGE = '糖视图与磁盘行号不可对照：该块没有可锚定的回放结果（存档态判定只对原代码有效）';

/* ============================== 回放折叠 ============================== */

/**
 * 由覆盖某行的分支链折叠出可达性。
 *
 * **调用方须先过滤掉"信封链"**（见 `isEnvelopeChain`）——即转译器自己生成的
 * 包装守卫（`IF LOCAL`），它的谓词 `LOCAL` 是语言局部量、回放器只能报
 * `unknown('pseudo')`；若参与折叠会把**每个**块污染成 unknown，把预览变成
 * 噪声。信封链仍出现在 `branches` 里（作者可见），只是不参与可达性判定。
 *
 * **几何前提**：ERB 控制流是**线性嵌套**的（无 goto 跨块）。于是"链 C 是否
 * 覆盖行 L"可判定为：`C.headLine < L`，且 `C.headLine` 与 `L` 之间的每条链
 * 都比 C **更深**（`depth` 严格更大）——即期间开起的链都嵌在 C 体内，C 的体
 * 尚未结束。反之若有同深度或更浅的链开在其间，则 C 的体已闭合。
 *
 * 规则（纯几何 + 链走向，**不做条件求值**——求值是 `state.replay` 的职责）：
 * - 无覆盖链 → `reachable`（无条件输出）；
 * - 任一覆盖链 `unreachable` → `unreachable`（外层未进入，内层再真也不执行；
 *   该结论由回放引擎的**可达性传播**给出，本层直接采信）；
 * - 任一覆盖链 `no-match` → `unreachable`（全假且无兜底）；
 * - 任一覆盖链 `unknown` → `unknown`（带首个阻断原因）；
 * - 全部 `taken`：本块须落在**某条 taken 分支的体内**才可达——判据是
 *   "管辖本行的链成员恰为 `takenLine`"（管辖 = 本行之前最近的成员）。
 */
export function foldReachability(
  block: { fromLine: number; toLine: number },
  chains: readonly BranchChainOutcome[],
): { reachability: 'reachable' | 'unreachable' | 'unknown'; unknown?: ReplayUnknown } {
  const covering = chains.filter((c) => coversLine(c, block.fromLine, chains));

  if (covering.length === 0) return { reachability: 'reachable' };

  // 外层链不可达 → 整块不可达（可达性传播已在回放侧算好）
  if (covering.some((c) => c.outcome === 'unreachable')) return { reachability: 'unreachable' };
  // 确定落空 → 不可达
  if (covering.some((c) => c.outcome === 'no-match')) return { reachability: 'unreachable' };
  // 未知且前序未定 → unknown（取首个阻断原因）
  const unknownChain = covering.find((c) => c.outcome === 'unknown');
  if (unknownChain) {
    return { reachability: 'unknown', ...(unknownChain.unknown ? { unknown: unknownChain.unknown } : {}) };
  }

  // 全部 taken：本块须落在**每一条**覆盖链的 taken 分支体内。
  // 注意是"每一条"而非"某一条"——外层信封链（`IF LOCAL`）的 takenLine 就是
  // 它自己的头行，其体涵盖整个函数，若用"某一条"判定会**恒真**，
  // 内层 SELECTCASE 的分支归属就白算了（本批踩过的坑）。
  const taken = covering.filter((c) => c.outcome === 'taken');
  if (taken.length === 0) return { reachability: 'reachable' }; // 防御：无走向信息
  for (const c of taken) {
    if (c.takenLine === null) continue; // 无命中行信息 → 不阻断
    const owner = memberOwningLine(c, block.fromLine);
    if (owner === null || owner !== c.takenLine) return { reachability: 'unreachable' };
  }
  return { reachability: 'reachable' };
}

/**
 * 信封链判定 —— **转译器自己生成的包装守卫**，不参与可达性折叠。
 *
 * 判据（纯源映射，无任何游戏/引擎知识）：
 * - 链头产物行**无糖源归属**（`sourceMap[headLine].sourceLine === null`）——即
 *   它不是作者写下的任何东西，而是 codegen 的骨架（当前唯一实例是
 *   `IF LOCAL` 的 `LOCAL = 1/0` 记入开关）；
 * - 且链的谓词**不可判定**（`unknown`）——真能判定的信封链无需特殊对待。
 *
 * 为什么必须排除：`IF LOCAL` 的条件 `LOCAL` 是语言局部量，快照里不存在，
 * 回放器只能报 `unknown('pseudo')`。若让它参与折叠，"每个块都 unknown"，
 * 编辑器预览将失去全部信息量。作者视角里这一层也不存在（糖语义是"这段
 * 文本会输出"）——把它折进可达性属于**误报**，而非保守。
 */
export function isEnvelopeChain(
  chain: BranchChainOutcome,
  generatedLineToSource: (generatedLine: number) => number | null,
): boolean {
  if (chain.outcome !== 'unknown') return false;
  return generatedLineToSource(chain.headLine) === null;
}

/**
 * 链 C 是否覆盖行 L（线性嵌套判据，见 `foldReachability` 注）。
 */
export function coversLine(chain: BranchChainOutcome, line: number, all: readonly BranchChainOutcome[]): boolean {
  if (chain.headLine >= line) return false;
  for (const other of all) {
    if (other === chain) continue;
    if (other.headLine > chain.headLine && other.headLine < line && other.depth <= chain.depth) {
      // 期间开起了同深度或更浅的链 → C 的体已闭合，不再覆盖 L
      return false;
    }
  }
  return true;
}

/** 管辖某行的链成员行号（本行之前最近的成员）；无 → null */
function memberOwningLine(chain: BranchChainOutcome, line: number): number | null {
  let owner: number | null = null;
  for (const m of chain.members) {
    if (m.line <= line) owner = m.line;
    else break;
  }
  return owner;
}

/* ============================== 主流程 ============================== */

/**
 * 生成预览（纯逻辑 + 可选回放）。
 *
 * 步骤：
 * 1. **转译**（复用注入的 `transpile`，与 `sugar.transpile` 逐字节同源）；
 * 2. **产物侧建索引**：函数块（`scanProductFunctions`）+ 消息块（`foldMessageBlocks`）；
 * 3. **源映射反查**：由 `sourceMap` 的 `generatedLine → sourceLine` 建反向表，
 *    得每条糖源行的产物行列表；纯生成行（`sourceLine: null`）不计入任何糖行；
 * 4. **回放**（可选）：按产物函数名逐函数回放 → **逐函数验证坐标同源**
 *    （`replayAnchorsToProduct`）→ 只有可锚定的分支链才按行区间贴到块上；
 * 5. **组装**：糖源行 × 产物行 × 消息块。
 *
 * 转译诊断 `error` 时**仍然返回结果**（含空产物），由调用方按
 * `transpile.diagnostics` 决定是否渲染预览——预览不替调用方做策略。
 */
export async function preview(deps: PreviewDeps, request: SugarPreviewRequest): Promise<SugarPreviewResult> {
  const { source } = request;
  if (typeof source !== 'string') {
    throw new TypeError('预览输入必须是字符串（.kojo 源文本）');
  }

  // --- 1. 转译（复用；不重实现） ---
  const transpileOptions: { filePath?: string; fileName?: string } = {};
  if (request.filePath !== undefined) transpileOptions.filePath = request.filePath;
  if (request.fileName !== undefined) transpileOptions.fileName = request.fileName;
  const transpile = deps.transpile(source, transpileOptions);

  // --- 2. 产物侧索引（**一次 split、每行只判一次结构行**；旧形态是三次 split + 两遍 isStructuralLine） ---
  const productLines = transpile.erb.split('\n');
  const productFns = scanFunctionsOfLines(productLines);
  const folded = foldProductLines(productLines);
  const rawBlocks = folded.blocks;

  // --- 3. 源映射反查：sourceLine → generatedLines[] ---
  const bySource = new Map<number, number[]>();
  const sourceOfGenerated = new Map<number, number | null>();
  for (const entry of transpile.sourceMap) {
    sourceOfGenerated.set(entry.generatedLine, entry.sourceLine);
    if (entry.sourceLine === null) continue; // 纯生成行不归属任何糖行（不伪造映射）
    const list = bySource.get(entry.sourceLine);
    if (list) list.push(entry.generatedLine);
    else bySource.set(entry.sourceLine, [entry.generatedLine]);
  }
  const sourceLineOfGenerated = (generatedLine: number): number | null => sourceOfGenerated.get(generatedLine) ?? null;

  // 结构行清单（供 UI 过滤/折叠）——与消息块同遍产出，口径不变（末尾空尾行不算）
  const structuralLines = folded.structuralLines;

  // --- 4. 回放（可选；结构化降级 + 坐标可对照性验证） ---
  const archiveOutcome = await resolveArchive(deps, request, transpile, productFns, productLines);

  // --- 5. 组装三向映射 ---
  const lines = buildLines(
    source,
    bySource,
    rawBlocks,
    archiveOutcome.functions,
    sourceLineOfGenerated,
    archiveOutcome.archive !== null,
  );

  const result: SugarPreviewResult = {
    transpile,
    lines,
    structuralLines,
    archive: archiveOutcome.archive,
  };
  return result;
}

/** 回放解析结果（archive 为 null 时 reason 说明原因） */
interface ArchiveOutcome {
  archive: SugarPreviewArchive | null;
  /**
   * 函数名 → 回放结果（archive 为 null 时为空表）。
   *
   * `replay` 只保留**锚定到本次产物**的结果（`replayAnchorsToProduct`）：
   * 回放器按磁盘旧版本出行号时，条目仍在表里（面板据此知道"有这个函数"），
   * 但 `replay` 为 null——没有可对照的回放结果（不看这一条就会把无链演成"全部可达"）。
   */
  functions: Map<string, SugarPreviewFunctionReplay>;
  reason?: SugarPreviewDegradeReason;
}

/** 回放侧：解析角色 → 建视图 → 逐产物函数回放 → 坐标可对照性验证；任何失败 → 结构化降级 */
async function resolveArchive(
  deps: PreviewDeps,
  request: SugarPreviewRequest,
  transpile: SugarTranspileResult,
  productFns: readonly ProductFunction[],
  productLines: readonly string[],
): Promise<ArchiveOutcome> {
  const empty: ArchiveOutcome = { archive: null, functions: new Map() };

  if (!request.archivePath) {
    return { ...empty, reason: 'no-archive-requested' };
  }
  if (!deps.replay) {
    return { ...empty, reason: 'replay-service-unavailable' };
  }

  // 角色号：请求 > 糖源码 front-matter（作者写 `角色: 12` 就不必再传）
  const charNo = resolveCharacterNo(request, transpile);
  if (charNo === null) {
    return { ...empty, reason: 'no-character' };
  }

  let view;
  try {
    view = await deps.replay.createView(request.archivePath, charNo);
  } catch (err) {
    deps.log?.warn?.(
      `[sugar.preview] 存档视图创建失败，降级为无状态预览：${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...empty, reason: 'archive-unreadable' };
  }

  const functions = new Map<string, SugarPreviewFunctionReplay>();
  const names = productFns.map((f) => f.name);
  try {
    // `textOverride: transpile.erb`：让回放器**按本次产物文本**解析（抽取器的 override
    // 分支已按行首 `@NAME` 在给定文本里重定位函数、坐标即产物坐标，见 2026-11-05 批）——
    // 这是「产物坐标回放」的真映射通道；拿不到产物文本时退回磁盘语义。
    // 无论哪条路，下面仍逐函数做 `replayAnchorsToProduct` 验证：坐标对不上照样丢弃。
    const replayOpts = {
      ...(request.callContext ? { callContext: request.callContext } : {}),
      textOverride: transpile.erb,
    };
    const results = await deps.replay.replayFunctions(view, names, replayOpts);
    for (let i = 0; i < productFns.length; i++) {
      const fn = productFns[i]!;
      const replay: FunctionReplay | null = results[i] ?? null;
      const anchored = replay !== null && replayAnchorsToProduct(replay, fn, productLines);
      if (replay !== null && !anchored) {
        // 内核铁律：不静默。落在另一个坐标系的明细一律丢弃（否则块与链随机错配）。
        deps.log?.warn?.(
          `[sugar.preview] 回放行号与产物不可对照，按无回放处理：${fn.name}（回放起点 L${replay.startLine} / 产物起点 L${fn.fromLine}）`,
        );
      }
      functions.set(fn.name, {
        functionName: fn.name,
        fromLine: fn.fromLine,
        toLine: fn.toLine,
        replay: anchored ? replay : null,
      });
    }
  } catch (err) {
    deps.log?.warn?.(
      `[sugar.preview] 函数回放失败，降级为无状态预览：${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...empty, reason: 'replay-failed' };
  }

  return {
    archive: {
      archivePath: request.archivePath,
      characterNo: charNo,
      characterName: view.characterName,
      functions: [...functions.values()],
    },
    functions,
  };
}

/**
 * 定位角色号：请求显式给了就用；否则读转译结果上的 `charNo`（文件头 `角色:` 原文，
 * additive 契约字段）。都拿不到 → null（降级 `no-character`）。
 *
 * 不再从产物骨架里正则反推 `_K(\d+)`：那是 adapter 的**命名惯例**，不是转译契约
 * （游戏无关插件不该知道它），且旧正则在 `_K58_` 这类"数字后紧跟下划线"的头上
 * 因 `\b` 失配，`archive` 恒为 null。
 */
function resolveCharacterNo(request: SugarPreviewRequest, transpile: SugarTranspileResult): number | null {
  if (typeof request.characterNo === 'number' && Number.isFinite(request.characterNo)) {
    return request.characterNo;
  }
  const raw = transpile.charNo?.trim();
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 组装三向映射（糖源行主键）。
 *
 * `hasArchive`：本次请求是否真的拿到了存档（`archive !== null`）。它决定"没有可对照
 * 回放结果"的块该怎么表达：
 * - 无存档（`false`）：折法维持旧语义（无覆盖链 → `reachable`），面板用
 *   `withReachability=false` 不显示徽章——"没有状态"是合法输入；
 * - **有存档但该块没有可锚定结果**（`true` 且 `replay === null`）：折成 `unknown`
 *   + 显式原因。若照旧折 `reachable`，"存档已接入但没有任何链"就会被演成
 *   **全部块可达**（本批要修的假象）。
 */
function buildLines(
  source: string,
  bySource: Map<number, number[]>,
  rawBlocks: readonly { fromLine: number; toLine: number; text: string }[],
  functions: Map<string, SugarPreviewFunctionReplay>,
  sourceLineOfGenerated: (generatedLine: number) => number | null,
  hasArchive: boolean,
): SugarPreviewLine[] {
  const srcLines = source.split('\n');
  // 源末尾若有换行，split 会产生一个空尾元素——那不是真实的"行"
  if (srcLines.length > 0 && srcLines[srcLines.length - 1] === '') srcLines.pop();

  // 每条产物行 → 所属函数（行区间查找；函数块数少，线性扫足够）
  const fnList = [...functions.values()];
  const functionOf = (line: number): SugarPreviewFunctionReplay | undefined =>
    fnList.find((f) => line >= f.fromLine && line <= f.toLine);

  // 消息块 → 归属源行（**反查一遍**，取代旧形态「每条源行线性扫全部块」的 O(源行 × 块数)）。
  //
  // 旧循环：外层每条源行 i、内层遍历**全部** rawBlocks 判 `hit`——大文件（数万行 × 数千块）
  // 就是数十万次判等，且同一个块每被一条源行命中就**重新构造一遍** block 对象（而 block 的
  // 内容只由 blk+fn 决定，与源行无关，纯属重复劳动）。
  // 新循环：块区间 [fromLine,toLine] 互不重叠（`foldMessageBlocks` 的产物是结构行之间的
  // 极大连续段），对每个块只走一遍它覆盖的产物行、经 `sourceLineOfGenerated` 反查归属源行，
  // block 构造一次挂给所有归属行 ⇒ 总代价 = O(产物行数 + 块数 × 链数)，与源行数无关。
  //
  // 归属集合与旧 `hit` **等价**：源行 i 命中块 ⟺ i 拥有落在 [from,to] 内的某产物行
  // ⟺ i ∈ { sourceLineOfGenerated(g) : g∈[from,to] }。块的**内容**也逐字不变。
  // 同一 block 对象被多个源行共享引用是安全的——下游（可达性计数、渲染）只读不写。
  const blocksBySource = new Map<number, SugarPreviewMessageBlock[]>();
  for (const blk of rawBlocks) {
    const owners = new Set<number>();
    for (let g = blk.fromLine; g <= blk.toLine; g++) {
      const s = sourceLineOfGenerated(g);
      if (s !== null) owners.add(s);
    }
    if (owners.size === 0) continue;
    const fn = functionOf(blk.fromLine);
    const replay = fn?.replay ?? null;

    // 有存档但这个块没有**可锚定**的回放结果（函数不在磁盘索引 / 明细落在另一个
    // 坐标系 / 回放器没给）→ 不可判定。绝不落进 fold 的"无覆盖链 ⇒ reachable"。
    if (hasArchive && replay === null) {
      const block: SugarPreviewMessageBlock = {
        fromLine: blk.fromLine,
        toLine: blk.toLine,
        text: blk.text,
        branches: [],
        reachability: 'unknown',
        unknown: { code: 'other', message: NO_ANCHOR_MESSAGE },
      };
      if (fn) block.functionName = fn.functionName;
      for (const s of owners) {
        const list = blocksBySource.get(s);
        if (list) list.push(block);
        else blocksBySource.set(s, [block]);
      }
      continue;
    }

    const fnBranches = replay?.branches ?? [];
    // 信封链（`IF LOCAL` 等转译器骨架守卫）不参与可达性折叠，但仍列出
    const authorChains = fnBranches.filter((c) => !isEnvelopeChain(c, sourceLineOfGenerated));
    const chains = fnBranches.filter((c) => coversLine(c, blk.fromLine, authorChains));
    const folded = foldReachability(blk, authorChains);
    const block: SugarPreviewMessageBlock = {
      fromLine: blk.fromLine,
      toLine: blk.toLine,
      text: blk.text,
      branches: chains,
      reachability: folded.reachability,
    };
    if (fn) block.functionName = fn.functionName;
    if (folded.unknown) block.unknown = folded.unknown;
    for (const s of owners) {
      const list = blocksBySource.get(s);
      if (list) list.push(block);
      else blocksBySource.set(s, [block]);
    }
  }

  const out: SugarPreviewLine[] = [];
  for (let i = 0; i < srcLines.length; i++) {
    const sourceLine = i + 1;
    const generatedLines = bySource.get(sourceLine) ?? [];
    const messageBlocks = blocksBySource.get(sourceLine) ?? [];
    // rawBlocks 升序 ⇒ 挂进去本就按 fromLine 递增；保留一次排序与旧实现逐字同口径（防御乱序）。
    if (messageBlocks.length > 1) messageBlocks.sort((a, b) => a.fromLine - b.fromLine);
    out.push({ sourceLine, sourceText: srcLines[i]!, generatedLines, messageBlocks });
  }
  return out;
}

/** 装配预览服务（`kojo-sugar` 的 `index.ts` 调用） */
export function createSugarPreviewService(deps: PreviewDeps): SugarPreviewService {
  return {
    preview: (request: SugarPreviewRequest) => preview(deps, request),
  };
}

/** 供测试与装配复用：源映射条目 → 源行（便捷反查） */
export function sourceLinesOf(sourceMap: readonly SugarSourceMapEntry[]): Map<number, number[]> {
  const bySource = new Map<number, number[]>();
  for (const e of sourceMap) {
    if (e.sourceLine === null) continue;
    const list = bySource.get(e.sourceLine);
    if (list) list.push(e.generatedLine);
    else bySource.set(e.sourceLine, [e.generatedLine]);
  }
  return bySource;
}
