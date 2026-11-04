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

import type { ErbIndex } from '@kojo/plugin-api';

/**
 * 一条 `#DIM` 声明在**项目里**的事实。
 *
 * `column` 刻意不在这一层：索引里的 `ErbDim` 只有 `name` / `directive` / `line`，
 * 没有列事实。跨文件落点给"那一行"是能保证的，凭空算一个列号会让光标停在名字中间
 * ——不伪造比好看重要。文件内的精确列由 `symbols.ts` 的 `resolveErbDimDefinition`
 * 给（它手上有文本）。
 */
export interface ErbDimEntry {
  /** 声明名（**原名**，不归一——诊断视图要按原样回给作者） */
  readonly name: string;
  /** 声明指令（已大写归一）：`DIM` / `DIMS` / `DIMF` / `DIMSTR` / `DIMCHAR` / `DEFINE` */
  readonly directive: string;
  readonly filePath: string;
  /** 1 基行号 */
  readonly line: number;
}

/** 一条声明在项目里的落点（导航目标；`column` 恒 1，理由见 {@link ErbDimEntry}） */
export interface ErbDimDeclarationSite {
  readonly name: string;
  readonly filePath: string;
  readonly line: number;
  /** 恒 1（索引无列事实） */
  readonly column: number;
  readonly directive: string;
}

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

  const out: ErbDimEntry[] = [];
  for (const [filePath, file] of index.files) {
    for (const dim of file.dims) {
      out.push({ name: dim.name, directive: dim.directive, filePath, line: dim.line });
    }
  }

  ENTRIES_CACHE.set(index, out);
  return out;
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
    const key = entry.name.toUpperCase();
    let bucket = out.get(key);
    if (bucket === undefined) {
      bucket = [];
      out.set(key, bucket);
    }
    bucket.push({
      name: entry.name,
      filePath: entry.filePath,
      line: entry.line,
      column: 1,
      directive: entry.directive,
    });
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
