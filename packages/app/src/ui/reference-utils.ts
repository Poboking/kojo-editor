import type { EditorSymbolLocation, ErbReference, ErbReferenceKind } from '@kojo/plugin-api';
import { MODEL_TOKEN_CLASS, splitModelLines } from '@kojo/plugin-api';

/**
 * **出现点台账**（W8 XLANG-RENAME，2026-10-17）——改名 / 查找引用 / code-lens /
 * 调用层级 / 全部替换共用的**一份**"名字的一次出现"数据结构与**一条**落盘通道。
 *
 * ## 它收的是哪三处断层
 *
 * 1. **口径断层**：`.erb` 反向索引带 `kind`（definition / call / mention），
 *    `find-references` 过去把它抹平成"文件:行:列"，调用层级面板另按 `kind === 'call'`
 *    数一遍，code-lens 第三遍——同一个名字的"N 处"在三处是三个数，没人解释差值。
 *    本模块把分类**留在台账上**（`ReferenceOccurrence.kind`），F12 计数与面板计数
 *    由**同一份** `tallyReferenceOccurrences` 导出，差值由 `explainReferenceCounts`
 *    写成一句话（`总数 = 定义 + 调用 + 提及 + 未分类`；「被调用」面板取 `nonDefinitionCount`
 *    （非定义位全集），CALL 直系族子集取 `callSiteCount`——两个读数从此同源）。
 * 2. **写通道断层**：`erb-rename` 有"已开 model 进 WorkspaceEdit / 未开文件走内核 io
 *    读改写 + 只读全或无"这套送达纪律，搜索面板的「全部替换」自己写了一份近乎同形的
 *    读改写与只读计数——两份代码、两套"只读未纳入"文案，改完名再搜仍见残留时
 *    无人能确定两边说的是同一个文件集。本模块收口成 `planReferenceWrites`
 *    （分组 + 写权限闸门）与 `rewriteClosedFile`（读 → 现文本改写 → 有实改才写回）
 *    两条纯函数，rename 与替换**都只经由它们落盘**。
 * 3. **跨语言断层**：`.erb` 侧全项目改名碰不到生成它的 `.kojo` 源，下一次保存 `.kojo`
 *    就把改名冲掉（数据损坏级）。台账因此带 `language` 轴，`.kojo` 的出现点与
 *    `.erb` 的进**同一份计划、同一次全或无判定**（判定细节在 `monaco/erb-rename.ts`：
 *    可证明的记号一起改，不可证明的整批拒绝）。
 *
 * ## 分层纪律
 *
 * 纯函数、零 Monaco、零 io 依赖（io 由调用方以最小接口注入），node 单测直接跑。
 * **不抄糖语法**：`.kojo` 源里"哪一处记号真的是这个函数的引用"由糖线探针判
 * （`kojo-sugar/rename.ts`，经 `ui.editor.languageService` 槽消费）；本模块只回答
 * "这一串字符是不是这个名字"——记号字符集用契约层单源 `MODEL_TOKEN_CLASS`，
 * 与反向索引 / 着色落点同一把尺子。
 */

/* ============================== 语言轴 ============================== */

/** 台账的语言轴（只有两值：原生方言面与语法糖源面；宿主不认识任何具体游戏方言） */
export type ReferenceLanguage = 'erb' | 'kojo';

/** `.kojo` 源扩展名（跨游戏共享术语，与 `ui/editor-model-pool` 的选语言判据同值） */
export const KOJO_SOURCE_EXTENSION = '.kojo';

/** 是否是 `.kojo` 源文件（宿主各处唯一判据，指回这里） */
export function isKojoSourcePath(path: string): boolean {
  return path.toLowerCase().endsWith(KOJO_SOURCE_EXTENSION);
}

/** 路径属于台账的哪一侧（`.kojo` = 糖源，其余按方言面） */
export function languageOfPath(path: string): ReferenceLanguage {
  return isKojoSourcePath(path) ? 'kojo' : 'erb';
}

/* ============================== 台账本体 ============================== */

/**
 * 名字的一处出现（1 基行列；`endColumn` 不含端点——与 `ErbReference` 同口径）。
 * `kind` **可选**：供方没给分类就是没给（计数时进 `unclassified` 桶，
 * **不猜成 call**，「被调用」面板才不会虚高，也不把旧消费方的读数改掉）。
 */
export interface ReferenceOccurrence {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  readonly kind?: ErbReferenceKind;
  readonly language: ReferenceLanguage;
}

/** 位置键：文件 + 行 + 列（同一位置的两次上报是一条出现，不是两条） */
function occurrenceKey(o: { filePath: string; line: number; column: number }): string {
  return o.filePath + '\u0000' + o.line + '\u0000' + o.column;
}

/** 分类具体度：同一位置被多方上报时留最具体的那个（定义 > 调用 > 提及 > 未分类） */
const KIND_SPECIFICITY: Record<ErbReferenceKind, number> = { definition: 2, call: 1, mention: 0 };
const specificityOf = (kind: ErbReferenceKind | undefined): number =>
  kind === undefined ? -1 : KIND_SPECIFICITY[kind];

/** `a` 是否比 `b` 更具体（未分类最弱）——同一位置多方上报时的取胜判据（单源在此） */
export function isMoreSpecificKind(a: ErbReferenceKind | undefined, b: ErbReferenceKind | undefined): boolean {
  return specificityOf(a) > specificityOf(b);
}

/** 出现点的位置键（跨模块去重用同一把尺子：文件 + 行 + 列） */
export function occurrencePositionKey(o: { filePath: string; line: number; column: number }): string {
  return occurrenceKey(o);
}

/** 反向索引的出现点 → 台账（`.erb` 侧唯一入口；`kind` 原样带过来，不抹平） */
export function erbOccurrences(refs: readonly ErbReference[]): ReferenceOccurrence[] {
  return refs.map((ref) => ({ ...ref, language: languageOfPath(ref.filePath) }));
}

/**
 * 槽给出的位置 → 台账（跨语言腿的唯一入口）。
 * `nameLength` 决定 `endColumn`（= column + 名字长度，与反向索引同一条派生纪律：
 * 契约位置不带 endColumn，落点区间由"这一串就是这个名字"这一事实派生）。
 */
export function occurrencesFromLocations(
  locations: readonly EditorSymbolLocation[],
  nameLength = 0,
): ReferenceOccurrence[] {
  const out: ReferenceOccurrence[] = [];
  for (const location of locations) {
    if (!Number.isFinite(location.line) || location.line < 1) continue;
    const column = location.column ?? 1;
    out.push({
      filePath: location.filePath,
      line: location.line,
      column,
      endColumn: column + nameLength,
      ...(location.kind !== undefined ? { kind: location.kind } : {}),
      language: languageOfPath(location.filePath),
    });
  }
  return out;
}

/**
 * 台账合并（**幂等、顺序确定**）：按位置去重，同位取最具体分类；
 * 先入组在前（调用方按"本语言索引 → 跨语言槽"的顺序递表）。
 */
export function mergeOccurrences(
  lists: readonly (readonly ReferenceOccurrence[])[],
): ReferenceOccurrence[] {
  const byKey = new Map<string, ReferenceOccurrence>();
  for (const list of lists) {
    for (const occ of list) {
      const key = occurrenceKey(occ);
      const kept = byKey.get(key);
      if (kept === undefined || specificityOf(occ.kind) > specificityOf(kept.kind)) {
        byKey.set(key, occ);
      }
    }
  }
  return [...byKey.values()];
}

/** 台账 → 契约位置（`find-references` 出口；`kind` 只在供方给过时原样带回，旧消费方零改动） */
export function occurrencesToLocations(
  occs: readonly ReferenceOccurrence[],
): EditorSymbolLocation[] {
  return occs.map((occ) => ({
    filePath: occ.filePath,
    line: occ.line,
    column: occ.column,
    ...(occ.kind !== undefined ? { kind: occ.kind } : {}),
  }));
}

/* ============================== 计数口径（差值可解释） ============================== */

/** 一份台账的**全部**计数口径（F12 与面板都从这里读数，不再各数各的） */
export interface ReferenceTally {
  readonly total: number;
  readonly definition: number;
  readonly call: number;
  readonly mention: number;
  /** 供方没给分类的出现点（跨语言槽的旧形态；单列一桶，不混进 `mention` 也不混进 `call`） */
  readonly unclassified: number;
  /** F12 / Peek 的口径：全部出现点 */
  readonly f12Count: number;
  /** 「被调用」面板口径：只有 `kind === 'call'`（CALL 直系族名字槽） */
  readonly callSiteCount: number;
  /**
   * 「被调用」**非定义位**口径：定义以外的一切出现点（call + mention + unclassified）。
   * 调用层级面板的入边集就是这一投影（`erb-call-hierarchy.incomingCalls` 只剔 `definition`）——
   * 面板要读数就取这里，**不许再自己数一遍**（那是 W8 要收口的第二判据）。
   */
  readonly nonDefinitionCount: number;
  /** 两者的差（= 定义 + 提及 + 未分类，一句话可解释） */
  readonly gap: number;
  readonly erbCount: number;
  readonly kojoCount: number;
  readonly files: number;
}

/** 按台账算计数（纯函数） */
export function tallyReferenceOccurrences(occs: readonly ReferenceOccurrence[]): ReferenceTally {
  let definition = 0;
  let call = 0;
  let mention = 0;
  let unclassified = 0;
  let erbCount = 0;
  let kojoCount = 0;
  const files = new Set<string>();
  for (const occ of occs) {
    if (occ.kind === 'definition') definition++;
    else if (occ.kind === 'call') call++;
    else if (occ.kind === 'mention') mention++;
    else unclassified++;
    if (occ.language === 'kojo') kojoCount++;
    else erbCount++;
    files.add(occ.filePath);
  }
  const total = occs.length;
  return {
    total,
    definition,
    call,
    mention,
    unclassified,
    f12Count: total,
    callSiteCount: call,
    nonDefinitionCount: total - definition,
    gap: total - call,
    erbCount,
    kojoCount,
    files: files.size,
  };
}

/**
 * 差值的一句话解释（**给作者看的**，也是面板/树的可测文案真源）：
 * "共 N 处出现（定义 a + 调用 b + 提及 c）；「被调用」面板的入边读数 = 非定义位 N-a 处
 * （其中 CALL 直系族 b 处）"——面板与 F12 的每个数都指回同一份 tally。
 */
export function explainReferenceCounts(tally: ReferenceTally): string {
  const parts: string[] = [];
  if (tally.definition > 0) parts.push(`定义 ${tally.definition}`);
  if (tally.call > 0) parts.push(`调用 ${tally.call}`);
  if (tally.mention > 0) parts.push(`提及 ${tally.mention}`);
  if (tally.unclassified > 0) parts.push(`未分类 ${tally.unclassified}`);
  const breakdown = parts.length > 0 ? parts.join(' + ') : '无';
  let text = `共 ${tally.total} 处出现（${breakdown}）`;
  if (tally.gap > 0) {
    // 一句话把面板的两个读数钉在同一份 tally 上：调用层级面板的「被调用 N 处」= **非定义位**，
    // 其中 CALL 直系族只有 callSiteCount——差值因此有名字，不再是各说各话。
    text +=
      `；「被调用」面板的入边读数 = 非定义位 ${tally.nonDefinitionCount} 处（其中 CALL 直系族 ${tally.callSiteCount} 处），` +
      `按直系族数会比这里少 ${tally.gap} 处（定义与非 CALL 的提及）`;
  } else {
    text += '；「被调用」面板计数与本数一致';
  }
  if (tally.kojoCount > 0) text += `；其中 .kojo 源 ${tally.kojoCount} 处`;
  return text;
}

/* ============================== 写通道（分组 + 只读闸门） ============================== */

/** 一个文件的出现点组（顺序 = 台账序，跨语言同表） */
export interface OccurrenceFileGroup {
  readonly path: string;
  readonly language: ReferenceLanguage;
  readonly occurrences: readonly ReferenceOccurrence[];
}

/** 写计划：可写文件的分组（待送达）+ 只读文件清单（铁律 4：不静默） */
export interface ReferenceWritePlan {
  readonly writable: readonly OccurrenceFileGroup[];
  /** 只读文件（不是出现点数）——非空 ⇒ 调用方必须整次取消 */
  readonly readOnlyFiles: readonly string[];
}

/**
 * ERB 词法 mention 的落盘判据（**单源**）：名字后紧邻 `(` 的 mention 才随改名落盘。
 *
 * 背景：反向索引对非 CALL 行做的是**词法级整串命中**，而 CALL 直系族表只认 CALL 系
 * 名字槽——`SIF FOO() == 0` 条件表达式位的真调用在索引里退化为 mention，`PRINTFORML
 * キスする。` 台词里的同名词也是 mention，词法分不开这两者。**现场文本**分得开：
 * 调用形 = 名字后紧邻 `(`（纯字形判据，零数据流）。判窄不判宽：判不出调用形就不写
 * （「改名不重写散文」既有自证同向）；散文里形如 `名(` 的罕见形态仍会被写（与
 * 旧行为一致，不劣化）。全角 `（` 刻意不算——台词里的全角括号是散文，不是调用。
 *
 * @param lineText 现场行文本（live model 的行或闭文件读回的行——**现文本**，非索引快照）
 * @param endColumn 名字的 1 基排他端列（其 0 基下标 endColumn-1 即名字后的第一个字符）
 */
export function isCallShapedMention(lineText: string, endColumn: number): boolean {
  return lineText[endColumn - 1] === '(';
}

/**
 * 出现点全集 → 按文件分组 + 写权限筛选（**纯函数**；`isWritable` = 内核 io 口径，
 * 与保存按钮同源）。只读文件整文件剔除并登记；只要有一份只读，调用方必须整次取消
 * （monaco 0.57 standalone 见 `rejectReason` 会丢弃全部编辑，没有"部分应用 + 提示"通道）。
 */
export function planReferenceWrites(
  occs: readonly ReferenceOccurrence[],
  isWritable: (path: string) => boolean,
): ReferenceWritePlan {
  const groups = new Map<string, ReferenceOccurrence[]>();
  const readOnly = new Set<string>();
  for (const occ of occs) {
    if (!isWritable(occ.filePath)) {
      readOnly.add(occ.filePath);
      continue;
    }
    let list = groups.get(occ.filePath);
    if (!list) {
      list = [];
      groups.set(occ.filePath, list);
    }
    list.push(occ);
  }
  return {
    writable: [...groups].map(([path, list]) => ({
      path,
      language: list[0]!.language,
      occurrences: list,
    })),
    readOnlyFiles: [...readOnly],
  };
}

/**
 * 「只读未纳入」的唯一文案（rename 与替换共用；REN-1 取证的原句保留在其中，
 * 旧断言 `toContain('n 个文件只读未纳入')` 零改动通过）。
 */
export function readOnlyFilesReason(count: number, action: string): string {
  return `${count} 个文件只读未纳入，整次${action}取消（部分改名会造成同名分叉）；解锁对应目录后重试`;
}

/**
 * 「只读剔除但其余已落」的明示（搜索面板「全部替换」用——它不是 Monaco rename 控制器，
 * 没有"见 rejectReason 丢弃全部编辑"的约束，可以逐文件剔除，但必须说出来，铁律 4）。
 * 计数措辞与 {@link readOnlyFilesReason} 同一段前缀，两处的读数因此可对拍。
 */
export function readOnlyFilesNotice(count: number, action: string): string {
  return `${count} 个文件只读未纳入（本次${action}未覆盖它们，其余文件已改）；解锁对应目录后重跑`;
}

/**
 * 检索/替换范围外仍有同名记号的明示（同一条引用判据的**跨通道回执**）：
 * F2 改的是全项目引用集，「全部替换」改的是检索结果集——两个写通道过去互不知情，
 * 于是"改完名再搜，残留命中仍在"。现在把差集说出来（不静默扩权、也不假装改干净）。
 */
export function residualOutsideScopeNotice(count: number, files: number, name: string): string {
  return `引用判据显示「${name}」在检索范围外还有 ${count} 处出现（${files} 个文件）未被本次替换覆盖`;
}

/* ============================== 落盘（闭文件一条通道） ============================== */

/** 内核 io 的最小面（rename 与替换都只用到这四条） */
export interface ClosedFileIo {
  isWritable(path: string): boolean;
  readText(path: string): Promise<{ text: string }>;
  writeText(path: string, text: string): Promise<void>;
}

/** 一次现文本改写的读数 */
export interface RewriteResult {
  readonly text: string;
  readonly applied: number;
  /** 现文本与坐标不符（作者已改写 / 行漂移）而跳过的处数——绝不按陈旧坐标硬写 */
  readonly stale?: number;
  /** kind=mention 且非调用形（散文）而跳过的处数——「改名不重写散文」的可见计数 */
  readonly skippedProse?: number;
}

/**
 * 未打开文件的**唯一**读改写通道（内核 io：保编码保换行 + 原子写 + 备份由内核兜住，
 * 写允许域由内核 io 强制——绕开写允许域没有第二条路，铁律 6）。
 *
 * 三条纪律收在此处，rename 与「全部替换」共用：
 * - 先 `isWritable` 再读盘（不可写 ⇒ 抛错交调用方计入只读剔除，不静默少改）；
 * - `rewrite` 在**读到的现文本**上算（陈旧坐标由 rewrite 自己判 stale）；
 * - 只在真有改动时写回（`applied > 0` 且文本变了）——零改动不产生备份与脏文件。
 */
export async function rewriteClosedFile(
  io: ClosedFileIo,
  path: string,
  rewrite: (text: string) => RewriteResult | Promise<RewriteResult>,
): Promise<{ applied: number; stale: number; skippedProse?: number }> {
  if (!io.isWritable(path)) {
    throw new Error(`文件只读（写权限未批准）：${path}`);
  }
  const { text } = await io.readText(path);
  const result = await rewrite(text);
  if (result.applied > 0 && result.text !== text) await io.writeText(path, result.text);
  // 仅非零才携带字段：没产 skippedProse / 为 0 的调用方拿到的形状与旧版逐字同形
  return result.skippedProse
    ? { applied: result.applied, stale: result.stale ?? 0, skippedProse: result.skippedProse }
    : { applied: result.applied, stale: result.stale ?? 0 };
}

/* ============================== 记号位置（单源字符集） ============================== */

/** 记号整串扫描用的正则（`MODEL_TOKEN_CLASS` 单源 ⇒ 与反向索引 / 着色同一把尺子） */
const TOKEN_RUN_RE = new RegExp(MODEL_TOKEN_CLASS + '+', 'gu');

/** 归一化快路径（无小写拉丁就不分配副本，与 `erb-parser/references.ts` 同判据） */
function upperOf(run: string): string {
  return /[a-zａ-ｚ]/.test(run) ? run.toUpperCase() : run;
}

/** 一处名字记号（1 基列，`endColumn` 不含端点；`text` 是源里的原样大小写） */
export interface NameTokenPosition {
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  readonly text: string;
}

/**
 * 整篇文本里"这一串字符等于这个名字"的**全部**记号位置（**纯函数**；
 * 大小写不敏感整串匹配，`.erb` 索引归一口径与 `.kojo` 源里的原样写法都能命中）。
 *
 * 刻意**不判读**这些位置是不是函数引用——糖侧的判读是探针法（转译器当判官），
 * 在 `kojo-sugar/rename.ts`，经槽消费；本函数只回答"字符形状对不对"，
 * 所以它不构成第二份糖语法扫描（也没有能力构成）。
 */
export function findNameTokenPositions(text: string, normalizedName: string): NameTokenPosition[] {
  if (normalizedName.length === 0) return [];
  const target = normalizedName.toUpperCase();
  const out: NameTokenPosition[] = [];
  const lines = splitModelLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    TOKEN_RUN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RUN_RE.exec(line)) !== null) {
      const run = m[0]!;
      if (upperOf(run) !== target) continue;
      out.push({ line: i + 1, column: m.index + 1, endColumn: m.index + 1 + run.length, text: run });
    }
  }
  return out;
}
