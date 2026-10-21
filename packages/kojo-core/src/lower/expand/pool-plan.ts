/**
 * `# 池` 落点判定（C2.6 / §7.1 / §16.2）：**纯结构判定，只产计划，不产字节**。
 *
 * 分工（与 `# 表` 的 `table-plan.ts`、`选项` 的 ETB 计划同一口径）：
 * - 本模块只回答"这条池链能不能**可证地**落等值分派（`selectcase`）"；
 * - 落点形状（引擎块关键字、缩进）是 adapter 的发射事实，core **零引擎关键字**；
 * - 计划是**纯数据**（数字 + 字符串 + span），可离线断言、可直接交给 adapter 的结构子集。
 *
 * ## 判据（写死；改这里 = 改语言口径，必须同步设计稿 §7.1）
 *
 * 1. **所有普通分支都是同一主语 + 整数等值比较**（`==` / `=`；见 `dispatch-plan.ts`）：
 *    区间比较（`恋慕 < 100`）、逻辑组合（`a == 0 && b == 1`）、非整数右值（字符串 /
 *    未求值常量 / 小数）一律不可证 → 落 `IF` 链（现状，产物不变）。
 * 2. **分支数 ≥ {@link POOL_DISPATCH_MIN_BRANCHES}（= 3，含 `? 否`）**：少于 3 条时
 *    等值分派只有"头 + 尾"的结构开销、没有分档收益，保持 `IF` 链更直接。这是
 *    **语言口径**，adapter 不得自行放宽。
 * 3. **`? 否` 必须存在、必须最后、必须可打印**（§7.1 既有规则）：缺/重复/位置错/空
 *    一律 `style: 'error'` + 诊断，调用方**不产字节**（不静默补一个空兜底）。
 * 4. **等值键不得重复**：同一主语下两档同值无法区分（`IF` 链第一个命中；等值分派也会
 *    静默取第一个），按计划不自洽 fail-closed（`core/pool/duplicate-case`）。
 * 5. **主语必须是纯表达式**且同一来源（trim 后逐字相同）：函数调用/字符串/三元/
 *    比较组合都不收（可能有副作用或非整数）。
 *
 * ## 失败语义
 *
 * - `if-chain`：**不可证/不划算**（不是错误）——调用方保持既有 `IF/ELSEIF/ELSE` 链；
 * - `error`：**计划不自洽**（缺 `否` / 重复 `否` / 空 `否` / 等值键重复）——诊断非空，
 *   调用方报完**不产字节**。
 *
 * ## 发射通道
 *
 * core 只发**结构请求** {@link PoolDispatchEmitRequest}（主语槽 + 每档已降糖行 + 兜底
 * 已降糖行）给 adapter 的契约可选能力 `presentation.poolDispatch`（`lower/backend.ts`）；
 * 没有该能力时原样退回既有 `IF` 链（golden 不变）。能力探测见 {@link poolDispatchOf}：
 * 契约字段是 optional，探测恒 = 一次属性读 + `this` 绑定。
 */
import type { KojoConditionBranch, KojoExprText, KojoPoolDecl, KojoSpan } from '../../ast.js';
import type { KojoDiagnostic } from '../../diagnostics.js';
import { severityOf } from '../../diagnostics.js';
import type { EmitResult, KojoEmitBackend } from '../backend.js';
import { narrativeHasOutput } from '../presentation.js';
import { sameDispatchSubject, scanIntegerEquality } from './dispatch-plan.js';

/* ============================== 判据常量 ============================== */

/**
 * 分支数下限（含 `? 否`）：少于 3 条时等值分派只有"头 + 尾"的结构开销、没有分档收益，
 * 保持 `IF` 链更直接。写死是**语言口径**，不是可调项。
 */
export const POOL_DISPATCH_MIN_BRANCHES = 3;

/** 隐藏槽前缀（与 `__kojo_table_*` / `__kojo_rand_*` 同一保留前缀；作者不可声明） */
export const POOL_SLOT_PREFIX = '__kojo_pool_';

/** 池主语隐藏槽名：`__kojo_pool_<池名>`（源表达式只求值一次） */
export function poolSubjectSlot(poolName: string): string {
  return `${POOL_SLOT_PREFIX}${poolName}`;
}

/* ============================== 输出计划 ============================== */

/** 一个可落等值档的分支（键 = 静态解析后的整数） */
export interface PoolDispatchCase {
  /** 等值键（安全整数） */
  readonly value: number;
  /** 源 `pool.branches` 里的下标（发射/诊断按它指回原分支） */
  readonly branchIndex: number;
  readonly span: KojoSpan;
}

/**
 * 落点风格：
 * - `selectcase`：可证等值，`cases` 有值；
 * - `if-chain`：不可证/不划算，**`cases` 为空**（保持既有 IF 链，产物不变）；
 * - `error`：计划不自洽（fail-closed），`diagnostics` 非空、`cases` 为空。
 *
 * 注：任务书写的是两态；`error` 是**additive 的第三态**——没有它，"不可证"与
 * "不自洽"就分不开，fail-closed 会退化成静默 IF 回退。与 `table-plan.ts` 同形。
 */
export type PoolDispatchStyle = 'selectcase' | 'if-chain' | 'error';

/** 一次判定结果（纯数据；只读、冻结） */
export interface PoolDispatchPlan {
  readonly style: PoolDispatchStyle;
  /** 仅 `selectcase` 时有值；顺序 = 源书写顺序（**不排序**） */
  readonly cases: readonly PoolDispatchCase[];
  /** 是否有 `? 否` 兜底分支（池恒为 true 才可能 `selectcase`） */
  readonly hasDefault: boolean;
  /** `? 否` 在 `pool.branches` 里的下标（无则 null；发射兜底正文用） */
  readonly defaultIndex: number | null;
  /** 同一主语（可证等值时非 null；`error` 时尽量给出首个可解析主语） */
  readonly subject: KojoExprText | null;
  /** 判定理由（中文；写进预览/测试断言，不产字节） */
  readonly reason: string;
  /** 仅 `error` 时有值；码/级别仍由 `diagnostics.ts` 唯一定义 */
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly span: KojoSpan;
}

/* ============================== 发射通道（结构请求） ============================== */

/**
 * core 发给 adapter 的**结构请求**：主语隐槽名 + 已降糖的分支正文。
 *
 * 契约（写死）：
 * - `caseLines[i]` 与 `plan.cases[i]` **一一对应**（顺序 = 源书写顺序）；
 * - 每行都是 core 已降糖的产物行（**没有缩进**）；adapter 只缩进嵌入，
 *   **不得改写/删除/插入/重排**；
 * - `elseLines` 是 `? 否` 分支的已降糖行（池的 `? 否` 必填且必须可打印，恒非空）；
 * - 主语求值（`subjectSlot = <主语>`）由 core 在请求之前发完，adapter 不重复求值。
 */
export interface PoolDispatchEmitRequest {
  readonly plan: PoolDispatchPlan;
  /** 主语隐藏槽（`__kojo_pool_<池名>`，只求值一次） */
  readonly subjectSlot: string;
  readonly caseLines: readonly (readonly string[])[];
  readonly elseLines: readonly string[];
}

/** adapter 的可选能力签名（一个请求 → 1/多行；表达不了返回 `EmitFailure`） */
export type PoolDispatchEmitter = (request: PoolDispatchEmitRequest) => EmitResult;

/**
 * 取 backend 的池等值分派能力；没有就返回 null（调用方退回既有 `IF` 链，golden 不变）。
 *
 * 能力是 `KojoPresentationEmitter` 上的 optional 方法：保留 `this = presentation`
 * 的绑定（与 `tableDispatchOf` 同一口径）。
 */
export function poolDispatchOf(backend: KojoEmitBackend): PoolDispatchEmitter | null {
  const host = backend.presentation;
  const emitter = host.poolDispatch;
  if (typeof emitter !== 'function') return null;
  return (request) => emitter.call(host, request);
}

/* ============================== 小工具 ============================== */

function diagnosticOf(code: KojoDiagnostic['code'], message: string, span: KojoSpan): KojoDiagnostic {
  return Object.freeze({ code, severity: severityOf(code), message, span });
}

function planOf(
  style: PoolDispatchStyle,
  fields: {
    readonly cases?: readonly PoolDispatchCase[];
    readonly hasDefault?: boolean;
    readonly defaultIndex?: number | null;
    readonly subject?: KojoExprText | null;
    readonly reason: string;
    readonly diagnostics?: readonly KojoDiagnostic[];
    readonly span: KojoSpan;
  },
): PoolDispatchPlan {
  return Object.freeze({
    style,
    cases: Object.freeze(fields.cases === undefined ? [] : [...fields.cases]),
    hasDefault: fields.hasDefault ?? false,
    defaultIndex: fields.defaultIndex ?? null,
    subject: fields.subject ?? null,
    reason: fields.reason,
    diagnostics: Object.freeze(fields.diagnostics === undefined ? [] : [...fields.diagnostics]),
    span: fields.span,
  });
}

/** `? 否` 分支必须至少有一行可打印内容（与 `pool.ts::checkPool` 同一判据） */
function branchPrintable(branch: KojoConditionBranch): boolean {
  return branch.body.length > 0 && narrativeHasOutput(branch.body);
}

/* ============================== 判定 ============================== */

/** 判定缓存：池声明是每次编译一份的不可变对象，WeakMap 随它一起被回收（零跨调用保留） */
const PLAN_CACHE = new WeakMap<KojoPoolDecl, PoolDispatchPlan>();

/**
 * 判一条池该落等值分派还是 `IF` 链（纯函数；同对象重复调用命中缓存，返回**同一**计划）。
 *
 * 返回计划是冻结的纯数据：`{ style, cases, hasDefault, defaultIndex, subject, reason,
 * diagnostics, span }`。`error` 时必须先报 `diagnostics` 且**不产字节**。
 */
export function planPoolDispatch(pool: KojoPoolDecl): PoolDispatchPlan {
  const cached = PLAN_CACHE.get(pool);
  if (cached !== undefined) return cached;
  const plan = computePlan(pool);
  PLAN_CACHE.set(pool, plan);
  return plan;
}

function computePlan(pool: KojoPoolDecl): PoolDispatchPlan {
  const branches = pool.branches;

  /* ---- 1. `? 否` 结构（缺/重复/位置/空） ---- */
  if (branches.length === 0) {
    return planOf('error', {
      reason: '池没有条件分支：池体必须是一条 `?` 链并以 `? 否` 收束。',
      diagnostics: [
        diagnosticOf(
          'core/pool/no-default',
          `池「${pool.name}」没有条件分支：池体必须是一条 \`?\` 链并以 \`? 否\` 收束（§7.1）。`,
          pool.span,
        ),
      ],
      span: pool.span,
    });
  }
  const defaultIndices: number[] = [];
  for (let index = 0; index < branches.length; index++) {
    if (branches[index]!.test === null) defaultIndices.push(index);
  }
  if (defaultIndices.length === 0) {
    return planOf('error', {
      reason: '池缺 `? 否`：等值分派没有兜底档，不能生成分派块。',
      diagnostics: [
        diagnosticOf(
          'core/pool/no-default',
          `池「${pool.name}」缺 \`? 否\`：玩家看到的分支必须有兜底（§7.1）。`,
          pool.span,
        ),
      ],
      span: pool.span,
    });
  }
  const diagnostics: KojoDiagnostic[] = [];
  for (let i = 1; i < defaultIndices.length; i++) {
    const index = defaultIndices[i]!;
    diagnostics.push(
      diagnosticOf(
        'core/pool/default-not-last',
        `池「${pool.name}」出现第二个「? 否」（第 ${index + 1} 个分支）：只能有一个且必须最后。`,
        branches[index]!.span,
      ),
    );
  }
  const defaultIndex = defaultIndices[0]!;
  if (defaultIndices.length === 1 && defaultIndex !== branches.length - 1) {
    diagnostics.push(
      diagnosticOf(
        'core/pool/default-not-last',
        `池「${pool.name}」的「? 否」不在最后（第 ${defaultIndex + 1} 个分支）：兜底分支必须贴在池尾。`,
        branches[defaultIndex]!.span,
      ),
    );
  }
  if (diagnostics.length > 0) {
    return planOf('error', {
      hasDefault: true,
      defaultIndex,
      reason: '`? 否` 的位置/数量不合规：等值分派无法确定唯一的兜底档。',
      diagnostics,
      span: pool.span,
    });
  }

  const defaultBranch = branches[defaultIndex]!;
  if (!branchPrintable(defaultBranch)) {
    return planOf('error', {
      hasDefault: true,
      defaultIndex,
      reason: '`? 否` 是空分支：兜底档没有任何可打印内容。',
      diagnostics: [
        diagnosticOf(
          'core/pool/empty-branch',
          `池「${pool.name}」的「? 否」是空分支（不可打印）：兜底至少要有一行文本（§7.1）。`,
          defaultBranch.span,
        ),
      ],
      span: pool.span,
    });
  }

  /* ---- 2. 分支数下限（含 `? 否`） ---- */
  if (branches.length < POOL_DISPATCH_MIN_BRANCHES) {
    return planOf('if-chain', {
      hasDefault: true,
      defaultIndex,
      reason: `池只有 ${branches.length} 个分支（< ${POOL_DISPATCH_MIN_BRANCHES}，含 \`? 否\`）：等值分派没有结构收益，落 IF 链。`,
      span: pool.span,
    });
  }

  /* ---- 3. 逐分支切「同一主语 + 整数等值」 ---- */
  const cases: PoolDispatchCase[] = [];
  const seen = new Map<number, number>();
  let subject: KojoExprText | null = null;
  for (const index of branchOrder(branches, defaultIndex)) {
    const branch = branches[index]!;
    const test = branch.test!;
    const scan = scanIntegerEquality(test);
    if (!scan.ok) {
      return planOf('if-chain', {
        hasDefault: true,
        defaultIndex,
        subject,
        reason: `第 ${index + 1} 个分支的条件「${test.text.trim()}」不是整数等值（${describeProblem(scan.problem)}）：等值分派不可证，落 IF 链。`,
        span: pool.span,
      });
    }
    if (subject === null) {
      subject = scan.fact.subject;
    } else if (!sameDispatchSubject(subject, scan.fact.subject)) {
      return planOf('if-chain', {
        hasDefault: true,
        defaultIndex,
        subject,
        reason: `第 ${index + 1} 个分支的主语「${scan.fact.subject.text}」与前面的「${subject.text}」不同：同一判别式不可证，落 IF 链。`,
        span: pool.span,
      });
    }
    const first = seen.get(scan.fact.value);
    if (first !== undefined) {
      return planOf('error', {
        hasDefault: true,
        defaultIndex,
        subject,
        reason: `等值键 ${scan.fact.value} 重复出现（第 ${first + 1} / ${index + 1} 个分支）：运行期无法区分该命中哪一档。`,
        diagnostics: [
          // 计划面自己的码（S5.6 additive）：与 `core/expr/not-expression` 分开，作者才知道
          // 该改的是"两个分支的等值键撞了"，不是"这行不是表达式"。
          diagnosticOf(
            'core/pool/duplicate-case',
            `池「${pool.name}」的等值键 ${scan.fact.value} 重复出现（第 ${first + 1} / ${index + 1} 个分支）：等值分派会静默取第一个，必须改成互不相同的整数（§7.1）。`,
            branch.span,
          ),
        ],
        span: pool.span,
      });
    }
    seen.set(scan.fact.value, index);
    cases.push(Object.freeze({ value: scan.fact.value, branchIndex: index, span: branch.span }));
  }

  return planOf('selectcase', {
    cases,
    hasDefault: true,
    defaultIndex,
    subject,
    reason: `全部 ${cases.length} 个普通分支都是同一主语「${subject === null ? '' : subject.text}」的整数等值、分支数 ${branches.length} ≥ ${POOL_DISPATCH_MIN_BRANCHES}、\`? 否\` 在池尾且可打印：等值分派可证。`,
    span: pool.span,
  });
}

/** 普通分支下标（源顺序；跳过唯一的 `? 否`） */
function branchOrder(branches: readonly KojoConditionBranch[], defaultIndex: number): readonly number[] {
  const out: number[] = [];
  for (let index = 0; index < branches.length; index++) {
    if (index !== defaultIndex) out.push(index);
  }
  return out;
}

function describeProblem(problem: string): string {
  switch (problem) {
    case 'not-equality':
      return '不是等值比较';
    case 'compound-condition':
      return '有逻辑/三元组合';
    case 'empty-subject':
      return '等值左边为空';
    case 'impure-subject':
      return '主语不是纯表达式';
    case 'non-integer-value':
      return '等值右边不是十进制安全整数';
    default:
      return problem;
  }
}
