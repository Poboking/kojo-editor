/**
 * `@巡 <集合>` 的集合声明校验 + 索引循环降糖计划（K2-FOREACH / 设计稿 §9.2 / §9.3）。
 *
 * 本模块**只产纯数据**：`ForeachLoopPlan` + 诊断，不拼任何 ERB 字符串。集合名、
 * 元素类型、长度机制与绑定名全部来自 adapter 的冻结声明；core 只校验语言层语义
 * （哪个类别允许哪几个绑定名），落成 `FOR`/`WHILE` 还是 adapter 的等价物由 emitter 决定。
 *
 * 口径（写死）：
 * - 绑定名按集合类别固定（§9.3）：数组 `{值}`/`{下标}`、角色集合 `{角}`/`{名}`、
 *   其他集合 `{项}`/`{键}`；adapter 只能声明该类别允许的子集，且 `{名}` 必须与 `{角}` 同声明；
 * - 未声明的集合 = error（`core/expr/unknown-symbol`，文案列出可用集合）；
 * - feature 关闭 = error（`core/control/unsupported`，与 `checkProgramFeature` **同码**：
 *   同一情形只有一条诊断，码表里查得到；`core/feature/unsupported` 只留给"能力面未声明"）；
 * - 声明不完整（空绑定 / 类别与元素类型矛盾 / 长度机制坏掉…）= error；
 * - 空集合整块跳过：plan 写成 `skeleton.empty = 'skip'`，emitter 用 `FOR i, 0, 长度`
 *   这类**结束值不含**的索引循环即可零轮，不许先执行一轮再判断；
 * - 不可声明时 **`plan` 恒为 null**（不产半成品，与 `table.ts` 同一纪律）。
 *
 * 隐藏槽名前缀 `__kojo_foreach_<源行>`，与表的 `__kojo_table_*` / 随机的 `__kojo_rand_*`
 * 同族；`@巡` 块头独占一行，嵌套循环按各自行号区分。模板展开可能把同一个块复制进同一
 * 产物函数（同源行 ⇒ 同槽名），调用方可用 `options.slotPrefix` 注入序号保证唯一。
 *
 * 元素寻址（plan 只给事实，不拼表达式）：
 * - 数组：元素由 emitter 用编译后的 `collectionExpr` + 下标槽按引擎下标语法取；
 * - 角色集合：元素（角色号）= `base + 下标`；`{名}` 由 adapter 的 `nameAccessor` 从角色号派生；
 * - 键值集合：`{项}`/`{键}` 的取法是 adapter 事实，core 只给槽名与键类型。
 */
import type { KojoExprText, KojoForEachLoop, KojoNarrativeNode, KojoSpan, KojoValueType } from '../../ast.js';
import type { KojoDiagnostic } from '../../diagnostics.js';
import { severityOf } from '../../diagnostics.js';

/* ============================== 1. 绑定与类别 ============================== */

/** `@巡` 的六个绑定名（2.0 语言词；§4.12 名字解析优先级第 2 档） */
export type ForeachBindingName = '值' | '下标' | '角' | '名' | '项' | '键';

/** 全部绑定名（诊断/补全共用；顺序 = 规范书写顺序） */
export const FOREACH_BINDING_NAMES: readonly ForeachBindingName[] = Object.freeze([
  '值',
  '下标',
  '角',
  '名',
  '项',
  '键',
] as const);

/** 集合元素类型：`character` = 角色号（引擎里是整数，语义上不是普通 int） */
export type ForeachElementType = KojoValueType | 'character';

/** 集合类别（决定允许哪一组绑定名；§9.3） */
export type ForeachCollectionKind = 'array' | 'characters' | 'records';

/** 类别 → 允许的绑定名（唯一真源；声明校验与 plan 生成都按它） */
export const FOREACH_COLLECTION_BINDINGS: Readonly<
  Record<ForeachCollectionKind, readonly ForeachBindingName[]>
> = Object.freeze({
  array: Object.freeze(['值', '下标'] as const),
  characters: Object.freeze(['角', '名'] as const),
  records: Object.freeze(['项', '键'] as const),
});

/** 绑定取值来源：core 只描述"从哪来"，具体落点由 emitter 决定 */
export type ForeachBindingSource = 'index' | 'element' | 'key' | 'name';

/** 绑定名 → 取值来源（规范固定；adapter 只能选子集，不能改语义） */
const BINDING_SOURCES: Readonly<Record<ForeachBindingName, ForeachBindingSource>> = Object.freeze({
  值: 'element',
  下标: 'index',
  角: 'element',
  名: 'name',
  项: 'element',
  键: 'key',
});

/** 类别标签（诊断文案用；语言层词汇，不是游戏名词） */
const KIND_LABELS: Readonly<Record<ForeachCollectionKind, string>> = Object.freeze({
  array: '数组集合',
  characters: '角色集合',
  records: '键值集合',
});

/* ============================== 2. adapter 声明 ============================== */

/**
 * 长度机制（纯数据）：
 * - `declared`：长度在编译期已知（数组 `# 设 名 类型[N]` 的 N、固定长度的 adapter 集合）；
 * - `engine`：长度由 adapter 的引擎计数器给出（`counter - minus`，如"角色数 - 1"跳过玩家）。
 */
export type ForeachLengthDecl =
  | { readonly kind: 'declared'; readonly size: number }
  | { readonly kind: 'engine'; readonly counter: string; readonly minus: number };

/**
 * 一个集合的声明（adapter 冻结数据；`@巡 <name>` 按名查表）。
 *
 * 字段全是事实，没有默认值：缺一个就报"不可声明"，不替 adapter 猜。
 */
export interface ForeachCollectionDecl {
  /** 源端集合名（`@巡 队伍` 里的"队伍"） */
  readonly name: string;
  readonly kind: ForeachCollectionKind;
  readonly elementType: ForeachElementType;
  /** 元素值 = base + 0 基下标（数组 0；角色集合通常 1，跳过 0 号玩家） */
  readonly base: number;
  /** 键值集合的键类型；非键值集合必须为 null */
  readonly keyType: KojoValueType | null;
  readonly length: ForeachLengthDecl;
  /** 本集合提供的绑定名（必须是该类别允许集合的子集） */
  readonly bindings: readonly ForeachBindingName[];
  /** `{名}` 的引擎变量族（按角色号索引的 adapter 事实；声明了 `名` 就必须给，core 不解释） */
  readonly nameAccessor: string | null;
}

/** 数组规则：作者 `# 设 名 类型[N]` 的可遍历形态（绑定名/下标基由 adapter 定） */
export interface ForeachArrayRule {
  readonly base: number;
  readonly bindings: readonly ForeachBindingName[];
}

/** 一份已声明数组的事实（core 从 `# 设` 收集；plan 只消费，不读盘） */
export interface ForeachArrayFact {
  readonly name: string;
  readonly elementType: KojoValueType;
  /** 声明长度（正整数；0 只用于"空集合跳过"的事实测试） */
  readonly size: number;
}

/** adapter 的整套集合声明（命名集合 + 数组规则） */
export interface ForeachDeclarations {
  readonly collections: readonly ForeachCollectionDecl[];
  readonly arrayRule: ForeachArrayRule | null;
}

/* ============================== 3. 计划事实 ============================== */

export type ForeachSlotRole = 'index' | 'element' | 'key' | 'name';

/** 一个隐藏槽事实（emitter 据此发 `#DIM`/声明，并当局部变量用） */
export interface ForeachSlotFact {
  readonly name: string;
  readonly role: ForeachSlotRole;
  readonly valueType: KojoValueType;
}

/** 一个绑定事实：源端绑定名 → 槽 + 静态类型 */
export interface ForeachBindingFact {
  readonly name: ForeachBindingName;
  readonly source: ForeachBindingSource;
  readonly valueType: KojoValueType;
  readonly slot: string;
}

/** 索引循环骨架（纯事实；emitter 不得改变这些语义） */
export interface ForeachLoopSkeleton {
  /** 下标初值（0 基） */
  readonly start: 0;
  /** 每轮推进量 */
  readonly step: 1;
  /** 迭代上界（结束值 = 上界，不含；`FOR i, 0, 上界`） */
  readonly length: ForeachLengthDecl;
  /** 空集合行为：整块跳过（零轮，不是"跑一轮空体"） */
  readonly empty: 'skip';
}

/** 一次 `@巡` 的完整降糖计划（纯数据；plan 为 null 时绝不产出部分事实） */
export interface ForeachLoopPlan {
  /** 源端集合名（已 trim） */
  readonly collection: string;
  /** 集合表达式源切片（数组取元素时由 emitter 编译；core 不重解析） */
  readonly collectionExpr: KojoExprText;
  readonly kind: ForeachCollectionKind;
  readonly elementType: ForeachElementType;
  /** 元素值 = base + 下标（角色集合用；数组一般为 0） */
  readonly base: number;
  /** 键值集合的键类型；其它集合为 null */
  readonly keyType: KojoValueType | null;
  readonly length: ForeachLengthDecl;
  /** `{名}` 的引擎变量族（按角色号索引；null = 不提供 `名`） */
  readonly nameAccessor: string | null;
  /** 下标槽（恒存在；`{下标}` 直接引用它） */
  readonly index: ForeachSlotFact;
  /** 本循环实际用到的槽（稳定序：下标 → 元素 → 键 → 名；去重） */
  readonly slots: readonly ForeachSlotFact[];
  /** 本循环提供的绑定（按声明顺序；每个都指向上面的某个槽） */
  readonly bindings: readonly ForeachBindingFact[];
  readonly skeleton: ForeachLoopSkeleton;
  /** 循环体原样（降糖由调用方接管；plan 不复制、不改写） */
  readonly body: readonly KojoNarrativeNode[];
  readonly span: KojoSpan;
}

/** plan 结果：失败时 `plan` 恒为 null（不产半成品） */
export type ForeachPlanResult =
  | { readonly ok: true; readonly plan: ForeachLoopPlan; readonly diagnostics: readonly KojoDiagnostic[] }
  | { readonly ok: false; readonly plan: null; readonly diagnostics: readonly KojoDiagnostic[] };

export interface ForeachPlanOptions {
  /** `programFeatures.foreach`；显式 false ⇒ `core/feature/unsupported`（缺省 true，由调用方给闸） */
  readonly enabled?: boolean;
  /** 本文件的可遍历数组事实（core 从 `# 设` 收集）；缺省空 */
  readonly arrays?: readonly ForeachArrayFact[];
  /** 槽名前缀覆盖（默认 `__kojo_foreach_<块头源行>`；模板展开复制同一块时用它消歧） */
  readonly slotPrefix?: string;
}

/** 隐藏槽默认前缀（唯一一份；作者变量禁用以 `__kojo_` 开头） */
export const FOREACH_SLOT_PREFIX = '__kojo_foreach_';

/* ============================== 4. 小工具 ============================== */

function makeDiagnostic(
  code: 'core/expr/unknown-symbol' | 'core/control/unsupported',
  message: string,
  span: KojoSpan,
): KojoDiagnostic {
  return { code, severity: severityOf(code), message, span };
}

function symbolDiagnostic(message: string, span: KojoSpan): KojoDiagnostic {
  return makeDiagnostic('core/expr/unknown-symbol', message, span);
}

function featureDiagnostic(span: KojoSpan): KojoDiagnostic {
  return makeDiagnostic(
    'core/control/unsupported',
    '`@巡` 未开启：当前 adapter 的 programFeatures.foreach 为 false；请开启，或用 `@原生` 写等价索引循环（§9.3 / §10.10）。',
    span,
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCollectionKind(value: unknown): value is ForeachCollectionKind {
  return value === 'array' || value === 'characters' || value === 'records';
}

function isBindingName(value: unknown): value is ForeachBindingName {
  return typeof value === 'string' && (FOREACH_BINDING_NAMES as readonly string[]).includes(value);
}

function failed(diagnostics: readonly KojoDiagnostic[]): ForeachPlanResult {
  return { ok: false, plan: null, diagnostics: Object.freeze([...diagnostics]) };
}

function succeeded(plan: ForeachLoopPlan): ForeachPlanResult {
  return { ok: true, plan, diagnostics: Object.freeze([]) };
}

/* ============================== 5. 集合解析 ============================== */

interface Resolution {
  readonly declaration: ForeachCollectionDecl | null;
  /** declaration 为 null 时的诊断文案 */
  readonly message: string;
}

function availableSuffix(available: readonly string[]): string {
  return available.length > 0
    ? `；当前 adapter 可用的集合：${available.join('、')}`
    : '；当前 adapter 没有声明任何集合';
}

function resolveCollection(
  name: string,
  declarations: ForeachDeclarations | null,
  options: ForeachPlanOptions,
): Resolution {
  const collections: readonly ForeachCollectionDecl[] = Array.isArray(declarations?.collections)
    ? declarations.collections
    : [];
  const available: string[] = [];
  const matches: ForeachCollectionDecl[] = [];

  for (const collection of collections) {
    const declaredName = typeof collection?.name === 'string' ? collection.name.trim() : '';
    if (declaredName.length === 0) continue;
    if (!available.includes(declaredName)) available.push(declaredName);
    if (declaredName === name) matches.push(collection);
  }

  if (matches.length > 1) {
    return {
      declaration: null,
      message: `集合「${name}」在 adapter 声明里重复出现（${matches.length} 条）：解析不了该用哪一条；请先修 adapter 数据（同一集合只能声明一次）。`,
    };
  }
  if (matches.length === 1) return { declaration: matches[0]!, message: '' };

  const rule = declarations?.arrayRule ?? null;
  if (rule === null) {
    return {
      declaration: null,
      message: `集合「${name}」未声明：\`@巡\` 只能遍历 adapter 声明的集合${availableSuffix(available)}（§9.3）。`,
    };
  }

  const arrays: readonly ForeachArrayFact[] = Array.isArray(options.arrays) ? options.arrays : [];
  const fact = arrays.find((item) => typeof item?.name === 'string' && item.name.trim() === name);
  if (fact === undefined) {
    return {
      declaration: null,
      message: `数组「${name}」未声明：本文件没有它的数组事实（\`# 设 ${name} <类型>[N]\`，§9.2）${availableSuffix(available)}。`,
    };
  }
  return {
    declaration: {
      name: fact.name.trim(),
      kind: 'array',
      elementType: fact.elementType,
      base: rule.base,
      keyType: null,
      length: { kind: 'declared', size: fact.size },
      bindings: rule.bindings,
      nameAccessor: null,
    },
    message: '',
  };
}

/* ============================== 6. 声明校验 ============================== */

function validateLength(
  length: ForeachLengthDecl,
  label: string,
  report: (message: string) => void,
): void {
  if (length === undefined || length === null) {
    report(`集合「${label}」缺少长度机制：至少要有 declared（编译期长度）或 engine（引擎计数器）。`);
    return;
  }
  switch (length.kind) {
    case 'declared':
      if (!isNonNegativeSafeInteger(length.size)) {
        report(`集合「${label}」的声明长度必须是非负安全整数（0 只用于"空集合跳过"的事实）。`);
      }
      return;
    case 'engine':
      if (typeof length.counter !== 'string' || length.counter.trim().length === 0) {
        report(`集合「${label}」的引擎长度缺少计数器名（engine.counter 不能为空）。`);
      }
      if (!isNonNegativeSafeInteger(length.minus)) {
        report(`集合「${label}」的引擎长度减数必须是非负安全整数（长度 = counter - minus）。`);
      }
      return;
    default:
      report(`集合「${label}」的长度机制非法：只支持 declared / engine。`);
  }
}

/**
 * 校验一条集合声明（纯函数；全部 error，任一失败即不产 plan）。
 *
 * 只查"声明自洽性"，不查用户源码：用户侧的未声明集合由 `resolveCollection` 报。
 */
function validateDeclaration(
  declaration: ForeachCollectionDecl,
  report: (message: string) => void,
): void {
  const rawName = typeof declaration.name === 'string' ? declaration.name.trim() : '';
  const label = rawName.length > 0 ? rawName : '(无名集合)';
  if (!isCollectionKind(declaration.kind)) {
    report(`集合「${label}」的类别 ${String(declaration.kind)} 非法：只支持 array / characters / records。`);
    return;
  }
  const kind = declaration.kind;
  const allowed = FOREACH_COLLECTION_BINDINGS[kind];

  /* ---- 元素类型 ---- */
  const elementType = declaration.elementType;
  if (elementType !== 'int' && elementType !== 'string' && elementType !== 'character') {
    report(`集合「${label}」的 elementType 非法：只支持 int / string / character。`);
  } else if (kind === 'characters' && elementType !== 'character') {
    report(`角色集合「${label}」的 elementType 必须是 character（角色号），实际是 ${elementType}。`);
  } else if (kind !== 'characters' && elementType === 'character') {
    report(`集合「${label}」不是角色集合，elementType 不能是 character。`);
  }

  /* ---- 下标基 ---- */
  if (!isNonNegativeSafeInteger(declaration.base)) {
    report(`集合「${label}」的 base 必须是非负安全整数（元素值 = base + 下标）。`);
  }

  /* ---- 键类型 ---- */
  if (kind === 'records') {
    if (declaration.keyType !== 'int' && declaration.keyType !== 'string') {
      report(`键值集合「${label}」必须声明 keyType（int / string）：\`{键}\` 的静态类型不能猜。`);
    }
  } else if (declaration.keyType !== null && declaration.keyType !== undefined) {
    report(`集合「${label}」不是键值集合，keyType 必须为 null。`);
  }

  /* ---- 绑定名 ---- */
  const bindings: readonly unknown[] = Array.isArray(declaration.bindings) ? declaration.bindings : [];
  if (bindings.length === 0) {
    report(`集合「${label}」没有声明任何绑定：至少要有 ${allowed.map((item) => `{${item}}`).join(' / ')} 之一，否则循环体拿不到元素。`);
  }
  const declared = new Set<ForeachBindingName>();
  for (const binding of bindings) {
    if (!isBindingName(binding)) {
      report(`集合「${label}」含未知绑定 ${String(binding)}：只支持 ${FOREACH_BINDING_NAMES.map((item) => `{${item}}`).join(' / ')}。`);
      continue;
    }
    if (!allowed.includes(binding)) {
      report(
        `集合「${label}」不能声明 {${binding}}：${KIND_LABELS[kind]}只允许 ${allowed.map((item) => `{${item}}`).join(' / ')}（§9.3）。`,
      );
      continue;
    }
    if (declared.has(binding)) {
      report(`集合「${label}」的绑定 {${binding}} 重复声明。`);
      continue;
    }
    declared.add(binding);
  }
  if (declared.has('名') && !declared.has('角')) {
    report(`集合「${label}」声明了 {名} 却没有 {角}：名字要从角色号派生，两者必须同声明。`);
  }
  if (declared.has('名') && (typeof declaration.nameAccessor !== 'string' || declaration.nameAccessor.trim().length === 0)) {
    report(`集合「${label}」声明了 {名}，但没有给出 nameAccessor（adapter 的名字访问器）。`);
  }

  /* ---- 长度 ---- */
  validateLength(declaration.length, label, report);
}

/**
 * 整套集合声明的自检（adapter 装载路径用；纯函数、只回消息串，不绑定诊断码）。
 *
 * 与 `validateGameAdapter` 的分工：本函数只管**集合声明自身**的语言层自洽
 * （类别/绑定/长度/数组规则/重名），诊断码由契约层按既有 adapter 校验码表决定——
 * 这样 `foreach.ts` 不新增码表条目，adapter 自检也不复制绑定规则。
 */
export function validateForeachDeclarations(declarations: ForeachDeclarations): readonly string[] {
  const out: string[] = [];
  const rawCollections: readonly unknown[] = Array.isArray(declarations?.collections)
    ? declarations.collections
    : [];
  const names = new Set<string>();

  for (const raw of rawCollections) {
    if (raw === null || typeof raw !== 'object') {
      out.push('collections 含非法项：每条集合声明必须是对象。');
      continue;
    }
    const declaration = raw as ForeachCollectionDecl;
    validateDeclaration(declaration, (message) => out.push(message));
    const name = typeof declaration.name === 'string' ? declaration.name.trim() : '';
    if (name.length === 0) continue;
    if (names.has(name)) out.push(`集合「${name}」重复声明：同一集合只能有一条声明（解析不出该用哪一条）。`);
    else names.add(name);
  }

  const rule = declarations?.arrayRule ?? null;
  if (rule !== null && rule !== undefined) {
    if (!isNonNegativeSafeInteger(rule.base)) {
      out.push('数组规则的 base 必须是非负安全整数（元素值 = base + 下标）。');
    }
    const allowed = FOREACH_COLLECTION_BINDINGS.array;
    const rawBindings: readonly unknown[] = Array.isArray(rule.bindings) ? rule.bindings : [];
    if (rawBindings.length === 0) {
      out.push(`数组规则没有声明任何绑定：至少要有 ${allowed.map((item) => `{${item}}`).join(' / ')} 之一，否则循环体拿不到元素。`);
    }
    const seen = new Set<ForeachBindingName>();
    for (const binding of rawBindings) {
      if (!isBindingName(binding)) {
        out.push(`数组规则含未知绑定 ${String(binding)}：只支持 ${FOREACH_BINDING_NAMES.map((item) => `{${item}}`).join(' / ')}。`);
        continue;
      }
      if (!allowed.includes(binding)) {
        out.push(`数组规则不能声明 {${binding}}：数组集合只允许 ${allowed.map((item) => `{${item}}`).join(' / ')}（§9.3）。`);
        continue;
      }
      if (seen.has(binding)) out.push(`数组规则的绑定 {${binding}} 重复声明。`);
      else seen.add(binding);
    }
  }

  return Object.freeze(out);
}

/* ============================== 7. 计划成形 ============================== */

function slotPrefixOf(loop: KojoForEachLoop, options: ForeachPlanOptions): string {
  const custom = options.slotPrefix;
  if (typeof custom === 'string' && custom.length > 0) return custom;
  return `${FOREACH_SLOT_PREFIX}${loop.span.start.line}`;
}

function materializePlan(
  loop: KojoForEachLoop,
  declaration: ForeachCollectionDecl,
  options: ForeachPlanOptions,
): ForeachLoopPlan {
  const collection =
    typeof declaration.name === 'string' && declaration.name.trim().length > 0
      ? declaration.name.trim()
      : loop.collection.text.trim();
  const prefix = slotPrefixOf(loop, options);

  const index: ForeachSlotFact = Object.freeze({ name: `${prefix}_i`, role: 'index', valueType: 'int' });
  const sources = new Set<ForeachBindingSource>();
  for (const binding of declaration.bindings) {
    const source = BINDING_SOURCES[binding];
    if (source !== undefined) sources.add(source);
  }

  const elementValueType: KojoValueType = declaration.elementType === 'string' ? 'string' : 'int';
  const elementSlot: ForeachSlotFact | null = sources.has('element')
    ? Object.freeze({ name: `${prefix}_e`, role: 'element', valueType: elementValueType })
    : null;
  const keySlot: ForeachSlotFact | null = sources.has('key')
    ? Object.freeze({ name: `${prefix}_k`, role: 'key', valueType: declaration.keyType ?? 'int' })
    : null;
  const nameSlot: ForeachSlotFact | null = sources.has('name')
    ? Object.freeze({ name: `${prefix}_n`, role: 'name', valueType: 'string' })
    : null;

  // 槽顺序固定：下标 → 元素 → 键 → 名（同一声明序下 plan 逐字稳定）
  const slots: ForeachSlotFact[] = [index];
  if (elementSlot !== null) slots.push(elementSlot);
  if (keySlot !== null) slots.push(keySlot);
  if (nameSlot !== null) slots.push(nameSlot);

  const bySource: Readonly<Record<ForeachBindingSource, ForeachSlotFact | null>> = {
    index,
    element: elementSlot,
    key: keySlot,
    name: nameSlot,
  };
  const bindings: ForeachBindingFact[] = declaration.bindings.map((binding) => {
    const source = BINDING_SOURCES[binding]!;
    // 校验已保证：每个绑定名的来源槽都已建出（这里只做形状收口）
    const slot = bySource[source]!;
    return Object.freeze({ name: binding, source, valueType: slot.valueType, slot: slot.name });
  });

  const skeleton: ForeachLoopSkeleton = Object.freeze({
    start: 0,
    step: 1,
    length: declaration.length,
    empty: 'skip',
  });

  return {
    collection,
    collectionExpr: loop.collection,
    kind: declaration.kind,
    elementType: declaration.elementType,
    base: declaration.base,
    keyType: declaration.kind === 'records' ? declaration.keyType : null,
    length: declaration.length,
    nameAccessor: declaration.nameAccessor,
    index,
    slots: Object.freeze(slots),
    bindings: Object.freeze(bindings),
    skeleton,
    body: loop.body,
    span: loop.span,
  };
}

/* ============================== 8. 公共入口 ============================== */

/**
 * 在计划里查绑定槽（walk 改写循环体时的唯一查表口；没有该绑定 → null）。
 *
 * 名字参数用 `string`：调用方拿到的是表达式里的标识符原文，不必先窄化到闭集。
 */
export function foreachBindingSlot(plan: ForeachLoopPlan, name: string): string | null {
  for (const binding of plan.bindings) {
    if (binding.name === name) return binding.slot;
  }
  return null;
}

/**
 * `@巡` → 槽/绑定事实 + 索引循环骨架（纯函数）。
 *
 * - `enabled === false` → `core/control/unsupported`（与 `checkProgramFeature` 同码）；
 * - 集合名未声明 → `core/expr/unknown-symbol`（文案列出可用集合）；
 * - 声明不自洽 → `core/expr/unknown-symbol`（文案指出哪条声明坏了）；
 * - 任一 error ⇒ `{ ok: false, plan: null }`（**不产半成品**）。
 *
 * 同输入同输出：不读盘、不缓存、不改 `loop`/`declarations`（plan 里只有只读引用）。
 */
export function planForEachLoop(
  loop: KojoForEachLoop,
  declarations: ForeachDeclarations | null,
  options: ForeachPlanOptions = {},
): ForeachPlanResult {
  const span = loop.span;
  const collectionSpan = loop.collection.span;

  if (options.enabled === false) return failed([featureDiagnostic(span)]);

  const name = loop.collection.text.trim();
  if (name.length === 0) {
    return failed([symbolDiagnostic('`@巡` 缺集合：写 `@巡 <集合>`，集合名由 adapter 声明（§9.3）。', collectionSpan)]);
  }

  const resolved = resolveCollection(name, declarations, options);
  if (resolved.declaration === null) return failed([symbolDiagnostic(resolved.message, collectionSpan)]);

  const diagnostics: KojoDiagnostic[] = [];
  validateDeclaration(resolved.declaration, (message) => diagnostics.push(symbolDiagnostic(message, collectionSpan)));
  if (diagnostics.length > 0) return failed(diagnostics);

  return succeeded(materializePlan(loop, resolved.declaration, options));
}
