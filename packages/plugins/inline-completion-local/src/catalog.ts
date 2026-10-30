import type { ErbIndex } from '@kojo/plugin-api';

/**
 * 名录（catalog）：**把 `erb.parser` 已经建好的那份索引投影成"可按前缀数命中"的形状**。
 *
 * ## 为什么这一层不构成"第二份索引"
 *
 * 名字事实的唯一持有者是 `erb.parser` 的 `ErbIndex`（`byName` = 归一化函数名 → 定义列表，
 * `files[*].dims` = `#DIM` 族声明名）。本层做的只有两件事：
 * ①把两份键集**排序**（一次，按索引对象 `WeakMap` 记忆化，索引重建即换键天然失效）；
 * ②在那份排序键表上做一次**区间二分**，回答"这个前缀命中几条"。
 * 不重解析文件、不读盘、不新建名字表——"哪些名字存在"这条判据一个字都不在这里。
 *
 * ## 二分而不是全表 `startsWith`
 *
 * 基线索引的函数名录实测 9.9 万条（`docs/STATE.md` 口径），逐键 `startsWith` 是每次击键
 * 付一趟全表扫描；排序 + `lowerBound` 把它压成 O(log n + 命中数)。宿主补全弹窗侧
 * （`app/src/monaco/completion-core.ts` 的 `prefixIndexFor`）出于同一动机建了同一份加速结构，
 * 本包不复用它的实现（那是宿主层、且要 Monaco 实例），但**复用同一批事实**
 * （同一段 `byName`）。
 *
 * ## 命中数为什么"数到 2 就停"
 *
 * 供方的判据只有"唯一"与"不唯一"两档：≥2 条时给出的是**哪两条**并不重要（一律不给候选），
 * 继续数下去只是把一次击键的成本绑在"这个前缀在项目里有多常见"上。
 * `probePrefix` 仍把 `limit` 留给调用方（语料活闸要拿真实命中规模报数），缺省 2。
 */

/** 一份可查的名录（`keys` 升序，`names` 与 `keys` 逐位对应） */
export interface NameCatalog {
  /** 归一化（大写）后的名字，升序（码元序，与 `locale` 无关） */
  readonly keys: readonly string[];
  /** 与 `keys[i]` 同条目的**原形**名字（写进缓冲区的就是它） */
  readonly names: readonly string[];
}

/** 一次前缀探测的结果 */
export interface PrefixProbe {
  /** 命中的原形名（最多 `limit` 条；顺序 = 名录升序） */
  readonly hits: readonly string[];
  /** 名录里是否还有没被 `limit` 装下的命中（`true` ⇒ 至少 `limit + 1` 条） */
  readonly truncated: boolean;
}

interface CatalogBundle {
  readonly functions: NameCatalog;
  readonly declared: NameCatalog;
  /** 本项目里实际出现过的 `#DIM` 族指令名（大写）——声明位的词表由此派生，不硬编码 */
  readonly directives: ReadonlySet<string>;
}

const bundleCache = new WeakMap<ErbIndex, CatalogBundle>();

/** 归一化口径与解析器逐字相同：`name.toUpperCase()`（`erb-parser/scanner.ts` 建 `normalizedName` 那一句） */
function normalize(name: string): string {
  return name.toUpperCase();
}

function makeCatalog(keys: string[], names: string[]): NameCatalog {
  const pairs = keys.map((key, i) => [key, names[i]!] as const);
  // 码元序（不用 localeCompare：排序结果不随运行环境语言变化，纪律同 erb-parser 的 compareText）
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    keys: pairs.map((p) => p[0]),
    names: pairs.map((p) => p[1]),
  };
}

function buildBundle(index: ErbIndex): CatalogBundle {
  const fnKeys: string[] = [];
  const fnNames: string[] = [];
  for (const normalized of index.byName.keys()) {
    // 原形名取该名下**第一枚定义**的名字（同一名字的多处定义在引擎里本就是同一个调用目标，
    // 展示用哪一份都不算错；取文档序第一枚是为了确定性，不是取"最好的那一个"）
    const display = index.byName.firstOf(normalized)?.name;
    fnKeys.push(normalized);
    fnNames.push(display !== undefined && display.length > 0 ? display : normalized);
  }

  const seenDim = new Set<string>();
  const dimKeys: string[] = [];
  const dimNames: string[] = [];
  const directives = new Set<string>();
  for (const file of index.files.values()) {
    for (const dim of file.dims) {
      directives.add(dim.directive);
      if (dim.name.length === 0) continue;
      const key = normalize(dim.name);
      if (seenDim.has(key)) continue;
      seenDim.add(key);
      dimKeys.push(key);
      dimNames.push(dim.name);
    }
  }

  return {
    functions: makeCatalog(fnKeys, fnNames),
    declared: makeCatalog(dimKeys, dimNames),
    directives,
  };
}

function bundleOf(index: ErbIndex): CatalogBundle {
  const cached = bundleCache.get(index);
  if (cached !== undefined) return cached;
  const built = buildBundle(index);
  bundleCache.set(index, built);
  return built;
}

/** 项目函数名录（`ErbIndex.byName` 的键集 + 原形名） */
export function functionCatalog(index: ErbIndex): NameCatalog {
  return bundleOf(index).functions;
}

/** 项目声明名录（全部 `#DIM` 族声明名，按归一化名去重） */
export function declaredCatalog(index: ErbIndex): NameCatalog {
  return bundleOf(index).declared;
}

/**
 * 本项目出现过的 `#DIM` 族**指令名**（大写集合）。
 *
 * 为什么从索引派生而不是在包里写一张词表：`#DIM` / `#DIMS` / `#DIMSTR` / … 这一族
 * 归哪个方言、有几枚，是 `erb.parser` 的扫描器说了算的事实（`scanner.ts` 的 `DIM_RE`）。
 * 本包把它抄成第二张表，就是"解析器收了新指令、幽灵文本还按老词表判位"的漂移起点。
 * 派生的代价是"没开项目时这一形状不工作"——而那正是本包**本来就该弃权**的情形。
 */
export function declaredDirectives(index: ErbIndex): ReadonlySet<string> {
  return bundleOf(index).directives;
}

/** 第一个不小于 `needle` 的下标（升序表上的 `lowerBound`；比较口径 = 码元序） */
export function lowerBound(keys: readonly string[], needle: string): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (keys[mid]! < needle) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * 前缀命中探测（二分定区间 + 顺序收集，最多 `limit` 条）。
 *
 * 空前缀**一律零命中**：名录里"全部名字"不是一条可自证的候选，把"还没打字"当成
 * "打字了且唯一"是本形状最容易长出的假阳性，所以在最里层再钉一次（调用点也有闸）。
 */
export function probePrefix(catalog: NameCatalog, prefix: string, limit = 2): PrefixProbe {
  if (prefix.length === 0 || limit < 1) return { hits: [], truncated: false };
  const needle = normalize(prefix);
  const keys = catalog.keys;
  const from = lowerBound(keys, needle);
  const hits: string[] = [];
  for (let i = from; i < keys.length; i++) {
    if (!keys[i]!.startsWith(needle)) break;
    if (hits.length >= limit) return { hits, truncated: true };
    hits.push(catalog.names[i]!);
  }
  return { hits, truncated: false };
}

/**
 * "这个前缀在本名录里**只**匹配一个名字"——本包唯一的一条自证判据。
 *
 * 命中 0 条（不是项目里的名字）与命中 ≥2 条（需要作者自己选）都返回 `undefined`：
 * 前者没依据，后者给哪一条都没依据。宁可漏报不可错报。
 */
export function uniqueNameFor(catalog: NameCatalog, prefix: string): string | undefined {
  const probe = probePrefix(catalog, prefix, 2);
  if (probe.truncated || probe.hits.length !== 1) return undefined;
  return probe.hits[0];
}
