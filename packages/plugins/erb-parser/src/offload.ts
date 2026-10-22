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
  LineDecoration,
} from '@kojo/plugin-api';
import { isErbDialectPath } from '@kojo/plugin-api';
import { parseErbText, scanControlFlow } from './scanner';
import { checkControlFlowStructure } from './structure';
import { structureDiagnostic } from './structure-fix';
import { scanFileRefs, type FileRefs } from './references';

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

export interface ParseFilePayload {
  text: string;
  path: string;
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
 */
export function erbStructureDecorations({ path, text }: EditorDecoratePayload): LineDecoration[] {
  if (!isErbDialectPath(path) || text.length === 0) return [];
  // 逐字段的形状只住在 `structureDiagnostic` 一处：💡 那边给出的"我修的是哪条诊断"
  // 用的就是同一个函数 ⇒ 波浪线与快速修复不可能对不上（B9 的关联键全靠它）
  return checkControlFlowStructure(text).map(structureDiagnostic);
}

/** 本插件导出的可搬运任务表（宿主与 worker 侧共用） */
export const erbParserTasks: ComputeTaskTable = {
  [PARSE_FILE_TASK]: ((payload: ParseFilePayload) => parseErbText(payload.text, payload.path)) as never,
  [SCAN_FLOW_TASK]: ((payload: ScanFlowPayload): ControlFlowStatement[] => scanControlFlow(payload.text)) as never,
  [SCAN_REFS_TASK]: ((payload: ScanRefsPayload): ScanRefsFileResult[] => scanRefsBatch(payload)) as never,
  [STRUCTURE_DECORATIONS_TASK]: ((payload: EditorDecoratePayload): LineDecoration[] =>
    erbStructureDecorations(payload)) as never,
};
