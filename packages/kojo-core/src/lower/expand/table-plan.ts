/**
 * `# 表` 落点判定（C2.5 / §6.3 / §16.2）：**纯结构判定，只产计划，不产字节**。
 *
 * 分工（与 `选项` 的 ETB 计划、`@巡` 的循环计划同一口径）：
 * - 本模块说"这张表能不能**可证地**落等值分派"（`selectcase`），或者只能落 `IF` 链；
 * - 落点形状（引擎块关键字、缩进）是 adapter 的发射事实，core **零引擎关键字**；
 * - 计划是**纯数据**（数字 + 字符串 + span），可离线断言、可 JSON 往返。
 *
 * ## 判据（写死；改这里 = 改语言口径，必须同步设计稿 §6.3）
 *
 * 1. **全部臂都是精确整数等值**：`shape === 'exact'`（`from === to`）且键是安全整数。
 *    闭区间 / 开放区间 / 逗号列表 / 表达式端点都不行——单条等值档表达不了；
 *    其中逗号列表与变量端点在上游 `validateTable` 就已被拒（端点是单 token，逗号 →
 *    `core/table/dynamic-endpoint`），所以到这里的"非精确"只剩区间形态。
 * 2. **等值臂 ≥ {@link TABLE_DISPATCH_MIN_ARMS}（=3）**：分派块骨架恒比 IF 链多一行
 *    （"块头 + 块尾" vs "链尾"），所以 n 小时 IF 链更短、更直观；只有臂数够多，
 *    "判别式只写一次 + 档位显式"（语料主流形态）才值得这一行开销。写死 3 是语言口径。
 * 3. **判别式是纯整数表达式**：静态**语法纯度** = 非空、无字符串字面量、无函数调用、
 *    无赋值、无逗号、无换行、无花括号。函数调用可能有副作用/返回字符串，字符串字面量
 *    不是整数——这两类一票否决。类型语义由表达式端口负责（隐藏槽 `__kojo_table_*`
 *    恒按 int 登记，见 `recordSlot(..., 'table-subject')`）。
 * 4. **`否` 臂可有可无**：它不进 `cases`，只置 `hasDefault`；没有 `否` 时怎么收尾由
 *    adapter 的数据决定（eraTW = 省略兜底档）。
 *
 * ## 失败（fail-closed，`style: 'error'`）
 *
 * 计划不自洽——缺判别式、等值键不是安全整数、等值键重复、出现多个 `否`——一律返回
 * **既有 core 诊断**（`core/expr/not-expression` / `core/table/dynamic-endpoint` /
 * `core/table/overlap` / `core/table/default-not-last`），调用方报完**不产字节**。
 * 正常管线里这些已被 `validateTable` 挡住；本模块仍判一次，因为计划也可能来自
 * 增量/宿主侧构造（手搓 plan），不自洽就绝不能落成运行期"第一个命中"。
 *
 * ## 发射通道
 *
 * core 只发**结构请求** {@link TableDispatchEmitRequest}（判别槽 / 值槽 / 每臂已降糖行 /
 * 兜底已降糖行）给 adapter 的契约可选能力 `program.tableDispatch`（`lower/backend.ts`）；
 * 没有该能力时**原样退回既有 `IF` 链**（golden 不变）。能力探测见 {@link tableDispatchOf}：
 * 契约字段是 optional，探测恒 = 一次属性读 + `this` 绑定。
 */
import type { KojoExprText, KojoSpan } from '../../ast.js';
import type { KojoDiagnostic } from '../../diagnostics.js';
import { severityOf } from '../../diagnostics.js';
import type { TableRowShape } from '../../table.js';
import type { EmitResult, KojoEmitBackend } from '../backend.js';

/* ============================== 判据常量 ============================== */

/**
 * 等值臂下限：少于 3 条时 `IF` 链更短（等值分派 = 1 头 + n 档 + 1 尾）。
 * 写死是**语言口径**，不是可调项；adapter 不得自行放宽/收紧。
 */
export const TABLE_DISPATCH_MIN_ARMS = 3;

/* ============================== 输入事实 ============================== */

/**
 * 一行的结构事实：`TablePlanRow` 的结构子集（`value` 不参与落点判定，故意不收）。
 * 直接传 `TableLoweringPlan` 即可（结构化类型，core 内不复制第二份 plan 类型）。
 */
export interface TableDispatchRowFact {
  readonly shape: TableRowShape;
  readonly from: number | null;
  readonly to: number | null;
  readonly span: KojoSpan;
}

/** 判定输入：`TableLoweringPlan` 的结构子集（也可以手工构造，用于离线/反例断言） */
export interface TableDispatchFact {
  readonly subject: KojoExprText;
  readonly rows: readonly TableDispatchRowFact[];
  /** `否` 的行下标（无 `否` 时缺省/null 都行；以行的 `shape === 'default'` 为准） */
  readonly defaultRow?: number | null;
  readonly span: KojoSpan;
}

/* ============================== 输出计划 ============================== */

/** 一个可落等值档的臂（键 = 静态求值后的整数） */
export interface TableDispatchCase {
  /** 等值键（安全整数；已静态求值，常量端点也在这里变成数字） */
  readonly value: number;
  /** 源 plan 里的行下标（诊断/发射按它指回原行） */
  readonly rowIndex: number;
  readonly span: KojoSpan;
}

/**
 * 落点风格：
 * - `selectcase`：可证等值，`cases` 有值；
 * - `if-chain`：不可证/不划算，**`cases` 为空**（没有可落等值档的位置）；
 * - `error`：计划不自洽（fail-closed），`diagnostics` 非空、`cases` 为空。
 */
export type TableDispatchStyle = 'selectcase' | 'if-chain' | 'error';

/** 一次判定结果（纯数据；只读、深冻结） */
export interface TableDispatchPlan {
  readonly style: TableDispatchStyle;
  /** 仅 `selectcase` 时有值；顺序 = 源书写顺序（**不排序**，§6.2） */
  readonly cases: readonly TableDispatchCase[];
  /** 是否有 `否` 兜底臂（不进 `cases`；收尾形式由 adapter 数据定） */
  readonly hasDefault: boolean;
  /** 判定理由（中文；写进预览/测试断言，不产字节） */
  readonly reason: string;
  /** 仅 `error` 时有值；码/级别仍由 `diagnostics.ts` 唯一定义 */
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly span: KojoSpan;
}

/* ============================== 发射通道（结构请求） ============================== */

/**
 * core 发给 adapter 的**结构请求**：隐槽名 + 已降糖的臂正文。
 *
 * 契约（写死）：
 * - `armLines[i]` 与 `plan.cases[i]` **一一对应**（顺序 = 源书写顺序）；
 * - 每行都是 core 已降糖的产物行（**没有缩进**）；adapter 只缩进嵌入，
 *   **不得改写/删除/插入/重排**；
 * - `elseLines` 是 `否` 臂的已降糖行；`plan.hasDefault === false` 时恒为空数组；
 * - 判别式求值（`subjectSlot = <subject>`）由 core 在请求之前发完，adapter 不重复求值。
 */
export interface TableDispatchEmitRequest {
  readonly plan: TableDispatchPlan;
  /** 判别值隐藏槽（`__kojo_table_<名>`，只求值一次） */
  readonly subjectSlot: string;
  /** 分档结果隐藏槽（`__kojo_table_<名>__value`） */
  readonly valueSlot: string;
  readonly armLines: readonly (readonly string[])[];
  readonly elseLines: readonly string[];
}

/** adapter 的可选能力签名（一个请求 → 0/1/多行 / `EmitFailure`） */
export type TableDispatchEmitter = (request: TableDispatchEmitRequest) => EmitResult;

/**
 * 取 backend 的等值分派能力；没有就返回 null（调用方退回既有 `IF` 链，golden 不变）。
 *
 * 能力是 `KojoProgramEmitter` 上的 optional 方法：这里保留 `this = program` 的绑定，
 * 让 adapter 用方法简写实现时仍能读自己的实例状态（本批 eraTW 实现无状态，但契约不因此收窄）。
 */
export function tableDispatchOf(backend: KojoEmitBackend): TableDispatchEmitter | null {
  const host = backend.program;
  const emitter = host.tableDispatch;
  if (typeof emitter !== 'function') return null;
  return (request) => emitter.call(host, request);
}

/* ============================== 小工具 ============================== */

function diagnosticOf(
  code: KojoDiagnostic['code'],
  message: string,
  span: KojoSpan,
): KojoDiagnostic {
  return Object.freeze({ code, severity: severityOf(code), message, span });
}

function planOf(
  style: TableDispatchStyle,
  fields: {
    readonly cases?: readonly TableDispatchCase[];
    readonly hasDefault?: boolean;
    readonly reason: string;
    readonly diagnostics?: readonly KojoDiagnostic[];
    readonly span: KojoSpan;
  },
): TableDispatchPlan {
  return Object.freeze({
    style,
    cases: Object.freeze(fields.cases === undefined ? [] : [...fields.cases]),
    hasDefault: fields.hasDefault ?? false,
    reason: fields.reason,
    diagnostics: Object.freeze(fields.diagnostics === undefined ? [] : [...fields.diagnostics]),
    span: fields.span,
  });
}

/** 区间形态的源写法标签（诊断文案用） */
function shapeLabel(shape: TableRowShape): string {
  switch (shape) {
    case 'closed':
      return '闭区间';
    case 'at-least':
      return '开放区间（`a..`）';
    case 'at-most':
      return '开放区间（`..b`）';
    case 'exact':
      return '精确值';
    case 'default':
      return '`否` 兜底';
  }
}

/**
 * 判别式的**静态语法纯度**（不是类型检查）：一票否决字符串字面量、函数调用、赋值、
 * 逗号、换行、花括号。标识符 / 整数 / 中文运算符 / 括号 / 下标 / 域名冒号 / 三元都放行。
 *
 * 为什么语法级足够：`# 表` 的判别式按 `int` 隐藏槽登记（见 `tables.ts` 的
 * `recordSlot(..., 'table-subject')`），表达式端口的类型错误在别处报；这里只排除
 * **明显可能有副作用/明显非整数**的形态，宁可退回 `IF` 链（保守），不放行再报错。
 */
function isPureIntegerSubject(text: string): boolean {
  if (text.length === 0) return false;
  // 字符串字面量（表判别式不允许字符串）/ 花括号插值 / 反斜杠转义：都不是纯整数表达式
  if (/["'`{}\\]/.test(text)) return false;
  // 逗号只出现在调用实参或列表里（调用已被下一行否决；数组字面量也不收）
  if (text.includes(',')) return false;
  if (/[\r\n]/.test(text)) return false;
  // 函数调用：标识符 / 右括号 / 右方括号 后面紧跟 `(`。`(a + b) * c` 不匹配。
  if (/[\p{L}\p{N}_$)\]]\s*\(/u.test(text)) return false;
  // 赋值（单个 `=`，且不是 `==` / `!=` / `<=` / `>=`）：不是表达式
  if (/(?<![<>=!])=(?!=)/.test(text)) return false;
  return true;
}

/* ============================== 判定 ============================== */

/** 判定缓存：plan 是每次编译一份的不可变对象，WeakMap 随它一起被回收（零跨调用保留） */
const PLAN_CACHE = new WeakMap<TableDispatchFact, TableDispatchPlan>();

/**
 * 判一张表该落等值分派还是 `IF` 链（纯函数；同对象重复调用命中缓存，返回**同一**计划）。
 *
 * 返回的计划是冻结的纯数据：`\{ style, cases, hasDefault, reason, diagnostics, span \}`。
 * `error` 时必须先报 `diagnostics` 且**不产字节**（见文件头注）。
 */
export function planTableDispatch(table: TableDispatchFact): TableDispatchPlan {
  const cached = PLAN_CACHE.get(table);
  if (cached !== undefined) return cached;
  const plan = computePlan(table);
  PLAN_CACHE.set(table, plan);
  return plan;
}

function computePlan(table: TableDispatchFact): TableDispatchPlan {
  const subjectText = table.subject.text.trim();
  if (subjectText.length === 0) {
    return planOf('error', {
      reason: '表没有判别式（`由` 后面的表达式为空）：无法生成等值分派。',
      diagnostics: [
        diagnosticOf(
          'core/expr/not-expression',
          '表的判别式为空：`# 表 <名> 由 <表达式>` 的 `由` 后面必须写一个整数表达式（§6.1）。',
          table.subject.span,
        ),
      ],
      span: table.span,
    });
  }

  if (!isPureIntegerSubject(subjectText)) {
    return planOf('if-chain', {
      reason: `判别式「${subjectText}」不是纯整数表达式（含字符串字面量 / 函数调用 / 赋值 / 逗号等）：等值分派不可证，落 IF 链。`,
      span: table.span,
    });
  }

  const cases: TableDispatchCase[] = [];
  let hasDefault = false;
  for (let index = 0; index < table.rows.length; index++) {
    const row = table.rows[index]!;
    if (row.shape === 'default') {
      if (hasDefault) {
        return planOf('error', {
          reason: '表里出现了第二个 `否`：等值分派无法确定兜底档。',
          diagnostics: [
            diagnosticOf(
              'core/table/default-not-last',
              '表的计划里出现第二个 `否` 行：一张表只能有一个兜底，且必须最后（§6.1）。',
              row.span,
            ),
          ],
          span: table.span,
        });
      }
      hasDefault = true;
      continue;
    }
    if (row.shape !== 'exact') {
      return planOf('if-chain', {
        hasDefault,
        reason: `第 ${index + 1} 行是${shapeLabel(row.shape)}而不是精确值：单条等值档表达不了，落 IF 链。`,
        span: table.span,
      });
    }
    if (row.from === null || row.to === null || row.from !== row.to || !Number.isSafeInteger(row.from)) {
      return planOf('error', {
        reason: `第 ${index + 1} 行的等值键无法静态表示成安全整数：不能落等值分派。`,
        diagnostics: [
          diagnosticOf(
            'core/table/dynamic-endpoint',
            `表的第 ${index + 1} 行是"精确值"形态，但键 ${String(row.from)} 不是安全整数：等值分派要求静态可证的整数键（§6.1）。`,
            row.span,
          ),
        ],
        span: table.span,
      });
    }
    cases.push(Object.freeze({ value: row.from, rowIndex: index, span: row.span }));
  }

  // 等值键去重（上游 validateTable 已按区间判重叠；这里防手搓 plan / 增量构造绕过）
  const seen = new Set<number>();
  for (const item of cases) {
    if (seen.has(item.value)) {
      return planOf('error', {
        reason: `等值键 ${item.value} 出现了两次：运行期无法区分该命中哪一档。`,
        diagnostics: [
          diagnosticOf(
            'core/table/overlap',
            `表的等值键 ${item.value} 重复出现：两档同值不可区分（§6.2 要求两两不重叠），等值分派会静默取第一个。`,
            item.span,
          ),
        ],
        span: table.span,
      });
    }
    seen.add(item.value);
  }

  if (cases.length < TABLE_DISPATCH_MIN_ARMS) {
    return planOf('if-chain', {
      hasDefault,
      reason: `等值臂只有 ${cases.length} 个（< ${TABLE_DISPATCH_MIN_ARMS}）：分派块骨架恒多一行，档位少时 IF 链更短，落 IF 链。`,
      span: table.span,
    });
  }

  return planOf('selectcase', {
    cases,
    hasDefault,
    reason: `全部 ${cases.length} 个臂都是精确整数等值、判别式「${subjectText}」是纯整数表达式、臂数 ${cases.length} ≥ ${TABLE_DISPATCH_MIN_ARMS}：等值分派可证。`,
    span: table.span,
  });
}
