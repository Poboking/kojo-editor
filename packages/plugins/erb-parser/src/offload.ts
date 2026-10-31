/**
 * 可搬运任务（并行运输层；2026-10-12「内核优化」批 · 例 1 之"首次加载也要快"）。
 *
 * ## 为什么
 *
 * 索引构建的墙钟时间由**纯 CPU 的解析**主导：真实语料 2,317 文件 / 362 万行，
 * `parseErbText` 串行耗时实测约 **2.6 s**（探针：读盘+解析 4,290 ms，其中读盘为
 * `readFileSync` 串行）。切片让路只能改善"卡不卡"，改不了"要等多久"——
 * **要真提速必须多线程并行**。
 *
 * ## 分工（铁律：IO 不搬）
 *
 * - 主线程：`walkDir` + `stat` + `readText`（Tauri IPC 留主线程——worker 内 invoke
 *   的可用性未经本仓库验证，不值得赌；见 `docs/archive/PERF-REVIEW-2026-10-11.md` §四）；
 * - 并行通道：**只搬纯解析**（`text` → `ErbFile`，纯数据进、纯数据出）。
 *
 * ## 单一真源
 *
 * 任务表由本模块导出，**宿主侧 `registerTask`（本地实现/回退）与 worker 入口
 * （`handleComputeRequest`）共用同一份**——避免两侧映射漂移（kind 写错会静默退化为
 * "unknown compute task kind"）。
 */
import type {
  ComputeTaskTable,
  ControlFlowStatement,
  EditorDecoratePayload,
  EditorDecoratorBulkPayload,
  EditorDecoratorBulkResult,
  ErbIndex,
  ErbParam,
  LineDecoration,
} from '@kojo/plugin-api';
import { ERB_ENGINE_RESERVED_IDENTIFIERS, ERB_ENGINE_STRING_IDENTIFIERS, isErbDialectPath } from '@kojo/plugin-api';
import type { ArityCatalog } from './arity';
import { agreedParamsOf, arityParamsOf, collectArityDiagnostics } from './arity';
import { BUILTIN_FUNCTION_NAMES, collectBuiltinArgDiagnostics } from './builtins';
import { parseErbText, scanControlFlow } from './scanner';
import { collectUndefinedNameDiagnostics, type UndefinedNameDiagnosticsInput } from './undefined-name';
import { checkStructure } from './structure';
import { structureDiagnostic } from './structure-fix';
import { scanFileRefs, splitErbLines, visibleCodeLineList, type FileRefs } from './references';

/** 任务 kind：纯解析一个 ERB 文件 */
export const PARSE_FILE_TASK = 'erb.parseFile';
/** 任务 kind：控制流骨架扫描（条件抽取的 CPU 主段） */
export const SCAN_FLOW_TASK = 'erb.scanControlFlow';
/**
 * 任务 kind（2026-10-16 装饰热路径批）：**结构波浪线整条链**（全文体检 + 诊断成形）。
 *
 * 这是 `ui.editor.decorator`（id `erb-structure`）的可搬运实现——编辑器每 250ms 停顿
 * 就把整份文件重扫一遍，纯 CPU、纯数据，正是该搬进 worker 的那一类。
 */
export const STRUCTURE_DECORATIONS_TASK = 'erb.structureDecorations';
/**
 * 任务 kind（REFS-WORKER，2026-10-21）：**反向引用批量扫描**（一批正文 + 项目名录 → 逐文件 `FileRefs`）。
 *
 * 这一段此前是全仓最后一块"整棵语料的纯 CPU 扫描留在主线程"的账（真语料快照未命中轮
 * `refs scan 7,388ms`，见 STATE §二）。判据本体 `scanFileRefs` 一个字都不改，本文件只做
 * "把 `hasName` 闭包换成**名录数据**"这一件事：worker 拿名录建 Set、按同一个 `hasName` 谓词扫。
 */
export const SCAN_REFS_TASK = 'erb.scanRefs';
/**
 * 任务 kind（R4b，2026-10-29）：**整项目扫描的三条语义诊断腿，一批文件一次算**。
 *
 * 与 `erb.structureDecorations`（编辑器，一次一份）的区别只在粒度：整轮扫描 400 文件时，
 * 逐文件搬运要把**跨文件上下文**（声明名表 / 实参目录 / 影子函数集）序列化 400 遍，
 * 而它属于整份项目态、与文件内容无关。批量载荷让这份上下文**每批只序列化一次**。
 *
 * 判据本体仍是 `semantic-diagnostics.ts` 的 `collectErbSemanticDiagnostics` 一处；
 * 本任务只做"把序列化快照折成它认识的三处事实"这一件事（`isUserFunction` 与
 * `arityCatalog` 都是它的既有注入位，R4b 没有新增分支）。
 */
export const SEMANTIC_DIAGNOSTICS_TASK = 'erb.semanticDiagnosticsBulk';

export interface ParseFilePayload {
  text: string;
  path: string;
}

/**
 * `erb.parseFile` 的**通道回传形态**：解析结果以 JSON 文本回传，而不是 `ErbFile` 对象图。
 *
 * 真机冷开那一帧 `Worker.onmessage`（2.1–2.2s）落点**早于 `kojo.functionChanged`** ⇒ 量的是索引阶段
 * 2,120 条 `parseFile` 的收结果。`ErbFile` 是"80k 浅对象 + 每对象若干字符串"，而结构化克隆按条数
 * 计价（同源读数见 `ScanRefsPayload` 头注）；同形载荷 99k 函数实测：对象图 1,232ms / `JSON.parse` 293ms。
 */
export interface ParseFileWire {
  /** `ErbFile` 的 JSON 文本（worker 内 `stringify`） */
  fileJson: string;
}

export interface ScanFlowPayload {
  text: string;
}

/** 引用批扫的连接符（名字是 `\p{L}\p{N}_` 记号串，按判据不可能含换行；含了会被下面的条数自证抓住） */
const NAME_JOIN = '\n';

/**
 * `erb.scanRefs` 的载荷（REFS-WORKER）。
 *
 * **名录为什么走"连接串 + 条数"而不是 `string[]`**：结构化克隆 99,030 枚字符串的**主线程序列化**
 * 实测每次 8.6ms（整轮 37 块 ≈ 318ms），而 5.8MiB 单串只 1.4ms（整轮 ≈ 52ms）；整轮正文
 * （183.5MiB / 96.2M 码元）本身序列化只 169ms ⇒ 名录才是那笔可省的固定税。
 * 串到 worker 侧要 `split` + 建 Set（本机实测 190–300ms/槽，受后台负载影响），
 * 按名录指纹缓存后**每槽每代只付一次**（4 槽并行摊到关键路径 ≈ 一次）。
 * `namesCount` 是**条数自证**：拆出来条数不符（名字里真混进了连接符）就抛错 ⇒ 调用方回退内联老路径，
 * 绝不用一份残缺名录去扫（宁慢不错，且不静默）。
 */
export interface ScanRefsPayload {
  /** 名录摘要（与快照溯源位同一把尺：`snapshot.nameSetDigest`）；worker 侧按它缓存 Set */
  namesFp: number;
  /** 名录条数（split 后自证） */
  namesCount: number;
  /** 归一化名录，`\\n` 连接 */
  namesJoined: string;
  /** 待扫正文（与调用方给的路径数组同序；空串是"读失败位"，由调用方就地剔掉，不进本载荷） */
  texts: string[];
}

/**
 * 单文件的批扫产出（REFS-PROVENANCE，2026-10-22）：refs 之外**顺带**交回该文件的
 * 候选记号集（问过 `hasName` 的一切记号，'\n' 连接；'' = 没有候选）。
 *
 * 为什么搭这趟车：候选收集只在**重扫那批文件**上发生（复用文件自带盘上候选位），
 * 而重扫本来就要走这条通道——让 worker 与内联老路径产出**同形**（调用方逐位对拍），
 * 溯源巡检就能把"名录变掉的名字 ∩ 候选集"的判定落到每份文件上，全树重扫就此退役。
 * 记号判据是 `\p{L}\p{N}_` ⇒ 候选**不可能含连接符**（真语料 3971 文件 / 170 万候选实测
 * `sepSafe=true`），仍由调用方的形状自证兜底。
 */
export interface ScanRefsFileResult {
  refs: FileRefs;
  /** 该文件的候选记号集，`\\n` 连接（归一化大写；顺序 = 扫描序，无语义） */
  candidates: string;
}

/** 名录 Set 的跨请求缓存（单槽一份；指纹变了自然作废） */
let refsNameCache: { fp: number; set: ReadonlySet<string> } | null = null;

function refsNameSetOf(payload: ScanRefsPayload): ReadonlySet<string> {
  if (refsNameCache !== null && refsNameCache.fp === payload.namesFp) return refsNameCache.set;
  // 空名录是合法输入（这一轮项目里一个函数都没有）；`''.split('\n')` 会得 `['']`，
  // 所以条数自证要在**空表**上单独判，不能拿 split 的结果去比。
  const parts = payload.namesCount === 0 ? [] : payload.namesJoined.split(NAME_JOIN);
  if (parts.length !== payload.namesCount) {
    throw new Error(
      `refs name set unusable: split produced ${parts.length} entries for namesCount ${payload.namesCount}`,
    );
  }
  const set = new Set(parts);
  refsNameCache = { fp: payload.namesFp, set };
  return set;
}

/**
 * 批量引用扫描（**纯函数**，两侧共用同一份 ⇒ 有 worker / 无 worker 同产出）。
 *
 * `hasName` 由名录 Set 现拼，谓词与主线程侧 `byName.has(upper)` 逐位同判据；
 * 扫描本体是 `references.ts:scanFileRefs`，本函数不掺任何判据（等价对拍见
 * `tests/refs-offload-equiv.test.ts`）。候选收集走同一个 `scanFileRefs` 的可选
 * 收集位（REFS-PROVENANCE）：与 refs 同一遍扫描产出，**refs 判据一字未动**。
 */
export function scanRefsBatch(payload: ScanRefsPayload): ScanRefsFileResult[] {
  const names = refsNameSetOf(payload);
  return payload.texts.map((text) => {
    const candidates = new Set<string>();
    const refs = scanFileRefs(text, (upper: string) => names.has(upper), (u: string) => {
      candidates.add(u);
    });
    return { refs, candidates: [...candidates].join(NAME_JOIN) };
  });
}

/** 观测面：当前槽是否已持有名录 Set（一次性取证用，不参与判据） */
export function refsNameCacheState(): { fp: number; size: number } | null {
  return refsNameCache === null ? null : { fp: refsNameCache.fp, size: refsNameCache.set.size };
}

/** 载荷的名录三位（每轮构建算一次、逐块复用同一枚串，不逐块重连） */
export type ScanRefsNamesPart = Pick<ScanRefsPayload, 'namesFp' | 'namesCount' | 'namesJoined'>;

/**
 * 名录三位组装（**连接符与条数只在这一处定形**，宿主与 worker 不许各写一遍）。
 *
 * `names` 传索引的 `byName.keys()`；调用方按轮缓存返回值再逐块 `{ ...names, texts }` ——
 * 99,030 名 `join` 一次约 5ms，逐块重连会把这条税又交回主线程（实测见交付读数）。
 */
export function scanRefsNamesOf(namesFp: number, names: Iterable<string>): ScanRefsNamesPart {
  const parts = [...names];
  return { namesFp, namesCount: parts.length, namesJoined: parts.join(NAME_JOIN) };
}

/**
 * 结构波浪线的**单一真源**（契约 `ui.editor.decorator` 的 `decorate` 与任务实现共用它）。
 *
 * 两处各写一遍必然漂移——漂移的表现是"有并行通道时波浪线一种、通道挂了另一种"，
 * 那种不一致比慢十倍更糟。适用性判据（方言扩展名 / 空文本）也在这一份里。
 *
 * **走的是全量入口 `checkStructure(text, path)` 而不是只跑配对那一趟**（2026-10-26 A4）：
 * 声明面两类（`#DIM` 硬规则 / `#FUNCTION` 收尾）与头文件形态此前只到服务面，编辑器
 * 一条都看不到——`checkStructure` 的头注写着"宿主只认一个答案"，而当时宿主根本没调它。
 * 判据（`dim-invalid` / `return-form` / `erh-invalid`）都已按"只在拿得准的地方说话"
 * 收过真语料（8 盘：`#DIM` 族 143,167 行 0 命中、`.ERH` 648 份 0 命中），
 * 所以这里不会把假红带上屏。带 `path` 的另一个用途：`.ERH` 的专属判据要靠扩展名分派。
 */
export function erbStructureDecorations({ path, text }: EditorDecoratePayload): LineDecoration[] {
  if (!isErbDialectPath(path) || text.length === 0) return [];
  // 逐字段的形状只住在 `structureDiagnostic` 一处：💡 那边给出的"我修的是哪条诊断"
  // 用的就是同一个函数 ⇒ 波浪线与快速修复不可能对不上（B9 的关联键全靠它）
  return checkStructure(text, path).map(structureDiagnostic);
}

/**
 * 整项目扫描的**跨文件上下文**（`erb.semanticDiagnosticsBulk` 的载荷头；R4b）。
 *
 * 三处事实就是 `collectErbSemanticDiagnostics` 对项目态的全部依赖：
 * 声明名（`#DIM` 族，未定义名腿）、实参目录（实参腿）、影子函数集（内建实参腿）。
 *
 * **为什么名录走"连接串 + 条数"而不是 `string[]`**：与 `ScanRefsPayload` 的同一条理由
 * （见那边的读数）——结构化克隆按条数计价，整轮扫描要把这份上下文**每批**送一次
 * （400 文件 / 16 一批 = 25 次），`string[]` 的每枚字符串都是一笔税，单串只按字节算。
 * `*Count` 是**条数自证**：拆出来条数不符就抛错 ⇒ 调用方回退逐文件（宁慢不错，不静默）。
 *
 * `arityJoined` 每行一枚函数：`名字\t形参1,形参2*`（`*` = 有默认值）。只收**多处定义
 * 一致**的那些名字（判据 = `agreedParamsOf`），其余名字在 worker 侧查不到 = `null` =
 * 与 `arityParamsOf` 给出 `null` 逐位同义（都表示"证明不了 ⇒ 一条不报"）。
 *
 * `shadowed` 只装**与内建签名表同名**的项目函数：内建诊断只在它认识的名字上问
 * `isUserFunction`，其余名字过滤掉是等价变换，不是近似。
 */
export interface SemanticBulkContext {
  /** 上下文指纹（每次从索引重建都换号）；worker 侧按它缓存解析结果 */
  fp: number;
  dimsCount: number;
  dimsJoined: string;
  stringsCount: number;
  stringsJoined: string;
  arityCount: number;
  arityJoined: string;
  /** 归一化（大写）的内建同名项目函数 */
  shadowed: readonly string[];
}

/** 连接符：声明名与函数名都是 `\p{L}\p{N}_` 记号串，按判据不可能含换行/制表/逗号 */
const LIST_JOIN = '\n';
const ARITY_FIELD = '\t';
const PARAM_JOIN = ',';
const DEFAULT_MARK = '*';

/** 形参表编码（`P1,P2*`；空表 = 空串，与"没这一项"靠行内制表位区分） */
export function encodeArityParams(params: readonly ErbParam[]): string {
  let out = '';
  for (let i = 0; i < params.length; i++) {
    if (i > 0) out += PARAM_JOIN;
    out += params[i]!.hasDefault ? params[i]!.name + DEFAULT_MARK : params[i]!.name;
  }
  return out;
}

function decodeArityParams(encoded: string): ErbParam[] {
  if (encoded === '') return [];
  return encoded.split(PARAM_JOIN).map((raw) => {
    const hasDefault = raw.endsWith(DEFAULT_MARK);
    return { name: hasDefault ? raw.slice(0, -1) : raw, hasDefault };
  });
}

/** 上下文解析后的形状（worker 侧每次进程只解析一次，按 `fp` 缓存） */
interface SemanticContextView {
  readonly dims: readonly string[];
  readonly strings: readonly string[];
  readonly arity: ArityCatalog;
  readonly isUserFunction: (normalizedName: string) => boolean;
}

/** 上下文缓存的**唯一一份**（单槽一份；指纹或三项条数变了自然作废） */
let semanticCtxCache:
  | {
      fp: number;
      dimsCount: number;
      stringsCount: number;
      arityCount: number;
      shadowedCount: number;
      view: SemanticContextView;
    }
  | null = null;

function splitWithCount(joined: string, count: number, what: string): string[] {
  // 空表是合法输入（这一轮项目里一个声明都没有）；`''.split('\n')` 会得 `['']`，
  // 所以条数自证要在空表上单独判，不能拿 split 的结果去比。
  const parts = count === 0 ? [] : joined.split(LIST_JOIN);
  if (parts.length !== count) {
    throw new Error(`semantic bulk ctx unusable: ${what} split produced ${parts.length} entries for count ${count}`);
  }
  return parts;
}

function semanticViewOf(ctx: SemanticBulkContext): SemanticContextView {
  // 命中条件不止指纹：三项条数也一起比。`fp` 由本侧发号，正常路径上不可能撞；
  // 但"指纹对、内容被换过"这种上下文**必须**在 O(1) 里被识别出来（否则缓存会把
  // 上一批的名录继续喂给下一批——错得悄无声息，比慢一百倍糟）。
  if (
    semanticCtxCache !== null &&
    semanticCtxCache.fp === ctx.fp &&
    semanticCtxCache.dimsCount === ctx.dimsCount &&
    semanticCtxCache.stringsCount === ctx.stringsCount &&
    semanticCtxCache.arityCount === ctx.arityCount &&
    semanticCtxCache.shadowedCount === ctx.shadowed.length
  ) {
    return semanticCtxCache.view;
  }
  const dims = splitWithCount(ctx.dimsJoined, ctx.dimsCount, 'dims');
  const strings = splitWithCount(ctx.stringsJoined, ctx.stringsCount, 'strings');
  const lines = ctx.arityCount === 0 ? [] : ctx.arityJoined.split(LIST_JOIN);
  if (lines.length !== ctx.arityCount) {
    throw new Error(`semantic bulk ctx unusable: arity split produced ${lines.length} entries for count ${ctx.arityCount}`);
  }
  const arityMap = new Map<string, ErbParam[]>();
  for (const line of lines) {
    const cut = line.indexOf(ARITY_FIELD);
    if (cut <= 0) throw new Error(`semantic bulk ctx unusable: arity line without separator`);
    arityMap.set(line.slice(0, cut), decodeArityParams(line.slice(cut + 1)));
  }
  const shadowed = new Set(ctx.shadowed);
  const view: SemanticContextView = {
    dims,
    strings,
    arity: (normalizedName: string) => arityMap.get(normalizedName) ?? null,
    isUserFunction: (normalizedName: string) => shadowed.has(normalizedName),
  };
  semanticCtxCache = {
    fp: ctx.fp,
    dimsCount: ctx.dimsCount,
    stringsCount: ctx.stringsCount,
    arityCount: ctx.arityCount,
    shadowedCount: ctx.shadowed.length,
    view,
  };
  return view;
}

/** 观测面：worker 槽当前缓存的上下文指纹（一次性取证用，不参与判据） */
export function semanticBulkCacheState(): { fp: number } | null {
  return semanticCtxCache === null ? null : { fp: semanticCtxCache.fp };
}

/** 上下文指纹的发号器（每次从索引重建 +1；worker 侧按它判缓存新旧） */
let bulkCtxSeq = 0;
/** 上下文按索引对象缓存：索引重建即换键，天然失效（与 `projectDeclaredNames` 同一把尺） */
const bulkCtxCache = new WeakMap<object, SemanticBulkContext>();

/**
 * 从项目索引**一次成型**整轮扫描的上下文（R4b；主线程调用，每索引对象只算一次）。
 *
 * 三处事实都从索引现读，但**回查方式与 `arityParamsOf` 逐位等价**而复杂度不同：
 * `arityParamsOf` 逐名 `find` 一遍函数表是 O(名字数 × 函数数)，整项目一次成型时
 * 这里预建 `startLine → 形参表`，逐名回查降到 O(1)；判据本体仍只 `agreedParamsOf` 一处。
 *
 * 只收 `agreedParamsOf` 给出结论的名字：那些"证明不了"的函数在 worker 侧查不到 ⇒
 * `null` ⇒ 与活索引路径逐位同义（都表示这一条不报），不是近似。
 */
export function buildSemanticBulkContext(index: ErbIndex): SemanticBulkContext {
  const cached = bulkCtxCache.get(index);
  if (cached !== undefined) return cached;
  const declared = projectDeclaredNames(index);
  // 每份文件的 startLine → 形参表（`params === undefined` 的条目**不建键**：
  // 缺席与"没有形参"是两件事，前者必须让 `agreedParamsOf` 判成"证明不了"）
  const paramAt = new Map<string, Map<number, readonly ErbParam[]>>();
  for (const [path, file] of index.files) {
    const at = new Map<number, readonly ErbParam[]>();
    for (const fn of file.functions) {
      if (fn.params !== undefined) at.set(fn.startLine, fn.params);
    }
    paramAt.set(path, at);
  }
  const arityLines: string[] = [];
  for (const name of index.byName.keys()) {
    const agreed = agreedParamsOf(index.byName.defsOf(name), (ref) => paramAt.get(ref.filePath)?.get(ref.startLine));
    if (agreed !== null) arityLines.push(name + ARITY_FIELD + encodeArityParams(agreed));
  }
  const ctx: SemanticBulkContext = {
    fp: ++bulkCtxSeq,
    dimsCount: declared.dims.length,
    dimsJoined: declared.dims.join(LIST_JOIN),
    stringsCount: declared.strings.length,
    stringsJoined: declared.strings.join(LIST_JOIN),
    arityCount: arityLines.length,
    arityJoined: arityLines.join(LIST_JOIN),
    // 内建诊断只在 `BUILTIN_SIGNATURES` 认识的名字上问 `isUserFunction` ⇒ 其余名字
    // 过滤掉是等价变换（见 `ErbSemanticDiagnosticsOptions.isUserFunction`）
    shadowed: BUILTIN_FUNCTION_NAMES.filter((n) => index.byName.has(n)),
  };
  bulkCtxCache.set(index, ctx);
  return ctx;
}

/**
 * 整项目扫描的语义诊断（**批量纯函数**；R4b）。
 *
 * `ctx === null` 与"索引为 null"**逐条等价**：实参腿 fail-open、声明名只有文本自身的、
 * 影子函数无从谈起——就是 `decorate` 在未开项目时的那一档。
 *
 * `maxSuggestions: 0` 是 R4a 的结论（扫描那一轮不算 did-you-mean），与
 * `decorate({..., bulk: true})` 传的是同一枚旋钮 ⇒ 两条路径的 `message` 也逐字相同。
 */
export function semanticDiagnosticsBulk(payload: EditorDecoratorBulkPayload): EditorDecoratorBulkResult {
  const ctx = (payload.ctx ?? null) as SemanticBulkContext | null;
  const view = ctx === null ? null : semanticViewOf(ctx);
  /**
   * `maxSuggestions: 0` **与上下文无关**（R4a 的结论）：扫描那一轮不算 did-you-mean，
   * 未开项目时也一样 ⇒ 这一格必须无条件在，否则"没有项目态"的那一档会和
   * `decorate({..., bulk: true})` 的文案分叉（差的就是尾巴那句"你是不是想写「X」"）。
   */
  const undefinedNames = {
    builtinNames: ERB_ENGINE_RESERVED_IDENTIFIERS,
    engineStringNames: ERB_ENGINE_STRING_IDENTIFIERS,
    maxSuggestions: 0,
    ...(view === null ? {} : { dimNames: view.dims, stringNames: view.strings }),
  };
  const options =
    view === null ? { undefinedNames } : { undefinedNames, arityCatalog: view.arity, isUserFunction: view.isUserFunction };
  const perFile = payload.files.map((file) =>
    collectErbSemanticDiagnostics({ path: file.path, text: file.text }, null, options).decorations,
  );
  return { perFile };
}

/** 本插件导出的可搬运任务表（宿主与 worker 侧共用） */
export const erbParserTasks: ComputeTaskTable = {
  [PARSE_FILE_TASK]: ((payload: ParseFilePayload): ParseFileWire => ({
    fileJson: JSON.stringify(parseErbText(payload.text, payload.path)),
  })) as never,
  [SCAN_FLOW_TASK]: ((payload: ScanFlowPayload): ControlFlowStatement[] => scanControlFlow(payload.text)) as never,
  [SCAN_REFS_TASK]: ((payload: ScanRefsPayload): ScanRefsFileResult[] => scanRefsBatch(payload)) as never,
  [STRUCTURE_DECORATIONS_TASK]: ((payload: EditorDecoratePayload): LineDecoration[] =>
    erbStructureDecorations(payload)) as never,
  [SEMANTIC_DIAGNOSTICS_TASK]: ((payload: EditorDecoratorBulkPayload): EditorDecoratorBulkResult =>
    semanticDiagnosticsBulk(payload)) as never,
};

/* ==================== 语义诊断的合并出口（批次十 S19；R4b 2026-10-29 从 `plugin.ts` 搬来） ====================

   这里是"同一份文件的三条腿合成一张诊断表"的唯一真源：实参个数（`arity.ts`）、未定义名
   （`undefined-name.ts`）、内建函数实参（`builtins.ts`）。两个消费者住在本模块与 `plugin.ts`：

   - `plugin.ts` 的装饰贡献 `erb-semantics`（编辑器那一轮，就地同步）；
   - 本文件的批量任务 `erb.semanticDiagnosticsBulk`（整项目扫描那一轮，worker 侧）。

   `plugin.ts` 已经在 import 本文件（任务表），判据若留在 `plugin.ts`，批量任务就得反向
   import 回去——那是一个真的模块环。搬到这里，两个消费者都只依赖它，环消失，而"两条路径
   共用同一个判据"由模块图本身保证，不靠注释提醒。

   为什么并进 `offload.ts` 而不独立一个模块（2026-10-31 并入主干时定）：独立模块会作为
   **第 200 枚**进开机图，而 `ps10-eager-graph` 的文件闸顶格是 199（"下一枚进图模块仍须先
   挪一枚出去"）。这一层的唯一消费者就是本文件的任务表与 `plugin.ts` 的贡献，没有第二个
   使用场景值得为它花掉那格额度。 */

/** 实参「多给」的稳定文案标记（`arity.ts` 的三种消息里只这一档是可证错误） */
const ARITY_EXTRA_ARG_MARKER = '多出的实参';

/** 规则执行失败的可读诊断码（问题面板可定位；不改写既有两码） */
export const ERB_DIAGNOSTICS_RULE_FAILED = 'ERB_DIAGNOSTICS_RULE_FAILED';

/**
 * 未定义名诊断是否默认启用。
 *
 * true 的依据与读数见上方接线注②（批次十一收窄后语料误报可逐条解释）；
 * 关闭可由调用方显式传 `enableUndefinedNames: false`。
 */
export const UNDEFINED_NAME_DIAGNOSTICS_ENABLED = true;

/** 逐规则失败的记账形状（与校验器 `report.failedRules` 同一语义：不静默） */
export interface ErbDiagnosticsRuleFailure {
  readonly rule: 'arity' | 'undefined-name' | 'builtin-args';
  readonly message: string;
}

/**
 * 语义诊断的接线选项（默认值即生产口径；测试可覆盖目录/开关）。
 *
 * 三处事实（声明名 / 实参目录 / 用户函数谓词）都留了覆盖位：索引路径从 `index` 现读，
 * worker 路径从序列化快照拼——**判据分支一个都不多**（`collectErbSemanticDiagnostics`
 * 里没有 "if (worker)" 这一档，差别只在传进来的函数与数组）。
 */
export interface ErbSemanticDiagnosticsOptions {
  /** 覆盖未定义名默认开关 */
  readonly enableUndefinedNames?: boolean;
  /** 覆盖实参目录（测试注入；缺省由索引的 `arityParamsOf` 构造） */
  readonly arityCatalog?: ArityCatalog;
  /** 追加给未定义名的已知名集（适配器接入前留的 additive 口） */
  readonly undefinedNames?: Omit<UndefinedNameDiagnosticsInput, 'text' | 'path' | 'lines' | 'visible'>;
  /**
   * 覆盖"这个名字是不是本项目的用户函数"（additive，2026-10-29 R4b）。
   *
   * 唯一的消费者是内建实参诊断的**影子函数让位**：项目里存在同名用户函数时该名字整体不判
   * （用户定义优先，猜错边就是满屏假红）。索引在手的路径缺省由 `index.byName` 现读；
   * worker 路径传一份**只含内建同名的影子集**——判据只在 `BUILTIN_SIGNATURES` 认识的名字上
   * 被问，所以过滤掉其余名字**是等价的**，不是近似。
   */
  readonly isUserFunction?: (normalizedName: string) => boolean;
}

export interface ErbSemanticDiagnosticsResult {
  readonly decorations: LineDecoration[];
  readonly failedRules: readonly ErbDiagnosticsRuleFailure[];
}

/** 工程级声明名（#DIM 族）按索引对象缓存；索引重建即换键，天然失效 */
const projectNamesCache = new WeakMap<ErbIndex, { dims: string[]; strings: string[] }>();

/**
 * 从项目索引汇总声明名：`dims` 供"已声明"判定，`strings` 供字符串型赋值整行跳过。
 *
 * 跨文件声明是 Emuera 的常态（`DIM.ERH` 集中声明），只看当前文件会成片误报。
 * 缓存按索引对象（`ErbIndex` 每次重建都是新对象）而不是按路径，避免"文件改了还拿旧名录"。
 */
export function projectDeclaredNames(index: ErbIndex): { dims: string[]; strings: string[] } {
  const cached = projectNamesCache.get(index);
  if (cached !== undefined) return cached;
  const dims: string[] = [];
  const strings: string[] = [];
  for (const file of index.files.values()) {
    for (const dim of file.dims) {
      dims.push(dim.name);
      if (dim.directive === 'DIMS' || dim.directive === 'DIMSTR' || dim.directive === 'DIMCHAR') strings.push(dim.name);
    }
  }
  const names = { dims, strings };
  projectNamesCache.set(index, names);
  return names;
}

const SEVERITY_ORDER: Record<LineDecoration['severity'], number> = { error: 0, warning: 1, info: 2 };

/** 码/文案比较用码元序（不用 localeCompare：排序结果不随运行环境语言变化） */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 去重 + 稳定排序：行 → 起始列 → 结束列 → 严重度 → 码 → 文案。
 *
 * 两个模块各自的区间口径已一致（1 基、UTF-16、结束列不含端点）；同一位置同一码的
 * 重复项只留第一条（不同模块理论上不会重合，但索引重建/规则演化的路上留一道闸）。
 */
function sortAndDedupe(decorations: readonly LineDecoration[]): LineDecoration[] {
  const seen = new Set<string>();
  const out: LineDecoration[] = [];
  for (const d of decorations) {
    const key = `${d.line}\u0001${d.startColumn ?? ''}\u0001${d.endColumn ?? ''}\u0001${d.severity}\u0001${d.code ?? ''}\u0001${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  out.sort(
    (a, b) =>
      a.line - b.line ||
      (a.startColumn ?? 0) - (b.startColumn ?? 0) ||
      (a.endColumn ?? 0) - (b.endColumn ?? 0) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compareText(a.code ?? '', b.code ?? '') ||
      compareText(a.message, b.message),
  );
  return out;
}

/**
 * 合并三条语义诊断腿（**纯函数**：文本 + 索引 + 选项进、诊断/失败账出）。
 *
 * 索引为 null 时实参腿 fail-open（目录不可证 ⇒ 一条不报）；未定义名腿若被显式打开，
 * 仍可用文本自身的 `#DIM` / 形参判定（与模块缺省语义一致）。
 *
 * 三处事实的取法（R4b 起）：`options.arityCatalog` / `options.undefinedNames.dimNames`
 * / `options.isUserFunction` 显式给了就用给的，没给才回落到 `index` —— 于是"worker 拿着一份
 * 序列化快照"与"编辑器拿着活索引"走的是**同一串判据**，没有第二份实现。
 */
export function collectErbSemanticDiagnostics(
  file: { readonly path: string; readonly text: string },
  index: ErbIndex | null,
  options: ErbSemanticDiagnosticsOptions = {},
): ErbSemanticDiagnosticsResult {
  if (!isErbDialectPath(file.path) || file.text.length === 0) return { decorations: [], failedRules: [] };

  // 四家消费方共用一份扫描产物：切行一次、可见行摊平一次（此前各家各扫一遍，24k 行 16.8 ms/遍）
  const lines = splitErbLines(file.text);
  const visible = visibleCodeLineList(lines);

  const decorations: LineDecoration[] = [];
  const failedRules: ErbDiagnosticsRuleFailure[] = [];

  const catalog =
    options.arityCatalog ?? (index === null ? null : (normalizedName: string) => arityParamsOf(index, normalizedName));
  if (catalog !== null) {
    try {
      for (const d of collectArityDiagnostics({ path: file.path, text: file.text, catalog, visible })) {
        // 少给（含省略可选）是 Emuera 的合法写法，见接线注①——只留"多给"
        if (!d.message.includes(ARITY_EXTRA_ARG_MARKER)) continue;
        decorations.push({ ...d, severity: 'warning' });
      }
    } catch (err) {
      failedRules.push({ rule: 'arity', message: String(err) });
    }
  }

  if (options.enableUndefinedNames ?? UNDEFINED_NAME_DIAGNOSTICS_ENABLED) {
    try {
      const declared = index === null ? { dims: [], strings: [] } : projectDeclaredNames(index);
      decorations.push(
        ...collectUndefinedNameDiagnostics({
          text: file.text,
          path: file.path,
          lines,
          visible,
          dimNames: declared.dims,
          stringNames: declared.strings,
          ...options.undefinedNames,
        }),
      );
    } catch (err) {
      failedRules.push({ rule: 'undefined-name', message: String(err) });
    }
  }

  /* ---------------- 内建函数实参诊断（A1 · exmeth 静态签名表） ----------------

     第三条腿，与用户函数两条腿的差异都是有意的：

     1. **不依赖索引**：签名表是静态数据 ⇒ 未打开项目 / 索引还没建好也判
        （`collectErbSemanticDiagnostics` 的索引可空，这一腿照常出）；
     2. **影子函数让位**：项目里存在同名用户函数时该名字整体不判——用户定义优先，
         猜错边就是满屏假红（`isUserFunction` 由调用点按索引现读，或由批量快照给）；
     3. **独立诊断码**（`ERB_BUILTIN_ARGS` / `ERB_BUILTIN_ARG_TYPE`）：问题面板可按码
         过滤，也不与用户函数那一路的接线注①（多给降 warning 的抗噪口径）互相污染。 */
  const isUserFunction =
    options.isUserFunction ?? (index === null ? undefined : (upper: string) => index!.byName.has(upper));
  try {
    decorations.push(
      ...collectBuiltinArgDiagnostics({
        path: file.path,
        text: file.text,
        visible,
        ...(isUserFunction === undefined ? {} : { isUserFunction }),
      }),
    );
  } catch (err) {
    failedRules.push({ rule: 'builtin-args', message: String(err) });
  }

  // 铁律四：失败要上屏，不能只在控制台留一行后当没发生
  for (const failure of failedRules) {
    decorations.push({
      line: 1,
      severity: 'warning',
      message: `诊断规则「${failure.rule}」本轮执行失败，这一类结果已跳过：${failure.message}`,
      code: ERB_DIAGNOSTICS_RULE_FAILED,
    });
  }

  return { decorations: sortAndDedupe(decorations), failedRules };
}
