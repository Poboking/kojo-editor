/**
 * Kojo 2.0 **项目级符号索引**（K2-INDEX-REFS）：跨文件引用查找的纯逻辑底座。
 *
 * ## 回答什么
 *
 * 一张内存索引，吃「文件路径 + 文本」，答三件事：
 * 1. 某个名字 / 种类在**整个项目**里的出现点（`refsOf`）——源码序、去重、有上限；
 * 2. 某个名字在项目里被声明在哪些文件 / 哪一行（`declsOf`）；
 * 3. 索引里现在有哪些文件、几行、几个符号（`files` / `snapshot`）。
 *
 * 它**不读盘、不观察文件系统、不注册 provider**：文本全部由宿主喂——**项目扫描**（未打开文件，
 * 经 `ui/project-scan-schedule` 的喂养通道排队、分拍送入）与**打开中的 model**（未保存文本优先）；
 * 索引只负责建表与查询。写入方每轮把 `{ path, text }` 灌进 `updateFile`，删文件 / 关项目用
 * `removeFile`。
 *
 * ## 跨文件消费面（同一份索引）
 *
 * 引用面（`kojo2-references`）直接吃 {@link Kojo2ProjectIndex}；重命名与调用层级的跨文件口各自
 * 是一对纯函数 resolver。两者都从这同一张表映射出来，不另建索引、不另扫盘：
 * - {@link createKojo2ProjectRenameResolvers}：`declsOf` → `listFilesWithSymbol`，
 *   `getFile().text` → `readSource`；
 * - {@link createKojo2ProjectCallHierarchyResolvers}：`declsOf` → `resolveDeclaration`，
 *   `getFile().text` → `readSource`，`refsOf` → `listCallers`。
 *
 * 路径判等一律 `pkey`（分隔符折叠 + 小写），扫描侧与 model 侧两种写法落到同一格。
 *
 * ## 一把尺子（本文件最重要的纪律）
 *
 * 每份文件的符号事实直接取 {@link kojo2ReferenceSymbolsOf}（`@kojo/kojo-lang/references`）：
 * 声明表来自 `kojo2DocumentOf`（`@函 / # 对照表 / # 池 / # 模 / # 设 / # 设 / # 幕`），
 * 事件名来自同一份 `# 机` / `@织` 挂点判据，引用位来自同一套表达式扫描（插值 / 调用 /
 * 条件 / `# 对照表 由` / `@算` 体 / `@返` / `@着色` / 数组长度）。
 * 逐文件的**候选引用位**取 {@link kojo2ReferenceCandidatesOf}：同一条扫描链，唯一的放宽是
 * 不要求名字在本文件里有声明——否则"只在 A 文件声明、B 文件引用"的跨文件引用根本看不见。
 * 归属仍按本地声明种类隔离（B 文件把同名声明成变量，它就不会被算成 A 文件那张表的引用）。
 * **本文件不写第二份扫描器**——跨文件与同文件因此不可能给出两套事实。
 * LAU-B11（2026-10-31）起**查询规则也不在本文件抄第二份**：`refsOf` / `declsOf` / `symbolAt`
 * 委托 `@kojo/kojo-lang/references` 的 {@link createKojo2ReferenceFactsQueryIndex}——快照供方
 * （插件那侧）读的是同一条实现；宿主这层只剩缓存与读取路径（逐文件事实建好，查询不重扫）。
 *
 * ## 缓存与性能
 *
 * - 按**路径归一键**缓存（{@link pkey}：分隔符折叠 + 小写）。`text` 与上次逐字相同 ⇒
 *   直接命中，不重跑 `lex + parse`，也不重扫出现点；路径只改了写法（大小写 / 斜杠）而文本
 *   没变时同样命中（只换显示路径）。
 * - 单文件更新是一次 `lex + parse` + 一次全篇扫描（与 `kojo2ReferencesAt` 的代价同阶）。
 *   5k 行夹具的预算见 `tests/kojo2-project-index.perf.test.ts`（< 8ms；计时池串行跑，
 *   并行主池会互相饿红，见 `docs/PITFALLS.md` §72）。
 * - 查询不重扫源文：只遍历已建好的符号表（`refsOf` 的代价 ≈ 结果条数）。
 *
 * ## 上限
 *
 * {@link KOJO2_PROJECT_REF_LIMIT} 是**单次 `refsOf` 结果**的上限（2000）。超了按
 * "路径 → 源码序"截掉尾部并置 `truncated = true`，绝不静默少给（与同文件的
 * `KOJO2_REFERENCE_LIMIT` 同一条纪律）。`declsOf` 不设上限（声明数量级远小于引用，
 * 而且"声明被截掉"会让跳转直接错，比慢更糟）。
 *
 * ## 确定性
 *
 * 文件顺序、出现点顺序全部按**路径归一键 → 原文路径 → 行 → 列 → 角色**排，不随
 * `updateFile` 的调用顺序漂。同一份输入无论文件以什么顺序喂进来，查询结果逐条相同。
 *
 * ## 插件边界
 *
 * 零插件依赖、零内核依赖：路径判等复用宿主既有 `file-tree-ops.pkey`（与文件树同一把尺），
 * 不 import 任何 `@kojo/plugin-*`。
 */
import { pkey } from '../ui/file-tree-ops';
import type {
  Kojo2CallHierarchyCallerCandidate,
  Kojo2CallHierarchyDeclarationTarget,
  Kojo2CallHierarchyResolvers,
  Kojo2CallableDeclarationKind,
} from '@kojo/kojo-lang/call-hierarchy';
import {
  kojo2DocumentOf,
  type Kojo2DeclarationKind,
  type Kojo2Document,
} from '@kojo/kojo-lang';
// SDK-B5b 车 3（2026-10-31）：`monaco/kojo2-rename` / `kojo2-references` 两枚转发壳随批删除
// （它们的安装器已并进 `slot-service-providers.ts`），这里直接取包叶——同一份实现、同一个
// 模块图位置（原来那两枚也只是转发这两条包叶）。
import type { Kojo2RenameResolvers } from '@kojo/kojo-lang/rename';
import {
  createKojo2ReferenceFactsQueryIndex,
  kojo2ReferenceCandidatesOf,
  kojo2ReferenceSymbolsOf,
  KOJO2_PROJECT_REF_LIMIT,
  type Kojo2DocumentSymbolFacts,
  type Kojo2ReferenceCandidate,
  type Kojo2ReferenceSiteKind,
  type Kojo2ReferenceSpan,
  type Kojo2ReferenceSymbolKind,
} from '@kojo/kojo-lang/references';

/* ============================== 公共形状 ============================== */

/**
 * 单次 `refsOf` 结果的上限——**转发包那枚**（LAU-B11：查询规则与上限同住
 * `@kojo/kojo-lang/references`，宿主不再另定义第二份值；旧消费方从本模块的导入零改动）。
 */
export { KOJO2_PROJECT_REF_LIMIT };

/** 喂给索引的一份文件（文本由宿主读好；索引不碰盘） */
export interface Kojo2ProjectFileInput {
  readonly path: string;
  readonly text: string;
}

/** 一份已索引的文件（`document` / `symbols` / `candidates` 是缓存下来的同一份事实） */
export interface Kojo2ProjectIndexedFile {
  readonly path: string;
  readonly text: string;
  readonly document: Kojo2Document;
  /** 逐符号的整篇出现点（源码序、含声明位；由 `kojo2ReferenceSymbolsOf` 建） */
  readonly symbols: readonly Kojo2DocumentSymbolFacts[];
  /**
   * 该文件里**语法可证**的全部表达式 / 调用位（不要求名字在本文件有声明；
   * 由 `kojo2ReferenceCandidatesOf` 用同一套扫描器建）。
   */
  readonly candidates: readonly Kojo2ReferenceCandidate[];
  /** 该文件去重后的出现点条数（含声明位与候选表达式位；快照读数用） */
  readonly siteCount: number;
}

/** `refsOf` 的查询面 */
export interface Kojo2ProjectRefQuery {
  readonly name: string;
  readonly kind: Kojo2ReferenceSymbolKind;
  /**
   * 排除这一份文件（宿主传**当前打开的文件**路径）。
   * 同文件结果由 `kojo2ReferencesAt` 自己出，索引侧再给一遍就是重复落点。
   */
  readonly excludePath?: string;
  /**
   * 只查这一份文件（与 `excludePath` 互斥；两者同时给出时 `onlyPath` 优先）。
   * 跨文件引用位（本文件没有同名声明）要把它**本文件**的出现点也列出来时用。
   */
  readonly onlyPath?: string;
}

/** 跨文件的一条出现点 */
export interface Kojo2ProjectReference {
  readonly path: string;
  readonly span: Kojo2ReferenceSpan;
  readonly kind: Kojo2ReferenceSiteKind;
}

/** `refsOf` 的结果（`truncated` 显式告诉宿主"这是截断后的列表"） */
export interface Kojo2ProjectReferencesResult {
  readonly refs: readonly Kojo2ProjectReference[];
  readonly truncated: boolean;
}

/** 某个名字的一条声明（`declsOf` 用；`span` 是声明名字段） */
export interface Kojo2ProjectDeclaration {
  readonly path: string;
  readonly name: string;
  readonly kind: Kojo2ReferenceSymbolKind;
  readonly span: Kojo2ReferenceSpan;
}

/** "这个位置引用的是哪个项目符号"的查询（1 基行列；与 Monaco / core 同口径） */
export interface Kojo2ProjectSymbolQuery {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/**
 * 位置处的项目符号（**声明种类**）：`name` + `kind`。
 *
 * 只在"本文件没声明这个名字、但语法上确实是一处可证引用位"时用得上：它是
 * `kojo2ProjectReferencesAt` 在跨文件引用位置上的符号归属来源（本文件有同名声明时，
 * 归属由 `kojo2ReferencesAt` 自己给，不走这里）。
 */
export interface Kojo2ProjectSymbolRef {
  readonly name: string;
  readonly kind: Kojo2DeclarationKind;
}

/** 索引快照里的一份文件读数 */
export interface Kojo2ProjectSnapshotFile {
  readonly path: string;
  /** 该文件的行数（物理行，与 `kojo2DocumentOf` 同口径） */
  readonly lines: number;
  /** 该文件的符号条数（声明 + 事件；`# 幕` 同标题两幕各算一条） */
  readonly symbols: number;
  /** 该文件去重后的出现点数（含声明位） */
  readonly sites: number;
}

/** 一次 `snapshot()` 的只读读数（不暴露内部 Map；宿主可放心在遍历中继续更新索引） */
export interface Kojo2ProjectIndexSnapshot {
  /** 数据版本：只有**真正变过**的写才 +1（同文本重复喂、remove 不存在的路径都不算） */
  readonly generation: number;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly siteCount: number;
  /** 按路径归一键排序的文件读数 */
  readonly files: readonly Kojo2ProjectSnapshotFile[];
}

/** 索引的注入面（全部可选；缺省即生产口径） */
export interface Kojo2ProjectIndexOptions {
  /** 文档索引入口（缺省 `kojo2DocumentOf`；测试注入桩可数缓存命中） */
  readonly documentOf?: (source: string) => Kojo2Document;
  /**
   * 逐文件符号事实入口（缺省 `kojo2ReferenceSymbolsOf` + 已建文档索引）。
   * 只在"要接另一套等价事实"时注入；生产别换——换掉就等于换尺子。
   */
  readonly symbolsOf?: (
    source: string,
    document: Kojo2Document,
  ) => readonly Kojo2DocumentSymbolFacts[];
}

/** 项目索引句柄（纯内存；生命周期由宿主决定） */
export interface Kojo2ProjectIndex {
  /**
   * 新增 / 更新一份文件。
   *
   * - 路径为空 / 非字符串、文本非字符串 ⇒ `undefined`（不抛，索引保持原样）；
   * - 文本与上次逐字相同 ⇒ 命中缓存，**不重解析**（只改路径写法时也只换显示路径）；
   * - 解析抛错 ⇒ `undefined`；若这个路径已有旧条目，旧条目**原样保留**（坏一次不污染好数据）。
   */
  updateFile(file: Kojo2ProjectFileInput): Kojo2ProjectIndexedFile | undefined;
  /** 移除一份文件；真的移掉了才 `true`（并让 `generation` +1） */
  removeFile(path: string): boolean;
  /** 取已索引的文件；没有 / 路径非法 ⇒ `undefined` */
  getFile(path: string): Kojo2ProjectIndexedFile | undefined;
  /** 跨文件出现点（源码序、去重、`KOJO2_PROJECT_REF_LIMIT` 截断） */
  refsOf(query: Kojo2ProjectRefQuery): Kojo2ProjectReferencesResult;
  /** 某个名字的全部声明（跨文件；按路径 → 行 → 列排序） */
  declsOf(name: string): readonly Kojo2ProjectDeclaration[];
  /**
   * 位置处的项目符号（1 基行列）。
   *
   * 只在该位置是**语法可证引用位**、而本文件没有同名声明时给出：用本文件的候选位拿名字，
   * 再看项目里这个名字的声明种类。**零声明 / 多种声明种类（重名是 core 错误）⇒ `null`**，
   * 不猜一个种类出来。`# 机` / `@织` 的事件位不走这里（本文件有事件挂点时同文件查询已答）。
   */
  symbolAt(query: Kojo2ProjectSymbolQuery): Kojo2ProjectSymbolRef | null;
  /** 当前索引里的文件路径（按路径归一键排序；返回原样路径） */
  files(): readonly string[];
  /** 只读快照（版本 / 计数 / 逐文件读数） */
  snapshot(): Kojo2ProjectIndexSnapshot;
}

/* ============================== 内部工具 ============================== */

/** 码元序比较（与 `kojo2-references` / core 项目层同一口径：不用 `localeCompare`） */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 路径序：归一键优先（大小写 / 分隔符不敏感），再按原文路径（同键两写法仍有确定序） */
function comparePaths(a: string, b: string): number {
  return compareText(pkey(a), pkey(b)) || compareText(a, b);
}

/**
 * 一份文件里去重后的出现点数（含声明位与候选表达式位）。
 *
 * 重名声明在错误态下同一处会被两条符号各收一次；候选位又可能和符号事实重叠——
 * 统一按"行 / 列 / 尾列 / 角色"去重，读数才对得上"这份文件里到底有多少个出现点"。
 */
function countSites(
  symbols: readonly Kojo2DocumentSymbolFacts[],
  candidates: readonly Kojo2ReferenceCandidate[],
): number {
  const seen = new Set<string>();
  const add = (span: Kojo2ReferenceSpan, kind: Kojo2ReferenceSiteKind): void => {
    seen.add(
      `${span.startLine}\u0000${span.startColumn}\u0000${span.endLine}\u0000${span.endColumn}\u0000${kind}`,
    );
  };
  for (const facts of symbols) for (const site of facts.refs) add(site.span, site.kind);
  for (const candidate of candidates) add(candidate.span, candidate.kind);
  return seen.size;
}

/** 缺省符号事实入口：同一份已建文档索引交给 `kojo2ReferenceSymbolsOf`（不再 lex + parse 一遍） */
function defaultSymbolsOf(
  source: string,
  document: Kojo2Document,
): readonly Kojo2DocumentSymbolFacts[] {
  return kojo2ReferenceSymbolsOf(source, { getIndex: () => document });
}

/* ============================== 工厂 ============================== */

/**
 * 建一张空的项目索引（纯逻辑、零 IO）。
 *
 * 可反复创建：索引不注册任何全局状态，宿主按项目 / 批次建一份、关项目时丢掉即可。
 */
export function createKojo2ProjectIndex(
  options: Kojo2ProjectIndexOptions = {},
): Kojo2ProjectIndex {
  const documentOf = options.documentOf ?? kojo2DocumentOf;
  const symbolsOf = options.symbolsOf ?? defaultSymbolsOf;

  /** 路径归一键 → 已索引文件。值里的 `path` 是**最近一次**喂进来的原样路径。 */
  const entries = new Map<string, Kojo2ProjectIndexedFile>();
  let generation = 0;

  /** 路径归一键 → 排序后的条目（查询逐次现取；文件数量级远小于引用数量级） */
  const orderedEntries = (): Kojo2ProjectIndexedFile[] => {
    const out = [...entries.values()];
    out.sort((a, b) => comparePaths(a.path, b.path));
    return out;
  };

  const validatePath = (path: unknown): path is string =>
    typeof path === 'string' && path.length > 0;

  const updateFile = (file: Kojo2ProjectFileInput): Kojo2ProjectIndexedFile | undefined => {
    if (file === null || typeof file !== 'object') return undefined;
    const path: unknown = (file as { path?: unknown }).path;
    const text: unknown = (file as { text?: unknown }).text;
    if (!validatePath(path)) return undefined;
    if (typeof text !== 'string') return undefined;

    const key = pkey(path);
    const existing = entries.get(key);
    if (existing !== undefined && existing.text === text) {
      // 文本没变 = 事实没变：不重解析、不重扫描；只把路径换成本次喂进来的写法。
      if (existing.path === path) return existing;
      const renamed: Kojo2ProjectIndexedFile = { ...existing, path };
      entries.set(key, renamed);
      return renamed;
    }

    let document: Kojo2Document;
    try {
      document = documentOf(text);
    } catch {
      // 解析失败：这个路径的旧条目原样保留（坏一次不许把上一版好数据擦掉）。
      return undefined;
    }

    let symbols: readonly Kojo2DocumentSymbolFacts[];
    try {
      symbols = symbolsOf(text, document);
    } catch {
      // 符号事实是上面那条解析的派生：派生失败 = 这一版不可信，旧条目同样保留。
      return undefined;
    }

    let candidates: readonly Kojo2ReferenceCandidate[];
    try {
      candidates = kojo2ReferenceCandidatesOf(text, { getIndex: () => document });
    } catch {
      return undefined;
    }

    const entry: Kojo2ProjectIndexedFile = {
      path,
      text,
      document,
      symbols,
      candidates,
      siteCount: countSites(symbols, candidates),
    };
    entries.set(key, entry);
    generation++;
    return entry;
  };

  const removeFile = (path: string): boolean => {
    if (!validatePath(path)) return false;
    const removed = entries.delete(pkey(path));
    if (removed) generation++;
    return removed;
  };

  const getFile = (path: string): Kojo2ProjectIndexedFile | undefined => {
    if (!validatePath(path)) return undefined;
    return entries.get(pkey(path));
  };

  /**
   * 查询视图（LAU-B11）：`refsOf` / `declsOf` / `symbolAt` 的规则实现**只有一处**，住在
   * `@kojo/kojo-lang/references` 的 `createKojo2ReferenceFactsQueryIndex`——快照供方读的
   * 同一条。本层把**已缓存**的逐文件事实原样交过去（每次查询按规范序重排条目引用，
   * 不重扫源文、不重解析），只负责缓存与读取路径；宿主不再手抄第二份口径。
   * 「名录未建 ⇒ 不答」与「真没有 ⇒ 答空」的分歧不在这里：那一格归取数腿
   * （`projectFilesSnapshotOf` 的 `undefined`），本索引只对已喂进来的事实作答。
   */
  const factsQuery = () => createKojo2ReferenceFactsQueryIndex(orderedEntries());

  const refsOf = (query: Kojo2ProjectRefQuery): Kojo2ProjectReferencesResult =>
    factsQuery().refsOf(query);

  const declsOf = (name: string): readonly Kojo2ProjectDeclaration[] =>
    factsQuery().declsOf(name);

  const files = (): readonly string[] => orderedEntries().map((entry) => entry.path);

  const symbolAt = (query: Kojo2ProjectSymbolQuery): Kojo2ProjectSymbolRef | null =>
    factsQuery().symbolAt(query);

  const snapshot = (): Kojo2ProjectIndexSnapshot => {
    const ordered = orderedEntries();
    const filesReadout: Kojo2ProjectSnapshotFile[] = [];
    let symbolCount = 0;
    let siteCount = 0;
    for (const entry of ordered) {
      filesReadout.push({
        path: entry.path,
        lines: entry.document.lines.length,
        symbols: entry.symbols.length,
        sites: entry.siteCount,
      });
      symbolCount += entry.symbols.length;
      siteCount += entry.siteCount;
    }
    return {
      generation,
      fileCount: filesReadout.length,
      symbolCount,
      siteCount,
      files: filesReadout,
    };
  };

  return { updateFile, removeFile, getFile, refsOf, declsOf, symbolAt, files, snapshot };
}

/* ============================== 跨文件 resolver：同一份索引的映射 ============================== */

/** 声明种类 → 可调用种类（调用层级只认 `@函` / `# 模`；其余声明不进这张口） */
function callableKindOf(kind: Kojo2ReferenceSymbolKind): Kojo2CallableDeclarationKind | null {
  if (kind === 'function') return 'function';
  if (kind === 'template') return 'template';
  return null;
}

/** 索引里某个名字的**可调用**声明种类（提示缺省时取声明序第一条；没有 ⇒ `null`） */
function declaredCallableKind(
  index: Kojo2ProjectIndex,
  name: string,
): Kojo2CallableDeclarationKind | null {
  for (const declaration of index.declsOf(name)) {
    const kind = callableKindOf(declaration.kind);
    if (kind !== null) return kind;
  }
  return null;
}

/**
 * 重命名的跨文件 resolver（`kojo2RenamePlanXFile` 的注入面）。
 *
 * 候选文件 = `declsOf(name)` 里**可改名**的声明所在文件（幕 / 事件不在本批改名面）；
 * `readSource` = `getFile(path)?.text`（`null` = 索引没有这份文件，plan 侧阻断而不是猜）。
 * 路径与顺序全部沿用索引的规范序，本函数不归一化、不去重之外的改写。
 */
export function createKojo2ProjectRenameResolvers(
  index: Kojo2ProjectIndex,
): Kojo2RenameResolvers {
  return {
    listFilesWithSymbol(name: string): readonly string[] {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const declaration of index.declsOf(name)) {
        if (declaration.kind === 'scene' || declaration.kind === 'event') continue;
        const key = pkey(declaration.path);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(declaration.path);
      }
      return out;
    },
    readSource(path: string): string | null {
      return index.getFile(path)?.text ?? null;
    },
  };
}

/**
 * 调用层级的跨文件 resolver（`kojo2IncomingCallsXFile` / 出边口共用的注入面）。
 *
 * `resolveDeclaration` 只交**可调用声明**（`@函` / `# 模`）的落点；`listCallers` 由
 * `refsOf` 的引用文件收口（只给路径与首枚出现点提示，真边由调用层级按源文重扫）。
 */
export function createKojo2ProjectCallHierarchyResolvers(
  index: Kojo2ProjectIndex,
): Kojo2CallHierarchyResolvers {
  return {
    resolveDeclaration(
      name: string,
      kind?: Kojo2CallableDeclarationKind,
    ): Kojo2CallHierarchyDeclarationTarget | null {
      if (typeof name !== 'string' || name.length === 0) return null;
      for (const declaration of index.declsOf(name)) {
        const callable = callableKindOf(declaration.kind);
        if (callable === null) continue;
        if (kind !== undefined && callable !== kind) continue;
        return {
          path: declaration.path,
          line: declaration.span.startLine,
          column: declaration.span.startColumn,
          kind: callable,
        };
      }
      return null;
    },
    readSource(path: string): string | null {
      return index.getFile(path)?.text ?? null;
    },
    listCallers(
      name: string,
      kind?: Kojo2CallableDeclarationKind,
    ): readonly Kojo2CallHierarchyCallerCandidate[] {
      if (typeof name !== 'string' || name.length === 0) return [];
      const callable = kind ?? declaredCallableKind(index, name);
      if (callable === null) return [];
      const symbolKind: Kojo2ReferenceSymbolKind = callable === 'template' ? 'template' : 'function';
      const out: Kojo2CallHierarchyCallerCandidate[] = [];
      const seen = new Set<string>();
      for (const ref of index.refsOf({ name, kind: symbolKind }).refs) {
        const key = pkey(ref.path);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          path: ref.path,
          line: ref.span.startLine,
          column: ref.span.startColumn,
          kind: callable,
        });
      }
      return out;
    },
  };
}
