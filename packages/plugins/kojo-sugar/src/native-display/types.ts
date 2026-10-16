/**
 * **零原生整行**契约（kojo 全中文化系列，2026-10-17 lead 定）。
 *
 * ## 这一层在解决什么
 *
 * `.kojo 预览` 是**只读派生视图**——它唯一的用途是让口上作者读懂既有 `.ERB` 的逻辑、
 * 并知道下一行该怎么写。它**不参与任何写回**：磁盘那份 `.ERB` 一个字节都不动，
 * 也不存在"原文转糖再编译"这条链路。因此这一层的成败只有一条判据：
 *
 * > **屏上不许出现一整行原样 ERB。** 行内残留英文记号（引擎名 `FIRSTTIME`、
 * > 槽位原名 `噴乳`）是允许的；**整行等于源文件那一行**是不允许的。
 *
 * 今天投影对认不出的行走 `native()`（`text: ''` ⇒ 宿主原样透传），实测整篇行覆盖
 * 只有 60.8%（`docs/STATE.md` §一 CR-1 读数）——剩下的四成就是"作者仍在读 ERB"。
 * 本文件是那四成的**单一收敛点**：所有"把一行 ERB 翻成作者可读形"的能力都从这里进出。
 *
 * ## 为什么是「pass 列表」而不是一张大表
 *
 * 控制流与声明（`IF` / `#DIM` / `$标签`）和赋值与调用（`TFLAG:193 = 1` / `CALL X`）
 * 是两条完全不同的识别路，硬挤在一个函数里必然长成一面判据墙。拆成两个 pass
 * （`control.ts` / `statement.ts`），**顺序即优先级**，谁都不许 `import` 谁。
 *
 * ## 失败口径（铁律 4「内核不静默」在这一层的投影）
 *
 * - pass 认不出 → 返回 `null`（**不得**原样返回入参行——那等于把 ERB 交回屏幕）；
 * - 全部 pass 返回 `null` → 调用方（投影）**必须**给一条显式兜底显示
 *   （标出"这行本工具读不懂 + 原因"），**不得**静默透传原文；
 * - 查不到别名 / 查不到中文名 → 该记号原样保留，**绝不猜**。
 */

/**
 * 外部中文形态查询器（由装配方注入，**可选**）。
 *
 * 缺席（`lookup === undefined`）时 pass 只做**语言层**替换（`IF` → `如果`、
 * `CALL` → `调用`），不碰游戏层名表——这样无工程 / 无 adapter 时预览照常工作。
 */
export interface NativeDisplayLookup {
  /** 引擎族头（大写原文）→ 作者可写中文别名（`TFLAG` → `时标`）；未登记 = `undefined` */
  familyAlias(engineFamilyUpper: string): string | undefined;
  /** 槽位原名 → 中文名（`NOWEX` + `噴乳` → `胸`一类的汉化名）；未登记 = `undefined` */
  slotCn(engineFamilyUpper: string, indexName: string): string | undefined;
}

/** 单行输入（**已剥前导缩进**；行尾注释保留在 `content` 里，由 pass 自己决定是否剥离） */
export interface NativeDisplayInput {
  /** 行内容原文（未命中时不许拿它当返回值） */
  readonly content: string;
  /** 缩进层级（显示用；判据不许依赖绝对值，只许依赖"是否比外层更深"） */
  readonly indent: number;
  readonly lookup?: NativeDisplayLookup;
}

/**
 * 一条识别路：认得出 → 返回作者可读显示形；认不出 → `null`。
 *
 * 返回值**必须非空且与 `input.content` 逐字不等**（`localizeNativeLine` 会拒绝原样返回，
 * 这样"偷偷透传"在结构上不可能发生，而不是靠自觉）。
 */
export type NativeDisplayPass = (input: NativeDisplayInput) => string | null;

/**
 * 「整行原样 ERB」的唯一判据（尺子与产品共用，禁第二份口径）。
 *
 * 投影产出的某一行若与源文件对应行**剥空白后逐字相同**，且那一行既不是空行也不是
 * 注释行，就是**一整行原生 ERB**——这是全中文化系列要归零的量。
 */
export function isVerbatimNativeLine(projected: string, source: string): boolean {
  const a = projected.trim();
  const b = source.trim();
  if (a.length === 0 || b.length === 0) return false;
  if (b.startsWith(';') || a.startsWith(';')) return false; // 注释行本来就是给人读的
  return a === b;
}

/** 统计一份投影里还有多少「整行原样 ERB」（读数用；行号 0 基） */
export function countVerbatimNativeLines(
  projectedLines: readonly string[],
  sourceLines: readonly string[],
): { count: number; lines: number[] } {
  const lines: number[] = [];
  const n = Math.min(projectedLines.length, sourceLines.length);
  for (let i = 0; i < n; i++) {
    if (isVerbatimNativeLine(projectedLines[i] ?? '', sourceLines[i] ?? '')) lines.push(i);
  }
  return { count: lines.length, lines };
}
