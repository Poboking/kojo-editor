/**
 * 表层↔原生映射表的**反查一格**（LAU-SURFACE-WIRE 批）：盘上这个原生写法，作者面管它叫什么。
 *
 * ## 为什么单独成文件（而不是写在 `kojo-hover.ts` 里）
 *
 * PS-10 开机静态图今天 **200 文件 / 3,512 KB 双双顶格**（余量不到 1 KB），`kojo-hover.ts`
 * 是**在图内**文件 ⇒ 往里加这段判据当场撞闸。所以判据整块住这里、由 `kojo-hover` 走**动态边**
 * 取一枚函数引用；本文件不进开机图（ps10 只跟静态"有值"依赖）。
 *
 * ## 这一格补的是什么
 *
 * `kojo-hover` 的四条正向路 + ZH-D3 反向面都只认"这个记号在**当前语言面**里是什么"；它们
 * 答不出"盘上这个**原生写法**，作者面叫什么"。这一族此前没有单一入口，各处自己抄一份映射
 * （LAU-D4 车② 的盘点）。这里把表接进来：表由方言包交来（清单 `surfaceMapExport` 的懒边），
 * 读表函数由 `@kojo/kojo-core/surface-map` 提供，**宿主不认识任何一个名字**。
 *
 * ## 落点怎么认：让**表**说，不让宿主猜
 *
 * 这里**不用** `unicodeTokenAt` 切记号。那个切法按 `[\p{L}\p{N}_]` 走，`%CALLNAME:TARGET%`
 * 会被切成 `CALLNAME`、`TALENT:3` 会被切成 `TALENT`——而表里的原生写法恰恰是**带 `%` 带 `:`**
 * 的整串。若先切记号再查表，符号面（这一格最要紧的一类）一条都命不中。
 *
 * 所以反过来：拿表里**已声明**的原生写法去行文里找"盖住光标的那一段"。宿主只需要一条通用
 * 词法边界（两侧都不是记号字符 ⇒ 独立成词，`EVENTTIME` 里的 `TIME` 不算命中），不需要认识
 * 任何一族名字。多段同时盖住时取**最长**那段（`RESULTS` 压过 `RESULT`），与"整串优先"同向。
 *
 * ## 只取三格
 *
 * `event`（`EVENTFIRST` → 初见）、`symbol`（`%CALLNAME:TARGET%` → 我）、`presentation`
 * （`HPH_PRINT` → 心形）。`storage`（`LOCAL` / `SAVEDATA` / `TCVAR`）**刻意不收**：那三个词
 * 在 ERB 里同时是槽头与 `#DIM` 修饰词，拿它们当表层名去悬停只会与既有的变量 / 槽位悬停抢答，
 * 是噪声不是信息。
 *
 * ## 三条纪律
 *
 * 1. **不抢已有事实**：调用方只在前面所有路都没答案时才问这一格；
 * 2. **恒等落点不算信息**：`TIME` → `TIME` 这种（表里确有，eraTW 的外部变量那几条）跳过——
 *    作者看到两个一模一样的词只会困惑；
 * 3. **不猜**：表缺席 / 读表模块还没装载 / 查不到 ⇒ `null`，一个字都不编。
 *
 * 多名一落点（`%CALLNAME:TARGET%` 上挂着 `我` 与 `她`）按表的**声明序**取首条——那是方言包
 * 的数据裁决，宿主不另立规则、不"取最短"、不拼成一句。
 */

/** 记号字符集：与 `plugin-api` 的 `MODEL_TOKEN_CLASS` 同一值域（只用来判"独立成词"） */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * 事实面的四格（与 `@kojo/kojo-core` 的 `DialectFactKind` **同一值域**）。
 *
 * 这里重写一遍而不 import：本文件是开机图**外**的懒模块，值域只有四个字面量，为它拉一条
 * `kojo-core` 的类型边不值（且宿主的解耦审计只认"包 exports 的懒叶"，不为类型开例外）。
 */
export type SurfaceFactKind = 'event' | 'symbol' | 'presentation' | 'storage';

export interface SurfaceNameHint {
  readonly name: string;
  readonly kind: string;
  readonly startColumn: number;
  readonly endColumn: number;
}

/** 表里一行的**最小结构面**（只读 `native`；`surface` 由 `surfacesOfNative` 统一投影） */
interface SurfaceRow {
  readonly native?: unknown;
}

/** 读表面的**最小结构面**：两枚函数，不 import 那个包的其余部分 */
export interface SurfaceReadApi {
  readonly surfacesOfNative: (table: unknown, kind: SurfaceFactKind, native: string) => readonly string[];
  readonly surfaceMappingsOf: (table: unknown, kind: SurfaceFactKind) => readonly SurfaceRow[];
}

/** 反查的三格（顺序即优先序；`storage` 不收的理由见模块头注） */
const SURFACE_NAME_KINDS: readonly { readonly kind: SurfaceFactKind; readonly label: string }[] = [
  { kind: 'event', label: '引擎事件' },
  { kind: 'symbol', label: '原生记号' },
  { kind: 'presentation', label: '演出提示' },
];

/**
 * 原生写法 `native` 在 `lineText` 里**盖住 `column`（1 基）**的那一段区间；没有 ⇒ `null`。
 *
 * 三条口径：两侧都得是词边界（独立成词）；只认盖住光标的段；同一 `native` 出现多次时逐段试。
 */
function spanOfNative(
  lineText: string,
  column: number,
  native: string,
): { readonly startColumn: number; readonly endColumn: number } | null {
  if (native.length === 0) return null;
  for (let from = 0; from + native.length <= lineText.length; ) {
    const at = lineText.indexOf(native, from);
    if (at < 0) return null;
    const before = at === 0 ? '' : lineText[at - 1]!;
    const after = at + native.length >= lineText.length ? '' : lineText[at + native.length]!;
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) {
      const startColumn = at + 1;
      const endColumn = at + native.length + 1;
      if (column >= startColumn && column < endColumn) return { startColumn, endColumn };
    }
    from = at + 1;
  }
  return null;
}

/**
 * 原生写法 → 作者面名字（纯函数，供单测：喂一张表 + 一枚假读表面即可）。
 *
 * `null` 的四种情形都是"不猜"：没表 / 没读表面 / 光标不在任何已声明落点上 / 表里查不到
 * （或只查到恒等的那一条）。
 */
export function surfaceNameHintOf(
  lineText: string,
  column: number,
  table: unknown,
  api: SurfaceReadApi | null,
): SurfaceNameHint | null {
  if (table === null || table === undefined || api === null) return null;
  for (const { kind, label } of SURFACE_NAME_KINDS) {
    let rows: readonly SurfaceRow[];
    try {
      rows = api.surfaceMappingsOf(table, kind);
    } catch {
      continue; // 单格抛错只丢它自己（表是第三方数据，形状由读表面把关）
    }
    if (!Array.isArray(rows)) continue;

    // 同一格内多段盖住光标 ⇒ 取最长那段（`RESULTS` 压过 `RESULT`，与"整串优先"同向）
    let best: { readonly native: string; readonly startColumn: number; readonly endColumn: number } | null = null;
    for (const row of rows) {
      const native = typeof row?.native === 'string' ? row.native : '';
      const span = spanOfNative(lineText, column, native);
      if (span === null) continue;
      if (best === null || span.endColumn - span.startColumn > best.endColumn - best.startColumn) {
        best = { native, startColumn: span.startColumn, endColumn: span.endColumn };
      }
    }
    if (best === null) continue;

    let names: readonly string[];
    try {
      names = api.surfacesOfNative(table, kind, best.native);
    } catch {
      continue;
    }
    if (!Array.isArray(names)) continue;
    const { native, startColumn, endColumn } = best;
    const distinct = names.filter((name) => typeof name === 'string' && name !== native);
    if (distinct.length > 0) return { name: distinct[0]!, kind: label, startColumn, endColumn };
  }
  return null;
}

/* ------------------------------ 读表模块的懒边 ------------------------------ */

let readApiPromise: Promise<SurfaceReadApi | null> | null = null;
let readApiNow: SurfaceReadApi | null = null;

/**
 * 取 `@kojo/kojo-core/surface-map` 的读表面（幂等；失败 ⇒ `null` 并**缓存这个失败**）。
 *
 * 打包器不认 exports 叶子 / 版本改名 ⇒ 这条懒边在当前构建上不通，反查这一格安静缺席
 * （它只是悬停的增益，不是主线功能，所以不抛也不刷屏）。
 */
export function surfaceReadApi(): Promise<SurfaceReadApi | null> {
  if (readApiPromise === null) {
    readApiPromise = (async () => {
      try {
        // @ts-ignore 深叶不带 .d.ts（包只发桶的类型面）；本模块只用这两枚读函数
        const mod = (await import('@kojo/kojo-core/surface-map')) as SurfaceReadApi;
        readApiNow =
          typeof mod.surfacesOfNative === 'function' && typeof mod.surfaceMappingsOf === 'function' ? mod : null;
        return readApiNow;
      } catch {
        return null;
      }
    })();
  }
  return readApiPromise;
}

/** 已结算的读表面（同步快照；`null` = 还没好 / 这条路不通） */
export function surfaceReadApiNow(): SurfaceReadApi | null {
  return readApiNow;
}
