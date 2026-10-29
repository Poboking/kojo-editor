/**
 * `# 对照表` 的静态校验 + 降糖计划（设计稿 §6 / §16.2 C2.5）。
 *
 * 本模块**只产纯数据**：`TableLoweringPlan` + 诊断，不拼任何 ERB 字符串。
 * 落点（`SELECTCASE` / `IF` 链 / 隐藏槽 `__kojo_table_*`）由 adapter 的 emitter 消费 plan 完成。
 *
 * 校验口径（§6.2 / §11.3，全部编译期、全部 error、全部 fail-closed）：
 * - 范围**两两不重叠**：闭区间、开放区间、精确值统一按 `[lo, hi]` 判交（端点相等即重叠）；
 * - `否` **必须最后、必须有值、不能重复**；
 * - 普通行必须有值；值列**全部同类型**；
 * - 端点只允许十进制整数字面量或已声明整数 `# 设`（变量/函数/算术 → dynamic-endpoint）；
 * - 静态可证 `from > to` → bad-range（不是 overlap：空区间不与任何行重叠）。
 *
 * 行编码（与 parser 拍的契约，见 `ast.ts::KojoTableRow`）：
 * - `否 <值>` → `from=null, to=null`
 * - `500..`  → `from=500, to=null`
 * - `..100`  → `from=null, to=100`
 * - `0..100` → `from=0, to=100`
 * - `5`      → `from=5, to=5`（**两端同值的退化闭区间**）
 *
 * 性能：端点求值 O(行数)，重叠检测 = 排序 + 单遍扫描 O(n log n)（不写 O(n²) 两两比较）；
 * 每张表热路径零链式数组（排序一次、诊断一次成形）。
 */
import type {
  KojoConstDecl,
  KojoExprText,
  KojoLiteral,
  KojoSpan,
  KojoTableDecl,
  KojoTableRow,
} from './ast.js';
import type { KojoDiagnostic } from './diagnostics.js';
import { severityOf } from './diagnostics.js';

/** 一行的静态形状（plan 消费方据此选 CASE/IF 形态） */
export type TableRowShape =
  /** `a..b`（a < b） */
  | 'closed'
  /** `a..b` 且 a === b：精确值（退化闭区间） */
  | 'exact'
  /** `a..`：大于等于 a */
  | 'at-least'
  /** `..b`：小于等于 b */
  | 'at-most'
  /** `否 <值>` */
  | 'default';

/** 降糖计划的一行：**纯数据**（number 均已静态求值） */
export interface TablePlanRow {
  /** 源书写顺序（0 基）；诊断/展开预览按它指回原行 */
  readonly index: number;
  readonly shape: TableRowShape;
  readonly from: number | null;
  readonly to: number | null;
  readonly value: KojoLiteral;
  readonly span: KojoSpan;
}

/**
 * 一张 `# 对照表` 的降糖计划。
 *
 * - `slot`：隐藏槽名（`__kojo_table_<名>`），"源表达式只求值一次"先算进它再分档；
 * - `landing`：`selectcase`（全是闭区间/精确值且无重叠，§6.3 优先）或 `if`（有开放区间）；
 * - `defaultRow`：`否` 的行下标（必非 null 才能出 plan）。
 */
export interface TableLoweringPlan {
  readonly name: string;
  readonly slot: string;
  readonly subject: KojoExprText;
  readonly rows: readonly TablePlanRow[];
  readonly defaultRow: number;
  readonly valueType: 'int' | 'string';
  readonly landing: 'selectcase' | 'if';
  readonly span: KojoSpan;
}

export interface TableValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 有 error 时为 null（**不产半成品 plan**） */
  readonly plan: TableLoweringPlan | null;
}

export interface TableLoweringContext {
  /** 已声明整数 `# 设`（端点静态求值用）；缺省 → 非字面量端点一律 dynamic-endpoint */
  readonly integerConstants?: ReadonlyMap<string, number>;
  /** 隐藏槽前缀（默认 `__kojo_table_`；§2.4/§13 保留前缀 `__kojo_`） */
  readonly slotPrefix?: string;
}

/** 隐藏槽默认前缀（唯一一份；作者变量禁用以 `__kojo_` 开头） */
export const TABLE_SLOT_PREFIX = '__kojo_table_';

const DECIMAL_INT_RE = /^-?\d+$/;
const IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** 隐藏槽名：`__kojo_table_<表名>` */
export function tableSlotName(name: string, prefix: string = TABLE_SLOT_PREFIX): string {
  return `${prefix}${name}`;
}

/** 从 `# 设` 声明里抽整数常量表（降糖入口的便捷注入；非整数常量不收） */
export function collectIntegerConstants(
  decls: Iterable<Pick<KojoConstDecl, 'name' | 'valueType' | 'value'>>,
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const decl of decls) {
    if (decl.valueType === 'int' && typeof decl.value === 'number' && Number.isSafeInteger(decl.value)) {
      map.set(decl.name, decl.value);
    }
  }
  return map;
}

type Endpoint =
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'dynamic'; readonly reason: string };

function resolveEndpoint(expr: KojoExprText, constants: ReadonlyMap<string, number> | undefined): Endpoint {
  const text = expr.text.trim();
  if (DECIMAL_INT_RE.test(text)) {
    const value = Number(text);
    if (!Number.isSafeInteger(value)) {
      return { kind: 'dynamic', reason: `端点 ${text} 超出安全整数范围（ERB 为 int64，plan 用 JS number 表示）` };
    }
    return { kind: 'value', value };
  }
  if (IDENTIFIER_RE.test(text)) {
    const value = constants?.get(text);
    if (value === undefined) {
      return { kind: 'dynamic', reason: `端点 ${text} 不是已声明的整数 # 设` };
    }
    return { kind: 'value', value };
  }
  return { kind: 'dynamic', reason: `端点 ${text} 不是十进制整数字面量或整数 # 设` };
}

/** 源写法标签（诊断文案用；保留作者原文，不换成求值后的数字） */
function rangeLabel(row: KojoTableRow): string {
  if (row.from === null && row.to === null) return '否';
  if (row.from === null) return `..${row.to?.text ?? '?'}`;
  if (row.to === null) return `${row.from.text}..`;
  return `${row.from.text}..${row.to.text}`;
}

interface Interval {
  readonly index: number;
  readonly lo: number;
  readonly hi: number;
}

function makeDiagnostic(code: KojoDiagnostic['code'], message: string, span: KojoSpan): KojoDiagnostic {
  return { code, severity: severityOf(code), message, span };
}

/** `# 对照表` 校验 + 降糖计划（纯函数） */
export function validateTable(decl: KojoTableDecl, context?: TableLoweringContext): TableValidationResult {
  const diagnostics: KojoDiagnostic[] = [];
  const rows = decl.rows;
  const constants = context?.integerConstants;
  const slotPrefix = context?.slotPrefix ?? TABLE_SLOT_PREFIX;

  if (rows.length === 0) {
    diagnostics.push(makeDiagnostic('core/table/no-rows', `表「${decl.name}」没有数据行：至少要有 1 行，并以「否 <值>」兜底。`, decl.span));
    return { ok: false, diagnostics, plan: null };
  }

  const planRows: TablePlanRow[] = [];
  const intervals: Interval[] = [];
  let valueType: 'int' | 'string' | null = null;
  let hasOpenRange = false;

  // ---- `否` 的位置（先扫一遍，避免"重复 + 不在最后"对同一行报两次） ----
  const defaultIndices: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (row.from === null && row.to === null) defaultIndices.push(index);
  }
  const defaultRow: number | null = defaultIndices[0] ?? null;
  if (defaultIndices.length > 1) {
    // 重复 `否`：只报"多出来的那些"，一条错误一个落点
    for (let i = 1; i < defaultIndices.length; i++) {
      const index = defaultIndices[i]!;
      diagnostics.push(
        makeDiagnostic(
          'core/table/default-not-last',
          `表「${decl.name}」出现第二个「否」（第 ${index + 1} 行）：一张表只能有一个「否」，且必须最后。`,
          rows[index]!.span,
        ),
      );
    }
  } else if (defaultRow !== null && defaultRow !== rows.length - 1) {
    diagnostics.push(
      makeDiagnostic(
        'core/table/default-not-last',
        `表「${decl.name}」的「否」不在最后（第 ${defaultRow + 1} 行）：兜底行必须贴在表尾。`,
        rows[defaultRow]!.span,
      ),
    );
  }

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const isDefault = row.from === null && row.to === null;
    const label = rangeLabel(row);

    // ---- 值列（trim 已由 parser 做；这里只看有没有、类型是否一致） ----
    if (isDefault) {
      if (typeof row.value === 'string' && row.value.length === 0) {
        diagnostics.push(
          makeDiagnostic('core/table/empty-default', `表「${decl.name}」的「否」没有值：兜底必须给出一个值。`, row.span),
        );
      }
    } else if (typeof row.value === 'string' && row.value.length === 0) {
      diagnostics.push(makeDiagnostic('core/table/value-empty', `表「${decl.name}」的 ${label} 行没有值。`, row.span));
    }

    const rowValueType: 'int' | 'string' = typeof row.value === 'number' ? 'int' : 'string';
    if (valueType === null) valueType = rowValueType;
    else if (valueType !== rowValueType) {
      diagnostics.push(
        makeDiagnostic(
          'core/table/type-mismatch',
          `表「${decl.name}」的值类型不一致：第 ${index + 1} 行是${rowValueType === 'int' ? '整数' : '字符串'}，前面是${valueType === 'int' ? '整数' : '字符串'}；一张表的值必须同类型。`,
          row.span,
        ),
      );
    }

    // ---- 范围（端点静态求值） ----
    let shaped: TableRowShape = 'default';
    let from: number | null = null;
    let to: number | null = null;
    if (!isDefault) {
      let bad = false;
      if (row.from !== null) {
        const resolved = resolveEndpoint(row.from, constants);
        if (resolved.kind === 'dynamic') {
          diagnostics.push(makeDiagnostic('core/table/dynamic-endpoint', `表「${decl.name}」${label} 行：${resolved.reason}；动态阈值请改用「?」链。`, row.from.span));
          bad = true;
        } else from = resolved.value;
      }
      if (row.to !== null) {
        const resolved = resolveEndpoint(row.to, constants);
        if (resolved.kind === 'dynamic') {
          diagnostics.push(makeDiagnostic('core/table/dynamic-endpoint', `表「${decl.name}」${label} 行：${resolved.reason}；动态阈值请改用「?」链。`, row.to.span));
          bad = true;
        } else to = resolved.value;
      }
      if (!bad) {
        if (from !== null && to !== null) {
          if (from > to) {
            diagnostics.push(
              makeDiagnostic(
                'core/table/bad-range',
                `表「${decl.name}」的 ${label} 范围下界大于上界（求值后 ${from} > ${to}）：这个范围永远命中不到，应为空区间写法的笔误。`,
                row.span,
              ),
            );
            bad = true;
          } else {
            shaped = from === to ? 'exact' : 'closed';
          }
        } else if (from !== null) {
          shaped = 'at-least';
          hasOpenRange = true;
        } else if (to !== null) {
          shaped = 'at-most';
          hasOpenRange = true;
        }
        if (!bad) {
          intervals.push({
            index,
            lo: shaped === 'at-most' ? Number.NEGATIVE_INFINITY : from!,
            hi: shaped === 'at-least' ? Number.POSITIVE_INFINITY : to!,
          });
        }
      }
      if (bad) shaped = 'closed';
    }

    planRows.push({ index, shape: shaped, from, to, value: row.value, span: row.span });
  }

  if (defaultRow === null) {
    diagnostics.push(
      makeDiagnostic('core/table/missing-default', `表「${decl.name}」缺一个「否」：范围允许有空洞，但必须有兜底值。`, decl.span),
    );
  }

  // ---- 重叠：按 lo 排序 + 单遍扫描（O(n log n)；不写两两比较） ----
  intervals.sort((a, b) => (a.lo === b.lo ? a.index - b.index : a.lo < b.lo ? -1 : 1));
  let best: Interval | null = null;
  for (const interval of intervals) {
    if (best !== null && interval.lo <= best.hi) {
      const a = rows[best.index]!;
      const b = rows[interval.index]!;
      diagnostics.push(
        makeDiagnostic(
          'core/table/overlap',
          `表「${decl.name}」的 ${rangeLabel(a)} 与 ${rangeLabel(b)} 重叠：落在重叠区的值会同时命中两行；请拆开端点。`,
          b.span,
        ),
      );
    }
    if (best === null || interval.hi > best.hi) best = interval;
  }

  // 诊断按源顺序稳定排列（作者写什么顺序，诊断就按什么顺序指出）
  diagnostics.sort((a, b) => {
    const sa = a.span?.start;
    const sb = b.span?.start;
    if (sa === undefined || sb === undefined) return 0;
    return sa.line === sb.line ? sa.column - sb.column : sa.line - sb.line;
  });

  const hasError = diagnostics.some((d) => d.severity === 'error');
  if (hasError || defaultRow === null || valueType === null) {
    return { ok: false, diagnostics, plan: null };
  }

  return {
    ok: true,
    diagnostics,
    plan: {
      name: decl.name,
      slot: tableSlotName(decl.name, slotPrefix),
      subject: decl.subject,
      rows: planRows,
      defaultRow,
      valueType,
      landing: hasOpenRange ? 'if' : 'selectcase',
      span: decl.span,
    },
  };
}
