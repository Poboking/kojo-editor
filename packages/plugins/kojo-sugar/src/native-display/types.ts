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

/**
 * 源行是否**计入红线面积**：空行、`;` 注释、`[SKIPSTART]` / `[SKIPEND]` 不计。
 *
 * 为什么单列一条：红线量 = 「未被投影接管、且作者真的得读它」的源行数。
 * 空行与注释不是"没中文化的 ERB"，把它们算进去只会让读数虚高、掩盖真问题；
 * `[SKIP]` 区连引擎都不执行，更不是要读的东西。
 */
export function isCountableErBLine(source: string): boolean {
  const t = source.trim();
  if (t.length === 0) return false;
  if (t.startsWith(';')) return false;
  return t !== '[SKIPSTART]' && t !== '[SKIPEND]';
}

/** 投影段的最小结构（避开对 `@kojo/plugin-api` 段类型的依赖；字段与 `SugarProjectSegment` 同名同义） */
export interface VerbatimSegmentShape {
  /** 源区间起点（1 基，含） */
  readonly fromLine: number;
  /** 源区间终点（1 基，含） */
  readonly toLine: number;
  /** 该段的糖写法（多行，`\n` 分隔） */
  readonly sugarText: string;
}

/** 红线读数（面积拆分，便于逐线追责） */
export interface VerbatimMeasurement {
  /** 红线总行数（= 未被接管 + 段内逐字透传） */
  readonly count: number;
  /** 未被任何段接管的源行数（今天的主要面积：宿主原样透传） */
  readonly uncovered: number;
  /** 被段接管、但糖文本与源行逐字相同的行数（1:1 对齐的段才可比） */
  readonly echoed: number;
  /** 计入面积的源行总数（分母：非空、非注释、非 `[SKIP]` 标记） */
  readonly total: number;
  /** 明细（1 基行号 + 原文，便于报红格式「屏上原样文案」） */
  readonly hits: ReadonlyArray<{ line: number; text: string }>;
}

/**
 * **段感知**的红线尺子（系列唯一实现；宿主与测试都走这里，禁自己数）。
 *
 * 面积定义：
 * - `uncovered`：源行不在任何投影段区间内 ⇒ 上屏就是它自己 ⇒ 一整行 ERB；
 * - `echoed`：段内糖文本与源行**行数 1:1 对齐**（段区间源行数 == 糖行数）时逐行比对，
 *   相同即"接管了但什么都没改"；非 1:1 的段无法对齐比较，不参与本项（**不猜**）。
 *
 * 分母 `total` 只算**作者真得读的行**：空行、`;` 注释、`[SKIPSTART]`/`[SKIPEND]` 不计。
 */
export function measureVerbatimNativeLines(
  sourceLines: readonly string[],
  segments: readonly VerbatimSegmentShape[],
): VerbatimMeasurement {
  const covered = new Set<number>();
  for (const seg of segments) {
    for (let ln = seg.fromLine; ln <= seg.toLine; ln++) covered.add(ln);
  }

  const hits: { line: number; text: string }[] = [];
  let uncovered = 0;
  let echoed = 0;
  let total = 0;

  for (let i = 0; i < sourceLines.length; i++) {
    const src = sourceLines[i] ?? '';
    if (!isCountableErBLine(src)) continue;
    total++;
    if (!covered.has(i + 1)) {
      uncovered++;
      hits.push({ line: i + 1, text: src.trim() });
    }
  }

  for (const seg of segments) {
    const srcCount = seg.toLine - seg.fromLine + 1;
    const sugarLines = seg.sugarText.split('\n');
    if (sugarLines.length !== srcCount) continue; // 非 1:1 ⇒ 无法对齐，不猜
    for (let k = 0; k < srcCount; k++) {
      const src = sourceLines[seg.fromLine - 1 + k] ?? '';
      if (!isCountableErBLine(src)) continue;
      if (isVerbatimNativeLine(sugarLines[k] ?? '', src)) {
        echoed++;
        hits.push({ line: seg.fromLine + k, text: src.trim() });
      }
    }
  }

  hits.sort((a, b) => a.line - b.line);
  return { count: uncovered + echoed, uncovered, echoed, total, hits };
}
