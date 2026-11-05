/**
 * 项目级 `#DIM` 声明事实（**唯一出口**，2026-11-04 ERH 批）。
 *
 * ## 为什么要有这个文件
 *
 * `.ERH` 是引擎的**全局声明容器**：`Preload.cs` 把 `.erb` / `.erh` 一起预载（8 盘语料
 * 实测 **0 处 `#INCLUDE`**），一个名字在 `.ERH` 里声明、在几十份 `.ERB` 里使用——引擎眼里
 * 它们本来就是同一个编译单元。
 *
 * 但本仓此前的 `#DIM` 判据全都只吃**当前文件文本**（`resolveErbDimDefinition` /
 * `erbDimReferencesAt`，注释里那句"跨文件不猜"），而项目级的名字汇总又只服务诊断
 * （`offload.ts` 的 `projectDeclaredNames`）。于是两种消费方各扫一遍 `files[].dims`：
 * 诊断要**名字**，导航要**落点**——同一份事实两处遍历，一漂移就是"补全有、跳转没有"。
 *
 * 本文件把那次遍历收成一处：{@link projectDimEntries} 是全项目**唯一**的遍历点，
 * 两个视图（{@link projectDimDeclarations} / {@link projectDeclaredNames}）都只是投影。
 * 加新的消费方时**从这里取视图，不要自己再写一遍 `for (const file of index.files)`**。
 *
 * ## 为什么不是 `ErbIndex` 上的第二张表
 *
 * `symbols.ts` 头注的纪律："不新造第二张表——第二张表就是漂移源"。`index.files[].dims`
 * 已经是声明的唯一真源，这里只做**派生缓存**（与 `offload.ts` 的 `bulkCtxCache` 同形）：
 * 按索引对象 WeakMap 缓存，索引重建即新对象 ⇒ 天然失效，不需要版本号，也不会出现
 * "表说是 A、files 说是 B"的分叉。
 *
 * ## 规模
 *
 * 8 盘语料 `ERB/` 下合计 154,617 条 `#DIM` 族声明（`ERB` 119,253 / `ERH` 35,364）。
 * 首建一次是线性扫描；之后每次 F12 / 补全只是查表。
 */

import type { ErbFile, ErbIndex } from '@kojo/plugin-api';

/**
 * 一条 `#DIM` 声明在**项目里**的事实（也是导航腿说的"落点"——同一个形状，同一批对象）。
 *
 * `column` 恒 1 不是占位：索引里的 `ErbDim` 只有 `name` / `directive` / `line`，没有列事实。
 * 跨文件落点给"那一行"是能保证的，凭空算一个列号会让光标停在名字中间——不伪造比好看重要。
 * 文件内的精确列由 `symbols.ts` 的 `resolveErbDimDefinition` 给（它手上有文本）。
 */
export interface ErbDimEntry {
  /** 声明名（**原名**，不归一——诊断视图要按原样回给作者） */
  readonly name: string;
  /** 声明指令（已大写归一）：`DIM` / `DIMS` / `DIMF` / `DIMSTR` / `DIMCHAR` / `DEFINE` */
  readonly directive: string;
  readonly filePath: string;
  /** 1 基行号 */
  readonly line: number;
  /**
   * 恒 1。放在条目这一层而不是另开一份"落点"对象，是因为两者**形状本就相同**：
   * 15 万条声明量级下，多一份平行对象就是多一整个世代的堆；导航与诊断共用同一批条目。
   */
  readonly column: 1;
  /**
   * 所属函数的 `@` 行（1 基）；**缺席 = 全局声明**（文件顶层 / `.ERH` / `.ERD`）。
   *
   * 这一位**不从解析器另存一份**：`ErbFile.functions[].startLine / endLine` 已经把
   * "某一行属于哪个函数"写全了，作用域是它的纯派生（引擎眼里函数体内 `#DIM` 是调用栈
   * 局部，跨函数同名互不相干）。多存一份就是第二个真源——一处漏更新，项目级引用就会把
   * A 函数的局部变量算到 B 头上。真语料 67.7% 的声明是局部（40,852 条里 27,655 条）。
   */
  readonly functionStartLine?: number;
}

/**
 * 一条声明在项目里的落点 = 一条条目本身（别名，非新形状）。
 *
 * 消费方按名字读，不需要知道"条目"与"落点"在实现上是同一个对象——保留这个名字是
 * 为了让导航腿的语义（去哪里）与诊断腿（叫什么）在调用点仍然读得出来。
 */
export type ErbDimDeclarationSite = ErbDimEntry;

/** 字符串型声明指令——`undefined-name` 靠它整行跳过字符串赋值（口径自 `projectDeclaredNames` 原样搬来） */
const STRING_DIRECTIVES: ReadonlySet<string> = new Set(['DIMS', 'DIMSTR', 'DIMCHAR']);

/** 全项目声明条目（按索引对象缓存；纯读，不碰盘） */
const ENTRIES_CACHE = new WeakMap<ErbIndex, readonly ErbDimEntry[]>();
/** 名字（大写归一）→ 落点列表（第二个视图，单独缓存避免每次聚合） */
const SITES_CACHE = new WeakMap<ErbIndex, ReadonlyMap<string, readonly ErbDimDeclarationSite[]>>();
/** 诊断视图（名字列表；与旧 `projectDeclaredNames` 同一形状，消费方零改动） */
const NAMES_CACHE = new WeakMap<ErbIndex, { dims: string[]; strings: string[] }>();

/**
 * 全项目 `#DIM` 声明条目——**本仓唯一**的 `index.files[].dims` 遍历点。
 *
 * 顺序 = `index.files` 的遍历顺序 × 文件内声明顺序。这个顺序是诊断视图的既有行为
 * （旧 `projectDeclaredNames` 逐字如此），改成任何"更聪明"的排序都会让下游 Map 的
 * 首个取值变——虽然今天没人依赖，但"顺手改顺序"是最容易无声漂移的一类改动。
 */
export function projectDimEntries(index: ErbIndex): readonly ErbDimEntry[] {
  const hit = ENTRIES_CACHE.get(index);
  if (hit !== undefined) return hit;
  const out = dimEntriesOfFiles(index.files);
  ENTRIES_CACHE.set(index, out);
  return out;
}

/**
 * 全项目 `#DIM` 声明条目（**底层那一份**；`index.files` 的遍历只住在这里）。
 *
 * 与 {@link projectDimEntries} 的关系：那一枚是"按索引对象缓存"的入口，这一枚是纯函数，
 * 供**建索引阶段**用（那时 `ErbIndex` 还没组装出来，只有 `files`）。两条入口、一次遍历实现
 * ——加新消费方时从这两枚取，别自己再写一遍 `for (const file of index.files)`。
 *
 * 作用域在这一层派生：`file.functions` 已按 `startLine` 升序（解析器逐行推入），声明也按行
 * 升序 ⇒ 一个游标推到底，命中后再用 `endLine` 复核（函数体之外的行不属于它）。
 */
export function dimEntriesOfFiles(files: Iterable<readonly [string, ErbFile]>): ErbDimEntry[] {
  const out: ErbDimEntry[] = [];
  for (const [filePath, file] of files) {
    const fns = file.functions;
    let j = -1;
    for (const dim of file.dims) {
      while (j + 1 < fns.length && fns[j + 1]!.startLine <= dim.line) j++;
      const fn = j >= 0 ? fns[j] : undefined;
      const inFn = fn !== undefined && dim.line <= fn.endLine ? fn.startLine : undefined;
      if (inFn === undefined) {
        out.push({ name: dim.name, directive: dim.directive, filePath, line: dim.line, column: 1 });
      } else {
        out.push({
          name: dim.name,
          directive: dim.directive,
          filePath,
          line: dim.line,
          column: 1,
          functionStartLine: inFn,
        });
      }
    }
  }
  return out;
}

/**
 * 全局声明名（大写归一）→ 是否在项目里。**项目级变量引用的名字表**：局部声明天然不可能
 * 跨文件被引用，进这张表只会制造假边（真语料 12,020 个全局名字 vs 27,655 条局部声明）。
 */
const GLOBAL_NAMES_CACHE = new WeakMap<ErbIndex, ReadonlySet<string>>();

export function globalDimNamesOf(index: ErbIndex): ReadonlySet<string> {
  const hit = GLOBAL_NAMES_CACHE.get(index);
  if (hit !== undefined) return hit;
  const set = globalDimNamesOfEntries(projectDimEntries(index));
  GLOBAL_NAMES_CACHE.set(index, set);
  return set;
}

/** 建索引阶段用（`ErbIndex` 尚未组装）：与 {@link globalDimNamesOf} 同一份派生 */
export function globalDimNamesOfFiles(files: Iterable<readonly [string, ErbFile]>): ReadonlySet<string> {
  return globalDimNamesOfEntries(dimEntriesOfFiles(files));
}

/** 已经有条目表时用它（避免为了拿名字再多走一遍 `dimEntriesOfFiles`） */
export function globalDimNamesOfEntries(entries: readonly ErbDimEntry[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const entry of entries) {
    if (entry.functionStartLine !== undefined) continue;
    if (entry.name.length === 0) continue;
    set.add(entry.name.toUpperCase());
  }
  return set;
}

/** 一处函数内局部声明造成的**遮蔽区间**：这个函数体里，这些名字指的是局部变量 */
export interface DimShadowSpan {
  /** 函数 `@` 行（1 基，含） */
  readonly from: number;
  /** 函数体结束行（1 基，含；`ErbFunction.endLine`） */
  readonly to: number;
  /** 该函数内局部声明的名字（大写归一） */
  readonly names: ReadonlySet<string>;
}

/**
 * 单文件的遮蔽区间表（按 `ErbFile` 对象缓存：索引重建 ⇒ 新对象 ⇒ 天然失效）。
 *
 * 消费方是**项目级变量引用**：`CFLAG` 在全局声明过、又在 `@F` 里 `#DIM CFLAG` 过，
 * 那么 `@F` 体内的 `CFLAG` 就是那个局部变量——索引里记着它，查询时靠这张表剔掉。
 * 为什么不建索引时就剔：遮蔽是**当前**文件事实，作者随时会加一行 `#DIM`；建时剔会把
 * "这行不算引用"冻进快照，改回来还得靠重扫。查询时判，永远读的是最新结构。
 */
const SHADOW_CACHE = new WeakMap<ErbFile, readonly DimShadowSpan[]>();

export function localDimShadowSpansOf(file: ErbFile): readonly DimShadowSpan[] {
  const hit = SHADOW_CACHE.get(file);
  if (hit !== undefined) return hit;

  /**
   * 作用域**不在这里再判一遍**：走 {@link dimEntriesOfFiles} 同一个派生
   * （`functionStartLine` 缺席 = 全局）。同一件事实写两处游标，一处改了另一处不知道，
   * 表现就是"项目级引用里剔掉的点和全局名录里收的点对不上"。
   */
  const byFn = new Map<number, Set<string>>();
  for (const entry of dimEntriesOfFiles([[file.path, file]])) {
    if (entry.functionStartLine === undefined || entry.name.length === 0) continue;
    let names = byFn.get(entry.functionStartLine);
    if (names === undefined) {
      names = new Set<string>();
      byFn.set(entry.functionStartLine, names);
    }
    names.add(entry.name.toUpperCase());
  }

  const spans: DimShadowSpan[] = [];
  if (byFn.size > 0) {
    for (const fn of file.functions) {
      const names = byFn.get(fn.startLine);
      if (names !== undefined) spans.push({ from: fn.startLine, to: fn.endLine, names });
    }
  }
  SHADOW_CACHE.set(file, spans);
  return spans;
}

/**
 * 名字（大写归一）→ 项目内全部声明落点。
 *
 * 为什么按名分桶而不是"一个名字只留第一条"：同名常量散在多份 `.ERH` 里是常态
 * （不同 mod 各带一份 `DIM.ERH`），导航要让作者看见"这条名字在项目里有几处来源"，
 * 而不是替他挑一个。挑哪一处是消费方的事（F12 全给、补全只要名字）。
 */
export function projectDimDeclarations(
  index: ErbIndex,
): ReadonlyMap<string, readonly ErbDimDeclarationSite[]> {
  const hit = SITES_CACHE.get(index);
  if (hit !== undefined) return hit;

  const out = new Map<string, ErbDimDeclarationSite[]>();
  for (const entry of projectDimEntries(index)) {
    // 空名字是解析残渣（`#DIM` 后面什么都没有那种病态行），不进名录——否则空串会成为
    // 一个"什么都能匹配到"的键。
    if (entry.name.length === 0) continue;
    // 键直接用声明名：数组维度（`配列[10]`）与二维尺寸（`MAP:10:20`）在扫描器切名时
    // 就已剥掉，索引里的名字与光标取到的记号是同一把尺子（见 `parseDimDeclaration`）。
    const key = entry.name.toUpperCase();
    let bucket = out.get(key);
    if (bucket === undefined) {
      bucket = [];
      out.set(key, bucket);
    }
    // 直接复用条目本体（同一批对象，不另造一份落点）：15 万条量级下这是整个世代的堆。
    bucket.push(entry);
  }

  SITES_CACHE.set(index, out);
  return out;
}

/**
 * 从项目索引汇总声明名：`dims` 供"已声明"判定，`strings` 供字符串型赋值整行跳过。
 *
 * 跨文件声明是 Emuera 的常态（`DIM.ERH` 集中声明），只看当前文件会成片误报。
 * 缓存按索引对象（`ErbIndex` 每次重建都是新对象）而不是按路径，避免"文件改了还拿旧名录"。
 *
 * 2026-11-04：实现从 `offload.ts` 搬来，改为 {@link projectDimEntries} 的投影——
 * 输出**逐字不变**（含重复项与原顺序），只是不再自己遍历一遍 `files`。
 */
export function projectDeclaredNames(index: ErbIndex): { dims: string[]; strings: string[] } {
  const hit = NAMES_CACHE.get(index);
  if (hit !== undefined) return hit;

  const dims: string[] = [];
  const strings: string[] = [];
  for (const entry of projectDimEntries(index)) {
    dims.push(entry.name);
    if (STRING_DIRECTIVES.has(entry.directive)) strings.push(entry.name);
  }

  const names = { dims, strings };
  NAMES_CACHE.set(index, names);
  return names;
}

/**
 * 按名取项目内声明落点（大小写不敏感，与 `dimDeclarationsOf` 同一把尺子）。
 * `index` 缺席（未开项目 / 未建好）⇒ 空数组：**不猜**，但也别让调用方自己判空。
 */
export function dimDeclarationSitesOf(
  index: ErbIndex | null,
  name: string,
): readonly ErbDimDeclarationSite[] {
  if (index === null || name.length === 0) return [];
  return projectDimDeclarations(index).get(name.toUpperCase()) ?? [];
}
