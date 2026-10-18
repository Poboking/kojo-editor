/**
 * `分支：` 规则池（条件即注解）——**纯函数**判定与排序（规范 §3.11）。
 *
 * 排序口径（用户拍板，2026-10-19）：
 * - 默认**保持作者书写顺序**（first-match-wins，可预测）；
 * - **只有**当所有条件分支都是「同一主语 + 同一运算符 + 数值比较」形态时，才按阈值
 *   「从窄到宽」自动排序——这正是规则池想要的语义：**最具体的分支先命中**。
 *   注意这类分支**会重叠**（`>= 500` 与 `>= 100` 在 600 处同真），所以排序**会改变**
 *   谁命中；改的是作者写反的那种顺序，不是无关顺序。语义因此必须写进规范 §3.11，
 *   不能当成"纯装饰"。
 * - 任何一条条件形态不可比（含 `且`/`或`、函数调用、字符串比较、不同主语、
 *   运算符混用）⇒ **整池保持书写顺序**，绝不猜。
 *
 * 为什么要求运算符**完全相同**而不是同族：`>= 500` 与 `> 500` 会同时命中 500，
 * 先匹配谁结果不同——那是真正依赖书写顺序的池，不能重排。
 *
 * 本模块零 IO、零游戏知识、零转译器状态：输入条件原文，输出排序后的副本。
 */

/** 可排序的比较运算符（`==` / `!=` 不参与排序：前者互斥但"阈值"无意义，后者顺序敏感）。 */
export type ComparableOp = '>=' | '>' | '<=' | '<';

/** 一条可比较的「同一主语 + 数值比较」条件 */
export interface NumericComparison {
  /** 主语原文（已 trim；比较时逐字相等才算同一主语） */
  readonly subject: string;
  readonly op: ComparableOp;
  /** 阈值（十进制整数，含负号） */
  readonly value: number;
}

/**
 * 运算符词形 → 规范符号。**长词优先**（`不等于` 先于 `等于`；`>=` 先于 `>`）。
 * 只收可排序的四枚；`==` / `!=`（及 `等于` / `不等于`）单独解析后返回 null。
 */
const OP_PATTERN = '不等于|等于|至少|至多|超过|不足|>=|<=|==|!=|>|<';

const OP_MAP: Readonly<Record<string, ComparableOp | null>> = {
  至少: '>=',
  至多: '<=',
  超过: '>',
  不足: '<',
  '>=': '>=',
  '<=': '<=',
  '>': '>',
  '<': '<',
  '==': null,
  '!=': null,
  等于: null,
  不等于: null,
};

/**
 * 条件原文 → 「同一主语 + 数值比较」形态；不是该形态（或运算符不可排序）⇒ `null`。
 *
 * 判据刻意**窄**：
 * - 左值必须是**单一标识符形态**（允许 `:` 索引与中文，不含空白 / 括号 / 算术 /
 *   逻辑词）——`心形(1) >= 2`、`A 且 B >= 1`、`A + 1 >= 2` 一律不可比；
 * - 右值必须是**十进制整数字面量**（变量 / 字符串 / 浮点都不可证，不猜）。
 */
export function parseNumericComparison(condition: string): NumericComparison | null {
  const m = new RegExp(`^(.+?)\\s*(${OP_PATTERN})\\s*(-?\\d+)$`).exec(condition.trim());
  if (!m) return null;
  const subject = m[1]!.trim();
  const op = OP_MAP[m[2]!] ?? null;
  if (op === null) return null;
  if (!isComparableSubject(subject)) return null;
  return { subject, op, value: Number(m[3]!) };
}

/** 主语是否「单一标识符形态」（不允许空白 / 括号 / 算术 / 比较 / 逻辑连接词） */
function isComparableSubject(subject: string): boolean {
  if (subject.length === 0) return false;
  if (/[\s()（）+\-*/%<>=!&|,，]/.test(subject)) return false;
  if (/且|或/.test(subject)) return false;
  return true;
}

/**
 * 整池条件是否可排序：至少两条、全部是「同一主语 + 同一运算符 + 数值比较」。
 *
 * 兜底分支不参与本判定（它没有条件文本）。
 */
export function canSortRulePool(conditions: readonly string[]): boolean {
  if (conditions.length < 2) return false;
  const first = parseNumericComparison(conditions[0]!);
  if (!first) return false;
  for (let i = 1; i < conditions.length; i++) {
    const p = parseNumericComparison(conditions[i]!);
    if (!p || p.op !== first.op || p.subject !== first.subject) return false;
  }
  return true;
}

/** 排序所需的最小分支形状（`kind` 区分条件分支与兜底） */
export interface SortableRulePoolBranch {
  readonly kind: 'rule' | 'else';
  readonly condition: string;
}

/**
 * 规则池分支排序（**纯函数**：返回新数组，不改入参）。
 *
 * - 兜底不在最后 ⇒ 原样返回（那是 `rule-pool-fallback-not-last` 的错误形态，
 *   排序会把作者的书写顺序藏起来，反而不利于诊断定位）；
 * - 不可排序 ⇒ 原样返回（书写顺序 = first-match-wins）；
 * - 可排序 ⇒ 条件分支按「窄 → 宽」稳定排序，兜底恒在末尾：
 *   - `>=` / `>`：阈值**从大到小**（`>= 500` 比 `>= 100` 窄）；
 *   - `<=` / `<`：阈值**从小到大**（`< 100` 比 `< 500` 窄）。
 */
export function sortRulePoolBranches<T extends SortableRulePoolBranch>(branches: readonly T[]): T[] {
  const out = [...branches];
  const fallbackAt = out.findIndex((b) => b.kind === 'else');
  if (fallbackAt >= 0 && fallbackAt !== out.length - 1) return out;
  const rules = fallbackAt >= 0 ? out.slice(0, -1) : out;
  if (!canSortRulePool(rules.map((b) => b.condition))) return out;

  const op = parseNumericComparison(rules[0]!.condition)!.op;
  const sorted = [...rules].sort((a, b) => {
    const av = parseNumericComparison(a.condition)!.value;
    const bv = parseNumericComparison(b.condition)!.value;
    return op === '>=' || op === '>' ? bv - av : av - bv;
  });
  return fallbackAt >= 0 ? [...sorted, out[out.length - 1]!] : sorted;
}

/** 条件文本的**规范化**（去多余空白）——重复条件判定的唯一口径 */
export function normalizeConditionText(condition: string): string {
  return condition.replace(/\s+/g, ' ').trim();
}

/**
 * 字面量恒真条件（`[真]` / `[true]` / `[1]`）——其后的分支永不触发
 * （`rule-pool-unreachable`，warning）。
 */
export function isLiteralTrueCondition(condition: string): boolean {
  const t = normalizeConditionText(condition);
  return t === '真' || t === '1' || /^true$/i.test(t);
}
