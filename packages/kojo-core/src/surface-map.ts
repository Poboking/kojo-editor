/**
 * 表层 ↔ 原生**双向映射表**的读表面（LAU-D4 车②；`ARCH-language-unification.md` §8 LAU-D4）。
 *
 * ## 这张表回答什么问题
 *
 * 作者面写的是一个名字（`# 机` / `@织` 里的事件名、`{我}` 这类代词、`好感度` 这类属性名、
 * `# 设` 的存储期、`(心形)` 这类演出提示），原生方言写法是另一个（引擎事件常量、引用模板、
 * `族:编号`、变量族名、引擎指令名）。这层对应今天**散在四个事实面各自的字段里**：
 * `eventCatalog.events[].engine` / `domainSymbols.*[].engineRef|family+index|engine` /
 * `storageClasses.classes[].engine` / `presentation.heart.engine`——每一面只会**正向**查
 * （按作者名找落点），反向（盘上落点 → 作者叫什么）没有单一入口，各自 ad hoc 抄一份。
 *
 * 本文件把这**一族**收成一张表：一条 = 一对 `(表层名 → 原生写法)`，正向与反向都从**同一批行**
 * 投影出来（没有第二份数据可漂），并且与四个事实面逐条对账。
 *
 * ## 三条纪律（与 LAU-D1 载体表同形同尺）
 *
 * 1. **表是数据，不是判据**：本文件零游戏名词、零 IO、零异步；真源永远是方言包交来的
 *    `readonly SurfaceMapping[]`（与各适配器包里的 `*_SURFACE_MAP` 同一形态），这里只读它；
 * 2. **省略 = 未声明**（`undefined` / 非数组 ≠ 空表）：没声明就一概不判（`checkSurfaceMap`
 *    返回空数组），与 `carriers` 的"没问就不判"同一口径——今天没有 `surfaceMap` 那一格的
 *    适配器（eraFL / eraAV / eraAkumaMaid / fixture 与各 v1-only 适配器）**零改动、零新诊断**；
 * 3. **错配必红**（铁律 4）：表与事实面对不上 ⇒ 三枚 error 码可见（`core/surface/dangling`
 *    指向不存在的原生写法 / 落点与事实面不同、`core/surface/contested` 同一原生写法被两条
 *    表层名争用、`core/surface/unmapped` 事实面有名字而表里缺）。不静默、不"取首条"裁决。
 *
 * ## 为什么不挂进 `GameAdapter`（而是走包的一条懒边）
 *
 * `carriers` 是 `GameAdapter` 的可选格，本批**刻意不加** `surfaceMap` 那一格：方言包总装
 * `*_GAME_ADAPTER` 落在开机静态依赖图里（PS-10 闸今天 200 文件 / 3,509 KB **双双顶格**），
 * 挂进去就是新增一枚在图文件 + 若干 KB ⇒ 当场撞闸。所以表以**方言包的新 `exports` 叶子**
 * 交付（同 `@kojo/kojo-lang/completion` 一族先例），读表函数按 `(事实, 表)` 两参显式调用。
 * 宿主接线（悬停 / 补全改吃这张表）是后续车的事，本批不动 `packages/app` 一个字。
 *
 * ## `kind` 为什么复用 `DialectFactKind`
 *
 * 四格 = `GameAdapter` 的四个事实面，与 `carriers[].validates` 同一值域。表不收**语法位**
 * （`# 机` / `@织` / `@函` 这些 `#`/`@` 系列关键字是跨方言共用的表层语法，按 D9/R6 三轴正交
 * 归语法面，车①头注同一裁决），也不收**发射形状**（`@函` 的标号拼法、`# 池` 的块关键字属
 * backend 与 emit 数据，本批不碰 backend）。角色名也不收：eraTW 的说话人是开放名表
 * （`domainSymbols.speakers.kind = 'project'`，上千角色名），契约层不猜 ⇒ 表的 `surface`
 * 只收方言包**自己声明得出**的那四类名字。
 */
import type { DialectFactKind, GameAdapter } from './adapter.js';
import type { CoreDiagnosticCode, KojoDiagnostic } from './diagnostics.js';
import { severityOf } from './diagnostics.js';

/* ============================== 1. 表的形状 ============================== */

/**
 * 一条「作者面名字 ↔ 原生方言写法」的对应。
 *
 * 口径（写死，别扩）：
 * - `kind` 决定这一条去**哪一个事实面**对账（值域复用 {@link DialectFactKind}，不新造概念）；
 * - `surface` 是作者在源端写的那个词（**不含**标记符号：`# 机 初见` 收 `'初见'`、
 *   `{我}` 收 `'我'`；存储期收事实面的 `period` 值，作者面的中文存储期词是跨方言语法位）；
 * - `native` 是原生写法的**单一真源文本**，其规范化形状按事实面固定（见 {@link factSurfacePairs}）；
 * - `aliases`（可省）是同一落点的**作者面别名**（本地化常用称呼、日文原名）。别名只多一个
 *   入口，不改落点：正向查得到、反向回到同一条 `surface`。
 */
export interface SurfaceMapping {
  readonly kind: DialectFactKind;
  readonly surface: string;
  readonly native: string;
  readonly aliases?: readonly string[];
}

/** 一张表（顺序 = 声明序 = 正向查询的优先序；与 `carriers` 同一口径） */
export type SurfaceMap = readonly SurfaceMapping[];

/** 事实面里读出的一对（`group` 说明它来自哪一枚**子面**，判"落点可否重合"要用） */
export interface SurfaceFactPair extends SurfacePair {
  /**
   * 子面标识：`event` / `pronoun` / `attribute` / `nameFunction` / `variable` /
   * `storage` / `hint`。它不是新契约格——只是把"这一条来自 `domainSymbols` 的哪张子表"
   * 说清楚，好让 {@link checkSurfaceMap} 判争用时按契约自己的建模来。
   */
  readonly group: SurfaceFactGroup;
}

/** 子面值域（与四个事实面的字段一一对应，不新增落点种类） */
export type SurfaceFactGroup =
  | 'event'
  | 'pronoun'
  | 'attribute'
  | 'nameFunction'
  | 'variable'
  | 'storage'
  | 'hint';

/** 纯的一对：作者面名字 ↔ 原生写法 */
export interface SurfacePair {
  readonly surface: string;
  readonly native: string;
}

/** `readSurfaceMap` 的形状读数（宿主装载从不跑 `validateGameAdapter`，这里自己防） */
export interface SurfaceMapReading {
  /** 表这一格给过（**含空数组**）⇒ `true`；`undefined` ⇒ 未声明，一概不判 */
  readonly declared: boolean;
  /** 形状合格、参与对账的条目（保持声明序） */
  readonly usable: readonly SurfaceMapping[];
  /** 形状坏、被跳过的条目数（整张表不是数组时记 1） */
  readonly skipped: number;
}

/** 四个事实面的固定遍历序（诊断消息里的 `kind` 顺序也取这一份） */
const SURFACE_KINDS: readonly DialectFactKind[] = ['event', 'symbol', 'presentation', 'storage'];

/* ============================== 2. 读表（形状 robust，不抛） ============================== */

/**
 * 读一张表的声明面。**"声明过"的判据是 `!== undefined`，不是 `length > 0`**：
 * 空数组 = 显式声明"本方言不映射任何名字"（同样参与对账 ⇒ 事实面有名字就报
 * `core/surface/unmapped`）；未声明 = 一概不问。坏条目跳过并计数，由调用方报成可见诊断。
 *
 * 条目合格判据：对象 + `kind` 在四格里 + `surface` / `native` 都是去空白后仍有内容的字符串 +
 * `aliases`（给了的话）是字符串数组。非数组入参按"声明了但零条可用 + 1 条坏"处理，**绝不抛**。
 */
export function readSurfaceMap(table: unknown): SurfaceMapReading {
  if (table === undefined) return { declared: false, usable: [], skipped: 0 };
  if (!Array.isArray(table)) return { declared: true, usable: [], skipped: 1 };
  const usable: SurfaceMapping[] = [];
  let skipped = 0;
  for (const item of table as readonly unknown[]) {
    if (!isUsableEntry(item)) {
      skipped += 1;
      continue;
    }
    usable.push(item);
  }
  return { declared: true, usable, skipped };
}

function isUsableEntry(item: unknown): item is SurfaceMapping {
  const entry = item as Partial<SurfaceMapping> | null;
  if (entry === null || typeof entry !== 'object') return false;
  if (!SURFACE_KINDS.includes(entry.kind as DialectFactKind)) return false;
  if (!filled(entry.surface) || !filled(entry.native)) return false;
  if (entry.aliases !== undefined) {
    if (!Array.isArray(entry.aliases)) return false;
    if (!entry.aliases.every((alias) => filled(alias))) return false;
  }
  return true;
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/* ============================== 3. 事实面投影（原生写法的规范化形状） ============================== */

/**
 * 从四个事实面投出这一 `kind` 的全部 `(表层名 → 原生写法)` 对（**只读，不改事实**）。
 *
 * 规范化形状（`native` 逐字取这里给的形态，表想对上了才算对——两侧同尺）：
 *
 * | kind | 来源字段 | `surface` | `native` |
 * | --- | --- | --- | --- |
 * | `event` | `eventCatalog.events[]` | `event` | `engine` |
 * | `symbol` | `domainSymbols.pronouns[]` | `pronoun` | `engineRef` |
 * | `symbol` | `domainSymbols.attributes[]` | `name` | `族:编号`（`family` + `:` + `index`） |
 * | `symbol` | `domainSymbols.nameFunctions[]` | `name` | `engine` |
 * | `symbol` | `domainSymbols.variables[]` | `name` | `name`（恒等落点：这一面的原生写法就是这个名字本身） |
 * | `presentation` | `presentation.hintNames[]` ×`heart.engine` | 提示名 | `heart.engine` |
 * | `storage` | `storageClasses.classes[]` | `period` | `engine` |
 *
 * `presentation` 只收**演出提示名**这一格：`@着色` / `@颜绘` / `选项` 的表层词是跨方言语法位，
 * 而它们的落点是一对多（`SETCOLOR` + `RESETCOLOR`、两条 `CALL`、`PRINTBUTTON` + `INPUTS` +
 * 读回槽），一张 `(一名 → 一写法)` 的表装不下一对多 ⇒ 宁缺毋滥，落点仍由 `presentation`
 * 事实面与发射器各按己责。子面里没有 `group` 的东西，本函数一概不发明。
 *
 * 入参形状坏（缺字段 / 非数组 / 非字符串）一律当"那一格没有名字"，**不抛**（宿主装载不跑
 * `validateGameAdapter`；坏了的对账由 {@link checkSurfaceMap} 报成可见诊断）。
 */
export function factSurfacePairs(facts: GameAdapter, kind: DialectFactKind): readonly SurfaceFactPair[] {
  const out: SurfaceFactPair[] = [];
  if (kind === 'event') {
    for (const spec of listable(facts?.eventCatalog?.events)) {
      if (filled(spec?.event) && filled(spec?.engine)) out.push({ surface: spec.event, native: spec.engine, group: 'event' });
    }
    return out;
  }
  if (kind === 'symbol') {
    const symbols = facts?.domainSymbols;
    for (const item of listable(symbols?.pronouns)) {
      if (filled(item?.pronoun) && filled(item?.engineRef)) out.push({ surface: item.pronoun, native: item.engineRef, group: 'pronoun' });
    }
    for (const item of listable(symbols?.attributes)) {
      if (filled(item?.name) && filled(item?.family) && typeof item?.index === 'number') {
        out.push({ surface: item.name, native: `${item.family}:${item.index}`, group: 'attribute' });
      }
    }
    for (const item of listable(symbols?.nameFunctions)) {
      if (filled(item?.name) && filled(item?.engine)) out.push({ surface: item.name, native: item.engine, group: 'nameFunction' });
    }
    for (const item of listable(symbols?.variables)) {
      if (filled(item?.name)) out.push({ surface: item.name, native: item.name, group: 'variable' });
    }
    return out;
  }
  if (kind === 'presentation') {
    const engine = facts?.presentation?.heart?.engine;
    if (filled(engine)) {
      for (const hint of listable(facts?.presentation?.hintNames)) {
        if (filled(hint)) out.push({ surface: hint, native: engine, group: 'hint' });
      }
    }
    return out;
  }
  for (const item of listable(facts?.storageClasses?.classes)) {
    if (filled(item?.period) && filled(item?.engine)) out.push({ surface: item.period, native: item.engine, group: 'storage' });
  }
  return out;
}

function listable<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/* ============================== 4. 双向投影（同一批行，两份读数） ============================== */

/**
 * **正向**：作者面名字（含别名）→ 原生写法。声明顺序 = 优先序，第一条命中即返回
 * （与 `findCarrierBinding` 同一口径）；查不到 ⇒ `undefined`，**不猜、不借别门方言的表**。
 *
 * ⚠ 只有过了 {@link checkSurfaceMap} 的表才谈得上"唯一答案"：一张有争用的表在这里
 * 只会交出先声明的那一条，而那条错配早已被判红。
 */
export function nativeOfSurface(table: unknown, kind: DialectFactKind, surface: string): string | undefined {
  const target = typeof surface === 'string' ? surface.trim() : '';
  if (target.length === 0) return undefined;
  for (const row of readSurfaceMap(table).usable) {
    if (row.kind !== kind) continue;
    if (row.surface === target) return row.native;
    if (row.aliases?.includes(target)) return row.native;
  }
  return undefined;
}

/**
 * **反向**：原生写法 → 指着它的那些表层名（声明序，去重）。反向与正向读的是**同一批行**，
 * 所以不存在"两份表各漂一半"的可能；合法数据下这一格通常只有一条，多条就是
 * {@link checkSurfaceMap} 要报的 `core/surface/contested`（代词那一子面除外，见该函数头注）。
 */
export function surfacesOfNative(table: unknown, kind: DialectFactKind, native: string): readonly string[] {
  const target = typeof native === 'string' ? native.trim() : '';
  if (target.length === 0) return [];
  const out: string[] = [];
  for (const row of readSurfaceMap(table).usable) {
    if (row.kind !== kind || row.native !== target) continue;
    if (!out.includes(row.surface)) out.push(row.surface);
  }
  return out;
}

/** 某一 `kind` 的全部条目（按声明序；补全/清单类投影用这一格，别自己再筛一遍） */
export function surfaceMappingsOf(table: unknown, kind: DialectFactKind): readonly SurfaceMapping[] {
  return readSurfaceMap(table).usable.filter((row) => row.kind === kind);
}

/* ============================== 5. 错配必红 ============================== */

/**
 * 表 ↔ 事实面对账（**只报不修**：诊断交回调用方，事实仍是方言包那份数据）。
 *
 * 三枚码（全 error，铁律 4）：
 *
 * 1. `core/surface/dangling`——表层名指向**不存在**的原生写法，或写的落点与事实面给的不一致；
 *    条目形状坏（{@link readSurfaceMap} 跳过的）也走这一枚，与 `core/carrier/unowned`
 *    承载"glob 非字符串"同一先例（同一族"表自己不合格"，不因形状另开码）；
 * 2. `core/surface/contested`——同一原生写法被两条表层名争用；以及同一条表层名/别名写了两遍、
 *    别名压到别条的名字上。
 *    **唯一合法的重合**是代词子面：`{我}` 与 `{她}` 同指 `%CALLNAME:…%` 那一格由契约自己建模
 *    （`requiresView` / `viewBound` 就是为了区分"何时重合"），所以合法性**从事实面判**：
 *    事实面本身就有 ≥2 条同落点的 `pronoun` 对时，表里同落点不算争用；其余子面（属性族槽、
 *    事件常量、变量族、指令名）两名一槽就是数据写反；
 * 3. `core/surface/unmapped`——事实面有这个名字、表里没有对应条目 ⇒ 作者面少一格
 *    （表"少写"与"写错"同样必须可见，否则双向表会悄悄退化成半张）。
 *
 * 未声明（`undefined`）⇒ 空数组，一概不判；空数组 ⇒ 判（事实面有名字就报 `unmapped`）。
 */
export function checkSurfaceMap(facts: GameAdapter, table: unknown): readonly KojoDiagnostic[] {
  const reading = readSurfaceMap(table);
  if (!reading.declared) return [];
  const diagnostics: KojoDiagnostic[] = [];

  if (reading.skipped > 0) {
    diagnostics.push(
      make(
        'core/surface/dangling',
        `表层映射表里有 ${reading.skipped} 条形状坏了（不是对象、kind 不在四格里，或 surface / native 是空串）` +
          '：这些条目**不参与对账**，它们指向的作者面名字会查不到落点——请检查方言包数据。',
      ),
    );
  }

  for (const kind of SURFACE_KINDS) {
    const rows = reading.usable.filter((row) => row.kind === kind);
    const pairs = factSurfacePairs(facts, kind);
    const bySurface = new Map(pairs.map((pair) => [pair.surface, pair]));

    /* ① 表层名 → 落点：不存在 / 与事实面不同 */
    for (const row of rows) {
      const pair = bySurface.get(row.surface);
      if (pair === undefined) {
        diagnostics.push(
          make(
            'core/surface/dangling',
            `表层映射表把「${row.surface}」（${kind} 面）指向原生写法 ${row.native}，` +
              `但这一门方言的 ${kind} 事实面里没有这个名字 ⇒ 作者写了它落不到任何原生落点。`,
          ),
        );
        continue;
      }
      if (pair.native !== row.native) {
        diagnostics.push(
          make(
            'core/surface/dangling',
            `表层映射表把「${row.surface}」（${kind} 面）写成 ${row.native}，` +
              `而事实面给的落点是 ${pair.native} ⇒ 表与事实分家，以事实面为准请改表。`,
          ),
        );
      }
    }

    /* ② 事实面有、表里缺 */
    const declared = new Set(rows.map((row) => row.surface));
    for (const pair of pairs) {
      if (declared.has(pair.surface)) continue;
      diagnostics.push(
        make(
          'core/surface/unmapped',
          `事实面（${kind} 面）里有「${pair.surface}」→ ${pair.native}，表层映射表里没有这一条` +
            '⇒ 这一面的作者名反查不到、正向投影也少一格，请补进方言包的表。',
        ),
      );
    }

    /* ③ 争用：一名多落点 / 两名一落点 / 别名压名 */
    pushContested(diagnostics, rows, pairs, kind);
  }

  return diagnostics;
}

/** 争用判定（同一 `kind` 内；合法重落的例外只承认代词子面，理由见 {@link checkSurfaceMap}） */
function pushContested(
  diagnostics: KojoDiagnostic[],
  rows: readonly SurfaceMapping[],
  pairs: readonly SurfaceFactPair[],
  kind: DialectFactKind,
): void {
  /* 一名两落点（含别名指向第二条）：正向会按声明序吞掉后一条，所以必须点名 */
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const name of [row.surface, ...(row.aliases ?? [])]) {
      const prior = seen.get(name);
      if (prior !== undefined && prior !== row.native) {
        diagnostics.push(
          make(
            'core/surface/contested',
            `表层名「${name}」（${kind} 面）同时指向 ${prior} 与 ${row.native}` +
              '⇒ 正向查询只会按声明序取到第一条，第二条永远查不到（本层不设"取首条"的静默裁决）。',
          ),
        );
      } else if (prior === row.native) {
        diagnostics.push(
          make(
            'core/surface/contested',
            `表层名「${name}」（${kind} 面）在表里写了两遍（同为 ${row.native}）` +
              '⇒ 一条名字一行数据；重复条目会让反向投影出重影。',
          ),
        );
      } else {
        seen.set(name, row.native);
      }
    }
  }

  /* 两名一落点：只有事实面自己允许重合的子面（代词）才放行 */
  const collapseAllowed = allowedCollapseGroups(pairs);
  const byNative = new Map<string, string[]>();
  for (const row of rows) {
    const holders = byNative.get(row.native) ?? [];
    if (!holders.includes(row.surface)) holders.push(row.surface);
    byNative.set(row.native, holders);
  }
  for (const [native, holders] of byNative) {
    if (holders.length < 2) continue;
    const groups = new Set(holders.map((name) => pairs.find((pair) => pair.surface === name)?.group));
    if (groups.size === 1 && collapseAllowed.has([...groups][0] as SurfaceFactGroup)) continue;
    diagnostics.push(
      make(
        'core/surface/contested',
        `原生写法 ${native}（${kind} 面）被 ${holders.length} 条表层名争用（${holders.join(' / ')}）` +
          '⇒ 同一个落点两个作者名，反查会二选一（契约建模了这种重合的只有代词子面，其余都是数据写反）。',
      ),
    );
  }
}

/** 事实面里"同一落点本来就有 ≥2 条名字"的那些子面 ⇒ 表照抄这份重合不算争用 */
function allowedCollapseGroups(pairs: readonly SurfaceFactPair[]): Set<SurfaceFactGroup> {
  const perGroup = new Map<SurfaceFactGroup, Map<string, number>>();
  for (const pair of pairs) {
    const counts = perGroup.get(pair.group) ?? new Map<string, number>();
    counts.set(pair.native, (counts.get(pair.native) ?? 0) + 1);
    perGroup.set(pair.group, counts);
  }
  const allowed = new Set<SurfaceFactGroup>();
  for (const [group, counts] of perGroup) {
    for (const hits of counts.values()) {
      if (hits >= 2) allowed.add(group);
    }
  }
  return allowed;
}

function make(code: CoreDiagnosticCode, message: string): KojoDiagnostic {
  return Object.freeze({ code, severity: severityOf(code), message, span: null });
}
