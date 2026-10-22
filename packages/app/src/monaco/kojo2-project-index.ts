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
 * 它**不读盘、不观察文件系统、不注册 provider**：文本全部由宿主喂（生产上来自项目扫描
 * `collectKojo2ProjectDocuments` / 打开中的 model），索引只负责建表与查询。写入方每轮把
 * `{ path, text }` 灌进 `updateFile`，删文件 / 关项目用 `removeFile`。
 *
 * ## 一把尺子（本文件最重要的纪律）
 *
 * 每份文件的符号事实直接取 {@link kojo2ReferenceSymbolsOf}（`kojo2-references.ts`）：
 * 声明表来自 `kojo2DocumentOf`（`@函 / # 表 / # 池 / # 模 / # 变量 / # 常量 / # 幕`），
 * 事件名来自同一份 `# 机` / `@织` 挂点判据，引用位来自同一套表达式扫描（插值 / 调用 /
 * 条件 / `# 表 由` / `@算` 体 / `@返` / `@着色` / 数组长度）。
 * 逐文件的**候选引用位**取 {@link kojo2ReferenceCandidatesOf}：同一条扫描链，唯一的放宽是
 * 不要求名字在本文件里有声明——否则"只在 A 文件声明、B 文件引用"的跨文件引用根本看不见。
 * 归属仍按本地声明种类隔离（B 文件把同名声明成变量，它就不会被算成 A 文件那张表的引用）。
 * **本文件不写第二份扫描器**——跨文件与同文件因此不可能给出两套事实。
 *
 * ## 缓存与性能
 *
 * - 按**路径归一键**缓存（{@link pkey}：分隔符折叠 + 小写）。`text` 与上次逐字相同 ⇒
 *   直接命中，不重跑 `lex + parse`，也不重扫出现点；路径只改了写法（大小写 / 斜杠）而文本
 *   没变时同样命中（只换显示路径）。
 * - 单文件更新是一次 `lex + parse` + 一次全篇扫描（与 `kojo2ReferencesAt` 的代价同阶）。
 *   5k 行夹具的预算见 `tests/kojo2-project-index.test.ts`（< 8ms）。
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
import {
  kojo2DocumentOf,
  type Kojo2DeclarationKind,
  type Kojo2Document,
} from './kojo2-declarations';
import {
  kojo2ReferenceCandidatesOf,
  kojo2ReferenceSymbolsOf,
  type Kojo2DocumentSymbolFacts,
  type Kojo2ReferenceCandidate,
  type Kojo2ReferenceSiteKind,
  type Kojo2ReferenceSpan,
  type Kojo2ReferenceSymbolKind,
} from './kojo2-references';

/* ============================== 公共形状 ============================== */

/** 单次 `refsOf` 的结果上限（超出按源码序截断并置 `truncated`） */
export const KOJO2_PROJECT_REF_LIMIT = 2000;

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

/** 合法符号种类（八类：七类声明 + 事件；用 Set 收口，坏值直接空结果） */
const SYMBOL_KINDS: ReadonlySet<string> = new Set<Kojo2ReferenceSymbolKind>([
  'scene',
  'variable',
  'constant',
  'table',
  'pool',
  'template',
  'function',
  'event',
]);

/** 查询种类的形态闸（未知字符串一律不进索引） */
function isSymbolKind(value: unknown): value is Kojo2ReferenceSymbolKind {
  return typeof value === 'string' && SYMBOL_KINDS.has(value);
}

/** 码元序比较（与 `kojo2-references` / core 项目层同一口径：不用 `localeCompare`） */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 路径序：归一键优先（大小写 / 分隔符不敏感），再按原文路径（同键两写法仍有确定序） */
function comparePaths(a: string, b: string): number {
  return compareText(pkey(a), pkey(b)) || compareText(a, b);
}

/** 出现点角色序（只用于同起点并列时给一个确定次序） */
const ROLE_RANK: Readonly<Record<Kojo2ReferenceSiteKind, number>> = {
  decl: 0,
  ref: 1,
  call: 2,
};

/** 跨文件出现点的规范序：路径 → 行 → 起始列 → 结束列 → 角色 */
function compareReferences(a: Kojo2ProjectReference, b: Kojo2ProjectReference): number {
  return (
    comparePaths(a.path, b.path) ||
    a.span.startLine - b.span.startLine ||
    a.span.startColumn - b.span.startColumn ||
    a.span.endColumn - b.span.endColumn ||
    ROLE_RANK[a.kind] - ROLE_RANK[b.kind]
  );
}

/** 声明规范序：路径 → 行 → 起始列 → 结束列 → 名字 → 种类 */
function compareDeclarations(a: Kojo2ProjectDeclaration, b: Kojo2ProjectDeclaration): number {
  return (
    comparePaths(a.path, b.path) ||
    a.span.startLine - b.span.startLine ||
    a.span.startColumn - b.span.startColumn ||
    a.span.endColumn - b.span.endColumn ||
    compareText(a.name, b.name) ||
    compareText(a.kind, b.kind)
  );
}

/** 出现点去重键（路径归一键 + 区间 + 角色；同位置同角色只留一条） */
function siteKey(path: string, span: Kojo2ReferenceSpan, kind: Kojo2ReferenceSiteKind): string {
  return `${pkey(path)}\u0000${span.startLine}\u0000${span.startColumn}\u0000${span.endLine}\u0000${span.endColumn}\u0000${kind}`;
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

/** 空结果（共享的冻结对象：查询无命中不是错误，也不该每次造新垃圾） */
const EMPTY_REFS: Kojo2ProjectReferencesResult = Object.freeze({
  refs: Object.freeze([]) as readonly Kojo2ProjectReference[],
  truncated: false,
});

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

  const refsOf = (query: Kojo2ProjectRefQuery): Kojo2ProjectReferencesResult => {
    if (query === null || typeof query !== 'object') return EMPTY_REFS;
    const name: unknown = (query as { name?: unknown }).name;
    const kind: unknown = (query as { kind?: unknown }).kind;
    if (typeof name !== 'string' || name.length === 0) return EMPTY_REFS;
    if (!isSymbolKind(kind)) return EMPTY_REFS;

    const only = validatePath((query as { onlyPath?: unknown }).onlyPath)
      ? pkey((query as { onlyPath: string }).onlyPath)
      : null;
    const exclude = validatePath((query as { excludePath?: unknown }).excludePath)
      ? pkey((query as { excludePath: string }).excludePath)
      : null;

    const ordered = orderedEntries();
    // 没有声明就没有符号：候选位只在"这个名字 + 种类确实被声明过"时才归属得上。
    const declared = ordered.some((entry) =>
      entry.symbols.some((facts) => facts.symbol.name === name && facts.symbol.kind === kind),
    );
    if (!declared) return EMPTY_REFS;

    const seen = new Set<string>();
    const refs: Kojo2ProjectReference[] = [];
    const add = (path: string, span: Kojo2ReferenceSpan, role: Kojo2ReferenceSiteKind): void => {
      const key = siteKey(path, span, role);
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({ path, span, kind: role });
    };

    for (const entry of ordered) {
      if (only !== null && pkey(entry.path) !== only) continue;
      if (only === null && exclude !== null && pkey(entry.path) === exclude) continue;

      // 本文件里这个名字的所有**声明种类**：候选表达式位按"最近的本地声明"归属——
      // 与 `kojo2ReferencesAt` 的家族隔离同一条判据（变量位不会被算成同名表的引用）。
      const localDeclKinds = new Set<Kojo2ReferenceSymbolKind>();
      for (const facts of entry.symbols) {
        if (facts.symbol.name !== name) continue;
        if (facts.symbol.kind === kind) {
          // 声明位 / 事件监听位：符号事实已按同一把尺子收好（`# 幕` 也走这一格）。
          for (const site of facts.refs) add(entry.path, site.span, site.kind);
        }
        if (facts.symbol.kind === 'scene' || facts.symbol.kind === 'event') continue;
        localDeclKinds.add(facts.symbol.kind);
      }

      // 表达式位：事件不靠表达式引用；幕没有引用位。
      if (kind === 'event' || kind === 'scene') continue;
      if (localDeclKinds.size > 0 && !localDeclKinds.has(kind)) continue;
      for (const candidate of entry.candidates) {
        if (candidate.name !== name) continue;
        add(entry.path, candidate.span, candidate.kind);
      }
    }

    refs.sort(compareReferences);
    if (refs.length <= KOJO2_PROJECT_REF_LIMIT) return { refs, truncated: false };
    return { refs: refs.slice(0, KOJO2_PROJECT_REF_LIMIT), truncated: true };
  };

  const declsOf = (name: string): readonly Kojo2ProjectDeclaration[] => {
    if (typeof name !== 'string' || name.length === 0) return [];
    const seen = new Set<string>();
    const out: Kojo2ProjectDeclaration[] = [];
    for (const entry of orderedEntries()) {
      for (const facts of entry.symbols) {
        if (facts.symbol.name !== name) continue;
        const span = facts.symbol.declSpan;
        const key = siteKey(entry.path, span, 'decl');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: entry.path, name, kind: facts.symbol.kind, span });
      }
    }
    out.sort(compareDeclarations);
    return out;
  };

  const files = (): readonly string[] => orderedEntries().map((entry) => entry.path);

  const symbolAt = (query: Kojo2ProjectSymbolQuery): Kojo2ProjectSymbolRef | null => {
    if (query === null || typeof query !== 'object') return null;
    const path: unknown = (query as { path?: unknown }).path;
    const line: unknown = (query as { line?: unknown }).line;
    const column: unknown = (query as { column?: unknown }).column;
    if (!validatePath(path)) return null;
    if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) return null;
    if (typeof column !== 'number' || !Number.isFinite(column) || column < 1) return null;

    const entry = entries.get(pkey(path));
    if (entry === undefined) return null;
    const col0 = column - 1;
    const candidate = entry.candidates.find(
      (candidate) =>
        candidate.span.startLine === line &&
        col0 >= candidate.span.startColumn - 1 &&
        col0 <= candidate.span.endColumn - 1,
    );
    if (candidate === undefined) return null;

    // 项目里这个名字的声明种类：只认进命名空间的声明（幕 / 事件不是表达式引用的目标）。
    const kinds = new Set<Kojo2DeclarationKind>();
    for (const other of entries.values()) {
      for (const facts of other.symbols) {
        if (facts.symbol.name !== candidate.name) continue;
        if (facts.symbol.kind === 'scene' || facts.symbol.kind === 'event') continue;
        kinds.add(facts.symbol.kind);
        // 同名多家族是 core 错误：这里没有可靠判据，交 `null`（不猜）。
        if (kinds.size > 1) return null;
      }
    }
    for (const kind of kinds) return { name: candidate.name, kind };
    return null;
  };

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
