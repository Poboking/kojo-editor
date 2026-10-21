/**
 * `@织` 项目级层分析（K2-WEAVE-LAYER；设计稿 §8.6、§10.5、§16.3 A3.9、§16.6 S5.3/S5.4）。
 *
 * ## 为什么单独一枚
 *
 * `analysis.ts` 的 `analyzeProject` 吃的是**装配层已汇总的事实**（`ProjectWeaveFact[]`），
 * 判定面是"同覆盖层是否有多枚接管"；本模块吃的是**已解析的文件**
 * （`{ filePath, file }[]`，`KojoFile` 来自 core 自身）+ adapter 的两个纯数据端口，
 * 要给出 `@织` 的完整层读数：`#PRI/#LATER/#ONLY` 三桶、优先级模型是否支持修饰词、
 * 同事件同层的接管冲突、以及被更高优先级接管压掉的监听（含链式压盖）。
 *
 * 两者**共享同一套事实与口径**：事实类型用 `ProjectWeaveFact`、采集用
 * `collectFileFacts`、排序用 `ordering.ts`、码字用 `diagnostics.ts` 的既有闭集。
 * 本模块不另造事实、不另造码、不产渲染好的诊断字符串表（只给结构，渲染/落盘归宿主）。
 *
 * ## 输入 / 输出
 *
 * - 输入：`documents: readonly { filePath, file }[]`（可带 `layerId` 表示覆盖层）
 *   + `adapter`（`eventCatalog` / `layerPolicy` 两个端口；真实 `GameAdapter` 结构上
 *   直接满足，调用方零转换）。
 * - 输出：`{ conflicts, shadowed, units }` 三张**纯数据**表。
 *   - `conflicts` / `shadowed` 每条是 `{ code, severity, message, spans, files }` 结构
 *     （**只给结构，不产渲染好的诊断字符串表**）；`spans` 里的落点按
 *     （文件路径 → 起点 → 终点）稳定排序，`files` 去重后按码元序排序。
 *   - `units` 是**逐监听块**的判定表（"unit" 沿用 core 既有词义：一个 `@织` 监听块，
 *     与 `storage.ts` 的 `unitId` 同口径）：块本身 + 落的桶 + 适用层模式 + 结论
 *     （会执行 / 接管 / 被压 / 被阻断）+ 冲突码 + "被谁压"。
 * - 确定性：三张表一律按（**事件名 → 文件路径 → 行号**）稳定排序；同一份输入调用两次、
 *   或打乱文件与声明顺序，结果逐字节相同。
 * - 零 IO：不读盘、不 import kernel / 插件 / 新依赖、不进 adapter 包。
 *
 * ## 判定口径（逐条决策，供审阅）
 *
 * 1. **优先级桶**：`之前`→`#PRI`（pri）、`之后`→`#LATER`（later）、`接管`→`#ONLY`（only）、
 *    无修饰词→普通桶（plain）。`接管` 是最高优先级层：与它同事件同层并存的其余监听
 *    全部被压（§8.6「接管 会压掉同事件其他监听」）；`之前/之后` 只决定执行次序，不压东西。
 * 2. **修饰词**：一枚为限（重复或并用 → `core/weave/modifier-conflict`）。事件的优先级模型
 *    **不是** `emuera-buckets` 时写修饰词 → `core/weave/unsupported`（没有 `#PRI` 落点）。
 *    这两类监听语义未定义：只报冲突、**不参与接管/被压推理**（不猜），在 `units`
 *    里的结论记为 `blocked`。
 * 3. **多个接管**：同事件同层多个 `接管` → `core/weave/multiple-only` error，`spans` 列出
 *    全部接管者。是否按覆盖层豁免**照 adapter 的 layerPolicy 数据**（本模块不写死模式）：
 *    `kojo-overlay` 目标声明 `overlay` 时，不同 `layerId` 的接管合法（翻译/多版本），
 *    同一 `layerId` 内重复仍是 error；`unique` / `shared-hook` 不豁免——接管是独占语义，
 *    共享钩子只放宽共享钩子的多定义，救不了"同事件两个接管"。
 * 4. **被压监听**：同事件同层只要存在 `接管`，其余监听全部进 `shadowed`
 *    （`core/weave/shadowed-listener`，warning），`suppressors` 记录"被谁压"（全部接管者，
 *    稳定排序）。多个接管并存（已报冲突）时彼此互压——只能有一个执行，于是形成
 *    A 压 B、B 压 C 的链：B 的 `suppressors` = [A]，C 的 = [A, B]。
 *    跨覆盖层的接管按第 3 条互不压盖（与 `analysis.ts` 一致）。
 * 5. **能力检查（S5.4）**：事件不在 `eventCatalog` → `core/weave/unsupported`；事件声明
 *    `weavable: false` → `core/weave/not-weavable`（S5.6 additive；"声明不可监听"与"adapter
 *    不认识这个事件"是两件事，提示方向不同）。`weavable` 缺省视为可监听
 *    （additive，老事实不带这一格）。
 * 6. **层模式来源**：基座层（无 `layerId`）读 `layerPolicy` 的 `event-hook` 规则，覆盖层
 *    （有 `layerId`）读 `kojo-overlay` 规则；没有规则退 `defaultMode`，再缺省 `unique`（最严）。
 * 7. **普通监听多份不是冲突**：§8.6 明确"同一事件可有多个 `@织`，全部执行；桶内按装载
 *    顺序"，所以 `layerPolicy=unique` 也不把同事件同层的多枚普通监听判成冲突——`unique`
 *    是针对"同名"的（监听没有名字）。若将来要按 unique 收紧监听多份，语义上需要一枚新码
 *    （现有闭集里没有"同事件同层多监听"的码），不在本波私造。
 */
import type { KojoFile, KojoWeaveModifier } from '../ast.js';
import { severityOf, type CoreDiagnosticCode } from '../diagnostics.js';
import { collectFileFacts, type LayerPolicyMode, type ProjectWeaveFact } from './analysis.js';
import {
  compareLocated,
  compareText,
  formatLocation as locationText,
  sortLocated,
  type Located,
} from './ordering.js';

/* ============================== 输入 ============================== */

/** adapter 的优先级模型（`EventSpec.priority` 的同集结构对应物；本层只关心是否 emuera 分桶） */
export type WeaveLayerPriorityModel = 'emuera-buckets' | 'load-order' | 'none';

/** adapter 的事件事实（`EventSpec` 的**最小子集**；真实 adapter 结构上直接满足） */
export interface WeaveLayerEventFact {
  readonly event: string;
  readonly priority: WeaveLayerPriorityModel;
  /** 可否被 `@织` 监听；缺省 = 可（additive，老事实不带这一格） */
  readonly weavable?: boolean;
}

/** adapter 的事件目录事实（`EventCatalog` 的最小子集；未知事件 = 不在表里） */
export interface WeaveLayerEventCatalogFacts {
  readonly events: readonly WeaveLayerEventFact[];
}

/** LayerPolicy 的规则目标（`LayerRule.target` 的同集结构对应物） */
export type WeaveLayerTarget = 'function' | 'event-hook' | 'kojo-overlay';

/** 一条 LayerPolicy 规则（与 adapter 的 `LayerRule` 同形） */
export interface WeaveLayerLayerRule {
  readonly target: WeaveLayerTarget;
  readonly mode: LayerPolicyMode;
}

/** LayerPolicy 事实（与 adapter 的 `LayerPolicy` 同形；`defaultMode` 缺省口径由调用方给） */
export interface WeaveLayerLayerPolicyFacts {
  readonly defaultMode: LayerPolicyMode;
  readonly rules: readonly WeaveLayerLayerRule[];
}

/** 本模块需要的 adapter 事实（两个纯数据端口；`GameAdapter` 结构上直接满足） */
export interface WeaveLayerAdapterFacts {
  readonly eventCatalog: WeaveLayerEventCatalogFacts;
  readonly layerPolicy: WeaveLayerLayerPolicyFacts;
}

/** 一份待分析的已解析文件（**零 IO**：AST 由调用方给） */
export interface WeaveLayerDocument {
  readonly filePath: string;
  readonly file: KojoFile;
  /** 覆盖层标识（翻译 / 多版本）；缺省 = 基座层 */
  readonly layerId?: string;
}

/* ============================== 输出 ============================== */

/** 优先级桶：`之前`（#PRI）/ 普通 / `之后`（#LATER）/ `接管`（#ONLY） */
export type WeavePriorityBucket = 'pri' | 'plain' | 'later' | 'only';

/** 冲突种类（与 `code` 一一对应；`code` 是宿主可消费的稳定判据） */
export type WeaveLayerConflictKind =
  /** 同事件同层多个 `接管`（`core/weave/multiple-only`） */
  | 'multiple-takeover'
  /** 修饰词重复 / 并用（`core/weave/modifier-conflict`） */
  | 'modifier-conflict'
  /** 优先级模型不支持修饰词，`#PRI/#LATER/#ONLY` 无落点（`core/weave/unsupported`） */
  | 'priority-unsupported'
  /** 事件不在 adapter 目录（`core/weave/unsupported`） */
  | 'unknown-event'
  /** 事件声明不可被 `@织` 监听（`core/weave/not-weavable`） */
  | 'not-weavable';

/**
 * 一条结构化事实的公共面：**只给结构，不产诊断字符串表**。
 *
 * `severity` 由 `diagnostics.ts` 的码表推出（`severityOf`），不在这里另抄一份级别表。
 */
export interface WeaveLayerFactBase {
  /** 事件名（排序主键） */
  readonly event: string;
  readonly code: CoreDiagnosticCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** 涉及的全部落点（稳定排序；`files` 即由它去重得出） */
  readonly spans: readonly Located[];
  /** 涉及文件（去重、码元序） */
  readonly files: readonly string[];
}

/** 一条层冲突（error 级事实；`spans` 至少一条，含全部涉及落点） */
export interface WeaveLayerConflict extends WeaveLayerFactBase {
  readonly kind: WeaveLayerConflictKind;
  /** 冲突所在的优先级桶；`null` = 修饰词非法（无桶可归） */
  readonly bucket: WeavePriorityBucket | null;
  /** 冲突所在的覆盖层；`null` = 基座层（或跨层汇总） */
  readonly layerId: string | null;
}

/** 一条被压监听（warning 级事实；`suppressors` = 压住它的接管者，至少一条） */
export interface WeaveLayerShadowed extends WeaveLayerFactBase {
  readonly bucket: WeavePriorityBucket;
  /** 被压的监听本身（`ProjectWeaveFact`：事件 / 修饰词 / 文件 / 落点 / 覆盖层） */
  readonly listener: ProjectWeaveFact;
  /** 压住它的接管者（稳定排序；"被谁压"的机器可读面） */
  readonly suppressors: readonly ProjectWeaveFact[];
}

/**
 * 监听块的结论（优先级：`blocked` > `shadowed` > `takeover` > `effective`）。
 *
 * - `effective`：会执行（普通 / 之前 / 之后，且同层没有被接管压）；
 * - `takeover`：接管（独占；同事件同层没有并存的接管冲突）；
 * - `shadowed`：被同事件同层的接管压掉（只能有一个执行，但它本身会让路）；
 * - `blocked`：被冲突阻断（`codes` 非空），不参与推理。
 */
export type WeaveLayerUnitVerdict = 'effective' | 'takeover' | 'shadowed' | 'blocked';

/** 一个 `@织` 监听块（unit）的判定结果：逐块一行，按（事件 → 文件 → 行号）排序 */
export interface WeaveLayerUnit {
  /** 监听块事实（事件 / 修饰词 / 文件 / 落点 / 覆盖层；`ProjectWeaveFact`） */
  readonly listener: ProjectWeaveFact;
  /** 落的优先级桶（写出来的那个）；`null` = 修饰词非法。无落点（priorityModel 不支持）也照写记，结论 blocked */
  readonly bucket: WeavePriorityBucket | null;
  /** adapter 目录事实；`null` = 未知事件（不猜形状） */
  readonly priorityModel: WeaveLayerPriorityModel | null;
  /** 该块适用的层模式（基座层走 event-hook，覆盖层走 kojo-overlay；照 adapter 数据） */
  readonly layerMode: LayerPolicyMode;
  /** 结论（见 `WeaveLayerUnitVerdict`） */
  readonly verdict: WeaveLayerUnitVerdict;
  /** 本块上的冲突码（去重、码元序；`blocked` 时非空） */
  readonly codes: readonly CoreDiagnosticCode[];
  /** 压住它的接管者（`shadowed` 时非空；"被谁压"的机器可读面） */
  readonly suppressors: readonly ProjectWeaveFact[];
}

/** `analyzeWeaveLayers` 的结果（纯数据；不可变口径，零副作用） */
export interface WeaveLayerAnalysis {
  readonly conflicts: readonly WeaveLayerConflict[];
  readonly shadowed: readonly WeaveLayerShadowed[];
  readonly units: readonly WeaveLayerUnit[];
}

/* ============================== 内部工具 ============================== */

const MODIFIER_TEXT: Readonly<Record<KojoWeaveModifier, string>> = {
  pri: '之前',
  later: '之后',
  only: '接管',
};

/** 修饰词 → 桶；修饰词超过一枚（重复/并用）返回 null = 语义未定义 */
export function weaveBucketOf(modifiers: readonly KojoWeaveModifier[]): WeavePriorityBucket | null {
  if (modifiers.length > 1) return null;
  switch (modifiers[0]) {
    case undefined:
      return 'plain';
    case 'pri':
      return 'pri';
    case 'later':
      return 'later';
    case 'only':
      return 'only';
    default:
      return null;
  }
}

/** 一条监听 + 它落的桶（`null` = 修饰词非法） */
interface ListenerEntry {
  readonly fact: ProjectWeaveFact;
  readonly bucket: WeavePriorityBucket | null;
}

function layerKey(layerId: string | undefined): string {
  return layerId ?? '';
}

function layerLabel(key: string): string {
  return key === '' ? '基座层' : `覆盖层「${key}」`;
}

function layerIdOf(key: string): string | null {
  return key === '' ? null : key;
}

/** 有效层模式：精确目标规则 → defaultMode → unique（最严） */
function resolveLayerMode(
  policy: WeaveLayerLayerPolicyFacts | undefined,
  target: WeaveLayerTarget,
): LayerPolicyMode {
  const rule = policy?.rules.find((entry) => entry.target === target);
  return rule?.mode ?? policy?.defaultMode ?? 'unique';
}

/** 定位比较（按文件路径 → span；同键保留注入序） */
function sortEntries(entries: readonly ListenerEntry[]): ListenerEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareLocated(a.entry.fact, b.entry.fact) || a.index - b.index)
    .map(({ entry }) => entry);
}

function locationsText(items: readonly Located[]): string {
  return items.map((item) => locationText(item)).join('、');
}

function uniqueFiles(items: readonly Located[]): string[] {
  return [...new Set(items.map((item) => item.filePath))].sort(compareText);
}

function modifiersText(modifiers: readonly KojoWeaveModifier[]): string {
  return modifiers.map((modifier) => MODIFIER_TEXT[modifier]).join(' + ');
}

function conflictFact(input: {
  readonly kind: WeaveLayerConflictKind;
  readonly event: string;
  readonly bucket: WeavePriorityBucket | null;
  readonly layerId: string | null;
  readonly code: CoreDiagnosticCode;
  readonly facts: readonly Located[];
  readonly describe: (locations: string) => string;
}): WeaveLayerConflict {
  const spans = sortLocated(input.facts);
  return {
    kind: input.kind,
    event: input.event,
    bucket: input.bucket,
    layerId: input.layerId,
    code: input.code,
    severity: severityOf(input.code),
    message: input.describe(locationsText(spans)),
    spans,
    files: uniqueFiles(spans),
  };
}

function shadowedFact(input: {
  readonly event: string;
  readonly listener: ProjectWeaveFact;
  readonly suppressors: readonly ProjectWeaveFact[];
}): WeaveLayerShadowed {
  const suppressors = sortLocated(input.suppressors);
  const spans = sortLocated([input.listener, ...suppressors]);
  const sources = locationsText(suppressors);
  const location = locationText(input.listener);
  const bucket = weaveBucketOf(input.listener.modifiers) ?? 'plain';
  const code = 'core/weave/shadowed-listener' as const;
  const message =
    bucket === 'only'
      ? `事件「${input.event}」的「接管」（${location}）被同层并存的其余接管压住——多个接管只能有一个执行。压住它的接管者：${sources}。`
      : `监听（${location}）被同事件同层的「接管」压掉，运行期不会执行。接管者：${sources}。`;
  return {
    event: input.event,
    bucket,
    listener: input.listener,
    suppressors,
    code,
    severity: severityOf(code),
    message,
    spans,
    files: uniqueFiles(spans),
  };
}

function firstLocated(fact: WeaveLayerFactBase): Located {
  return fact.spans[0] ?? { filePath: '', span: null };
}

/** 事实统一排序：事件名 → 首个落点（文件路径 → 行号）→ 码 → 注入序 */
function sortFacts<T extends WeaveLayerFactBase>(facts: readonly T[]): T[] {
  return facts
    .map((fact, index) => ({ fact, index }))
    .sort(
      (a, b) =>
        compareText(a.fact.event, b.fact.event) ||
        compareLocated(firstLocated(a.fact), firstLocated(b.fact)) ||
        compareText(String(a.fact.code), String(b.fact.code)) ||
        a.index - b.index,
    )
    .map(({ fact }) => fact);
}

/** unit 统一排序：事件名 → 监听块落点（文件路径 → 行号）→ 注入序 */
function sortUnits(units: readonly WeaveLayerUnit[]): WeaveLayerUnit[] {
  return units
    .map((unit, index) => ({ unit, index }))
    .sort(
      (a, b) =>
        compareText(a.unit.listener.event, b.unit.listener.event) ||
        compareLocated(a.unit.listener, b.unit.listener) ||
        a.index - b.index,
    )
    .map(({ unit }) => unit);
}

/* ============================== 主入口 ============================== */

/**
 * 项目级 `@织` 层分析（纯函数）。
 *
 * `documents` 的每份文件先经 `collectFileFacts` 采出监听事实（只读 AST、零 IO），
 * 再按事件分组做单遍推理：修饰词 → 桶 → 能力检查 → 多接管 → 被压监听 → unit 汇总。
 * 任何一条 `conflicts` 都意味着项目不可编译（error），按 `severity === 'error'` 拒绝落盘。
 */
export function analyzeWeaveLayers(
  documents: readonly WeaveLayerDocument[],
  adapter: WeaveLayerAdapterFacts,
): WeaveLayerAnalysis {
  const catalog = new Map<string, WeaveLayerEventFact>();
  for (const spec of adapter.eventCatalog.events) {
    // adapter 装载期已校验事件名不重复；这里"先到先得"，不因重复事实改变判定。
    if (!catalog.has(spec.event)) catalog.set(spec.event, spec);
  }
  const baseMode = resolveLayerMode(adapter.layerPolicy, 'event-hook');
  const overlayMode = resolveLayerMode(adapter.layerPolicy, 'kojo-overlay');

  /* ---- 1) 采集：只吃 AST 事实，不解析表达式、不读盘 ---- */
  const byEvent = new Map<string, ListenerEntry[]>();
  for (const document of documents) {
    const facts = collectFileFacts(document.file, document.filePath, document.layerId);
    for (const fact of facts.weaves) {
      const entry: ListenerEntry = { fact, bucket: weaveBucketOf(fact.modifiers) };
      const list = byEvent.get(fact.event);
      if (list === undefined) byEvent.set(fact.event, [entry]);
      else list.push(entry);
    }
  }

  const conflicts: WeaveLayerConflict[] = [];
  const shadowed: WeaveLayerShadowed[] = [];
  const units: WeaveLayerUnit[] = [];

  /* ---- 2) 逐事件：结构冲突 → 推理集 → 多接管 → 被压 → 逐块判定 ---- */
  for (const event of [...byEvent.keys()].sort(compareText)) {
    const entries = sortEntries(byEvent.get(event)!);
    const spec = catalog.get(event);
    const known = spec !== undefined;
    const priorityModel: WeaveLayerPriorityModel | null = spec === undefined ? null : spec.priority;
    const prioritySupported = priorityModel === 'emuera-buckets';
    const weavable = spec === undefined || spec.weavable !== false;

    const eventConflicts: WeaveLayerConflict[] = [];
    const eventShadowed: WeaveLayerShadowed[] = [];
    /** 逐块账：冲突码 / 压住它的接管者（`units` 的机器可读面；Map 键是同一批事实对象） */
    const unitCodes = new Map<ProjectWeaveFact, CoreDiagnosticCode[]>();
    const unitSuppressors = new Map<ProjectWeaveFact, readonly ProjectWeaveFact[]>();
    const addUnitCode = (fact: ProjectWeaveFact, code: CoreDiagnosticCode): void => {
      const list = unitCodes.get(fact);
      if (list === undefined) unitCodes.set(fact, [code]);
      else list.push(code);
    };
    /** 进入接管/被压推理的监听（未知事件 / 不可监听 / 修饰词非法 / 无落点修饰词都排除） */
    const inference: ListenerEntry[] = [];

    for (const entry of entries) {
      const { fact, bucket } = entry;
      if (bucket === null) {
        addUnitCode(fact, 'core/weave/modifier-conflict');
        eventConflicts.push(
          conflictFact({
            kind: 'modifier-conflict',
            event,
            bucket: null,
            layerId: fact.layerId ?? null,
            code: 'core/weave/modifier-conflict',
            facts: [fact],
            describe: (locations) =>
              `@织 的修饰词只能写一枚（之前 / 之后 / 接管），这里写了 ${modifiersText(fact.modifiers)}（${locations}）——组合修饰词没有定义语义，已阻断。`,
          }),
        );
        continue;
      }
      if (!known) {
        addUnitCode(fact, 'core/weave/unsupported');
        eventConflicts.push(
          conflictFact({
            kind: 'unknown-event',
            event,
            bucket,
            layerId: fact.layerId ?? null,
            code: 'core/weave/unsupported',
            facts: [fact],
            describe: (locations) =>
              `@织 的事件「${event}」不在 adapter 的 eventCatalog 里（${locations}）——未知事件无法确定形状与调用方式，已阻断。`,
          }),
        );
        continue;
      }
      if (!weavable) {
        addUnitCode(fact, 'core/weave/not-weavable');
        eventConflicts.push(
          conflictFact({
            kind: 'not-weavable',
            event,
            bucket,
            layerId: fact.layerId ?? null,
            code: 'core/weave/not-weavable',
            facts: [fact],
            describe: (locations) =>
              `事件「${event}」在 adapter 目录里声明为不可被 @织 监听（${locations}）——挂上去运行期不会执行，已阻断。`,
          }),
        );
        continue;
      }
      if (bucket !== 'plain' && !prioritySupported) {
        addUnitCode(fact, 'core/weave/unsupported');
        eventConflicts.push(
          conflictFact({
            kind: 'priority-unsupported',
            event,
            bucket,
            layerId: fact.layerId ?? null,
            code: 'core/weave/unsupported',
            facts: [fact],
            describe: (locations) =>
              `@织 的修饰词（${modifiersText(fact.modifiers)}）需要 adapter 对事件「${event}」声明 priorityModel = emuera-buckets，当前是 ${priorityModel}（${locations}）——没有 #PRI / #LATER / #ONLY 落点，已阻断。`,
          }),
        );
        continue;
      }
      inference.push(entry);
    }

    /* 覆盖层分组（基座层 = ''）；单遍入组，组内保持定位序 */
    const byLayer = new Map<string, ListenerEntry[]>();
    for (const entry of inference) {
      const key = layerKey(entry.fact.layerId);
      const list = byLayer.get(key);
      if (list === undefined) byLayer.set(key, [entry]);
      else list.push(entry);
    }
    const layerKeys = [...byLayer.keys()].sort(compareText);
    const takeoversByLayer = new Map<string, ProjectWeaveFact[]>();
    for (const key of layerKeys) {
      takeoversByLayer.set(
        key,
        (byLayer.get(key) ?? []).filter((entry) => entry.bucket === 'only').map((entry) => entry.fact),
      );
    }
    const takeoversOf = (key: string): ProjectWeaveFact[] => takeoversByLayer.get(key) ?? [];

    /* 2a) 多个接管：同事件同层只能有一个（是否按覆盖层豁免照 layerPolicy 数据） */
    const takeoverGroups = layerKeys
      .map((key) => ({ key, facts: sortLocated(takeoversOf(key)) }))
      .filter((group) => group.facts.length > 0);
    const takeoverTotal = takeoverGroups.reduce((count, group) => count + group.facts.length, 0);
    if (overlayMode === 'overlay') {
      // 覆盖层政策：跨层合法（翻译/多版本），同层内重复仍是 error。
      for (const group of takeoverGroups) {
        if (group.facts.length < 2) continue;
        for (const fact of group.facts) addUnitCode(fact, 'core/weave/multiple-only');
        eventConflicts.push(
          conflictFact({
            kind: 'multiple-takeover',
            event,
            bucket: 'only',
            layerId: layerIdOf(group.key),
            code: 'core/weave/multiple-only',
            facts: group.facts,
            describe: (locations) =>
              `事件「${event}」的${layerLabel(group.key)}出现多个「接管」（${locations}）——layerPolicy 允许跨覆盖层各留一个接管，但同一层内接管仍是独占的，只能有一个；请删掉多余的接管。`,
          }),
        );
      }
    } else if (takeoverTotal > 1) {
      // 非 overlay 政策：没有"跨覆盖层"这回事，同事件全部接管算同一层。
      const all = takeoverGroups.flatMap((group) => group.facts);
      for (const fact of all) addUnitCode(fact, 'core/weave/multiple-only');
      eventConflicts.push(
        conflictFact({
          kind: 'multiple-takeover',
          event,
          bucket: 'only',
          layerId: null,
          code: 'core/weave/multiple-only',
          facts: all,
          describe: (locations) =>
            `事件「${event}」出现多个「接管」（${locations}）——接管是独占的，同事件同层只能有一个；adapter 的 layerPolicy 只有 kojo-overlay 声明 overlay 才允许跨覆盖层各留一个。`,
        }),
      );
    }

    /* 2b) 被压监听：同事件同层的其余监听全被接管压掉；多个接管并存时彼此互压（链） */
    for (const key of layerKeys) {
      const group = byLayer.get(key) ?? [];
      const groupTakeovers = sortLocated(takeoversOf(key));
      if (groupTakeovers.length === 0) continue;
      for (const entry of group) {
        const suppressors = groupTakeovers.filter((fact) => fact !== entry.fact);
        if (suppressors.length === 0) continue; // 唯一接管者不压自己
        unitSuppressors.set(entry.fact, sortLocated(suppressors));
        eventShadowed.push(shadowedFact({ event, listener: entry.fact, suppressors }));
      }
    }

    /* 2c) 逐块判定表（unit = 一个 @织 监听块；结论优先级 blocked > shadowed > takeover > effective） */
    for (const entry of entries) {
      const { fact, bucket } = entry;
      const codes = [...new Set(unitCodes.get(fact) ?? [])].sort(compareText);
      const suppressors = unitSuppressors.get(fact) ?? [];
      const verdict: WeaveLayerUnitVerdict =
        codes.length > 0
          ? 'blocked'
          : suppressors.length > 0
            ? 'shadowed'
            : bucket === 'only'
              ? 'takeover'
              : 'effective';
      units.push({
        listener: fact,
        bucket,
        priorityModel,
        layerMode: layerKey(fact.layerId) === '' ? baseMode : overlayMode,
        verdict,
        codes,
        suppressors,
      });
    }
    conflicts.push(...eventConflicts);
    shadowed.push(...eventShadowed);
  }

  /* ---- 3) 统一确定性排序（事件名 → 文件路径 → 行号） ---- */
  return {
    conflicts: sortFacts(conflicts),
    shadowed: sortFacts(shadowed),
    units: sortUnits(units),
  };
}
