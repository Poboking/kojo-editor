/**
 * Kojo 2.0 **项目级分析**（K2-PROJECT-HOST；设计稿 §16.6 S5.3/S5.4、§16.3 A3.9）。
 *
 * ## 这一层补的是哪一格
 *
 * core 的 `project/analysis`（跨文件重名 / LayerPolicy 分桶 / `@织` 接管与压盖）与
 * `project/weave-layers`（逐监听块的层读数 / 能力检查 / 被压链）都已经是纯函数，但它们只吃
 * **事实**、只吐**纯数据**：不知道文件 URI、不读盘、不产 `EditorProblem`。宿主要在整项目扫描
 * 这一轮里把它们跑起来，需要有人把「盘上文本 → AST → 事实 → 诊断 → 问题面板行」串成一条线。
 * 这个文件就是那一条线，且**只此一条**。
 *
 * ## 三层分工（本文件只做第 2、3 层）
 *
 * 1. core（`@kojo/kojo-core`）：`lex` / `parse` → `collectFileFacts` / `analyzeProject` /
 *    `analyzeWeaveLayers` / `planStorageSlots`。判定口径全在那边，本文件**不重写任何判定**。
 * 2. {@link analyzeKojo2Project}：纯逻辑（零 IO、零 Monaco、零 React）。吃
 *    `{ path, text }[]`，出 `{ problems, problemsByPath, weaveUnits, stats }`。
 * 3. {@link collectKojo2ProjectDocuments}：**唯一**的 IO 面（列举 / 读文本全部注入），
 *    给不需要复用「扫描器已读文本」的调用方用；扫描器那一轮直接喂第 2 层，**不二次读盘**。
 *
 * ## 口径（逐条决策，供审阅）
 *
 * 1. **`问题` 形状与既有面板逐字段同款**：{@link toEditorProblem} 把 core 的
 *    `{ code, severity, message, span }` 映射成 `problem-store.EditorProblem`——**码原样**
 *    （不加工、不加前缀）、severity 只做 error/warning 两档映射（意外值按 error，
 *    fail-visible，与 `monaco/kojo2-diagnostics` 同一条纪律）、落点只取同行列区间
 *    （跨行/无落点退化成行级信息，退化判据仍归 `monaco/reveal-position`）。
 * 2. **织面口径单一**（不双报）：注入 adapter 事实时，`@织` 的判定**只归**
 *    `analyzeWeaveLayers`（它按事件读优先级模型、`weavable`、overlay 政策，比
 *    `analyzeProject` 的全局事件目录更精确），`analyzeProject` 只吃函数与声明；
 *    adapter 缺席时织面退回 `analyzeProject`（没有事件目录就**不判**未知事件——不猜）。
 *    同一条结论无论从哪条腿出，都只上账一次。
 * 3. **每份文件自己的词法/语法诊断一起带上**：整项目扫描是**未打开文件**唯一的诊断来源，
 *    只报跨文件结论会让一份语法写坏的文件在面板里显示成「干净」（假真相）。
 * 4. **存储期**：`# 变量` 采成 `StorageDeclarationFact` 后走 core `planStorageSlots`
 *    （槽位区段缺省用 `kojo2-storage-registry` 的预览口径，真项目由调用方注入 adapter 事实；
 *    声明键缺省 `path#行:列`，与那份注册表同一缺省）。**默认不传旧账本** ⇒ 只做「同名/同键」
 *    这类当前事实能判的检查；换盘 / 改型 / 搬槽这些跨构建判据必须有旧快照才成立，调用方
 *    要就自己注入 `previousSnapshot`。
 * 5. **返回路径（`core/func/*`）不在这里判**：那不是从 AST 能猜出来的（要 C2/语义层的
 *    `hasValueReturn` / `allPathsReturn` 事实）。缺口见本模块末尾的说明，**不伪造**。
 * 6. **确定性**：问题按（severity → path → line → 列 → code → message）排序，同一份输入
 *    无论文件以何种顺序注入，输出逐条相同；重复项按（path, 落点, code）去重——同一处同一个码
 *    只留一条，项目层先入（它的文案更完整）。项目层已判过的「文件 → 行 → 码」还会压掉
 *    该文件自己的同码同处诊断（parser 与项目层对同一处各说一遍是纯噪声）。
 *
 * ## 插件边界（本批的硬边界）
 *
 * 2.0 的项目级结论**只经本模块输出**。v1 插件（`convention-linter` /
 * `condition-extractor` / `erb-parser` …）对 `.kojo2` 一无所知，也不该知道：它们不进
 * 这条链路、不感知这里产出的任何一条结论，本模块也**不 import 任何插件包**。
 * 扫描器把 v1 那一路的结果与本模块的结果**合并**后经同一个 `publish` 上账——插件侧零改动。
 *
 * ## 性能
 *
 * 解析（`lex + parse`）与判定分开计时（{@link Kojo2ProjectTiming}）。判定段的量级与
 * core `tests/project.bench.test.ts` 同一口径（万级 `@函` 数十毫秒）；解析段随文本量线性，
 * 由调用方决定是否按轮上限截断。扫描器只在 `.kojo2` 文件上走这条路，`.kojo` 与本模块无关。
 *
 * ## 惰性 adapter（K2-PROJECT-WIRE）
 *
 * 生产宿主的 adapter 住在插件包里，若在模块求值 / 装配那一刻静态取用，就会把整包拽进开机图。
 * 因此扫描装配面（{@link Kojo2ProjectPassOptions.adapter}）接受**惰性 getter**：
 * {@link analyzeKojo2ProjectAsync} 在判定前 `await` 一次（每个 getter 实例只求值一次，
 * 结果与失败都缓存），拿到事实再走同步判定。解析失败（抛错 / 拒绝 / 返回 `undefined`）
 * **不炸、不静默**：`stats.adapterUnavailable = true`，第一次失败经 `onAdapterUnavailable`
 * （缺省 `console.warn`）给一条可见读数，分析照常跑——织面退回 `analyzeProject` 的既有路径。
 *
 * 同步入口 {@link analyzeKojo2Project} 仍然只吃事实对象：它的调用方（测试 / 纯逻辑复用）
 * 不需要为异步买单，`adapterUnavailable` 恒 `false`。
 */
import {
  analyzeProject,
  analyzeWeaveLayers,
  collectFileFacts,
  collectIntegerConstants,
  lex,
  parse,
  planStorageSlots,
} from '@kojo/kojo-core';
import type {
  KojoConstDecl,
  KojoDiagnostic,
  KojoFile,
  KojoSpan,
  KojoValueType,
  KojoVarStorage,
  LayerPolicyFacts,
  ProjectDeclarationFact,
  ProjectFunctionFact,
  ProjectWeaveFact,
  SlotClassSpec,
  SlotRegistrySnapshot,
  StorageDeclarationFact,
  WeaveLayerAdapterFacts,
  WeaveLayerDocument,
  WeaveLayerUnit,
} from '@kojo/kojo-core';
import { isUnderPath, pkey } from './file-tree-ops';
import { isKojo2Path } from './kojo2-open';
import type { EditorProblem } from './problem-store';
import {
  KOJO2_STORAGE_DEFAULT_CLASSES,
  KOJO2_STORAGE_DEFAULT_FINGERPRINT,
  KOJO2_STORAGE_DEFAULT_PROJECT_URI,
} from './kojo2-storage-registry';

/* ============================== 稳定标签与码 ============================== */

/** 问题面板里的来源标签（`EditorProblem.source`；与实时那一簇的 `Kojo 2.0` 区分开） */
export const KOJO2_PROJECT_SOURCE = 'Kojo 2.0 项目级';

/**
 * 本模块自己的失败码（**不是 core 码**）：某份文件连解析都进不去，项目级结论因此不完整。
 *
 * 用 `kojo2/` 前缀与 `kojo2-problem-wiring` 的 `kojo2/diagnostics-unavailable` 同族：
 * 一眼看出这是工具链自己的事，不是作者源码的语义错误。
 */
export const KOJO2_PROJECT_FAILURE_CODE = 'kojo2/project-analysis-failed';

/**
 * 项目级（无单一声明/监听可指）问题的虚拟落点。
 *
 * 与存储注册表的 `KOJO2_STORAGE_DEFAULT_PROJECT_URI` 是同一个 URI：两处都表示「这属于整个
 * 项目，不属于某一行」。扫描器会把它当作一格单独上账（不悄悄丢掉），面板里因此看得见
 * 「这条不是某个文件的错」。
 */
export const KOJO2_PROJECT_PROBLEM_PATH: string = KOJO2_STORAGE_DEFAULT_PROJECT_URI;

/* ============================== 输入 / 输出契约 ============================== */

/** 一份待分析的 `.kojo2` 文档（文本由调用方给；`layerId` 缺省 = 基座层） */
export interface Kojo2ProjectDocument {
  readonly path: string;
  readonly text: string;
  /** overlay 覆盖层标识（翻译 / 多版本）；缺省 = 基座层（与 core 同口径） */
  readonly layerId?: string;
}

/** adapter 事实（与 core `WeaveLayerAdapterFacts` 同形；真实 `GameAdapter` 结构上直接满足） */
export type Kojo2ProjectAdapterFacts = WeaveLayerAdapterFacts;

/**
 * 惰性 adapter getter：宿主在这里接动态 `import()`（不进开机静态图）。
 *
 * 三种返回都合法：事实 = 本轮拿得到；`undefined` = 拿不到（缺席，走降级）；
 * `Promise` = 异步装载（本模块 `await` 一次并缓存结果，不会逐文件重复求值）。
 */
export type Kojo2ProjectAdapterGetter = () =>
  | Kojo2ProjectAdapterFacts
  | undefined
  | Promise<Kojo2ProjectAdapterFacts | undefined>;

/** 装配面接受的 adapter 形态：直接给事实（测试 / 已是同步事实）或惰性 getter */
export type Kojo2ProjectAdapterInput = Kojo2ProjectAdapterFacts | Kojo2ProjectAdapterGetter;

/**
 * 一次 adapter 解析的读数。
 *
 * - `unavailable`：**给了 getter 但没拿到事实**（抛错 / 拒绝 / 返回 undefined）；
 *   与「压根没配 adapter」区分开——后者是 `unavailable:false` + `facts:undefined`。
 * - `reason`：失败原因（仅 `unavailable` 时有）。
 * - `lazy`：这次是否走了 getter（false = 直接给的事实 / 未配置）。
 */
export interface Kojo2ProjectAdapterResolution {
  readonly facts: Kojo2ProjectAdapterFacts | undefined;
  readonly unavailable: boolean;
  readonly reason: string | null;
  readonly lazy: boolean;
}

/** 存储期声明的稳定键入参（与 `kojo2-storage-registry` 同一形状，便于宿主复用同一把账本键） */
export interface Kojo2ProjectStorageKey {
  readonly path: string;
  readonly name: string;
  readonly storage: KojoVarStorage;
  readonly valueType: KojoValueType;
  readonly arraySize: number | null;
  readonly line: number;
  readonly column: number;
}

/** 存储期分析的注入面（全部可选；缺省 = 预览口径 + 无旧账本） */
export interface Kojo2ProjectStorageOptions {
  /** adapter 的槽位区段（缺省 {@link KOJO2_STORAGE_DEFAULT_CLASSES}，只配预览/测试） */
  readonly classes?: readonly SlotClassSpec[];
  /** adapter 的游戏指纹（缺省 {@link KOJO2_STORAGE_DEFAULT_FINGERPRINT}） */
  readonly gameFingerprint?: string;
  /** 上一次已提交的槽位账本（给出后才做换盘 / 改型 / 搬槽检测；缺省 null） */
  readonly previousSnapshot?: SlotRegistrySnapshot | null;
  /** 声明键（缺省 `path#行:列`；真项目注入编辑器账本的跨构建稳定键） */
  readonly declarationKey?: (input: Kojo2ProjectStorageKey) => string;
}

export interface Kojo2ProjectAnalysisInput {
  readonly documents: readonly Kojo2ProjectDocument[];
  /** adapter 事实；缺席 = 织面退回 `analyzeProject`（不判未知事件 / 优先级模型） */
  readonly adapter?: Kojo2ProjectAdapterFacts;
  readonly storage?: Kojo2ProjectStorageOptions;
  /** 解析入口（缺省 core `parse(lex(text))`；测试可注入桩以隔离词法开销） */
  readonly parse?: (text: string) => KojoFile;
  /** 项目级问题的虚拟落点（缺省 {@link KOJO2_PROJECT_PROBLEM_PATH}） */
  readonly projectPath?: string;
  /** 计时时钟（缺省 `performance.now`；测试可注入假时钟） */
  readonly now?: () => number;
}

/**
 * 异步入口的输入面：与 {@link Kojo2ProjectAnalysisInput} 只差 `adapter` 允许惰性形态，
 * 外加一条失败读数通道。同步入口保持只吃事实——不给既有 37 条判据添 await。
 */
export interface Kojo2ProjectAsyncAnalysisInput extends Omit<Kojo2ProjectAnalysisInput, 'adapter'> {
  /** 事实对象或惰性 getter（getter 每个实例只求值一次；失败走降级） */
  readonly adapter?: Kojo2ProjectAdapterInput;
  /**
   * 惰性 adapter **第一次**解析失败时的可见读数（缺省 = `console.warn` 一行）。
   * 同一条 getter 的失败只报一次（后续轮次命中缓存，不再刷屏）。
   */
  readonly onAdapterUnavailable?: (reason: string) => void;
}

/** 判定两段的计时读数（毫秒；两段都含映射与去重，`parseMs + analyzeMs ≈ totalMs`） */
export interface Kojo2ProjectTiming {
  readonly parseMs: number;
  readonly analyzeMs: number;
  readonly totalMs: number;
}

export interface Kojo2ProjectStats {
  /** 参与分析的文档数（按路径归一后去重） */
  readonly documents: number;
  /** 解析抛错的文档数（这些文件没有参与跨文件判定） */
  readonly failedDocuments: number;
  readonly functions: number;
  readonly weaves: number;
  readonly declarations: number;
  readonly storageDeclarations: number;
  /** `analyzeProject` 产出的诊断数 */
  readonly projectDiagnostics: number;
  /** `analyzeWeaveLayers` 产出的冲突数（adapter 缺席时恒 0） */
  readonly layerConflicts: number;
  /** `planStorageSlots` 产出的诊断数 */
  readonly storageDiagnostics: number;
  /** 最终上账的问题条数（去重、排序后） */
  readonly problems: number;
  /** 逐监听块判定表条数（adapter 缺席时恒 0） */
  readonly weaveUnits: number;
  /** 织面是否走了 `analyzeWeaveLayers`（false = adapter 缺席，能力检查未跑） */
  readonly weaveLayers: boolean;
  /**
   * 惰性 adapter 是否解析失败（抛错 / 拒绝 / 返回 undefined）。
   *
   * `true` ⇒ 本轮**没有** adapter 事实，织面退回 `analyzeProject`；`false` 既覆盖
   * “拿到事实”，也覆盖“压根没配 adapter”（未配置不是失败）。同步入口恒 `false`。
   */
  readonly adapterUnavailable: boolean;
  readonly timing: Kojo2ProjectTiming;
}

export interface Kojo2ProjectAnalysisResult {
  /** 全部问题（按 severity → path → line → 列 → code → message 排序；跨文件结论在此） */
  readonly problems: readonly EditorProblem[];
  /**
   * 同一份问题的按文件分桶（扫描器据此与本文件的 v1 诊断合并后**一次** publish）。
   * 项目级问题落在 {@link KOJO2_PROJECT_PROBLEM_PATH} 这一格上（不丢、也不冒充某个文件）。
   */
  readonly problemsByPath: ReadonlyMap<string, readonly EditorProblem[]>;
  /** 逐监听块的判定表（`effective` / `takeover` / `shadowed` / `blocked`） */
  readonly weaveUnits: readonly WeaveLayerUnit[];
  readonly stats: Kojo2ProjectStats;
}

/** 扫描器装配面（= {@link Kojo2ProjectAnalysisInput} 去掉文档，加启用判据与读数回调） */
export interface Kojo2ProjectPassOptions {
  /** 启用判据（缺省 = 给了这个对象就启用；生产接 `kojo2DiagnosticsEnabled`） */
  readonly enabled?: () => boolean;
  /** `.kojo2` 判据（缺省 {@link isKojo2Path}） */
  readonly isKojo2?: (path: string) => boolean;
  /**
   * adapter 事实或**惰性 getter**（生产接动态 `import()`；见 {@link Kojo2ProjectAdapterInput}）。
   * getter 每个实例只求值一次，失败不炸（`stats.adapterUnavailable` + 一次可见读数）。
   */
  readonly adapter?: Kojo2ProjectAdapterInput;
  /** 惰性 adapter 第一次不可用时的可见读数（缺省 `console.warn`；宿主接通知通道时注入） */
  readonly onAdapterUnavailable?: (reason: string) => void;
  readonly storage?: Kojo2ProjectStorageOptions;
  readonly parse?: (text: string) => KojoFile;
  readonly projectPath?: string;
  readonly now?: () => number;
  /** 路径 → overlay 层标识（缺省 = 基座层；翻译 / 多版本项目由宿主注入） */
  readonly layerOf?: (path: string) => string | undefined;
  /** 计时读数出口（宿主接 perf / 日志；缺省由扫描器打印一行，见 `project-diagnostics`） */
  readonly onTiming?: (timing: Kojo2ProjectTiming) => void;
}

/* ============================== 收集（唯一 IO 面） ============================== */

export interface Kojo2ProjectSkipped {
  readonly path: string;
  readonly reason: string;
}

export interface Kojo2ProjectCollectDeps {
  /** 待办清单（宿主接 `ErbIndex.files.keys()` / `walkDialectPaths`；本模块不认识内核） */
  readonly listFiles: () => readonly string[] | Promise<readonly string[]>;
  /** 只读文本（内核 io；本模块没有任何写路径） */
  readonly readFile: (path: string) => Promise<string>;
  /**
   * 允许读的根（与扫描器同一把尺子：`file-tree-ops.isUnderPath`）。
   * 缺省 = 不在这里过滤（调用方已把清单收在允许域内）；**空数组 = 什么都不读**（fail-closed）。
   */
  readonly roots?: () => readonly string[];
  /** `.kojo2` 判据（缺省 {@link isKojo2Path}） */
  readonly isKojo2?: (path: string) => boolean;
  /** 启用判据（缺省 = 启用；false 时连 `listFiles` 都不调） */
  readonly enabled?: () => boolean;
  /** 本轮最多读几份（0/缺省 = 不限；截断发生在排序之后 ⇒ 反复跑取到同一段） */
  readonly maxFiles?: number;
  /** 路径 → overlay 层标识（缺省 = 基座层；与扫描器装配面同一个注入点） */
  readonly layerOf?: (path: string) => string | undefined;
  /** 读不动 / 解码失败的文件（**可见降级**：跳过也要说得出是哪一份） */
  readonly onSkipped?: (info: Kojo2ProjectSkipped) => void;
}

export interface Kojo2ProjectCollectionStats {
  readonly listed: number;
  /** 命中 `.kojo2` 且在允许域内的去重路径数（截断前） */
  readonly considered: number;
  readonly read: number;
  readonly skipped: number;
  /** 越界（不在允许根内）被拒读的路径数 */
  readonly outOfRoots: number;
  /** 撞到 `maxFiles` 上限 ⇒ 这份清单不完整 */
  readonly capped: boolean;
}

export interface Kojo2ProjectCollection {
  /** 这一趟到底跑没跑（false = 开关关，一个端口都没碰） */
  readonly enabled: boolean;
  readonly documents: readonly Kojo2ProjectDocument[];
  readonly stats: Kojo2ProjectCollectionStats;
}

const EMPTY_COLLECTION_STATS: Kojo2ProjectCollectionStats = {
  listed: 0,
  considered: 0,
  read: 0,
  skipped: 0,
  outOfRoots: 0,
  capped: false,
};

/**
 * 收集项目内的 `.kojo2` 文档（**唯一 IO 面**：列举 / 读文本 / 允许根全部注入）。
 *
 * 纪律：
 * - 开关关 ⇒ 直接返回 `enabled:false`，`listFiles` / `readFile` **一次都不调**（零动作）；
 * - 允许根为空 ⇒ 一份都不读（与扫描器 `filterInsideRoots` 同一条 fail-closed）；
 * - 路径去重按 `pkey`（Windows 两种写法是同一个文件，读两遍算两遍就是造假账）；
 * - 截断发生在排序之后（同一份输入反复跑取到同一段，不是随机的一把）；
 * - 单文件读炸只跳该文件（`skipped++` + `onSkipped` 点名），不带走整趟。
 */
export async function collectKojo2ProjectDocuments(
  deps: Kojo2ProjectCollectDeps,
): Promise<Kojo2ProjectCollection> {
  const enabled = deps.enabled === undefined ? true : deps.enabled() === true;
  if (!enabled) return { enabled: false, documents: [], stats: EMPTY_COLLECTION_STATS };

  const listed = await deps.listFiles();
  const is2 = deps.isKojo2 ?? isKojo2Path;
  const roots = deps.roots?.() ?? null;
  const considered = new Set<string>();
  const candidates: string[] = [];
  let outOfRoots = 0;

  for (const path of listed) {
    if (typeof path !== 'string' || path.length === 0) continue;
    if (!is2(path)) continue;
    if (roots !== null && (roots.length === 0 || !roots.some((root) => isUnderPath(root, path)))) {
      outOfRoots++;
      continue;
    }
    const key = pkey(path);
    if (considered.has(key)) continue;
    considered.add(key);
    candidates.push(path);
  }
  candidates.sort(compareText);

  const maxFiles = Math.max(0, Math.floor(deps.maxFiles ?? 0));
  const capped = maxFiles > 0 && candidates.length > maxFiles;
  const chosen = capped ? candidates.slice(0, maxFiles) : candidates;

  const documents: Kojo2ProjectDocument[] = [];
  let skipped = 0;
  for (const path of chosen) {
    try {
      const text = await deps.readFile(path);
      const layerId = deps.layerOf?.(path);
      documents.push({ path, text, ...(layerId === undefined ? {} : { layerId }) });
    } catch (thrown) {
      skipped++;
      deps.onSkipped?.({ path, reason: messageOf(thrown) });
    }
  }

  return {
    enabled: true,
    documents,
    stats: {
      listed: listed.length,
      considered: considered.size,
      read: documents.length,
      skipped,
      outOfRoots,
      capped,
    },
  };
}

/* ============================== 问题映射 ============================== */

/** 一条可映射的事实（core `KojoDiagnostic` 与 `weave-layers` 的结构化事实都满足） */
export interface Kojo2ProblemFact {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly span: KojoSpan | null;
}

/** 严重级别权重（与 `problem-store.sortProblems` 同序：error → warning → info） */
const SEVERITY_RANK: Readonly<Record<EditorProblem['severity'], number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * core 诊断 → 既有面板行（`EditorProblem`）。
 *
 * - **码原样**：不加工、不改名、不加前缀（面板过滤 / 快速修复都按它认）；
 * - **severity**：core 只有 error / warning 两档；意外值按 error（fail-visible，不悄悄降成提示）；
 * - **落点**：`span` 只在同一行时给出列区间（与 `project-diagnostics.toEditorProblem` /
 *   `kojo2ProblemsOf` 同一条退化口径）；跨行 / 无落点只保留行号（缺 span 退到文件头第 1 行）；
 * - **source**：{@link KOJO2_PROJECT_SOURCE}——面板要说得出「这条是谁报的」。
 */
export function toEditorProblem(path: string, fact: Kojo2ProblemFact): EditorProblem {
  const span = fact.span;
  const line = span === null ? 1 : span.start.line;
  const columns =
    span !== null && span.start.line === span.end.line && span.end.column > span.start.column
      ? { columnStart: span.start.column, columnEnd: span.end.column }
      : undefined;
  return {
    path,
    line,
    ...(columns === undefined ? {} : { span: columns }),
    severity: fact.severity === 'warning' ? 'warning' : 'error',
    message: fact.message,
    code: fact.code,
    source: KOJO2_PROJECT_SOURCE,
  };
}

/* ============================== 内部工具 ============================== */

const defaultNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/**
 * 码元序比较（与 core 项目层内部同一口径：`<` / `>` 直比，不用 `localeCompare`）。
 *
 * core 没有把这个小比较器放进公共入口（只有 `comparePositions` 是公开面），这里补一份
 * 三行的实现；判据仍是"码元序、locale 无关、确定性"，与 core 排序结果不冲突。
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 缺省解析：core 公共入口（词法 + 文法；零 IO） */
const coreParse = (text: string): KojoFile => parse(lex(text));

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/* ============================== 惰性 adapter ============================== */

/**
 * 解析结果缓存：键是 getter 本身（`WeakMap` ⇒ getter 被回收后缓存跟着走）。
 *
 * 为什么按 getter 而不按"这一轮"缓存：生产 getter 里是动态 `import()` + 事实对象，
 * 每轮（约 60s）重新求值一次纯属白烧主线程；同一个 getter 的生命周期就是"装一次 adapter"。
 * 失败也缓存（同一条 getter 失败一次就够了：宿主换 adapter 时换 getter 实例即可重试）。
 */
const adapterResolutions = new WeakMap<
  Kojo2ProjectAdapterGetter,
  Promise<Kojo2ProjectAdapterResolution>
>();

/** 已经报过"不可用"的 getter（失败只给一条可见读数，不按轮刷屏） */
const adapterWarned = new WeakSet<Kojo2ProjectAdapterGetter>();

/** 缺省可见读数：一行警告；宿主想要面板提示就注入 `onAdapterUnavailable` */
function warnAdapterUnavailable(reason: string): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[kojo2 项目级] adapter 不可用：${reason}；织面退回 analyzeProject（本轮不判未知事件 / 优先级模型），` +
      '其余跨文件结论照常出。',
  );
}

/**
 * 把装配面的 adapter 形态解析成事实（惰性 getter 只 `await` 一次，失败折成 `unavailable`）。
 *
 * **永不 reject**：getter 抛错 / 拒绝 / 返回 `undefined` 都归一成 `unavailable:true`，
 * 由调用方照常跑"无 adapter"路径。这是本模块唯一会为 adapter 让出执行权的地方。
 */
export async function resolveKojo2ProjectAdapter(
  adapter: Kojo2ProjectAdapterInput | undefined,
  onUnavailable?: (reason: string) => void,
): Promise<Kojo2ProjectAdapterResolution> {
  if (adapter === undefined) {
    return { facts: undefined, unavailable: false, reason: null, lazy: false };
  }
  if (typeof adapter !== 'function') {
    return { facts: adapter, unavailable: false, reason: null, lazy: false };
  }

  const cached = adapterResolutions.get(adapter);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<Kojo2ProjectAdapterResolution> => {
    let reason: string;
    try {
      const facts = await adapter();
      if (facts !== undefined) {
        return { facts, unavailable: false, reason: null, lazy: true };
      }
      reason = 'getter 返回 undefined';
    } catch (thrown) {
      reason = messageOf(thrown);
    }
    if (!adapterWarned.has(adapter)) {
      adapterWarned.add(adapter);
      try {
        (onUnavailable ?? warnAdapterUnavailable)(reason);
      } catch {
        // 读数通道自己炸了不该把"降级"升级成"整轮失败"：stats 仍然会置位。
      }
    }
    return { facts: undefined, unavailable: true, reason, lazy: true };
  })();

  adapterResolutions.set(adapter, pending);
  return pending;
}

/** 问题去重键：同一（文件, 落点, 码）只上账一次（跨来源的同一条结论不翻倍，文案以先入者为准） */
function problemKey(problem: EditorProblem): string {
  const start = problem.span?.columnStart ?? 0;
  const end = problem.span?.columnEnd ?? 0;
  return `${problem.path}\u0000${problem.line}\u0000${start}:${end}\u0000${problem.code ?? ''}`;
}

/** 排序口径：与 `problem-store.sortProblems` 同序（severity → path → line），再按列 / 码 / 文案 */
function compareProblems(a: EditorProblem, b: EditorProblem): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    compareText(a.path, b.path) ||
    a.line - b.line ||
    (a.span?.columnStart ?? 0) - (b.span?.columnStart ?? 0) ||
    compareText(a.code ?? '', b.code ?? '') ||
    compareText(a.message, b.message)
  );
}

interface ParsedDocument {
  readonly document: Kojo2ProjectDocument;
  readonly file: KojoFile;
}

/** 定位事实的最小面（函数 / 监听 / 声明都满足） */
interface FactLocation {
  readonly filePath: string;
  readonly span: KojoSpan | null;
}

/** `key = 行:列` → 该坐标上出现过事实的文件（去重、注入序）；用于把无路径诊断挂回文件 */
function buildLocationIndex(locations: readonly FactLocation[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const location of locations) {
    if (location.span === null) continue;
    const key = `${location.span.start.line}:${location.span.start.column}`;
    const list = index.get(key);
    if (list === undefined) index.set(key, [location.filePath]);
    else if (!list.includes(location.filePath)) list.push(location.filePath);
  }
  return index;
}

/**
 * 无路径诊断（core 只给 span）→ 落哪份文件。
 *
 * 先按「起点行:列」找候选事实；多个文件在同一坐标都有事实时，用**消息里最先出现的路径**
 * 消歧——core 的 `formatLocation` 逐字把 `路径:行:列` 写进文案（与存储注册表同一条判据）。
 * 一个候选都没有 ⇒ 归项目级虚拟落点（不硬塞给某一份文件）。
 */
function resolveFactPath(
  diagnostic: KojoDiagnostic,
  index: ReadonlyMap<string, readonly string[]>,
  projectPath: string,
): string {
  const span = diagnostic.span;
  if (span === null) return projectPath;
  const candidates = index.get(`${span.start.line}:${span.start.column}`);
  if (candidates === undefined || candidates.length === 0) return projectPath;
  const first = candidates[0];
  if (first === undefined) return projectPath;
  if (candidates.length === 1) return first;
  let best = first;
  let bestIndex = diagnostic.message.indexOf(best);
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const at = diagnostic.message.indexOf(candidate);
    if (at >= 0 && (bestIndex < 0 || at < bestIndex)) {
      best = candidate;
      bestIndex = at;
    }
  }
  return best;
}

/** 函数层模式：精确规则 → defaultMode（与 core `weave-layers` 同一条解析顺序） */
function functionLayerPolicy(adapter: Kojo2ProjectAdapterFacts): LayerPolicyFacts {
  const rule = adapter.layerPolicy.rules.find((entry) => entry.target === 'function');
  return { mode: rule?.mode ?? adapter.layerPolicy.defaultMode };
}

/** 数组长度端点：十进制整数直取，`# 常量` 端点按同文件常量表静态求值；其余 → null（不猜） */
function resolveArraySize(text: string | null, constants: ReadonlyMap<string, number>): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (/^\d+$/u.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : null;
  }
  const value = constants.get(trimmed);
  return value === undefined ? null : value;
}

/** 声明键缺省（与 `kojo2-storage-registry` 同一缺省：无账本时的近似，改名不搬槽、搬行会搬槽） */
function defaultDeclarationKey(input: Kojo2ProjectStorageKey): string {
  return `${input.path}\u0000${input.line}:${input.column}`;
}

interface StorageHarvest {
  readonly facts: readonly StorageDeclarationFact[];
  readonly classes: readonly SlotClassSpec[];
  readonly gameFingerprint: string;
  readonly previousSnapshot: SlotRegistrySnapshot | null;
}

/**
 * 从已解析文档采集存储期声明事实。
 *
 * 单元边界（`unitId`）取**文件路径**——与 `kojo2-storage-registry` 的缺省同口径：
 * `场景` 变量的真单元是 `# 机` / `@织` 监听块，而 core 的 AST 是扁平声明表（块体是叙事节点，
 * 不含声明），从它推不出可靠的块边界；给文件级单元是**保守**的（宁可把同一文件的不同块
 * 当成同一单元多报一条同名，也不把两个不同单元的同名错判成合法）。
 */
function harvestStorageFacts(
  parsed: readonly ParsedDocument[],
  options: Kojo2ProjectStorageOptions | undefined,
): StorageHarvest {
  const keyOf = options?.declarationKey ?? defaultDeclarationKey;
  const facts: StorageDeclarationFact[] = [];
  for (const { document, file } of parsed) {
    const constants = collectIntegerConstants(
      file.decls.filter((decl): decl is KojoConstDecl => decl.kind === 'const'),
    );
    for (const decl of file.decls) {
      if (decl.kind !== 'var') continue;
      const arraySize = resolveArraySize(decl.arraySize?.text ?? null, constants);
      const key = keyOf({
        path: document.path,
        name: decl.name,
        storage: decl.storage,
        valueType: decl.valueType,
        arraySize,
        line: decl.span.start.line,
        column: decl.span.start.column,
      });
      facts.push({
        key,
        storage: decl.storage,
        name: decl.name,
        valueType: decl.valueType,
        arraySize,
        filePath: document.path,
        span: decl.span,
        ...(decl.storage === 'scene' ? { unitId: document.path } : {}),
      });
    }
  }
  return {
    facts,
    classes: options?.classes ?? KOJO2_STORAGE_DEFAULT_CLASSES,
    gameFingerprint: options?.gameFingerprint ?? KOJO2_STORAGE_DEFAULT_FINGERPRINT,
    previousSnapshot: options?.previousSnapshot ?? null,
  };
}

/** 存储期事实的规范序：文件路径 → 起点（无落点排最后）→ 声明键。判定前先归位，输入顺序无关 */
function compareStorageFacts(a: StorageDeclarationFact, b: StorageDeclarationFact): number {
  const byPath = compareText(a.filePath, b.filePath);
  if (byPath !== 0) return byPath;
  const aLine = a.span === null ? Number.MAX_SAFE_INTEGER : a.span.start.line;
  const bLine = b.span === null ? Number.MAX_SAFE_INTEGER : b.span.start.line;
  if (aLine !== bLine) return aLine - bLine;
  const aColumn = a.span === null ? Number.MAX_SAFE_INTEGER : a.span.start.column;
  const bColumn = b.span === null ? Number.MAX_SAFE_INTEGER : b.span.start.column;
  if (aColumn !== bColumn) return aColumn - bColumn;
  return compareText(a.key, b.key);
}

/** 存储期诊断（core 只给 span，无 filePath）→ 落哪份文件；判据与 `resolveFactPath` 同源 */
function storageFactPath(
  diagnostic: KojoDiagnostic,
  facts: readonly StorageDeclarationFact[],
  projectPath: string,
): string {
  const span = diagnostic.span;
  if (span === null) return projectPath;
  const candidates: string[] = [];
  for (const fact of facts) {
    if (fact.span === null) continue;
    if (fact.span.start.line !== span.start.line) continue;
    if (fact.span.start.column !== span.start.column) continue;
    if (!candidates.includes(fact.filePath)) candidates.push(fact.filePath);
  }
  const first = candidates[0];
  if (first === undefined) return projectPath;
  if (candidates.length === 1) return first;
  let best = first;
  let bestIndex = diagnostic.message.indexOf(best);
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const at = diagnostic.message.indexOf(candidate);
    if (at >= 0 && (bestIndex < 0 || at < bestIndex)) {
      best = candidate;
      bestIndex = at;
    }
  }
  return best;
}

/* ============================== 主入口 ============================== */

/**
 * 项目内 `.kojo2` 文档 → 跨文件结论（纯函数：零 IO、零 Monaco、零 React）。
 *
 * 流程：解析 → 事实（函数 / 监听 / 声明 / 存储期）→ `analyzeProject`（+ adapter 在时
 * `analyzeWeaveLayers`、`planStorageSlots`）→ 映射成 `EditorProblem` → 去重排序。
 *
 * 单份文件解析抛错**只跳该文件**（`failedDocuments++` 并上账一条可见的失败问题），
 * 其余文档照常出结论；编程性异常（例如调用方注入的 `declarationKey` 抛错）**不吞**——
 * 由调用方（扫描器）决定怎么降级，这样"少一路结论"不会被静默当成"项目干净"。
 */
export function analyzeKojo2Project(input: Kojo2ProjectAnalysisInput): Kojo2ProjectAnalysisResult {
  const now = input.now ?? defaultNow;
  const parseDocument = input.parse ?? coreParse;
  const projectPath = input.projectPath ?? KOJO2_PROJECT_PROBLEM_PATH;
  const startedAt = now();

  /* ---- 1) 解析：同一路径只收一份（身份唯一；重复注入不该造出假重名） ---- */
  const parsed: ParsedDocument[] = [];
  const parseProblems: EditorProblem[] = [];
  const seenPaths = new Set<string>();
  let failedDocuments = 0;
  for (const document of input.documents) {
    const identity = pkey(document.path);
    if (seenPaths.has(identity)) continue;
    seenPaths.add(identity);
    try {
      parsed.push({ document, file: parseDocument(document.text) });
    } catch (thrown) {
      failedDocuments++;
      parseProblems.push(
        toEditorProblem(document.path, {
          code: KOJO2_PROJECT_FAILURE_CODE,
          severity: 'error',
          message:
            `Kojo 2.0 项目级分析无法解析这份文件：${messageOf(thrown)}` +
            '（它没有参与跨文件判定，修好前项目级结论不完整）',
          span: null,
        }),
      );
    }
  }
  const parsedAt = now();

  /* ---- 2) 事实：只读 AST，不重解析函数体 ---- */
  const functions: ProjectFunctionFact[] = [];
  const weaves: ProjectWeaveFact[] = [];
  const declarations: ProjectDeclarationFact[] = [];
  for (const { document, file } of parsed) {
    const facts = collectFileFacts(file, document.path, document.layerId);
    functions.push(...facts.functions);
    weaves.push(...facts.weaves);
    declarations.push(...facts.declarations);
  }
  const storage = harvestStorageFacts(parsed, input.storage);

  /* ---- 3) 判定：core 公共入口，一条都不重写 ---- */
  const adapter = input.adapter;
  const project = analyzeProject({
    functions,
    declarations,
    // 织面口径单一：adapter 在 ⇒ 归 analyzeWeaveLayers（见文件头第 2 条），否则退回这里。
    ...(adapter === undefined ? { weaves } : {}),
    ...(adapter === undefined ? {} : { policy: functionLayerPolicy(adapter) }),
  });

  const layerDocuments: WeaveLayerDocument[] = parsed.map(({ document, file }) => ({
    filePath: document.path,
    file,
    ...(document.layerId === undefined ? {} : { layerId: document.layerId }),
  }));
  const layers = adapter === undefined ? null : analyzeWeaveLayers(layerDocuments, adapter);

  // 存储期事实先归位成规范序：core 的重名判定按事实顺序认「先声明者」，顺序不定则
  // 诊断落点会随输入顺序漂（同一份项目换个文件枚举次序就换一条落点 = 假确定性）。
  const storageFacts = storage.facts.slice().sort(compareStorageFacts);
  const storagePlan = planStorageSlots(
    {
      gameFingerprint: storage.gameFingerprint,
      classes: storage.classes,
      declarations: storageFacts,
    },
    storage.previousSnapshot,
  );

  /* ---- 4) 映射 + 去重（同一条结论只上账一次；项目层先入 ⇒ 文案以它为准） ---- */
  const problems: EditorProblem[] = [];
  const seenProblems = new Set<string>();
  const push = (problem: EditorProblem): void => {
    const key = problemKey(problem);
    if (seenProblems.has(key)) return;
    seenProblems.add(key);
    problems.push(problem);
  };
  /**
   * 项目层已经判过的（文件 → 行 → 码）。文件的词法/语法诊断若撞上这三格，就**不再重复上账**：
   * 同一处同一个码在面板里出两行只是噪声（parser 的文案更短，项目层那条更完整）。
   * 反过来不成立——两枚 parser 诊断在同一行同码（不同列）照样都留，因为只有项目层参与压制。
   */
  const projectLayerLines = new Set<string>();
  const pushProjectLayer = (problem: EditorProblem): void => {
    push(problem);
    projectLayerLines.add(`${problem.path}\u0000${problem.line}\u0000${problem.code ?? ''}`);
  };

  for (const problem of parseProblems) push(problem);

  const locationIndex = buildLocationIndex([...functions, ...weaves, ...declarations]);
  for (const diagnostic of project.diagnostics) {
    pushProjectLayer(
      toEditorProblem(resolveFactPath(diagnostic, locationIndex, projectPath), diagnostic),
    );
  }

  if (layers !== null) {
    for (const conflict of layers.conflicts) {
      const primary = conflict.spans[0];
      pushProjectLayer(
        toEditorProblem(primary?.filePath ?? projectPath, {
          code: conflict.code,
          severity: conflict.severity,
          message: conflict.message,
          span: primary?.span ?? null,
        }),
      );
    }
    // 被压监听锚在**被压的那一条**上（`spans[0]` 可能是另一份文件里的接管者）
    for (const shadowed of layers.shadowed) {
      pushProjectLayer(
        toEditorProblem(shadowed.listener.filePath, {
          code: shadowed.code,
          severity: shadowed.severity,
          message: shadowed.message,
          span: shadowed.listener.span,
        }),
      );
    }
  }

  for (const diagnostic of storagePlan.diagnostics) {
    pushProjectLayer(toEditorProblem(storageFactPath(diagnostic, storageFacts, projectPath), diagnostic));
  }

  // 每份文件自己的词法/语法诊断放在**最后**：整项目扫描是未打开文件唯一的诊断来源，
  // 只报跨文件结论会让写坏的文件显示成「干净」（见文件头第 3 条）。
  for (const { document, file } of parsed) {
    for (const diagnostic of file.diagnostics) {
      const problem = toEditorProblem(document.path, diagnostic);
      if (projectLayerLines.has(`${problem.path}\u0000${problem.line}\u0000${problem.code ?? ''}`)) continue;
      push(problem);
    }
  }

  /* ---- 5) 确定性排序 + 按文件分桶 ---- */
  const ordered = problems.slice().sort(compareProblems);
  const byPath = new Map<string, EditorProblem[]>();
  for (const problem of ordered) {
    const list = byPath.get(problem.path);
    if (list === undefined) byPath.set(problem.path, [problem]);
    else list.push(problem);
  }
  const finishedAt = now();
  const totalMs = Math.max(0, finishedAt - startedAt);
  const parseMs = Math.max(0, parsedAt - startedAt);
  const analyzeMs = Math.max(0, totalMs - parseMs);

  return {
    problems: ordered,
    problemsByPath: byPath,
    weaveUnits: layers === null ? [] : layers.units,
    stats: {
      documents: parsed.length + failedDocuments,
      failedDocuments,
      functions: functions.length,
      weaves: weaves.length,
      declarations: declarations.length,
      storageDeclarations: storage.facts.length,
      projectDiagnostics: project.diagnostics.length,
      layerConflicts: layers === null ? 0 : layers.conflicts.length,
      storageDiagnostics: storagePlan.diagnostics.length,
      problems: ordered.length,
      weaveUnits: layers === null ? 0 : layers.units.length,
      weaveLayers: layers !== null,
      // 同步入口只吃事实：没有"解析失败"这一态（异步入口会按解析结果覆盖）。
      adapterUnavailable: false,
      timing: { parseMs, analyzeMs, totalMs },
    },
  };
}

/**
 * 异步入口：先解析 adapter（可能是惰性 getter），再跑与同步入口**逐行相同**的判定。
 *
 * 纪律：
 * - getter 失败**不炸、不静默**：`stats.adapterUnavailable = true` + 第一次失败一条可见读数，
 *   然后走"无 adapter"的既有路径（织面退回 `analyzeProject`，不判未知事件 / 优先级模型）。
 * - getter 每个实例只求值一次（{@link resolveKojo2ProjectAdapter} 的缓存）⇒ 扫描器每轮重跑
 *   也不会重复动态装载。
 * - `adapterUnavailable` 只表示"给了 getter 却没拿到事实"；没配 adapter 不算失败。
 */
export async function analyzeKojo2ProjectAsync(
  input: Kojo2ProjectAsyncAnalysisInput,
): Promise<Kojo2ProjectAnalysisResult> {
  const resolution = await resolveKojo2ProjectAdapter(input.adapter, input.onAdapterUnavailable);
  const result = analyzeKojo2Project({
    documents: input.documents,
    ...(resolution.facts === undefined ? {} : { adapter: resolution.facts }),
    ...(input.storage === undefined ? {} : { storage: input.storage }),
    ...(input.parse === undefined ? {} : { parse: input.parse }),
    ...(input.projectPath === undefined ? {} : { projectPath: input.projectPath }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (!resolution.unavailable) return result;
  return { ...result, stats: { ...result.stats, adapterUnavailable: true } };
}

/* ============================== 装配判据 ============================== */

/**
 * 这一轮扫描要不要跑 2.0 项目级分析。
 *
 * 三条：① 宿主给了装配面；② 装配面自己的启用判据没否；③ 不给判据 = 视为启用
 * （给了对象就是明确的意图，避免"装配了却永远不跑"的哑火）。flag 关时扫描器**连
 * `.kojo2` 判据都不调**，v1 行为逐字不变。
 */
export function kojo2ProjectPassEnabled(options: Kojo2ProjectPassOptions | undefined): boolean {
  if (options === undefined) return false;
  return options.enabled === undefined ? true : options.enabled() === true;
}

/* ==============================
 * 已知缺口（写在这里，别让下一个人以为"没报=没问题"）
 *
 * 1. `core/func/*`（返回路径）不在本模块：需要 C2 / 语义层的 `hasValueReturn` /
 *    `hasBareReturn` / `allPathsReturn` 事实（本批未接），`analyzeProject` 的 `returns`
 *    入参因此缺席 ⇒ 这两条码不会从项目扫描里出现。接的时候只加事实注入，不改口径。
 * 2. 存储期只做"当前事实能判"的检查：换盘 / 改型 / 搬槽 / 槽位区段变更要旧账本
 *    （`storage.previousSnapshot`）才成立；缺省不传 ⇒ 那几条不会报（**不是**它们永远不报）。
 * 3. 场景变量的单元边界退到文件级（原因见 `harvestStorageFacts`）：跨块同名会多报一条，
 *    等 AST 带上块边界再收紧。
 * 4. 2.0 的逐文件诊断（`semantic` / `table` / `pool` 校验）不走这里：那些属于编辑器实时
 *    那一簇与 `kojo2-storage-registry`；本模块只带 `lex + parse` 这一层。
 * ============================== */
