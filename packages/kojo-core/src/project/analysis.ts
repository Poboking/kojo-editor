/**
 * 项目级分析（project layer）——「重名 / Layer / @织 接管 / 命名空间 / 返回路径」的**唯一判定**。
 *
 * ## 为什么住 core、且必须是纯函数
 *
 * 这些判定是**跨文件事实**（同名函数在别的 `.kojo` 里也定义了？同一个事件被谁接管？），
 * 单个文件的 parser / lowering 天然看不见。但它们又绝不能读盘：项目层由装配层把各文件的
 * AST 事实（`ProjectFunctionFact[]` / `ProjectWeaveFact[]` / …）汇总后注入，本模块只做
 * 纯计算。于是同一份事实在 Node 测试、编辑器主线程、CLI 里给出**逐字相同**的诊断与分桶
 * （零 IO、零 Monaco、零游戏名词）。
 *
 * ## 口径（设计稿 §7.3 / §8.6 / §10.5 / §11.3）
 *
 * - **重名函数按 LayerPolicy 分桶**：`shared-hook`（多定义合法）/ `overlay`（不同覆盖层合法）
 *   / 其余情况落 `unique` 桶；`unique` 桶内的同层重复、`overlay` 桶内的**同层**重复都是
 *   真冲突 → `core/decl/duplicate-name` **error**（不许"后装载者静默覆盖 + 低级别 warning"）。
 * - **`@织` 接管**：同一事件、同一层出现多个 `接管` → `core/weave/multiple-only` error；
 *   同层被 `接管` 压掉的普通监听 → `core/weave/shadowed-listener` **warning**，文案列出
 *   **全部接管者**（文件:行）。不同 overlay 层的接管互不压盖（跨层语义归 LayerPolicy），
 *   但全部接管者都在 `takeoverGroups` 里可见（§8.6「编辑器必须显示所有接管者」）。
 * - **修饰词**：一枚为限（`之前` / `之后` / `接管`）；重复或并用 → `core/weave/modifier-conflict`。
 *   未知事件 / adapter 未声明 `emuera-buckets` → `core/weave/unsupported`。
 * - **文件命名空间**（§3.4.5）：变量/常量/表/池/模板/函数共用一套名字；同文件重名 → error。
 *   函数对函数的同文件重名由上面的 Layer 判定报一次，这里**不双报**。
 * - **返回路径**：本层**不重解析函数体**，只吃 C2/语义层送来的事实
 *   （`hasValueReturn` / `hasBareReturn` / `allPathsReturn` / `returnFlow`）。事实带
 *   `returnFlow`（= 事实来自语义层）时，`return-mixed` 与 `missing-return` **都归编译链**：
 *   混用由主链递归分析落在具体 `@返` 行、落空由语义层只在可证落空时报——本层只留事实，
 *   **不双报**；没有 `returnFlow` 的旧事实仍按 `allPathsReturn` 保守判定（向后兼容）。
 *
 * ## 性能与确定性
 *
 * - 单遍聚合（`Map` 建组）+ 组内/组间排序，**无 O(n²)**；万级函数 + 千级监听在 50ms 内
 *   （`tests/project.bench.test.ts` 钉上界）。
 * - 输出顺序不依赖输入顺序：组名/文件路径/span 一律按码元序稳定排序，诊断最后统一排序。
 *   同一份事实无论以何种顺序注入，诊断序列逐条相同。
 */
import type { KojoFile, KojoSpan, KojoWeaveModifier } from '../ast.js';
import { severityOf, type CoreDiagnosticCode, type KojoDiagnostic } from '../diagnostics.js';
import {
  compareLocated,
  compareText,
  formatLocation as locationText,
  sortDiagnostics,
  sortLocated,
  type Located,
} from './ordering.js';

/* ============================== 输入事实 ============================== */

/** LayerPolicy 模式（§10.5）；来源是 adapter 的 `layerPolicy` */
export type LayerPolicyMode = 'unique' | 'shared-hook' | 'overlay';

/**
 * LayerPolicy 事实（由 adapter / 项目 profile 注入；本层不读 adapter）。
 *
 * 判定顺序：`byName`（精确覆盖）→ `sharedHooks`（便捷面）→ `mode`（全局缺省）→ `unique`。
 * 缺省是**最严**的 `unique`：没有声明就是"同层重复 = error"，绝不因为"没配置"而放行覆盖。
 */
export interface LayerPolicyFacts {
  readonly mode?: LayerPolicyMode;
  /** 按符号名精确覆盖（例如某 adapter 的共享事件钩子只有个别几个） */
  readonly byName?: ReadonlyMap<string, LayerPolicyMode>;
  /** 共享钩子名集合 = `shared-hook` 的便捷面（与 `byName` 同时给出时 `byName` 优先） */
  readonly sharedHooks?: ReadonlySet<string>;
}

/** 一个 `@函` 定义（项目级名录的一条；`layerId` 非空 = overlay 层，空 = 基座层） */
export interface ProjectFunctionFact {
  readonly name: string;
  readonly filePath: string;
  readonly span: KojoSpan | null;
  /**
   * overlay 覆盖层标识（翻译 / 多版本）。undefined = 基座层。
   * 同一层 = 同一 `layerId`（undefined 视为同一个基座层）；`LayerPolicy=overlay` 时
   * 只有**不同层**的多定义才算合法覆盖。
   */
  readonly layerId?: string;
}

/** 文件命名空间里的声明种类（§3.4.5：变量/常量/表/池/模板/函数共用一套名字） */
export type ProjectDeclarationKind = 'var' | 'const' | 'table' | 'pool' | 'template';

/** 一条声明事实（`# 变量` / `# 常量` / `# 表` / `# 池` / `# 模`） */
export interface ProjectDeclarationFact {
  readonly name: string;
  readonly kind: ProjectDeclarationKind;
  readonly filePath: string;
  readonly span: KojoSpan | null;
}

/** 一个 `@织` 监听事实（事件名 / 修饰词 / 来源；事件目录由 adapter 注入） */
export interface ProjectWeaveFact {
  readonly event: string;
  readonly modifiers: readonly KojoWeaveModifier[];
  readonly filePath: string;
  readonly span: KojoSpan | null;
  /** overlay 层标识；undefined = 基座层（与函数同口径） */
  readonly layerId?: string;
}

/** adapter 的事件目录事实（只取判定需要的两格：事件名、优先级模型） */
export interface EventCatalogFacts {
  readonly names: readonly string[];
  readonly priorityModel: 'emuera-buckets' | 'none';
}

/**
 * 一个 `@函` 的返回路径事实（**由 C2 / 语义层给出，本层不解析函数体**）。
 *
 * - `hasValueReturn`：函数体里是否出现过带值 `@返 表达式`；
 * - `hasBareReturn`：是否出现过无值 `@返`；
 * - `allPathsReturn`：是否已被证明"所有可达路径都以 `@返` 结束"（保守检查由上游做，
 *   上游证不出就填 `false`——本层据此报 `missing-return`，宁可多报也不许产出隐式返回）；
 * - `returnFlow`（additive；K2-SEMA-WIRING）：语义层 `KojoSemaFunctionSymbol.returnFlow`
 *   的三态投影。**给出即表示"missing-return 归语义层所有"**：编译期已按同一份判据报过
 *   （只有 `falls-through` 才报），本层只留事实、不再报第二遍——两个入口各报一次就是双报。
 */
export interface FunctionReturnFact {
  readonly name: string;
  readonly filePath: string;
  readonly span: KojoSpan | null;
  readonly hasValueReturn: boolean;
  readonly hasBareReturn: boolean;
  readonly allPathsReturn: boolean;
  readonly returnFlow?: 'returns' | 'falls-through' | 'unproven';
}

export interface ProjectAnalysisInput {
  readonly functions?: readonly ProjectFunctionFact[];
  readonly weaves?: readonly ProjectWeaveFact[];
  readonly declarations?: readonly ProjectDeclarationFact[];
  readonly returns?: readonly FunctionReturnFact[];
  readonly policy?: LayerPolicyFacts;
  /** 缺席 = 无法判断未知事件（本层不猜）；给出后未登记事件一律 error */
  readonly events?: EventCatalogFacts;
}

/* ============================== 输出 ============================== */

/** 一个重名函数组：`bucket` 是 LayerPolicy 分桶结果，`conflict` = 是否真冲突（已报 error） */
export interface ProjectFunctionGroup {
  readonly name: string;
  readonly bucket: LayerPolicyMode;
  readonly conflict: boolean;
  /** 稳定排序后的定义（文件路径 → span）；单定义组也有这一项（长度 1） */
  readonly definitions: readonly ProjectFunctionFact[];
}

/** 一个事件的接管总览（跨层；供宿主「保存前显示所有接管者」） */
export interface WeaveTakeoverGroup {
  readonly event: string;
  readonly takeovers: readonly ProjectWeaveFact[];
  /** 接管者所在的层（去重、稳定排序；基座层为 `''`） */
  readonly layers: readonly string[];
}

/** 一条被同层接管压掉的监听（warnings 的机器可读面） */
export interface WeaveShadowedListener {
  readonly event: string;
  readonly listener: ProjectWeaveFact;
  readonly takeovers: readonly ProjectWeaveFact[];
}

/** 文件命名空间重名组（同一文件、同一名字；声明与函数合并判定） */
export interface DeclarationNameGroup {
  readonly filePath: string;
  readonly name: string;
  readonly declarations: readonly ProjectDeclarationFact[];
  readonly functions: readonly ProjectFunctionFact[];
}

/** 一个函数的返回路径判定结果（诊断之外的可读面） */
export interface FunctionReturnCheck {
  readonly name: string;
  readonly filePath: string;
  readonly span: KojoSpan | null;
  /** 非 void（存在带值 `@返` 且没有无值 `@返`） */
  readonly returnsValue: boolean;
  /** 同时存在带值/无值 `@返`（error） */
  readonly mixed: boolean;
  /** 非 void 且未证明所有可达路径都以 `@返` 结束（error） */
  readonly missingReturn: boolean;
}

export interface ProjectAnalysisStats {
  readonly functionDefinitions: number;
  readonly uniqueFunctionNames: number;
  readonly duplicateFunctionNames: number;
  readonly functionConflicts: number;
  readonly sharedHookNames: number;
  readonly overlayNames: number;
  readonly weaves: number;
  readonly takeoverGroups: number;
  readonly shadowedListeners: number;
  readonly declarationDuplicates: number;
  readonly functionReturnDiagnostics: number;
  readonly diagnostics: number;
}

export interface ProjectAnalysisResult {
  /** LayerPolicy 三桶；`unique` 桶里可能含 conflict=true 的同层重复组 */
  readonly functionBuckets: {
    readonly unique: readonly ProjectFunctionGroup[];
    readonly sharedHook: readonly ProjectFunctionGroup[];
    readonly overlay: readonly ProjectFunctionGroup[];
  };
  readonly takeoverGroups: readonly WeaveTakeoverGroup[];
  readonly shadowed: readonly WeaveShadowedListener[];
  readonly declarationDuplicates: readonly DeclarationNameGroup[];
  readonly functionReturns: readonly FunctionReturnCheck[];
  /** 统一排序后的全部诊断（不双报；同一条诊断只出现一次） */
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly stats: ProjectAnalysisStats;
}

/* ============================== 内部工具 ============================== */

function diagnostic(code: CoreDiagnosticCode, message: string, span: KojoSpan | null): KojoDiagnostic {
  return { code, severity: severityOf(code), message, span };
}

function layerKey(layerId: string | undefined): string {
  return layerId ?? '';
}

function layerLabel(layerId: string | undefined): string {
  return layerId === undefined ? '基座层' : `覆盖层「${layerId}」`;
}

function formatTakeoverSources(takeovers: readonly ProjectWeaveFact[]): string {
  return takeovers.map((fact) => `「@织 ${fact.event} 接管」（${locationText(fact)}）`).join('、');
}

const MODIFIER_TEXT: Readonly<Record<KojoWeaveModifier, string>> = {
  pri: '之前',
  later: '之后',
  only: '接管',
};

/** 有效 LayerPolicy 模式：byName → sharedHooks → mode → unique */
function resolveLayerMode(name: string, policy: LayerPolicyFacts | undefined): LayerPolicyMode {
  const byName = policy?.byName?.get(name);
  if (byName !== undefined) return byName;
  if (policy?.sharedHooks?.has(name) === true) return 'shared-hook';
  return policy?.mode ?? 'unique';
}

/* ============================== 重名函数 ============================== */

/**
 * 重名函数的分桶与冲突判定（单遍聚合 + 组内排序）。
 *
 * - `shared-hook`：多定义合法，无诊断；
 * - `overlay`：不同 `layerId` 的多定义合法（无诊断，但整组进 overlay 桶供 UI 显示）；
 *   同一层出现多个 → 冲突，`core/decl/duplicate-name`；
 * - 其余（含缺省 `unique`）：同层多定义 → 冲突，`core/decl/duplicate-name`。
 */
function analyzeFunctions(
  facts: readonly ProjectFunctionFact[],
  policy: LayerPolicyFacts | undefined,
  diagnostics: KojoDiagnostic[],
): {
  buckets: ProjectAnalysisResult['functionBuckets'];
  stats: Pick<ProjectAnalysisStats, 'functionDefinitions' | 'uniqueFunctionNames' | 'duplicateFunctionNames' | 'functionConflicts' | 'sharedHookNames' | 'overlayNames'>;
} {
  const byName = new Map<string, ProjectFunctionFact[]>();
  for (const fact of facts) {
    const list = byName.get(fact.name);
    if (list === undefined) byName.set(fact.name, [fact]);
    else list.push(fact);
  }

  const unique: ProjectFunctionGroup[] = [];
  const sharedHook: ProjectFunctionGroup[] = [];
  const overlay: ProjectFunctionGroup[] = [];
  let functionConflicts = 0;
  let singleDefinitionNames = 0;
  let duplicateNames = 0;

  for (const name of [...byName.keys()].sort(compareText)) {
    const raw = byName.get(name)!;
    // 单定义组占绝大多数（万级函数里 8 成以上）：不复制、不排序，别为一条定义付三次数组分配。
    const definitions = raw.length > 1 ? sortLocated(raw) : raw;
    const mode = resolveLayerMode(name, policy);
    let bucket: LayerPolicyMode = 'unique';
    let conflict = false;

    if (definitions.length > 1) {
      bucket = mode;
      if (mode === 'shared-hook') {
        // 共享事件钩子：多定义就是设计意图，不报。
      } else if (mode === 'overlay') {
        // overlay：按层分组，只有「同层重复」是真冲突。
        const byLayer = new Map<string, ProjectFunctionFact[]>();
        for (const def of definitions) {
          const key = layerKey(def.layerId);
          const list = byLayer.get(key);
          if (list === undefined) byLayer.set(key, [def]);
          else list.push(def);
        }
        for (const key of [...byLayer.keys()].sort(compareText)) {
          const layerDefs = byLayer.get(key)!;
          if (layerDefs.length < 2) continue;
          conflict = true;
          for (let i = 1; i < layerDefs.length; i++) {
            const duplicate = layerDefs[i]!;
            const first = layerDefs[0]!;
            diagnostics.push(
              diagnostic(
                'core/decl/duplicate-name',
                `函数「${name}」在${layerLabel(duplicate.layerId)}重复定义（${locationText(duplicate)}；首个定义 ${locationText(first)}）——overlay 只允许不同覆盖层各定义一次，同层重名会让后装载者静默覆盖。`,
                duplicate.span,
              ),
            );
          }
        }
      } else {
        conflict = true;
        for (let i = 1; i < definitions.length; i++) {
          const duplicate = definitions[i]!;
          const first = definitions[0]!;
          diagnostics.push(
            diagnostic(
              'core/decl/duplicate-name',
              `函数「${name}」在项目里重复定义（${locationText(duplicate)}；首个定义 ${locationText(first)}）——LayerPolicy=unique 时同层重名是硬冲突，不许后装载者静默覆盖。`,
              duplicate.span,
            ),
          );
        }
      }
    }

    const group: ProjectFunctionGroup = { name, bucket, conflict, definitions };
    if (bucket === 'shared-hook') sharedHook.push(group);
    else if (bucket === 'overlay') overlay.push(group);
    else unique.push(group);
    if (conflict) functionConflicts += 1;
    if (definitions.length > 1) duplicateNames += 1;
    else singleDefinitionNames += 1;
  }

  return {
    buckets: { unique, sharedHook, overlay },
    stats: {
      functionDefinitions: facts.length,
      uniqueFunctionNames: singleDefinitionNames,
      duplicateFunctionNames: duplicateNames,
      functionConflicts,
      sharedHookNames: sharedHook.length,
      overlayNames: overlay.length,
    },
  };
}

/* ============================== @织：接管 / 压盖 / 修饰词 ============================== */

/** 修饰词合法性：一枚为限（§8.6 规则 4：重复或并用都是 error） */
function modifierIsValid(modifiers: readonly KojoWeaveModifier[]): boolean {
  return modifiers.length <= 1;
}

function analyzeWeaves(
  facts: readonly ProjectWeaveFact[],
  events: EventCatalogFacts | undefined,
  diagnostics: KojoDiagnostic[],
): {
  takeoverGroups: readonly WeaveTakeoverGroup[];
  shadowed: readonly WeaveShadowedListener[];
  stats: Pick<ProjectAnalysisStats, 'weaves' | 'takeoverGroups' | 'shadowedListeners'>;
} {
  const byEvent = new Map<string, ProjectWeaveFact[]>();
  for (const fact of facts) {
    const list = byEvent.get(fact.event);
    if (list === undefined) byEvent.set(fact.event, [fact]);
    else list.push(fact);
  }
  const knownEvents = events === undefined ? null : new Set(events.names);
  const prioritySupported = events === undefined ? null : events.priorityModel === 'emuera-buckets';

  const takeoverGroups: WeaveTakeoverGroup[] = [];
  const shadowed: WeaveShadowedListener[] = [];

  for (const event of [...byEvent.keys()].sort(compareText)) {
    const eventFacts = sortLocated(byEvent.get(event)!);
    const known = knownEvents === null ? true : knownEvents.has(event);

    for (const fact of eventFacts) {
      if (!modifierIsValid(fact.modifiers)) {
        const written = fact.modifiers.map((modifier) => MODIFIER_TEXT[modifier]).join(' + ');
        diagnostics.push(
          diagnostic(
            'core/weave/modifier-conflict',
            `@织 的修饰词只能写一枚（之前 / 之后 / 接管），这里写了 ${written}（${locationText(fact)}）——组合修饰词没有定义语义，已阻断。`,
            fact.span,
          ),
        );
      }
      if (!known) {
        diagnostics.push(
          diagnostic(
            'core/weave/unsupported',
            `@织 的事件「${event}」不在 adapter 的 eventCatalog 里（${locationText(fact)}）——未知事件无法确定形状与调用方式，已阻断。`,
            fact.span,
          ),
        );
      } else if (fact.modifiers.length > 0 && prioritySupported === false) {
        diagnostics.push(
          diagnostic(
            'core/weave/unsupported',
            `@织 的修饰词（${fact.modifiers.map((modifier) => MODIFIER_TEXT[modifier]).join(' / ')}）需要 adapter 声明 priorityModel = emuera-buckets，当前 adapter 未声明（${locationText(fact)}）——不支持则修饰词无落点，已阻断。`,
            fact.span,
          ),
        );
      }
    }
    if (!known) continue; // 未知事件不做接管/压盖推理（不猜）

    // 修饰词非法的监听语义未定义：只报 modifier-conflict，不参与接管/压盖推理（不猜）。
    const validFacts = eventFacts.filter((fact) => modifierIsValid(fact.modifiers));

    // 同事件按层分组；层内：多个接管 = error，普通监听被压 = warning。
    const byLayer = new Map<string, ProjectWeaveFact[]>();
    for (const fact of validFacts) {
      const key = layerKey(fact.layerId);
      const list = byLayer.get(key);
      if (list === undefined) byLayer.set(key, [fact]);
      else list.push(fact);
    }
    const eventTakeovers: ProjectWeaveFact[] = [];
    for (const key of [...byLayer.keys()].sort(compareText)) {
      const layerFacts = byLayer.get(key)!;
      const takeovers = layerFacts.filter((fact) => fact.modifiers.includes('only'));
      if (takeovers.length === 0) continue;
      eventTakeovers.push(...takeovers);
      if (takeovers.length > 1) {
        for (let i = 1; i < takeovers.length; i++) {
          const duplicate = takeovers[i]!;
          diagnostics.push(
            diagnostic(
              'core/weave/multiple-only',
              `事件「${event}」的${layerLabel(duplicate.layerId)}出现多个「接管」（${locationText(duplicate)}）——接管是独占的，同事件同层只能有一个。全部接管者：${formatTakeoverSources(sortLocated(takeovers))}。`,
              duplicate.span,
            ),
          );
        }
      }
      const sortedTakeovers = sortLocated(takeovers);
      for (const listener of layerFacts) {
        if (listener.modifiers.includes('only')) continue;
        shadowed.push({ event, listener, takeovers: sortedTakeovers });
        diagnostics.push(
          diagnostic(
            'core/weave/shadowed-listener',
            `监听（${locationText(listener)}）被同事件同层的「接管」压掉，运行期不会执行。接管者：${formatTakeoverSources(sortedTakeovers)}。`,
            listener.span,
          ),
        );
      }
    }
    if (eventTakeovers.length > 0) {
      const layers = [...new Set(eventTakeovers.map((fact) => layerKey(fact.layerId)))].sort(compareText);
      takeoverGroups.push({ event, takeovers: sortLocated(eventTakeovers), layers });
    }
  }

  return {
    takeoverGroups,
    shadowed: shadowed
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => compareText(a.entry.event, b.entry.event) || compareLocated(a.entry.listener, b.entry.listener) || a.index - b.index)
      .map(({ entry }) => entry),
    stats: { weaves: facts.length, takeoverGroups: takeoverGroups.length, shadowedListeners: shadowed.length },
  };
}

/* ============================== 文件命名空间重名 ============================== */

type NamespaceEntry =
  | { readonly kind: 'decl'; readonly fact: ProjectDeclarationFact }
  | { readonly kind: 'function'; readonly fact: ProjectFunctionFact };

function locatedOf(entry: NamespaceEntry): Located {
  return entry.fact;
}

/**
 * 文件命名空间（§3.4.5）：同一文件里，变量/常量/表/池/模板/函数共用一个名字空间。
 *
 * 规则（避免与 Layer 判定双报）：
 * - 组内按（span, 注入序）排序，第一枚是"先声明者"；
 * - 其后的**声明**一律报 error；
 * - 其后的**函数**只在组内函数恰好一枚时由本层报（多枚函数 → 归 Layer 判定报一次）。
 */
function analyzeDeclarations(
  declarations: readonly ProjectDeclarationFact[],
  functions: readonly ProjectFunctionFact[],
  diagnostics: KojoDiagnostic[],
): {
  groups: readonly DeclarationNameGroup[];
  stats: Pick<ProjectAnalysisStats, 'declarationDuplicates'>;
} {
  interface Bucket {
    readonly filePath: string;
    readonly name: string;
    readonly declarations: ProjectDeclarationFact[];
    readonly functions: ProjectFunctionFact[];
  }
  /**
   * 惰性建组：绝大多数「文件 × 名字」只有一条记录（万级函数全量），为它们建 bucket/数组
   * 纯属白烧内存与 GC。这里先只记第一枚，遇到第二条才真正建组——组数 = 重名数。
   */
  const firstEntries = new Map<string, NamespaceEntry>();
  const buckets = new Map<string, Bucket>();
  const addEntry = (filePath: string, name: string, entry: NamespaceEntry): void => {
    const key = `${filePath}\u0000${name}`;
    const first = firstEntries.get(key);
    if (first === undefined) {
      firstEntries.set(key, entry);
      return;
    }
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { filePath, name, declarations: [], functions: [] };
      buckets.set(key, bucket);
      if (first.kind === 'decl') bucket.declarations.push(first.fact);
      else bucket.functions.push(first.fact);
    }
    if (entry.kind === 'decl') bucket.declarations.push(entry.fact);
    else bucket.functions.push(entry.fact);
  };
  for (const fact of declarations) addEntry(fact.filePath, fact.name, { kind: 'decl', fact });
  for (const fact of functions) addEntry(fact.filePath, fact.name, { kind: 'function', fact });

  const groups: DeclarationNameGroup[] = [];
  const keys = [...buckets.keys()].sort(compareText);
  for (const key of keys) {
    const bucket = buckets.get(key)!;
    const entries: NamespaceEntry[] = [
      ...bucket.declarations.map((fact): NamespaceEntry => ({ kind: 'decl', fact })),
      ...bucket.functions.map((fact): NamespaceEntry => ({ kind: 'function', fact })),
    ];
    const ordered = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => compareLocated(locatedOf(a.entry), locatedOf(b.entry)) || a.index - b.index)
      .map(({ entry }) => entry);
    const first = ordered[0]!;
    const functionCount = bucket.functions.length;
    let reported = false;
    for (let i = 1; i < ordered.length; i++) {
      const entry = ordered[i]!;
      // 函数对函数：Layer 判定已经报过（同文件必然同层/同批），这里跳过避免双报。
      if (entry.kind === 'function' && functionCount > 1) continue;
      reported = true;
      diagnostics.push(
        diagnostic(
          'core/decl/duplicate-name',
          `文件内命名空间重名：「${bucket.name}」在 ${locationText(entry.fact)} 再次声明（首个声明 ${locationText(first.fact)}）——变量/常量/表/池/模板/函数共用同一文件名字空间，后声明者会静默遮蔽前者，已阻断。`,
          entry.fact.span,
        ),
      );
    }
    if (reported) {
      groups.push({
        filePath: bucket.filePath,
        name: bucket.name,
        declarations: sortLocated(bucket.declarations),
        functions: sortLocated(bucket.functions),
      });
    }
  }
  return { groups, stats: { declarationDuplicates: groups.length } };
}

/* ============================== 返回路径（只吃事实） ============================== */

function analyzeReturns(
  facts: readonly FunctionReturnFact[],
  diagnostics: KojoDiagnostic[],
): {
  checks: readonly FunctionReturnCheck[];
  stats: Pick<ProjectAnalysisStats, 'functionReturnDiagnostics'>;
} {
  const seen = new Set<string>();
  const checks: FunctionReturnCheck[] = [];
  let reported = 0;
  const ordered = sortLocated(
    facts.filter((fact) => {
      const key = `${fact.filePath}\u0000${fact.name}`;
      if (seen.has(key)) return false; // 同一函数只判一次（调用方重复注入不双报）
      seen.add(key);
      return true;
    }),
  );
  for (const fact of ordered) {
    const mixed = fact.hasValueReturn && fact.hasBareReturn;
    const returnsValue = fact.hasValueReturn && !fact.hasBareReturn;
    /*
     * 返回路径归属（K2-SEMA-WIRING）：事实带了 `returnFlow` 就说明它来自语义层——编译期已按
     * "只在能证明落空时报"的判据报过 missing-return，`@返` 混用也由主链的递归分析在**具体
     * `@返` 行**报过；本层只留事实（`checks[]`），不再报第二条诊断（两个入口各报一次 = 双报）。
     * 没有 `returnFlow` 的旧事实仍走原判据（向后兼容，不改变既有调用方口径）。
     */
    const semaOwned = fact.returnFlow !== undefined;
    const missingReturn = semaOwned
      ? returnsValue && fact.returnFlow === 'falls-through'
      : returnsValue && !fact.allPathsReturn;
    if (mixed && !semaOwned) {
      reported += 1;
      diagnostics.push(
        diagnostic(
          'core/func/return-mixed',
          `函数「${fact.name}」（${locationText(fact)}）的 @返 混用：既有带值 @返，又有无值 @返——同一函数必须全部有值或全部无值，已阻断。`,
          fact.span,
        ),
      );
    } else if (missingReturn && !semaOwned) {
      reported += 1;
      diagnostics.push(
        diagnostic(
          'core/func/missing-return',
          `非 void 函数「${fact.name}」（${locationText(fact)}）存在不以 @返 结束的可达路径——core 不做隐式默认返回，请补全分支或在末尾写 @返。`,
          fact.span,
        ),
      );
    }
    checks.push({ name: fact.name, filePath: fact.filePath, span: fact.span, returnsValue, mixed, missingReturn });
  }
  return { checks, stats: { functionReturnDiagnostics: reported } };
}

/* ============================== 主入口 ============================== */

/**
 * 项目级分析主入口（纯函数）。
 *
 * 输入是**各文件事实的汇总**（装配层注入；本层零 IO）。返回三桶 + 接管总览 + 诊断。
 * 任何一条 error 诊断都意味着项目不可编译（由装配层按 `severity==='error'` 拒绝落盘）。
 */
export function analyzeProject(input: ProjectAnalysisInput): ProjectAnalysisResult {
  const diagnostics: KojoDiagnostic[] = [];
  const functions = input.functions ?? [];
  const weaves = input.weaves ?? [];
  const declarations = input.declarations ?? [];

  const functionResult = analyzeFunctions(functions, input.policy, diagnostics);
  const weaveResult = analyzeWeaves(weaves, input.events, diagnostics);
  const declarationResult = analyzeDeclarations(declarations, functions, diagnostics);
  const returnResult = analyzeReturns(input.returns ?? [], diagnostics);

  const orderedDiagnostics = sortDiagnostics(diagnostics);
  return {
    functionBuckets: functionResult.buckets,
    takeoverGroups: weaveResult.takeoverGroups,
    shadowed: weaveResult.shadowed,
    declarationDuplicates: declarationResult.groups,
    functionReturns: returnResult.checks,
    diagnostics: orderedDiagnostics,
    stats: {
      ...functionResult.stats,
      ...weaveResult.stats,
      ...declarationResult.stats,
      ...returnResult.stats,
      diagnostics: orderedDiagnostics.length,
    },
  };
}

/* ============================== 便捷事实采集 ============================== */

/** 单文件的符号事实（供装配层从 `KojoFile` 直接汇入项目层） */
export interface FileSymbolFacts {
  readonly functions: readonly ProjectFunctionFact[];
  readonly weaves: readonly ProjectWeaveFact[];
  readonly declarations: readonly ProjectDeclarationFact[];
}

/**
 * 从一份已解析的 `KojoFile` 采集项目层事实（**只读 AST，不解析表达式**）。
 *
 * 注意：`layerId` 由装配层按"这份文件属于哪个覆盖层"注入；缺省 = 基座层。
 * 存储期槽位的采集不在这里（那是 `storage.ts` 的 `StorageDeclarationFact`，需要
 * 调用方给的稳定声明键与单元边界，不能从 AST 猜）。
 */
export function collectFileFacts(file: KojoFile, filePath: string, layerId?: string): FileSymbolFacts {
  const functions: ProjectFunctionFact[] = [];
  const weaves: ProjectWeaveFact[] = [];
  const declarations: ProjectDeclarationFact[] = [];
  for (const decl of file.decls) {
    switch (decl.kind) {
      case 'function':
        functions.push({ name: decl.name, filePath, span: decl.span, ...(layerId === undefined ? {} : { layerId }) });
        break;
      case 'weave':
        weaves.push({
          event: decl.event,
          modifiers: decl.modifiers,
          filePath,
          span: decl.span,
          ...(layerId === undefined ? {} : { layerId }),
        });
        break;
      case 'var':
      case 'const':
      case 'table':
      case 'pool':
      case 'template':
        declarations.push({ name: decl.name, kind: decl.kind, filePath, span: decl.span });
        break;
      default:
        break;
    }
  }
  return { functions, weaves, declarations };
}
